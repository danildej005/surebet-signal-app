"use strict";
// Тесты движка value (де-виг + value%). Реальные кэфы Pinnacle 1X2 взяты из живого ответа oddspapi
// (матч Jordan–Argentina): home 18.17 / draw 3.34 / away 1.438.
const test = require("node:test");
const assert = require("node:assert");
const { margin, devigProportional, devigPower, valuePct, evaluate, findValue } = require("../lib/value.cjs");

const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

test("margin: ровный рынок 0%, маржа считается", () => {
  assert.ok(near(margin([2.0, 2.0]), 0));
  assert.ok(near(margin([1.9, 1.9]), 0.052631, 1e-5)); // 2/1.9 - 1
});

test("devigProportional: симметрия [2,2] → [0.5,0.5]", () => {
  const p = devigProportional([2.0, 2.0]);
  assert.ok(near(p[0], 0.5) && near(p[1], 0.5));
});

test("devigProportional: реальный 1X2 → честная вер-ть away 66.24%, честный кэф 1.510", () => {
  const p = devigProportional([18.17, 3.34, 1.438]); // [home, draw, away]
  assert.ok(near(p.reduce((a, b) => a + b, 0), 1.0), "сумма вероятностей = 1");
  assert.ok(near(p[2], 0.6624), "away prob");
  assert.ok(near(1 / p[2], 1.5097, 1e-3), "away честный кэф");
});

test("devigPower: вероятности нормируются на 1; симметрия даёт [0.5,0.5]", () => {
  const ps = devigPower([1.9, 1.9]);
  assert.ok(near(ps[0], 0.5) && near(ps[1], 0.5));
  const p = devigPower([18.17, 3.34, 1.438]);
  assert.ok(near(p.reduce((a, b) => a + b, 0), 1.0, 1e-3), "сумма = 1");
  assert.ok(p.every((x) => x > 0 && x < 1));
});

test("devigPower ≠ proportional на скошенном рынке (ловит перекос маржи)", () => {
  const a = devigProportional([18.17, 3.34, 1.438]);
  const b = devigPower([18.17, 3.34, 1.438]);
  // методы дают РАЗНЫЕ честные вероятности фаворита — иначе степенной не нужен
  assert.ok(Math.abs(a[2] - b[2]) > 1e-3, "favorite prob отличается между методами");
});

test("valuePct: кэф выше честного → плюс, ниже → минус", () => {
  // away честная вер-ть ~0.6624; Betano 1.5 → минус, 1.6 → плюс
  assert.ok(near(valuePct(1.5, 0.6624), -0.0064, 1e-3));
  assert.ok(valuePct(1.6, 0.6624) > 0);
  assert.strictEqual(valuePct(0, 0.5), -1); // битый кэф
});

test("evaluate: полная оценка исхода (away, Betano 1.5) — реальный кейс, value ≈ −0.6%", () => {
  const r = evaluate({ pinnacleOdds: [18.17, 3.34, 1.438], index: 2, bookOdds: 1.5 });
  assert.ok(near(r.margin, 0.04985, 1e-4), "маржа Pinnacle ~4.98%");
  assert.ok(near(r.fairProb, 0.6624), "честная вер-ть");
  assert.ok(near(r.fairOdds, 1.5097, 1e-3), "честный кэф");
  assert.ok(near(r.valuePct, -0.0064, 1e-3), "value%");
});

test("evaluate: тот же исход, но кэф конторы 1.65 → value положительный (ставим)", () => {
  const r = evaluate({ pinnacleOdds: [18.17, 3.34, 1.438], index: 2, bookOdds: 1.65 });
  assert.ok(r.valuePct > 0.09 && r.valuePct < 0.11, "≈ +9.3%");
});

// ── findValue: джойн рынков по нормализованным id + де-виг + порог (реальный 1X2 Jordan–Argentina) ──
const PIN = { "101": { "101": 19.0, "102": 9.0, "103": 1.153 } }; // home/draw/away Pinnacle
const BET = { "101": { "101": 20.0, "102": 7.5, "103": 1.16 } };  // home/draw/away Betano

test("findValue: ловит value на home (Betano 20.0 vs честный ~19.6) ≥ порога", () => {
  const r = findValue(PIN, BET, { threshold: 0.02 });
  assert.strictEqual(r.length, 1, "только home проходит порог");
  assert.strictEqual(r[0].outcomeId, "101");
  assert.ok(r[0].valuePct > 0.02 && r[0].valuePct < 0.03, "≈ +2.1%");
  assert.ok(Math.abs(r[0].fairOdds - 19.59) < 0.3, "честный кэф home ~19.6");
});

test("findValue: высокий порог → пусто (на топ-матче value мало — норма)", () => {
  assert.strictEqual(findValue(PIN, BET, { threshold: 0.05 }).length, 0);
});

test("findValue: рынок есть у конторы, но нет у Pinnacle → пропуск (нет эталона)", () => {
  const r = findValue({}, BET, { threshold: 0.0 });
  assert.strictEqual(r.length, 0);
});

test("findValue: рынок с одним исходом → пропуск (де-виг невозможен)", () => {
  const r = findValue({ "9": { "1": 1.5 } }, { "9": { "1": 5.0 } }, { threshold: 0.0 });
  assert.strictEqual(r.length, 0);
});
