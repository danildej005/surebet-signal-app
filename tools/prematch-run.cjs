"use strict";
// Запуск прематч-движка без приложения: опрашивает фид, пишет в консоль найденные вилки и складывает журнал в папку.
// Движок только измеряет — ничего не ставит (docs/PREMATCH-HANDBOOK.md).
//
//   node tools/prematch-run.cjs --key-file ~/.bettingco_key_prematch --minutes 30 --out ./prematch-out
//
// Параметры: --key-file путь к файлу с ключом (или переменная окружения BETTINGCO_KEY; в git ключ не кладём)
//            --minutes  сколько работать (0 = до Ctrl+C)          --out      папка для журнала (по умолчанию не пишем)
//            --grid     сетка оценки, сек (по хендбуку 120)        --pause    пауза между запросами, сек (5)
//            --sports   виды спорта через запятую, напр. 1,3 (по умолчанию проверенный набор; all = все)
// ВАЖНО: один ключ опрашивает ОДНА программа. Вторая вызывает ошибки 429 у обеих.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { PrematchEngine } = require("../lib/prematch/engine.cjs");
const { makeFeed } = require("../lib/prematch/feed.cjs");
const { makeDirectory } = require("../lib/prematch/sportradar.cjs");
const { sportName } = require("../lib/bettingco.cjs");

const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i > 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def; };
const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const pct = (v) => (v == null ? "—" : (v * 100).toFixed(2) + "%");

(async () => {
  const keyFile = expand(arg("key-file", ""));
  const key = (keyFile ? fs.readFileSync(keyFile, "utf8") : process.env.BETTINGCO_KEY || "").trim();
  if (!key) { console.error("нет ключа: укажи --key-file или переменную BETTINGCO_KEY"); process.exit(2); }
  const minutes = Number(arg("minutes", 30)), pauseMs = Number(arg("pause", 5)) * 1000, gridMs = Number(arg("grid", 120)) * 1000;
  const sp = arg("sports", "");
  const sports = sp === "all" ? null : sp ? sp.split(",").map(Number) : undefined;
  const out = expand(arg("out", ""));
  if (out) fs.mkdirSync(out, { recursive: true });
  const append = (file, obj) => { if (out) fs.appendFileSync(path.join(out, file), JSON.stringify(obj) + "\n"); };

  const eng = new PrematchEngine({
    feed: makeFeed(key), gridMs, sports,
    directory: arg("no-identity", "") === "1" ? null : makeDirectory(),  // сверка матча по номеру Sportradar (--no-identity 1 — выключить)
    onLog: (level, msg) => console.log(`[${ts()}] ${level} ${msg}`),
    onArb: (r, kind) => {
      if (kind === "new") {
        console.log(`[${ts()}] ВИЛКА ${pct(r.arb)} | ${sportName(r.sportType)} | ${r.t1} — ${r.t2} | ${r.what} | Betano ${r.price} / Pinnacle ${r.opp.toFixed(3)} (${r.via}) | до старта ${(r.minsToStart / 60).toFixed(1)} ч` +
          (r.pairCheck === "suspect" ? " | ⚠ пара под подозрением: цены расходятся и по силе, и по тоталу" : r.pairCheck === "nodata" ? " | пару по ценам не проверить" : ""));
      } else if (kind === "identity") {
        const mark = { confirmed: "✅ матч подтверждён", mismatch: "⛔ НЕ ТОТ МАТЧ", unknown: "❔ не удалось подтвердить", noid: "— нет номера матча" }[r.identity] || r.identity;
        console.log(`[${ts()}] ПРОВЕРКА ${mark} | ${r.t1} — ${r.t2} | ${r.what} | ${r.identityWhy}`);
      } else {
        console.log(`[${ts()}] ЗАКРЫТИЕ ${r.t1} — ${r.t2} | ${r.what} | цена сигнала ${r.price} → закрытие ${r.kC == null ? "нет" : r.kC} (${pct(r.drop)}) | повторов ${r.repeats}, максимум ${pct(r.maxArb)}${r.noClose ? " | пропуск записи" : ""}`);
      }
      append("arbs-events.jsonl", { kind, at: Date.now(), ...r });
    },
  });

  let stop = false;
  process.on("SIGINT", () => { stop = true; });
  const until = minutes > 0 ? Date.now() + minutes * 60000 : Infinity;
  let lastSummary = 0;
  try {
    while (!stop && Date.now() < until) {
      await eng.tick();
      if (eng.ready() && Date.now() - lastSummary > 5 * 60000) {
        lastSummary = Date.now();
        const s = eng.summary();
        console.log(`[${ts()}] СВОДКА пар ${s.pairs} (` + Object.entries(s.pairsBySport).map(([k, v]) => sportName(Number(k)) + " " + v).join(", ") +
          `) | вилок сейчас ${s.arbsNow} | в журнале ${s.arbsJournal} | перезагрузок B/P ${s.reloads.Betano}/${s.reloads.Pinnacle} | 429: ${s.rate429}`);
      }
      await sleep(pauseMs);
    }
  } catch (e) {
    console.error(`[${ts()}] ОСТАНОВКА: ${e.message}`);
    process.exitCode = 1;
  }
  const s = eng.summary();
  console.log(`[${ts()}] ИТОГ ` + JSON.stringify(s));
  if (out) {
    fs.writeFileSync(path.join(out, "arbs.json"), JSON.stringify([...eng.arbs.values()], null, 1));
    fs.writeFileSync(path.join(out, "pairs-disputed.json"), JSON.stringify(eng.matcher.disputed(), null, 1));
    console.log(`журнал: ${path.join(out, "arbs.json")} · спорные пары: ${path.join(out, "pairs-disputed.json")}`);
  }
})();
