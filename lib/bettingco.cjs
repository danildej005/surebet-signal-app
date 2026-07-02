"use strict";
// Клиент сырого live-фида bettingco (apiparsers.bettingco.pro) + ЧИСТЫЙ расчёт live-value Betano vs Pinnacle.
// Обе конторы приходят с ОДНОГО ключа (X-Api-Key), синхронно, обновление 0.5–1с. Pinnacle — эталон (de-vig),
// Betano — цель ставки. Общего id событий НЕТ → матч по именам; рынки матчим по нормализованному surebetTextId
// (одинаков в обеих книгах). Чистая логика покрыта тестами (test/bettingco.test.cjs). Ключ — секрет, в git не кладём.
const https = require("https");
const HOST = "apiparsers.bettingco.pro";

// GET GameData одной конторы (bookmakerType строкой: "Betano" | "Pinnacle"). X-Api-Key в заголовке.
function getBookmakerData(bookmakerType, key, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: opts.host || HOST, path: "/GameData/GetBookmakerData?bookmakerType=" + encodeURIComponent(bookmakerType),
        headers: { "X-Api-Key": key, Accept: "application/json" }, timeout: opts.timeoutMs || 30000 },
      (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => {
          if (res.statusCode === 204 || !b) return resolve(null);
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("bettingco не JSON (" + res.statusCode + "): " + b.slice(0, 120))); }
        });
      });
    req.on("timeout", () => req.destroy(new Error("bettingco таймаут " + bookmakerType)));
    req.on("error", reject);
  });
}

// PURE: нормализация имени команды/игрока (для матча событий по именам, без общего id).
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// PURE: sportType (enum bettingco, совпадает с /getsports) → русское название. Для статистики.
const SPORTS = {
  0: "—", 1: "Футбол", 2: "Хоккей", 3: "Теннис", 4: "Баскетбол", 5: "Волейбол", 6: "Гандбол",
  7: "Наст. теннис", 8: "Бадминтон", 9: "Бейсбол", 10: "Регби", 11: "Ам. футбол", 12: "Снукер",
  13: "Дартс", 14: "Водное поло", 21: "Киберспорт", 22: "Кибер-футбол", 23: "Кибер-баскет",
  24: "Кибер-теннис", 25: "Кибер-хоккей", 26: "Футзал", 27: "Крикет", 28: "Флорбол", 29: "CS",
  30: "Dota", 31: "LoL", 32: "Valorant", 33: "Хоккей на траве", 34: "Сквош", 35: "Велоспорт",
};
const sportName = (t) => SPORTS[t] || ("sport#" + t);

// PURE: счёт матча в массив сетов [["6","1"],["1","0"]] (без «|CurrentGame:X» и пробелов).
const parseScore = (s) => { const k = String(s || "").split("|")[0].replace(/\s+/g, ""); return k ? k.split(",").map((x) => x.split("-")) : []; };
// PURE: синхронны ли плечи по событию + перевёрнут ли порядок команд между книгами. Возврат {sync, flip}.
// flip=true, если книги перечислили команды в РАЗНОМ порядке (тогда счёт и стороны сравниваем «наоборот»).
// Рассинхрон счёта = одно плечо протухло на событии → value ложный, скипаем.
function eventSync(gb, gp) {
  const flip = norm(gb.team1NameEn) !== norm(gp.team1NameEn);
  const a = parseScore(gb.currentScore), b = parseScore(gp.currentScore);
  if (!a.length && !b.length) return { sync: true, flip };   // прематч — ок
  if (a.length !== b.length) return { sync: false, flip };
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = flip ? [b[i][1], b[i][0]] : b[i];      // при flip у Pinnacle меняем местами счёт пары
    if (p[0] !== q[0] || p[1] !== q[1]) return { sync: false, flip };
  }
  return { sync: true, flip };
}

// PURE: игры → Map(ключ-пары имён → игра). Ключ независим от порядка команд.
function gamesByPair(gamesModel) {
  const m = new Map();
  for (const g of Object.values(gamesModel || {})) {
    const k = [norm(g.team1NameEn), norm(g.team2NameEn)].sort().join("~");
    m.set(k, g);
  }
  return m;
}

// PURE: сопоставить события Betano↔Pinnacle по именам. Возврат [{key, b, p}].
function matchEvents(betanoGames, pinnacleGames) {
  const bi = gamesByPair(betanoGames), pi = gamesByPair(pinnacleGames);
  const out = [];
  for (const [k, b] of bi) { const p = pi.get(k); if (p) out.push({ key: k, b, p }); }
  return out;
}

// PURE: рынки → Map(gameTextId → [рынки]).
function marketsByGame(marketsModel) {
  const m = new Map();
  for (const x of Object.values(marketsModel || {})) {
    const g = x.gameTextId; if (!g) continue;
    if (!m.has(g)) m.set(g, []); m.get(g).push(x);
  }
  return m;
}

// Разрешённые рынки: только ПОЛНЫЙ матч (без live-подсегментов текущего сета/гейма — там шум и лаг).
const isMainMarket = (st) => st === "/Main/Main" || st === "/Main/Main/Game";

// PURE: исходы Pinnacle одной игры → { "<surebetTextId>|<betType>|<absParam>": {A:odds, B:odds} }.
// meta структурная: gameId|period|BETTYPE|TEAMSLOT|SIDE|param|extra. A/B: ML/SPREAD → team1/team2, TOTAL → over/under.
// flip=true (книги перечислили команды наоборот) → у командных рынков TEAM1↔TEAM2 меняем местами, чтобы A/B
// указывали на ТЕ ЖЕ команды, что у Betano (иначе de-vig считает по чужой стороне).
function pinnacleOutcomes(markets, flip) {
  const T1 = flip ? "B" : "A", T2 = flip ? "A" : "B";
  const out = {};
  for (const x of markets || []) {
    const st = x.surebetTextId; if (!isMainMarket(st)) continue;
    const p = String(x.meta || "").split("|");
    const bet = p[2], slot = p[3], side = p[4];
    let kind, ab;
    if (bet === "MONEYLINE") { kind = "ML"; ab = slot === "TEAM1" ? T1 : slot === "TEAM2" ? T2 : null; }
    else if (bet === "TOTAL_POINTS") { kind = "TOTAL"; ab = side === "OVER" ? "A" : side === "UNDER" ? "B" : null; }
    else if (bet === "SPREAD") { kind = "SPREAD"; ab = slot === "TEAM1" ? T1 : slot === "TEAM2" ? T2 : null; }
    else continue;
    if (!ab || !(x.marketValue > 1)) continue;
    const param = kind === "ML" ? "" : Math.abs(Number(x.marketParameter));
    const key = st + "|" + kind + "|" + param;
    (out[key] || (out[key] = {}))[ab] = x.marketValue;
  }
  return out;
}

// PURE: исходы Betano одной игры → тот же формат ключей. meta человекочитаемая. t1/t2 — имена для маппинга стороны.
// Тоталы с именем игрока (напр. «X Games Won | Over») ОТСЕКАЕМ — это не матчевый тотал (защита от подмены рынка).
function betanoOutcomes(markets, t1, t2) {
  const n1 = norm(t1), n2 = norm(t2), out = {};
  for (const x of markets || []) {
    const st = x.surebetTextId; if (!isMainMarket(st)) continue;
    const meta = String(x.meta || ""), mn = norm(meta), k = x.marketValue;
    if (!(k > 1)) continue;
    let kind, ab, param = "";
    if (/^winner/i.test(meta)) {
      kind = "ML"; const who = norm(meta.split("|").pop());
      ab = who === n1 ? "A" : who === n2 ? "B" : null;
    } else if (/\bover\b/i.test(meta) || /\bunder\b/i.test(meta)) {
      // матчевый тотал: НЕ содержит имени игрока (иначе это персональный тотал — другой рынок)
      if (mn.includes(n1) || mn.includes(n2)) continue;
      kind = "TOTAL"; ab = /\bover\b/i.test(meta) ? "A" : "B"; param = Math.abs(Number(x.marketParameter));
    } else if (/handicap/i.test(meta)) {
      kind = "SPREAD"; const who = norm(meta.split("|").pop().replace(/[-\d.\s]+$/, ""));
      ab = who === n1 ? "A" : who === n2 ? "B" : null; param = Math.abs(Number(x.marketParameter));
    } else continue;
    if (!ab) continue;
    const key = st + "|" + kind + "|" + param;
    (out[key] || (out[key] = {}))[ab] = k;
  }
  return out;
}

// PURE: de-vig 2-way → [fairA, fairB].
function devig2(oddsA, oddsB) { const ra = 1 / oddsA, rb = 1 / oddsB, o = ra + rb; return [ra / o, rb / o]; }

// PURE: value-сигналы для одного события. Для каждого 2-way рынка, что есть в ОБЕИХ книгах (обе стороны):
// de-vig Pinnacle → fair, value = кэф_Betano × fair − 1. maxPlausible режет артефакты (мисматч рынка).
function valueForEvent(betanoMarkets, pinnacleMarkets, t1, t2, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.02;
  const maxPlausible = opts.maxPlausible != null ? opts.maxPlausible : 0.25;
  const B = betanoOutcomes(betanoMarkets, t1, t2), P = pinnacleOutcomes(pinnacleMarkets, opts.flip);
  const sigs = [];
  for (const key of Object.keys(P)) {
    const p = P[key], b = B[key];
    if (!b || !(p.A > 1 && p.B > 1 && b.A > 1 && b.B > 1)) continue; // обе стороны в обеих книгах
    const [fA, fB] = devig2(p.A, p.B);
    for (const [ab, fair] of [["A", fA], ["B", fB]]) {
      const v = b[ab] * fair - 1;
      if (v >= threshold && v <= maxPlausible) {
        const [st, kind, param] = key.split("|");
        sigs.push({ market: st + " " + kind + (param ? " " + param : ""), kind, param, side: ab,
          betanoOdds: b[ab], pinnacleOdds: p[ab], fair, value: v, t1, t2 });
      }
    }
  }
  return sigs.sort((x, y) => y.value - x.value);
}

// Полный проход по одному ответу пары фидов: матч событий → value-сигналы (плоский список, по убыванию value).
function scanValue(betanoData, pinnacleData, opts = {}) {
  const bmg = marketsByGame(betanoData.marketsOriginModel && betanoData.marketsOriginModel.model);
  const pmg = marketsByGame(pinnacleData.marketsOriginModel && pinnacleData.marketsOriginModel.model);
  const events = matchEvents(betanoData.gamesOriginModel && betanoData.gamesOriginModel.model,
    pinnacleData.gamesOriginModel && pinnacleData.gamesOriginModel.model);
  const out = [];
  for (const e of events) {
    const sync = eventSync(e.b, e.p);
    if (!sync.sync) continue; // плечи рассинхронены по счёту → скип
    // gameTextId рынков = textId игры (в обеих книгах свой префикс — берём каждой книги свой)
    const sigs = valueForEvent(bmg.get(e.b.textId) || [], pmg.get(e.p.textId) || [], e.b.team1NameEn, e.b.team2NameEn, { ...opts, flip: sync.flip });
    for (const s of sigs) { s.league = e.b.leagueName; s.link = e.b.link; s.score = e.b.currentScore; s.sportType = e.b.sportType; s.sport = sportName(e.b.sportType); out.push(s); }
  }
  return out.sort((a, b) => b.value - a.value);
}

// ── СНИМКИ (модель сессии): опрос обеих книг СИНХРОННО каждую ~1с через дельты (штатный путь фида,
// 500–1000мс). Полный GetBookmakerData (лимит 1/5с) — только инициализация + пере-инициализация на mismatch. ──

// GET дельт после lastSnapshotTime. Возврат: тело ответа ({snapshots[], ...} или {error}).
function getSnapshots(bookmakerType, key, sessionGuid, lastSnapshotTime, opts = {}) {
  return new Promise((resolve, reject) => {
    const q = "?bookmakerType=" + encodeURIComponent(bookmakerType) + "&SessionId=" + encodeURIComponent(sessionGuid) +
      "&lastSnapshotTime=" + encodeURIComponent(lastSnapshotTime);
    const req = https.get(
      { host: opts.host || HOST, path: "/GameData/GetBookmakerSnapshots" + q,
        headers: { "X-Api-Key": key, Accept: "application/json" }, timeout: opts.timeoutMs || 20000 },
      (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => {
          if (res.statusCode === 429) return resolve({ error: "429 rate", rate: true });
          if (res.statusCode === 204 || !b) return resolve({ snapshots: [] });
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("snapshots не JSON (" + res.statusCode + "): " + b.slice(0, 120))); }
        });
      });
    req.on("timeout", () => req.destroy(new Error("snapshots таймаут " + bookmakerType)));
    req.on("error", reject);
  });
}

// PURE: применить один снимок-дельту к состоянию {games, markets}. Возврат writeTime снимка (курсор).
function applySnapshot(state, snap) {
  if (!state.touched) state.touched = {}; // gameTextId → writeTime последнего изменения события (для свежести)
  const wt = snap.writeTime || null;
  const bump = (gt) => { if (gt && wt) state.touched[gt] = wt; };
  for (const it of snap.marketsRemoved || []) delete state.markets[it.textId];
  for (const it of snap.marketsAdded || []) if (it.marketModel) { state.markets[it.textId] = it.marketModel; bump(it.gameTextId || it.marketModel.gameTextId); }
  for (const it of snap.marketsUpdated || []) if (it.marketModel) { state.markets[it.textId] = it.marketModel; bump(it.gameTextId || it.marketModel.gameTextId); }
  for (const it of snap.gamesRemoved || []) delete state.games[it.textId];
  for (const it of snap.gamesAdded || []) if (it.gameModel) { state.games[it.textId] = it.gameModel; bump(it.textId); }
  for (const it of snap.gamesUpdated || []) {
    const g = state.games[it.textId];
    if (it.gameModel) state.games[it.textId] = it.gameModel;
    else if (g) { if (it.currentScore != null) g.currentScore = it.currentScore; if (it.statusType != null) g.statusType = it.statusType; }
    bump(it.textId);
  }
  return wt;
}

// Состояние книги из GetBookmakerData: {book, sessionGuid, cursor, games, markets}. Применяет начальные снимки.
function stateFromData(book, data) {
  const state = {
    book, sessionGuid: null,
    cursor: (data.gamesOriginModel && data.gamesOriginModel.writeTime) || null,
    games: { ...(data.gamesOriginModel && data.gamesOriginModel.model) },
    markets: { ...(data.marketsOriginModel && data.marketsOriginModel.model) },
    touched: {},
  };
  for (const k of Object.keys(state.games)) state.touched[k] = state.cursor; // все события свежие на момент загрузки
  const snaps = data.snapshots || [];
  for (const s of snaps) { const wt = applySnapshot(state, s); if (wt && (!state.cursor || wt > state.cursor)) state.cursor = wt; }
  if (snaps.length) state.sessionGuid = snaps[snaps.length - 1].sessionGuid;
  return state;
}

// Применить ответ getSnapshots к состоянию (дельты, продвинуть курсор). Возврат {applied, mismatch, rate}.
function applySnapshotsResponse(state, resp) {
  if (resp && resp.rate) return { applied: 0, mismatch: false, rate: true };
  if (resp && resp.error) return { applied: 0, mismatch: /sessionid/i.test(resp.error), rate: false };
  let applied = 0;
  for (const s of (resp && resp.snapshots) || []) { const wt = applySnapshot(state, s); applied++; if (wt && (!state.cursor || wt > state.cursor)) state.cursor = wt; }
  return { applied, mismatch: false, rate: false };
}

// PURE: value-скан из ДВУХ состояний {games, markets} (синхронный путь снимков). СТОРОЖ ПО СОБЫТИЮ:
// (1) счёт матча должен совпасть между плечами; (2) событие должно быть свежим в ОБЕИХ книгах — не молчать
// дольше freshMs относительно курсора своей книги. Иначе плечо протухло на этом матче → value ложный, скип.
function scanValueState(bState, pState, opts = {}) {
  const freshMs = opts.freshMs != null ? opts.freshMs : 30000;
  const bmg = marketsByGame(bState.markets), pmg = marketsByGame(pState.markets);
  const bCur = bState.cursor ? new Date(bState.cursor).getTime() : 0, pCur = pState.cursor ? new Date(pState.cursor).getTime() : 0;
  const bT = bState.touched || {}, pT = pState.touched || {};
  const age = (cur, touched, id) => (cur && touched[id]) ? (cur - new Date(touched[id]).getTime()) : 0; // насколько событие отстало от курсора книги
  const out = [];
  for (const e of matchEvents(bState.games, pState.games)) {
    const sync = eventSync(e.b, e.p);
    if (!sync.sync) continue;                                                        // рассинхрон счёта
    if (age(bCur, bT, e.b.textId) > freshMs || age(pCur, pT, e.p.textId) > freshMs) continue; // событие замолчало
    const sigs = valueForEvent(bmg.get(e.b.textId) || [], pmg.get(e.p.textId) || [], e.b.team1NameEn, e.b.team2NameEn, { ...opts, flip: sync.flip });
    for (const s of sigs) { s.league = e.b.leagueName; s.link = e.b.link; s.score = e.b.currentScore; s.sportType = e.b.sportType; s.sport = sportName(e.b.sportType); out.push(s); }
  }
  return out.sort((a, b) => b.value - a.value);
}

module.exports = {
  getBookmakerData, norm, SPORTS, sportName, gamesByPair, matchEvents, marketsByGame,
  pinnacleOutcomes, betanoOutcomes, devig2, valueForEvent, scanValue,
  getSnapshots, applySnapshot, stateFromData, applySnapshotsResponse, scanValueState,
};
