"use strict";
// Surebet Signal — Electron-приложение.
// Главное окно = сам сайт surebet (логин + фильтр делаешь там). Фоновый цикл читает
// это окно, ищет вилки с Pinnacle и шлёт сигналы в Telegram. Управление — в трее.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session } = require("electron");
const { join } = require("node:path");

const logger = require("./lib/logger.cjs");
const { parseSurebets } = require("./lib/parse.cjs");
const { pickWanted } = require("./lib/filter.cjs");
const { formatSignal } = require("./lib/format.cjs");
const { sendTelegram } = require("./lib/telegram.cjs");
const { makeDeduper } = require("./lib/dedupe.cjs");
const { readSurebet } = require("./lib/surebetReader.cjs");
const settingsStore = require("./lib/settings.cjs");

const SUREBET_URL = "https://su.surebet.com/surebets";
const PARTITION = "persist:surebet"; // постоянная сессия → логин сохраняется

let settings = null;
let dedupe = null;
let surebetWin = null;
let panelWin = null;
let tray = null;
let timer = null;
let running = true;
let startupSent = false;
let lastWatchdogAt = 0;

const status = {
  running: true,
  loggedOut: false,
  lastCheck: null,
  total: 0,
  pinnacle: 0,
  sent: 0,
  lastError: null,
  lastSignal: null,
};

// ── окна ───────────────────────────────────────────────────────────────────
function createSurebetWindow() {
  surebetWin = new BrowserWindow({
    width: 1200,
    height: 820,
    title: "Surebet Signal — surebet.com",
    webPreferences: {
      partition: PARTITION,
      backgroundThrottling: false, // не тормозить чтение, когда окно свёрнуто
      preload: join(__dirname, "preload-surebet.cjs"),
    },
  });
  surebetWin.loadURL(SUREBET_URL);
  surebetWin.on("close", (e) => {
    // не закрываем приложение — прячем окно (работа продолжается в фоне)
    if (!app.isQuitting) { e.preventDefault(); surebetWin.hide(); }
  });
  // самовосстановление: если страница surebet упала — перезагружаем
  surebetWin.webContents.on("render-process-gone", (_e, d) => {
    logger.log("ERROR", "surebet render-process-gone:", d && d.reason);
    try { surebetWin.loadURL(SUREBET_URL); } catch (e) { logger.log("ERROR", "reload after crash:", e); }
  });
  surebetWin.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (code !== -3) logger.log("WARN", `surebet did-fail-load ${code} ${desc} ${url}`);
  });
}

function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); return; }
  panelWin = new BrowserWindow({
    width: 460,
    height: 560,
    title: "Surebet Signal — панель",
    resizable: false,
    webPreferences: { preload: join(__dirname, "preload-control.cjs") },
  });
  panelWin.loadFile(join(__dirname, "renderer", "index.html"));
  panelWin.on("closed", () => { panelWin = null; });
}

// ── трей ─────────────────────────────────────────────────────────────────────
function trayImage() {
  try {
    const img = nativeImage.createFromPath(join(__dirname, "build", "icon.png"));
    if (!img.isEmpty()) return img.resize({ width: 18, height: 18 });
  } catch { /* fallthrough */ }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: status.loggedOut ? "⚠️ нужен вход в surebet" : running ? "🟢 Слежу за вилками" : "⏸ Пауза", enabled: false },
    { label: `Вилок: ${status.total} · Pinnacle: ${status.pinnacle} · отправлено: ${status.sent}`, enabled: false },
    { type: "separator" },
    { label: "Открыть surebet (вход/фильтр)", click: () => { if (surebetWin) { surebetWin.show(); surebetWin.focus(); } } },
    { label: "Панель и настройки…", click: createPanelWindow },
    { label: running ? "Поставить на паузу" : "Возобновить", click: () => setRunning(!running) },
    { type: "separator" },
    { label: "Выход", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`Surebet Signal — ${status.loggedOut ? "нужен вход" : running ? "слежу" : "пауза"} (отправлено ${status.sent})`);
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip("Surebet Signal");
    tray.on("click", () => { if (surebetWin) surebetWin.show(); });
    refreshTray();
  } catch (e) { console.error("[tray]", e.message); }
}

// ── связь с панелью ───────────────────────────────────────────────────────────
function pushStatus() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send("status", { ...status, settings: maskedSettings() });
  refreshTray();
}
function maskedSettings() {
  return {
    tgToken: settings.tgToken ? settings.tgToken.slice(0, 6) + "…" : "",
    tgChat: settings.tgChat || "",
    tgApiBase: settings.tgApiBase || "https://api.telegram.org",
    pollMs: settings.pollMs,
    keyword: settings.keyword,
    hasToken: !!settings.tgToken,
  };
}

function setRunning(v) {
  running = v;
  status.running = v;
  pushStatus();
}

// ── Telegram (через прокси-базу из настроек) ──────────────────────────────────
function tg(text) {
  return sendTelegram(settings.tgToken, settings.tgChat, text, { apiBase: settings.tgApiBase });
}

// ── цикл слежения ─────────────────────────────────────────────────────────────
async function watchdog(text) {
  const now = Date.now();
  if (now - lastWatchdogAt < 15 * 60 * 1000) return;
  lastWatchdogAt = now;
  if (settings.tgToken && settings.tgChat) await tg(text);
}

async function tick() {
  if (!running || !surebetWin || surebetWin.isDestroyed()) return;
  const r = await readSurebet(surebetWin.webContents);
  status.lastCheck = Date.now();

  if (r.error) { status.lastError = r.error; logger.log("WARN", "чтение surebet:", r.error); pushStatus(); return; }
  status.lastError = null;

  if (r.loggedOut) {
    status.loggedOut = true;
    await watchdog("⚠️ Нужен вход в surebet — открой приложение и залогинься. Сигналы на паузе.");
    pushStatus();
    return;
  }
  status.loggedOut = false;

  if (settings.tgToken && settings.tgChat && !startupSent) {
    startupSent = true;
    await tg("🟢 Surebet Signal запущен. Слежу за вилками с Pinnacle.");
  }

  const arbs = parseSurebets(r.html);
  const wanted = pickWanted(arbs, settings.keyword);
  status.total = arbs.length;
  status.pinnacle = wanted.length;

  for (const s of wanted) {
    if (!dedupe.shouldSend(s.id)) continue;
    if (!settings.tgToken || !settings.tgChat) break; // некуда слать
    const res = await tg(formatSignal(s, settings.keyword));
    if (res.ok) { dedupe.markSent(s.id); status.sent++; status.lastSignal = { event: s.event, profit: s.profitPct, at: Date.now() }; }
    else { status.lastError = "Telegram: " + res.error; logger.log("WARN", "Telegram send:", res.error); }
  }
  pushStatus();
}

function startLoop() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { tick().catch((e) => { status.lastError = e.message; logger.log("ERROR", "tick:", e); }); }, Math.max(3000, settings.pollMs || 8000));
}

// ── авто-обновление ───────────────────────────────────────────────────────────
function initAutoUpdate() {
  if (!app.isPackaged) return; // только в собранном приложении
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.logger = { info: (m) => logger.log("UPD", m), warn: (m) => logger.log("UPD", m), error: (m) => logger.log("UPD-ERR", m), debug: () => {} };
    autoUpdater.on("update-available", (i) => logger.log("UPD", "доступно обновление", i && i.version));
    autoUpdater.on("update-downloaded", (i) => {
      logger.log("UPD", "обновление загружено", i && i.version);
      if (settings && settings.tgToken && settings.tgChat)
        tg("⬆️ Обновление загружено, установится при следующем запуске.");
    });
    autoUpdater.on("error", (e) => logger.log("UPD-ERR", e));
    autoUpdater.checkForUpdatesAndNotify().catch((e) => logger.log("UPD-ERR", e));
    setInterval(() => autoUpdater.checkForUpdates().catch((e) => logger.log("UPD-ERR", e)), 6 * 60 * 60 * 1000);
  } catch (e) { logger.log("UPD-ERR", e); }
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle("get-status", () => ({ ...status, settings: maskedSettings() }));
ipcMain.handle("save-settings", (_e, patch) => {
  const clean = {};
  if (typeof patch.tgToken === "string" && patch.tgToken.trim()) clean.tgToken = patch.tgToken.trim();
  if (typeof patch.tgChat === "string") clean.tgChat = patch.tgChat.trim();
  if (typeof patch.tgApiBase === "string") clean.tgApiBase = patch.tgApiBase.trim() || "https://api.telegram.org";
  if (patch.pollMs) clean.pollMs = Math.max(3000, Number(patch.pollMs) || 8000);
  if (patch.keyword) clean.keyword = String(patch.keyword).trim().toLowerCase();
  settings = settingsStore.save(clean);
  startupSent = false;
  startLoop();
  pushStatus();
  return maskedSettings();
});
ipcMain.handle("open-surebet", () => { if (surebetWin) { surebetWin.show(); surebetWin.focus(); } });
ipcMain.handle("set-running", (_e, v) => { setRunning(!!v); return running; });
ipcMain.handle("test-telegram", async () => {
  if (!settings.tgToken || !settings.tgChat) return { ok: false, error: "не заданы токен/chat_id" };
  const res = await tg("✅ Проверка: Surebet Signal на связи.");
  logger.log(res.ok ? "INFO" : "WARN", "тест Telegram:", res.ok ? "ok" : res.error, "| база:", settings.tgApiBase);
  return res;
});
ipcMain.handle("logout-surebet", async () => {
  try { await session.fromPartition(PARTITION).clearStorageData(); if (surebetWin) surebetWin.loadURL(SUREBET_URL); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("open-logs", async () => {
  const d = logger.dir();
  if (d) await shell.openPath(d);
  return { ok: !!d, dir: d };
});

// ── запуск ────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => { if (surebetWin) { surebetWin.show(); surebetWin.focus(); } });

  app.whenReady().then(() => {
    logger.init();
    initAutoUpdate(); // проверку обновлений запускаем ПЕРВОЙ — чтобы баг-версия успевала подтянуть фикс

    try {
      settings = settingsStore.load();
      dedupe = makeDeduper({ ttlMs: settings.dedupeTtlMs, file: join(app.getPath("userData"), "seen.json") });

      createSurebetWindow();
      createTray();
      if (!settings.tgToken || !settings.tgChat) createPanelWindow(); // первый запуск — покажем настройки
      startLoop();
    } catch (e) {
      logger.log("FATAL", "ошибка инициализации:", e);
    }

    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createSurebetWindow(); });
  });

  app.on("window-all-closed", (e) => { /* живём в трее, не выходим */ });
  app.on("before-quit", () => { app.isQuitting = true; });
}
