"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bookerForUrl, resolveSurebetNav, defaultBookers, buildFingerprintScript, randomFingerprint } = require("../lib/bookers.cjs");

const bookers = [
  { id: "betano", name: "Betano", url: "https://www.betano.pt/" },
  { id: "pinnacle", name: "Pinnacle", url: "https://www.pinnacle888.com/" },
];

// Ссылка плеча surebet: prongs[0]=pinnacle (с глубокой ссылкой), prongs[1]=betano (только главная)
function navUrl(prongIdx) {
  const jb = JSON.stringify({
    prongs: [
      JSON.stringify({ bk: "pinnaclesports", markers: { link: "https://www.pinnacle888.com/en/standard/tennis/x/1631755699/#all" }, bookie_nav: { links: [{ link: { url: "https://www.pinnacle888.com/" } }] } }),
      JSON.stringify({ bk: "betanopt", markers: { eventId: "86985456" }, bookie_nav: { links: [{ link: { url: "https://www.betano.pt" } }] } }),
    ],
    profit: -2.24,
  });
  return `https://su.surebet.com/nav/surebet/prong/${prongIdx}/HASH/if?odd_format=eu&json_body=${encodeURIComponent(jb)}`;
}

test("surebet-nav prong/0 → pinnacle + глубокая ссылка на событие", () => {
  const r = resolveSurebetNav(navUrl(0), bookers);
  assert.equal(r.booker.id, "pinnacle");
  assert.match(r.targetUrl, /pinnacle888\.com\/en\/standard\/tennis\/x\/1631755699/);
});

test("surebet-nav prong/1 → betano + главная (глубокой нет)", () => {
  const r = resolveSurebetNav(navUrl(1), bookers);
  assert.equal(r.booker.id, "betano");
  assert.equal(r.targetUrl, "https://www.betano.pt");
});

test("не surebet-nav ссылка → null", () => {
  assert.equal(resolveSurebetNav("https://www.betano.pt/event/1", bookers), null);
});

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
