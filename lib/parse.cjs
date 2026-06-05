"use strict";
// Парсер страницы вилок surebet.com → массив вилок.
// Разметка: каждая вилка = <tbody class="surebet_record" data-id=… data-profit=… data-start-at=…>,
// плечи помечены data-testid="surebet-leg-bookmaker"/-odds/-event, «Ставка» — в <td class="coeff">.
// Внутри строк есть ВЛОЖЕННЫЕ таблицы (меню/калькулятор) → берём блок записи и извлекаем
// поля плеч ПОЗИЦИОННО по data-testid (устойчиво к вложенности).

const RE_RECORD = /<tbody class="surebet_record"/g;

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
const clean = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const all = (re, s) => [...s.matchAll(re)];
const attr = (s, name) => {
  const m = s.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : null;
};

function parseSurebets(html) {
  const out = [];
  if (!html || typeof html !== "string") return out;

  const starts = [];
  let m;
  RE_RECORD.lastIndex = 0;
  while ((m = RE_RECORD.exec(html))) starts.push(m.index);
  if (!starts.length) return out;
  starts.push(html.length);

  for (let i = 0; i < starts.length - 1; i++) {
    const rec = html.slice(starts[i], starts[i + 1]);
    const head = rec.slice(0, 500);

    const id = attr(head, "data-id");
    const signature = attr(head, "data-signature");
    const profitStr = attr(head, "data-profit");
    const startStr = attr(head, "data-start-at");

    const books = all(/data-testid="surebet-leg-bookmaker"[^>]*>([\s\S]*?)<\/a>/g, rec).map((x) => clean(x[1]));
    const odds = all(/data-testid="surebet-leg-odds"[^>]*>([\s\S]*?)<\/a>/g, rec).map((x) => Number(clean(x[1])));
    const events = all(/data-testid="surebet-leg-event"[^>]*>([\s\S]*?)<\/a>/g, rec).map((x) => clean(x[1]));
    const outcomes = all(/<td class="coeff[^"]*">([\s\S]*?)<\/td>/g, rec).map((x) => clean(x[1]));

    if (!books.length) continue;

    const legs = books.map((book, j) => ({
      book,
      odds: Number.isFinite(odds[j]) ? odds[j] : NaN,
      outcome: outcomes[j] || "",
      event: events[j] || "",
    }));

    out.push({
      id: id || signature || `sb-${i}`,
      signature: signature || null,
      event: legs[0].event || "",
      profitPct: profitStr != null && profitStr !== "" ? Number(profitStr) : NaN,
      startAt: startStr ? Number(startStr) : null,
      legs,
    });
  }
  return out;
}

module.exports = { parseSurebets };
