"use strict";
// ПРЕМАТЧ: быстрая проверка «тот ли это матч» по ценам (без сети). Чистая логика, покрыта тестами.
//
// Идея: если Betano и Pinnacle говорят про ОДИН матч, цена одного и того же исхода у них близка почти везде.
// Сравниваем две независимые группы рынков: «сила команд» (исход, фора 0, фора, тоталы команд) и «тотал матча».
// У перепутанных матчей обычно не сходятся ОБЕ группы; у настоящей вилки (Betano отстал) — чаще одна.
//
// ЭТО НЕ ФИЛЬТР, А ПОМЕТКА. Замер на дампе 19.11.2026 (футбол, 754 верные пары и 2 262 намеренно перепутанные):
//   • из перепутанных пар, давших «вилку», пометку «suspect» получают 84%, 16% проходят как «ok»;
//   • из верных пар «suspect» получают 18 (2.4%), в том числе 2 из 6 пар с настоящей вилкой.
// Строже нельзя: вилка — это и есть расхождение цен, жёсткий порог режет настоящие вилки вместе с ложными.
// Поэтому вилку из пары «suspect» нужно дополнительно подтверждать (название/страна/время матча), а не выбрасывать.
const { parseKey, mkKey } = require("./markets.cjs");

const LO = 1.3, HI = 3.5;  // сравниваем только средние коэффициенты: на длинных маржа Betano искажает картину
const MIN = 2;             // столько общих исходов нужно в группе, чтобы ей верить
const T_BOTH = 0.05;       // есть обе группы: «suspect», если медиана расхождения в КАЖДОЙ больше ~5%
const T_ONE = 0.12;        // есть только одна группа: «suspect», если её медиана больше ~12%

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// PURE: bPrices — пары [ключ, цена Betano]; getP(ключ) → цена Pinnacle по тому же ключу (в порядке команд Betano).
// Возврат { status: "ok" | "suspect" | "nodata", devS, devT, nS, nT } — dev* это медиана |ln(цена Betano / цена Pinnacle)|.
function pairCheck(bPrices, getP) {
  const P = (key) => { const v = Number(getP(key)); return v > 1 ? v : null; };
  const S = [], T = [];
  for (const [key, price] of bPrices) {
    const b = Number(price);
    if (!(b >= LO && b <= HI)) continue;
    const k = parseKey(key);
    const pDraw = P(mkKey(k.period, "x", 0, "d")) != null;      // у Pinnacle в этом периоде рынок с ничьей
    let pk;
    if (k.family === "x") { if (!pDraw) continue; pk = key; }    // исход с ничьей сравним только с таким же
    else if (k.family === "ml") { if (pDraw) continue; pk = mkKey(k.period, "x", 0, k.side); } // победа без ничьей — с двухисходным
    else if (k.family === "dnb") pk = mkKey(k.period, "hc", 0, k.side);
    else if (k.family === "tot" || k.family === "tt1" || k.family === "tt2" || k.family === "hc") pk = key;
    else continue;
    const p = P(pk);
    if (!p || p < LO || p > HI) continue;
    (k.family === "tot" ? T : S).push(Math.abs(Math.log(b / p)));
  }
  const devS = median(S), devT = median(T), hasS = S.length >= MIN, hasT = T.length >= MIN;
  let status;
  if (hasS && hasT) status = devS > T_BOTH && devT > T_BOTH ? "suspect" : "ok";
  else if (hasS || hasT) status = (hasS ? devS : devT) > T_ONE ? "suspect" : "ok";
  else status = "nodata";
  return { status, devS, devT, nS: S.length, nT: T.length };
}

module.exports = { pairCheck, LO, HI, MIN, T_BOTH, T_ONE };
