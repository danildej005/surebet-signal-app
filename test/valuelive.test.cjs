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

test("_initBook: пусто(null) и 429(rateLimited по статусу) — ждёт, поднимается, логирует форму", async () => {
  const bc = require("../lib/bettingco.cjs");
  const orig = bc.getBookmakerData;
  let calls = 0; const diag = [];
  bc.getBookmakerData = async () => {
    calls++;
    if (calls === 1) return null;                                     // пусто (204/empty тело)
    if (calls === 2) return { rateLimited: true, retryAfterMs: 20 };  // 429 распознан по статусу
    return { gamesOriginModel: { writeTime: "t", model: { "/g/9": { textId: "/g/9", team1NameEn: "C", team2NameEn: "D" } } }, marketsOriginModel: { model: {} }, snapshots: [] };
  };
  try {
    const eng = new ValueLiveEngine("k", { minPullMs: 5, onInitDiag: (b, s) => diag.push(b + ":" + s) });
    eng.lastPull = Date.now() - 10;
    const st = await eng._initBook("Pinnacle");
    assert.ok(st && st.games["/g/9"]);
    assert.equal(calls, 3);
    assert.ok(diag.some((d) => d.includes("пусто")) && diag.some((d) => d.includes("429")), "форма залогирована: " + diag.join(" | "));
  } finally { bc.getBookmakerData = orig; }
});
