"use strict";
// Чистый сеттлмент теннисного сигнала по ФИНАЛЬНОМУ счёту (бумажный бэктест, без денег). Счёт по сетам:
// «6-1, 6-4» → [[6,1],[6,4]]. Уровень рынка из surebetTextId: «/Main/Main» = сеты/матч, «/Main/Main/Game» = геймы.
// Доход считаем от кэфа Betano на ВХОДЕ, флэт 1 у.е.: зашла → кэф−1, не зашла → −1, возврат → 0.
// ОГРАНИЧЕНИЕ: только теннис (sportType 3) — счёт по сетам; прочие спорты → «na» (не гадаем). Отказ/незавершённый
// матч (неполный сет в финале) → «void» (в бэктест НЕ берём) — не мис-сеттлим и не угадываем победителя.
// Допущение: best-of-3 (ITF). Bo5/супертай-брейк-как-сет тоже уйдут в void (безопасно, лишь сужает выборку).

// Финальный счёт → массив сетов [[g1,g2],...] (без хвоста «|CurrentGame:X», без мусора).
const parseSets = (score) => String(score || "").split("|")[0].split(",")
  .map((s) => s.trim()).filter(Boolean)
  .map((p) => p.split("-").map((n) => parseInt(n, 10)))
  .filter((a) => a.length === 2 && a.every(Number.isFinite));

// Суммы по матчу: геймы/сеты каждой стороны + разницы (со стороны team1).
function tennisTotals(sets) {
  let g1 = 0, g2 = 0, s1 = 0, s2 = 0;
  for (const [a, b] of sets) { g1 += a; g2 += b; if (a > b) s1++; else if (b > a) s2++; }
  return { g1, g2, s1, s2, games: g1 + g2, sets: s1 + s2, gameMargin: g1 - g2, setMargin: s1 - s2 };
}

// Валидно ЗАВЕРШЁННЫЙ сет тенниса: 6-0..6-4 (или зеркало), 7-5, 7-6 (тай-брейк). Незавершённый (2-1, 6-6) — нет.
const completedSet = (a, b) => { const hi = Math.max(a, b), lo = Math.min(a, b); return (hi === 6 && lo <= 4) || (hi === 7 && (lo === 5 || lo === 6)); };

// Матч решён? Считаем ТОЛЬКО завершённые сеты; best-of-3: решён, если у лидера ровно 2 завершённых сета, у другого ≤1.
// Иначе (отказ / незавершённый сет / bo5 / супертай-брейк) — не решён → void. Возврат {decided, s1, s2} по завершённым.
function matchDecided(sets) {
  let s1 = 0, s2 = 0;
  for (const [a, b] of sets) { if (!completedSet(a, b)) continue; if (a > b) s1++; else if (b > a) s2++; }
  const lead = Math.max(s1, s2), lag = Math.min(s1, s2);
  return { decided: lead === 2 && lag <= 1, s1, s2 };
}

// Исход рынка по финалу. side: A=team1/over, B=team2/under. Возврат {result, cover} —
// cover>0: сторона A зашла, <0: зашла B, 0: возврат. result: win|lose|push|void|na (для СТОРОНЫ сигнала).
function settleTennis(kind, param, side, st, score) {
  const sets = parseSets(score);
  if (!sets.length) return { result: "na", cover: null };
  const dec = matchDecided(sets);
  if (!dec.decided) return { result: "void", cover: null }; // отказ/незавершён/не bo3 → в бэктест не берём
  const t = tennisTotals(sets);                             // матч решён → все сеты завершены, суммы корректны
  const setMargin = dec.s1 - dec.s2;
  const games = st === "/Main/Main/Game";                   // уровень геймов, иначе сеты/матч
  let cover;
  if (kind === "ML") cover = setMargin;                                          // победитель матча по сетам
  else if (kind === "TOTAL") cover = (games ? t.games : (dec.s1 + dec.s2)) - Number(param); // A=over: тотал − линия
  else if (kind === "SPREAD") cover = (games ? t.gameMargin : setMargin) + Number(param);   // A=team1@L: разница + фора
  else return { result: "na", cover: null };
  const forA = side === "A" ? cover : -cover;                   // приводим к стороне сигнала
  return { result: forA > 0 ? "win" : forA < 0 ? "lose" : "push", cover };
}

// Полный сеттлмент сигнала → {result, pnl}. pnl (флэт 1 у.е.): win → кэф−1, lose → −1, push → 0, na → null.
// sig: {kind, param, side, st, sportType, betanoOdds, finalScore}.
function settle(sig) {
  if (Number(sig.sportType) !== 3) return { result: "na", pnl: null }; // сеттлим только теннис (счёт по сетам)
  const { result } = settleTennis(sig.kind, sig.param, sig.side, sig.st, sig.finalScore);
  if (result === "na" || result === "void") return { result, pnl: null }; // не завершён/не теннис → не в бэктест
  const odds = Number(sig.betanoOdds);
  const pnl = result === "win" ? (odds - 1) : result === "lose" ? -1 : 0;
  return { result, pnl };
}

// Бакеты по ДИСТАНЦИИ ДО ВИЛКИ (arbEntry): 0 = на уровне вилки … 4 = глубоко ниже. Ось калибровки порога value.
const BUCKET_LABELS = ["вилка (arb ≥ 0)", "−0…−2% ниже", "−2…−5%", "−5…−10%", "< −10%"];
const bucketIndex = (a) => { a = Number(a) || 0; return a >= 0 ? 0 : a >= -0.02 ? 1 : a >= -0.05 ? 2 : a >= -0.10 ? 3 : 4; };

// Свод «за всё время» по строкам сигналов {arbEntry, valueEntry, pnl, result}. pnl==null → не сеттлилось (скип).
// Возврат: {detected, overall, buckets[]}, у каждого {bets,wins,units,roi,evPred,delta}. Δ = roi − evPred (близость к МО):
// roi — реальный доход (Σpnl/N при флэте), evPred — ожидаемый (ср. value входа = матожидание), delta — их разница.
function rollup(rows) {
  const mk = () => ({ bets: 0, wins: 0, units: 0, evSum: 0 });
  const fin = (g) => { const roi = g.bets ? g.units / g.bets : 0, evPred = g.bets ? g.evSum / g.bets : 0;
    return { bets: g.bets, wins: g.wins, units: g.units, roi, evPred, delta: roi - evPred }; };
  const overall = mk(), buckets = BUCKET_LABELS.map(() => mk());
  let detected = 0;
  for (const r of rows || []) {
    detected++;
    if (r.pnl == null) continue;                     // не завершилось/не теннис → в бэктест не берём
    for (const g of [overall, buckets[bucketIndex(r.arbEntry)]]) {
      g.bets++; if (r.result === "win") g.wins++; g.units += r.pnl; g.evSum += (Number(r.valueEntry) || 0);
    }
  }
  return { detected, overall: fin(overall), buckets: BUCKET_LABELS.map((label, i) => ({ label, ...fin(buckets[i]) })) };
}

module.exports = { parseSets, tennisTotals, settleTennis, settle, BUCKET_LABELS, bucketIndex, rollup };
