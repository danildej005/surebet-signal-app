"use strict";
// Тесты парсера ps3838 (odds → честные вероятности) на форме реального ответа /v3/odds.
const test = require("node:test");
const assert = require("node:assert");
const { fairByEvent } = require("../lib/ps3838.cjs");

const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;

const OD = { leagues: [{ id: 1, events: [{ id: 999, periods: [
  { number: 1, moneyline: { home: 2, away: 2 } }, // саб-период (1-й тайм) — игнорируем
  { number: 0,
    moneyline: { home: 1.5, away: 2.5 },                       // бейсбол: 2-way
    totals: [{ points: 8.5, over: 1.9, under: 2.0 }],
    spreads: [{ hdp: -1.5, home: 1.8, away: 2.1 }] },
]}]}]};

test("fairByEvent: берёт period.number=0, де-виг moneyline/totals/spreads", () => {
  const m = fairByEvent(OD);
  const f = m.get("999");
  assert.ok(f, "событие по строковому id");
  assert.ok(near(f.ml.home, 0.625) && near(f.ml.away, 0.375), "moneyline де-виг");
  assert.ok(near(f.tot["8.5"].over, 0.5132, 2e-3), "тотал over");
  assert.ok(near(f.ah["-1.5"].home, 0.5378, 2e-3), "фора home");
});

test("fairByEvent: 3-way moneyline (футбол) → сумма вероятностей 1", () => {
  const m = fairByEvent({ leagues: [{ events: [{ id: 7, periods: [{ number: 0, moneyline: { home: 2.0, draw: 3.4, away: 4.0 } }] }] }] });
  const f = m.get("7");
  assert.ok(near(f.ml.home + f.ml.draw + f.ml.away, 1.0));
  assert.ok(f.ml.draw > 0);
});

test("fairByEvent: нет period 0 → событие пропущено", () => {
  const m = fairByEvent({ leagues: [{ events: [{ id: 5, periods: [{ number: 1, moneyline: { home: 2, away: 2 } }] }] }] });
  assert.ok(near((m.get("5") && m.get("5").ml) ? 1 : 0, 0) || m.get("5").ml === null);
});
