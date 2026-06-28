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
  valueThreshold: 0.05,      // мин. value (доля) — высокий «вилочный» порог (бэктест: мелкий валуй = слив)
  valueStake: 0,             // фикс. сумма ставки (валюта Betano)
  valueMaxPerDay: 20,        // лимит ставок в сутки
  valueRefSource: "ps3838",  // источник ЭТАЛОНА Pinnacle: "ps3838" (прямой) или "oddspapi"
  ps3838Auth: "",            // "логин:пароль" ps3838 (СЕКРЕТ, шифруется; ТОЛЬКО чтение кэфов)
  valueOddsMin: 0,           // не ставить кэф ниже (0 = без границы)
  valueOddsMax: 0,           // не ставить кэф выше (0 = без границы)
  // спорты с лигами — включать/исключать (oa = id oddspapi, ps = id ps3838)
  valueSports: [
    { key: "soccer", name: "Футбол", oa: "10", ps: "29", on: false, leagues: "" },
    { key: "baseball", name: "Бейсбол", oa: "13", ps: "3", on: false, leagues: "" },
    { key: "tennis", name: "Теннис", oa: "12", ps: "33", on: false, leagues: "" },
    { key: "basketball", name: "Баскетбол", oa: "11", ps: "4", on: false, leagues: "" },
    { key: "hockey", name: "Хоккей", oa: "15", ps: "19", on: false, leagues: "" },
    { key: "amfootball", name: "Американский футбол", oa: "14", ps: "15", on: false, leagues: "" },
  ],
  // разрешённые типы рынков (пусто = все). Группы в панели: Исход(1x2/moneyline)/Тоталы/Форы/DNB/Двойной шанс
  valueMarkets: ["1x2", "moneyline", "totals", "spreads", "drawnobet", "doublechance"],
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
