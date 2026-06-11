"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { vilkaStakes, parseMoney } = require("../lib/vilka.cjs");

test("parseMoney: US и EU форматы, с валютой/мусором", () => {
  assert.strictEqual(parseMoney("Max bet USDT 10,035.00"), 10035);   // Pinnacle (US)
  assert.strictEqual(parseMoney("10.000,00 €"), 10000);              // Betano (EU)
  assert.strictEqual(parseMoney("10000"), 10000);
  assert.strictEqual(parseMoney("1,000"), 1000);                     // тысячи (US без копеек)
  assert.strictEqual(parseMoney("99,50"), 99.5);                     // EU копейки
  assert.strictEqual(parseMoney("1.234.567,89"), 1234567.89);
  assert.strictEqual(parseMoney(""), null);
  assert.strictEqual(parseMoney("—"), null);
});

test("упор в максимум конторы (без лимита панели): USD-плечо ограничивает", () => {
  const r = vilkaStakes({ oddsEur: 2.0, oddsUsd: 2.1, usdToEur: 0.92, maxEur: 500, maxUsd: 400 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bind, "usd");        // Pinnacle $400 — узкое место
  assert.strictEqual(r.usd, 400);
  assert.strictEqual(r.eur, 386.4);          // Betano пересчитан под него
  assert.ok(r.profitEur > 0);
  // возвраты по обоим исходам ~равны (с учётом курса)
  assert.ok(Math.abs(r.returnIfEur - r.returnIfUsd) < 0.5);
});

test("лимит панели режет сумму (вариант A — урезаем и пересчитываем)", () => {
  const r = vilkaStakes({ oddsEur: 2.0, oddsUsd: 2.1, usdToEur: 0.92, maxEur: 500, maxUsd: 400, limitEur: 200 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bind, "eur");         // лимит €200 на Betano-плече — узкое место
  assert.strictEqual(r.eur, 200);
  assert.ok(r.usd > 200 && r.usd < 220);     // ~$207 (200€ по кэфам)
  assert.ok(r.profitEur > 0);
});

test("равные кэфы и курс 1 — баланс пополам", () => {
  const r = vilkaStakes({ oddsEur: 2.0, oddsUsd: 2.0, usdToEur: 1, maxEur: 100, maxUsd: 100 });
  assert.strictEqual(r.eur, 100);
  assert.strictEqual(r.usd, 100);
  assert.strictEqual(r.bind, "eur");
});

test("не вилка (сумма обратных вероятностей > 1) → ok:false", () => {
  const r = vilkaStakes({ oddsEur: 1.5, oddsUsd: 1.5, usdToEur: 1, maxEur: 100, maxUsd: 100 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.profitEur < 0);
});

test("курс влияет на баланс", () => {
  const a = vilkaStakes({ oddsEur: 2.0, oddsUsd: 2.0, usdToEur: 1.0, maxEur: 1000, maxUsd: 100 });
  const b = vilkaStakes({ oddsEur: 2.0, oddsUsd: 2.0, usdToEur: 0.5, maxEur: 1000, maxUsd: 100 });
  // при курсе 0.5 USD-плечо «весит» меньше → EUR-сумма под него вдвое меньше
  assert.ok(b.eur < a.eur);
});

test("плохие входные → ok:false с ошибкой", () => {
  assert.strictEqual(vilkaStakes({ oddsEur: 1, oddsUsd: 2, usdToEur: 0.9 }).ok, false);
  assert.strictEqual(vilkaStakes({ oddsEur: 2, oddsUsd: 2, usdToEur: 0 }).ok, false);
});
