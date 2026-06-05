"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isWanted, receiverLegs, pickWanted } = require("../lib/filter.cjs");
const { formatSignal } = require("../lib/format.cjs");
const { makeDeduper } = require("../lib/dedupe.cjs");

const withPin = { id: "1", event: "A — B", profitPct: 1.2, legs: [
  { book: "Pinnacle888 (Asian)", odds: 1.45, outcome: "W1" },
  { book: "Betano (PT)", odds: 3.1, outcome: "W2" },
] };
const noPin = { id: "2", event: "C — D", profitPct: 0.8, legs: [
  { book: "Betano (PT)", odds: 2.0 }, { book: "Bet365", odds: 2.05 },
] };

test("filter: Pinnacle есть/нет", () => {
  assert.equal(isWanted(withPin, "pinnacle"), true);
  assert.equal(isWanted(noPin, "pinnacle"), false);
  assert.equal(receiverLegs(withPin, "pinnacle").length, 1);
  assert.deepEqual(pickWanted([withPin, noPin], "pinnacle").map((s) => s.id), ["1"]);
});

test("format: событие, кф, доход, ставка", () => {
  const t = formatSignal(withPin, "pinnacle");
  assert.match(t, /A — B/);
  assert.match(t, /1\.450/);
  assert.match(t, /\+1\.20%/);
  assert.match(t, /Pinnacle888 \(Asian\)/);
  assert.match(t, /W1/);
});

test("format: отрицательный доход со знаком минус", () => {
  assert.match(formatSignal({ ...withPin, profitPct: -2.5 }, "pinnacle"), /−2\.50%/);
});

test("dedupe: ttl", () => {
  let now = 1000;
  const d = makeDeduper({ ttlMs: 500, now: () => now });
  assert.equal(d.shouldSend("a"), true);
  d.markSent("a");
  assert.equal(d.shouldSend("a"), false);
  now = 1600;
  assert.equal(d.shouldSend("a"), true);
});
