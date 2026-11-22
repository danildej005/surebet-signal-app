"use strict";
// ПРЕМАТЧ: расчёт ставки по счёту (docs/PREMATCH-HANDBOOK.md, раздел 11) и разбор строки счёта Flashscore (раздел 10).
// Только ФУТБОЛ (периоды FT / 1H / 2H). Чистая логика, покрыта test/prematch.test.cjs.
const { parseKey } = require("./markets.cjs");

// Результат одной «половинной» ставки: +1 выигрыш, −1 проигрыш, 0 возврат.
const cmp = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

function outcome(family, line, side, h, a) {
  const sum = h + a;
  switch (family) {
    case "x": return (side === "h" ? h > a : side === "a" ? a > h : h === a) ? 1 : -1;
    case "dc": return (side === "1x" ? h >= a : side === "x2" ? a >= h : h !== a) ? 1 : -1;
    case "dnb": return h === a ? 0 : ((side === "h") === (h > a) ? 1 : -1);          // ничья — возврат
    case "tot": return side === "o" ? cmp(sum - line) : cmp(line - sum);             // сумма равна линии — возврат
    case "tt1": return side === "o" ? cmp(h - line) : cmp(line - h);
    case "tt2": return side === "o" ? cmp(a - line) : cmp(line - a);
    case "hc": return side === "h" ? cmp(h + line - a) : cmp(a - line - h);          // линия в терминах хозяев
    case "btts": return ((h > 0 && a > 0) === (side === "y")) ? 1 : -1;
    case "odd": return ((sum % 2 === 1) === (side === "o")) ? 1 : -1;
    default: return null;
  }
}

// PURE: результат ставки в единицах ставки: выигрыш k − 1, проигрыш −1, возврат 0. null — рассчитать нельзя.
// ft / ht — счёт матча и первого тайма как [хозяева, гости]. Нет счёта первого тайма → ставки на таймы не считаются.
// Четвертная линия (x.25 / x.75) — среднее двух половинных ставок на линия−0.25 и линия+0.25.
function settle(key, price, ft, ht) {
  const k = parseKey(key);
  if (!ft) return null;
  let sc;
  if (k.period === "FT") sc = ft;
  else if (k.period === "1H") { if (!ht) return null; sc = ht; }
  else if (k.period === "2H") { if (!ht) return null; sc = [ft[0] - ht[0], ft[1] - ht[1]]; }
  else return null;
  const unit = (r) => (r > 0 ? Number(price) - 1 : r < 0 ? -1 : 0);
  const quarter = Math.abs((Math.abs(k.line) * 4) % 2) === 1;        // 0.25 / 0.75
  const lines = quarter ? [k.line - 0.25, k.line + 0.25] : [k.line];
  let total = 0;
  for (const ln of lines) {
    const r = outcome(k.family, ln, k.side, sc[0], sc[1]);
    if (r == null) return null;
    total += unit(r);
  }
  return total / lines.length;
}

// PURE: строка счёта Flashscore → { ft: [h, a], ht: [h, a] | null } или null (матч не состоялся / не разобрать).
//   «2-0 (1-0,1-0)»            → 2:0, первый тайм 1:0
//   «2-2aet (0-0,2-1,0-1)»     → дополнительное время: счёт основного = сумма первых двух частей → 2:1, тайм 0:0
//   «1-1 (Pen: 5-3)»           → серия пенальти: счёт основного времени 1:1
//   «-»                        → матч не состоялся
function parseFlashscore(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const m = /^(\d+)\s*-\s*(\d+)\s*(aet)?/i.exec(s);
  if (!m) return null;
  let ft = [Number(m[1]), Number(m[2])], ht = null;
  const parts = [];
  const pm = /\(([^)]*)\)/.exec(s);
  if (pm && !/pen/i.test(pm[1])) {
    for (const p of pm[1].split(",")) { const x = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(p); if (x) parts.push([Number(x[1]), Number(x[2])]); }
  }
  if (parts.length >= 2) {
    ht = parts[0];
    if (m[3]) ft = [parts[0][0] + parts[1][0], parts[0][1] + parts[1][1]];   // aet: основное время = первые две части
  } else if (m[3]) return null;                                              // aet без частей — счёт основного времени неизвестен
  return { ft, ht };
}

module.exports = { settle, parseFlashscore };
