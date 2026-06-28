"use strict";
// Сканер value-режима: один проход опроса oddspapi (Pinnacle-эталон + Betano) по выбранным лигам →
// готовые кандидаты для простановки (через valuebet.scanCandidates). Тонкая I/O-обёртка над клиентом и
// чистым ядром; пере­используется и в разведке, и в боевом цикле. Ключ API передаётся аргументом.

const api = require("./oddspapi.cjs");
const ps = require("./ps3838.cjs");
const { scanCandidates, candidatesVsPinnacleFair } = require("./valuebet.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// odds-by-tournaments: максимум 5 турниров за запрос → бьём на пятёрки.
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
const ds = (d) => d.toISOString().slice(0, 10);

// Каталог рынков меняется редко (9МБ) — кэшируем на сессию (TTL 6ч), чтобы не тянуть каждый скан.
let _cat = { sportId: null, cat: null, ts: 0 };
async function getCatalog(sportId, apiKey) {
  const now = Date.now();
  if (_cat.sportId === String(sportId) && _cat.cat && now - _cat.ts < 6 * 3600e3) return _cat.cat;
  const cat = api.catalogFromMarkets(await api.markets(sportId, apiKey));
  _cat = { sportId: String(sportId), cat, ts: now };
  return cat;
}

// Один проход скана. cfg: { sportId, tournamentIds (массив/строка), threshold, method, stake, toDays }.
// Возврат: кандидаты (по убыванию value%). refKey/softKey фиксированы: эталон pinnacle, ставим betano.
async function scanOnce(apiKey, cfg = {}) {
  const { sportId = "10", tournamentIds = [], threshold = 0.03, method = "proportional", stake = 0, toDays = 9, markets = [], oddsMin = 0, oddsMax = 0 } = cfg;
  const tids = (Array.isArray(tournamentIds) ? tournamentIds : String(tournamentIds).split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!tids.length) return [];

  const catalog = await getCatalog(sportId, apiKey);
  // имена команд (для subject + slug URL) — по ближайшим матчам в окне дат
  const today = new Date();
  const namesByFx = new Map();
  for (const f of api.asList(await api.fixtures(sportId, ds(today), ds(new Date(today.getTime() + toDays * 864e5)), apiKey))) {
    namesByFx.set(f.fixtureId, { p1: f.participant1Name, p2: f.participant2Name });
  }
  // кэфы по конторе: ≤5 турниров/запрос, с паузой под rate-limit (~0.4с)
  const fetchBook = async (bk) => {
    const idx = new Map();
    for (const grp of chunk(tids, 5)) {
      for (const f of api.asList(await api.oddsByTournaments(bk, grp, apiKey))) idx.set(f.fixtureId, f);
      await sleep(500);
    }
    return idx;
  };
  const pin = await fetchBook("pinnacle");
  await sleep(500);
  const bet = await fetchBook("betano");

  return scanCandidates(pin, bet, namesByFx, catalog, { threshold, method, stake, markets, oddsMin, oddsMax });
}

// Один проход скана с эталоном ps3838 (Pinnacle напрямую) вместо oddspapi-Pinnacle. Матч Betano↔ps3838
// ТОЧНЫЙ по pinnacleId. cfg: { sportId (oddspapi), psSportId (ps3838), tournamentIds, threshold, stake, toDays }.
async function scanOnceVsPs3838(oddsApiKey, ps3838Auth, cfg = {}) {
  const { sportId = "10", psSportId = "29", tournamentIds = [], threshold = 0.05, stake = 0, toDays = 9, markets = [], oddsMin = 0, oddsMax = 0 } = cfg;
  const tids = (Array.isArray(tournamentIds) ? tournamentIds : String(tournamentIds).split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!tids.length || !ps3838Auth) return [];

  const catalog = await getCatalog(sportId, oddsApiKey);
  const today = new Date();
  const fxMap = new Map(); // fixtureId → {pinId, p1, p2}
  for (const f of api.asList(await api.fixtures(sportId, ds(today), ds(new Date(today.getTime() + toDays * 864e5)), oddsApiKey))) {
    fxMap.set(f.fixtureId, { pinId: (f.externalProviders || {}).pinnacleId, p1: f.participant1Name, p2: f.participant2Name });
  }
  const bet = new Map();
  for (const grp of chunk(tids, 5)) { for (const f of api.asList(await api.oddsByTournaments("betano", grp, oddsApiKey))) bet.set(f.fixtureId, f); await sleep(500); }
  const fair = ps.fairByEvent(await ps.odds(psSportId, ps3838Auth)); // эталон Pinnacle из ps3838 (только чтение)

  const out = [];
  for (const [fid, betFx] of bet) {
    const meta = fxMap.get(fid);
    if (!meta || !meta.pinId) continue;
    const f = fair.get(String(meta.pinId));
    if (!f) continue;
    const eid = api.bookmakerMeta(betFx, "betano").eventId;
    out.push(...candidatesVsPinnacleFair(betFx, f, catalog, meta.p1, meta.p2, eid, { threshold, stake, markets, oddsMin, oddsMax }));
  }
  return out.sort((a, b) => b.valuePct - a.valuePct);
}

// МУЛЬТИ-СПОРТ скан. cfg: { sports:[{oa,ps,leagues}], refSource ("ps3838"|"oddspapi"), threshold, stake,
// markets, oddsMin, oddsMax }. Для каждого включённого спорта зовём нужный сканер с его лигами и id.
async function scanAll(oddsApiKey, ps3838Auth, cfg = {}) {
  const { sports = [], refSource = "ps3838", threshold = 0.05, stake = 0, markets = [], oddsMin = 0, oddsMax = 0 } = cfg;
  const out = [];
  for (const s of sports) {
    if (!s || s.on === false || !s.leagues) continue;
    const base = { tournamentIds: s.leagues, threshold, stake, markets, oddsMin, oddsMax };
    try {
      const c = refSource === "ps3838"
        ? await scanOnceVsPs3838(oddsApiKey, ps3838Auth, { ...base, sportId: s.oa, psSportId: s.ps })
        : await scanOnce(oddsApiKey, { ...base, sportId: s.oa });
      out.push(...c);
    } catch (e) { /* один спорт упал — не валим весь скан */ }
  }
  return out.sort((a, b) => b.valuePct - a.valuePct);
}

module.exports = { scanOnce, scanOnceVsPs3838, scanAll, chunk };
