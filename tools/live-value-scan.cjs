"use strict";
// ИЗМЕРИТЕЛЬ live-value (go/no-go), НЕ ставит. СИНХРОННЫЙ 1с-опрос обоих плеч через снимки (lib/bettingco.cjs):
// инициализация раз (GetBookmakerData, лимит 1/5с) → цикл: ПАРАЛЛЕЛЬНО GetBookmakerSnapshots по Betano+Pinnacle
// каждую ~1с, применяем дельты, матчим события, считаем value по чистым 2-way рынкам полного матча. Логируем
// новые сигналы + их живучесть; в строке цикла — рассинхрон плеч (мс) для контроля синхронности. Сводка по Ctrl+C.
//
// Ключ: env BETTINGCO_KEY или ~/.bettingco_key. Параметры (env): THRESHOLD (доля, деф 0.03), INTERVAL_MS (деф 1000),
// DURATION_MIN (деф 0 = бесконечно).
const fs = require("fs"), os = require("os"), path = require("path");
const bc = require("../lib/bettingco.cjs");

const KEY = (process.env.BETTINGCO_KEY || (() => { try { return fs.readFileSync(path.join(os.homedir(), ".bettingco_key"), "utf8"); } catch { return ""; } })()).trim();
if (!KEY) { console.error("нет ключа: env BETTINGCO_KEY или ~/.bettingco_key"); process.exit(1); }
const THRESHOLD = Number(process.env.THRESHOLD || 0.03);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1000);
const DURATION_MIN = Number(process.env.DURATION_MIN || 0);
const STALE_MS = Number(process.env.STALE_MS || 8000);     // плечо протухло: курсор старше стольких мс
const STALE_EMPTY = Number(process.env.STALE_EMPTY || 6);  // ИЛИ столько пустых снимков подряд
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (s) => console.log(ts() + "  " + s);

const seen = new Map();
let cycles = 0, errs = 0, lastFullPull = 0; const startedAt = Date.now();

// Полный пул с соблюдением лимита 1/5с (для init и пере-инициализации на SessionId mismatch).
async function initBook(book) {
  const wait = 5200 - (Date.now() - lastFullPull);
  if (wait > 0) await sleep(wait);
  lastFullPull = Date.now();
  const data = await bc.getBookmakerData(book, KEY);
  if (!data || !data.gamesOriginModel) throw new Error(book + ": пустой GetBookmakerData");
  return bc.stateFromData(book, data);
}

(async () => {
  log("СТАРТ синхронный live-value (снимки) | порог " + (THRESHOLD * 100).toFixed(1) + "% | цикл ~" + INTERVAL_MS + "мс | " + (DURATION_MIN ? DURATION_MIN + " мин" : "до Ctrl+C"));
  let B = await initBook("Betano");
  let P = await initBook("Pinnacle");
  log("инициализировано: Betano игр " + Object.keys(B.games).length + " / рынков " + Object.keys(B.markets).length +
    " | Pinnacle игр " + Object.keys(P.games).length + " / рынков " + Object.keys(P.markets).length);

  const summary = () => {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    const arr = [...seen.values()], persist = arr.filter((e) => e.count >= 2);
    console.log("\n===== СВОДКА (" + mins + " мин, " + cycles + " циклов, ошибок " + errs + ") =====");
    console.log("уникальных value-сигналов: " + arr.length + " | живучих (≥2 циклов): " + persist.length);
    for (const e of arr.sort((a, b) => b.maxValue - a.maxValue).slice(0, 20))
      console.log("  +" + (e.maxValue * 100).toFixed(1) + "% | " + e.desc + " | " + e.count + "× / жил ~" + Math.round((e.last - e.first) / 1000) + "с");
    console.log("порог " + (THRESHOLD * 100).toFixed(1) + "%");
  };
  process.on("SIGINT", () => { summary(); process.exit(0); });

  while (true) {
    cycles++;
    try {
      // ОБА плеча параллельно — снимаются синхронно (в одном ~1с-окне)
      const t0 = Date.now();
      const [rb, rp] = await Promise.all([
        bc.getSnapshots("Betano", KEY, B.sessionGuid, B.cursor),
        bc.getSnapshots("Pinnacle", KEY, P.sessionGuid, P.cursor),
      ]);
      const ab = bc.applySnapshotsResponse(B, rb), ap = bc.applySnapshotsResponse(P, rp);
      if (ab.rate || ap.rate) { errs++; await sleep(800); }
      // Счётчик пустых снимков подряд: если плечо «молчит» много циклов — сессия деградирует (курсор виснет),
      // данные протухают → сигналы стали бы ложными. Такое плечо переинициализируем и цикл пропускаем.
      B.empty = ab.applied ? 0 : (B.empty || 0) + 1;
      P.empty = ap.applied ? 0 : (P.empty || 0) + 1;
      const now = Date.now();
      const stale = (s) => (now - new Date(s.cursor)) > STALE_MS || s.empty >= STALE_EMPTY; // курсор стар ИЛИ пустые подряд
      if (ab.mismatch || stale(B)) { log("Betano протухло (mismatch/stale) → пере-инициализация"); B = await initBook("Betano"); continue; }
      if (ap.mismatch || stale(P)) { log("Pinnacle протухло (mismatch/stale) → пере-инициализация"); P = await initBook("Pinnacle"); continue; }

      const sigs = bc.scanValueState(B, P, { threshold: THRESHOLD, maxPlausible: 0.25 });
      for (const s of sigs) {
        const k = bc.norm(s.t1) + "~" + bc.norm(s.t2) + "|" + s.market + "|" + s.side;
        const e = seen.get(k);
        if (e) { e.last = Date.now(); e.count++; e.maxValue = Math.max(e.maxValue, s.value); }
        else {
          seen.set(k, { first: Date.now(), last: Date.now(), count: 1, maxValue: s.value, desc: s.t1 + " vs " + s.t2 + " · " + s.market + " " + s.side });
          log("🎯 +" + (s.value * 100).toFixed(1) + "% | " + s.t1 + " vs " + s.t2 + " | " + s.market + " " + s.side +
            " | Bet " + s.betanoOdds + " vs fair " + s.fair.toFixed(3) + " | " + s.league + (s.score ? " | " + s.score : ""));
        }
      }
      // свежесть плеч = возраст курсора каждой книги (мс от now); оба должны быть малы (иначе плечо отстаёт)
      const ageB = Date.now() - new Date(B.cursor), ageP = Date.now() - new Date(P.cursor);
      if (cycles % 10 === 0 || sigs.length) log("цикл " + cycles + ": сигналов " + sigs.length + " | уникальных " + seen.size + " | возраст B/P " + ageB + "/" + ageP + "мс | опрос " + (Date.now() - t0) + "мс");
    } catch (e) { errs++; log("🔴 цикл: " + e.message); await sleep(1500); }
    if (DURATION_MIN && Date.now() - startedAt >= DURATION_MIN * 60000) { summary(); break; }
    await sleep(INTERVAL_MS);
  }
})();
