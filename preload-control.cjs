"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  saveSettings: (patch) => ipcRenderer.invoke("save-settings", patch),
  openSurebet: () => ipcRenderer.invoke("open-surebet"),
  setRunning: (v) => ipcRenderer.invoke("set-running", v),
  testTelegram: () => ipcRenderer.invoke("test-telegram"),
  logoutSurebet: () => ipcRenderer.invoke("logout-surebet"),
  openLogs: () => ipcRenderer.invoke("open-logs"),
  getBookers: () => ipcRenderer.invoke("get-bookers"),
  getTournaments: (sportId) => ipcRenderer.invoke("get-tournaments", sportId),
  saveBookers: (list) => ipcRenderer.invoke("save-bookers", list),
  openBooker: (id) => ipcRenderer.invoke("open-booker", id),
  openOcto: () => ipcRenderer.invoke("open-octo"),       // открыть профиль Betano в Octo (кнопка «Войти»)
  testOcto: () => ipcRenderer.invoke("test-octo"),       // диагностика подключения к Octo
  randomizeFp: (id) => ipcRenderer.invoke("randomize-fp", id),
  randomizeUa: (id) => ipcRenderer.invoke("randomize-ua", id),
  checkProxy: (id) => ipcRenderer.invoke("check-proxy", id),
  resetBookerData: (id) => ipcRenderer.invoke("reset-booker-data", id),
  captureBooker: (id) => ipcRenderer.invoke("capture-booker", id),
  geoDiag: (id) => ipcRenderer.invoke("geo-diag", id),
  dryRunPlace: (id, stake) => ipcRenderer.invoke("dry-run-place", id, stake),
  placeBet: (id, stake) => ipcRenderer.invoke("place-bet", id, stake),
  getFx: () => ipcRenderer.invoke("get-fx"),
  runBot: (live) => ipcRenderer.invoke("run-bot", live),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
  onFx: (cb) => ipcRenderer.on("fx", (_e, r) => cb(r)),
  onBot: (cb) => ipcRenderer.on("bot", (_e, r) => cb(r)),
  onBotStats: (cb) => ipcRenderer.on("bot-stats", (_e, r) => cb(r)),
  onBotPulse: (cb) => ipcRenderer.on("bot-pulse", (_e, p) => cb(p)),
  onValuePulse: (cb) => ipcRenderer.on("value-pulse", (_e, p) => cb(p)),
  onLog: (cb) => ipcRenderer.on("log", (_e, line) => cb(line)),
});
