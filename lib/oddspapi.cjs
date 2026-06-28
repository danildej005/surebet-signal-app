"use strict";
// Клиент oddspapi.io (v4) + ЧИСТЫЕ парсеры ответа. Сеть — тонкие обёртки; разбор данных — отдельно
// (тестируется без сети). Ключ API передаётся аргументом (в приложении берём из settings.enc, в
// разведке — из ~/.oddspapi_key). Ключ в код/git НЕ зашиваем.
const https = require("https");

const BASE = "https://api.oddspapi.io/v4";

// GET с query-параметрами; вернёт распарсенный JSON (или {error}). Без зависимостей.
function apiGet(path, params, apiKey) {
  const qs = new URLSearchParams({ ...params, apiKey }).toString();
  const url = `${BASE}${path}?${qs}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error("oddspapi: не JSON (" + res.statusCode + "): " + buf.slice(0, 200))); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("oddspapi: таймаут " + path)));
    req.on("error", reject);
  });
}

// ── Тонкие обёртки эндпоинтов ────────────────────────────────────────────────
const account = (apiKey) => apiGet("/account", {}, apiKey);                       // free, не тратит квоту
const sports = (apiKey) => apiGet("/sports", {}, apiKey);
const tournaments = (sportId, apiKey) => apiGet("/tournaments", { sportId }, apiKey);
const markets = (sportId, apiKey) => apiGet("/markets", { sportId }, apiKey);
const fixtures = (sportId, from, to, apiKey) => apiGet("/fixtures", { sportId, from, to }, apiKey);
// odds-by-tournaments: РОВНО одна контора, МАКС 5 турниров за запрос (ограничения API).
const oddsByTournaments = (bookmaker, tournamentIds, apiKey) =>
  apiGet("/odds-by-tournaments", { bookmaker, tournamentIds: [].concat(tournamentIds).join(",") }, apiKey);

// ── ЧИСТЫЕ парсеры ───────────────────────────────────────────────────────────
const asList = (json) => (Array.isArray(json) ? json : (json && (json.data || json.fixtures || json.markets)) || []);

// Каталог рынков → Map(marketId(string) → meta{marketType, period, handicap, marketName, outcomes[]}).
function catalogFromMarkets(json) {
  const m = new Map();
  for (const x of asList(json)) m.set(String(x.marketId), x);
  return m;
}

// Из fixture вытащить рынки одной конторы → { "<marketId>": { "<outcomeId>": price } }.
// API при фильтре bookmaker=... кладёт данные под КАНОНИЧЕСКИМ ключом (напр. betano.bg → "betano"),
// поэтому если точного ключа нет — берём первую (единственную) контору в ответе.
function outcomesByMarket(fixture, bookmaker) {
  const bo = (fixture && fixture.bookmakerOdds) || {};
  const b = (bookmaker && bo[bookmaker]) || Object.values(bo)[0];
  const out = {};
  if (!b || !b.markets) return out;
  for (const [mid, mv] of Object.entries(b.markets)) {
    if (mv && mv.marketActive === false) continue;
    const om = {};
    for (const [oid, ov] of Object.entries(mv.outcomes || {})) {
      const pl = ov && ov.players && Object.values(ov.players)[0];
      if (pl && pl.active !== false && typeof pl.price === "number" && pl.price > 1) om[oid] = pl.price;
    }
    if (Object.keys(om).length) out[mid] = om;
  }
  return out;
}

// eventId конторы (общий между странами Betano) + путь — для сборки дип-линка.
function bookmakerMeta(fixture, bookmaker) {
  const bo = (fixture && fixture.bookmakerOdds) || {};
  const b = (bookmaker && bo[bookmaker]) || Object.values(bo)[0] || {};
  return { eventId: b.bookmakerFixtureId || "", path: b.fixturePath || "" };
}

// Индекс fixtureId → fixture по списку (для джойна разных запросов одной контора-выборки).
function indexByFixtureId(json) {
  const m = new Map();
  for (const f of asList(json)) if (f && f.fixtureId) m.set(f.fixtureId, f);
  return m;
}

module.exports = {
  BASE, apiGet, account, sports, tournaments, markets, fixtures, oddsByTournaments,
  asList, catalogFromMarkets, outcomesByMarket, bookmakerMeta, indexByFixtureId,
};
