"use strict";
// Файловый лог: ловит фатальные ошибки и пишет в userData/logs/main.log (с ротацией).
// Это «чёрный ящик» — по нему чиним краши. Кнопка «Показать логи» открывает папку.
const { app } = require("electron");
const { join } = require("node:path");
const { mkdirSync, appendFileSync, statSync, renameSync, existsSync } = require("node:fs");

let logsDir = null;
let logFile = null;
let sink = null; // подписчик на строки лога (дашборд показывает их в реальном времени)
function onLine(fn) { sink = typeof fn === "function" ? fn : null; }

function rotateIfBig() {
  try {
    if (logFile && existsSync(logFile) && statSync(logFile).size > 1_000_000) {
      renameSync(logFile, logFile + ".1"); // храним один предыдущий
    }
  } catch { /* ignore */ }
}

function safe(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function log(level, ...args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(safe).join(" ")}\n`;
  try { process.stdout.write(line); } catch { /* ignore */ }
  try { if (logFile) appendFileSync(logFile, line); } catch { /* ignore */ }
  try { if (sink) sink(line); } catch { /* ignore */ } // в дашборд (живой лог)
}

function init() {
  try {
    logsDir = join(app.getPath("userData"), "logs");
    mkdirSync(logsDir, { recursive: true });
    logFile = join(logsDir, "main.log");
    rotateIfBig();
  } catch { /* ignore */ }

  process.on("uncaughtException", (e) => log("FATAL", "uncaughtException:", e));
  process.on("unhandledRejection", (e) => log("ERROR", "unhandledRejection:", e));

  let version = "?";
  try { version = app.getVersion(); } catch { /* ignore */ }
  log("INFO", "=== старт Surebet Signal", version, "===");
}

function dir() { return logsDir; }

module.exports = { init, log, dir, onLine };
