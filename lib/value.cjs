"use strict";
// Движок value-ставок: снимаем маржу (de-vig) с линии Pinnacle → честная вероятность исхода →
// сравниваем с кэфом конторы (Betano) → value%. ЧИСТЫЕ функции, без сети. Тесты в test/value.test.cjs.
//
// Идея: Pinnacle — «шарп», его линия ближе всего к правде. Снимаем его маржу и получаем честную
// вероятность p. Честный кэф = 1/p. Если контора даёт кэф ВЫШЕ честного — это плюсовое ожидание (value).
// value% = кэф_конторы × p − 1.
//
// Де-виг считаем СТРОГО по полному набору исходов одного рынка (иначе вероятности не нормируются на 1).

// Маржа (overround) рынка: сумма обратных кэфов минус 1. [2.0,2.0] → 0; [1.9,1.9] → ~0.0526.
function margin(odds) {
  const s = odds.reduce((a, o) => a + (o > 0 ? 1 / o : 0), 0);
  return s - 1;
}

// Де-виг ПРОПОРЦИОНАЛЬНЫЙ (multiplicative): p_i = (1/o_i) / Σ(1/o_j). Маржа снимается поровну
// (в долях вероятности). Возвращает массив честных вероятностей (сумма = 1).
function devigProportional(odds) {
  const inv = odds.map((o) => (o > 0 ? 1 / o : 0));
  const s = inv.reduce((a, b) => a + b, 0);
  return s > 0 ? inv.map((x) => x / s) : odds.map(() => 0);
}

// Де-виг СТЕПЕННОЙ (power): p_i = (1/o_i)^k, степень k подбираем бисекцией так, чтобы Σ p_i = 1.
// Снимает маржу НЕ поровну — давит крайние кэфы иначе, чем середину, и тем ловит перекос маржи
// (фаворит-лонгшот: контора закладывает в фаворита/лонгшота разную маржу). Какой метод точнее —
// решаем бэктестом на истории, а не на слух.
function devigPower(odds) {
  const inv = odds.map((o) => (o > 0 ? 1 / o : 0));
  if (inv.some((x) => x <= 0)) return devigProportional(odds); // битый кэф → безопасный откат
  const sumPow = (k) => inv.reduce((a, x) => a + Math.pow(x, k), 0);
  // Σ(inv^k) монотонно убывает по k (т.к. каждый inv<1). Ищем корень Σ=1 на [0.5, 6].
  let lo = 0.5, hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (sumPow(mid) > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  return inv.map((x) => Math.pow(x, k));
}

// value% исхода: кэф конторы × честная вероятность − 1. >0 — плюсовое ожидание (ставим), <0 — минус.
function valuePct(bookOdds, fairProb) {
  return bookOdds > 0 && fairProb > 0 ? bookOdds * fairProb - 1 : -1;
}

// Полная оценка одного исхода рынка.
//   pinnacleOdds — кэфы ВСЕГО рынка Pinnacle (массив, в порядке исходов);
//   index        — индекс нужного исхода в этом массиве;
//   bookOdds     — кэф конторы (Betano) на этот же исход;
//   method       — "proportional" (по умолчанию) | "power".
// Возвращает { margin, fairProb, fairOdds, valuePct }.
function evaluate({ pinnacleOdds = [], index = 0, bookOdds = 0, method = "proportional" } = {}) {
  const probs = method === "power" ? devigPower(pinnacleOdds) : devigProportional(pinnacleOdds);
  const fairProb = probs[index] || 0;
  return {
    margin: margin(pinnacleOdds),
    fairProb,
    fairOdds: fairProb > 0 ? 1 / fairProb : null,
    valuePct: valuePct(bookOdds, fairProb),
  };
}

// PURE-сканер value по ОДНОМУ матчу. На вход — рынки Pinnacle и конторы в виде
//   { "<marketId>": { "<outcomeId>": price, ... }, ... }  (одинаковая нумерация — нормализованные id API).
// Для каждого рынка, что есть у конторы И у Pinnacle: де-виг полного набора исходов Pinnacle → честная
// вероятность → value% для кэфа конторы. Возвращает кандидатов с value% ≥ threshold, по убыванию.
function findValue(pinMarkets, bookMarkets, { threshold = 0.02, method = "proportional" } = {}) {
  const out = [];
  for (const mid of Object.keys(bookMarkets || {})) {
    const pin = pinMarkets && pinMarkets[mid];
    if (!pin) continue;                       // нет эталона Pinnacle на этот рынок — пропускаем
    const oids = Object.keys(pin);
    if (oids.length < 2) continue;            // де-виг требует полный набор исходов (≥2)
    const odds = oids.map((o) => pin[o]);
    if (odds.some((o) => !(o > 1))) continue; // битые/нерыночные кэфы
    const probs = method === "power" ? devigPower(odds) : devigProportional(odds);
    oids.forEach((oid, i) => {
      const bk = bookMarkets[mid][oid];
      if (!(bk > 1)) return;
      const v = bk * probs[i] - 1;
      if (v >= threshold) {
        out.push({ marketId: mid, outcomeId: oid, bookOdds: bk, fairProb: probs[i], fairOdds: 1 / probs[i], valuePct: v });
      }
    });
  }
  return out.sort((a, b) => b.valuePct - a.valuePct);
}

module.exports = { margin, devigProportional, devigPower, valuePct, evaluate, findValue };
