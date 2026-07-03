"use strict";
// СВОД «за всё время» по всем файлам сессий (value-session-*.json): общий бэктест + ROI по ДИСТАНЦИИ ДО ВИЛКИ.
// Запуск:  node tools/settle-report.cjs [папка-с-json]
// Папка по умолчанию — где приложение пишет сессии (logs/value-sessions в userData), либо ./logs/value-sessions,
// либо переменная SUREBET_SESSIONS. Чистая логика свода — в lib/settle.cjs (rollup), тут только чтение + печать.
const fs = require("fs");
const path = require("path");
const os = require("os");
const settle = require("../lib/settle.cjs");

function defaultDir() {
  const app = "Surebet Signal";
  const cands = [
    process.env.SUREBET_SESSIONS,
    path.join(process.cwd(), "logs", "value-sessions"),
    process.platform === "win32" && path.join(process.env.APPDATA || "", app, "logs", "value-sessions"),
    process.platform === "darwin" && path.join(os.homedir(), "Library", "Application Support", app, "logs", "value-sessions"),
    path.join(os.homedir(), ".config", app, "logs", "value-sessions"),
  ].filter(Boolean);
  return cands.find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }) || cands[1];
}

const dir = process.argv[2] || defaultDir();
let files;
try { files = fs.readdirSync(dir).filter((f) => /^value-session-.*\.json$/.test(f)); }
catch { console.error("Нет папки сессий:", dir, "\nУкажи путь: node tools/settle-report.cjs <папка>"); process.exit(1); }
if (!files.length) { console.error("В папке нет value-session-*.json:", dir); process.exit(1); }

// Собираем строки сигналов из всех файлов. Берём готовый pnl/result (посчитан приложением); если поля нет
// (старый формат) — пробуем пересеттлить по finalScore (нужны st+знаковый param → только новые файлы).
const rows = [];
let sessions = 0;
for (const f of files.sort()) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
  sessions++;
  for (const sig of j.signals || []) {
    let pnl = sig.pnl, result = sig.result;
    if (pnl === undefined) { const r = settle.settle(sig); pnl = r.pnl; result = r.result; } // старый файл без сеттла
    rows.push({ arbEntry: sig.arbEntry, valueEntry: sig.valueEntry != null ? sig.valueEntry : sig.maxValue, pnl, result });
  }
}

const R = settle.rollup(rows);
const pct = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
const u2 = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
const o = R.overall;

console.log("СВОД ЗА ВСЁ ВРЕМЯ  (" + sessions + " сессий, папка: " + dir + ")");
console.log("Задетектировано сигналов: " + R.detected);
console.log("Ставок рассчитано (матч завершён): " + o.bets + " | зашло: " + o.wins + (o.bets ? " (" + (o.wins / o.bets * 100).toFixed(0) + "%)" : ""));
console.log("Флэты профита (Σ у.е.): " + u2(o.units));
console.log("Реальный ROI: " + pct(o.roi) + " | ожидаемый (МО = ср. валуй входа): " + pct(o.evPred));
console.log("Δ = реальный − ожидаемый (близость к матожиданию): " + pct(o.delta) + "  [>0 лучше прогноза · <0 хуже (валуй бумажный) · ≈0 модель точна]");
console.log("");
console.log("ROI ПО ДИСТАНЦИИ ДО ВИЛКИ (ось калибровки порога value — до какого бакета ROI ещё > 0):");
const pad = (s, w) => String(s).padEnd(w), padL = (s, w) => String(s).padStart(w);
const W = [16, 6, 9, 9, 8, 8, 8];
const row = (c) => "  " + c.map((x, i) => (i === 0 ? pad(x, W[i]) : padL(x, W[i]))).join(" │ ");
console.log(row(["бакет", "ставок", "зашло", "Σфлэты", "ROI", "МО", "Δ"]));
for (const b of R.buckets)
  console.log(row([b.label, b.bets, b.bets ? b.wins + " (" + (b.wins / b.bets * 100).toFixed(0) + "%)" : "0",
    u2(b.units), b.bets ? pct(b.roi) : "—", b.bets ? pct(b.evPred) : "—", b.bets ? pct(b.delta) : "—"]));
