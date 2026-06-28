"use strict";
// Проверка утверждения владельца: вилки Betano↔Pinnacle регулярны ⟹ value (нога Betano) тоже есть и в плюс.
// По КЭШУ истории (бесплатно): в каждый момент для каждого 2–3-исходного рынка берём ЛУЧШИЙ кэф по каждому
// исходу среди {pinnacle,betano}; если Σ(1/лучший) < 1 — это ВИЛКА. Для исходов, где лучший = Betano, это
// value-нога: ставим её один раз (в первый момент вилки) и сверяем по факту (settlements). Считаем:
// сколько вилок, ROI value-ног Betano, и гарантированный профит вилки (для контроля).
// Запуск: node tools/arb-backtest.cjs <sportId> <from> <to>
const fs = require("fs"); const os = require("os"); const path = require("path");
const api = require("../lib/oddspapi.cjs");
const { devigProportional } = require("../lib/value.cjs");

const KEY = fs.readFileSync(path.join(os.homedir(), ".oddspapi_key"), "utf8").trim();
const sportId = process.argv[2] || "13";
const from = process.argv[3] || "2026-06-20";
const to = process.argv[4] || "2026-06-27";
const CACHE = path.join(os.tmpdir(), "oddspapi-cache");
const skipType = (mt) => !mt || mt.startsWith("player") || /correctscore|exact|score/.test(mt);

function stepAt(series, t) { let v = null; for (const s of series) { const ts = Date.parse(s.createdAt); if (ts <= t) v = (s.active !== false && s.price > 1) ? s.price : null; else break; } return v; }
function seriesOf(node) {
  const out = {};
  for (const [mid, mv] of Object.entries((node && node.markets) || {})) {
    const om = {};
    for (const [oid, ov] of Object.entries(mv.outcomes || {})) { const a = ov && ov.players && ov.players["0"]; if (Array.isArray(a) && a.length) om[oid] = a.slice().sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt)); }
    if (Object.keys(om).length) out[mid] = om;
  }
  return out;
}
function resultsOf(se) { const out = {}; for (const [mid, mv] of Object.entries((se && se.markets) || {})) { out[mid] = {}; for (const [oid, ov] of Object.entries(mv.outcomes || {})) { const r = ov && ov.players && ov.players["0"] && ov.players["0"].result; if (r) out[mid][oid] = r; } } return out; }

(async () => {
  const cat = api.catalogFromMarkets(await api.markets(sportId, KEY));
  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  let fxAll = []; // fixtures эндпоинт требует диапазон <10 дней → берём кусками по 9
  for (let cur = from; cur <= to; cur = addDays(cur, 9)) {
    const end = addDays(cur, 8) < to ? addDays(cur, 8) : to;
    fxAll = fxAll.concat(api.asList(await api.fixtures(sportId, cur, end, KEY)));
  }
  const fx = fxAll.filter((f) => f.statusName === "Finished");
  const startMap = new Map(fx.map((f) => [f.fixtureId, Date.parse(f.startTime)]));

  const legBets = []; // {odds, win} — ноги Betano из вилок
  let arbCount = 0, arbProfitSum = 0, matches = 0, scanned = 0;
  for (const f of fx) {
    const hp = path.join(CACHE, `${f.fixtureId}.ho.json`), sp = path.join(CACHE, `${f.fixtureId}.se.json`);
    if (!fs.existsSync(hp) || !fs.existsSync(sp)) continue;
    let ho, se; try { ho = JSON.parse(fs.readFileSync(hp, "utf8")); se = JSON.parse(fs.readFileSync(sp, "utf8")); } catch (_) { continue; }
    if (!ho.bookmakers) continue;
    matches++;
    const startMs = startMap.get(f.fixtureId) || Infinity;
    const pin = seriesOf(ho.bookmakers.pinnacle), bet = seriesOf(ho.bookmakers.betano), res = resultsOf(se);

    for (const mid of Object.keys(bet)) {
      const meta = cat.get(String(mid));
      if (!meta || skipType(meta.marketType) || !(meta.marketLength >= 2 && meta.marketLength <= 3)) continue;
      if (!pin[mid] || !res[mid]) continue;
      const oids = (meta.outcomes || []).map((o) => String(o.outcomeId)).filter((o) => pin[mid][o] || bet[mid][o]);
      if (oids.length !== meta.marketLength) continue; // нужен ПОЛНЫЙ набор исходов
      scanned++;
      const times = new Set();
      for (const o of oids) { for (const s of (pin[mid][o] || [])) { const t = Date.parse(s.createdAt); if (t <= startMs) times.add(t); } for (const s of (bet[mid][o] || [])) { const t = Date.parse(s.createdAt); if (t <= startMs) times.add(t); } }
      const placed = {}; // oid → уже поставили ногу
      for (const t of [...times].sort((a, b) => a - b)) {
        const best = {}, who = {}, pp = {};
        let ok = true;
        for (const o of oids) {
          pp[o] = pin[mid][o] ? stepAt(pin[mid][o], t) : null;
          const bp = bet[mid][o] ? stepAt(bet[mid][o], t) : null;
          if (!(pp[o] > 1) && !(bp > 1)) { ok = false; break; }
          best[o] = Math.max(pp[o] || 0, bp || 0);
          who[o] = (bp || 0) >= (pp[o] || 0) ? "bet" : "pin";
        }
        if (!ok) continue;
        const sumInv = oids.reduce((a, o) => a + 1 / best[o], 0);
        if (sumInv < 1) { // ВИЛКА
          arbCount++; arbProfitSum += (1 / sumInv - 1);
          // value% ноги = кэф Betano × честная вер-ть (де-виг Pinnacle в этот же момент) − 1
          const pinArr = oids.map((o) => pp[o]);
          const probs = pinArr.every((x) => x > 1) ? devigProportional(pinArr) : null;
          for (let i = 0; i < oids.length; i++) {
            const o = oids[i];
            if (who[o] === "bet" && !placed[o]) {
              const r = res[mid][o];
              if (r === "WIN" || r === "LOSE") {
                const value = probs ? best[o] * probs[i] - 1 : null;
                legBets.push({ odds: best[o], win: r === "WIN", value }); placed[o] = true;
              }
            }
          }
        }
      }
    }
  }

  const roi = (a) => a.length ? a.reduce((s, x) => s + (x.win ? x.odds - 1 : -1), 0) / a.length : 0;
  const wr = (a) => a.length ? a.filter((x) => x.win).length / a.length : 0;
  console.log(`Матчей из кэша: ${matches} | рынков просмотрено: ${scanned}`);
  console.log(`ВИЛОК-моментов найдено: ${arbCount} | средний гарант. профит вилки: ${arbCount ? (arbProfitSum / arbCount * 100).toFixed(2) : 0}%`);
  console.log(`Value-ног Betano (из вилок): ${legBets.length} | winrate=${(wr(legBets) * 100).toFixed(1)}% | ROI=${(roi(legBets) * 100).toFixed(1)}%\n`);
  // РАЗМЕР перевеса: насколько крупный value у найденных вилок-ног
  const sized = legBets.filter((b) => b.value != null);
  const vs = sized.map((b) => b.value).sort((a, b) => a - b);
  if (vs.length) console.log(`Размер value ног: min=${(vs[0] * 100).toFixed(1)}% медиана=${(vs[Math.floor(vs.length / 2)] * 100).toFixed(1)}% max=${(vs[vs.length - 1] * 100).toFixed(1)}%`);
  console.log("Распределение по размеру value:");
  for (const [lo, hi] of [[0, 0.03], [0.03, 0.05], [0.05, 0.10], [0.10, 1]]) {
    const a = sized.filter((b) => b.value >= lo && b.value < hi);
    console.log(`  ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%:  n=${String(a.length).padStart(3)}  winrate=${(wr(a) * 100).toFixed(0)}%  ROI=${(roi(a) * 100).toFixed(1)}%`);
  }
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
