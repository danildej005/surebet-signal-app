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
  keepAlive: true, // анти-разлогин: держать сессии контор (клик+перезагрузка окна). Выключи, чтобы спокойно залогиниться.
  keepAliveMs: 180000, // период анти-разлогина (мс). Реже = меньше перезагрузок = меньше прокси-трафика. Мин. 45с. Деф 3 мин
  octoBlockResources: true, // резать картинки/видео/шрифты на Octo-странице (экономия прокси-трафика; DOM с кэфами не трогаем)
  dedupeTtlMs: 10 * 60 * 1000,
  bookers: defaultBookers(), // профили контор (антидетект): сессия+прокси+отпечаток+гео
  liveMode: false, // боевой режим простановки (реальные ставки). По умолчанию ВЫКЛ.
  // VALUE-режим (прематч value через oddspapi: эталон Pinnacle de-vig, ставим Betano). Всё ВЫКЛ по умолч.
  bettingcoKey: "",          // ключ Betano-фида bettingco (X-Api-Key; секрет, шифруется) — оба плеча Betano+Pinnacle
  oddsApiKey: "",            // ключ oddspapi.io (секрет; УСТАРЕЛ, заменён на bettingcoKey; оставлен для миграции)
  valueMode: false,          // включён ли value-режим (сканировать и ставить)
  valueLive: false,          // боевой value (реальные ставки); false = dry-run
  valueLiveSports: [3, 1, 29, 31, 32], // БОЕВОЙ клик: теннис + футбол/CS/LoL/Valorant (5+ чистых dry-run у каждого, 09.07). Dota копит. Пусто = все
  valueMarginBySport: {},    // фильтр маржи Pinnacle НА СПОРТ: {sportType: доля}, напр. {"29":0.07}. Нет ключа = общий valueMarginMax
  valueDiagNonTennisEvery: 50, // набрали столько НЕ-теннисных валуёв за сессию → шлём .txt-срез сессии в Telegram (для доработки). 0 = выкл
  valuePlace: false,         // ВКЛ ставочную часть на bettingco-сигналах (по умолчанию ВЫКЛ; реальный клик только при valueLive)
  valuePlaceRequireArb: false, // ставить только сигналы, дошедшие до реальной вилки (arb>0)
  valuePlaceKinds: [],       // какие рынки ставить (пусто = все): напр. ["ML"] — сперва только победа
  // Лимиты простановки (все три НЕЗАВИСИМЫ, ставка проходит только если во ВСЕ укладывается). Значение = сколько
  // ДОПОЛНИТЕЛЬНО к первой (0 = только первая). По умолчанию 0/0/0 → 1 ставка на матч (самый безопасный дефолт).
  valuePlaceDupExtra: 0,      // дубли: тот же ТОЧНЫЙ исход (событие+маркет+линия+сторона)
  valuePlaceEventExtra: 0,    // доп ставок на СОБЫТИЕ (матч) — подними, чтобы ставить в РАЗНЫХ маркетах матча
  valuePlaceMarketExtra: 0,   // доп ставок в одном МАРКЕТЕ (фора/тотал/победа, без линии) — 0 = не две форы
  valueThreshold: 0.05,      // мин. value (доля) — высокий «вилочный» порог (бэктест: мелкий валуй = слив)
  valueMax: 0.25,            // ПОТОЛОК value (доля): выше = артефакт/мисматч рынка → сигнал режем (было захардкожено 0.25)
  valueStake: 0,             // фикс. сумма ставки (валюта Betano)
  valueMaxPerDay: 20,        // лимит ставок в сутки
  valueRefSource: "ps3838",  // источник ЭТАЛОНА Pinnacle: "ps3838" (прямой) или "oddspapi"
  ps3838Auth: "",            // "логин:пароль" ps3838 (СЕКРЕТ, шифруется; ТОЛЬКО чтение кэфов)
  valueOddsMin: 0,           // не ставить кэф ниже (0 = без границы)
  valueOddsMax: 0,           // не ставить кэф выше (0 = без границы)
  valueMarginMax: 0,         // фильтр шума: макс. маржа Pinnacle (0 = ВЫКЛ; включим после калибровки по вилке)
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
const backupFile = () => join(app.getPath("userData"), "settings-backup.json");

// СЕКРЕТЫ — в резервную копию НЕ пишем (она plaintext). bookers тоже (внутри пароли/прокси контор).
const SECRET_KEYS = ["tgToken", "bettingcoKey", "oddsApiKey", "ps3838Auth", "octoToken", "bookers"];

let lastLoadError = null; // причина последнего фолбэка (владелец терял ВЕСЬ конфиг молча — теперь видно в логе)

function readBackup() {
  try { return JSON.parse(readFileSync(backupFile(), "utf8")); } catch { return {}; }
}

function load() {
  let buf = null;
  try { buf = readFileSync(file()); } catch { /* файла нет — первый запуск */ }
  if (buf) {
    try {
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
      lastLoadError = null;
      return { ...DEFAULTS, ...JSON.parse(json) };
    } catch (e) {
      // Файл ЕСТЬ, но не читается (сбой DPAPI/битый файл). РАНЬШЕ: молча DEFAULTS → первое же сохранение
      // ЗАТИРАЛО конфиг дефолтами («ничего не сохранилось» у владельца). ТЕПЕРЬ: бэкапим битый файл,
      // пишем причину и восстанавливаем НЕсекретные поля из плоского резерва.
      lastLoadError = e && e.message;
      try { writeFileSync(file() + ".broken-" + Date.now(), buf); } catch { /* ignore */ }
    }
  }
  return { ...DEFAULTS, ...readBackup() };
}

function save(patch) {
  const merged = { ...load(), ...patch };
  const json = JSON.stringify(merged);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf8");
  writeFileSync(file(), data);
  // Плоский резерв НЕсекретных полей: переживает сбои шифрования — проценты/лимиты/тумблеры не теряются.
  try {
    const plain = {};
    for (const [k, v] of Object.entries(merged)) if (!SECRET_KEYS.includes(k)) plain[k] = v;
    writeFileSync(backupFile(), JSON.stringify(plain, null, 1), "utf8");
  } catch { /* ignore */ }
  return merged;
}

module.exports = { load, save, DEFAULTS, getLastLoadError: () => lastLoadError };
