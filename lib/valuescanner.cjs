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

// ВСЕ активные лиги спорта (если в настройках лиги не заданы → сканируем все). Кэш 3ч; только турниры
// с ближайшими/будущими матчами, по убыванию активности, до cap (защита квоты). Меняется редко.
const _tids = new Map(); // sportId → {ids, ts}
async function getTournamentIds(sportId, apiKey, cap = 60) {
  const now = Date.now();
  const c = _tids.get(String(sportId));
  if (c && now - c.ts < 3 * 3600e3) return c.ids;
  const ids = api.asList(await api.tournaments(sportId, apiKey))
    .filter((t) => ((t.upcomingFixtures || 0) + (t.futureFixtures || 0)) > 0)
    .sort((a, b) => ((b.upcomingFixtures || 0) + (b.futureFixtures || 0)) - ((a.upcomingFixtures || 0) + (a.futureFixtures || 0)))
    .slice(0, cap)
    .map((t) => String(t.tournamentId));
  _tids.set(String(sportId), { ids, ts: now });
  return ids;
}

// Один проход скана. cfg: { sportId, tournamentIds (массив/строка), threshold, method, stake, toDays }.
// Возврат: кандидаты (по убыванию value%). refKey/softKey фиксированы: эталон pinnacle, ставим betano.
async function scanOnce(apiKey, cfg = {}) {
  const { sportId = "10", tournamentIds = [], exclude = [], threshold = 0.03, method = "proportional", stake = 0, toDays = 9, markets = [], oddsMin = 0, oddsMax = 0, onDiag } = cfg;
  const D = onDiag || (() => {});
  if (!apiKey) { D({ step: "ключ", error: "не задан ключ oddspapi" }); return []; }
  let tids = (Array.isArray(tournamentIds) ? tournamentIds : String(tournamentIds).split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!tids.length) { // лиги явно не заданы → ВСЕ активные (авто, кэш 3ч → новые подхватываются) минус исключённые
    try { tids = await getTournamentIds(sportId, apiKey); }
    catch (e) { D({ step: "лиги (oddspapi /tournaments)", error: e.message }); return []; }
    if (exclude.length) { const ex = new Set(exclude.map(String)); tids = tids.filter((id) => !ex.has(String(id))); }
  }
  D({ step: "лиги", n: tids.length });
  if (!tids.length) return [];

  let catalog;
  try { catalog = await getCatalog(sportId, apiKey); }
  catch (e) { D({ step: "каталог рынков (oddspapi /markets)", error: e.message }); return []; }
  // имена команд (для subject + slug URL) — по ближайшим матчам в окне дат
  const today = new Date();
  const namesByFx = new Map();
  try {
    for (const f of api.asList(await api.fixtures(sportId, ds(today), ds(new Date(today.getTime() + toDays * 864e5)), apiKey))) {
      namesByFx.set(f.fixtureId, { p1: f.participant1Name, p2: f.participant2Name });
    }
  } catch (e) { D({ step: "матчи (oddspapi /fixtures)", error: e.message }); return []; }
  D({ step: "матчи", n: namesByFx.size });
  // кэфы по конторе: ≤5 турниров/запрос, с паузой под rate-limit (~0.4с)
  const fetchBook = async (bk) => {
    const idx = new Map();
    for (const grp of chunk(tids, 5)) {
      for (const f of api.asList(await api.oddsByTournaments(bk, grp, apiKey))) idx.set(f.fixtureId, f);
      await sleep(500);
    }
    return idx;
  };
  let pin, bet;
  try { pin = await fetchBook("pinnacle"); await sleep(500); bet = await fetchBook("betano"); }
  catch (e) { D({ step: "кэфы (oddspapi /odds-by-tournaments)", error: e.message }); return []; }
  D({ step: "кэфы", pinnacle: pin.size, betano: bet.size });

  const res = scanCandidates(pin, bet, namesByFx, catalog, { threshold, method, stake, markets, oddsMin, oddsMax });
  D({ step: "итог", cand: res.length, threshold });
  return res;
}

// Один проход скана с эталоном ps3838 (Pinnacle напрямую) вместо oddspapi-Pinnacle. Матч Betano↔ps3838
// ТОЧНЫЙ по pinnacleId. cfg: { sportId (oddspapi), psSportId (ps3838), tournamentIds, threshold, stake, toDays }.
async function scanOnceVsPs3838(oddsApiKey, ps3838Auth, cfg = {}) {
  const { sportId = "10", psSportId = "29", tournamentIds = [], exclude = [], threshold = 0.05, stake = 0, toDays = 9, markets = [], oddsMin = 0, oddsMax = 0, onDiag } = cfg;
  const D = onDiag || (() => {}); // пошаговая диагностика: каждый этап → числа ответа, ошибка → на каком шаге упало
  if (!oddsApiKey) { D({ step: "ключ", error: "не задан ключ oddspapi" }); return []; }
  if (!ps3838Auth) { D({ step: "ключ", error: "не задан ключ ps3838 (эталон Pinnacle)" }); return []; }

  let tids = (Array.isArray(tournamentIds) ? tournamentIds : String(tournamentIds).split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!tids.length) { // ВСЕ активные лиги спорта (авто, кэш 3ч) минус исключённые
    try { tids = await getTournamentIds(sportId, oddsApiKey); }
    catch (e) { D({ step: "лиги (oddspapi /tournaments)", error: e.message }); return []; }
    if (exclude.length) { const ex = new Set(exclude.map(String)); tids = tids.filter((id) => !ex.has(String(id))); }
  }
  D({ step: "лиги", n: tids.length });
  if (!tids.length) return [];

  let catalog;
  try { catalog = await getCatalog(sportId, oddsApiKey); }
  catch (e) { D({ step: "каталог рынков (oddspapi /markets)", error: e.message }); return []; }

  const today = new Date();
  const fxMap = new Map(); // fixtureId → {pinId, p1, p2}
  let withPin = 0;
  try {
    for (const f of api.asList(await api.fixtures(sportId, ds(today), ds(new Date(today.getTime() + toDays * 864e5)), oddsApiKey))) {
      const pinId = (f.externalProviders || {}).pinnacleId; if (pinId) withPin++;
      fxMap.set(f.fixtureId, { pinId, p1: f.participant1Name, p2: f.participant2Name });
    }
  } catch (e) { D({ step: "матчи (oddspapi /fixtures)", error: e.message }); return []; }
  D({ step: "матчи", n: fxMap.size, withPin }); // withPin = сколько матчей с pinnacleId (по нему матчим ps3838)

  const bet = new Map();
  try {
    for (const grp of chunk(tids, 5)) { for (const f of api.asList(await api.oddsByTournaments("betano", grp, oddsApiKey))) bet.set(f.fixtureId, f); await sleep(500); }
  } catch (e) { D({ step: "кэфы Betano (oddspapi /odds-by-tournaments)", error: e.message }); return []; }
  D({ step: "кэфы Betano", n: bet.size });

  let fair;
  try { fair = ps.fairByEvent(await ps.odds(psSportId, ps3838Auth)); } // эталон Pinnacle из ps3838 (только чтение)
  catch (e) { D({ step: "эталон Pinnacle (ps3838 /odds)", error: e.message }); return []; }
  D({ step: "эталон ps3838", n: fair.size });

  const out = [];
  let matched = 0, best = null; // matched = betano-матчи с pinId И эталоном ps3838; best = лучший value (даже < порога)
  for (const [fid, betFx] of bet) {
    const meta = fxMap.get(fid);
    if (!meta || !meta.pinId) continue;
    const f = fair.get(String(meta.pinId));
    if (!f) continue;
    matched++;
    const eid = api.bookmakerMeta(betFx, "betano").eventId;
    const c = candidatesVsPinnacleFair(betFx, f, catalog, meta.p1, meta.p2, eid, { threshold, stake, markets, oddsMin, oddsMax });
    if (c[0] && (best == null || c[0].valuePct > best)) best = c[0].valuePct;
    out.push(...c);
  }
  D({ step: "итог", matched, cand: out.length, best, threshold }); // matched=0 → нет пересечения Betano↔ps3838; matched>0,cand=0 → value ниже порога (best покажет насколько)
  return out.sort((a, b) => b.valuePct - a.valuePct);
}

// МУЛЬТИ-СПОРТ скан. cfg: { sports:[{oa,ps,leagues}], refSource ("ps3838"|"oddspapi"), threshold, stake,
// markets, oddsMin, oddsMax }. Для каждого включённого спорта зовём нужный сканер с его лигами и id.
async function scanAll(oddsApiKey, ps3838Auth, cfg = {}) {
  const { sports = [], refSource = "ps3838", threshold = 0.05, stake = 0, markets = [], oddsMin = 0, oddsMax = 0, onDiag } = cfg;
  const out = [];
  let enabled = 0;
  for (const s of sports) {
    if (!s || s.on === false) continue; // включённые спорты → ВСЕ их лиги (минус exclude), без ручного списка
    enabled++;
    const tag = s.key || s.oa; // помечаем диагностику спортом
    const diag = onDiag ? (d) => onDiag({ sport: tag, ...d }) : undefined;
    const base = { exclude: s.exclude || [], threshold, stake, markets, oddsMin, oddsMax, onDiag: diag };
    try {
      const c = refSource === "ps3838"
        ? await scanOnceVsPs3838(oddsApiKey, ps3838Auth, { ...base, sportId: s.oa, psSportId: s.ps })
        : await scanOnce(oddsApiKey, { ...base, sportId: s.oa });
      out.push(...c);
    } catch (e) { if (diag) diag({ error: e.message }); } // раньше глоталось молча — теперь видно причину
  }
  if (onDiag) onDiag({ enabled }); // сколько спортов вообще включено (0 = никто не включён в панели)
  return out.sort((a, b) => b.valuePct - a.valuePct);
}

module.exports = { scanOnce, scanOnceVsPs3838, scanAll, chunk };
