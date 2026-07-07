"use strict";
// Тесты НЕЗАВИСИМОГО судьи verifyPick: сверка «выбор == сигнал» перед боевым кликом.
// Ловит наблюдённые классы мис-селектов (экспресс, «N+», не-та-сторона, не та линия) И будущие.
const test = require("node:test");
const assert = require("node:assert");
const { verifyPick } = require("../lib/bookers.cjs");

const sig = (o) => Object.assign({ t1: "Andres Martin", t2: "Jason Jung", expectedOdds: 1.9 }, o);

test("TOTAL: верный Under проходит; экспресс и не та линия — блок", () => {
  assert.equal(verifyPick(sig({ kind: "TOTAL", side: "B", param: "18.5", expectedOdds: 1.9 }), { text: "Under 18.5 1.90", odds: 1.9 }).ok, true);
  assert.equal(verifyPick(sig({ kind: "TOTAL", side: "A", param: "18.5", expectedOdds: 1.2 }), { text: "Ivan Ivanov and Over 18.5 1.10", odds: 1.1 }).ok, false); // экспресс
  assert.equal(verifyPick(sig({ kind: "TOTAL", side: "B", param: "18.5", expectedOdds: 1.9 }), { text: "Under 20.5 1.90", odds: 1.9 }).ok, false); // не та линия
  assert.equal(verifyPick(sig({ kind: "TOTAL", side: "A", param: "18.5", expectedOdds: 1.9 }), { text: "Under 18.5 1.90", odds: 1.9 }).ok, false); // ждали Over
});

test("SPREAD: верная линия/сторона проходит; чужая сторона и не та линия — блок", () => {
  assert.equal(verifyPick(sig({ kind: "SPREAD", side: "A", param: "-6.5", st: "/Main/Main/Game", expectedOdds: 1.85 }), { text: "-6.5 1.85", odds: 1.85, how: "fav" }).ok, true);
  assert.equal(verifyPick(sig({ kind: "SPREAD", side: "B", param: "3.5", st: "/Main/Main/Game", expectedOdds: 1.85 }), { text: "-3.5 1.85", odds: 1.85 }).ok, true); // side B: линия -3.5
  assert.equal(verifyPick(sig({ kind: "SPREAD", side: "A", param: "-6.5", st: "/Main/Main/Game", expectedOdds: 1.85 }), { text: "-5.5 1.85", odds: 1.85 }).ok, false); // не та линия
  assert.equal(verifyPick(sig({ kind: "SPREAD", side: "A", param: "-1.5", st: "/Main/Main/Game", expectedOdds: 3.0, t1: "Calvin", t2: "Marvin" }), { text: "Marvin -1.5 3.00", odds: 3.0 }).ok, false); // чужая сторона
  // сетовая фора −1.5 ⟺ счёт 2:0 — допускаем
  assert.equal(verifyPick(sig({ kind: "SPREAD", side: "A", param: "-1.5", st: "/Main/Main", expectedOdds: 3.0 }), { text: "2 - 0 3.00", odds: 3.0 }).ok, true);
});

test("ML: имя/токен стороны проходит; «3»/«N+»/чужой/тотал — блок", () => {
  assert.equal(verifyPick(sig({ kind: "ML", side: "A", expectedOdds: 1.72 }), { text: "Andres Martin 1.72", odds: 1.72, how: "name" }).ok, true);
  assert.equal(verifyPick(sig({ kind: "ML", side: "B", expectedOdds: 2.0 }), { text: "2 2.02", odds: 2.02 }).ok, true); // чистый токен стороны
  assert.equal(verifyPick(sig({ kind: "ML", side: "A", expectedOdds: 1.93 }), { text: "3 1.95", odds: 1.95 }).ok, false); // «3» — не победитель
  assert.equal(verifyPick(sig({ kind: "ML", side: "B", expectedOdds: 2.32 }), { text: "25+ 2.27", odds: 2.27 }).ok, false); // агрегат
  assert.equal(verifyPick(sig({ kind: "ML", side: "B", t1: "Luca Potenza", t2: "Lorenzo Angelini", expectedOdds: 2.87 }), { text: "Luca Potenza 2.92", odds: 2.92 }).ok, false); // чужой игрок (нужен Lorenzo)
  assert.equal(verifyPick(sig({ kind: "ML", side: "A", expectedOdds: 1.9 }), { text: "Over 18.5 1.90", odds: 1.9 }).ok, false); // тотал вместо победы
  // гейм-проп «to win to N» (выиграть гейм всухую) — НЕ победа матча, хоть имя и кэф совпали (реальный баг Palosi)
  assert.equal(verifyPick(sig({ kind: "ML", side: "A", t1: "Stefan Palosi", t2: "Zdenek Kolar", expectedOdds: 2.35 }), { text: "Stefan Palosi to win to 15 2.32", odds: 2.32, how: "name" }).ok, false);
});

test("TOTAL: условный тотал со счётом («… 3-0») — блок", () => {
  // сигнал матчевого Under 41.5, а выбор — тотал, привязанный к счёту 3-0 (реальный баг Score 3-0)
  assert.equal(verifyPick(sig({ kind: "TOTAL", side: "B", param: "41.5", expectedOdds: 2.12 }), { text: "Under 41.5 3-0 2.10", odds: 2.1 }).ok, false);
  assert.equal(verifyPick(sig({ kind: "TOTAL", side: "B", param: "41.5", expectedOdds: 2.12 }), { text: "Under 41.5 2.10", odds: 2.1 }).ok, true); // чистый матчевый — проходит
});

test("Кэф грубо мимо / нет типа сигнала", () => {
  assert.equal(verifyPick(sig({ kind: "TOTAL", side: "A", param: "18.5", expectedOdds: 1.2 }), { text: "Over 18.5 5.00", odds: 5.0 }).ok, false); // кэф далёк
  const skip = verifyPick({ expectedOdds: 2 }, { text: "что-то 2.00", odds: 2 });
  assert.equal(skip.ok, true); assert.equal(skip.skip, true); // нечем сверять — не блокируем
});
