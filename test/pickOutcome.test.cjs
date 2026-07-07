"use strict";
// Тест выбора исхода на РЕАЛЬНЫХ кнопках со страниц событий (снято «Снять купон»).
// Pinnacle: ATP Stuttgart, Shimabukuro–Kyrgios. Betano: тот же матч.
const test = require("node:test");
const assert = require("node:assert");
const { pickOutcome, classifyDesc, orderPlayers, isEventUrl, extractSubject, marketUnit, betanoTarget, localizeBetanoUrl, betanoCategoryFor } = require("../lib/bookers.cjs");

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

test("Pinnacle: фора Ф1(+1.5) @1.543 → Shimabukuro +1.5 (имя приклеено из мани-лайна по id-стороне)", () => {
  // имя команды у Pinnacle-форы берётся из мани-лайна той же стороны (id …|2|СТОРОНА|…) и подтверждается
  const r = pickOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.543, buttons: PINN, eventUrl: SLUG_T });
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5");
  assert.strictEqual(r.odds, 1.543);
  assert.strictEqual(r.how, "name");
});
test("Pinnacle: фора Ф2(-1.5) @2.560 → Kyrgios -1.5 (подтверждено именем, не Shimabukuro -1.5)", () => {
  assert.strictEqual(pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 2.56, buttons: PINN, eventUrl: SLUG_T }).id, "1631805342|0|2|1|0|-1.5");
});
test("Pinnacle: Тм(2.5) @1.546 → Under 2.5", () => {
  const r = pickOutcome({ desc: "Тм(2.5)", expectedOdds: 1.546, buttons: PINN });
  assert.match(r.text, /Under/);
});
test("Pinnacle: Тб(2.5) @2.550 → Over 2.5", () => {
  assert.match(pickOutcome({ desc: "Тб(2.5)", expectedOdds: 2.55, buttons: PINN }).text, /Over/);
});
test("Pinnacle: П1 @2.230 → Shimabukuro (подтверждено именем)", () => {
  assert.strictEqual(pickOutcome({ desc: "П1", expectedOdds: 2.23, buttons: PINN, eventUrl: SLUG_T }).id, "1631805342|0|1|0|0|0");
});
test("Pinnacle: П2 @1.709 → Kyrgios (подтверждено именем)", () => {
  assert.strictEqual(pickOutcome({ desc: "П2", expectedOdds: 1.709, buttons: PINN, eventUrl: SLUG_T }).id, "1631805342|0|1|1|0|0");
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
  const r = pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 1.82, buttons: BET, eventUrl: SLUG_T });
  assert.strictEqual(r.text, "Nick Kyrgios -1.5 1.82");
  assert.strictEqual(r.odds, 1.82);
});
test("Betano: фора Ф1(+1.5) @1.72 → Sho Shimabukuro +1.5 1.72", () => {
  assert.strictEqual(pickOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.72, buttons: BET, eventUrl: SLUG_T }).text, "Sho Shimabukuro +1.5 1.72");
});
test("Betano: Тм(22.5) @2.10 → Under 22.5 2.10 (не победа Shimabukuro 2.10)", () => {
  const r = pickOutcome({ desc: "Тм(22.5)", expectedOdds: 2.10, buttons: BET });
  assert.strictEqual(r.text, "Under 22.5 2.10");
});
test("Betano: Тб(22.5) @1.53 → Over 22.5 1.53", () => {
  assert.strictEqual(pickOutcome({ desc: "Тб(22.5)", expectedOdds: 1.53, buttons: BET }).text, "Over 22.5 1.53");
});
test("Betano: П1 @2.10 → Shimabukuro (НЕ Under 22.5 с тем же кэфом 2.10)", () => {
  const r = pickOutcome({ desc: "П1", expectedOdds: 2.10, buttons: BET, eventUrl: SLUG_T });
  assert.strictEqual(r.text, "Sho Shimabukuro 2.10");
});
test("Betano: П2 @1.72 → Nick Kyrgios 1.72 (не фора +1.5 с кэфом 1.72)", () => {
  const r = pickOutcome({ desc: "П2", expectedOdds: 1.72, buttons: BET, eventUrl: SLUG_T });
  assert.strictEqual(r.text, "Nick Kyrgios 1.72");
});
test("выбранная кнопка несёт индекс i для клика", () => {
  const r = pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 1.82, buttons: BET, eventUrl: SLUG_T });
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

test("Pinnacle-фора без имени и без id → отказ (нельзя подтвердить команду, по кэфу не угадываем)", () => {
  const buttons = [
    { i: 0, id: "", text: "+1.5 1.66" },
    { i: 1, id: "", text: "-1.5 2.20" },
  ];
  assert.strictEqual(pickOutcome({ desc: "AH1(+1.5)", expectedOdds: 1.66, buttons }), null);
});
test("Pinnacle-фора: имя приклеено из мани-лайна по id-стороне → берём +1.5 НУЖНОЙ команды", () => {
  const buttons = withIndex([
    { id: "999|0|1|0|0|0", text: "Fukuoka Hawks 1.95" },       // мани-лайн side0
    { id: "999|0|1|1|0|0", text: "Hokkaido Fighters 1.85" },   // мани-лайн side1
    { id: "999|0|2|0|0|+1.5", text: "+1.5 1.66" },              // фора side0 → Fukuoka
    { id: "999|0|2|1|0|-1.5", text: "-1.5 2.20" },              // фора side1 → Hokkaido
  ]);
  const url = "https://www.pinnacle888.com/en/standard/baseball/npb/fukuoka-hawks-hokkaido-fighters/999";
  const r = pickOutcome({ desc: "AH1(+1.5)", expectedOdds: 1.66, buttons, eventUrl: url });
  assert.ok(r, "должен подтвердить команду по имени из мани-лайна");
  assert.strictEqual(r.id, "999|0|2|0|0|+1.5");
  assert.strictEqual(r.team, "Fukuoka Hawks");
  assert.strictEqual(r.how, "name");
});
test("Pinnacle-фора: нужной команды среди +1.5 нет (только чужая) → отказ (защита от ставки на ту же команду)", () => {
  const buttons = withIndex([
    { id: "999|0|1|0|0|0", text: "Fukuoka Hawks 1.95" },
    { id: "999|0|1|1|0|0", text: "Hokkaido Fighters 1.85" },
    { id: "999|0|2|1|0|+1.5", text: "+1.5 1.66" },   // +1.5 принадлежит Hokkaido (side1)
    { id: "999|0|2|0|0|-1.5", text: "-1.5 2.20" },   // -1.5 у Fukuoka (side0)
  ]);
  const url = "https://www.pinnacle888.com/en/standard/baseball/npb/fukuoka-hawks-hokkaido-fighters/999";
  // просят Fukuoka +1.5, но на странице +1.5 = Hokkaido → подтвердить Fukuoka нельзя → отказ (не берём Hokkaido)
  assert.strictEqual(pickOutcome({ desc: "AH1(+1.5)", subject: "Fukuoka Hawks", expectedOdds: 1.66, buttons, eventUrl: url }), null);
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
test("Pinnacle: Ф2(−1.5) сеты — берётся фора Kyrgios (счёта на странице нет, имя из мани-лайна)", () => {
  // в PINN счёта нет, но есть -1.5 @2.560 у Kyrgios (side1) → подтверждаем по имени из мани-лайна
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

test("Pinnacle фора (имени на кнопке нет) — имя из мани-лайна по id-стороне, подтверждено", () => {
  // у Pinnacle кнопки «+1.5 1.543» без имени → имя приклеиваем из мани-лайна той же стороны (id …|2|0|…) → name
  const r = pickOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.543, buttons: PINN, eventUrl: "https://www.pinnacle888.com/en/standard/tennis/x/sho-shimabukuro-vs-nick-kyrgios/1631805342" });
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5");
  assert.strictEqual(r.team, "Sho Shimabukuro");
  assert.strictEqual(r.how, "name");
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

// ── Betano: вкладка категории для спец-рынков (карточки/угловые) ───────────────
test("betanoCategoryFor: карточки → Cards, угловые → Corner kicks, прочее → null", () => {
  assert.strictEqual(betanoCategoryFor("Тотал меньше 3.5 - карточки"), "Cards");
  assert.strictEqual(betanoCategoryFor("Total under 4.5 - cards"), "Cards");
  assert.strictEqual(betanoCategoryFor("Тотал больше 1.5 - угловые команда X"), "Corner kicks");
  assert.strictEqual(betanoCategoryFor("Total over 8.5 - corners"), "Corner kicks");
  assert.strictEqual(betanoCategoryFor("Petja Drame to win (no draw) - sets"), null);
  assert.strictEqual(betanoCategoryFor(""), null);
});

// ── Betano: ЕВРОПЕЙСКИЙ гандикап (бейсбол, вкладка Handicap) — реальные кнопки из капчи ──
const MLB_EH = withIndex([
  { text: "Athletics -1.5 2.37" }, { text: "Los Angeles Angels +1.5 1.60" },   // азиатские (.5) — НЕ евро
  { text: "Athletics -1 2.35" }, { text: "Tie -1 5.30" }, { text: "Los Angeles Angels +1 2.10" }, // евро incl. extra innings
  { text: "Athletics -1 3.10" }, { text: "Tie -1 5.70" }, { text: "Los Angeles Angels +1 1.67" }, // евро 3 full innings
]);
const MLB_URL = "https://www.betano.bg/en/match-odds/athletics-los-angeles-angels/85397353/";

test("classifyDesc: «1(1:0)» → европейский гандикап (ehcap), а «Ф1(+1.5)» остаётся азиатским", () => {
  assert.strictEqual(classifyDesc("1(1:0)").kind, "ehcap");
  assert.strictEqual(classifyDesc("1(1:0)").side, "1");
  assert.strictEqual(classifyDesc("2(0:1) ОТ").kind, "ehcap");
  assert.strictEqual(classifyDesc("Ф1(+1.5)").kind, "hcap");
});

test("pickOutcome: евро-гандикап «1(1:0)» Athletics @2.35 → Athletics -1 2.35 (incl. extra innings по кэфу, не .5, не Tie)", () => {
  const r = pickOutcome({ desc: "1(1:0)", expectedOdds: 2.35, buttons: MLB_EH, subject: "Athletics", eventUrl: MLB_URL });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.text, "Athletics -1 2.35");
});

test("pickOutcome: евро-гандикап «2(0:1)» Angels @2.10 → Los Angeles Angels +1 2.10", () => {
  const r = pickOutcome({ desc: "2(0:1)", expectedOdds: 2.10, buttons: MLB_EH, subject: "Los Angeles Angels", eventUrl: MLB_URL });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.text, "Los Angeles Angels +1 2.10");
});

test("pickOutcome: евро-гандикап — если кэф далёк (не тот вариант) → null (страховка)", () => {
  const r = pickOutcome({ desc: "1(1:0)", expectedOdds: 9.99, buttons: MLB_EH, subject: "Athletics", eventUrl: MLB_URL });
  assert.strictEqual(r, null);
});

test("betanoCategoryFor: европейский гандикап → вкладка Handicap", () => {
  assert.strictEqual(betanoCategoryFor("Cleveland Guardians победит с форой 1:0 (европейский гандикап) с учётом овертайма - раны"), "Handicap");
});

// ── Pinnacle: «1-2 OT» (DNB incl. overtime, бейсбол) → 2-way мани-лайн команды (реальные кнопки из лога) ──
const PINN_MLB_ML = withIndex([
  { text: "Milwaukee Brewers 1.671" }, { text: "Cleveland Guardians 2.370" }, // 2-way мани-лайн (без ничьи, incl OT)
  { text: "-1.5 2.520" }, { text: "+1.5 1.591" }, { text: "Over 7.5 1.980" }, { text: "Under 7.5 1.909" },
  { text: "Milwaukee Brewers 3.810" }, { text: "Draw 1.694" }, { text: "Cleveland Guardians 4.500" }, // 3-way (регламент)
]);
const PINN_MLB_URL = "https://www.pinnacle888.com/en/standard/baseball/mlb/cleveland-guardians-vs-milwaukee-brewers/1631842611";

test("classifyDesc: «1 1-2 OT» (суффикс) → nodraw side 1", () => {
  const r = classifyDesc("1 1-2 OT");
  assert.strictEqual(r.kind, "win"); assert.strictEqual(r.side, "1"); assert.strictEqual(r.nodraw, true);
});

test("pickOutcome: «1 1-2 OT» @2.37 → Cleveland Guardians 2.370 (2-way мани-лайн, не 3-way 4.500)", () => {
  const r = pickOutcome({ desc: "1 1-2 OT", expectedOdds: 2.37, buttons: PINN_MLB_ML, subject: "Cleveland Guardians", eventUrl: PINN_MLB_URL });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.text, "Cleveland Guardians 2.370");
});

test("pickOutcome: nodraw тугой порог — соккерный 1X2 как DNB (кэф далёк) → null", () => {
  const buttons = withIndex([{ text: "Team A 1.40" }, { text: "X 3.50" }, { text: "Team B 5.00" }]);
  const r = pickOutcome({ desc: "1 1-2", expectedOdds: 1.25, buttons, subject: "Team A", eventUrl: "https://x/team-a-team-b/1/" });
  assert.strictEqual(r, null);
});

// ── КРОСС-ПРОВЕРКА ПЛЕЧ: оба на одну сторону = НЕ хедж (защита от бага «обе на одну команду») ──
const { sameSideSelected } = require("../lib/bookers.cjs");
test("sameSideSelected: обе на одну команду (реальный баг Angels) → true (не ставим)", () => {
  assert.strictEqual(sameSideSelected("Los Angeles Angels +1 2.10", "Los Angeles Angels 2.220"), true);
});
test("sameSideSelected: противоположные команды (настоящая вилка) → false (ставим)", () => {
  assert.strictEqual(sameSideSelected("Los Angeles Angels +1 2.10", "Athletics 1.757"), false);
});
test("sameSideSelected: тотал оба Over → true; Over↔Under → false", () => {
  assert.strictEqual(sameSideSelected("Over 8.5 1.95", "Over 8.5 2.02"), true);
  assert.strictEqual(sameSideSelected("Under 3.5 1.27", "Over 3.5 3.85"), false);
});
test("sameSideSelected: сокращение имени (LA Angels ⊂ Los Angeles Angels) → true", () => {
  assert.strictEqual(sameSideSelected("LA Angels 2.10", "Los Angeles Angels 2.22"), true);
});
test("pickOutcome: DNB без подтверждения именем (нет subject/URL) → null (не угадываем по кэфу)", () => {
  const buttons = withIndex([{ text: "Team A 2.10" }, { text: "Team B 1.80" }]);
  assert.strictEqual(pickOutcome({ desc: "1 1-2", expectedOdds: 2.10, buttons }), null);
});

test("sameSideSelected: индивидуальный тотал ОДНОЙ команды Over↔Under → false (разрешаем — это валидный хедж)", () => {
  assert.strictEqual(sameSideSelected("San Francisco Giants Over 4.5 1.95", "San Francisco Giants Under 4.5 2.05"), false);
  assert.strictEqual(sameSideSelected("Giants Over 4.5", "Giants Over 4.5"), true); // оба Over = не хедж → блок
});

test("Betano фора-сеты: сторона A (team1) — НЕ берём фору ОППОНЕНТА, даже если в пуле есть счёт (баг 0.10.9)", () => {
  const URL = "https://www.betano.bg/en/match-odds/calvin-hemery-marvin-moeller/12345678/"; // player1 = Calvin
  // Только фора оппонента (Marvin -1.5), нашей −1.5 нет → ОТКАЗ, а не Marvin −1.5
  const only = withIndex([
    { text: "Calvin Hemery 1.87" }, { text: "Marvin Moeller 1.90" },
    { text: "Marvin Moeller -1.5 2.47" }, { text: "Calvin Hemery +1.5 1.53" },
  ]);
  assert.strictEqual(pickOutcome({ desc: "AH1(-1.5)", expectedOdds: 2.92, buttons: only, eventUrl: URL, unit: "set", subject: "Calvin Hemery" }), null);
  // Есть счёт «2 - 0» (Calvin 2:0 = Calvin −1.5 сеты) → берём СЧЁТ нашей стороны, не Marvin −1.5
  const withScore = withIndex([
    { text: "Calvin Hemery 1.87" }, { text: "Marvin Moeller 1.90" },
    { text: "Marvin Moeller -1.5 2.47" }, { text: "2 - 0 2.90" }, { text: "0 - 2 4.10" },
  ]);
  const r = pickOutcome({ desc: "AH1(-1.5)", expectedOdds: 2.92, buttons: withScore, eventUrl: URL, unit: "set", subject: "Calvin Hemery" });
  assert.ok(r && /2\s*-\s*0/.test(r.text), "должен выбрать счёт 2-0, а не Marvin -1.5; выбрал: " + (r && r.text));
});

test("Betano гейм-фора БЕЗ имени: явный фаворит → берём «-X» его стороны; неявный фаворит → отказ", () => {
  const URL = "https://www.betano.bg/en/match-odds/vladyslav-orlov-stefan-popovic/999/"; // player1 = Orlov
  // Явный фаворит Orlov (1.26 vs 3.35): наш AH1(-3.5) сторона 1 = Orlov → берём «-3.5»
  const clear = withIndex([
    { text: "Vladyslav Orlov 1.26" }, { text: "Stefan Popovic 3.35" },
    { text: "-3.5 1.55" }, { text: "+3.5 2.05" },
  ]);
  const r = pickOutcome({ desc: "AH1(-3.5)", expectedOdds: 1.55, buttons: clear, eventUrl: URL, unit: "game", subject: "Vladyslav Orlov" });
  assert.ok(r && /-3\.5/.test(r.text), "должен взять -3.5 фаворита; взял: " + (r && r.text));
  assert.equal(r.how, "fav"); // помечено как безымянная-фора по фавориту (для отдельной статы в логах)
  // Близкий матч (1.85 vs 1.95) → фаворит НЕ явный → отказ (не гадаем сторону)
  const close = withIndex([
    { text: "Vladyslav Orlov 1.85" }, { text: "Stefan Popovic 1.95" },
    { text: "-3.5 1.55" }, { text: "+3.5 2.05" },
  ]);
  assert.strictEqual(pickOutcome({ desc: "AH1(-3.5)", expectedOdds: 1.55, buttons: close, eventUrl: URL, unit: "game", subject: "Vladyslav Orlov" }), null);
});

test("Betano гейм-фора БЕЗ имени: фаворит по МАНИ-ЛАЙНУ, не по min всех кнопок (баг Leo −6.5)", () => {
  const URL = "https://www.betano.bg/en/match-odds/leo-raquillet-tomohiro-masabayashi/999/"; // player1 = Leo
  // У КАЖДОГО игрока несколько именованных кнопок: мани-лайн ПЕРВЫМ (Leo 1.33 / Tomohiro 2.72), затем сет-форы
  // (Leo 1.08 — его же +фора, Tomohiro 1.55 — его хендикап). Старый min брал «оппонента» = 1.08/1.55 → фаворит
  // не явный → отказ. Новая логика сравнивает мани-лайн (1.33 vs 2.72) → Leo явный фаворит → берём «-6.5».
  const btns = withIndex([
    { text: "Leo Raquillet 1.33" }, { text: "Tomohiro Masabayashi 2.72" }, // мани-лайн
    { text: "Leo Raquillet 1.08" }, { text: "Tomohiro Masabayashi 6.10" }, // сет-фора +1.5
    { text: "Leo Raquillet 2.25" }, { text: "Tomohiro Masabayashi 1.55" }, // сет-фора −1.5
    { text: "-6.5 1.82" }, { text: "+6.5 1.85" },                           // гейм-фора БЕЗ имени
  ]);
  const r = pickOutcome({ desc: "AH1(-6.5)", expectedOdds: 1.82, buttons: btns, eventUrl: URL, unit: "game", subject: "Leo Raquillet" });
  assert.ok(r && /-6\.5/.test(r.text), "должен взять -6.5 фаворита Leo; взял: " + (r && r.text));
  assert.equal(r.how, "fav");
});

test("Тотал: экспресс «X and Over/Under N» НЕ путается с чистым тоталом (мисселект из лога)", () => {
  const btns = withIndex([
    { text: "Over 18.5 1.20" },                    // чистый матчевый тотал
    { text: "Ivan Ivanov and Over 18.5 1.10" },    // ЭКСПРЕСС (парлей) — не брать
  ]);
  const r = pickOutcome({ desc: "Over 18.5", expectedOdds: 1.2, buttons: btns });
  assert.ok(r && /^Over 18\.5 1\.20/.test(r.text), "должен взять чистый тотал, не экспресс; взял: " + (r && r.text));
  // на странице ТОЛЬКО экспресс → отказ (лучше пропустить, чем поставить парлей)
  assert.strictEqual(pickOutcome({ desc: "Over 18.5", expectedOdds: 1.2, buttons: withIndex([{ text: "Ivan Ivanov and Over 18.5 1.10" }]) }), null);
});

test("ML: агрегат «N+» (25+/35+) НЕ выбирается как победитель (мисселект из лога)", () => {
  const URL = "https://www.betano.bg/en/match-odds/felix-auger-aliassime-alejandro-davidovich-fokina/999/"; // player1 = Felix
  const btns = withIndex([
    { text: "Felix Auger Aliassime 1.90" },        // победитель 1
    { text: "Alejandro Davidovich Fokina 2.32" },  // победитель 2 (наш side)
    { text: "25+ 2.27" },                          // агрегат тотала — НЕ победитель
  ]);
  const r = pickOutcome({ desc: "2", expectedOdds: 2.32, buttons: btns, eventUrl: URL, subject: "Alejandro Davidovich Fokina" });
  assert.ok(r && /Alejandro/.test(r.text), "должен взять Alejandro (side 2), не «25+»; взял: " + (r && r.text));
});

// ── ПРЯМОЙ id Betano (data-selnid == id исхода из фида; связка доказана боевым замером 0.10.25) ──
test("selnid: кликаем РОВНО кнопку с нашим id — даже если по кэфу «ближе» другая", () => {
  const btns = [
    { i: 0, id: "", selnid: "9950561590", text: "Alice Tubello 2.02" },          // Game Winner — кэфточь-в-точь
    { i: 1, id: "", selnid: "9950561592", text: "Alice Tubello 2.10" },          // НАШ id (Winner матча)
    { i: 2, id: "", selnid: "9950561593", text: "Yufei Ren 1.75" },
  ];
  const r = pickOutcome({ desc: "1", expectedOdds: 2.02, buttons: btns, selnid: "9950561592" });
  assert.ok(r, "должен найти по id");
  assert.strictEqual(r.i, 1);                    // взял кнопку по id, а не «ближайший кэф» (i=0)
  assert.strictEqual(r.how, "selnid");
});
test("selnid: id есть, кнопки нет → null (исход снят; текстовый фолбэк НЕ делаем — он и давал мис-селекты)", () => {
  const btns = [
    { i: 0, id: "", selnid: "111", text: "Alice Tubello 2.02" },
    { i: 1, id: "", selnid: "222", text: "Yufei Ren 1.75" },
  ];
  assert.strictEqual(pickOutcome({ desc: "1", expectedOdds: 2.02, buttons: btns, selnid: "999" }), null);
});
test("selnid НЕ передан → старое поведение (текстовый матчинг работает как раньше)", () => {
  const r = pickOutcome({ desc: "Ф2(-1.5)", expectedOdds: 1.82, buttons: BET, eventUrl: SLUG_T });
  assert.strictEqual(r.text, "Nick Kyrgios -1.5 1.82");
});

test("ML: гейм-проп «to win to N» НЕ выбирается как победитель (мисселект Palosi из лога)", () => {
  const URL = "https://www.betano.bg/en/match-odds/stefan-palosi-zdenek-kolar/999/"; // player1 = Stefan Palosi
  // есть чистый победитель И гейм-проп, у пропа кэф БЛИЖЕ к ожидаемому — всё равно берём чистого победителя
  const btns = withIndex([
    { text: "Stefan Palosi 2.40" },               // победитель 1 (наш) — кэф чуть дальше от 2.35
    { text: "Zdenek Kolar 1.55" },                // победитель 2
    { text: "Stefan Palosi to win to 15 2.32" },  // гейм-проп (выиграть гейм всухую) — кэф ближе, но НЕ победа
  ]);
  const r = pickOutcome({ desc: "1", expectedOdds: 2.35, buttons: btns, eventUrl: URL, subject: "Stefan Palosi" });
  assert.ok(r && r.text === "Stefan Palosi 2.40", "должен взять чистого победителя, не «to win to»; взял: " + (r && r.text));
  // только проп нашей стороны (плоского победителя нет) → отказ, НЕ проп
  const onlyProp = withIndex([{ text: "Zdenek Kolar 1.55" }, { text: "Stefan Palosi to win to 15 2.32" }]);
  assert.strictEqual(pickOutcome({ desc: "1", expectedOdds: 2.35, buttons: onlyProp, eventUrl: URL, subject: "Stefan Palosi" }), null);
});

test("ML: голый токен «3» НЕ обыгрывает именованного победителя по кэфу (мисселект «3 1.95»)", () => {
  const URL = "https://www.betano.bg/en/match-odds/andres-martin-jason-jung/999/"; // player1 = Andres
  const btns = withIndex([
    { text: "Andres Martin 1.90" },   // победитель 1 (наш) — кэф ЧУТЬ дальше от 1.93
    { text: "Jason Jung 1.88" },      // победитель 2
    { text: "3 1.95" },               // мусор: не победитель, но кэф БЛИЖЕ к 1.93 → старый код брал его
  ]);
  const r = pickOutcome({ desc: "1", expectedOdds: 1.93, buttons: btns, eventUrl: URL, subject: "Andres Martin" });
  assert.ok(r && /Andres/.test(r.text), "должен взять Andres Martin, не «3»; взял: " + (r && r.text));
  assert.equal(r.how, "name");
});
