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
  keepAlive: true, // анти-разлогин: держать сессии контор (клик+перезагрузка окна раз в 45с). Выключи, чтобы спокойно залогиниться.
  dedupeTtlMs: 10 * 60 * 1000,
  bookers: defaultBookers(), // профили контор (антидетект): сессия+прокси+отпечаток+гео
  liveMode: false, // боевой режим простановки (реальные ставки). По умолчанию ВЫКЛ.
  // VALUE-режим (прематч value через oddspapi: эталон Pinnacle de-vig, ставим Betano). Всё ВЫКЛ по умолч.
  bettingcoKey: "",          // ключ Betano-фида bettingco (X-Api-Key; секрет, шифруется) — оба плеча Betano+Pinnacle
  oddsApiKey: "",            // ключ oddspapi.io (секрет; УСТАРЕЛ, заменён на bettingcoKey; оставлен для миграции)
  valueMode: false,          // включён ли value-режим (сканировать и ставить)
  valueLive: false,          // боевой value (реальные ставки); false = dry-run
  valueThreshold: 0.05,      // мин. value (доля) — высокий «вилочный» порог (бэктест: мелкий валуй = слив)
  valueStake: 0,             // фикс. сумма ставки (валюта Betano)
  valueMaxPerDay: 20,        // лимит ставок в сутки
  valueRefSource: "ps3838",  // источник ЭТАЛОНА Pinnacle: "ps3838" (прямой) или "oddspapi"
  ps3838Auth: "",            // "логин:пароль" ps3838 (СЕКРЕТ, шифруется; ТОЛЬКО чтение кэфов)
  valueOddsMin: 0,           // не ставить кэф ниже (0 = без границы)
  valueOddsMax: 0,           // не ставить кэф выше (0 = без границы)
  // спорты: галочка on = сканировать. ВСЕ активные лиги спорта берём автоматически (бот обновляет список
  // и подхватывает новые). exclude = id лиг, которые НЕ сканировать (сняты галочкой в панели).
  valueSports: [
    { key: "soccer", name: "Футбол", oa: "10", ps: "29", on: false, exclude: [] },
    { key: "baseball", name: "Бейсбол", oa: "13", ps: "3", on: false, exclude: [] },
    { key: "tennis", name: "Теннис", oa: "12", ps: "33", on: false, exclude: [] },
    { key: "basketball", name: "Баскетбол", oa: "11", ps: "4", on: false, exclude: [] },
    { key: "hockey", name: "Хоккей", oa: "15", ps: "19", on: false, exclude: [] },
    { key: "amfootball", name: "Американский футбол", oa: "14", ps: "15", on: false, exclude: [] },
  ],
  // разрешённые типы рынков (пусто = все). Группы в панели: Исход(1x2/moneyline)/Тоталы/Форы/DNB/Двойной шанс
  valueMarkets: ["1x2", "moneyline", "totals", "spreads", "drawnobet", "doublechance"],
  // OCTO BROWSER (настоящий антидетект) для простановки на Betano вместо нашего Electron-окна. Всё ВЫКЛ.
  // Прокси/отпечаток/логин betano.bg живут ВНУТРИ Octo-профиля → наши proxyBridge/fingerprint для Betano не нужны.
  octoMode: false,                       // использовать Octo для Betano вместо Electron-окна конторы
  octoApiUrl: "http://127.0.0.1:58888",  // адрес Local API Octo (Octo должен быть запущен на ВДС)
  octoProfileId: "",                     // UUID профиля Betano в Octo (профиль залогинен в betano.bg)
  octoExePath: "",                       // путь к Octo.exe для автозапуска (пусто = искать стандартные пути)
  octoToken: "",                         // токен Cloud API Octo (СЕКРЕТ, шифруется; пока не используется в простановке)
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
