"use strict";
// Настройки приложения. Секреты (токен Telegram) шифруются через safeStorage и
// хранятся в userData. В код/git не попадают.
const { app, safeStorage } = require("electron");
const { join } = require("node:path");
const { readFileSync, writeFileSync } = require("node:fs");
const { defaultBookers } = require("./bookers.cjs");

const DEFAULTS = {
  tgToken: "",
  tgChat: "",
  tgApiBase: "https://api.telegram.org", // обычно не трогаем (для варианта с Cloudflare Worker)
  proxy: "", // прокси для Telegram: "host:port", "host:port:user:pass" или "scheme://user:pass@host:port"
  pollMs: 8000,
  keyword: "pinnacle",
  dedupeTtlMs: 10 * 60 * 1000,
  bookers: defaultBookers(), // профили контор (антидетект): сессия+прокси+отпечаток+гео
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
