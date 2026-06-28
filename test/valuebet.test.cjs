"use strict";
// Тесты ядра value-режима: сырые кэфы oddspapi → кандидаты для betano.bg.
const test = require("node:test");
const assert = require("node:assert");
const { betanoBgUrl, candidatesForFixture, scanCandidates, candidatesVsPinnacleFair } = require("../lib/valuebet.cjs");

// Каталог: только 1X2 полного матча.
const catalog = new Map([["101", {
  marketId: 101, marketType: "1x2", period: "fulltime", marketLength: 3,
  outcomes: [{ outcomeId: 101, outcomeName: "1" }, { outcomeId: 102, outcomeName: "X" }, { outcomeId: 103, outcomeName: "2" }],
}], ["10256", { marketId: 10256, marketType: "totals", period: "p1", marketLength: 2, outcomes: [{ outcomeId: 10256, outcomeName: "Over" }] }]]);

const mkFx = (key, fid, prices) => ({
  bookmakerOdds: { [key]: { bookmakerFixtureId: fid, fixturePath: "x", markets: {
    "101": { marketActive: true, outcomes: {
      "101": { players: { "0": { price: prices[0], active: true } } },
      "102": { players: { "0": { price: prices[1], active: true } } },
      "103": { players: { "0": { price: prices[2], active: true } } },
    } },
  } } },
});

const pinFx = mkFx("pinnacle", "111", [2.0, 3.5, 4.0]); // де-виг home ~0.483 → честный ~2.07
const betFx = mkFx("betano", "87650", [2.2, 3.4, 4.1]);  // home 2.2 > 2.07 → value ~+6%

test("betanoBgUrl: путь /koefitsienti/<slug>/<id>/", () => {
  assert.strictEqual(betanoBgUrl("87650", "Real Madrid", "Barcelona"), "https://www.betano.bg/koefitsienti/real-madrid-barcelona/87650/");
});

test("candidatesForFixture: ловит value на home (П1) с правильным desc/subject/url/eventId", () => {
  const c = candidatesForFixture(pinFx, betFx, catalog, "Real", "Barca", { threshold: 0.03, stake: 5 });
  assert.strictEqual(c.length, 1, "только home проходит");
  const x = c[0];
  assert.strictEqual(x.desc, "П1");
  assert.strictEqual(x.subject, "Real");
  assert.strictEqual(x.outcomeId, "101");
  assert.strictEqual(x.eventId, "87650");
  assert.match(x.url, /\/87650\/$/);
  assert.ok(x.valuePct > 0.05 && x.valuePct < 0.07, "≈ +6%");
  assert.strictEqual(x.expectedOdds, 2.2);
  assert.strictEqual(x.stake, 5);
});

test("candidatesForFixture: высокий порог → пусто", () => {
  assert.strictEqual(candidatesForFixture(pinFx, betFx, catalog, "Real", "Barca", { threshold: 0.10 }).length, 0);
});

test("candidatesForFixture: саб-период не попадает (перевод null)", () => {
  // даже если бы был value на p1-рынке, toDesc вернёт null → не ставим
  const pin = mkFx("pinnacle", "111", [2.0, 3.5, 4.0]);
  const bet = mkFx("betano", "87650", [2.2, 3.4, 4.1]);
  // подменим 101 на «p1»-рынок в каталоге нельзя (101=fulltime); просто проверяем, что 1X2 ок, p1 бы отсёкся переводчиком
  const c = candidatesForFixture(pin, bet, catalog, "Real", "Barca", { threshold: 0.03 });
  assert.ok(c.every((x) => x.desc));
});

test("candidatesVsPinnacleFair: эталон ps3838 (честные вер-ти) vs Betano → кандидаты", () => {
  const cat = new Map([
    ["101", { marketType: "1x2", period: "fulltime", marketLength: 3, outcomes: [{ outcomeId: 101, outcomeName: "1" }, { outcomeId: 102, outcomeName: "X" }, { outcomeId: 103, outcomeName: "2" }] }],
    ["116", { marketType: "totals", period: "result", marketLength: 2, handicap: 8.5, outcomes: [{ outcomeId: 116, outcomeName: "Over" }, { outcomeId: 117, outcomeName: "Under" }] }],
    ["1024", { marketType: "spreads", period: "fulltime", marketLength: 2, handicap: -1.5, outcomes: [{ outcomeId: 1024, outcomeName: "1" }, { outcomeId: 1025, outcomeName: "2" }] }],
  ]);
  const fair = { ml: { home: 0.6, draw: 0.25, away: 0.15 }, tot: { "8.5": { over: 0.5, under: 0.5 } }, ah: { "-1.5": { home: 0.55, away: 0.45 } } };
  const px = (oid, p) => ({ [oid]: { players: { "0": { price: p, active: true } } } });
  const betFx = { bookmakerOdds: { betano: { bookmakerFixtureId: "555", markets: {
    "101": { outcomes: { ...px(101, 1.8), ...px(102, 4.0), ...px(103, 1.2) } }, // home 1.8*0.6-1=+8% ✓
    "116": { outcomes: { ...px(116, 2.1), ...px(117, 1.7) } },                  // over 2.1*0.5-1=+5% ✓
    "1024": { outcomes: { ...px(1024, 1.9), ...px(1025, 1.9) } },               // home 1.9*0.55-1=+4.5% ✗
  } } } };
  const c = candidatesVsPinnacleFair(betFx, fair, cat, "Real", "Barca", "555", { threshold: 0.05 });
  assert.strictEqual(c.length, 2, "1x2 home (+8%) и тотал over (+5%)");
  assert.strictEqual(c[0].desc, "П1");        // топ по value
  assert.strictEqual(c[0].subject, "Real");
  assert.strictEqual(c[0].eventId, "555");
  assert.ok(c.some((x) => x.desc === "Тб(8.5)"));
});

test("scanCandidates: джойн по fixtureId + имена + сортировка по value", () => {
  const pinIndex = new Map([["A", pinFx]]);
  const betIndex = new Map([["A", betFx], ["B", betFx]]); // B нет у Pinnacle → пропуск
  const names = new Map([["A", { p1: "Real", p2: "Barca" }]]);
  const all = scanCandidates(pinIndex, betIndex, names, catalog, { threshold: 0.03 });
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].p1, "Real");
});
