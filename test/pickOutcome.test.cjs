"use strict";
// Тест выбора исхода на РЕАЛЬНЫХ кнопках со страниц событий (снято «Снять купон»).
// Pinnacle: ATP Stuttgart, Shimabukuro–Kyrgios. Betano: тот же матч.
const test = require("node:test");
const assert = require("node:assert");
const { pickOutcome } = require("../lib/bookers.cjs");

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
