"use strict";
// БЭКТЕСТ value-стратегии на ИСТОРИИ (free: historical-odds квоту не тратит; settlements — billable).
// Для завершённых матчей берём ЗАКРЫВАЮЩИЕ кэфы (последний снимок до старта), считаем value (де-виг
// Pinnacle vs Betano) обоими методами и сверяем с фактом (settlements WIN/LOSE). Главный вопрос:
// РАСТЁТ ли реальный ROI с ростом value (тогда сигнал рабочий). Ставит НИЧЕГО — только считает.
// Запуск: node tools/value-backtest.cjs <sportId> <tournamentIds> <from> <to> [maxMatches]
const fs = require("fs"); const os = require("os"); const path = require("path");
const api = require("../lib/oddspapi.cjs");
const { devigProportional, devigPower } = require("../lib/value.cjs");

const KEY = fs.readFileSync(path.join(os.homedir(), ".oddspapi_key"), "utf8").trim();
const sportId = process.argv[2] || "13";
const tournamentIds = (process.argv[3] || "109,1036").split(",");
const from = process.argv[4] || "2026-06-22";
const to = process.argv[5] || "2026-06-27";
const maxMatches = Number(process.argv[6] || "50");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WHITELIST = new Set(["moneyline", "1x2", "spreads", "totals", "drawnobet", "doublechance"]);

// закрывающие кэфы конторы из historical-odds: последний снимок с createdAt <= startMs.
function closingOdds(node, startMs, cat) {
  const out = {};
  for (const [mid, mv] of Object.entries((node && node.markets) || {})) {
    const meta = cat.get(String(mid));
    if (!meta || !WHITELIST.has(meta.marketType)) continue;
    const om = {};
    for (const [oid, ov] of Object.entries(mv.outcomes || {})) {
      const arr = ov && ov.players && ov.players["0"];
      if (!Array.isArray(arr) || !arr.length) continue;
      let chosen = null;
      for (const s of arr) { const t = Date.parse(s.createdAt); if (t <= startMs && (!chosen || t > Date.parse(chosen.createdAt))) chosen = s; }
      if (!chosen) chosen = arr[arr.length - 1];
      if (chosen && chosen.active !== false && chosen.price > 1) om[oid] = chosen.price;
    }
    if (Object.keys(om).length) out[mid] = om;
  }
  return out;
}
function resultsOf(se) {
  const out = {};
  for (const [mid, mv] of Object.entries((se && se.markets) || {})) {
    out[mid] = {};
    for (const [oid, ov] of Object.entries(mv.outcomes || {})) {
      const r = ov && ov.players && ov.players["0"] && ov.players["0"].result;
      if (r) out[mid][oid] = r;
    }
  }
  return out;
}

(async () => {
  const cat = api.catalogFromMarkets(await api.markets(sportId, KEY));
  const fx = api.asList(await api.fixtures(sportId, from, to, KEY))
    .filter((f) => tournamentIds.includes(String(f.tournamentId)) && f.statusName === "Finished");
  console.log(`Завершённых матчей: ${fx.length} | беру до ${maxMatches}\n`);

  const samples = []; // {vP, vK, odds, win}
  let done = 0;
  for (const f of fx.slice(0, maxMatches)) {
    const startMs = Date.parse(f.startTime);
    let ho, se;
    try {
      ho = await api.apiGet("/historical-odds", { fixtureId: f.fixtureId, bookmakers: "pinnacle,betano" }, KEY);
      await sleep(150);
      se = await api.apiGet("/settlements", { fixtureId: f.fixtureId }, KEY);
    } catch (e) { continue; }
    if (!ho || !ho.bookmakers || ho.error || !se || se.error) continue;
    const pin = closingOdds(ho.bookmakers.pinnacle, startMs, cat);
    const bet = closingOdds(ho.bookmakers.betano, startMs, cat);
    const res = resultsOf(se);
    for (const mid of Object.keys(bet)) {
      if (!pin[mid] || !res[mid]) continue;
      const oids = Object.keys(pin[mid]);
      if (oids.length < 2) continue;
      const odds = oids.map((o) => pin[mid][o]);
      if (odds.some((o) => !(o > 1))) continue;
      const pProp = devigProportional(odds), pPow = devigPower(odds);
      oids.forEach((oid, i) => {
        const b = bet[mid][oid], r = res[mid][oid];
        if (!(b > 1) || (r !== "WIN" && r !== "LOSE")) return;
        samples.push({ vP: b * pProp[i] - 1, vK: b * pPow[i] - 1, odds: b, win: r === "WIN" });
      });
    }
    done++;
    await sleep(150);
  }

  console.log(`Обработано матчей: ${done} | ставок-семплов: ${samples.length}\n`);
  const roi = (arr) => arr.length ? arr.reduce((a, s) => a + (s.win ? s.odds - 1 : -1), 0) / arr.length : 0;
  const wr = (arr) => arr.length ? arr.filter((s) => s.win).length / arr.length : 0;

  // распределение по корзинам value (метод: пропорциональный)
  const bins = [[-1, -0.05], [-0.05, -0.02], [-0.02, 0], [0, 0.02], [0.02, 0.05], [0.05, 1]];
  const label = (lo, hi) => `${(lo * 100).toFixed(0)}%..${(hi * 100).toFixed(0)}%`;
  for (const method of ["vP", "vK"]) {
    console.log(`=== ДЕ-ВИГ: ${method === "vP" ? "пропорциональный" : "степенной"} — ROI по корзинам value ===`);
    for (const [lo, hi] of bins) {
      const a = samples.filter((s) => s[method] >= lo && s[method] < hi);
      console.log(`  value ${label(lo, hi).padEnd(12)} n=${String(a.length).padStart(4)}  winrate=${(wr(a) * 100).toFixed(1).padStart(5)}%  ROI=${(roi(a) * 100).toFixed(1).padStart(6)}%`);
    }
    const pos = samples.filter((s) => s[method] > 0);
    const pos2 = samples.filter((s) => s[method] >= 0.02);
    console.log(`  --> value>0:  n=${pos.length}  ROI=${(roi(pos) * 100).toFixed(1)}%   | value>=2%: n=${pos2.length}  ROI=${(roi(pos2) * 100).toFixed(1)}%`);
    console.log("");
  }
  console.log(`КОНТРОЛЬ — ROI всех ставок (≈ −маржа Betano): ${(roi(samples) * 100).toFixed(1)}% (n=${samples.length})`);
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
