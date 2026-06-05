"use strict";
// Настройки приложения. Секреты (токен Telegram) шифруются через safeStorage и
// хранятся в userData. В код/git не попадают.
const { app, safeStorage } = require("electron");
const { join } = require("node:path");
const { readFileSync, writeFileSync } = require("node:fs");

const DEFAULTS = {
  tgToken: "",
  tgChat: "",
  pollMs: 8000,
  keyword: "pinnacle",
  dedupeTtlMs: 10 * 60 * 1000,
};

const file = () => join(app.getPath("userData"), "settings.enc");

function load() {
  try {
    const buf = readFileSync(file());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
    return { ...DEFAULTS, ...JSON.parse(json) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const merged = { ...load(), ...patch };
  const json = JSON.stringify(merged);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf8");
  writeFileSync(file(), data);
  return merged;
}

module.exports = { load, save, DEFAULTS };
