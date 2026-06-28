"use strict";
// ПЕРЕВОДЧИК: рынок/исход oddspapi (по каталогу /v4/markets) → desc/subject для pickOutcome.
// oddspapi отдаёт числовые id; pickOutcome ждёт описание в формате старого surebet-фида («П2»,
// «Тб(2.5)», «Ф1(+1.5)», «1 1-2», «1X»). Этот модуль их сопоставляет. Поддерживаем ТОЛЬКО полный матч
// и 2–3-исходные рынки, которые pickOutcome реально умеет ставить; остальное → null (не ставим).
// Чистая функция, тесты в test/oddsmap.test.cjs.

const FULL = new Set(["fulltime", "result", "match"]); // полный матч (не саб-периоды)
const signed = (n) => (Number(n) > 0 ? "+" + n : String(n));

// meta — запись каталога рынка {marketType, period, handicap, outcomes:[{outcomeId,outcomeName}]}.
// p1/p2 — имена участников (для subject → подтверждение стороны в pickOutcome).
// Возврат: { desc, subject } или null (рынок/исход не поддержан для простановки).
function toDesc(meta, outcomeId, p1 = "", p2 = "") {
  if (!meta || !FULL.has(meta.period)) return null;
  const out = (meta.outcomes || []).find((o) => String(o.outcomeId) === String(outcomeId));
  if (!out) return null;
  const name = String(out.outcomeName || "").trim();
  const line = meta.handicap;
  switch (meta.marketType) {
    case "1x2":
      if (name === "1") return { desc: "П1", subject: p1 };
      if (name === "X") return { desc: "X", subject: "" };
      if (name === "2") return { desc: "П2", subject: p2 };
      return null;
    case "moneyline": // 2-исходный (бейсбол/без ничьи)
      if (name === "1") return { desc: "П1", subject: p1 };
      if (name === "2") return { desc: "П2", subject: p2 };
      return null;
    case "totals":
      if (/over/i.test(name)) return { desc: `Тб(${line})`, subject: "" };
      if (/under/i.test(name)) return { desc: `Тм(${line})`, subject: "" };
      return null;
    case "spreads": // азиатская фора: handicap = линия стороны 1, у стороны 2 знак противоположный
      if (name === "1") return { desc: `Ф1(${signed(line)})`, subject: p1 };
      if (name === "2") return { desc: `Ф2(${signed(-line)})`, subject: p2 };
      return null;
    case "drawnobet":
      if (name === "1") return { desc: "1 1-2", subject: p1 };
      if (name === "2") return { desc: "2 1-2", subject: p2 };
      return null;
    case "doublechance":
      if (name === "1X") return { desc: "1X", subject: "" };
      if (name === "12") return { desc: "12", subject: "" };
      if (name === "2X") return { desc: "X2", subject: "" };
      return null;
    default:
      return null; // BTTS, евро-фора, чёт/нечет, проп-ставки и пр. — пока не ставим
  }
}

module.exports = { toDesc, FULL };
