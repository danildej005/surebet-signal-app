"use strict";
// ПРЕМАТЧ: сопоставление матчей Pinnacle ↔ Betano по названиям и времени (docs/PREMATCH-HANDBOOK.md, раздел 3).
// Общего id событий нет (у Betano compareEventId = 0). Чистая логика, покрыта test/prematch.test.cjs.
//
// Футбол — правила хендбука дословно (проверены на 1 223 парах записи). Остальные виды спорта — те же правила
// с двумя отличиями, которые видны на дампе фида 19.11.2026 (в хендбуке их нет, он только про футбол):
//   • порядок команд между конторами бывает перевёрнут (US-лиги: «Bucks vs Blazers» ↔ «Blazers vs Bucks») → flip;
//   • теннис: время старта у контор расходится на часы (расписание «не раньше»), зато имена игроков уникальны →
//     допуск по времени шире, а совпадение имён требуется полное.

const FOOTBALL = 1, TENNIS = 3;

// Служебные слова (хендбук 3.1) — в токены не входят.
const SERVICE = new Set(("fc cf sc ac afc cd ca club de the fk sk if bk cs sv as us ss rc ud sd fs cfc sfc ff kf nk sp bc c f " +
  "team and").split(" "));
// Не-футбол: шум киберспортивных названий («LGD Gaming» ↔ «LGD») — из нашего опыта склейки лайва.
const NOISE_OTHER = new Set(["esports", "esport", "gaming"]);
const RESERVE = new Set(["ii", "b", "2", "res", "reserves"]);
// «women» — подстрокой (хендбук 3.1): у Pinnacle бывает «National Womens Soccer League». «wta» — женский теннисный тур
// (у Betano лига «Colina (W)», у Pinnacle «WTA 125k Colina») — замер 22.11.2026: без этого пары терялись.
const WOMEN_RE = /\(w\)|women|femenin|feminin|frauen|ladies|damen|\(f\)|\bwta\b/i;
const WOMEN_TOKEN = /^(w|womens?|femenin[a-z]*|feminin[a-z]*|frauen|ladies|damen|wta)$/;
const AGE_RE = /(?:^|[^a-z])u-?(\d\d)(?!\d)/i;

const deaccent = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// PURE: название команды + название лиги → { age, women, reserve, tokens }.
// Возраст и женский признак берём И из лиги: у Pinnacle команда «Czechia», а лига «U21 Euro Championship Qualifiers».
function parseTeam(name, league, sportType) {
  const n = deaccent(name), lg = deaccent(league);
  const am = AGE_RE.exec(n) || AGE_RE.exec(lg);
  const age = am ? Number(am[1]) : 0;
  const women = WOMEN_RE.test(n) || WOMEN_RE.test(lg);
  let reserve = false;
  const tokens = [];
  for (const t of n.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    if (RESERVE.has(t)) { reserve = true; continue; }
    if (/^u\d\d$/.test(t) || (age && (t === "u" || t === String(age)))) continue; // возрастная метка
    if (WOMEN_TOKEN.test(t)) continue;
    if (SERVICE.has(t)) continue;
    if (Number(sportType) !== FOOTBALL && NOISE_OTHER.has(t)) continue;
    tokens.push(t);
  }
  // всё название состояло из служебных слов → не оставляем пустым (иначе sim всегда 0)
  if (!tokens.length) for (const t of n.split(/[^a-z0-9]+/)) if (t) tokens.push(t);
  return { age, women, reserve, tokens };
}

// PURE: сходство двух наборов токенов (хендбук 3.2). Токены равны ИЛИ один — начало другого при длине от 4.
// Делим на размер меньшего набора; сверху ограничиваем 1 (два токена A могут попасть в один токен B).
function sim(a, b) {
  if (!a.length || !b.length) return 0;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  let hit = 0;
  for (const t of x) {
    if (y.some((u) => u === t || (Math.min(t.length, u.length) >= 4 && (t.startsWith(u) || u.startsWith(t))))) hit++;
  }
  return Math.min(1, hit / x.length);
}

// PURE: разобрать игру фида в форму для сопоставления.
function parseGame(g) {
  const sport = Number(g.sportType);
  return {
    id: g.textId, sport, start: Number(g.startTimeStamp) || 0, league: g.leagueName || "",
    name1: g.team1NameEn || "", name2: g.team2NameEn || "",
    h: parseTeam(g.team1NameEn, g.leagueName, sport), a: parseTeam(g.team2NameEn, g.leagueName, sport),
  };
}

const sameFlags = (x, y) => x.age === y.age && x.women === y.women && x.reserve === y.reserve;

// Допуски (хендбук 3.3): старт ±15 минут. Теннис — ±12 часов (см. шапку файла).
const TOL_SEC = 15 * 60, TOL_TENNIS_SEC = 12 * 3600;

// PURE: годится ли пара игр (b — Betano, p — Pinnacle; обе после parseGame). Возврат null или
// { sum, simH, simA, flip } — flip=true, если у Pinnacle команды перечислены в обратном порядке.
function pairScore(b, p) {
  if (b.sport !== p.sport) return null;
  const tennis = b.sport === TENNIS;
  if (!b.start || !p.start || Math.abs(b.start - p.start) > (tennis ? TOL_TENNIS_SEC : TOL_SEC)) return null;
  const tryOrder = (ph, pa, flip) => {
    if (!sameFlags(b.h, ph) || !sameFlags(b.a, pa)) return null;       // возраст, женский признак, резерв — у обеих команд
    const simH = sim(b.h.tokens, ph.tokens), simA = sim(b.a.tokens, pa.tokens);
    if (tennis) { if (simH < 1 || simA < 1) return null; }             // теннис: имена обязаны совпасть полностью
    else if (simH < 0.5 || simA < 0.5 || simH + simA < 1.5) return null; // «Man United / Man City» = 0.5 → нужен порог суммы
    return { sum: simH + simA, simH, simA, flip };
  };
  const straight = tryOrder(p.h, p.a, false);
  if (b.sport === FOOTBALL) return straight;                           // футбол: хозяева с хозяевами, без переворота
  const flipped = tryOrder(p.a, p.h, true);
  if (straight && flipped) return flipped.sum > straight.sum ? flipped : straight;
  return straight || flipped;
}

// Сопоставление «на лету»: новые игры копятся в несопоставленных, sync() собирает пары.
// Одна игра входит только в одну пару; при нескольких кандидатах берётся наибольшая сумма сходства.
class Matcher {
  constructor() {
    this.un = { Betano: new Map(), Pinnacle: new Map() }; // id → parseGame
    this.pairs = new Map();                               // pairId → пара
    this.byGame = new Map();                              // id игры (любой конторы) → pairId
    this._touched = false;
  }

  add(book, game) {
    if (!game || !game.textId || this.byGame.has(game.textId) || this.un[book].has(game.textId)) return;
    this.un[book].set(game.textId, parseGame(game));
    this._touched = true;
  }

  // Собрать пары из несопоставленных. Возврат — массив НОВЫХ пар.
  sync() {
    if (!this._touched) return [];
    this._touched = false;
    const bySport = new Map();
    for (const p of this.un.Pinnacle.values()) { if (!bySport.has(p.sport)) bySport.set(p.sport, []); bySport.get(p.sport).push(p); }
    const cands = [];
    for (const b of this.un.Betano.values()) {
      for (const p of bySport.get(b.sport) || []) {
        const s = pairScore(b, p);
        if (s) cands.push({ b, p, ...s });
      }
    }
    // жадно: сначала самые похожие; при равенстве — ближе по времени старта
    cands.sort((x, y) => (y.sum - x.sum) || (Math.abs(x.b.start - x.p.start) - Math.abs(y.b.start - y.p.start)));
    const out = [];
    for (const c of cands) {
      if (!this.un.Betano.has(c.b.id) || !this.un.Pinnacle.has(c.p.id)) continue;
      this.un.Betano.delete(c.b.id); this.un.Pinnacle.delete(c.p.id);
      const pair = {
        id: c.b.id + "~" + c.p.id, b: c.b.id, p: c.p.id, sport: c.b.sport, flip: c.flip,
        sum: c.sum, simH: c.simH, simA: c.simA,
        t1: c.b.name1, t2: c.b.name2, p1: c.p.name1, p2: c.p.name2, league: c.b.league, pLeague: c.p.league,
        startB: c.b.start, startP: c.p.start,
      };
      this.pairs.set(pair.id, pair); this.byGame.set(pair.b, pair.id); this.byGame.set(pair.p, pair.id);
      out.push(pair);
    }
    return out;
  }

  pairOf(gameId) { const id = this.byGame.get(gameId); return id ? this.pairs.get(id) : null; }

  // Спорные пары — на ручную проверку (хендбук 3.4: перед расчётом смотреть 20–30 пар глазами).
  disputed() { return [...this.pairs.values()].filter((p) => p.sum < 2 || p.startB !== p.startP); }
}

module.exports = { parseTeam, sim, parseGame, pairScore, Matcher, FOOTBALL, TENNIS, TOL_SEC, TOL_TENNIS_SEC };
