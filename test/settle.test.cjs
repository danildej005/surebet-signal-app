"use strict";
// Тесты сеттлмента теннисного сигнала по финальному счёту (бумажный бэктест).
const test = require("node:test");
const assert = require("node:assert");
const s = require("../lib/settle.cjs");
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

test("parseSets/tennisTotals: счёт по сетам → геймы/сеты/разницы", () => {
  assert.deepEqual(s.parseSets("6-1, 6-4|CurrentGame:0"), [[6, 1], [6, 4]]); // хвост CurrentGame срезан
  const t = s.tennisTotals([[6, 1], [6, 4]]);
  assert.deepEqual([t.games, t.gameMargin, t.sets, t.setMargin], [17, 7, 2, 2]);
  assert.deepEqual(s.parseSets(""), []); // пусто → нет сетов
});

test("settleTennis ML: победитель матча по сетам", () => {
  assert.equal(s.settleTennis("ML", "", "A", "/Main/Main", "6-1, 6-4").result, "win");  // team1 2-0
  assert.equal(s.settleTennis("ML", "", "B", "/Main/Main", "6-1, 6-4").result, "lose");
  assert.equal(s.settleTennis("ML", "", "B", "/Main/Main", "4-6, 3-6").result, "win");  // team2 2-0
});

test("settleTennis TOTAL(геймы): сумма геймов vs линия, over=A/under=B, возврат на целой", () => {
  // 6-1,6-4 = 17 геймов
  assert.equal(s.settleTennis("TOTAL", "20.5", "A", "/Main/Main/Game", "6-1, 6-4").result, "lose"); // over 20.5 — нет
  assert.equal(s.settleTennis("TOTAL", "20.5", "B", "/Main/Main/Game", "6-1, 6-4").result, "win");  // under 20.5 — да
  assert.equal(s.settleTennis("TOTAL", "16.5", "A", "/Main/Main/Game", "6-1, 6-4").result, "win");  // over 16.5 — да
  assert.equal(s.settleTennis("TOTAL", "17", "A", "/Main/Main/Game", "6-1, 6-4").result, "push");   // ровно 17 → возврат
});

test("settleTennis SPREAD(геймы): ЗНАКОВАЯ фора team1, разница геймов", () => {
  // gameMargin = +7 (12 vs 5)
  assert.equal(s.settleTennis("SPREAD", "-6.5", "A", "/Main/Main/Game", "6-1, 6-4").result, "win");  // team1 −6.5: 7−6.5>0
  assert.equal(s.settleTennis("SPREAD", "-7.5", "A", "/Main/Main/Game", "6-1, 6-4").result, "lose"); // team1 −7.5: 7−7.5<0
  assert.equal(s.settleTennis("SPREAD", "-6.5", "B", "/Main/Main/Game", "6-1, 6-4").result, "lose"); // team2 +6.5: зеркало
  assert.equal(s.settleTennis("SPREAD", "-7", "A", "/Main/Main/Game", "6-1, 6-4").result, "push");   // ровно 7−7=0 → возврат
});

test("settleTennis SPREAD(сеты): фора по сетам на /Main/Main", () => {
  // setMargin = +2
  assert.equal(s.settleTennis("SPREAD", "-1.5", "A", "/Main/Main", "6-1, 6-4").result, "win");  // team1 −1.5 сета
  assert.equal(s.settleTennis("SPREAD", "1.5", "B", "/Main/Main", "6-1, 6-4").result, "lose");  // team2 +1.5: −2+1.5<0
});

test("settle: pnl от кэфа Betano на входе (флэт 1 у.е.), только теннис", () => {
  assert.ok(near(s.settle({ kind: "SPREAD", param: "-6.5", side: "A", st: "/Main/Main/Game", sportType: 3, betanoOdds: 2.0, finalScore: "6-1, 6-4" }).pnl, 1.0)); // win 2.0−1
  assert.ok(near(s.settle({ kind: "ML", param: "", side: "B", st: "/Main/Main", sportType: 3, betanoOdds: 5.9, finalScore: "6-1, 6-4" }).pnl, -1)); // lose
  assert.equal(s.settle({ kind: "TOTAL", param: "17", side: "A", st: "/Main/Main/Game", sportType: 3, betanoOdds: 1.9, finalScore: "6-1, 6-4" }).pnl, 0); // push
  assert.deepEqual(s.settle({ kind: "ML", param: "", side: "A", st: "/Main/Main", sportType: 9, betanoOdds: 2.0, finalScore: "5-3" }), { result: "na", pnl: null }); // не теннис → na
  assert.deepEqual(s.settle({ kind: "ML", param: "", side: "A", st: "/Main/Main", sportType: 3, betanoOdds: 2.0, finalScore: "" }), { result: "na", pnl: null }); // нет счёта → na
});

test("settleTennis: отказ/незавершённый матч → void (не сеттлим, не гадаем)", () => {
  assert.equal(s.settleTennis("ML", "", "A", "/Main/Main", "6-1, 2-1").result, "void");            // 2-1 — сет не доигран
  assert.equal(s.settleTennis("SPREAD", "-2.5", "A", "/Main/Main/Game", "6-1, 1-0").result, "void"); // ранний отказ
  assert.equal(s.settleTennis("TOTAL", "20.5", "A", "/Main/Main/Game", "6-4, 3-6, 1-0").result, "void"); // супертай-брейк-как-сет
  assert.equal(s.settle({ kind: "ML", param: "", side: "A", st: "/Main/Main", sportType: 3, betanoOdds: 2.0, finalScore: "6-1, 2-1" }).pnl, null); // void → pnl null
  assert.equal(s.settleTennis("ML", "", "A", "/Main/Main", "6-1, 4-6, 7-5").result, "win");        // завершённый bo3 в 3 сета — ок
});

test("bucketIndex: дистанция до вилки → бакет", () => {
  assert.equal(s.bucketIndex(0.08), 0);   // вилка
  assert.equal(s.bucketIndex(-0.01), 1);  // −0…−2
  assert.equal(s.bucketIndex(-0.03), 2);  // −2…−5
  assert.equal(s.bucketIndex(-0.07), 3);  // −5…−10
  assert.equal(s.bucketIndex(-0.2), 4);   // < −10
});

test("rollup: свод + бакеты по дистанции до вилки + Δ к МО", () => {
  const rows = [
    { arbEntry: 0.08, valueEntry: 0.02, pnl: 1.0, result: "win" },       // вилка
    { arbEntry: -0.01, valueEntry: 0.03, pnl: -1, result: "lose" },      // −0…−2
    { arbEntry: -0.03, valueEntry: 0.01, pnl: 0.9, result: "win" },      // −2…−5
    { arbEntry: -0.2, valueEntry: 0.005, pnl: -1, result: "lose" },      // < −10
    { arbEntry: -0.01, valueEntry: 0.02, pnl: null, result: "pending" }, // не сеттлилось → скип
  ];
  const r = s.rollup(rows);
  assert.equal(r.detected, 5);
  assert.equal(r.overall.bets, 4);         // pending не считается
  assert.equal(r.overall.wins, 2);
  assert.ok(near(r.overall.units, -0.1));  // 1 −1 +0.9 −1
  assert.ok(near(r.overall.roi, -0.1 / 4));
  assert.ok(near(r.overall.delta, r.overall.roi - r.overall.evPred)); // Δ = реальный − ожидаемый
  assert.equal(r.buckets[0].bets, 1); assert.ok(near(r.buckets[0].units, 1.0)); // бакет вилки
  assert.equal(r.buckets[1].bets, 1); assert.equal(r.buckets[1].wins, 0);       // −0…−2 проиграл
});
