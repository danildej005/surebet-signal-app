"use strict";
// Тесты переводчика oddspapi → desc для pickOutcome. meta — как записи каталога /v4/markets.
const test = require("node:test");
const assert = require("node:assert");
const { toDesc } = require("../lib/oddsmap.cjs");

const m = (marketType, outcomes, extra = {}) => ({ marketType, period: "fulltime", outcomes, ...extra });
const O = (id, nm) => ({ outcomeId: id, outcomeName: nm });

test("1x2 → П1/X/П2 с именами команд", () => {
  const meta = m("1x2", [O(101, "1"), O(102, "X"), O(103, "2")]);
  assert.deepStrictEqual(toDesc(meta, 101, "Real", "Barca"), { desc: "П1", subject: "Real" });
  assert.deepStrictEqual(toDesc(meta, 102, "Real", "Barca"), { desc: "X", subject: "" });
  assert.deepStrictEqual(toDesc(meta, 103, "Real", "Barca"), { desc: "П2", subject: "Barca" });
});

test("totals → Тб/Тм с линией из handicap", () => {
  const meta = m("totals", [O(106, "Over"), O(107, "Under")], { handicap: 2.5 });
  assert.deepStrictEqual(toDesc(meta, 106), { desc: "Тб(2.5)", subject: "" });
  assert.deepStrictEqual(toDesc(meta, 107), { desc: "Тм(2.5)", subject: "" });
});

test("spreads (азиат. фора) → Ф1(линия) и Ф2(противоположный знак)", () => {
  const meta = m("spreads", [O(1024, "1"), O(1025, "2")], { handicap: -1.5 });
  assert.deepStrictEqual(toDesc(meta, 1024, "Yankees", "RedSox"), { desc: "Ф1(-1.5)", subject: "Yankees" });
  assert.deepStrictEqual(toDesc(meta, 1025, "Yankees", "RedSox"), { desc: "Ф2(+1.5)", subject: "RedSox" });
});

test("moneyline (2-исходный) → П1/П2", () => {
  const meta = m("moneyline", [O(10728, "1"), O(10729, "2")]);
  assert.deepStrictEqual(toDesc(meta, 10729, "A", "B"), { desc: "П2", subject: "B" });
});

test("drawnobet → 1 1-2 / 2 1-2 (DNB по имени)", () => {
  const meta = m("drawnobet", [O(10214, "1"), O(10215, "2")]);
  assert.deepStrictEqual(toDesc(meta, 10215, "A", "B"), { desc: "2 1-2", subject: "B" });
});

test("doublechance: 2X → X2 (наш формат)", () => {
  const meta = m("doublechance", [O(1, "1X"), O(2, "12"), O(3, "2X")]);
  assert.deepStrictEqual(toDesc(meta, 3), { desc: "X2", subject: "" });
});

test("саб-период (period=p1) → null (не ставим)", () => {
  const meta = m("totals", [O(10256, "Over"), O(10257, "Under")], { handicap: 0.5, period: "p1" });
  assert.strictEqual(toDesc(meta, 10256), null);
});

test("неподдержанный рынок (btts) → null", () => {
  const meta = m("bothteamsscore", [O(104, "Yes"), O(105, "No")]);
  assert.strictEqual(toDesc(meta, 104), null);
});

test("несуществующий исход → null", () => {
  const meta = m("1x2", [O(101, "1"), O(102, "X"), O(103, "2")]);
  assert.strictEqual(toDesc(meta, 999), null);
});
