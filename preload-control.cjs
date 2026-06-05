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
  onStatus: (cb) => ipcRenderer.on("status", (_e, s) => cb(s)),
});
