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
  liveMode: false, // боевой режим простановки (реальные ставки). По умолчанию ВЫКЛ.
  // VALUE-режим (прематч value через oddspapi: эталон Pinnacle de-vig, ставим Betano). Всё ВЫКЛ по умолч.
  oddsApiKey: "",            // ключ oddspapi.io (секрет, шифруется вместе с настройками)
  valueMode: false,          // включён ли value-режим (сканировать и ставить)
  valueLive: false,          // боевой value (реальные ставки); false = dry-run
  valueSportId: "10",        // вид спорта (10=футбол, 13=бейсбол…)
  valueTournaments: "",      // id турниров через запятую
  valueThreshold: 0.05,      // мин. value (доля) — высокий «вилочный» порог (бэктест: мелкий валуй = слив)
  valueStake: 0,             // фикс. сумма ставки (валюта Betano)
  valueMaxPerDay: 20,        // лимит ставок в сутки
  valueRefSource: "ps3838",  // источник ЭТАЛОНА Pinnacle: "ps3838" (прямой) или "oddspapi"
  ps3838Auth: "",            // "логин:пароль" ps3838 (СЕКРЕТ, шифруется; ТОЛЬКО чтение кэфов)
  valuePsSportId: "29",      // id спорта в ps3838 (29=футбол,3=бейсбол,33=теннис,4=баскет,19=хоккей,15=амфутбол)
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
