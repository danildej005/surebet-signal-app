"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bookerForUrl, resolveSurebetNav, buildProxyString, defaultBookers, buildFingerprintScript, randomFingerprint } = require("../lib/bookers.cjs");

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

// Регресс: surebet шлёт плечо Pinnacle под брендом ps3838 (а не pinnaclesports).
// Раньше ps3838 не сопоставлялся → booker=null → запасной путь открывал НЕ ту контору
// (по слову «betano» в URL, где лежат оба плеча) → логин surebet. Должно мапиться в pinnacle.
test("surebet-nav: плечо Pinnacle под брендом ps3838 → профиль pinnacle", () => {
  const jb = JSON.stringify({
    prongs: [
      JSON.stringify({ bk: "ps3838", markers: { link: "https://www.pinnacle888.com/en/standard/basketball/x/123/#all" } }),
      JSON.stringify({ bk: "betanopt", bookie_nav: { links: [{ link: { url: "https://www.betano.pt" } }] } }),
    ],
  });
  const url = `https://su.surebet.com/nav/surebet/prong/0/HASH/if?json_body=${encodeURIComponent(jb)}`;
  const r = resolveSurebetNav(url, bookers);
  assert.equal(r.booker.id, "pinnacle");
  assert.match(r.targetUrl, /pinnacle888\.com\/en\/standard\/basketball\/x\/123/);
});

test("buildProxyString: структурный прокси → строка для parseProxy", () => {
  assert.equal(buildProxyString({ protocol: "socks5", host: "1.2.3.4", port: "1080", user: "u", pass: "p" }), "socks5://1.2.3.4:1080:u:p");
  assert.equal(buildProxyString({ protocol: "http", host: "1.2.3.4", port: "8080", user: "", pass: "" }), "http://1.2.3.4:8080");
  assert.equal(buildProxyString({ protocol: "", host: "1.2.3.4", port: "8080" }), ""); // нет протокола → без прокси
  assert.equal(buildProxyString("socks5://x:1:u:p"), "socks5://x:1:u:p"); // старый строковый формат
  assert.equal(buildProxyString(null), "");
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
  assert.ok(d.find((b) => b.id === "betano").url.includes("betano.bg")); // value-режим: ставим на Betano BG
  assert.ok(!d.find((b) => b.id === "pinnacle")); // Pinnacle убран — кэфы берём из API (oddspapi/ps3838)
  // скрипт отпечатка компилируется
  require("node:vm").compileFunction(buildFingerprintScript(randomFingerprint()));
});
