"use strict";
// Сканер value-режима: один проход опроса oddspapi (Pinnacle-эталон + Betano) по выбранным лигам →
// готовые кандидаты для простановки (через valuebet.scanCandidates). Тонкая I/O-обёртка над клиентом и
// чистым ядром; пере­используется и в разведке, и в боевом цикле. Ключ API передаётся аргументом.

const api = require("./oddspapi.cjs");
const { scanCandidates } = require("./valuebet.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// odds-by-tournaments: максимум 5 турниров за запрос → бьём на пятёрки.
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
const ds = (d) => d.toISOString().slice(0, 10);

// Один проход скана. cfg: { sportId, tournamentIds (массив/строка), threshold, method, stake, toDays }.
// Возврат: кандидаты (по убыванию value%). refKey/softKey фиксированы: эталон pinnacle, ставим betano.
async function scanOnce(apiKey, cfg = {}) {
  const { sportId = "10", tournamentIds = [], threshold = 0.03, method = "proportional", stake = 0, toDays = 9 } = cfg;
  const tids = (Array.isArray(tournamentIds) ? tournamentIds : String(tournamentIds).split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!tids.length) return [];

  const catalog = api.catalogFromMarkets(await api.markets(sportId, apiKey));
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

  return scanCandidates(pin, bet, namesByFx, catalog, { threshold, method, stake });
}

module.exports = { scanOnce, chunk };
