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
  saveBookers: (list) => ipcRenderer.invoke("save-bookers", list),
  openBooker: (id) => ipcRenderer.invoke("open-booker", id),
  randomizeFp: (id) => ipcRenderer.invoke("randomize-fp", id),
  resetBookerData: (id) => ipcRenderer.invoke("reset-booker-data", id),
  captureBooker: (id) => ipcRenderer.invoke("capture-booker", id),
  dryRunPlace: (id, stake) => ipcRenderer.invoke("dry-run-place", id, stake),
  placeBet: (id, stake) => ipcRenderer.invoke("place-bet", id, stake),
  getFx: () => ipcRenderer.invoke("get-fx"),
  runBot: (live) => ipcRenderer.invoke("run-bot", live),
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
  onFx: (cb) => ipcRenderer.on("fx", (_e, r) => cb(r)),
  onBot: (cb) => ipcRenderer.on("bot", (_e, r) => cb(r)),
});
