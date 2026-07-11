"use strict";
// Тесты чистой логики live-value bettingco: матч событий по именам, парс исходов Betano/Pinnacle,
// de-vig и расчёт value с отсечкой артефактов. Форма данных — как в реальном фиде (проверено вживую).
const test = require("node:test");
const assert = require("node:assert");
const bc = require("../lib/bettingco.cjs");

const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

test("matchEvents: матч по именам без учёта порядка/регистра/акцентов", () => {
  const B = { g1: { team1NameEn: "Alex de Minaur", team2NameEn: "Adrian Mannarino", textId: "/B/1" } };
  const P = { g9: { team1NameEn: "Adrian Mannarino", team2NameEn: "Alex De Minaur", textId: "/P/9" } };
  const m = bc.matchEvents(B, P);
  assert.equal(m.length, 1);
  assert.equal(m[0].b.textId, "/B/1");
  assert.equal(m[0].p.textId, "/P/9");
});

test("teamKey/matchEvents: разные написания одной команды склеиваются (реальный кейс Dota)", () => {
  // Dota Esports World Cup был в ОБОИХ плечах фида, но пересечение 0: «Team Yandex»≠«Yandex» по точным именам
  assert.equal(bc.teamKey("Team Yandex"), bc.teamKey("Yandex"));
  assert.equal(bc.teamKey("LGD Gaming"), bc.teamKey("LGD"));
  assert.equal(bc.teamKey("Virtus.Pro"), bc.teamKey("Virtus.pro"));
  assert.equal(bc.teamKey("Sporting CP (Kray) (Esports)"), bc.teamKey("Sporting CP")); // скобочные ники — вон
  assert.notEqual(bc.teamKey("Team Spirit"), bc.teamKey("Team Falcons"));              // разные команды не слипаются
  assert.equal(bc.teamKey("Team"), bc.norm("Team")); // всё съела чистка → откат к полному norm (не пустой ключ)
  const B = { g1: { team1NameEn: "Team Yandex", team2NameEn: "Team OG", textId: "/B/1" } };
  const P = { g9: { team1NameEn: "Yandex", team2NameEn: "OG", textId: "/P/9" } };
  const m = bc.matchEvents(B, P);
  assert.equal(m.length, 1); // матч склеился, value теперь считается
  // flip: порядок команд совпал → false (teamKey, а не сырой norm — иначе «Team Yandex»≠«Yandex» давал бы ложный flip)
  assert.equal(bc.eventSync(B.g1, P.g9).flip, false);
});

test("teamKey: мировой бейсбол — US-алиасы городов, латам-предлоги/порядок слов, KBO-бренды целы", () => {
  // США: аббревиатуры городов
  assert.equal(bc.teamKey("LA Angels"), bc.teamKey("Los Angeles Angels"));
  assert.equal(bc.teamKey("NY Yankees"), bc.teamKey("New York Yankees"));
  assert.equal(bc.teamKey("St. Louis Cardinals"), bc.teamKey("Saint Louis Cardinals"));
  assert.notEqual(bc.teamKey("Red Sox"), bc.teamKey("White Sox")); // ники не слипаются
  // Латам: предлоги + порядок слов
  assert.equal(bc.teamKey("Diablos Rojos del México"), bc.teamKey("Mexico Diablos Rojos"));
  assert.equal(bc.teamKey("Tigres del Licey"), bc.teamKey("Licey Tigres"));
  // KBO: бренд-буквы различают команды — не режем
  assert.notEqual(bc.teamKey("LG Twins"), bc.teamKey("KT Twins"));
  // NPB: спонсорская вставка DeNA + слитное/раздельное написание (реальная потеря 14-16 снимков/сутки)
  assert.equal(bc.teamKey("Yokohama DeNA Baystars"), bc.teamKey("Yokohama Bay Stars"));
});

test("matchEvents: SUBSET-фолбэк (NPB-префикс региона) — склейка ЕДИНСТВЕННОГО кандидата, отказ при двух", () => {
  // Fukuoka SoftBank Hawks ↔ SoftBank Hawks: точный ключ не совпал, но токены ⊆ → склейка (кандидат один)
  const B = {
    g1: { team1NameEn: "Fukuoka SoftBank Hawks", team2NameEn: "Hokkaido Nippon-Ham Fighters", textId: "/B/1" },
  };
  const P = {
    g9: { team1NameEn: "SoftBank Hawks", team2NameEn: "Nippon-Ham Fighters", textId: "/P/9" },
  };
  const m = bc.matchEvents(B, P);
  assert.equal(m.length, 1);
  assert.equal(m[0].p.textId, "/P/9");
  assert.equal(bc.eventSync(B.g1, P.g9).flip, false); // sameTeam subset-осведомлён → flip не врёт
  // ДВА кандидата «Giants» → отказ (не гадаем, какой матч склеивать)
  const B2 = { g1: { team1NameEn: "Giants", team2NameEn: "Tigers", textId: "/B/1" } };
  const P2 = {
    g8: { team1NameEn: "Yomiuri Giants", team2NameEn: "Hanshin Tigers", textId: "/P/8" },
    g9: { team1NameEn: "Lotte Giants", team2NameEn: "Kia Tigers", textId: "/P/9" },
  };
  assert.equal(bc.matchEvents(B2, P2).length, 0);
});

test("betanoOutcomes: ЕВРОПЕЙСКИЙ хендикап (3-way с ничьёй) помечается draw → value не считается", () => {
  // реальный кейс 08-07: сигнал AH1(+1.5) Pinnacle ↔ Betano «Handicap Match Result» (+2 с ничьёй) — разные
  // рынки, de-vig 2-way дал ложный value, спас текстовый судья. Теперь режем в фиде.
  const mk = [
    { surebetTextId: "/Main/Main", meta: "Handicap Match Result | FC Kairat -2", marketValue: 1.85, marketParameter: -2 },
    { surebetTextId: "/Main/Main", meta: "Handicap Match Result | Draw -2", marketValue: 3.6, marketParameter: -2 },
    { surebetTextId: "/Main/Main", meta: "Handicap Match Result | FK Sutjeska 2", marketValue: 4.2, marketParameter: 2 },
  ];
  const out = bc.betanoOutcomes(mk, "FC Kairat", "FK Sutjeska");
  const keys = Object.keys(out).filter((k) => k.includes("SPREAD"));
  assert.ok(keys.length, "SPREAD-ключи должны существовать");
  for (const k of keys) assert.equal(out[k].draw, true, "ключ " + k + " должен быть помечен draw");
  // и valueForEvent (сырые массивы обеих БК) такие рынки пропускает (draw хотя бы в одной БК)
  const pinnRaw = [
    { surebetTextId: "/Main/Main", meta: "9|0|SPREAD|TEAM1||-2|3", marketValue: 1.9, marketParameter: -2 },
    { surebetTextId: "/Main/Main", meta: "9|0|SPREAD|TEAM2||2|3", marketValue: 1.9, marketParameter: 2 },
  ];
  const sigs = bc.valueForEvent(mk, pinnRaw, "FC Kairat", "FK Sutjeska", { threshold: 0.001 });
  assert.equal(sigs.filter((s) => s.kind === "SPREAD").length, 0);
});

test("devig2: снимает маржу, сумма вероятностей 1", () => {
  const [a, b] = bc.devig2(1.5, 2.5);
  assert.ok(near(a + b, 1));
  assert.ok(a > b); // фаворит вероятнее
  assert.ok(near(a, (1 / 1.5) / (1 / 1.5 + 1 / 2.5)));
});

test("pinnacleOutcomes: парс структурной meta (ML/TOTAL/SPREAD), только полный матч", () => {
  const mk = [
    { surebetTextId: "/Main/Main", meta: "111|0|MONEYLINE|TEAM1||0|3", marketValue: 1.017, marketParameter: 0 },
    { surebetTextId: "/Main/Main", meta: "111|0|MONEYLINE|TEAM2||0|3", marketValue: 25.36, marketParameter: 0 },
    { surebetTextId: "/Main/Main/Game", meta: "111|0|TOTAL_POINTS||OVER|27.5|3", marketValue: 1.72, marketParameter: 27.5 },
    { surebetTextId: "/Main/Main/Game", meta: "111|0|TOTAL_POINTS||UNDER|27.5|3", marketValue: 2.02, marketParameter: 27.5 },
    { surebetTextId: "/Set/Game/3|5", meta: "111|36|MONEYLINE|TEAM1||0|3", marketValue: 2.82, marketParameter: 0 }, // подсегмент — игнор
  ];
  const o = bc.pinnacleOutcomes(mk);
  assert.deepEqual(o["/Main/Main|ML|"], { A: 1.017, B: 25.36 });
  assert.deepEqual(o["/Main/Main/Game|TOTAL|27.5"], { A: 1.72, B: 2.02 });
  assert.ok(!Object.keys(o).some((k) => k.includes("/Set/"))); // in-play подсегмент отсеян
});

test("betanoOutcomes: парс человекочитаемой meta + отсев персональных тоталов", () => {
  const mk = [
    { surebetTextId: "/Main/Main", meta: "Winner | Alex de Minaur", marketValue: 1.02 },
    { surebetTextId: "/Main/Main", meta: "Winner | Adrian Mannarino", marketValue: 12.5 },
    { surebetTextId: "/Main/Main/Game", meta: "Games | Over 27.5", marketValue: 1.72, marketParameter: 27.5 },
    { surebetTextId: "/Main/Main/Game", meta: "Games | Under 27.5", marketValue: 2.02, marketParameter: 27.5 },
    { surebetTextId: "/Main/Main/Game", meta: "Alex de Minaur Games Won | Over 20.5", marketValue: 2.95, marketParameter: 20.5 }, // персональный — отсечь
  ];
  const o = bc.betanoOutcomes(mk, "Alex de Minaur", "Adrian Mannarino");
  assert.deepEqual(o["/Main/Main|ML|"], { A: 1.02, B: 12.5 });
  assert.deepEqual(o["/Main/Main/Game|TOTAL|27.5"], { A: 1.72, B: 2.02 });
  // персональный тотал с именем игрока НЕ должен создать /Main/Main/Game|TOTAL|20.5
  assert.ok(!o["/Main/Main/Game|TOTAL|20.5"]);
});

test("valueForEvent: манилайн де Минаура → отрицательный value (маржа Betano), в сигналы не идёт", () => {
  const B = [
    { surebetTextId: "/Main/Main", meta: "Winner | Alex de Minaur", marketValue: 1.02 },
    { surebetTextId: "/Main/Main", meta: "Winner | Adrian Mannarino", marketValue: 12.5 },
  ];
  const P = [
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM1||0|3", marketValue: 1.017, marketParameter: 0 },
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM2||0|3", marketValue: 25.36, marketParameter: 0 },
  ];
  const all = bc.valueForEvent(B, P, "Alex de Minaur", "Adrian Mannarino", { threshold: -1, maxPlausible: 99 });
  const ml = all.find((s) => s.kind === "ML" && s.side === "A");
  assert.ok(ml.value < 0 && ml.value > -0.05, "де Минаур ~ −1.9% (Betano чуть хуже fair)");
  // при боевом пороге сигналов нет
  assert.equal(bc.valueForEvent(B, P, "Alex de Minaur", "Adrian Mannarino", { threshold: 0.02 }).length, 0);
});

test("valueForEvent: реальный value проходит, артефакт (>maxPlausible) режется", () => {
  const B = [
    { surebetTextId: "/Main/Main", meta: "Winner | A", marketValue: 2.20 },
    { surebetTextId: "/Main/Main", meta: "Winner | B", marketValue: 1.75 },
  ];
  const P = [ // Pinnacle fair A ≈ 0.5 → Betano 2.20 даёт +10% (реальный value)
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM1||0|3", marketValue: 2.0, marketParameter: 0 },
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM2||0|3", marketValue: 2.0, marketParameter: 0 },
  ];
  const sigs = bc.valueForEvent(B, P, "A", "B", { threshold: 0.02, maxPlausible: 0.25 });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].side, "A");
  assert.ok(near(sigs[0].value, 0.10, 2e-2));
  // тот же расчёт, но артефактный кэф Betano 5.0 (мисматч) → value ~ +150% режется maxPlausible
  const B2 = [{ surebetTextId: "/Main/Main", meta: "Winner | A", marketValue: 5.0 }, { surebetTextId: "/Main/Main", meta: "Winner | B", marketValue: 1.75 }];
  assert.equal(bc.valueForEvent(B2, P, "A", "B", { threshold: 0.02, maxPlausible: 0.25 }).length, 0);
});

test("3-way (1X2 с ничьёй): ML отсеивается — de-vig 2-way завышает fair для 3 исходов", () => {
  // Pinnacle: MONEYLINE с 3-м слотом (ничья, слот ≠ TEAM1/TEAM2) → ML-ключ помечен draw
  const P = [
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM1||0|3", marketValue: 2.0, marketParameter: 0 },
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|DRAW||0|3", marketValue: 3.4, marketParameter: 0 },
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM2||0|3", marketValue: 4.0, marketParameter: 0 },
  ];
  assert.equal(bc.pinnacleOutcomes(P)["/Main/Main|ML|"].draw, true);
  // Betano: «Winner | Draw» (3-й исход) → тоже помечает draw
  const B = [
    { surebetTextId: "/Main/Main", meta: "Winner | A", marketValue: 2.2 },
    { surebetTextId: "/Main/Main", meta: "Winner | Draw", marketValue: 3.3 },
    { surebetTextId: "/Main/Main", meta: "Winner | B", marketValue: 3.9 },
  ];
  assert.equal(bc.betanoOutcomes(B, "A", "B")["/Main/Main|ML|"].draw, true);
  // несмотря на «перекос» 2.2(Betano) vs 2.0(Pinnacle), ML-сигнала НЕТ — рынок 3-way пропущен
  assert.equal(bc.valueForEvent(B, P, "A", "B", { threshold: -1, maxPlausible: 99, marginMax: 99 }).filter((s) => s.kind === "ML").length, 0);
});

test("sportName: sportType → название (для статистики)", () => {
  assert.equal(bc.sportName(3), "Теннис");
  assert.equal(bc.sportName(9), "Бейсбол");
  assert.equal(bc.sportName(1), "Футбол");
  assert.equal(bc.sportName(22), "Кибер-футбол");
  assert.equal(bc.sportName(999), "sport#999"); // неизвестный → не падает
});

test("valueForEvent: фильтр маржи Pinnacle режет широкий (неострый) эталон", () => {
  const B = [
    { surebetTextId: "/Main/Main", meta: "Winner | A", marketValue: 2.20 },
    { surebetTextId: "/Main/Main", meta: "Winner | B", marketValue: 1.75 },
  ];
  // Pinnacle с ШИРОКОЙ маржой: 1/1.9+1/1.9−1 = 5.3%… сделаем явно широкую 1.7/1.7 → маржа 17.6%
  const Pwide = [
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM1||0|3", marketValue: 1.7, marketParameter: 0 },
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM2||0|3", marketValue: 1.7, marketParameter: 0 },
  ];
  // при marginMax 6% широкий эталон (17.6%) отсекается → 0 сигналов
  assert.equal(bc.valueForEvent(B, Pwide, "A", "B", { threshold: 0.02, marginMax: 0.06 }).length, 0);
  // с узкой маржой (2.0/2.0 = 0%) сигнал проходит
  const Ptight = [
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM1||0|3", marketValue: 2.0, marketParameter: 0 },
    { surebetTextId: "/Main/Main", meta: "1|0|MONEYLINE|TEAM2||0|3", marketValue: 2.0, marketParameter: 0 },
  ];
  assert.ok(bc.valueForEvent(B, Ptight, "A", "B", { threshold: 0.02, marginMax: 0.06 }).length >= 1);
});

test("scanValue: сторож рассинхрона по счёту — при разных счётах value не считается", () => {
  const game = (book, t1, t2, score) => ({ [`/${book}/T/L/${t1}/${t2}`]: { textId: `/${book}/T/L/${t1}/${t2}`, team1NameEn: t1, team2NameEn: t2, currentScore: score, sportType: 3, leagueName: "L", link: "" } });
  const mk = (book, t1, t2) => ({
    [`${book}1`]: { gameTextId: `/${book}/T/L/${t1}/${t2}`, surebetTextId: "/Main/Main", meta: book === "Betano" ? "Winner | " + t1 : "1|0|MONEYLINE|TEAM1||0|3", marketValue: book === "Betano" ? 2.2 : 2.0, marketParameter: 0 },
    [`${book}2`]: { gameTextId: `/${book}/T/L/${t1}/${t2}`, surebetTextId: "/Main/Main", meta: book === "Betano" ? "Winner | " + t2 : "1|0|MONEYLINE|TEAM2||0|3", marketValue: book === "Betano" ? 1.75 : 2.0, marketParameter: 0 },
  });
  const B = (score) => ({ gamesOriginModel: { model: game("Betano", "A", "B", score) }, marketsOriginModel: { model: mk("Betano", "A", "B") } });
  const P = (score) => ({ gamesOriginModel: { model: game("Pinnacle", "A", "B", score) }, marketsOriginModel: { model: mk("Pinnacle", "A", "B") } });
  // счёт совпадает → value есть (+10%)
  assert.equal(bc.scanValue(B("6-1, 1-0|CurrentGame:2"), P("6-1, 1-0|CurrentGame:5")).length, 1); // хвост CurrentGame игнор
  // счёт разный (плечо протухло) → скип, 0 сигналов
  assert.equal(bc.scanValue(B("6-1, 1-0"), P("6-1, 0-0")).length, 0);
});

// ── SPREAD / фора: ЗНАКОВАЯ линия со стороны A (team1). Форма данных из живого фида (захват 2026-07-03) ──

test("pinnacleOutcomes: SPREAD — обе линии ±L как разные ключи, знак со стороны A", () => {
  // Реальный расклад: Pinnacle отдаёт TEAM1@±1.5 и TEAM2@∓1.5 — ДВА рынка (линия +1.5 и линия −1.5 у team1).
  const mk = [
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM1||1.5|8", marketValue: 1.198, marketParameter: 1.5 },
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM2||-1.5|8", marketValue: 4.6, marketParameter: -1.5 },
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM1||-1.5|8", marketValue: 2.15, marketParameter: -1.5 },
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM2||1.5|8", marketValue: 1.719, marketParameter: 1.5 },
  ];
  const o = bc.pinnacleOutcomes(mk);
  assert.deepEqual(o["/Main/Main|SPREAD|1.5"], { A: 1.198, B: 4.6 });   // линия +1.5 у team1 (team2 −1.5)
  assert.deepEqual(o["/Main/Main|SPREAD|-1.5"], { A: 2.15, B: 1.719 }); // линия −1.5 у team1 (team2 +1.5)
});

test("pinnacleOutcomes: SPREAD при flip (обратный порядок команд) — линия всё равно со стороны A", () => {
  const mk = [
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM1||-1.5|8", marketValue: 2.15, marketParameter: -1.5 },
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM2||1.5|8", marketValue: 1.719, marketParameter: 1.5 },
  ];
  // flip=true: Pinnacle-TEAM1 = Betano-team2 (B). Линия со стороны A(=Betano-team1) = −(−1.5) = +1.5.
  const o = bc.pinnacleOutcomes(mk, true);
  assert.deepEqual(o["/Main/Main|SPREAD|1.5"], { A: 1.719, B: 2.15 });
});

test("betanoOutcomes: SPREAD — знаковая линия со стороны team1, сеты и геймы разведены по st", () => {
  const mk = [
    { surebetTextId: "/Main/Main", meta: "Match Handicap (Set) | Gustavo Heide -1.5", marketValue: 2.18, marketParameter: -1.5 },
    { surebetTextId: "/Main/Main", meta: "Match Handicap (Set) | Enrico Dalla Valle 1.5", marketValue: 1.6, marketParameter: 1.5 },
    { surebetTextId: "/Main/Main/Game", meta: "Handicap Games | Enrico Dalla Valle 2.5", marketValue: 1.98, marketParameter: 2.5 },
    { surebetTextId: "/Main/Main/Game", meta: "Handicap Games | Gustavo Heide -2.5", marketValue: 1.72, marketParameter: -2.5 },
  ];
  const o = bc.betanoOutcomes(mk, "Gustavo Heide", "Enrico Dalla Valle");
  assert.deepEqual(o["/Main/Main|SPREAD|-1.5"], { A: 2.18, B: 1.6 });       // сеты: team1 −1.5
  assert.deepEqual(o["/Main/Main/Game|SPREAD|-2.5"], { A: 1.72, B: 1.98 }); // геймы: team1 −2.5 (не путается с сетами)
});

test("valueForEvent: SPREAD матчится по ЗНАКОВОЙ линии; лишняя линия Pinnacle без пары не считается", () => {
  const B = [
    { surebetTextId: "/Main/Main", meta: "Match Handicap (Set) | Heide -1.5", marketValue: 2.2, marketParameter: -1.5 },
    { surebetTextId: "/Main/Main", meta: "Match Handicap (Set) | Valle 1.5", marketValue: 1.75, marketParameter: 1.5 },
  ];
  const P = [
    // линия −1.5 (fair 0.5/0.5) — совпадает с Betano
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM1||-1.5|8", marketValue: 2.0, marketParameter: -1.5 },
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM2||1.5|8", marketValue: 2.0, marketParameter: 1.5 },
    // линия +1.5 у team1 — у Betano такой линии НЕТ → фантомная пара не считается (раньше модуль склеил бы с −1.5)
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM1||1.5|8", marketValue: 1.2, marketParameter: 1.5 },
    { surebetTextId: "/Main/Main", meta: "1|0|SPREAD|TEAM2||-1.5|8", marketValue: 4.5, marketParameter: -1.5 },
  ];
  const sigs = bc.valueForEvent(B, P, "Heide", "Valle", { threshold: 0.02, maxPlausible: 0.25 });
  assert.equal(sigs.length, 1);          // только линия −1.5, сторона A
  assert.equal(sigs[0].kind, "SPREAD");
  assert.equal(sigs[0].side, "A");
  assert.equal(sigs[0].param, "-1.5");   // ЗНАКОВАЯ линия сохранена (для сеттлмента)
  assert.ok(near(sigs[0].value, 0.10, 2e-2)); // 2.2 × 0.5 − 1
});

// ── Снимки (модель сессии): накат дельт + сборка состояния + разбор ответа опроса ──

test("applySnapshot: рынки added/updated/removed + возврат writeTime", () => {
  const state = { games: {}, markets: { "/m/keep": { textId: "/m/keep", marketValue: 1.5 }, "/m/del": { textId: "/m/del", marketValue: 2.0 } } };
  const wt = bc.applySnapshot(state, {
    writeTime: "2026-07-02T10:00:00Z",
    marketsAdded: [{ textId: "/m/new", marketModel: { textId: "/m/new", marketValue: 3.3 } }],
    marketsUpdated: [{ textId: "/m/keep", marketModel: { textId: "/m/keep", marketValue: 1.9 } }],
    marketsRemoved: [{ textId: "/m/del" }],
  });
  assert.equal(wt, "2026-07-02T10:00:00Z");
  assert.equal(state.markets["/m/new"].marketValue, 3.3);   // added
  assert.equal(state.markets["/m/keep"].marketValue, 1.9);  // updated: кэф сменился
  assert.ok(!state.markets["/m/del"]);                      // removed
});

test("applySnapshot: дельта-обновление кэфа (marketModel:null, кэф в value)", () => {
  const state = { games: {}, markets: { "/m/1": { textId: "/m/1", marketValue: 1.5, gameTextId: "/g/1" } }, touched: {} };
  bc.applySnapshot(state, {
    writeTime: "2026-07-02T10:00:05Z",
    marketsUpdated: [{ textId: "/m/1", value: 2.2, marketModel: null, gameTextId: "/g/1" }],
  });
  assert.equal(state.markets["/m/1"].marketValue, 2.2);       // кэф обновился из value (раньше дропался!)
  assert.equal(state.touched["/g/1"], "2026-07-02T10:00:05Z"); // touched события бампнулся
});

test("applySnapshot: игры — точечный апдейт счёта, полная замена, удаление", () => {
  const state = { games: { "/g/1": { textId: "/g/1", team1NameEn: "A", team2NameEn: "B", currentScore: "0-0" }, "/g/del": { textId: "/g/del" } }, markets: {} };
  bc.applySnapshot(state, {
    gamesAdded: [{ textId: "/g/2", gameModel: { textId: "/g/2", team1NameEn: "C", team2NameEn: "D" } }],
    gamesUpdated: [{ textId: "/g/1", gameModel: null, currentScore: "1-0", statusType: 1 }],
    gamesRemoved: [{ textId: "/g/del" }],
  });
  assert.equal(state.games["/g/2"].team1NameEn, "C");       // added
  assert.equal(state.games["/g/1"].currentScore, "1-0");    // счёт обновился
  assert.equal(state.games["/g/1"].team1NameEn, "A");       // объект цел (имена не потеряны)
  assert.equal(state.games["/g/1"].statusType, 1);
  assert.ok(!state.games["/g/del"]);                        // removed
});

test("stateFromData: словари + sessionGuid + курсор + начальные снимки применены", () => {
  const data = {
    gamesOriginModel: { writeTime: "2026-07-02T10:00:00Z", model: { "/g/1": { textId: "/g/1", team1NameEn: "A", team2NameEn: "B" } } },
    marketsOriginModel: { writeTime: "2026-07-02T10:00:00Z", model: { "/m/1": { textId: "/m/1", marketValue: 1.5 } } },
    snapshots: [{ writeTime: "2026-07-02T10:00:01Z", sessionGuid: "SG-1",
      marketsAdded: [], marketsUpdated: [{ textId: "/m/1", marketModel: { textId: "/m/1", marketValue: 1.8 } }], marketsRemoved: [],
      gamesAdded: [], gamesUpdated: [], gamesRemoved: [] }],
  };
  const st = bc.stateFromData("Betano", data);
  assert.equal(st.sessionGuid, "SG-1");
  assert.equal(st.cursor, "2026-07-02T10:00:01Z");          // максимальный writeTime снимка
  assert.equal(st.markets["/m/1"].marketValue, 1.8);        // начальный снимок применён
  assert.ok(st.games["/g/1"]);
});

test("applySnapshotsResponse: mismatch / rate / нормальные дельты / пусто", () => {
  const mk = () => ({ games: {}, markets: { "/m/1": { textId: "/m/1", marketValue: 1.5 } }, cursor: "2026-07-02T10:00:00Z" });
  assert.deepEqual(bc.applySnapshotsResponse(mk(), { error: "SessionId mismatch. Expected..." }), { applied: 0, mismatch: true, rate: false });
  assert.equal(bc.applySnapshotsResponse(mk(), { rate: true }).rate, true);
  const st = mk();
  const r = bc.applySnapshotsResponse(st, { snapshots: [{ writeTime: "2026-07-02T10:00:02Z", marketsUpdated: [{ textId: "/m/1", marketModel: { textId: "/m/1", marketValue: 2.2 } }] }] });
  assert.equal(r.applied, 1);
  assert.equal(st.markets["/m/1"].marketValue, 2.2);        // дельта применилась
  assert.equal(st.cursor, "2026-07-02T10:00:02Z");          // курсор продвинулся
  const st2 = mk();
  assert.equal(bc.applySnapshotsResponse(st2, { snapshots: [] }).applied, 0);
  assert.equal(st2.cursor, "2026-07-02T10:00:00Z");         // пусто → курсор не двинулся
});
