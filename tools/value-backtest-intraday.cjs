"use strict";
// ИНТРАДЕЙ-БЭКТЕСТ value: ловим ЛАГ Betano против движения Pinnacle ВО ВРЕМЕНИ (настоящий edge value-беттинга).
// По временным рядам обеих контор: в каждый момент изменения кэфа считаем честную линию Pinnacle НА ТОТ ЖЕ
// момент; если кэф Betano ≥ честный×(1+порог) — это первый «бет» на исход (ставим один раз, в момент появления
// value), settи́м по факту. Кэш в /tmp/oddspapi-cache (historical-odds free; settlements billable → не пере-тратим).
// Запуск: node tools/value-backtest-intraday.cjs <sportId> <tournamentIds> <from> <to> [maxMatches]
const fs = require("fs"); const os = require("os"); const path = require("path");
const api = require("../lib/oddspapi.cjs");
const { devigProportional, devigPower } = require("../lib/value.cjs");

const KEY = fs.readFileSync(path.join(os.homedir(), ".oddspapi_key"), "utf8").trim();
const sportId = process.argv[2] || "13";
const tournamentIds = (process.argv[3] || "109,1036").split(",");
const from = process.argv[4] || "2026-06-20";
const to = process.argv[5] || "2026-06-27";
const maxMatches = Number(process.argv[6] || "60");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WHITELIST = new Set(["moneyline", "1x2", "spreads", "totals", "drawnobet", "doublechance"]);
const THRESHOLDS = [0.01, 0.02, 0.03, 0.05];
const CACHE = path.join(os.tmpdir(), "oddspapi-cache");
fs.mkdirSync(CACHE, { recursive: true });

async function cached(kind, fid, fetchFn) {
  const p = path.join(CACHE, `${fid}.${kind}.json`);
  if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) {} }
  const data = await fetchFn();
  try { fs.writeFileSync(p, JSON.stringify(data)); } catch (_) {}
  return data;
}
// цена конторы, активная в момент t (последний снимок с createdAt<=t, active!==false, price>1) или null
function stepAt(series, t) {
  let v = null;
  for (const s of series) { const ts = Date.parse(s.createdAt); if (ts <= t) { if (s.active !== false && s.price > 1) v = s.price; else v = null; } else break; }
  return v;
}
// нормализуем узел historical-odds конторы → { marketId: { outcomeId: [ {createdAt,price,active} ... ] } }
function seriesOf(node, cat) {
  const out = {};
  for (const [mid, mv] of Object.entries((node && node.markets) || {})) {
    const meta = cat.get(String(mid));
    if (!meta || !WHITELIST.has(meta.marketType)) continue;
    const om = {};
    for (const [oid, ov] of Object.entries(mv.outcomes || {})) {
      const arr = ov && ov.players && ov.players["0"];
      if (Array.isArray(arr) && arr.length) om[oid] = arr.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    }
    if (Object.keys(om).length) out[mid] = om;
  }
  return out;
}
function resultsOf(se) {
  const out = {};
  for (const [mid, mv] of Object.entries((se && se.markets) || {})) {
    out[mid] = {};
    for (const [oid, ov] of Object.entries(mv.outcomes || {})) { const r = ov && ov.players && ov.players["0"] && ov.players["0"].result; if (r) out[mid][oid] = r; }
  }
  return out;
}

(async () => {
  const cat = api.catalogFromMarkets(await cached("markets" + sportId, "_cat", () => api.markets(sportId, KEY)));
  const fxAll = api.asList(await cached("fx" + sportId + from + to, "_fx", () => api.fixtures(sportId, from, to, KEY)));
  const fx = fxAll.filter((f) => tournamentIds.includes(String(f.tournamentId)) && f.statusName === "Finished").slice(0, maxMatches);
  console.log(`Завершённых матчей: ${fx.length}\n`);

  // bets[method][thrIndex] = [ {odds, win} ]
  const bets = { prop: THRESHOLDS.map(() => []), pow: THRESHOLDS.map(() => []) };
  let done = 0, newSettle = 0;
  for (const f of fx) {
    const startMs = Date.parse(f.startTime);
    let ho, se;
    try {
      ho = await cached("ho", f.fixtureId, async () => { const d = await api.apiGet("/historical-odds", { fixtureId: f.fixtureId, bookmakers: "pinnacle,betano" }, KEY); await sleep(120); return d; });
      const sePath = path.join(CACHE, `${f.fixtureId}.se.json`);
      const fresh = !fs.existsSync(sePath);
      se = await cached("se", f.fixtureId, () => api.apiGet("/settlements", { fixtureId: f.fixtureId }, KEY));
      if (fresh) { newSettle++; await sleep(150); }
    } catch (e) { continue; }
    if (!ho || !ho.bookmakers || ho.error || !se || se.error) continue;
    const pin = seriesOf(ho.bookmakers.pinnacle, cat);
    const bet = seriesOf(ho.bookmakers.betano, cat);
    const res = resultsOf(se);

    for (const mid of Object.keys(bet)) {
      if (!pin[mid] || !res[mid]) continue;
      const pinOids = Object.keys(pin[mid]);
      if (pinOids.length < 2) continue;
      // таймлайн рынка: все моменты изменений (pin+bet), только прематч (<= старт)
      const times = new Set();
      for (const oid of pinOids) for (const s of pin[mid][oid]) { const t = Date.parse(s.createdAt); if (t <= startMs) times.add(t); }
      for (const oid of Object.keys(bet[mid])) for (const s of bet[mid][oid]) { const t = Date.parse(s.createdAt); if (t <= startMs) times.add(t); }
      const timeline = [...times].sort((a, b) => a - b);

      for (const method of ["prop", "pow"]) {
        const devig = method === "prop" ? devigProportional : devigPower;
        // для каждого исхода конторы с фактом — ищем ПЕРВЫЙ момент value>=порога (по каждому порогу)
        for (const boid of Object.keys(bet[mid])) {
          const r = res[mid][boid];
          if ((r !== "WIN" && r !== "LOSE") || !pin[mid][boid]) continue;
          const placed = THRESHOLDS.map(() => false);
          for (const t of timeline) {
            const pinPrices = pinOids.map((o) => stepAt(pin[mid][o], t));
            if (pinPrices.some((p) => !(p > 1))) continue; // неполный рынок Pinnacle в этот момент
            const probs = devig(pinPrices);
            const fairProb = probs[pinOids.indexOf(boid)];
            const bp = stepAt(bet[mid][boid], t);
            if (!(bp > 1) || !(fairProb > 0)) continue;
            const v = bp * fairProb - 1;
            THRESHOLDS.forEach((thr, ti) => { if (!placed[ti] && v >= thr) { placed[ti] = true; bets[method][ti].push({ odds: bp, win: r === "WIN" }); } });
            if (placed.every(Boolean)) break;
          }
        }
      }
    }
    done++;
  }

  console.log(`Обработано: ${done} матчей | новых settlements-запросов: ${newSettle}\n`);
  const roi = (a) => a.length ? a.reduce((s, x) => s + (x.win ? x.odds - 1 : -1), 0) / a.length : 0;
  const wr = (a) => a.length ? a.filter((x) => x.win).length / a.length : 0;
  for (const method of ["prop", "pow"]) {
    console.log(`=== ДЕ-ВИГ ${method === "prop" ? "пропорциональный" : "степенной"}: ставим при ПЕРВОМ появлении value во времени ===`);
    THRESHOLDS.forEach((thr, ti) => {
      const a = bets[method][ti];
      console.log(`  порог ≥${(thr * 100).toFixed(0)}%:  ставок=${String(a.length).padStart(4)}  winrate=${(wr(a) * 100).toFixed(1).padStart(5)}%  ROI=${(roi(a) * 100).toFixed(1).padStart(6)}%`);
    });
    console.log("");
  }
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
