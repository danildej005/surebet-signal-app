"use strict";
// Разведсканер value с эталоном ps3838 (Pinnacle напрямую) vs Betano (oddspapi). Матч по pinnacleId.
// НЕ ставит. ps3838 — только чтение. Запуск: node tools/value-ps3838-scan.cjs <oaSport> <psSport> <oaTournaments> <threshold>
const fs = require("fs"); const os = require("os"); const path = require("path");
const oa = require("../lib/oddspapi.cjs"); const ps = require("../lib/ps3838.cjs");
const { candidatesVsPinnacleFair } = require("../lib/valuebet.cjs");

const OKEY = fs.readFileSync(path.join(os.homedir(), ".oddspapi_key"), "utf8").trim();
const PAUTH = fs.readFileSync(path.join(os.homedir(), ".ps3838"), "utf8").trim();
const oaSport = process.argv[2] || "13", psSport = process.argv[3] || "3", tids = process.argv[4] || "109", thr = Number(process.argv[5] || "0");
const ds = (d) => d.toISOString().slice(0, 10);

(async () => {
  const catalog = oa.catalogFromMarkets(await oa.markets(oaSport, OKEY));
  const today = new Date();
  const fxMap = new Map(); // fixtureId → {pinId, p1, p2}
  for (const f of oa.asList(await oa.fixtures(oaSport, ds(today), ds(new Date(today.getTime() + 3 * 864e5)), OKEY))) {
    fxMap.set(f.fixtureId, { pinId: (f.externalProviders || {}).pinnacleId, p1: f.participant1Name, p2: f.participant2Name });
  }
  const bet = oa.indexByFixtureId(await oa.oddsByTournaments("betano", tids, OKEY));
  const fair = ps.fairByEvent(await ps.odds(psSport, PAUTH));
  console.log(`Betano fixtures: ${bet.size} | ps3838 events: ${fair.size}`);

  let matched = 0; const cands = [];
  for (const [fid, betFx] of bet) {
    const meta = fxMap.get(fid); if (!meta || !meta.pinId) continue;
    const f = fair.get(String(meta.pinId)); if (!f) continue;
    matched++;
    const eid = oa.bookmakerMeta(betFx, "betano").eventId;
    cands.push(...candidatesVsPinnacleFair(betFx, f, catalog, meta.p1, meta.p2, eid, { threshold: thr }));
  }
  cands.sort((a, b) => b.valuePct - a.valuePct);
  console.log(`матчей Betano↔ps3838 по pinnacleId: ${matched} | кандидатов (value ≥ ${(thr * 100).toFixed(0)}%): ${cands.length}`);
  for (const c of cands.slice(0, 15)) {
    console.log(`  +${(c.valuePct * 100).toFixed(1)}%  ${c.p1} vs ${c.p2} | ${c.desc} @${c.expectedOdds} (честный ${c.fairOdds.toFixed(2)})`);
  }
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
