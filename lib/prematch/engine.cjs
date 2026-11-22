"use strict";
// ПРЕМАТЧ-ДВИЖОК (docs/PREMATCH-HANDBOOK.md): фид двух контор → состояние рынков по каждой игре → пары матчей
// Pinnacle/Betano → по сетке пересчёт «грязных» пар → журнал вилок (первое появление, число повторов, максимум)
// → на старте матча состояние замораживается = цена закрытия.
// Движок НИЧЕГО НЕ СТАВИТ и не работает со счетами — он только измеряет. Простановка подключается отдельно.
// Сеть вынесена в объект feed ({ getData(book), getSnapshots(book, guid, cursor) }) — в тестах подменяется.
//
// Чего здесь ПОКА НЕТ из хендбука: модели справедливых цен (раздел 5) и журнала сигналов по ней (ev ≥ 5.5%).
// Поэтому поля ev / w / l в записях журнала пустые. Вилкам модель не нужна. См. PLAN.md.
const { BookState } = require("./state.cjs");
const { Matcher } = require("./names.cjs");
const { flipKey, parseKey, describeKey } = require("./markets.cjs");
const { oppositePrice, arbOf } = require("./arb.cjs");
const { pairCheck } = require("./guard.cjs");
const { identityCheck } = require("./sportradar.cjs");
const { ruleBlock } = require("./rules.cjs");

const ORDER = ["Betano", "Pinnacle"];
const GAP_MS = 10 * 60 * 1000; // по конторе не было данных дольше 10 минут — пропуск записи (2.7)
// Виды спорта по умолчанию: футбол (правила хендбука, проверены записью) + те, где на дампе 19.11.2026 рынки
// ОБЕИХ контор просмотрены глазами и сегменты совпали: хоккей, теннис, баскетбол, ам. футбол, CS, Dota.
// Остальные (гандбол, волейбол, дартс, бейсбол…) в Pinnacle-плече фида сейчас отсутствуют — сверить не с чем,
// а названия сегментов могут значить разное («Total 180s» у дартса лежит в том же «/Main/Main», что и тотал).
const DEFAULT_SPORTS = [1, 2, 3, 4, 11, 29, 30];

class PrematchEngine {
  // opts: feed (обязателен), now(), gridMs (сетка оценки, по хендбуку 2 минуты), minToStartMin (15),
  //       sports (массив sportType; не задано = DEFAULT_SPORTS; null = все), onLog(level, msg),
  //       onArb(запись, "new" | "close" | "identity"),
  //       directory — справочник матчей ({ async get(extId) }, см. sportradar.cjs): если задан, каждая пара с вилкой
  //       сверяется по номеру Sportradar (страна, время, названия) — один запрос на матч, не больше
  //       identifyPerTick запросов за шаг.
  constructor(opts = {}) {
    this.feed = opts.feed;
    this.now = opts.now || (() => Date.now());
    this.gridMs = opts.gridMs != null ? opts.gridMs : 120000;
    this.minToStartMin = opts.minToStartMin != null ? opts.minToStartMin : 15;
    this.onLog = opts.onLog || (() => {});
    this.onArb = opts.onArb || (() => {});
    const list = opts.sports === undefined ? DEFAULT_SPORTS : opts.sports;
    const sports = list && list.length ? new Set(list.map(Number)) : null;
    const acceptGame = (g) => !sports || sports.has(Number(g.sportType));
    this.books = {
      Betano: new BookState("Betano", { acceptGame, now: this.now }),
      Pinnacle: new BookState("Pinnacle", { acceptGame, now: this.now }),
    };
    this.matcher = new Matcher();
    this.arbs = new Map();       // id записи («пара|ключ») → запись журнала вилок
    this.byPair = new Map();     // id пары → Set id записей (для цены закрытия)
    this.closedPairs = new Set();
    this.current = new Map();    // id пары → последняя оценка { at, mins, flick, arbs[] }
    this.lastEval = 0;
    this.turn = 0;
    this.lastOk = { Betano: 0, Pinnacle: 0 };
    this.gaps = { Betano: [], Pinnacle: [] };
    this.rate429 = 0;
    this.directory = opts.directory || null;
    this.identifyPerTick = opts.identifyPerTick != null ? opts.identifyPerTick : 3;
    this.identity = new Map();   // id пары → { status, why, sr } — сверка матча по номеру Sportradar
    this._idFails = new Map();   // id пары → сколько раз справочник не ответил
  }

  ready() { return !!(this.books.Betano.sessionGuid && this.books.Pinnacle.sessionGuid); }

  _markOk(book, now) {
    const was = this.lastOk[book];
    if (was && now - was > GAP_MS) { this.gaps[book].push({ from: was, to: now }); this.onLog("WARN", `${book}: пропуск записи ${Math.round((now - was) / 60000)} мин — матчи, стартовавшие в нём, без цены закрытия`); }
    this.lastOk[book] = now;
  }
  _inGap(startMs, now) {
    for (const book of ORDER) {
      if (this.gaps[book].some((g) => g.from < startMs && startMs <= g.to)) return true;
      if (this.lastOk[book] < startMs && now - this.lastOk[book] > GAP_MS) return true;
    }
    return false;
  }

  _fatal(r, book) {
    if (r.status === 401) { const e = new Error("ключ фида истёк (401) — остановка"); e.code = "KEY_EXPIRED"; throw e; }
    if (r.status === 429) { this.rate429++; this.onLog("WARN", `${book}: 429 — этот ключ опрашивает ещё одна программа, оставь одного клиента`); return; }
    this.onLog("WARN", `${book}: ответ ${r.status} ${r.error || ""}`);
  }

  async _reload(book) {
    const st = this.books[book];
    const r = await this.feed.getData(book);
    if (r.status !== 200 || !r.data || !r.data.gamesOriginModel) { this._fatal(r, book); return false; }
    const first = st.reloads === 0;
    const d = st.reload(r.data);
    this.onLog("INFO", `${book}: ${first ? "загрузка" : "перезагрузка сессии"} — игр ${st.games.size}, ` +
      (first ? `цен ${d.added}` : `реально изменилось цен ${d.changed}, снято ${d.removed}, добавлено ${d.added}`));
    if (!st.sessionGuid) this.onLog("WARN", `${book}: в ответе нет снимков → нет sessionGuid, повторю загрузку`);
    return true;
  }

  // Один шаг: опрос ОДНОЙ конторы (они чередуются), сопоставление новых игр, оценка по сетке.
  async tick() {
    const book = ORDER[this.turn++ % ORDER.length], st = this.books[book];
    let ok = false;
    if (!st.sessionGuid) ok = await this._reload(book);
    else {
      const r = await this.feed.getSnapshots(book, st.sessionGuid, st.cursor);
      if (r.status === 204) ok = true;
      else if (r.status === 200) {
        ok = true;
        for (const s of (r.data && r.data.snapshots) || []) {
          if (!st.applySnapshot(s)) { st.sessionGuid = null; this.onLog("INFO", `${book}: сессия поставщика сменилась — полная перезагрузка на следующем шаге`); break; }
        }
      } else if (r.status === 400 && /session/i.test(String(r.error))) { st.sessionGuid = null; ok = true; this.onLog("INFO", `${book}: SessionId mismatch — полная перезагрузка на следующем шаге`); }
      else this._fatal(r, book);
    }
    const now = this.now();
    if (ok) this._markOk(book, now);
    this._syncPairs();
    let evaluated = null;
    if (this.ready() && now - this.lastEval >= this.gridMs) evaluated = this.evaluate(now);
    if (this.directory && this.ready()) await this._identify();
    return { book, ok, evaluated };
  }

  // Медленная проверка «тот ли матч»: для пар с вилкой спрашиваем справочник по номеру Sportradar игры Betano
  // и сверяем страну, время и названия с игрой Pinnacle. Один раз на пару; результат — в записи журнала.
  async _identify() {
    let asked = 0;
    for (const [pairId, cur] of this.current) {
      if (!cur.arbs.length || this.identity.has(pairId)) continue;
      const pair = this.matcher.pairs.get(pairId); if (!pair) continue;
      const bg = this.books.Betano.games.get(pair.b), pg = this.books.Pinnacle.games.get(pair.p);
      const ext = bg && bg.extId && String(bg.extId) !== "0" ? String(bg.extId) : null;
      let res;
      if (!ext) res = { status: "noid", why: "у игры Betano нет номера Sportradar" };
      else {
        if (asked >= this.identifyPerTick) continue;                // остальные — на следующих шагах
        asked++;
        let sr = null;
        try { sr = await this.directory.get(ext); } catch { sr = null; }
        if (!sr) {
          const n = (this._idFails.get(pairId) || 0) + 1; this._idFails.set(pairId, n);
          if (n < 3) continue;                                      // не ответил — попробуем ещё
          res = { status: "unknown", why: "справочник не ответил" };
        } else res = { ...identityCheck(sr, pg, pair.sport), sr };
      }
      this.identity.set(pairId, res);
      if (res.status === "mismatch") this.onLog("WARN", `НЕ ТОТ МАТЧ? ${pair.t1} — ${pair.t2} / Pinnacle: ${pair.p1} — ${pair.p2}: ${res.why}`);
      for (const id of this.byPair.get(pairId) || []) {
        const rec = this.arbs.get(id);
        rec.identity = res.status; rec.identityWhy = res.why;
        this.onArb(rec, "identity");
      }
    }
  }

  _syncPairs() {
    for (const book of ORDER) {
      const st = this.books[book];
      for (const gid of st.takeNewGames()) this.matcher.add(book, st.games.get(gid));
    }
    const fresh = this.matcher.sync();
    for (const p of fresh) this.books.Betano.dirty.add(p.b); // новая пара — на первую оценку
    return fresh;
  }

  // Пересчитать «грязные» пары (у которых изменилась цена в любой из двух игр). Возврат — сколько пар.
  evaluate(now = this.now()) {
    this.lastEval = now;
    const B = this.books.Betano, P = this.books.Pinnacle;
    const pairs = new Set();
    for (const st of [B, P]) { for (const gid of st.dirty) { const p = this.matcher.pairOf(gid); if (p) pairs.add(p); } st.dirty.clear(); }
    for (const pair of pairs) this._evalPair(pair, now);
    this._closeStarted(now);
    return pairs.size;
  }

  _startMs(pair) {
    const b = this.books.Betano.startMs(pair.b), p = this.books.Pinnacle.startMs(pair.p);
    return Math.min(b || p, p || b); // раньший из двух стартов: после него одно из плеч уже заморожено
  }

  _evalPair(pair, now) {
    const B = this.books.Betano, P = this.books.Pinnacle;
    const startMs = this._startMs(pair);
    if (!startMs || now >= startMs) { this.current.delete(pair.id); return; }
    const bs = B.gs.get(pair.b), ps = P.gs.get(pair.p);
    if (!bs || !ps) { this.current.delete(pair.id); return; }
    const mins = (startMs - now) / 60000;
    const getP = (key) => { const c = ps.prices.get(pair.flip ? flipKey(key) : key); return c ? c.price : undefined; };
    const flick = B.flicker(pair.b);
    const arbs = [], bPrices = [];
    const ctx = { sport: pair.sport, t1: pair.t1, t2: pair.t2, league: pair.league, pLeague: pair.pLeague };
    for (const [key, c] of bs.prices) {
      if (!(c.price > 1)) continue;
      bPrices.push([key, c.price]);
      if (ruleBlock(key, ctx)) continue;                      // рынок рассчитывается у контор по-разному — не сравниваем
      const o = oppositePrice(key, getP);
      const arb = o ? arbOf(c.price, o.opp) : null;
      if (!(arb > 0)) continue;
      arbs.push({ key, price: c.price, opp: o.opp, via: o.via, arb });
    }
    // «Тот ли матч» по ценам — считаем, только когда есть вилка (иначе незачем). Пометка, не фильтр (см. guard.cjs).
    const check = arbs.length ? pairCheck(bPrices, getP) : null;
    // В журнал — только если до старта не меньше 15 минут и матч не «мигает».
    if (mins >= this.minToStartMin && !flick) {
      for (const a of arbs) this._journal(pair, a.key, a.price, a, a.arb, mins, now, startMs, check);
    }
    this.current.set(pair.id, { at: now, mins, flick, arbs, check });
  }

  _journal(pair, key, price, o, arb, mins, now, startMs, check) {
    const id = pair.id + "|" + key;
    let rec = this.arbs.get(id);
    if (rec) {
      rec.repeats++; rec.lastAt = now; rec.lastPrice = price; if (arb > rec.maxArb) rec.maxArb = arb;
      if (check && check.status === "suspect") rec.pairCheck = "suspect"; // хоть раз под подозрением — так и остаётся
      return rec;
    }
    const k = parseKey(key), bg = this.books.Betano.games.get(pair.b) || {};
    rec = {
      id, pairId: pair.id, sportType: pair.sport, t1: pair.t1, t2: pair.t2, league: pair.league, link: bg.link || "",
      key, period: k.period, family: k.family, line: k.line, side: k.side, what: describeKey(key, pair.t1, pair.t2),
      firstAt: now, lastAt: now, price, lastPrice: price, ev: null, w: null, l: null,   // ev/w/l — из модели (раздел 5), её пока нет
      opp: o.opp, via: o.via, arb, maxArb: arb, band: "вилка", minsToStart: mins, repeats: 1,
      selId: this.books.Betano.selId(pair.b, key), startMs, flip: !!pair.flip,
      // «тот ли матч» по ценам: ok / suspect (вилку нужно подтвердить отдельно) / nodata (сравнить не с чем)
      pairCheck: check ? check.status : "nodata", devS: check ? check.devS : null, devT: check ? check.devT : null,
      // сверка матча по номеру Sportradar: confirmed / mismatch / unknown / noid; null — ещё не проверяли
      identity: (this.identity.get(pair.id) || {}).status || null, identityWhy: (this.identity.get(pair.id) || {}).why || null,
      kC: null, drop: null, arbC: null, noClose: false, closedAt: null,                  // цена закрытия (раздел 9)
      result: null, resultSource: null,                                                  // расчёт (разделы 10–11)
    };
    this.arbs.set(id, rec);
    if (!this.byPair.has(pair.id)) this.byPair.set(pair.id, new Set());
    this.byPair.get(pair.id).add(id);
    this.onArb(rec, "new");
    return rec;
  }

  // Цена закрытия: матч стартовал → состояние заморожено. kC — последняя цена Betano по исходу до старта.
  _closeStarted(now) {
    const B = this.books.Betano, P = this.books.Pinnacle;
    for (const [pairId, ids] of this.byPair) {
      if (this.closedPairs.has(pairId)) continue;
      const pair = this.matcher.pairs.get(pairId); if (!pair) continue;
      const startMs = this._startMs(pair);
      if (!startMs || now < startMs) continue;
      const noClose = this._inGap(startMs, now);
      const ps = P.gs.get(pair.p);
      const getP = (key) => { const c = ps && ps.prices.get(pair.flip ? flipKey(key) : key); return c ? c.price : undefined; };
      for (const id of ids) {
        const rec = this.arbs.get(id);
        rec.closedAt = now; rec.noClose = noClose;
        if (!noClose) {
          const kC = B.lastPrice(pair.b, rec.key);
          if (kC > 0) {
            rec.kC = kC; rec.drop = kC / rec.price - 1;              // снижение: kC / цена сигнала − 1
            const o = oppositePrice(rec.key, getP); rec.arbC = o ? arbOf(kC, o.opp) : null;
          }
        }
        this.onArb(rec, "close");
      }
      this.closedPairs.add(pairId);
    }
  }

  // Текущие вилки по ещё не начавшимся парам (по последней оценке), по убыванию размера.
  scan() {
    const out = [];
    for (const [pairId, cur] of this.current) {
      const pair = this.matcher.pairs.get(pairId); if (!pair) continue;
      const bg = this.books.Betano.games.get(pair.b) || {};
      for (const a of cur.arbs) {
        out.push({ ...a, pairId, sportType: pair.sport, t1: pair.t1, t2: pair.t2, league: pair.league, link: bg.link || "",
          what: describeKey(a.key, pair.t1, pair.t2), mins: cur.mins, flick: cur.flick, at: cur.at,
          pairCheck: cur.check ? cur.check.status : "nodata",
          identity: (this.identity.get(pairId) || {}).status || null,
          selId: this.books.Betano.selId(pair.b, a.key) });
      }
    }
    return out.sort((x, y) => y.arb - x.arb);
  }

  summary() {
    const bySport = {};
    for (const p of this.matcher.pairs.values()) bySport[p.sport] = (bySport[p.sport] || 0) + 1;
    return {
      games: { Betano: this.books.Betano.games.size, Pinnacle: this.books.Pinnacle.games.size },
      pairs: this.matcher.pairs.size, pairsBySport: bySport, disputed: this.matcher.disputed().length,
      arbsJournal: this.arbs.size, arbsNow: this.scan().length, reloads: { Betano: this.books.Betano.reloads, Pinnacle: this.books.Pinnacle.reloads },
      gaps: { Betano: this.gaps.Betano.length, Pinnacle: this.gaps.Pinnacle.length }, rate429: this.rate429,
    };
  }
}

module.exports = { PrematchEngine, ORDER, GAP_MS, DEFAULT_SPORTS };
