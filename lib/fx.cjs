"use strict";
// Авто-курс USD→EUR (сколько EUR за 1 USD) для калькулятора вилки.
// Тянем из интернета (ECB через frankfurter + запасной er-api), кэшируем, при сбое — фолбэк.
const https = require("node:https");

const TTL_MS = 6 * 60 * 60 * 1000; // обновляем не чаще раза в 6ч
const FALLBACK = 0.92;             // если сеть недоступна и кэша нет
const SOURCES = [
  "https://api.frankfurter.app/latest?from=USD&to=EUR",
  "https://open.er-api.com/v6/latest/USD",
];

let cache = { rate: null, at: 0 };

// Разбор ответа: и frankfurter, и er-api кладут курс в rates.EUR (база USD).
function parseRate(body) {
  try {
    const d = typeof body === "string" ? JSON.parse(body) : body;
    const r = d && d.rates && Number(d.rates.EUR);
    return r > 0 && r < 10 ? r : null;
  } catch { return null; }
}

function httpGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let req;
    try { req = https.get(url, { headers: { "User-Agent": "surebet-signal" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve(body));
    }); } catch { return resolve(null); }
    req.on("error", () => resolve(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* ignore */ } resolve(null); });
  });
}

// Вернёт { rate, source, at, stale? }. Использует кэш; при сбое сети — старый кэш или фолбэк.
async function fetchUsdToEur({ force = false } = {}) {
  if (!force && cache.rate && Date.now() - cache.at < TTL_MS) {
    return { rate: cache.rate, source: "cache", at: cache.at };
  }
  for (const url of SOURCES) {
    const r = parseRate(await httpGetJson(url));
    if (r) { cache = { rate: r, at: Date.now() }; return { rate: r, source: url, at: cache.at }; }
  }
  if (cache.rate) return { rate: cache.rate, source: "stale-cache", at: cache.at, stale: true };
  return { rate: FALLBACK, source: "fallback", at: 0, stale: true };
}

function cachedRate() { return cache.rate || FALLBACK; }

module.exports = { fetchUsdToEur, cachedRate, parseRate, FALLBACK, TTL_MS };
