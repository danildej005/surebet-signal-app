"use strict";
// Тесты обёртки движка LIVE-value (valuelive.cjs). Клиент/чистая логика — в bettingco.test.cjs;
// тут — методы поверх состояния (снимок счёта под сеттлмент).
const test = require("node:test");
const assert = require("node:assert");
const { ValueLiveEngine } = require("../lib/valuelive.cjs");

test("eventScores: снимок счёта/статуса событий Betano (захват финала под сеттлмент)", () => {
  const eng = new ValueLiveEngine("k");
  eng.B = { games: {
    "/b/1": { team1NameEn: "Guido Ivan Justo", team2NameEn: "Olle Wallin", currentScore: "3-1|CurrentGame:5", statusType: 1 },
    "/b/2": { team1NameEn: "A", team2NameEn: "B", currentScore: "", statusType: null },
    "/b/x": {}, // без имён — пропустить (не событие)
  } };
  eng.P = { games: {} }; // ready() = B && P
  const ev = eng.eventScores();
  assert.equal(ev.length, 2); // «/b/x» без имён отсеян
  const byKey = Object.fromEntries(ev.map((e) => [e.key, e]));
  assert.deepEqual(byKey["Guido Ivan Justo~Olle Wallin"], { key: "Guido Ivan Justo~Olle Wallin", score: "3-1|CurrentGame:5", status: 1 });
  assert.deepEqual(byKey["A~B"], { key: "A~B", score: "", status: null }); // пустой счёт/статус ок
});

test("eventScores: движок не готов (нет состояния) → пусто", () => {
  assert.deepEqual(new ValueLiveEngine("k").eventScores(), []);
});

test("_initBook: rate-limit фида — терпеливо ждёт retryAfter и поднимается (не падает как «пусто»)", async () => {
  const bc = require("../lib/bettingco.cjs");
  const orig = bc.getBookmakerData;
  let calls = 0;
  bc.getBookmakerData = async () => {
    calls++;
    if (calls <= 2) return { message: "Rate limit exceeded", retryAfterMilliseconds: 20 }; // сперва rate-limit
    return { gamesOriginModel: { writeTime: "t", model: { "/g/1": { textId: "/g/1", team1NameEn: "A", team2NameEn: "B" } } }, marketsOriginModel: { model: {} }, snapshots: [] };
  };
  try {
    const eng = new ValueLiveEngine("k", { minPullMs: 5 });
    eng.lastPull = Date.now() - 10;                 // не ждать стартовый интервал
    const st = await eng._initBook("Pinnacle");
    assert.ok(st && st.games["/g/1"], "поднялся после rate-limit");
    assert.equal(calls, 3);                          // 2 rate-limit + 1 успех; rate-limit не сжёг лимит попыток
  } finally { bc.getBookmakerData = orig; }
});
