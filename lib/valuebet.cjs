"use strict";
// ЯДРО value-режима: из сырых кэфов oddspapi собирает готовых КАНДИДАТОВ для простановки на betano.bg.
// Соединяет: outcomesByMarket (парс) + findValue (де-виг Pinnacle vs Betano) + toDesc (перевод в формат
// pickOutcome) + сборку URL betano.bg. ЧИСТАЯ логика, без сети. Эталон — Pinnacle, ставим — Betano.
// Тесты в test/valuebet.test.cjs.

const { findValue } = require("./value.cjs");
const { toDesc } = require("./oddsmap.cjs");
const { outcomesByMarket, bookmakerMeta } = require("./oddspapi.cjs");

const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// URL события на betano.bg по eventId (slug косметический — Betano открывает по числовому id).
function betanoBgUrl(eventId, p1, p2) {
  return `https://www.betano.bg/koefitsienti/${slug((p1 || "") + "-" + (p2 || ""))}/${eventId}/`;
}

// Чистый рынок для value: 2–3 исхода, полный матч (де-виг надёжен, pickOutcome умеет ставить).
function isCleanMeta(meta) {
  if (!meta) return false;
  const full = meta.period === "fulltime" || meta.period === "result" || meta.period === "match";
  const len = meta.marketLength || (meta.outcomes || []).length;
  return full && len >= 2 && len <= 3;
}
const cleanMarkets = (mkts, catalog) => Object.fromEntries(Object.entries(mkts).filter(([mid]) => isCleanMeta(catalog.get(String(mid)))));

// Кандидаты по ОДНОЙ паре событий (Pinnacle + Betano одного матча).
//   pinFx/betFx — записи fixture из odds-by-tournaments; catalog — Map(marketId→meta); p1/p2 — команды.
//   cfg: { threshold (доля, по умолч. 0.03), method ("proportional"|"power"), stake, refKey, softKey }.
// Возврат: массив кандидатов { eventId, url, marketId, outcomeId, desc, subject, expectedOdds, valuePct, fairOdds, stake, p1, p2 }.
function candidatesForFixture(pinFx, betFx, catalog, p1, p2, cfg = {}) {
  const { threshold = 0.03, method = "proportional", stake = 0, refKey = "pinnacle", softKey = "betano" } = cfg;
  const pin = cleanMarkets(outcomesByMarket(pinFx, refKey), catalog);
  const bet = cleanMarkets(outcomesByMarket(betFx, softKey), catalog);
  const eventId = bookmakerMeta(betFx, softKey).eventId;
  const out = [];
  for (const v of findValue(pin, bet, { threshold, method })) {
    const d = toDesc(catalog.get(String(v.marketId)), v.outcomeId, p1, p2);
    if (!d) continue; // нет перевода исхода в desc → не ставим (страховка)
    out.push({
      eventId, url: betanoBgUrl(eventId, p1, p2),
      marketId: v.marketId, outcomeId: v.outcomeId,
      desc: d.desc, subject: d.subject,
      expectedOdds: v.bookOdds, valuePct: v.valuePct, fairOdds: v.fairOdds,
      stake, p1, p2,
    });
  }
  return out;
}

// Скан всех общих матчей. pinIndex/betIndex — Map(fixtureId→fixture); namesByFx — Map(fixtureId→{p1,p2}).
// Возврат: все кандидаты, по убыванию value%.
function scanCandidates(pinIndex, betIndex, namesByFx, catalog, cfg = {}) {
  const out = [];
  for (const id of betIndex.keys()) {
    const pinFx = pinIndex.get(id);
    if (!pinFx) continue;
    const nm = namesByFx.get(id) || {};
    out.push(...candidatesForFixture(pinFx, betIndex.get(id), catalog, nm.p1, nm.p2, cfg));
  }
  return out.sort((a, b) => b.valuePct - a.valuePct);
}

// Честная вероятность исхода Betano (catalog meta + outcomeId) из ps3838-эталона (fair = ps3838.fairByEvent[eventId]).
function lookupFair(fair, meta, outcomeId) {
  if (!fair || !meta) return null;
  const out = (meta.outcomes || []).find((o) => String(o.outcomeId) === String(outcomeId));
  if (!out) return null;
  const name = String(out.outcomeName || "").trim();
  const line = meta.handicap;
  if (meta.marketType === "1x2" || meta.marketType === "moneyline") {
    if (!fair.ml) return null;
    if (name === "1") return fair.ml.home;
    if (name === "X") return fair.ml.draw != null ? fair.ml.draw : null;
    if (name === "2") return fair.ml.away;
    return null;
  }
  if (meta.marketType === "totals") {
    const k = fair.tot[String(line)]; if (!k) return null;
    if (/over/i.test(name)) return k.over;
    if (/under/i.test(name)) return k.under;
    return null;
  }
  if (meta.marketType === "spreads") {
    const k = fair.ah[String(line)]; if (!k) return null;
    if (name === "1") return k.home;
    if (name === "2") return k.away;
    return null;
  }
  return null; // прочие рынки ps3838-путь пока не покрывает (1x2/moneyline/тоталы/форы)
}

// Кандидаты по матчу, где эталон — ps3838 (fair = честные вероятности рынков события из ps3838.fairByEvent).
// betFx — fixture Betano из oddspapi; eventId = pinnacleId (он же id события ps3838).
function candidatesVsPinnacleFair(betFx, fair, catalog, p1, p2, eventId, cfg = {}) {
  const { threshold = 0.05, stake = 0, softKey = "betano" } = cfg;
  const bet = cleanMarkets(outcomesByMarket(betFx, softKey), catalog);
  const out = [];
  for (const mid of Object.keys(bet)) {
    const meta = catalog.get(String(mid));
    for (const [oid, price] of Object.entries(bet[mid])) {
      const fp = lookupFair(fair, meta, oid);
      if (!(fp > 0) || !(price > 1)) continue;
      const v = price * fp - 1;
      if (v < threshold) continue;
      const d = toDesc(meta, oid, p1, p2);
      if (!d) continue;
      out.push({ eventId, url: betanoBgUrl(eventId, p1, p2), marketId: mid, outcomeId: oid, desc: d.desc, subject: d.subject, expectedOdds: price, valuePct: v, fairOdds: 1 / fp, stake, p1, p2 });
    }
  }
  return out.sort((a, b) => b.valuePct - a.valuePct);
}

module.exports = { betanoBgUrl, isCleanMeta, candidatesForFixture, scanCandidates, lookupFair, candidatesVsPinnacleFair };
