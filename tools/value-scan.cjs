"use strict";
// РАЗВЕДОЧНЫЙ сканер value (НЕ часть приложения, не ставит ставки). Тянет Pinnacle+Betano по выбранным
// турнирам, джойнит по нормализованным id, считает value через lib/value.cjs, печатает покрытие,
// распределение value% и топ-кандидатов с дип-линком betano.bg. Ключ — из ~/.oddspapi_key.
// Запуск:  node tools/value-scan.cjs [sportId] [tournamentIds] [threshold]
//   напр.: node tools/value-scan.cjs 10 16,7,17,23,8 0.02
const fs = require("fs");
const os = require("os");
const path = require("path");
const api = require("../lib/oddspapi.cjs");
const { findValue, devigProportional } = require("../lib/value.cjs");

const KEY = fs.readFileSync(path.join(os.homedir(), ".oddspapi_key"), "utf8").trim();
const sportId = process.argv[2] || "10";
const tournamentIds = process.argv[3] || "16,7,17,23,8";
const threshold = Number(process.argv[4] || "0.02");
const SOFT = process.argv[5] || "betano"; // контора, на которой ищем value (ставим)
const REF = process.argv[6] || "pinnacle"; // контора-ЭТАЛОН (де-виг → честная линия)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function dateStr(d) { return d.toISOString().slice(0, 10); }

(async () => {
  const today = new Date();
  const to = new Date(today.getTime() + 9 * 864e5);
  console.log(`sportId=${sportId} tournaments=${tournamentIds} порог=${(threshold * 100).toFixed(1)}% | ставим=${SOFT} | эталон=${REF}\n`);

  const cat = api.catalogFromMarkets(await api.markets(sportId, KEY));
  const fxIdx = api.indexByFixtureId(await api.fixtures(sportId, dateStr(today), dateStr(to), KEY));
  await sleep(600);
  const pinList = await api.oddsByTournaments(REF, tournamentIds, KEY);
  await sleep(800);
  const betList = await api.oddsByTournaments(SOFT, tournamentIds, KEY);

  const pin = api.indexByFixtureId(pinList);
  const bet = api.indexByFixtureId(betList);
  const common = [...bet.keys()].filter((id) => pin.has(id));
  console.log(`ПОКРЫТИЕ: ${REF}=${pin.size} | ${SOFT}=${bet.size} | оба=${common.length}\n`);

  const label = (mid, oid) => {
    const m = cat.get(String(mid));
    if (!m) return { txt: `market ${mid}/${oid}`, period: "?", placeable: false };
    const o = (m.outcomes || []).find((x) => String(x.outcomeId) === String(oid));
    const full = m.period === "fulltime" || m.period === "result" || m.period === "match";
    return {
      txt: `${m.marketName || m.marketType}${m.handicap ? " " + m.handicap : ""} → ${o ? o.outcomeName : oid}`,
      period: m.period, placeable: full,
    };
  };

  // ЧИСТЫЕ рынки: только 2–3-исходные (1X2/тотал/фора/DC/DNB) полного матча. Многоисходные (Correct
  // Score и т.п.) выкидываем — там пропорциональный де-виг даёт ФЕЙКОВОЕ value (артефакт), и мы их не ставим.
  const isClean = (mid) => {
    const m = cat.get(String(mid));
    if (!m) return false;
    const full = m.period === "fulltime" || m.period === "result" || m.period === "match";
    return full && (m.marketLength ? m.marketLength <= 3 : (m.outcomes || []).length <= 3);
  };
  const clean = (mkts) => Object.fromEntries(Object.entries(mkts).filter(([mid]) => isClean(mid)));

  // распределение value по ВСЕМ сопоставимым исходам + сбор кандидатов ≥ порога
  const all = [];
  const cands = [];
  for (const id of common) {
    const pm = clean(api.outcomesByMarket(pin.get(id), REF));
    const bm = clean(api.outcomesByMarket(bet.get(id), SOFT));
    for (const v of findValue(pm, bm, { threshold: -1 })) all.push(v.valuePct);
    for (const v of findValue(pm, bm, { threshold })) {
      const fx = fxIdx.get(id) || {};
      const meta = api.bookmakerMeta(bet.get(id), SOFT);
      const lab = label(v.marketId, v.outcomeId);
      cands.push({ ...v, id, p1: fx.participant1Name, p2: fx.participant2Name, eventId: meta.eventId, lab });
    }
  }
  all.sort((a, b) => a - b);
  const pctl = (q) => all.length ? all[Math.floor(q * (all.length - 1))] : 0;
  const pos = (t) => all.filter((x) => x >= t).length;
  console.log(`СОПОСТАВЛЕНО ИСХОДОВ: ${all.length}`);
  if (all.length) {
    console.log(`  value%: min=${(all[0] * 100).toFixed(1)} | медиана=${(pctl(0.5) * 100).toFixed(1)} | max=${(all[all.length - 1] * 100).toFixed(1)}`);
    console.log(`  ≥1%: ${pos(0.01)} | ≥2%: ${pos(0.02)} | ≥3%: ${pos(0.03)} | ≥5%: ${pos(0.05)}`);
  }

  cands.sort((a, b) => b.valuePct - a.valuePct);
  console.log(`\nКАНДИДАТОВ (value ≥ ${(threshold * 100).toFixed(1)}%): ${cands.length}. Топ-12:`);
  for (const c of cands.slice(0, 12)) {
    const url = SOFT === "betano" ? `https://www.betano.bg/koefitsienti/${slug((c.p1 || "") + "-" + (c.p2 || ""))}/${c.eventId}/` : `[${SOFT} eventId ${c.eventId}]`;
    const flag = c.lab.placeable ? "" : `  [${c.lab.period}/непростав.]`;
    console.log(`  +${(c.valuePct * 100).toFixed(1)}%  ${c.p1} vs ${c.p2}`);
    console.log(`     ${c.lab.txt} | ${SOFT} ${c.bookOdds} vs честный ${c.fairOdds.toFixed(2)}${flag}`);
    console.log(`     ${url}`);
  }
})().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
