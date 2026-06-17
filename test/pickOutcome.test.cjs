"use strict";
// Тест выбора исхода на РЕАЛЬНЫХ кнопках со страниц событий (снято «Снять купон»).
// Pinnacle: ATP Stuttgart, Shimabukuro–Kyrgios. Betano: тот же матч.
const test = require("node:test");
const assert = require("node:assert");
const { pickOutcome, classifyDesc, orderPlayers, isEventUrl, extractSubject, marketUnit, betanoTarget, localizeBetanoUrl } = require("../lib/bookers.cjs");

const SLUG_T = "https://www.betano.pt/odds/sho-shimabukuro-nick-kyrgios/87161959/"; // player1=Shimabukuro
const SLUG_NBA = "https://www.betano.pt/odds/new-york-knicks-san-antonio-spurs/86655013/"; // player1=Knicks

const withIndex = (arr) => arr.map((b, i) => ({ i, id: b.id || "", text: b.text }));

// ── Pinnacle: кнопки с id (eventId|период|тип|…|линия) ───────────────────────
const PINN = withIndex([
  { id: "1631805342|0|2|0|0|+1.5", text: "+1.5 1.543" },
  { id: "1631805342|0|2|1|0|-1.5", text: "-1.5 2.560" },
  { id: "1631805342|0|2|0|1|-1.5", text: "-1.5 3.640" },
  { id: "1631805342|0|2|1|1|+1.5", text: "+1.5 1.308" },
  { id: "1631805342|0|3|3|0|2.5", text: "Over 2.5 Sets 2.550" },
  { id: "1631805342|0|3|4|0|2.5", text: "Under 2.5 Sets 1.546" },
  { id: "1631805342|0|1|0|0|0", text: "Sho Shimabukuro 2.230" },
  { id: "1631805342|0|1|1|0|0", text: "Nick Kyrgios 1.709" },
  { id: "all", text: "ALL" },
  { id: "0", text: "MATCH" },
]);

test("Pinnacle: фора Ф1(+1.5) @1.543 → Shimabukuro +1.5 (не Kyrgios +1.5)", () => {
  const r = pickOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.543, buttons: PINN });
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5");
  assert.strictEqual(r.odds, 1.543);
  assert.strictEqual(r.how, "desc");
});
test("Pinnacle: фора Ф2(-1.5) @2.560 → -1.5 2.560", () => {
  assert.strictEqual(pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 2.56, buttons: PINN }).id, "1631805342|0|2|1|0|-1.5");
});
test("Pinnacle: Тм(2.5) @1.546 → Under 2.5", () => {
  const r = pickOutcome({ desc: "Тм(2.5)", expectedOdds: 1.546, buttons: PINN });
  assert.match(r.text, /Under/);
});
test("Pinnacle: Тб(2.5) @2.550 → Over 2.5", () => {
  assert.match(pickOutcome({ desc: "Тб(2.5)", expectedOdds: 2.55, buttons: PINN }).text, /Over/);
});
test("Pinnacle: П1 @2.230 → Shimabukuro", () => {
  assert.strictEqual(pickOutcome({ desc: "П1", expectedOdds: 2.23, buttons: PINN }).id, "1631805342|0|1|0|0|0");
});
test("Pinnacle: П2 @1.709 → Kyrgios", () => {
  assert.strictEqual(pickOutcome({ desc: "П2", expectedOdds: 1.709, buttons: PINN }).id, "1631805342|0|1|1|0|0");
});
test("Pinnacle: точный путь по id из вилки (другой префикс события)", () => {
  const r = pickOutcome({ desc: "", expectedOdds: 0, outcomeId: "999999|0|2|0|0|+1.5", buttons: PINN });
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5");
  assert.strictEqual(r.how, "id");
});

// ── Betano: кнопки .selections__selection БЕЗ id, имя+линия+кэф в тексте ──────
const BET = withIndex([
  { text: "Sho Shimabukuro 2.10" },
  { text: "Nick Kyrgios 1.72" },
  { text: "1.95" }, { text: "1.70" }, { text: "1.95" }, { text: "1.70" },
  { text: "Over 19.5 1.16" }, { text: "Under 19.5 3.75" },
  { text: "Over 22.5 1.53" }, { text: "Under 22.5 2.10" },
  { text: "Over 23.5 1.75" }, { text: "Under 23.5 1.78" },
  { text: "Sho Shimabukuro +1.5 1.72" },
  { text: "Nick Kyrgios -1.5 1.82" },
  { text: "2 - 0 3.60" }, { text: "2 - 1 4.25" }, { text: "0 - 2 2.75" }, { text: "1 - 2 3.80" },
]);

test("Betano: фора Ф2(-1.5) @1.82 → Nick Kyrgios -1.5 1.82", () => {
  const r = pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 1.82, buttons: BET });
  assert.strictEqual(r.text, "Nick Kyrgios -1.5 1.82");
  assert.strictEqual(r.odds, 1.82);
});
test("Betano: фора Ф1(+1.5) @1.72 → Sho Shimabukuro +1.5 1.72", () => {
  assert.strictEqual(pickOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.72, buttons: BET }).text, "Sho Shimabukuro +1.5 1.72");
});
test("Betano: Тм(22.5) @2.10 → Under 22.5 2.10 (не победа Shimabukuro 2.10)", () => {
  const r = pickOutcome({ desc: "Тм(22.5)", expectedOdds: 2.10, buttons: BET });
  assert.strictEqual(r.text, "Under 22.5 2.10");
});
test("Betano: Тб(22.5) @1.53 → Over 22.5 1.53", () => {
  assert.strictEqual(pickOutcome({ desc: "Тб(22.5)", expectedOdds: 1.53, buttons: BET }).text, "Over 22.5 1.53");
});
test("Betano: П1 @2.10 → Shimabukuro (НЕ Under 22.5 с тем же кэфом 2.10)", () => {
  const r = pickOutcome({ desc: "П1", expectedOdds: 2.10, buttons: BET });
  assert.strictEqual(r.text, "Sho Shimabukuro 2.10");
});
test("Betano: П2 @1.72 → Nick Kyrgios 1.72 (не фора +1.5 с кэфом 1.72)", () => {
  const r = pickOutcome({ desc: "П2", expectedOdds: 1.72, buttons: BET });
  assert.strictEqual(r.text, "Nick Kyrgios 1.72");
});
test("выбранная кнопка несёт индекс i для клика", () => {
  const r = pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 1.82, buttons: BET });
  assert.strictEqual(typeof r.i, "number");
  assert.strictEqual(BET[r.i].text, "Nick Kyrgios -1.5 1.82");
});

// ── БЕЗОПАСНОСТЬ: пропсы и нераспознанное → null (не берём чужой исход) ────────
test("пропс игрока «Тотал ≥3 ОТ - ассисты» @2.35 → null (НЕ San Antonio Spurs 2.10)", () => {
  // реальный кейс: матчер раньше хватал команду по близкому кэфу
  const NBA = withIndex([
    { text: "San Antonio Spurs 2.10" },
    { text: "New York Knicks 1.75" },
    { text: "Over 220.5 1.90" }, { text: "Under 220.5 1.90" },
  ]);
  assert.strictEqual(pickOutcome({ desc: "Тотал ≥3 ОТ - ассисты", expectedOdds: 2.35, buttons: NBA }), null);
});

test("стоп-порог: ближайший кэф слишком далеко → null", () => {
  // ждали 5.0, а единственный Over 2.5 на странице — 2.55 (отклонение ~49%)
  assert.strictEqual(pickOutcome({ desc: "Тб(2.5)", expectedOdds: 5.0, buttons: PINN }), null);
});

test("classifyDesc: распознаёт фору/тотал/победу/счёт, отклоняет пропсы", () => {
  assert.strictEqual(classifyDesc("Ф1(+1.5)").kind, "hcap");
  assert.strictEqual(classifyDesc("Тб(2.5)").kind, "total");
  assert.strictEqual(classifyDesc("Тм(220.5)").kind, "total");
  assert.strictEqual(classifyDesc("П1").kind, "win");
  assert.strictEqual(classifyDesc("2:0").kind, "score");
  assert.strictEqual(classifyDesc("Тотал ≥3 ОТ - ассисты").kind, null);
  assert.strictEqual(classifyDesc("Devin Vassell - очки").kind, null);
});

// ── АНГЛ-нотация фида (после переключения на английский ради сверки имён #1) ──
test("classifyDesc: английские форы/тоталы (AH/Over/Under) — сторона, знак линии, over/under", () => {
  const ah1 = classifyDesc("AH1(+1.5)");
  assert.strictEqual(ah1.kind, "hcap");
  assert.strictEqual(ah1.side, "1");
  assert.strictEqual(ah1.line, "+1.5");
  const ah2 = classifyDesc("AH2(−1.5)"); // юникод-минус из фида
  assert.strictEqual(ah2.kind, "hcap");
  assert.strictEqual(ah2.side, "2");
  assert.strictEqual(ah2.line, "-1.5");
  const ov = classifyDesc("Over 7.5 OT"); // с суффиксом overtime
  assert.strictEqual(ov.kind, "total");
  assert.strictEqual(ov.over, true);
  assert.strictEqual(ov.line, "7.5");
  const un = classifyDesc("Under 220.5");
  assert.strictEqual(un.kind, "total");
  assert.strictEqual(un.over, false);
  assert.strictEqual(un.line, "220.5");
  // русская нотация по-прежнему работает (фид может вернуться)
  assert.strictEqual(classifyDesc("Ф2(-2.5)").kind, "hcap");
  assert.strictEqual(classifyDesc("Тб(7.5)").over, true);
});

test("англ-тотал «Over 7.5» → кнопка «Over 7.5 1.95» (не Under)", () => {
  const buttons = [
    { i: 0, id: "", text: "Over 7.5 1.95" },
    { i: 1, id: "", text: "Under 7.5 1.85" },
  ];
  const r = pickOutcome({ desc: "Over 7.5", expectedOdds: 1.95, buttons });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.i, 0);
});

test("англ-фора «AH1(+1.5)» → кнопка «+1.5 1.66» по знаку+линии", () => {
  const buttons = [
    { i: 0, id: "", text: "+1.5 1.66" },
    { i: 1, id: "", text: "-1.5 2.20" },
  ];
  const r = pickOutcome({ desc: "AH1(+1.5)", expectedOdds: 1.66, buttons });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.i, 0);
});

// ── ДВОЙНОЙ ШАНС / составные исходы (1X/X2/12) vs одиночная победа ────────────
test("classifyDesc: 1X/X2/12 = двойной шанс (dc), а 1/2/X = одиночная победа", () => {
  assert.strictEqual(classifyDesc("1X").kind, "dc");
  assert.deepStrictEqual(classifyDesc("1X").sides, ["1", "X"]);
  assert.deepStrictEqual(classifyDesc("X2").sides, ["X", "2"]);
  assert.deepStrictEqual(classifyDesc("12").sides, ["1", "2"]);
  assert.strictEqual(classifyDesc("1").kind, "win");
  assert.strictEqual(classifyDesc("1").side, "1");
  assert.strictEqual(classifyDesc("X").kind, "win");
  assert.strictEqual(classifyDesc("X").side, "X");
});

// реальный кейс из лога: искали «1» (Vancouver FC), бот брал «Vancouver FC or Draw» (двойной шанс)
const FOOTBALL = [
  { i: 0, id: "", text: "Vancouver FC 2.35" },
  { i: 1, id: "", text: "Draw 3.90" },
  { i: 2, id: "", text: "Pacific FC 4.10" },
  { i: 3, id: "", text: "Vancouver FC or Draw 1.42" },
  { i: 4, id: "", text: "Draw or Pacific FC 1.63" },
  { i: 5, id: "", text: "Vancouver FC or Pacific FC 1.19" },
];
const FURL = "https://www.betano.pt/odds/vancouver-fc-pacific-fc/87075448/";

test("одиночная победа «1» → чистая «Vancouver FC 2.35», НЕ составная «… or …»", () => {
  const r = pickOutcome({ desc: "1", expectedOdds: 2.35, subject: "Vancouver FC", eventUrl: FURL, buttons: FOOTBALL });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.i, 0);
});

test("двойной шанс «X2» → «Draw or Pacific FC» (ничья или гость)", () => {
  const r = pickOutcome({ desc: "X2", expectedOdds: 1.63, eventUrl: FURL, buttons: FOOTBALL });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.i, 4);
});

test("двойной шанс «1X» → «Vancouver FC or Draw»; «12» → «Vancouver FC or Pacific FC»", () => {
  const r1 = pickOutcome({ desc: "1X", expectedOdds: 1.42, eventUrl: FURL, buttons: FOOTBALL });
  assert.ok(r1); assert.strictEqual(r1.i, 3);
  const r12 = pickOutcome({ desc: "12", expectedOdds: 1.19, eventUrl: FURL, buttons: FOOTBALL });
  assert.ok(r12); assert.strictEqual(r12.i, 5);
});

// ── ТОЧНЫЙ СЧЁТ (теннис): «2:0» → кнопка «2 - 0», не победа ──────────────────
test("счёт 2:0 @3.55 → «2 - 0 3.60» (НЕ победа Shimabukuro 2.10)", () => {
  const r = pickOutcome({ desc: "2:0", expectedOdds: 3.55, buttons: BET });
  assert.strictEqual(r.text, "2 - 0 3.60");
});
test("счёт 0:2 @2.75 → «0 - 2 2.75» (не путает с 2:0)", () => {
  assert.strictEqual(pickOutcome({ desc: "0:2", expectedOdds: 2.75, buttons: BET }).text, "0 - 2 2.75");
});
test("счёт 2:1 @4.25 → «2 - 1 4.25»", () => {
  assert.strictEqual(pickOutcome({ desc: "2:1", expectedOdds: 4.25, buttons: BET }).text, "2 - 1 4.25");
});

// ── Сетовая фора −1.5 ⟺ точный счёт (БО3). Betano: нет форы сетов → берёт счёт ──
test("Betano: Ф2(−1.5) сеты @2.75 → счёт «0 - 2» (форы сетов нет, есть геймовая −1.5)", () => {
  // у Betano есть геймовая «-1.5» (Kyrgios -1.5 1.82) и счёт «0 - 2 2.75» — кэф разводит
  const r = pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 2.75, buttons: BET, eventUrl: SLUG_T, unit: "set" });
  assert.strictEqual(r.text, "0 - 2 2.75");
});
test("Betano: Ф1(−1.5) сеты @3.60 → счёт «2 - 0»", () => {
  const r = pickOutcome({ desc: "Ф1(-1.5)", expectedOdds: 3.60, buttons: BET, eventUrl: SLUG_T, unit: "set" });
  assert.strictEqual(r.text, "2 - 0 3.60");
});
test("Pinnacle: Ф2(−1.5) сеты — остаётся форой по кэфу (счёта на странице нет)", () => {
  // в PINN счёта нет, но есть -1.5 @2.560 → берётся фора
  const r = pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 2.560, buttons: PINN, eventUrl: "https://www.pinnacle888.com/en/standard/tennis/x/sho-shimabukuro-vs-nick-kyrgios/1631805342", unit: "set" });
  assert.strictEqual(r.id, "1631805342|0|2|1|0|-1.5");
});

// ── СВЕРКА СТОРОНЫ ПО ИМЕНИ (Ф1/П1 = первый игрок из URL события) ────────────
test("orderPlayers: порядок из URL (player1 первым), даже без «vs» в слаге", () => {
  assert.deepStrictEqual(orderPlayers(SLUG_T, ["Nick Kyrgios", "Sho Shimabukuro"]), ["Sho Shimabukuro", "Nick Kyrgios"]);
  assert.deepStrictEqual(orderPlayers(SLUG_NBA, ["San Antonio Spurs", "New York Knicks"]), ["New York Knicks", "San Antonio Spurs"]);
});

test("ИМЯ ПОБЕЖДАЕТ КЭФ: П1, но кэф уехал так, что ближе игрок 2 → всё равно игрок 1", () => {
  const DRIFT = withIndex([
    { text: "Sho Shimabukuro 2.50" }, // player1 — кэф уехал вверх
    { text: "Nick Kyrgios 2.05" },    // player2 — ближе к ожидаемым 2.10
    { text: "Over 22.5 1.90" }, { text: "Under 22.5 1.90" },
  ]);
  const r = pickOutcome({ desc: "П1", expectedOdds: 2.10, buttons: DRIFT, eventUrl: SLUG_T });
  assert.strictEqual(r.text, "Sho Shimabukuro 2.50"); // выбран по ИМЕНИ, не по кэфу
  assert.strictEqual(r.how, "name");
});

test("Betano фора Ф1(+1.5): сторона подтверждена именем игрока", () => {
  const r = pickOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.72, buttons: BET, eventUrl: SLUG_T });
  assert.strictEqual(r.text, "Sho Shimabukuro +1.5 1.72");
  assert.strictEqual(r.how, "name");
});

// ── extractSubject: имя игрока/команды из расширенного описания ───────────────
test("extractSubject: имя игрока из descFull", () => {
  assert.strictEqual(extractSubject("Sho Shimabukuro победит с форой +1.5 (азиатский гандикап) - сеты"), "Sho Shimabukuro");
  assert.strictEqual(extractSubject("San Antonio Spurs тотал больше 220.5"), "San Antonio Spurs");
  assert.strictEqual(extractSubject("New York Knicks победит"), "New York Knicks");
});

// ── marketUnit: различить сеты/геймы (Pinnacle держит их в разных вкладках) ────
test("marketUnit: сеты vs геймы из хвоста описания", () => {
  assert.strictEqual(marketUnit("Александр Бублик (геймы) победит с форой +1.5 (азиатский гандикап) - сеты"), "set");
  assert.strictEqual(marketUnit("Игрок победит с форой -1.5 (азиатский гандикап) - геймы"), "game");
  assert.strictEqual(marketUnit("Sho Shimabukuro победит с форой +1.5 - сеты"), "set");
  assert.strictEqual(marketUnit("Победа в матче"), null);
});

// ── isEventUrl: ссылка на КОНКРЕТНОЕ событие (есть числовой id), а не раздел ───
test("isEventUrl: событие = да, общий раздел/домен = нет", () => {
  assert.strictEqual(isEventUrl("https://www.pinnacle888.com/en/standard/tennis/atp-x/a-vs-b/1631805342"), true);
  assert.strictEqual(isEventUrl("https://www.betano.pt/odds/new-york-knicks-san-antonio-spurs/86655013/"), true);
  assert.strictEqual(isEventUrl("https://www.pinnacle888.com/en/compact/sports"), false); // ← баг из лога
  assert.strictEqual(isEventUrl("https://www.pinnacle888.com/"), false);
  assert.strictEqual(isEventUrl("https://www.betano.pt/"), false);
});

test("БЕЗОПАСНОСТЬ: нужной стороны по имени нет → отказ, НЕ берём чужую (-1.5 другого игрока)", () => {
  // desc Ф1(-1.5) = Shimabukuro -1.5, но в BET есть только «Nick Kyrgios -1.5» → null (не Kyrgios!)
  const r = pickOutcome({ desc: "Ф1(-1.5)", expectedOdds: 1.82, buttons: BET, eventUrl: SLUG_T });
  assert.strictEqual(r, null);
});

// ── ПРЯМОЙ коннект имени плеча (descFull→subject) с кнопкой Betano (бейсбол-кейс из лога) ──
const NBA_HCAP = withIndex([
  { text: "Milwaukee Brewers -1.5 2.42" },
  { text: "Philadelphia Phillies +1.5 1.55" },
  { text: "Philadelphia Phillies -1.5 2.60" },
  { text: "Milwaukee Brewers +1.5 1.50" },
  { text: "Milwaukee Brewers 1.80" }, { text: "Philadelphia Phillies 2.05" },
]);
const SLUG_MLB = "https://www.betano.pt/odds/milwaukee-brewers-philadelphia-phillies/87086699/";

test("Ф1(−1.5) subject=Milwaukee → берёт «Milwaukee Brewers -1.5» (а НЕ Philadelphia -1.5)", () => {
  const r = pickOutcome({ desc: "Ф1(-1.5)", subject: "Milwaukee Brewers", expectedOdds: 2.42, buttons: NBA_HCAP, eventUrl: SLUG_MLB });
  assert.strictEqual(r.text, "Milwaukee Brewers -1.5 2.42");
});
test("Ф1(−1.5) subject=Milwaukee, но Milwaukee -1.5 НЕТ на странице → отказ (НЕ Philadelphia -1.5)", () => {
  const noMil = withIndex([
    { text: "Philadelphia Phillies -1.5 2.60" }, { text: "Milwaukee Brewers +1.5 1.50" },
    { text: "Milwaukee Brewers 1.80" }, { text: "Philadelphia Phillies 2.05" },
  ]);
  const r = pickOutcome({ desc: "Ф1(-1.5)", subject: "Milwaukee Brewers", expectedOdds: 2.42, buttons: noMil, eventUrl: SLUG_MLB });
  assert.strictEqual(r, null);
});

test("Pinnacle фора (имени на кнопке нет) — остаётся выбор по кэфу", () => {
  // у Pinnacle кнопки «+1.5 1.543» без имени → имя не применяется, работает кэф
  const r = pickOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.543, buttons: PINN, eventUrl: "https://www.pinnacle888.com/en/standard/tennis/x/sho-shimabukuro-vs-nick-kyrgios/1631805342" });
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5");
  assert.strictEqual(r.how, "desc");
});

// ── Доп-рынок «X 1-2» (нет ничьи / DNB): для 2-исходных видов = победитель ─────
test("classifyDesc: «1 1-2» (полный матч, нет ничьи) → победа side 1, nodraw", () => {
  const r = classifyDesc("1 1-2");
  assert.strictEqual(r.kind, "win"); assert.strictEqual(r.side, "1"); assert.strictEqual(r.nodraw, true);
  assert.strictEqual(classifyDesc("2 1-2").side, "2");
});
test("classifyDesc: «1 1-2 1st set» (саб-период) → не берём (null)", () => {
  assert.strictEqual(classifyDesc("1 1-2 1st set").kind, null);
});
test("pickOutcome: «1 1-2» теннис @5.6 → победитель Petja Drame 5.60 (реальный кейс из лога)", () => {
  const buttons = [
    { i: 0, id: "", text: "Petja Drame 5.60" }, { i: 1, id: "", text: "Karine Sarkisova 1.10" },
    { i: 2, id: "", text: "4.20" }, { i: 3, id: "", text: "1.18" },
  ];
  const r = pickOutcome({ desc: "1 1-2", expectedOdds: 5.6, buttons, eventUrl: "https://www.betano.bg/en/match-odds/petja-drame-karine-sarkisova/87599652/", subject: "Petja Drame" });
  assert.ok(r, "должен найти исход"); assert.strictEqual(r.text, "Petja Drame 5.60");
});
test("pickOutcome: «1 1-2» с НИЧЬЕЙ на странице (3-исходный) → null (не подменяем DNB победителем)", () => {
  const buttons = [
    { i: 0, id: "", text: "Team A 1.40" }, { i: 1, id: "", text: "X 3.50" }, { i: 2, id: "", text: "Team B 5.00" },
  ];
  const r = pickOutcome({ desc: "1 1-2", expectedOdds: 1.25, buttons, eventUrl: "https://www.betano.bg/en/match-odds/team-a-team-b/123456/", subject: "Team A" });
  assert.strictEqual(r, null);
});

// ── Betano: авто-рерайт страны (RO-фид → BG-аккаунт), ID события общий ─────────
test("betanoTarget: betano.bg → BG-сайт, прочие → null", () => {
  const t = betanoTarget("https://www.betano.bg/");
  assert.deepStrictEqual(t, { host: "www.betano.bg", path: "en/match-odds" });
  assert.strictEqual(betanoTarget("https://www.betano.pt/"), null);   // PT — без рерайта
  assert.strictEqual(betanoTarget("https://ro.betano.com/"), null);   // RO-источник — без рерайта
  assert.strictEqual(betanoTarget(""), null);
});

test("localizeBetanoUrl: RO deep-ссылка → BG, ID сохранён (реальный пример)", () => {
  const tgt = betanoTarget("https://www.betano.bg/");
  const ro = "https://ro.betano.com/cote/cehia-africa-de-sud/83961881/?bt=14";
  const bg = localizeBetanoUrl(ro, tgt);
  const u = new URL(bg);
  assert.strictEqual(u.hostname, "www.betano.bg");
  assert.strictEqual(u.pathname, "/en/match-odds/cehia-africa-de-sud/83961881/"); // slug сохранён, Betano поправит по id
  assert.match(bg, /83961881/);          // ID общий → то же событие
  assert.strictEqual(u.search, "");      // ?bt= отброшен — открываем полную страницу события
});

test("localizeBetanoUrl: не-betano и домашняя страница — не трогаем", () => {
  const tgt = betanoTarget("https://www.betano.bg/");
  assert.strictEqual(localizeBetanoUrl("https://www.pinnacle888.com/en/standard/x/1631929272/", tgt), "https://www.pinnacle888.com/en/standard/x/1631929272/");
  assert.strictEqual(localizeBetanoUrl("https://ro.betano.com/", tgt), "https://ro.betano.com/"); // нет slug+id
  assert.strictEqual(localizeBetanoUrl("https://ro.betano.com/cote/x/83961881/", null), "https://ro.betano.com/cote/x/83961881/"); // target=null
});
