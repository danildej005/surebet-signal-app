"use strict";
// Текст сигнала в Telegram.
const { receiverLegs } = require("./filter.cjs");

const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtProfit(p) {
  if (typeof p !== "number" || !Number.isFinite(p)) return "н/д";
  const sign = p > 0 ? "+" : p < 0 ? "−" : "";
  return `${sign}${Math.abs(p).toFixed(2)}%`;
}

function formatSignal(surebet, keyword = "pinnacle") {
  const legs = receiverLegs(surebet, keyword);
  const odds = legs
    .map((l) => {
      const bet = l.outcome ? ` — ${esc(l.outcome)}` : "";
      return `${esc(l.book)}: кф <b>${Number(l.odds).toFixed(3)}</b>${bet}`;
    })
    .join("\n");
  const lines = [
    "🎯 <b>Вилка с Pinnacle</b>",
    surebet.event ? esc(surebet.event) : null,
    odds || "Pinnacle: кф н/д",
    `Доход: <b>${fmtProfit(surebet.profitPct)}</b>`,
  ].filter(Boolean);
  return lines.join("\n");
}

module.exports = { formatSignal };
