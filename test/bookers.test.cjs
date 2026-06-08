"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bookerForUrl, defaultBookers, buildFingerprintScript, randomFingerprint } = require("../lib/bookers.cjs");

const bookers = [
  { id: "betano", name: "Betano", url: "https://www.betano.pt/" },
  { id: "pinnacle", name: "Pinnacle", url: "https://www.pinnacle888.com/" },
];

test("распознаёт betano по ссылке", () => {
  assert.equal(bookerForUrl("https://www.betano.pt/pt/sport/futebol/123", bookers).id, "betano");
});

test("распознаёт pinnacle по pinnacle888", () => {
  assert.equal(bookerForUrl("https://www.pinnacle888.com/en/soccer/55", bookers).id, "pinnacle");
});

test("распознаёт pinnacle по ps3838", () => {
  assert.equal(bookerForUrl("https://www.ps3838.com/en/event/9", bookers).id, "pinnacle");
});

test("распознаёт pinnacle по слову pinnacle", () => {
  assert.equal(bookerForUrl("https://m.pinnacle.com/x", bookers).id, "pinnacle");
});

test("неизвестная ссылка → null", () => {
  assert.equal(bookerForUrl("https://www.bet365.com/x", bookers), null);
  assert.equal(bookerForUrl("", bookers), null);
});

test("дефолтные конторы и отпечаток валидны", () => {
  const d = defaultBookers();
  assert.ok(d.find((b) => b.id === "pinnacle").url.includes("pinnacle888"));
  // скрипт отпечатка компилируется
  require("node:vm").compileFunction(buildFingerprintScript(randomFingerprint()));
});
