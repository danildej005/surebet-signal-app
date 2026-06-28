"use strict";
// Тесты ЧИСТЫХ парсеров oddspapi (без сети). Форма данных — как в реальном ответе /v4/odds-by-tournaments.
const test = require("node:test");
const assert = require("node:assert");
const { catalogFromMarkets, outcomesByMarket, bookmakerMeta, indexByFixtureId } = require("../lib/oddspapi.cjs");

// Реальная форма: при фильтре bookmaker=betano.bg API кладёт данные под КАНОНИЧЕСКИМ ключом "betano".
const FX = {
  fixtureId: "idABC",
  bookmakerOdds: {
    betano: {
      bookmakerFixtureId: "87697271",
      fixturePath: "https://www.betano.com/quoten/e-e/87697271",
      markets: {
        "101": {
          marketActive: true,
          outcomes: {
            "101": { players: { "0": { price: 20.0, active: true } } },
            "102": { players: { "0": { price: 7.5, active: true } } },
            "103": { players: { "0": { price: 1.16, active: true } } },
          },
        },
        "999": { marketActive: true, outcomes: { "1": { players: { "0": { price: 1.0, active: false } } } } }, // неактивный → выкинуть
      },
    },
  },
};

test("outcomesByMarket: фильтр betano.bg возвращается под ключом 'betano' → берём его (фолбэк на первую контору)", () => {
  const m = outcomesByMarket(FX, "betano.bg"); // точного ключа нет → первая контора
  assert.deepStrictEqual(m["101"], { "101": 20.0, "102": 7.5, "103": 1.16 });
  assert.ok(!m["999"], "неактивный/битый рынок отброшен");
});

test("bookmakerMeta: eventId и path для дип-линка", () => {
  const meta = bookmakerMeta(FX, "betano.bg");
  assert.strictEqual(meta.eventId, "87697271");
  assert.match(meta.path, /87697271/);
});

test("catalogFromMarkets: marketId → meta (тип/исходы)", () => {
  const cat = catalogFromMarkets([{ marketId: 101, marketType: "1x2", period: "fulltime", outcomes: [{ outcomeId: 101, outcomeName: "1" }] }]);
  assert.strictEqual(cat.get("101").marketType, "1x2");
});

test("indexByFixtureId: список → Map по fixtureId", () => {
  const idx = indexByFixtureId([FX, { fixtureId: "idZ" }]);
  assert.strictEqual(idx.get("idABC"), FX);
  assert.ok(idx.has("idZ"));
});
