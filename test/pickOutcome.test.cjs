"use strict";
// Тест выбора исхода Pinnacle на РЕАЛЬНЫХ кнопках со страницы события
// (снято кнопкой «Снять разметку купона»: ATP Stuttgart, Shimabukuro–Kyrgios).
const test = require("node:test");
const assert = require("node:assert");
const { pickPinnacleOutcome } = require("../lib/bookers.cjs");

// Реальные кнопки исходов с id и текстом (eventId|период|тип|…|линия).
const BUTTONS = [
  { id: "1631805342|0|2|0|0|+1.5", text: "+1.5 1.543" },
  { id: "1631805342|0|2|1|0|-1.5", text: "-1.5 2.560" },
  { id: "1631805342|0|2|0|1|-1.5", text: "-1.5 3.640" },
  { id: "1631805342|0|2|1|1|+1.5", text: "+1.5 1.308" },
  { id: "1631805342|0|3|3|0|2.5", text: "Over 2.5 Sets 2.550" },
  { id: "1631805342|0|3|4|0|2.5", text: "Under 2.5 Sets 1.546" },
  { id: "1631805342|0|1|0|0|0", text: "Sho Shimabukuro 2.230" },
  { id: "1631805342|0|1|1|0|0", text: "Nick Kyrgios 1.709" },
  // навигация — должна отсеяться (нет «|», нет кэфа)
  { id: "all", text: "ALL" },
  { id: "0", text: "MATCH" },
];

test("фора Ф1(+1.5) @1.543 → именно кнопка Shimabukuro +1.5 (а не Kyrgios +1.5)", () => {
  const r = pickPinnacleOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.543, buttons: BUTTONS });
  assert.ok(r, "должен найти исход");
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5");
  assert.strictEqual(r.odds, 1.543);
  assert.strictEqual(r.how, "desc");
});

test("фора Ф2(-1.5) @2.560 → -1.5 2.560", () => {
  const r = pickPinnacleOutcome({ desc: "Ф2(-1.5)", expectedOdds: 2.56, buttons: BUTTONS });
  assert.strictEqual(r.id, "1631805342|0|2|1|0|-1.5");
});

test("тотал меньше Тм(2.5) @1.546 → Under 2.5", () => {
  const r = pickPinnacleOutcome({ desc: "Тм(2.5)", expectedOdds: 1.546, buttons: BUTTONS });
  assert.strictEqual(r.id, "1631805342|0|3|4|0|2.5");
  assert.match(r.text, /Under/);
});

test("тотал больше Тб(2.5) @2.550 → Over 2.5", () => {
  const r = pickPinnacleOutcome({ desc: "Тб(2.5)", expectedOdds: 2.55, buttons: BUTTONS });
  assert.strictEqual(r.id, "1631805342|0|3|3|0|2.5");
  assert.match(r.text, /Over/);
});

test("победа П1 @2.230 → Shimabukuro (по ближайшему кэфу)", () => {
  const r = pickPinnacleOutcome({ desc: "П1", expectedOdds: 2.23, buttons: BUTTONS });
  assert.strictEqual(r.id, "1631805342|0|1|0|0|0");
});

test("победа П2 @1.709 → Kyrgios", () => {
  const r = pickPinnacleOutcome({ desc: "П2", expectedOdds: 1.709, buttons: BUTTONS });
  assert.strictEqual(r.id, "1631805342|0|1|1|0|0");
});

test("если кэф уехал — берём ближайшую кнопку той же форы (+1.5)", () => {
  // ждали 1.543, на странице по +1.5 есть 1.543 и 1.308 → ближе 1.50
  const r = pickPinnacleOutcome({ desc: "Ф1(+1.5)", expectedOdds: 1.50, buttons: BUTTONS });
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5"); // 1.543 ближе к 1.50, чем 1.308
});

test("точный путь по id из вилки (бренд с pinnacleBrExternalId)", () => {
  // другой eventId-префикс, но «хвост» совпадает
  const r = pickPinnacleOutcome({ desc: "", expectedOdds: 0, outcomeId: "999999|0|2|0|0|+1.5", buttons: BUTTONS });
  assert.strictEqual(r.id, "1631805342|0|2|0|0|+1.5");
  assert.strictEqual(r.how, "id");
});

test("навигационные кнопки (ALL/MATCH) не выбираются", () => {
  const r = pickPinnacleOutcome({ desc: "П1", expectedOdds: 2.23, buttons: BUTTONS });
  assert.ok(String(r.id).includes("|"));
});
