"use strict";
// ПРЕМАТЧ: как образуется вилка (docs/PREMATCH-HANDBOOK.md, раздел 7).
// Вилка считается на уровне ОДНОГО исхода Betano против противоположной ставки в Pinnacle.
// Чистая логика, покрыта test/prematch.test.cjs.
const { parseKey, mkKey } = require("./markets.cjs");

// Синтетика из двух исходов: цена ставки, покрывающей оба.
const synth = (a, b) => (a > 1 && b > 1) ? 1 / (1 / a + 1 / b) : null;

// PURE: лучшая противоположная цена Pinnacle для исхода Betano.
// getP(key) → цена Pinnacle по единому ключу (в порядке команд Betano) или undefined.
// Возврат { opp, via } или null («нет рынка»: ни вилка, ни классический валуй невозможны).
//
// Таблица хендбука 7.1 (футбол) + то, чего в ней нет:
//   • ml (победа без ничьей, не-футбол) и hc (фора Betano, не-футбол) — другая сторона того же рынка;
//   • для двойного шанса 1X / X2 добавлена равносильная фора ∓0.5 (выигрывает ровно тогда же, когда П2 / П1).
function oppositePrice(key, getP) {
  const k = parseKey(key);
  if (k.period === "2H") return null;                               // второго тайма в Pinnacle нет
  const P = (family, line, side) => { const v = Number(getP(mkKey(k.period, family, line, side))); return v > 1 ? v : null; };
  const cands = [];
  const add = (opp, via) => { if (opp && opp > 1) cands.push({ opp, via }); };
  const hasDraw = P("x", 0, "d") != null;                           // у Pinnacle в этом периоде рынок с ничьей
  if (k.family === "x") {
    if (k.side === "a") { add(P("hc", 0.5, "h"), "фора хозяев +0.5"); add(synth(P("x", 0, "h"), P("x", 0, "d")), "П1 или Х"); }
    else if (k.side === "h") { add(P("hc", -0.5, "a"), "фора гостей +0.5"); add(synth(P("x", 0, "a"), P("x", 0, "d")), "П2 или Х"); }
    else if (k.side === "d") add(synth(P("x", 0, "h"), P("x", 0, "a")), "П1 или П2");
    if (k.side === "d" && !hasDraw) return null;                    // ничьей у Pinnacle нет → «П1 или П2» её не дополняет
  } else if (k.family === "ml") {                                   // победа без ничьей (теннис, кибер, с овертаймом)
    if (hasDraw) return null;                                       // у Pinnacle в этом сегменте 3 исхода — рынки разные
    if (k.side === "h") { add(P("x", 0, "a"), "победа соперника"); add(P("hc", -0.5, "a"), "фора соперника +0.5"); }
    else if (k.side === "a") { add(P("x", 0, "h"), "победа соперника"); add(P("hc", 0.5, "h"), "фора соперника +0.5"); }
  } else if (k.family === "dnb") {
    add(P("hc", 0, k.side === "h" ? "a" : "h"), "другая сторона форы 0");
  } else if (k.family === "dc") {
    if (!hasDraw) return null;
    if (k.side === "1x") { add(P("x", 0, "a"), "П2"); add(P("hc", 0.5, "a"), "фора гостей −0.5"); }
    else if (k.side === "x2") { add(P("x", 0, "h"), "П1"); add(P("hc", -0.5, "h"), "фора хозяев −0.5"); }
    else if (k.side === "12") add(P("x", 0, "d"), "Х");
  } else if (k.family === "tot" || k.family === "tt1" || k.family === "tt2") {
    add(P(k.family, k.line, k.side === "o" ? "u" : "o"), "другая сторона линии");
  } else if (k.family === "hc") {
    add(P("hc", k.line, k.side === "h" ? "a" : "h"), "другая сторона форы");
  } else return null;                                               // btts, odd — рынка в Pinnacle нет
  if (!cands.length) return null;
  return cands.reduce((best, c) => (c.opp > best.opp ? c : best));
}

// PURE: размер вилки. arb = 1 / (1/k_betano + 1/opp) − 1. null, если цены нет.
function arbOf(k, opp) {
  k = Number(k); opp = Number(opp);
  return (k > 1 && opp > 1) ? 1 / (1 / k + 1 / opp) - 1 : null;
}

// PURE: полоса (хендбук 7.2). Запас от вилки в код не зашиваем — режем при анализе по полю arb.
function band(arb) {
  if (arb == null) return "нет рынка";
  if (arb > 0) return "вилка";
  if (arb > -0.015) return "рядом";
  return "далеко";
}

module.exports = { oppositePrice, arbOf, band, synth };
