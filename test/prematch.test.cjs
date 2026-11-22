"use strict";
// Прематч-движок (lib/prematch/*). Первые десять тестов — проверки из docs/PREMATCH-HANDBOOK.md, раздел 15.
const test = require("node:test");
const assert = require("node:assert");
const { parseTeam, sim, parseGame, pairScore, Matcher } = require("../lib/prematch/names.cjs");
const { classifyPinnacle, classifyBetano, flipKey, describeKey } = require("../lib/prematch/markets.cjs");
const { oppositePrice, arbOf, band } = require("../lib/prematch/arb.cjs");
const { BookState } = require("../lib/prematch/state.cjs");
const { PrematchEngine } = require("../lib/prematch/engine.cjs");
const { settle, parseFlashscore } = require("../lib/prematch/settle.cjs");
const { pairCheck } = require("../lib/prematch/guard.cjs");
const { ruleBlock } = require("../lib/prematch/rules.cjs");
const { legacyOf, arbToCandidate, arbAtPrice, choosePrematch, outcomeGroup, isFullMatch } = require("../lib/prematch/place.cjs");
const { verifyPick, verifySlipMarket } = require("../lib/bookers.cjs");
const { parseMatchInfo, pinnacleCountry, identityCheck, makeDirectory } = require("../lib/prematch/sportradar.cjs");

const START = 2000000000; // старт игр в тестах, сек
const T0 = (START - 3600) * 1000; // «сейчас» по умолчанию: за час до старта, мс

// ── заготовки моделей фида ──
const pGame = (o = {}) => ({ textId: "/Pinnacle/Football/L/A/B", leagueName: "L", team1NameEn: "Alpha", team2NameEn: "Beta",
  sportType: 1, startTimeStamp: START, compareEventId: 111, ...o });
const bGame = (o = {}) => ({ textId: "/Betano/Football/L/A/B", leagueName: "L", team1NameEn: "Alpha", team2NameEn: "Beta",
  sportType: 1, startTimeStamp: START, compareEventId: 0, link: "https://www.betano.cz/en/match-odds/a-b/1/", ...o });
let seq = 0;
const pMkt = (sb, value, param = null, o = {}) => ({ textId: "pm" + (++seq), gameTextId: "/Pinnacle/Football/L/A/B", surebetType: sb,
  marketType: 0, marketMeta: null, subMarketType: 0, specialKind: 0, marketParameter: param, marketValue: value,
  meta: "111|0|X", surebetTextId: "/Main/Main", ...o });
const bMkt = (sb, value, meta, param = null, o = {}) => ({ textId: "bm" + (++seq), gameTextId: "/Betano/Football/L/A/B", surebetType: sb,
  marketType: 0, marketMeta: null, subMarketType: 0, specialKind: 0, marketParameter: param, marketValue: value,
  meta, eventId: "777" + seq + "|1", surebetTextId: "/Main/Main", ...o });
const base = (games, markets, guid = "S1", writeTime = new Date(T0).toISOString()) => ({
  gamesOriginModel: { writeTime, model: Object.fromEntries(games.map((g) => [g.textId, g])) },
  marketsOriginModel: { writeTime, model: Object.fromEntries(markets.map((m) => [m.textId, m])) },
  snapshots: [{ sessionGuid: guid, writeTime }],
});

// ───────────────────────── раздел 15 хендбука ─────────────────────────

test("15.1 перезагрузка сессии с теми же ценами не порождает ни одного изменения цены", () => {
  const st = new BookState("Pinnacle", { now: () => T0 });
  const g = pGame(), ms = [pMkt(0, 2.1), pMkt(1, 3.4), pMkt(2, 3.3), pMkt(10, 1.9, 2.5), pMkt(11, 1.95, 2.5)];
  st.reload(base([g], ms, "S1"));
  st.dirty.clear();
  const before = st.gs.get(g.textId).changes;
  // новая сессия: те же рынки под новыми textId — как после перезапуска Pinnacle в фиде
  const again = ms.map((m) => ({ ...m, textId: m.textId + "-new" }));
  const d = st.reload(base([g], again, "S2"));
  assert.deepStrictEqual(d, { changed: 0, removed: 0, added: 0 });
  assert.strictEqual(st.gs.get(g.textId).changes, before);          // счётчик движений не тронут
  assert.strictEqual(st.sessionGuid, "S2");
  assert.deepStrictEqual([...st.dirty], [g.textId]);                // «грязная» только из-за самой перезагрузки
  assert.strictEqual(st.price(g.textId, "FT|x|0|h"), 2.1);
});

test("15.1b перезагрузка: реально изменившаяся цена считается одним изменением, пропавший рынок — снятым", () => {
  const st = new BookState("Pinnacle", { now: () => T0 });
  const g = pGame(), ms = [pMkt(0, 2.1), pMkt(1, 3.4), pMkt(2, 3.3)];
  st.reload(base([g], ms, "S1"));
  const d = st.reload(base([g], [{ ...ms[0], marketValue: 2.2 }, ms[1]], "S2"));
  assert.deepStrictEqual(d, { changed: 1, removed: 1, added: 0 });
  assert.strictEqual(st.gs.get(g.textId).changes, 1);
  assert.strictEqual(st.price(g.textId, "FT|x|0|d"), undefined);
});

test("15.2 рынок угловых Pinnacle не проходит классификатор (чужой id в начале meta)", () => {
  const g = pGame();
  assert.strictEqual(classifyPinnacle(pMkt(10, 1.9, 9.5, { meta: "999|0|TOTAL_POINTS||OVER|9.5", surebetTextId: "/Main/Main/Corner" }), g), null);
  assert.strictEqual(classifyPinnacle(pMkt(10, 1.9, 2.5, { meta: "111|0|TOTAL_POINTS||OVER|2.5" }), g).key, "FT|tot|2.5|o");
});

test("15.3 два рынка Betano с одним ключом: цена по ключу не меняется, пока жив первый", () => {
  const st = new BookState("Betano", { now: () => T0 });
  const g = bGame();
  const euro = bMkt(10, 1.8, "Over/Under Total Goals | Over 2.5", 2.5), asian = bMkt(10, 1.85, "Asian (Over/Under) Goals | Over 2.5", 2.5);
  st.reload(base([g], [euro, asian]));
  assert.strictEqual(st.price(g.textId, "FT|tot|2.5|o"), 1.8);
  st.updateMarket(asian.textId, 1.95, g.textId, T0 + 1000);          // второй рынок двигается — ключ не меняется
  assert.strictEqual(st.price(g.textId, "FT|tot|2.5|o"), 1.8);
  assert.strictEqual(st.gs.get(g.textId).changes, 0);
  st.removeMarket(euro.textId, g.textId, T0 + 2000);                 // владелец снят → ключ переходит второму
  assert.strictEqual(st.price(g.textId, "FT|tot|2.5|o"), 1.95);
});

test("15.4 фора гостей Pinnacle −0.5 попадает в ключ hc|0.5|a", () => {
  const c = classifyPinnacle(pMkt(16, 2.0, -0.5, { meta: "111|0|SPREAD|TEAM2||-0.5" }), pGame());
  assert.strictEqual(c.key, "FT|hc|0.5|a");
  assert.strictEqual(classifyPinnacle(pMkt(15, 1.9, 0.5, { meta: "111|0|SPREAD|TEAM1||0.5" }), pGame()).key, "FT|hc|0.5|h");
});

test("15.5 «x гости» против Pinnacle: противоположная цена — максимум из форы хозяев +0.5 и синтетики П1/Х", () => {
  const mk = (hc) => { const P = { "FT|x|0|h": 2.0, "FT|x|0|d": 3.6, "FT|x|0|a": 4.0, "FT|hc|0.5|h": hc }; return (k) => P[k]; };
  const synthPrice = 1 / (1 / 2.0 + 1 / 3.6);                        // ≈ 1.2857
  let o = oppositePrice("FT|x|0|a", mk(1.33));
  assert.strictEqual(o.opp, 1.33); assert.strictEqual(o.via, "фора хозяев +0.5");
  o = oppositePrice("FT|x|0|a", mk(1.25));
  assert.ok(Math.abs(o.opp - synthPrice) < 1e-12); assert.strictEqual(o.via, "П1 или Х");
});

test("15.6 изменение цены после startTimeStamp не меняет состояние (заморозка на старте)", () => {
  const st = new BookState("Betano", { now: () => T0 });
  const g = bGame(), m = bMkt(0, 2.5, "Match Result | Alpha");
  st.reload(base([g], [m]));
  st.updateMarket(m.textId, 2.4, g.textId, START * 1000 - 1);        // за миг до старта — применяется
  assert.strictEqual(st.price(g.textId, "FT|x|0|h"), 2.4);
  st.updateMarket(m.textId, 1.5, g.textId, START * 1000);            // на старте и позже — игнор
  st.removeMarket(m.textId, g.textId, START * 1000 + 5000);
  assert.strictEqual(st.price(g.textId, "FT|x|0|h"), 2.4);           // это и есть цена закрытия
  st.applySnapshot({ sessionGuid: "S1", writeTime: new Date(START * 1000 + 9000).toISOString(), gamesRemoved: [{ textId: g.textId }] });
  assert.strictEqual(st.price(g.textId, "FT|x|0|h"), 2.4);           // удаление игры состояние не стирает
});

test("15.7 тотал 2.25 больше при счёте 1:1: половина ставки проиграна, половина возвращена", () => {
  assert.strictEqual(settle("FT|tot|2.25|o", 1.9, [1, 1], [0, 0]), -0.5);
  assert.strictEqual(settle("FT|tot|2.75|o", 2.0, [2, 1], null), 0.5);   // 3 гола: половина выиграла, половина возврат
  assert.strictEqual(settle("FT|tot|2.5|u", 1.8, [1, 1], null), 0.8);
});

test("15.8 фора 0 при ничьей: возврат", () => {
  assert.strictEqual(settle("FT|dnb|0|h", 1.7, [1, 1], null), 0);
  assert.strictEqual(settle("FT|dnb|0|h", 1.7, [2, 1], null), 0.7);
  assert.strictEqual(settle("FT|dnb|0|a", 2.2, [2, 1], null), -1);
});

test("15.9 «2-2aet» с частями 0-0,2-1,0-1 даёт счёт 2:1 и первый тайм 0:0", () => {
  assert.deepStrictEqual(parseFlashscore("2-2aet (0-0,2-1,0-1)"), { ft: [2, 1], ht: [0, 0] });
  assert.deepStrictEqual(parseFlashscore("2-0 (1-0,1-0)"), { ft: [2, 0], ht: [1, 0] });
  assert.deepStrictEqual(parseFlashscore("1-1 (Pen: 5-3)"), { ft: [1, 1], ht: null });
  assert.strictEqual(parseFlashscore("-"), null);                    // матч не состоялся
});

test("15.10 «Ireland U21 – Finland U21» не сопоставляется с матчем других сборных U21 в то же время", () => {
  const b = parseGame({ textId: "b1", sportType: 1, startTimeStamp: START, leagueName: "UEFA U21 Championship Qualification", team1NameEn: "Ireland U21", team2NameEn: "Finland U21" });
  const other = parseGame({ textId: "p1", sportType: 1, startTimeStamp: START, leagueName: "U21 Euro Championship Qualifiers", team1NameEn: "Czechia", team2NameEn: "Scotland" });
  const same = parseGame({ textId: "p2", sportType: 1, startTimeStamp: START, leagueName: "U21 Euro Championship Qualifiers", team1NameEn: "Ireland", team2NameEn: "Finland" });
  const adults = parseGame({ textId: "p3", sportType: 1, startTimeStamp: START, leagueName: "Friendlies", team1NameEn: "Ireland", team2NameEn: "Finland" });
  assert.strictEqual(pairScore(b, other), null);
  assert.strictEqual(pairScore(b, adults), null);                    // без проверки возраста U21 цеплялся ко взрослым
  assert.strictEqual(pairScore(b, same).sum, 2);                     // возраст берётся из названия лиги
});

// ───────────────────────── сопоставление матчей ─────────────────────────

test("names: возраст, женский признак, резерв, служебные слова", () => {
  assert.deepStrictEqual(parseTeam("FC Barcelona (W)", "Primera Division (W)", 1), { age: 0, women: true, reserve: false, tokens: ["barcelona"] });
  assert.deepStrictEqual(parseTeam("Barcelona", "Spain - Primera Division Women", 1), { age: 0, women: true, reserve: false, tokens: ["barcelona"] });
  assert.deepStrictEqual(parseTeam("SK Slavia Praha II", "2. liga", 1), { age: 0, women: false, reserve: true, tokens: ["slavia", "praha"] });
  assert.deepStrictEqual(parseTeam("Bristol City U21", "PL2", 1), { age: 21, women: false, reserve: false, tokens: ["bristol", "city"] });
  assert.strictEqual(parseTeam("Deportivo Alavés", "LaLiga", 1).tokens.join(" "), "deportivo alaves"); // без диакритики
  assert.strictEqual(parseTeam("Kansas City Current", "USA - National Womens Soccer League", 1).women, true); // «Womens» слитно
  assert.strictEqual(parseTeam("Fernanda Labrana", "WTA 125k Colina - R16", 3).women, true);                  // женский тур
  assert.strictEqual(parseTeam("Fernanda Labrana", "Colina (W)", 3).women, true);
  assert.strictEqual(parseTeam("Carlos Alcaraz", "ATP Finals - Groups", 3).women, false);
});

test("names: «Manchester United / Manchester City» = 0.5 по одной команде → нужен порог суммы 1.5", () => {
  assert.strictEqual(sim(["manchester", "united"], ["manchester", "city"]), 0.5);
  assert.strictEqual(sim(["slavia", "praha"], ["slavia", "prague"]), 0.5);
  assert.strictEqual(sim(["kryvbas"], ["kryvbas", "kryvyi", "rih"]), 1);
  assert.strictEqual(sim(["metropolitan"], ["met"]), 0);            // начало другого — только при длине от 4
  const g = (id, t1, t2, o = {}) => parseGame({ textId: id, sportType: 1, startTimeStamp: START, leagueName: "L", team1NameEn: t1, team2NameEn: t2, ...o });
  assert.strictEqual(pairScore(g("b", "Manchester United", "Leeds"), g("p", "Manchester City", "Leeds")).sum, 1.5); // на пороге
  assert.strictEqual(pairScore(g("b", "Manchester United", "Leeds United"), g("p", "Manchester City", "Leeds City")), null);
  assert.strictEqual(pairScore(g("b", "Alpha", "Beta"), g("p", "Alpha", "Beta", { startTimeStamp: START + 16 * 60 })), null); // старт > 15 мин
  assert.strictEqual(pairScore(g("b", "Alpha", "Beta"), g("p", "Beta", "Alpha")), null);  // футбол: порядок команд обязан совпасть
  assert.strictEqual(pairScore(g("b", "Alpha II", "Beta"), g("p", "Alpha", "Beta")), null); // резерв ≠ основа
});

test("names: не-футбол — порядок команд может быть перевёрнут; теннис — имена полностью, время шире", () => {
  const g = (id, sp, t1, t2, dt = 0) => parseGame({ textId: id, sportType: sp, startTimeStamp: START + dt, leagueName: "L", team1NameEn: t1, team2NameEn: t2 });
  const nba = pairScore(g("b", 4, "Milwaukee Bucks", "Portland Trail Blazers"), g("p", 4, "Portland Trail Blazers", "Milwaukee Bucks", -600));
  assert.strictEqual(nba.flip, true); assert.strictEqual(nba.sum, 2);
  assert.strictEqual(pairScore(g("b", 3, "Henrique Rocha", "Guido Ivan Justo"), g("p", 3, "Henrique Rocha", "Guido Ivan Justo", -270 * 60)).sum, 2);
  assert.strictEqual(pairScore(g("b", 3, "Francisco Cerundolo", "Taro Daniel"), g("p", 3, "Juan Manuel Cerundolo", "Taro Daniel")), null); // братья
  assert.strictEqual(pairScore(g("b", 3, "A Player", "B Player"), g("p", 3, "A Player", "B Player", 13 * 3600)), null);
});

test("Matcher: одна игра — в одной паре, при нескольких кандидатах берётся наибольшая сумма", () => {
  const m = new Matcher();
  const g = (id, t1, t2) => ({ textId: id, sportType: 1, startTimeStamp: START, leagueName: "L", team1NameEn: t1, team2NameEn: t2 });
  m.add("Betano", g("b1", "Manchester United", "Leeds")); m.add("Betano", g("b2", "Manchester City", "Leeds"));
  m.add("Pinnacle", g("p1", "Manchester City", "Leeds"));
  const fresh = m.sync();
  assert.strictEqual(fresh.length, 1); assert.strictEqual(fresh[0].b, "b2");
  assert.strictEqual(m.pairOf("p1").b, "b2"); assert.strictEqual(m.pairOf("b1"), null);
  m.add("Pinnacle", g("p2", "Manchester Utd", "Leeds"));              // «на лету»: пришла новая игра
  const late = m.sync();                                              // utd ≠ united → 0.5 + 1 = 1.5: на пороге, b1 свободна → пара
  assert.strictEqual(late.length, 1); assert.strictEqual(late[0].b, "b1");
  assert.strictEqual(m.disputed().length, 1);                         // сходство неполное → в список на ручную проверку
  m.add("Pinnacle", g("p3", "Manchester City", "Leeds"));             // дубль уже занятого матча — пары не будет
  assert.strictEqual(m.sync().length, 0);
});

// ───────────────────────── классификация рынков ─────────────────────────

test("markets: Betano футбол — стороны тотала берутся из кода, а не из слова Over в названии рынка", () => {
  const g = bGame();
  assert.strictEqual(classifyBetano(bMkt(10, 1.9, "Over/Under Total Goals | Over 2.5", 2.5), g).key, "FT|tot|2.5|o");
  assert.strictEqual(classifyBetano(bMkt(11, 1.9, "Over/Under Total Goals | Under 2.5", 2.5), g).key, "FT|tot|2.5|u");
  assert.strictEqual(classifyBetano(bMkt(11, 2.05, "Asian (Over/Under) Goals | Under 2.75", 2.75), g).key, "FT|tot|2.75|u");
  assert.strictEqual(classifyBetano(bMkt(6, 1.7, "Alpha - Over/Under Total Goals | Alpha Over 1.5", 1.5), g).key, "FT|tt1|1.5|o");
});

test("markets: Betano футбол — периоды, фора 0, двойной шанс, обе забьют; лишнее отсекается", () => {
  const g = bGame(), h1 = { marketType: 3, marketMeta: "1" }, h2 = { marketType: 3, marketMeta: "2" };
  assert.strictEqual(classifyBetano(bMkt(1, 3.1, "Match Result | Beta"), g).key, "FT|x|0|a");
  assert.strictEqual(classifyBetano(bMkt(2, 2.1, "First-Half Result | Draw", null, h1), g).key, "1H|x|0|d");
  assert.strictEqual(classifyBetano(bMkt(1, 3.9, "Second-Half Result | Beta", null, h2), g).key, "2H|x|0|a");
  assert.strictEqual(classifyBetano(bMkt(0, 1.6, "Draw No Bet | Alpha", null, { specialKind: 200 }), g).key, "FT|dnb|0|h");
  assert.strictEqual(classifyBetano(bMkt(4, 1.5, "Halftime Double Chance | Beta or Draw", null, h1), g).key, "1H|dc|0|x2");
  assert.strictEqual(classifyBetano(bMkt(17, 1.8, "Both Teams to Score | Yes"), g).key, "FT|btts|0|y");
  assert.strictEqual(classifyBetano(bMkt(12, 1.9, "Total Goals Odd/Even | Odd"), g).key, "FT|odd|0|o");
  // не про голы / не тот период / не тот specialKind
  assert.strictEqual(classifyBetano(bMkt(10, 1.9, "Over/Under Corners | Over 9.5", 10, { specialKind: 3 }), g), null);
  assert.strictEqual(classifyBetano(bMkt(6, 1.9, "First Half Alpha Over/Under Corners | Alpha Over 4.5", 4.5, h1), g), null);
  assert.strictEqual(classifyBetano(bMkt(10, 1.9, "Over/Under First Half Goals | Over 1.5", 1.5), g), null); // тайм с типом матча
  assert.strictEqual(classifyBetano(bMkt(0, 2.0, "To Win Either Half | Alpha"), g), null);                 // исход без «Result»
  assert.strictEqual(classifyBetano(bMkt(15, 1.9, "Handicap Match Result | Alpha +1", 1), g), null);        // евро-гандикап
  assert.strictEqual(classifyBetano(bMkt(10, 1.9, "Over/Under Total Goals | Over 2.5", 2.5, { subMarketType: 1 }), g), null);
});

test("markets: Pinnacle — исход только при пустом параметре, период 2H и доп. время не берём", () => {
  const g = pGame();
  assert.strictEqual(classifyPinnacle(pMkt(2, 3.3), g).key, "FT|x|0|d");
  assert.strictEqual(classifyPinnacle(pMkt(0, 2.0, 1), g), null);
  assert.strictEqual(classifyPinnacle(pMkt(0, 2.6, null, { marketType: 3, marketMeta: "1", meta: "111|1|MONEYLINE" }), g).key, "1H|x|0|h");
  assert.strictEqual(classifyPinnacle(pMkt(0, 2.6, null, { marketType: 3, marketMeta: "2" }), g), null);
  assert.strictEqual(classifyPinnacle(pMkt(0, 2.6, null, { marketType: 3, marketMeta: "8" }), g), null);
  assert.strictEqual(classifyPinnacle(pMkt(15, 1.95, 0, { meta: "111|0|SPREAD|TEAM1||0" }), g).key, "FT|hc|0|h");
  assert.strictEqual(classifyPinnacle(pMkt(16, 1.95, -0, { meta: "111|0|SPREAD|TEAM2||-0" }), g).key, "FT|hc|0|a"); // −0 → «0»
  assert.strictEqual(classifyPinnacle(pMkt(10, 1.9, 2.5, { specialKind: 1 }), g), null);
});

test("markets: не-футбол — период = сегмент фида; теннисные геймы Pinnacle идут под чужим id и проходят", () => {
  const pt = { textId: "/Pinnacle/Tennis/T/A/B", sportType: 3, compareEventId: 500, startTimeStamp: START };
  const bt = { textId: "/Betano/Tennis/T/A/B", sportType: 3, compareEventId: 0, startTimeStamp: START };
  assert.strictEqual(classifyPinnacle(pMkt(10, 1.9, 22.5, { meta: "999|0|TOTAL_POINTS||OVER|22.5", surebetTextId: "/Main/Main/Game" }), pt).key, "/Main/Main/Game|tot|22.5|o");
  assert.strictEqual(classifyPinnacle(pMkt(0, 1.4, null, { meta: "500|0|MONEYLINE|TEAM1" }), pt).key, "/Main/Main|x|0|h");
  assert.strictEqual(classifyBetano(bMkt(1, 2.8, "Winner | B"), bt).key, "/Main/Main|ml|0|a");
  assert.strictEqual(classifyBetano(bMkt(16, 1.7, "Handicap Games | B -5.5", -5.5, { surebetTextId: "/Main/Main/Game" }), bt).key, "/Main/Main/Game|hc|5.5|a");
  assert.strictEqual(classifyBetano(bMkt(15, 2.0, "Handicap Games | A +5.5", 5.5, { surebetTextId: "/Main/Main/Game" }), bt).key, "/Main/Main/Game|hc|5.5|h");
  // в одном сегменте «… Result» (3 исхода) и «… Winner» (2 исхода) — разные семейства
  const q = { surebetTextId: "/Quarter/Main/1", marketType: 8, marketMeta: "1" };
  assert.strictEqual(classifyBetano(bMkt(0, 2.1, "1st Quarter - Result | A", null, q), bt).key, "/Quarter/Main/1|x|0|h");
  assert.strictEqual(classifyBetano(bMkt(0, 1.8, "1st Quarter - Winner | A", null, q), bt).key, "/Quarter/Main/1|ml|0|h");
  assert.strictEqual(classifyBetano(bMkt(0, 1.8, "First Blood (Map 1) | A", null, { surebetTextId: "/Map/Main/1/FirstBlood" }), bt), null);
  assert.strictEqual(classifyBetano(bMkt(10, 1.9, "3-way Total Runs | Over 9.0", 9.5, { specialKind: 3 }), bt), null);
  assert.strictEqual(classifyBetano(bMkt(17, 1.9, "Extra Innings | Yes"), bt), null);
});

test("markets: flipKey — перевёрнутый порядок команд", () => {
  assert.strictEqual(flipKey("/Main/Main/Overtime|ml|0|h"), "/Main/Main/Overtime|ml|0|a");
  assert.strictEqual(flipKey("/Main/Main/Overtime|hc|-5.5|h"), "/Main/Main/Overtime|hc|5.5|a");
  assert.strictEqual(flipKey("/Main/Main/Overtime|tt1|110.5|o"), "/Main/Main/Overtime|tt2|110.5|o");
  assert.strictEqual(flipKey("/Main/Main/Overtime|tot|220.5|u"), "/Main/Main/Overtime|tot|220.5|u");
  assert.strictEqual(flipKey("FT|dc|0|1x"), "FT|dc|0|x2");
  assert.strictEqual(describeKey("FT|hc|0.5|a", "Alpha", "Beta"), "матч · фора Beta -0.5");
});

// ───────────────────────── вилка ─────────────────────────

test("arb: противоположная цена по таблице 7.1", () => {
  const P = { "FT|x|0|h": 2.0, "FT|x|0|d": 3.6, "FT|x|0|a": 4.0, "FT|hc|0|h": 1.5, "FT|hc|0|a": 2.7, "FT|hc|-0.5|a": 1.85,
    "FT|tot|2.5|o": 1.9, "FT|tot|2.5|u": 2.0, "FT|tt1|1.5|u": 1.7, "1H|x|0|h": 2.6, "1H|x|0|d": 2.2, "1H|x|0|a": 4.5 };
  const getP = (k) => P[k];
  const xh = oppositePrice("FT|x|0|h", getP);                                          // синтетика П2/Х (1.895) лучше форы гостей +0.5 (1.85)
  assert.ok(Math.abs(xh.opp - 1 / (1 / 4.0 + 1 / 3.6)) < 1e-12); assert.strictEqual(xh.via, "П2 или Х");
  assert.ok(Math.abs(oppositePrice("FT|x|0|d", getP).opp - 1 / (1 / 2.0 + 1 / 4.0)) < 1e-12);
  assert.strictEqual(oppositePrice("FT|dnb|0|h", getP).opp, 2.7);
  assert.strictEqual(oppositePrice("FT|dnb|0|a", getP).opp, 1.5);
  assert.strictEqual(oppositePrice("FT|dc|0|1x", getP).opp, 4.0);
  assert.strictEqual(oppositePrice("FT|dc|0|x2", getP).opp, 2.0);
  assert.strictEqual(oppositePrice("FT|dc|0|12", getP).opp, 3.6);
  assert.strictEqual(oppositePrice("FT|tot|2.5|o", getP).opp, 2.0);
  assert.strictEqual(oppositePrice("FT|tt1|1.5|o", getP).opp, 1.7);
  assert.strictEqual(oppositePrice("FT|tot|3.5|o", getP), null);                       // линии нет → нет рынка
  assert.strictEqual(oppositePrice("FT|btts|0|y", getP), null);
  assert.strictEqual(oppositePrice("FT|odd|0|o", getP), null);
  assert.strictEqual(oppositePrice("2H|x|0|h", getP), null);                           // второго тайма в Pinnacle нет
  assert.ok(Math.abs(oppositePrice("1H|x|0|a", getP).opp - 1 / (1 / 2.6 + 1 / 2.2)) < 1e-12);
});

test("arb: победа без ничьей (не-футбол) — только против двухисходного рынка Pinnacle", () => {
  const two = { "/Main/Main|x|0|h": 1.4, "/Main/Main|x|0|a": 3.1 };
  assert.strictEqual(oppositePrice("/Main/Main|ml|0|h", (k) => two[k]).opp, 3.1);
  assert.strictEqual(oppositePrice("/Main/Main|ml|0|a", (k) => two[k]).opp, 1.4);
  const three = { ...two, "/Main/Main|x|0|d": 4.2 };
  assert.strictEqual(oppositePrice("/Main/Main|ml|0|h", (k) => three[k]), null);        // у Pinnacle 3 исхода — рынки разные
  // исход с ничьей у Betano против двухисходного Pinnacle: синтетики нет, годится только фора ∓0.5
  assert.strictEqual(oppositePrice("/Half/Main/1|x|0|h", (k) => ({ "/Half/Main/1|x|0|h": 1.8, "/Half/Main/1|x|0|a": 2.0 })[k]), null);
  assert.strictEqual(oppositePrice("/Half/Main/1|x|0|h", (k) => ({ "/Half/Main/1|hc|-0.5|a": 1.75 })[k]).opp, 1.75);
  assert.strictEqual(oppositePrice("/Main/Main/Game|hc|5.5|h", (k) => ({ "/Main/Main/Game|hc|5.5|a": 1.9 })[k]).opp, 1.9);
});

test("arb: размер вилки и полосы", () => {
  assert.ok(Math.abs(arbOf(2.1, 2.0) - (1 / (1 / 2.1 + 1 / 2.0) - 1)) < 1e-12);
  assert.ok(arbOf(2.1, 2.0) > 0);
  assert.strictEqual(arbOf(2.0, 2.0), 0);
  assert.strictEqual(arbOf(2.0, null), null);
  assert.strictEqual(band(0.011), "вилка"); assert.strictEqual(band(0), "рядом"); assert.strictEqual(band(-0.01), "рядом");
  assert.strictEqual(band(-0.015), "далеко"); assert.strictEqual(band(null), "нет рынка");
});

// ───────────────────────── «тот ли матч» по ценам ─────────────────────────

test("guard: один матч — цены близки → ok; перепутанные матчи — расходятся и сила, и тотал → suspect", () => {
  // Pinnacle: хозяева — фаворит, матч «низовой»
  const P = { "FT|x|0|h": 1.6, "FT|x|0|d": 3.9, "FT|x|0|a": 5.5, "FT|hc|0|h": 1.3, "FT|hc|0|a": 3.3,
    "FT|tot|2.5|o": 2.1, "FT|tot|2.5|u": 1.75, "FT|tot|2.25|o": 1.85, "FT|tot|2.25|u": 2.0 };
  const getP = (k) => P[k];
  const same = [["FT|x|0|h", 1.57], ["FT|x|0|d", 3.7], ["FT|dnb|0|a", 3.2], ["FT|tot|2.5|o", 2.05], ["FT|tot|2.5|u", 1.72], ["FT|tot|2.25|o", 1.8]];
  assert.strictEqual(pairCheck(same, getP).status, "ok");
  // другой матч: гости — фаворит, матч «верховой» → не сходится ни сила, ни тотал
  const other = [["FT|x|0|h", 3.4], ["FT|x|0|d", 3.3], ["FT|dnb|0|a", 1.45], ["FT|tot|2.5|o", 1.6], ["FT|tot|2.5|u", 2.3], ["FT|tot|2.25|o", 1.45]];
  const r = pairCheck(other, getP);
  assert.strictEqual(r.status, "suspect"); assert.ok(r.devS > 0.05 && r.devT > 0.05);
  // настоящая вилка: Betano отстал только по силе команд, тотал сходится → ok (не режем настоящие вилки)
  const lag = [["FT|x|0|h", 1.95], ["FT|x|0|d", 3.4], ["FT|dnb|0|a", 2.6], ["FT|tot|2.5|o", 2.05], ["FT|tot|2.5|u", 1.72], ["FT|tot|2.25|o", 1.8]];
  assert.strictEqual(pairCheck(lag, getP).status, "ok");
});

test("guard: исход с ничьей не сравнивается с двухисходным рынком; мало общих исходов → nodata", () => {
  // хоккей, период: у Betano «Result» (3 исхода), у Pinnacle победа без ничьей — цены несравнимы (2.95 против 2.12)
  const P = { "/Period/Main/1|x|0|h": 1.76, "/Period/Main/1|x|0|a": 2.12 };
  assert.strictEqual(pairCheck([["/Period/Main/1|x|0|h", 2.57], ["/Period/Main/1|x|0|a", 2.95]], (k) => P[k]).status, "nodata");
  // а «победа без ничьей» Betano с тем же рынком Pinnacle сравнивается
  const r = pairCheck([["/Period/Main/1|ml|0|h", 1.72], ["/Period/Main/1|ml|0|a", 2.05]], (k) => P[k]);
  assert.strictEqual(r.nS, 2); assert.strictEqual(r.status, "ok");
  // длинные коэффициенты не участвуют (маржа Betano на аутсайдерах), одна группа — порог выше
  assert.strictEqual(pairCheck([["FT|x|0|d", 8]], () => 16).status, "nodata");
  const one = { "FT|tot|2.5|o": 1.9, "FT|tot|2.5|u": 1.9 };
  assert.strictEqual(pairCheck([["FT|tot|2.5|o", 2.05], ["FT|tot|2.5|u", 1.75]], (k) => one[k]).status, "ok");      // ~8% — в пределах
  assert.strictEqual(pairCheck([["FT|tot|2.5|o", 2.6], ["FT|tot|2.5|u", 1.4]], (k) => one[k]).status, "suspect");   // ~31%
});

// ───────────────────────── правила расчёта ─────────────────────────

test("rules: рынки, которые конторы рассчитывают по-разному, не сравниваются", () => {
  const singles = { sport: 3, t1: "Carlos Alcaraz", t2: "Flavio Cobolli", league: "ATP Finals", pLeague: "ATP Finals - Groups" };
  const doubles = { sport: 3, t1: "Adam Jilly / David Bakonyi", t2: "Keshav Chopra / Andres Martin", league: "Champaign - Doubles", pLeague: "ATP Challenger Champaign - R16" };
  // пары: фора и тотал геймов за матч — нельзя (Pinnacle аннулирует их при тай-брейке вместо решающего сета)
  assert.match(ruleBlock("/Main/Main/Game|tot|21.5|u", doubles), /пары/);
  assert.match(ruleBlock("/Main/Main/Game|hc|-3.5|h", doubles), /пары/);
  assert.strictEqual(ruleBlock("/Main/Main|ml|0|h", doubles), null);            // победа в матче — можно
  assert.strictEqual(ruleBlock("/Set/Main/1|tot|9.5|o", doubles), null);        // первый сет играется полностью — можно
  assert.strictEqual(ruleBlock("/Main/Main/Game|tot|21.5|u", singles), null);   // одиночные — можно
  assert.match(ruleBlock("/Main/Main/Game|tot|21.5|u", { sport: 3, t1: "A", t2: "B", pLeague: "ITF Men Monastir - Qualifiers" }), /квалификация/);
  assert.strictEqual(ruleBlock("/Main/Main/Game|tot|21.5|u", { sport: 3, t1: "A", t2: "B", pLeague: "ITF Men Monastir - QF" }), null);
  // вторая половина (баскетбол, ам. футбол): у Pinnacle с овертаймом
  assert.match(ruleBlock("/Half/Main/2|ml|0|h", { sport: 4 }), /вторая половина/);
  assert.strictEqual(ruleBlock("/Half/Main/1|ml|0|h", { sport: 4 }), null);
  assert.strictEqual(ruleBlock("FT|tot|2.5|o", { sport: 1 }), null);
});

test("engine: исключённый правилами рынок не даёт вилку", async () => {
  const feed = fakeFeed();
  const bg = { textId: "/Betano/Tennis/T/A/B", leagueName: "Champaign - Doubles", team1NameEn: "Adam Jilly / David Bakonyi", team2NameEn: "Keshav Chopra / Andres Martin", sportType: 3, startTimeStamp: START, compareEventId: 0 };
  const pg = { ...bg, textId: "/Pinnacle/Tennis/T/A/B", leagueName: "ATP Challenger Champaign - Doubles", compareEventId: 5 };
  const seg = { surebetTextId: "/Main/Main/Game" };
  feed.data.Betano = { status: 200, data: base([bg], [bMkt(11, 2.2, "Games | Under 21.5", 21.5, { ...seg, gameTextId: bg.textId }), bMkt(0, 2.3, "Winner | Adam Jilly / David Bakonyi", null, { gameTextId: bg.textId })], "B1") };
  feed.data.Pinnacle = { status: 200, data: base([pg], [pMkt(10, 2.1, 21.5, { ...seg, gameTextId: pg.textId, meta: "9|0|T" }), pMkt(11, 1.8, 21.5, { ...seg, gameTextId: pg.textId, meta: "9|0|T" }),
    pMkt(0, 1.7, null, { gameTextId: pg.textId, meta: "5|0|ML" }), pMkt(1, 2.0, null, { gameTextId: pg.textId, meta: "5|0|ML" })], "P1") };
  const eng = new PrematchEngine({ feed, now: () => T0, gridMs: 0 });
  await eng.tick(); await eng.tick();
  const a = eng.scan();
  assert.strictEqual(a.length, 1);                                              // тотал геймов (был бы вилкой 7%) исключён
  assert.strictEqual(a[0].key, "/Main/Main|ml|0|h");                            // победа в матче — осталась
});

// ───────────────────────── вилка → кандидат на простановку ─────────────────────────

const mkArb = (o = {}) => ({ pairId: "b~p", key: "/Main/Main|ml|0|h", price: 2.1, opp: 2.0, via: "победа соперника", arb: arbOf(2.1, 2.0),
  sportType: 3, t1: "Carlos Alcaraz", t2: "Flavio Cobolli", league: "ATP", link: "https://www.betano.cz/en/match-odds/a-b/123456/", what: "…",
  mins: 600, flick: false, selId: "999", identity: "confirmed", pairCheck: "ok", ...o });

test("place: ключ исхода → поля сигнала, которые понимают существующие судьи (теннис, 4 проверенных рынка)", () => {
  assert.deepStrictEqual(legacyOf("/Main/Main|ml|0|a"), { st: "/Main/Main", kind: "ML", param: "", side: "B" });
  assert.deepStrictEqual(legacyOf("/Main/Main/Game|tot|21.5|u"), { st: "/Main/Main/Game", kind: "TOTAL", param: "21.5", side: "B" });
  assert.deepStrictEqual(legacyOf("/Main/Main/Game|hc|5.5|a"), { st: "/Main/Main/Game", kind: "SPREAD", param: "5.5", side: "B" });
  assert.deepStrictEqual(legacyOf("/Main/Main|hc|-1.5|h"), { st: "/Main/Main", kind: "SPREAD", param: "-1.5", side: "A" });
  // победа
  let c = arbToCandidate(mkArb(), 1500, 0.005);
  assert.strictEqual(c.desc, "1"); assert.strictEqual(c.subject, "Carlos Alcaraz"); assert.strictEqual(c.kind, "ML"); assert.strictEqual(c.judged, true);
  assert.strictEqual(c.betanoSelId, "999"); assert.strictEqual(c.arbOpp, 2.0); assert.strictEqual(c.arbMin, 0.005); assert.strictEqual(c.expectedOdds, 2.1);
  assert.deepStrictEqual(verifyPick({ kind: c.kind, side: c.side, param: c.param, st: c.st, expectedOdds: c.expectedOdds, t1: c.t1, t2: c.t2 }, { text: "Carlos Alcaraz 2.10", odds: 2.1, how: "selnid" }), { ok: true });
  assert.strictEqual(verifySlipMarket({ kind: c.kind, st: c.st, sportType: 3 }, "Carlos Alcaraz 2.10 Winner …").ok, true);
  // фора по геймам на второго игрока: ключ «гости −5.5» → «AH2(-5.5)», судья ждёт −5.5 на его стороне
  c = arbToCandidate(mkArb({ key: "/Main/Main/Game|hc|5.5|a", price: 1.7 }), 1500, 0);
  assert.strictEqual(c.desc, "AH2(-5.5)"); assert.strictEqual(c.subject, "Flavio Cobolli"); assert.strictEqual(c.descFull, "AH2(-5.5) Flavio Cobolli - геймы");
  assert.strictEqual(verifyPick({ kind: c.kind, side: c.side, param: c.param, st: c.st, expectedOdds: 1.7, t1: c.t1, t2: c.t2 }, { text: "Flavio Cobolli -5.5 1.70", odds: 1.7 }).ok, true);
  assert.strictEqual(verifyPick({ kind: c.kind, side: c.side, param: c.param, st: c.st, expectedOdds: 1.7, t1: c.t1, t2: c.t2 }, { text: "Carlos Alcaraz +5.5 1.70", odds: 1.7 }).ok, false);
  assert.strictEqual(verifySlipMarket({ kind: c.kind, st: c.st, sportType: 3 }, "Flavio Cobolli -5.5 1.70 Match Handicap (Set)").ok, false); // сет-фора вместо гейм-форы
  // тотал геймов меньше
  c = arbToCandidate(mkArb({ key: "/Main/Main/Game|tot|21.5|u", price: 1.95 }), 1500, 0);
  assert.strictEqual(c.desc, "Under 21.5"); assert.strictEqual(c.descFull, "Under 21.5 - геймы");
  assert.strictEqual(verifyPick({ kind: c.kind, side: c.side, param: c.param, st: c.st, expectedOdds: 1.95 }, { text: "Under 21.5 1.95", odds: 1.95 }).ok, true);
  // фора по сетам на первого
  c = arbToCandidate(mkArb({ key: "/Main/Main|hc|-1.5|h", price: 2.07 }), 1500, 0);
  assert.strictEqual(c.desc, "AH1(-1.5)"); assert.strictEqual(c.descFull, "AH1(-1.5) Carlos Alcaraz - сеты");
});

test("place: футбольные рынки, которых судьи ещё не знают, помечаются judged=false и не ломают выбор", () => {
  const f = (key) => arbToCandidate(mkArb({ key, sportType: 1, t1: "Alpha", t2: "Beta", what: "описание" }), 1500, 0.005);
  assert.strictEqual(f("FT|x|0|h").kind, "ML"); assert.strictEqual(f("FT|x|0|h").judged, true); assert.strictEqual(f("FT|x|0|h").st, "/Main/Main");
  assert.strictEqual(f("FT|x|0|d").kind, "X"); assert.strictEqual(f("FT|x|0|d").judged, false);
  assert.strictEqual(f("FT|dnb|0|a").kind, "DNB"); assert.strictEqual(f("1H|dc|0|1x").kind, "DC"); assert.strictEqual(f("1H|dc|0|1x").st, "/Time/Main/1");
  assert.strictEqual(f("FT|tt2|1.5|u").kind, "TT"); assert.strictEqual(f("FT|tt2|1.5|u").side, "2U");
  assert.strictEqual(f("FT|tot|2.5|o").desc, "Over 2.5"); assert.strictEqual(f("FT|tot|2.5|o").descFull, "Over 2.5"); // без «геймы/сеты» вне тенниса
  assert.strictEqual(f("FT|dnb|0|a").desc, "описание");
  // незнакомый судье рынок: текстовый судья пропускает (skip), а не блокирует
  assert.strictEqual(verifyPick({ kind: "DNB", side: "B", expectedOdds: 2.1 }, { text: "Beta 2.10", odds: 2.1 }).skip, true);
});

test("place: выбор вилки — порог, виды спорта, сверка матча, уже пробованные, лимит на матч", () => {
  const a1 = mkArb({ arb: 0.02 }), a2 = mkArb({ key: "/Main/Main/Game|tot|21.5|u", arb: 0.01 }), a3 = mkArb({ pairId: "x~y", arb: 0.03, identity: "mismatch" });
  assert.strictEqual(choosePrematch([a1, a2, a3], { minArb: 0.005 }).arb, a1);                        // «не тот матч» не берём, хоть вилка и больше
  assert.strictEqual(choosePrematch([a1, a2], { minArb: 0.015 }).arb, a1);
  assert.match(choosePrematch([a2], { minArb: 0.015 }).skip, /меньше порога/);
  assert.strictEqual(choosePrematch([a1, a2], { minArb: 0 }, { tried: new Set(["b~p|/Main/Main|ml|0|h"]) }).arb, a2);
  assert.match(choosePrematch([a1, a2], { minArb: 0, maxPerPair: 1 }, { perPair: new Map([["b~p", 1]]) }).skip, /лимит попыток на матч/);
  assert.match(choosePrematch([a1], { minArb: 0, sports: [1] }).skip, /вид спорта/);
  assert.match(choosePrematch([mkArb({ identity: "unknown" })], { minArb: 0, onlyConfirmed: true }).skip, /не подтверждён/);
  assert.match(choosePrematch([mkArb({ selId: "" })], { minArb: 0 }).skip, /id кнопки/);
  assert.match(choosePrematch([mkArb({ mins: 5 })], { minArb: 0, minToStartMin: 15 }).skip, /до старта/);
  assert.match(choosePrematch([mkArb({ price: 6 })], { minArb: 0, oddsMax: 5 }).skip, /цена выше/);
  assert.strictEqual(choosePrematch([], {}).skip, "вилок нет");
  // вилка при цене страницы: кнопка просела с 2.10 до 1.95 → вилки уже нет
  assert.ok(arbAtPrice(2.1, 2.0) > 0); assert.ok(arbAtPrice(1.95, 2.0) < 0);
});

test("place: галочки панели — исходы, отрезок матча, потолок вилки", () => {
  assert.strictEqual(outcomeGroup("FT|x|0|h"), "win"); assert.strictEqual(outcomeGroup("/Main/Main|ml|0|a"), "win");
  assert.strictEqual(outcomeGroup("1H|x|0|d"), "draw"); assert.strictEqual(outcomeGroup("FT|tt2|1.5|o"), "tt");
  assert.strictEqual(outcomeGroup("FT|dnb|0|h"), "dnb"); assert.strictEqual(outcomeGroup("/Main/Main/Game|hc|3.5|a"), "hc");
  for (const k of ["FT|tot|2.5|o", "/Main/Main|ml|0|h", "/Main/Main/Game|tot|21.5|u", "/Main/Main/Overtime|hc|-5.5|h"]) assert.strictEqual(isFullMatch(k), true);
  for (const k of ["1H|x|0|h", "/Set/Main/1|tot|9.5|o", "/Half/Main/1|ml|0|h", "/Quarter/Main/1|tot|50.5|u", "/Map/Main/1|ml|0|a"]) assert.strictEqual(isFullMatch(k), false);
  const win = mkArb({ arb: 0.02 }), tot = mkArb({ key: "/Main/Main/Game|tot|21.5|u", arb: 0.03 }), set1 = mkArb({ key: "/Set/Main/1|tot|9.5|o", arb: 0.04 });
  assert.strictEqual(choosePrematch([win, tot, set1], { minArb: 0 }).arb, set1);                       // без ограничений — самая большая
  assert.strictEqual(choosePrematch([win, tot, set1], { minArb: 0, parts: false }).arb, tot);          // части матча выключены
  assert.strictEqual(choosePrematch([win, tot, set1], { minArb: 0, outcomes: ["win"] }).arb, win);     // только победа
  assert.strictEqual(choosePrematch([win, tot, set1], { minArb: 0, full: false }).arb, set1);          // только части
  assert.strictEqual(choosePrematch([win, tot, set1], { minArb: 0, maxArb: 0.035 }).arb, tot);         // потолок вилки
  assert.match(choosePrematch([win], { minArb: 0, outcomes: ["tot"] }).skip, /исход выключен/);
  assert.match(choosePrematch([set1], { minArb: 0, parts: false }).skip, /отрезок выключен/);
  assert.match(choosePrematch([set1], { minArb: 0, maxArb: 0.01 }).skip, /больше потолка/);
  assert.strictEqual(choosePrematch([win], { minArb: 0, outcomes: [], sports: [] }).arb, win);          // пустые списки = всё включено
});

// ───────────────────────── сверка матча по номеру Sportradar ─────────────────────────

const srCard = (o = {}) => ({ home: "Alpha", away: "Beta", country: "Spain", tournament: "LaLiga", start: START, score: null, periods: null, ...o });
const pinG = (o = {}) => ({ textId: "p", sportType: 1, startTimeStamp: START, leagueName: "Spain - La Liga", team1NameEn: "Alpha", team2NameEn: "Beta", ...o });

test("sportradar: разбор ответа справочника и страна из лиги Pinnacle", () => {
  const json = { doc: [{ data: { realcategory: { name: "France" }, tournament: { name: "Ligue 1" },
    match: { _dt: { uts: START }, teams: { home: { name: "Nice" }, away: { name: "PSG" } }, result: { home: 2, away: 3 }, periods: { p1: { home: 1, away: 2 } } } } }] };
  assert.deepStrictEqual(parseMatchInfo(json), { home: "Nice", away: "PSG", country: "France", tournament: "Ligue 1", start: START, score: [2, 3], periods: { p1: { home: 1, away: 2 } } });
  assert.strictEqual(parseMatchInfo({ doc: [{ event: "exception", data: { message: "Unauthorized feed" } }] }), null);
  assert.strictEqual(pinnacleCountry("Spain - Segunda Federacion"), "spain");
  assert.strictEqual(pinnacleCountry("NBA"), null);
});

test("sportradar: сверка — подтверждён по названиям; по стране и времени при разном написании; не тот матч", () => {
  assert.strictEqual(identityCheck(srCard(), pinG(), 1).status, "confirmed");
  // «Aalborg» и «AaB»: названия не сходятся, но страна, время и вторая команда совпали
  const dk = identityCheck(srCard({ home: "Kolding IF", away: "Aalborg", country: "Denmark" }), pinG({ leagueName: "Denmark - 1st Division", team1NameEn: "Kolding", team2NameEn: "AaB" }), 1);
  assert.strictEqual(dk.status, "confirmed"); assert.match(dk.why, /страна и время/);
  // время расходится → не тот матч (у Sportradar время точное: совпало с Pinnacle во всех замеренных случаях)
  assert.strictEqual(identityCheck(srCard({ home: "Kolding IF", away: "Aalborg", country: "Denmark", start: START + 3600 }), pinG({ leagueName: "Denmark - 1st Division", team1NameEn: "Kolding", team2NameEn: "AaB" }), 1).status, "mismatch");
  // страна другая и названия не сходятся → не тот матч
  assert.strictEqual(identityCheck(srCard({ home: "Racing", away: "Union", country: "Argentina" }), pinG({ leagueName: "Uruguay - Primera", team1NameEn: "Racing Club", team2NameEn: "Liverpool" }), 1).status, "mismatch");
  // страны у Pinnacle нет, названия разные → вывода нет
  assert.strictEqual(identityCheck(srCard({ home: "Aarhus", away: "Lyngby" }), pinG({ leagueName: "Cup", team1NameEn: "AGF", team2NameEn: "Boldklub" }), 1).status, "unknown");
  // страна и время совпали, но ни одно название не сошлось → вывода нет (не подтверждаем наугад)
  assert.strictEqual(identityCheck(srCard({ home: "Aarhus", away: "Gladsaxe", country: "Denmark" }), pinG({ leagueName: "Denmark - Cup", team1NameEn: "AGF", team2NameEn: "Akademisk Boldklub" }), 1).status, "unknown");
  assert.strictEqual(identityCheck(null, pinG(), 1).status, "unknown");
  // не-футбол: порядок команд перевёрнут — это не расхождение
  assert.strictEqual(identityCheck(srCard({ home: "Zemun", away: "Borac", country: "Serbia" }), pinG({ sportType: 4, leagueName: "Serbia - KLS", team1NameEn: "Borac", team2NameEn: "Zemun" }), 4).status, "confirmed");
});

test("sportradar: кэш — один запрос на матч, неудача не кэшируется", async () => {
  let calls = 0, fail = true;
  const dir = makeDirectory({ fetch: async () => { calls++; return fail ? null : srCard(); } });
  assert.strictEqual(await dir.get("1"), null);
  fail = false;
  assert.strictEqual((await dir.get("1")).home, "Alpha");
  await dir.get("1"); await dir.get("1");
  assert.strictEqual(calls, 2);
});

test("engine: пара с вилкой сверяется по номеру Sportradar один раз; итог — в записи журнала", async () => {
  const feed = fakeFeed(); const events = []; let asked = 0;
  feed.data.Betano = { status: 200, data: base([bGame({ extId: "777" })], [bMkt(10, 2.1, "Over/Under Total Goals | Over 2.5", 2.5)], "B1") };
  feed.data.Pinnacle = { status: 200, data: base([pGame({ leagueName: "Spain - La Liga" })], [pMkt(10, 1.9, 2.5), pMkt(11, 2.0, 2.5)], "P1") };
  const directory = { get: async (id) => { asked++; assert.strictEqual(id, "777"); return srCard({ start: START + 7200 }); } };
  const eng = new PrematchEngine({ feed, now: () => T0, gridMs: 0, directory, onArb: (r, kind) => events.push(kind + ":" + (r.identity || "-")) });
  await eng.tick(); await eng.tick(); await eng.tick(); await eng.tick();
  const rec = [...eng.arbs.values()][0];
  assert.strictEqual(asked, 1);                                       // один запрос на матч
  assert.strictEqual(rec.identity, "mismatch"); assert.match(rec.identityWhy, /время старта расходится на 120 мин/);
  assert.deepStrictEqual(events, ["new:-", "identity:mismatch"]);
  assert.strictEqual(eng.scan()[0].identity, "mismatch");
  // у игры Betano нет номера → так и помечаем, справочник не трогаем
  const feed2 = fakeFeed();
  feed2.data.Betano = { status: 200, data: base([bGame({ extId: "0" })], [bMkt(10, 2.1, "Over/Under Total Goals | Over 2.5", 2.5)], "B1") };
  feed2.data.Pinnacle = feed.data.Pinnacle;
  const eng2 = new PrematchEngine({ feed: feed2, now: () => T0, gridMs: 0, directory: { get: async () => { throw new Error("не должен вызываться"); } } });
  await eng2.tick(); await eng2.tick();
  assert.strictEqual([...eng2.arbs.values()][0].identity, "noid");
});

// ───────────────────────── состояние и мигание ─────────────────────────

test("state: счёт «возвратов» цены и фильтр мигающего матча (изменений ≥ 40, возвратов > 45%)", () => {
  const st = new BookState("Betano", { now: () => T0 });
  const g = bGame(), m = bMkt(0, 2.0, "Match Result | Alpha");
  st.reload(base([g], [m]));
  for (let i = 0; i < 40; i++) st.updateMarket(m.textId, i % 2 ? 2.0 : 2.1, g.textId, T0 + i); // 2.1, 2.0, 2.1, …
  const s = st.gs.get(g.textId);
  assert.strictEqual(s.changes, 40); assert.strictEqual(s.returns, 39);
  assert.strictEqual(st.flicker(g.textId), true);
  assert.strictEqual(st.lastPrice(g.textId, "FT|x|0|h"), 2.0);
  assert.strictEqual(st.selId(g.textId, "FT|x|0|h"), String(m.eventId).split("|")[0]);
});

test("state: снимок из чужой сессии не применяется (нужна полная перезагрузка); рынок без игры пропускается", () => {
  const st = new BookState("Betano", { now: () => T0 });
  const g = bGame(), m = bMkt(0, 2.0, "Match Result | Alpha");
  st.reload(base([g], [m], "S1"));
  assert.strictEqual(st.applySnapshot({ sessionGuid: "S2", writeTime: new Date(T0 + 1000).toISOString(), marketsUpdated: [{ textId: m.textId, value: 3, gameTextId: g.textId }] }), false);
  assert.strictEqual(st.price(g.textId, "FT|x|0|h"), 2.0);
  const orphan = bMkt(0, 2.0, "Match Result | X", null, { gameTextId: "/Betano/Football/L/No/Game" });
  assert.strictEqual(st.applySnapshot({ sessionGuid: "S1", writeTime: new Date(T0 + 2000).toISOString(), marketsAdded: [{ textId: orphan.textId, gameTextId: orphan.gameTextId, marketModel: orphan }] }), true);
  assert.strictEqual(st.gs.has(orphan.gameTextId), false);
  // фильтр видов спорта: чужой спорт не берём вовсе
  const only = new BookState("Betano", { now: () => T0, acceptGame: (x) => x.sportType === 1 });
  only.reload(base([bGame({ textId: "/Betano/Darts/L/A/B", sportType: 13 })], []));
  assert.strictEqual(only.games.size, 0);
});

// ───────────────────────── движок целиком (подставной фид) ─────────────────────────

function fakeFeed() {
  const f = { data: {}, queue: { Betano: [], Pinnacle: [] }, calls: { data: 0, snaps: 0 },
    getData: async (book) => { f.calls.data++; return f.data[book]; },
    getSnapshots: async (book) => { f.calls.snaps++; return f.queue[book].shift() || { status: 204, data: null }; } };
  return f;
}
const pBase = (guid = "P1") => base([pGame()], [pMkt(0, 2.0), pMkt(2, 3.6), pMkt(1, 4.0), pMkt(10, 1.9, 2.5), pMkt(11, 2.0, 2.5)], guid);

test("engine: вилка попадает в журнал один раз, повторы считаются, цена закрытия берётся на старте", async () => {
  const feed = fakeFeed(); let now = T0; const events = [];
  const tot = bMkt(10, 2.1, "Over/Under Total Goals | Over 2.5", 2.5), win = bMkt(1, 3.2, "Match Result | Beta");
  feed.data.Betano = { status: 200, data: base([bGame()], [tot, win], "B1") };
  feed.data.Pinnacle = { status: 200, data: pBase() };
  const eng = new PrematchEngine({ feed, now: () => now, gridMs: 0, onArb: (r, kind) => events.push(kind + ":" + r.key) });
  await eng.tick(); await eng.tick();                                 // загрузка Betano, затем Pinnacle + оценка
  assert.strictEqual(eng.matcher.pairs.size, 1);
  assert.deepStrictEqual(events, ["new:FT|tot|2.5|o"]);               // 2.1 против «меньше 2.5» за 2.0 → вилка
  const rec = [...eng.arbs.values()][0];
  assert.ok(Math.abs(rec.arb - arbOf(2.1, 2.0)) < 1e-12);
  assert.strictEqual(rec.band, "вилка"); assert.strictEqual(rec.repeats, 1); assert.strictEqual(rec.minsToStart, 60);
  assert.strictEqual(rec.selId, String(tot.eventId).split("|")[0]); assert.strictEqual(rec.ev, null);
  assert.strictEqual(rec.pairCheck, "nodata");                        // общий исход в средних ценах один — сравнить не с чем
  assert.strictEqual(eng.scan()[0].pairCheck, "nodata");
  assert.strictEqual(eng.scan().length, 1);
  // Betano поднял цену → та же запись: повтор и новый максимум, новой записи нет
  now += 120000;
  feed.queue.Betano.push({ status: 200, data: { snapshots: [{ sessionGuid: "B1", writeTime: new Date(now).toISOString(), marketsUpdated: [{ textId: tot.textId, value: 2.2, gameTextId: tot.gameTextId }] }] } });
  await eng.tick();
  assert.strictEqual(eng.arbs.size, 1); assert.strictEqual(rec.repeats, 2); assert.strictEqual(rec.price, 2.1);
  assert.ok(Math.abs(rec.maxArb - arbOf(2.2, 2.0)) < 1e-12);
  // Betano срезал цену → вилки больше нет
  now += 120000;
  feed.queue.Pinnacle.push({ status: 204 });
  feed.queue.Betano.push({ status: 200, data: { snapshots: [{ sessionGuid: "B1", writeTime: new Date(now).toISOString(), marketsUpdated: [{ textId: tot.textId, value: 1.85, gameTextId: tot.gameTextId }] }] } });
  await eng.tick(); await eng.tick();
  assert.strictEqual(eng.scan().length, 0);
  // идём к старту шагами по 4 минуты (без пропусков записи) → цена закрытия
  while (now < START * 1000) { now += 240000; await eng.tick(); await eng.tick(); }
  assert.strictEqual(rec.kC, 1.85); assert.ok(Math.abs(rec.drop - (1.85 / 2.1 - 1)) < 1e-12);
  assert.ok(rec.arbC < 0); assert.strictEqual(rec.noClose, false);
  assert.deepStrictEqual(events, ["new:FT|tot|2.5|o", "close:FT|tot|2.5|o"]);
});

test("engine: пропуск записи дольше 10 минут — матч, стартовавший внутри него, остаётся без цены закрытия", async () => {
  const feed = fakeFeed(); let now = T0;
  feed.data.Betano = { status: 200, data: base([bGame()], [bMkt(10, 2.1, "Over/Under Total Goals | Over 2.5", 2.5)], "B1") };
  feed.data.Pinnacle = { status: 200, data: pBase() };
  const eng = new PrematchEngine({ feed, now: () => now, gridMs: 0 });
  await eng.tick(); await eng.tick();
  const rec = [...eng.arbs.values()][0];
  now = START * 1000 + 60000;                                         // клиент «проспал» час — старт пришёлся на пропуск
  await eng.tick(); await eng.tick();
  assert.strictEqual(eng.gaps.Betano.length, 1);
  assert.strictEqual(rec.noClose, true); assert.strictEqual(rec.kC, null);
});

test("engine: меньше 15 минут до старта — вилка видна в scan(), но в журнал не пишется", async () => {
  const feed = fakeFeed(); const now = START * 1000 - 10 * 60000;
  feed.data.Betano = { status: 200, data: base([bGame()], [bMkt(10, 2.1, "Over/Under Total Goals | Over 2.5", 2.5)], "B1", new Date(now).toISOString()) };
  feed.data.Pinnacle = { status: 200, data: pBase() };
  const eng = new PrematchEngine({ feed, now: () => now, gridMs: 0 });
  await eng.tick(); await eng.tick();
  assert.strictEqual(eng.scan().length, 1); assert.strictEqual(eng.arbs.size, 0);
});

test("engine: SessionId mismatch → полная перезагрузка; 401 → остановка с понятной ошибкой", async () => {
  const feed = fakeFeed(); const logs = [];
  feed.data.Betano = { status: 200, data: base([bGame()], [bMkt(1, 3.2, "Match Result | Beta")], "B1") };
  feed.data.Pinnacle = { status: 200, data: pBase() };
  const eng = new PrematchEngine({ feed, now: () => T0, gridMs: 0, onLog: (l, m) => logs.push(m) });
  await eng.tick(); await eng.tick();
  assert.strictEqual(feed.calls.data, 2);
  feed.queue.Betano.push({ status: 400, error: "SessionId mismatch" });
  await eng.tick();                                                   // Betano: mismatch
  assert.strictEqual(eng.books.Betano.sessionGuid, null);
  feed.data.Betano = { status: 200, data: base([bGame()], [bMkt(1, 3.2, "Match Result | Beta")], "B2") };
  await eng.tick(); await eng.tick();                                 // Pinnacle (204), затем Betano — перезагрузка
  assert.strictEqual(feed.calls.data, 3); assert.strictEqual(eng.books.Betano.sessionGuid, "B2");
  assert.ok(logs.some((m) => /реально изменилось цен 0/.test(m)));
  feed.queue.Pinnacle.push({ status: 401, error: "API key has expired" });
  await assert.rejects(() => eng.tick(), (e) => e.code === "KEY_EXPIRED");
});

test("engine: перевёрнутая пара (не-футбол) — цены Pinnacle читаются в порядке команд Betano", async () => {
  const feed = fakeFeed();
  const bg = { textId: "/Betano/Basketball/NBA/A/B", leagueName: "NBA", team1NameEn: "Milwaukee Bucks", team2NameEn: "Portland Trail Blazers", sportType: 4, startTimeStamp: START, compareEventId: 0 };
  const pg = { textId: "/Pinnacle/Basketball/NBA/B/A", leagueName: "NBA", team1NameEn: "Portland Trail Blazers", team2NameEn: "Milwaukee Bucks", sportType: 4, startTimeStamp: START, compareEventId: 9 };
  const seg = { surebetTextId: "/Main/Main/Overtime" };
  // Betano: победа Bucks (хозяева у Betano) за 2.30. Pinnacle: Blazers (хозяева у Pinnacle) 1.80, Bucks 2.05.
  feed.data.Betano = { status: 200, data: base([bg], [bMkt(0, 2.3, "Winner | Milwaukee Bucks", null, { ...seg, gameTextId: bg.textId })], "B1") };
  feed.data.Pinnacle = { status: 200, data: base([pg], [pMkt(0, 1.8, null, { ...seg, gameTextId: pg.textId, meta: "9|0|ML" }), pMkt(1, 2.05, null, { ...seg, gameTextId: pg.textId, meta: "9|0|ML" })], "P1") };
  const eng = new PrematchEngine({ feed, now: () => T0, gridMs: 0 });
  await eng.tick(); await eng.tick();
  const pair = [...eng.matcher.pairs.values()][0];
  assert.strictEqual(pair.flip, true);
  const a = eng.scan();
  assert.strictEqual(a.length, 1); assert.strictEqual(a[0].opp, 1.8);  // противоположная ставка — победа Blazers
  assert.strictEqual(a[0].what, "/Main/Main/Overtime · победа Milwaukee Bucks");
});
