"use strict";
// Surebet Signal — Electron-приложение.
// Главное окно = сам сайт surebet (логин + фильтр делаешь там). Фоновый цикл читает
// это окно, ищет вилки с Pinnacle и шлёт сигналы в Telegram. Управление — в трее.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session, net } = require("electron");
const { join } = require("node:path");

const logger = require("./lib/logger.cjs");
const { parseSurebets } = require("./lib/parse.cjs");
const { pickWanted } = require("./lib/filter.cjs");
const { formatSignal } = require("./lib/format.cjs");
const { makeDeduper } = require("./lib/dedupe.cjs");
const { readSurebet } = require("./lib/surebetReader.cjs");
const settingsStore = require("./lib/settings.cjs");
const { defaultBookers, emptyProxy, buildProxyString, randomFingerprint, randomUA, buildFingerprintScript, bookerForUrl, resolveSurebetNav, pickOutcome, isEventUrl, extractSubject, marketUnit } = require("./lib/bookers.cjs");
const { startSocksBridge } = require("./lib/proxyBridge.cjs");
const fx = require("./lib/fx.cjs");
const { parseMoney, vilkaStakes } = require("./lib/vilka.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fxRate = { rate: fx.FALLBACK, source: "fallback", at: 0, stale: true };
async function refreshFx() {
  try {
    fxRate = await fx.fetchUsdToEur();
    logger.log("INFO", "курс USD→EUR:", fxRate.rate, "(" + fxRate.source + ")");
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send("fx", fxRate);
  } catch (e) { logger.log("WARN", "курс:", e.message); }
}

const SUREBET_URL = "https://su.surebet.com/surebets";
const PARTITION = "persist:surebet"; // постоянная сессия → логин сохраняется

let settings = null;
let dedupe = null;
let surebetWin = null;
let panelWin = null;
const bookerWins = new Map(); // id конторы → окно
const pendingBet = new Map(); // id конторы → { outcomeId, expectedOdds, desc } из последнего клика по плечу
let lastBookerId = null;
let tray = null;
let timer = null;
let running = true;
let startupSent = false;
let lastWatchdogAt = 0;
let lastReloadAt = Date.now();
let loggedOutCount = 0;

const status = {
  running: true,
  loggedOut: false,
  lastCheck: null,
  total: 0,
  pinnacle: 0,
  sent: 0,
  lastError: null,
  lastSignal: null,
  botArmed: false,
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

  // ФАЗА 4: клик по плечу вилки → перехватываем ссылку и открываем нужную контору
  // в её антидетект-окне (залогинено, через прокси), сразу на событии.
  surebetWin.webContents.setWindowOpenHandler(({ url }) => {
    logger.log("INFO", "клик по плечу surebet:", String(url).slice(0, 90));
    try {
      const nav = resolveSurebetNav(url, settings.bookers || []);
      // 1) surebet-ссылка плеча с распознанной конторой → открыть событие (routeLeg, общий путь с ботом)
      if (nav && nav.booker) { routeLeg(url).catch((e) => logger.log("WARN", "routeLeg:", e)); return { action: "deny" }; }
      // bk не сопоставлен — НЕ открываем по слову в URL (там оба плеча), иначе откроется не та контора
      if (nav) { logger.log("WARN", "  bk не сопоставлен с профилем:", nav.bk, "— пропускаю (без misroute)"); return { action: "deny" }; }
      // 2) прямая ссылка на контору (НЕ surebet-nav) — запасной путь
      const b = bookerForUrl(url, settings.bookers || []);
      if (b) { openBookerProfile(b, url).catch(() => {}); return { action: "deny" }; }
      logger.log("WARN", "  не распознал — открываю обычным окном");
    } catch (e) { logger.log("WARN", "windowOpen route:", e); }
    return { action: "allow" };
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

// ── антидетект-окно конторы (профиль: сессия + прокси + отпечаток + гео) ───────
const proxyBridges = new Map(); // строка прокси → { url, close } (мост для авторизованного SOCKS5)

async function applySessionProxy(ses, proxyStr) {
  const p = parseProxy(proxyStr);
  if (!p || !p.host || !p.port) {
    ses.__creds = null; try { await ses.setProxy({ mode: "direct" }); } catch { /* ignore */ }
    logger.log("WARN", "  applySessionProxy: прокси ПУСТОЙ/неполный (строка:", JSON.stringify(proxyStr || ""), ") → direct = РЕАЛЬНЫЙ IP. Проверь поля прокси конторы + «Сохранить».");
    return;
  }

  const isSocks = p.scheme === "socks5" || p.scheme === "socks";
  // Авторизованный SOCKS5 → поднимаем локальный мост (Chromium сам авторизацию SOCKS5 не умеет).
  if (isSocks && (p.user || p.pass)) {
    let bridge = proxyBridges.get(proxyStr);
    if (!bridge) {
      try { bridge = await startSocksBridge(p); proxyBridges.set(proxyStr, bridge); logger.log("INFO", "SOCKS5-мост поднят:", bridge.url, "→", p.host + ":" + p.port); }
      catch (e) { logger.log("WARN", "SOCKS5-мост не поднялся:", e); }
    }
    if (bridge) {
      ses.__creds = null;
      try { await ses.setProxy({ proxyRules: bridge.url }); } catch (e) { logger.log("WARN", "setProxy(bridge):", e); }
      return;
    }
  }

  // Обычный путь: SOCKS5 без авторизации, либо HTTP(S) (авторизация — через событие login).
  ses.__creds = (p.user || p.pass) ? { user: p.user, pass: p.pass } : null;
  try {
    await ses.setProxy({ proxyRules: `${p.scheme}://${p.host}:${p.port}` });
    logger.log("INFO", "  applySessionProxy: setProxy", p.scheme + "://" + p.host + ":" + p.port, p.user ? "(+ авторизация через login-событие)" : "");
  } catch (e) { logger.log("WARN", "booker setProxy:", e); }
}

async function openBookerProfile(profile, overrideUrl) {
  if (!profile || !profile.id) return null;
  normalizeBooker(profile);
  const id = profile.id;
  const partition = "persist:booker-" + id;
  const ses = session.fromPartition(partition);
  const pxStr = buildProxyString(profile.proxy);
  await applySessionProxy(ses, pxStr);

  if (!ses.__hooked) {
    ses.__hooked = true;
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(true)); // гео (спуф) и пр. не блокируем
  }

  let win = bookerWins.get(id);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1280, height: 860,
      title: "Контора — " + (profile.name || id),
      webPreferences: { partition, backgroundThrottling: false },
    });
    bookerWins.set(id, win);
    win.on("focus", () => { lastBookerId = id; });
    // КРИТИЧНО: при закрытии окна отцепляем отладчик CDP, иначе падает весь процесс.
    win.on("close", () => {
      try { const d = win.webContents.debugger; if (d && d.isAttached && d.isAttached()) d.detach(); } catch { /* ignore */ }
    });
    win.on("closed", () => { bookerWins.delete(id); });
    try { win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); } catch { /* ignore */ }

    // Авторизация прокси (HTTP/HTTPS) — событие приходит на ОКНО, не на сессию.
    win.webContents.on("login", (event, _details, authInfo, cb) => {
      if (authInfo.isProxy && ses.__creds) { event.preventDefault(); cb(ses.__creds.user, ses.__creds.pass); }
      else cb();
    });

    // Показ реальной причины «белого экрана» (ошибка прокси/сети) прямо в окне + в лог.
    win.webContents.on("did-fail-load", (_e, code, desc, failedUrl, isMainFrame) => {
      if (code === -3 || !isMainFrame) return; // -3 = ABORTED (норма при редиректах)
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      logger.log("WARN", `контора ${id} не загрузилась: ${code} ${desc} ${failedUrl}`);
      const safe = (s) => String(s).replace(/[<>&]/g, "");
      const body = `<body style="font:14px monospace;padding:24px;color:#b00"><h3>Не удалось загрузить страницу</h3>` +
        `<p>Код: ${code} (${safe(desc)})</p><p>URL: ${safe(failedUrl)}</p>` +
        `<p>Частые причины: неверный прокси/тип (HTTP vs SOCKS5), нужна авторизация прокси, прокси недоступен.</p>` +
        `<p>SOCKS5 указывай как <b>socks5://логин:пароль@host:port</b> или <b>socks5://host:port:логин:пароль</b>.</p></body>`;
      try { win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(body)).catch(() => {}); } catch { /* окно закрылось */ }
    });

    const fp = profile.fp || {};
    if (fp.ua) { try { win.webContents.setUserAgent(fp.ua); } catch { /* ignore */ } }

    // КРИТИЧНО: сначала поднимаем рендерер пустой страницей, иначе CDP-команды зависают
    // (и loadURL ниже никогда не вызывается → белый экран). Ждём готовности или 3с.
    try {
      await Promise.race([
        new Promise((res) => { win.webContents.once("did-finish-load", res); win.loadURL("about:blank"); }),
        new Promise((res) => setTimeout(res, 3000)),
      ]);
    } catch { /* ignore */ }

    try {
      const dbg = win.webContents.debugger;
      dbg.attach("1.3");
      await dbg.sendCommand("Page.enable");
      await dbg.sendCommand("Network.enable");
      await dbg.sendCommand("Network.setUserAgentOverride", { userAgent: fp.ua || "", acceptLanguage: (fp.languages || ["en-US"]).join(","), platform: fp.platform || "Win32" });
      if (fp.timezone) await dbg.sendCommand("Emulation.setTimezoneOverride", { timezoneId: fp.timezone }).catch(() => {});
      if (fp.locale) await dbg.sendCommand("Emulation.setLocaleOverride", { locale: fp.locale }).catch(() => {});
      if (fp.lat != null && fp.lon != null) await dbg.sendCommand("Emulation.setGeolocationOverride", { latitude: Number(fp.lat), longitude: Number(fp.lon), accuracy: 50 }).catch(() => {});
      await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: buildFingerprintScript(fp) });
      const pxInfo = parseProxy(pxStr);
      logger.log("INFO", "контора открыта:", id, "прокси:", (pxInfo && pxInfo.host) ? (pxInfo.scheme + "://" + pxInfo.host + ":" + pxInfo.port) : "НЕТ — реальный IP ВДС!", "tz:", fp.timezone);
    } catch (e) { logger.log("WARN", "booker CDP:", e); }
  }

  lastBookerId = id;
  win.show(); win.focus();
  const target = overrideUrl || profile.url;
  if (target) win.loadURL(target);
  return win;
}

// Регэксп домена конторы (для определения, что редирект дошёл до неё).
function bookerDomainRe(booker) {
  const kws = ({ betano: ["betano"], pinnacle: ["pinnacle888", "ps3838", "pinnacle"] }[booker.id]) || [booker.id];
  return new RegExp("(" + kws.join("|") + ")", "i");
}

// Пройти surebet-редирект (с surebet-сессией) и вернуть финальный URL события на конторе.
// Surebet строит глубокую ссылку (особенно для Betano) на сервере — ловим её из навигаций.
function resolveEventViaNav(navUrl, booker, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let navWin;
    try {
      navWin = new BrowserWindow({ show: false, webPreferences: { partition: "persist:surebet", backgroundThrottling: false } });
    } catch (e) { logger.log("WARN", "navWin:", e); return resolve(null); }
    const wc = navWin.webContents;
    const re = bookerDomainRe(booker);
    let best = null, done = false, settle = null;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(settle);
      try { if (!navWin.isDestroyed()) navWin.destroy(); } catch { /* ignore */ }
      resolve(best);
    };
    const onNav = (url) => {
      if (url && re.test(url) && !/surebet\.com/i.test(url)) {
        best = url;                          // дошли до конторы
        clearTimeout(settle);
        settle = setTimeout(finish, 3000);   // подождать JS-редирект к самому событию
      }
    };
    wc.on("did-redirect-navigation", (_e, url) => onNav(url));
    wc.on("did-navigate", (_e, url) => onNav(url));
    wc.on("did-navigate-in-page", (_e, url) => onNav(url));
    wc.loadURL(navUrl).catch(() => {});
    setTimeout(finish, timeoutMs);           // жёсткий таймаут
  });
}

// Поиск МАТЧА по имени игрока/команды, когда прямой ссылки на событие нет (Pinnacle отдаёт
// только раздел). Вводим имя в поиск конторы → кликаем строку матча с этим именем → ждём,
// пока URL станет событием (есть числовой id). Логируем каждый шаг (self-диагностика).
const SEARCH_SEL = { pinnacle: ["#oddsPageSearch", "#search-input", "input[placeholder*='Search' i]"] };
async function navigateToEventByName(booker, win, subject) {
  try {
    const sels = SEARCH_SEL[booker.id];
    if (!sels || !subject) return;
    const surname = (subject.split(/\s+/).filter(Boolean).pop() || subject).toLowerCase();
    await sleep(1500); // дать списку прогрузиться

    // Один и тот же код гоняем В КАЖДОМ ФРЕЙМЕ (compact-вид Pinnacle держит список во iframe):
    // вводим имя в поиск (если поле в этом фрейме есть) → ищем строку/ссылку матча по имени →
    // кликаем (ссылку по href — приоритетно). Возвращаем диагностику, даже если не кликнули.
    const code = `(async () => {
      const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
      const NAME = ${JSON.stringify(surname)};
      const inp = ${JSON.stringify(sels)}.map((s) => document.querySelector(s)).find(Boolean);
      if (inp) {
        inp.focus();
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(inp, ${JSON.stringify(subject)});
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("keyup", { bubbles: true }));
        await SLEEP(1900);
      }
      const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
      const NAMEn = norm(NAME);
      // ЦЕЛЫЙ токен, а не подстрока: «Eala» НЕ должен матчить «New zEALAnd» (был ложный клик)
      const hasTok = (txt) => norm(txt).split(/[^a-z0-9]+/).filter(Boolean).includes(NAMEn);
      const links = [...document.querySelectorAll("a[href]")];
      const linkHit = links.find((a) => hasTok(a.innerText));
      const named = [...document.querySelectorAll("a,[onclick],[class*=event],[class*=game],[class*=match],[class*=row]")]
        .filter((e) => e.offsetParent !== null && hasTok(e.innerText))
        .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
      let clicked = false, how = null, href = null, text = null;
      if (linkHit) { href = linkHit.getAttribute("href"); text = (linkHit.innerText || "").replace(/\\s+/g, " ").slice(0, 60); linkHit.click(); clicked = true; how = "link"; }
      else if (named[0]) { text = (named[0].innerText || "").replace(/\\s+/g, " ").slice(0, 60); named[0].click(); clicked = true; how = "el"; }
      return { hadInput: !!inp, links: links.length, named: named.length, clicked, how, href, text };
    })()`;

    let frames = [];
    try { frames = win.webContents.mainFrame.framesInSubtree; } catch { frames = [win.webContents.mainFrame]; }
    logger.log("INFO", "  [поиск матча] фреймов:", frames.length);
    for (const f of frames) {
      let r; try { r = await f.executeJavaScript(code); } catch (e) { r = { error: e.message }; }
      let furl = ""; try { furl = (f.url || "").slice(0, 55); } catch { /* ignore */ }
      logger.log("INFO", "  [поиск матча] frame:", furl, "→", JSON.stringify(r));
      if (r && r.clicked) break;
    }
    const surTok = surname.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      if (win.isDestroyed()) return;
      const u = win.webContents.getURL();
      if (!isEventUrl(u)) continue;
      // СВЕРКА: открылось событие ИМЕННО нужного игрока? (защита от ложного клика «Eala»→«Zealand»)
      const slugTokens = u.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/);
      if (slugTokens.includes(surTok)) { logger.log("INFO", "  событие найдено по имени:", u); return; }
      logger.log("WARN", "  открылось ЧУЖОЕ событие (нет «" + surTok + "» в URL), отменяю:", u);
      try { await win.loadURL(booker.url || "about:blank"); } catch (_) {} // увести с чужого → плечо не откроется → цикл скипнет
      return;
    }
    logger.log("WARN", "  событие по имени не открылось (subject:", subject + ")");
  } catch (e) { logger.log("WARN", "navigateToEventByName:", e); }
}

// Привести профиль к новому виду: прокси-объект {protocol,host,port,user,pass} + login.
function normalizeBooker(b) {
  if (!b) return b;
  if (typeof b.proxy === "string") {
    const p = parseProxy(b.proxy);
    b.proxy = p ? { protocol: p.scheme, host: p.host, port: p.port, user: p.user, pass: p.pass } : emptyProxy();
  } else if (!b.proxy || typeof b.proxy !== "object") {
    b.proxy = emptyProxy();
  }
  if (!b.login || typeof b.login !== "object") b.login = { user: "", pass: "" };
  return b;
}

// Разметка купона по конторе: селектор кнопок-исходов, поле суммы, слова на кнопке постановки.
// confirmSel — селектор кнопки ПОДТВЕРЖДЕНИЯ в модалке после кнопки постановки (если контора её показывает).
// Pinnacle: после «CONFIRM … SINGLE BET» вылетает модалка с «OK» (.confirm-bet-modal-btn-ok) — без неё ставка НЕ принята.
// Betano: наличие модалки после «BET NOW» НЕ подтверждено — проверить вживую (пока null).
// clearSel — кнопки «удалить выбор» в купоне (крестики), чтобы держать купон ЧИСТЫМ и готовым к ставке.
// Pinnacle: крестики .CloseStyled-* (в снимке 3 шт = 3 накопленных). Betano: чистим повторным кликом (deselect),
// placed-ставки («CASH OUT») не трогаются. clearSel у Betano пока null (не подтверждён селектор удаления).
const BETSLIP = {
  betano: { outcomeSel: ".selections__selection", stake: 'input[id^="stakeInput"]', placeWords: ["BET NOW"], confirmSel: null, clearSel: null },
  pinnacle: { outcomeSel: '[id*="|"]', stake: 'input[name="stake"]', placeWords: ["CONFIRM", "SINGLE BET"], confirmSel: ".confirm-bet-modal-btn-ok", clearSel: '[class*="CloseStyled"]' },
};
const ODDS_TOLERANCE = 0.05; // допустимое падение кэфа (5%)

// Чтение максимума ставки из купона (в валюте конторы: Pinnacle USDT≈USD, Betano EUR).
// Pinnacle печатает «Max bet USDT 10,035.00» под полем суммы — читаем текст.
// Betano прячет за кнопкой MAX — кликаем её, она вписывает макс в поле, читаем поле.
const PINN_MAX_JS = `(() => {
  // берём САМЫЙ МАЛЕНЬКИЙ (лист) элемент с «Max bet», иначе схватим родителя с кучей чисел → каша (2.3e15)
  const els = [...document.querySelectorAll('div,span,p,td,li')]
    .filter((e) => /max\\s*bet/i.test(e.innerText || '') && /\\d/.test(e.innerText || ''))
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  const t = els[0] ? (els[0].innerText || '').replace(/\\s+/g, ' ').trim() : '';
  if (!t) return null;
  // вытаскиваем число СРАЗУ после «Max bet», чтобы не прихватить посторонние числа из того же блока
  const m = t.match(/max\\s*bet[^\\d]*([\\d.,]+)/i);
  return m ? m[1] : t;
})()`;
const BETANO_MAX_JS = `(async () => {
  const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = document.querySelector('.max-button') || [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim().toUpperCase() === 'MAX');
  const inp = document.querySelector('input[id^="stakeInput"]');
  if (!btn || !inp) return null;
  btn.click();
  // поле MAX заполняется С ЗАДЕРЖКОЙ (на 700мс было пусто) — поллим до ~4с, вернём как заполнится
  for (let i = 0; i < 10; i++) { await SLEEP(400); if (inp.value) return inp.value; }
  return inp.value || null;
})()`;
// ДИАГНОСТИКА Betano-MAX: почему вернулся null (нашлась ли кнопка MAX, есть ли поле ставки, что на купоне)
const BETANO_MAXDIAG_JS = `(() => {
  const maxBtn = document.querySelector('.max-button');
  const txtBtn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim().toUpperCase() === 'MAX');
  const inp = document.querySelector('input[id^="stakeInput"]');
  const btns = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 14);
  return { maxButton: !!maxBtn, maxTextButton: !!txtBtn, stakeInput: !!inp, inputVal: inp ? inp.value : null, buttons: btns };
})()`;
async function readBookmakerMax(win, id) {
  const js = id === "pinnacle" ? PINN_MAX_JS : id === "betano" ? BETANO_MAX_JS : null;
  if (!js) return null;
  try {
    const raw = await win.webContents.executeJavaScript(js);
    const n = parseMoney(raw);
    if (!(n > 0) && id === "betano") {
      try {
        const d = await win.webContents.executeJavaScript(BETANO_MAXDIAG_JS);
        logger.log("INFO", "  [диаг макса betano] raw=", JSON.stringify(raw), "|", JSON.stringify(d));
      } catch (_) {}
    }
    return n > 0 ? n : null;
  } catch (e) { logger.log("WARN", "чтение макса:", id, e.message); return null; }
}

// Чтение БАЛАНСА счёта (в валюте конторы). Эвристика: листовые элементы шапки с валютой+числом,
// исключаем купон (max/bet now/potential). Берём верхний (шапка). Логируем кандидатов — если
// взял не то, по логу уточню селектор без отдельного снимка.
const BAL_JS = (cur, excl) => `(() => {
  const out = [];
  document.querySelectorAll('*').forEach((e) => {
    // раньше брали только листья; но баланс в шапке Pinnacle разбит на «USDT» + «23.00» в разных <span>,
    // поэтому разрешаем и НЕБОЛЬШИЕ контейнеры (≤4 потомков) с коротким текстом
    if (e.querySelectorAll('*').length > 4) return;
    const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 22 || !${cur}.test(t) || !/\\d/.test(t)) return;
    let top = 99999; try { top = Math.round(e.getBoundingClientRect().top); } catch (e) {}
    const range = /\\d[^\\d]*[-\\u2013][^\\d]*\\d/.test(t); // «20 € - 50 €» (виджет ставок) — не баланс
    out.push({ t, top, skip: ${excl}.test(t) || range });
  });
  // дедуп по тексту+позиции (родитель и потомок с одинаковым innerText)
  const seen = new Set();
  return out.filter((c) => { const k = c.t + '|' + c.top; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
})()`;
const PINN_BAL_JS = BAL_JS("/usdt|usd|\\\\$/i", "/max|bet|potential|win/i");
const BETANO_BAL_JS = BAL_JS("/€|eur/i", "/max|bet now|potential|win|stake/i");
// ДИАГНОСТИКА: выкладывает в лог содержимое ШАПКИ (верхняя полоса) — чтобы увидеть, как реально
// представлен баланс, если эвристика его не поймала. Снести, когда ридер баланса станет надёжным.
const HEADER_DIAG_JS = `(() => {
  const out = [];
  document.querySelectorAll('*').forEach((e) => {
    let r; try { r = e.getBoundingClientRect(); } catch (_) { return; }
    if (r.top < 0 || r.top > 200) return; // верхняя полоса (шапка)
    const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 40) return;
    if (!/[€$]|usd|eur|\\d[.,]\\d/i.test(t)) return; // только похожее на деньги/валюту
    out.push({ t, top: Math.round(r.top), nd: e.querySelectorAll('*').length, tag: e.tagName, cls: (e.className || '').toString().slice(0, 36) });
  });
  const seen = new Set();
  return out.filter((c) => { const k = c.t + '|' + c.top; if (seen.has(k)) return false; seen.add(k); return true; })
            .sort((a, b) => a.top - b.top).slice(0, 50);
})()`;
async function readBookmakerBalance(win, id) {
  const js = id === "pinnacle" ? PINN_BAL_JS : id === "betano" ? BETANO_BAL_JS : null;
  if (!js) return null;
  try {
    const cands = await win.webContents.executeJavaScript(js);
    if (!Array.isArray(cands) || !cands.length) { logger.log("INFO", "баланс", id, ": кандидатов нет"); }
    // баланс — в ШАПКЕ (top<250). Эхо максбета из купона (Betano «119,04 €» top 752) — НЕ баланс.
    const usable = (cands || []).filter((c) => !c.skip && c.top < 250).sort((a, b) => a.top - b.top);
    const best = usable[0];
    const value = best ? parseMoney(best.t) : null;
    logger.log("INFO", "баланс", id, "=", value, "| кандидаты:", JSON.stringify((cands || []).slice(0, 8)));
    // пока баланс не читается надёжно (Betano до сих пор null) — дампим шапку для отладки
    if (!(value > 0)) {
      try {
        const hdr = await win.webContents.executeJavaScript(HEADER_DIAG_JS);
        logger.log("INFO", "  [диаг шапки " + id + "]:", JSON.stringify(hdr));
      } catch (_) {}
    }
    return value > 0 ? value : null;
  } catch (e) { logger.log("WARN", "чтение баланса:", id, e.message); return null; }
}

// Закрыть cookie/TCF-согласие, если оно перекрыло страницу (иначе купон Betano не доступен —
// «List of Vendors»/«Allow All» в логе). Владелец явно разрешил жать вместо него. Приоритет:
// сперва «только необходимые/Reject» (приватнее и тоже убирает оверлей), иначе «принять все».
const CONSENT_JS = `(() => {
  const REJECT = /^(reject all|reject|decline|necessary only|only necessary|rejeitar( tudo)?|apenas (as )?necess[aá]ri\\w*|recusar)$/i;
  const ACCEPT = /^(allow all|accept all|accept|permitir todos|aceitar( tudo)?|concordo|i agree|agree|ok|got it|entendi|aceito|continuar)$/i;
  // ВНЕ консент-контейнера жмём ТОЛЬКО однозначные фразы (чтобы не нажать обычную «OK»/«Continuar»)
  const STRICT = /^(allow all|accept all|reject all|permitir todos|aceitar tudo|rejeitar tudo)$/i;
  const inConsent = (el) => !!el.closest('[id*="onetrust" i],[class*="onetrust" i],[id*="consent" i],[class*="consent" i],[id*="cookie" i],[class*="cookie" i],[class*="didomi" i],[id*="sp_message" i],[class*="cmp" i],[class*="gdpr" i],[class*="qc-cmp" i]');
  // ВИДИМОСТЬ через rect, а НЕ offsetParent: cookie-оверлеи это position:fixed → offsetParent=null,
  // и старый фильтр выбрасывал саму кнопку «Allow All». Теперь ловим её.
  const vis = (x) => { try { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (_) { return false; } };
  const btns = [...document.querySelectorAll('button,[role=button],a')].filter(vis);
  const txt = (x) => (x.innerText || '').replace(/\\s+/g, ' ').trim();
  // в консент-контейнере: reject → accept; вне контейнера — только однозначные STRICT-фразы
  let b = btns.find((x) => REJECT.test(txt(x)) && inConsent(x))
       || btns.find((x) => ACCEPT.test(txt(x)) && inConsent(x))
       || btns.find((x) => STRICT.test(txt(x)));
  if (b) { b.click(); return txt(b); }
  return null;
})()`;
async function dismissConsent(win) {
  if (!win || win.isDestroyed()) return false;
  try {
    const clicked = await win.webContents.executeJavaScript(CONSENT_JS);
    if (clicked) { logger.log("INFO", "  cookie-согласие закрыто кнопкой:", clicked); await sleep(900); return true; }
  } catch (e) { logger.log("WARN", "dismissConsent:", e.message); }
  return false;
}

// === Шаги простановки (переиспользуются в placeBet ОДНОГО плеча и в оркестраторе runBot) ===

// Шаг 1: выбрать исход в купоне конторы + прочитать максимум. Сумму НЕ вписывает.
async function selectLegOutcome(id) {
  const win = bookerWins.get(id);
  if (!win || win.isDestroyed()) return { ok: false, error: "окно конторы не открыто" };
  const cfg = BETSLIP[id];
  if (!cfg) return { ok: false, error: "нет разметки купона «" + id + "»" };
  const bet = pendingBet.get(id) || {};
  let selected = null, selectedOdds = null, how = null, pickedIndex = null;
  if (cfg.outcomeSel) {
    const sel = cfg.outcomeSel;
    const unit = marketUnit(bet.descFull); // сеты/геймы — для вкладки Pinnacle и маппинга фора→счёт
    await dismissConsent(win); // снять cookie/TCF-оверлей, если перекрыл купон (иначе кнопок/поля нет)
    await clearBetslip(win, cfg); // купон ВСЕГДА чист перед выбором (убрать накопленные неподтверждённые)
    // Дождаться, пока контора ПРОРИСУЕТ кнопки исходов (Pinnacle standard SPA рендерит ~10с) —
    // иначе читаем пустую страницу и получаем «кнопок:0».
    for (let i = 0; i < 15; i++) {
      await dismissConsent(win); // cookie-оверлей может всплыть ПОЗЖЕ начального — ловим его в цикле
      let n = 0; try { n = await win.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(sel)}).length`); } catch { /* ignore */ }
      if (n > 0) break;
      await sleep(1000);
    }
    if (id === "pinnacle") { // вкладка по единице (сеты/геймы, если есть) + ВСЕГДА «Show All» (раскрыть альт-линии)
      try {
        await win.webContents.executeJavaScript(`(() => {
          const unit = ${JSON.stringify(unit || "")};
          if (unit) {
            const tab = document.getElementById(unit === "set" ? "set-markets" : "game-markets") ||
              [...document.querySelectorAll("button,[role=button]")].find((b) => (b.innerText || "").trim().toUpperCase() === (unit === "set" ? "SET MARKETS" : "GAME MARKETS"));
            if (tab) tab.click();
          }
          const all = document.querySelector(".btn-toggle-all"); if (all) all.click();
          return true;
        })()`);
        await sleep(1500);
      } catch (e) { logger.log("WARN", "pinnacle tab/showall:", e); }
    }
    let buttons = [];
    try {
      buttons = await win.webContents.executeJavaScript(`(() => {
        const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
        return [...document.querySelectorAll(${JSON.stringify(sel)})].map((el, i) => ({ i, id: el.id || "", text: norm(el.innerText) }));
      })()`);
    } catch (e) { return { ok: false, win, cfg, bet, error: "не прочитал кнопки исходов: " + e.message }; }
    let eventUrl = ""; try { eventUrl = win.webContents.getURL(); } catch { /* ignore */ }
    const choice = pickOutcome({ desc: bet.desc, expectedOdds: bet.expectedOdds, outcomeId: bet.outcomeId, buttons, eventUrl, unit, subject: extractSubject(bet.descFull) });
    if (!choice) return { ok: false, win, cfg, bet, error: "не нашёл исход (линия/кэф). desc=" + (bet.desc || "—") + " кэф=" + (bet.expectedOdds || "?") + " кнопок:" + buttons.length };
    selected = choice.text; selectedOdds = choice.odds; how = choice.how; pickedIndex = choice.i;
    try {
      const clicked = await win.webContents.executeJavaScript(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = els[${Number(choice.i)}]; if (el) { el.click(); return true; } return false; })()`);
      if (!clicked) return { ok: false, win, cfg, bet, selected, selectedOdds, how, error: "кнопка исхода не кликнулась (i=" + choice.i + ")" };
    } catch (e) { return { ok: false, win, cfg, bet, selected, selectedOdds, how, error: "клик исхода: " + e.message }; }
    await sleep(800);
  }
  if (cfg.outcomeSel) await dismissConsent(win); // оверлей мог всплыть к моменту чтения макса — закрыть
  const maxStake = cfg.outcomeSel ? await readBookmakerMax(win, id) : null;
  const exp = bet.expectedOdds;
  const oddsOk = (exp && selectedOdds) ? (selectedOdds >= exp * (1 - ODDS_TOLERANCE)) : null;
  return { ok: true, win, cfg, bet, selected, selectedOdds, how, maxStake, expectedOdds: exp || null, oddsOk, selectedIndex: pickedIndex };
}

// Снять свой выбор (повторный клик по той же кнопке-исходу = убрать из купона). Чтобы купон не
// копил «осиротевшие» ставки от скипнутых циклов (иначе Betano собирает экспресс → MAX/сумма ломаются).
async function deselectLeg(id, index) {
  if (index == null) return;
  const win = bookerWins.get(id), cfg = BETSLIP[id];
  if (!win || win.isDestroyed() || !cfg || !cfg.outcomeSel) return;
  try {
    await win.webContents.executeJavaScript(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(cfg.outcomeSel)})]; const el = els[${Number(index)}]; if (el) { el.click(); return true; } return false; })()`);
    await sleep(400);
    logger.log("INFO", "  купон: снял выбор", id, "(i=" + index + ")");
  } catch (e) { logger.log("WARN", "deselectLeg:", id, e.message); }
}
// ПОЛНАЯ ОЧИСТКА купона — убрать ВСЕ накопленные (неподтверждённые) выборы крестиками, чтобы купон
// был всегда чист и готов к ставке. placed-ставки (с «CASH OUT») крестиков не имеют — не трогаются.
async function clearBetslip(win, cfg) {
  if (!win || win.isDestroyed() || !cfg || !cfg.clearSel) return;
  try {
    for (let i = 0; i < 6; i++) {
      const n = await win.webContents.executeJavaScript(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(cfg.clearSel)})]; els.forEach((b) => { try { b.click(); } catch (_) {} }); return els.length; })()`);
      if (!n) break;
      await sleep(400);
    }
  } catch (e) { logger.log("WARN", "clearBetslip:", e.message); }
}
// ДИАГНОСТИКА купона: кандидаты в кнопки «удалить ставку» (если повторный клик не чистит купон,
// по этому найду точный селектор полной очистки). Срабатывает только при обнаруженном накоплении.
const SLIP_DIAG_JS = `(() => {
  const rx = /remove|delete|close|clear|trash|remover|eliminar|limpar|fechar|excluir|apagar/i;
  const out = [];
  document.querySelectorAll('button,[role=button],a,[aria-label],[title]').forEach((e) => {
    const al = (e.getAttribute('aria-label') || e.getAttribute('title') || '');
    const cls = (e.className || '').toString();
    const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!(rx.test(al) || rx.test(cls) || t === '×' || t === '✕' || /^[xX]$/.test(t))) return;
    let top = -1; try { top = Math.round(e.getBoundingClientRect().top); } catch (_) {}
    out.push({ tag: e.tagName, al: al.slice(0, 30), cls: cls.slice(0, 44), t: t.slice(0, 12), top });
  });
  const seen = new Set();
  return out.filter((c) => { const k = c.tag + c.al + c.cls + c.top; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
})()`;
// Снимок окна конторы (PNG) — визуальное доказательство, что купон реально открыт и заполнен.
async function screenshotBooker(win, id) {
  try {
    if (!win || win.isDestroyed()) return null;
    const img = await win.webContents.capturePage();
    const file = join(logger.dir() || app.getPath("userData"), `betslip-${id}.png`);
    require("node:fs").writeFileSync(file, img.toPNG());
    return file;
  } catch (e) { logger.log("WARN", "screenshot:", id, e.message); return null; }
}

// Шаг 2: вписать сумму (React value-tracker) + найти кнопку постановки. Исход уже выбран.
async function fillStakeOnly(win, cfg, stake) {
  const js = `(async () => {
    const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
    const inp = document.querySelector(${JSON.stringify(cfg.stake)});
    if (!inp) return { error: "поле суммы не найдено — исход не в купоне" };
    inp.focus();
    const old = inp.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(inp, ${JSON.stringify(String(stake))});
    if (inp._valueTracker) inp._valueTracker.setValue(old);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    await SLEEP(800);
    const words = ${JSON.stringify(cfg.placeWords)};
    const pbtn = [...document.querySelectorAll("button")].find((b) => { const t = (b.innerText || "").toUpperCase(); return words.every((w) => t.includes(w.toUpperCase())); });
    return { ok: true, stakeValue: inp.value, placeBtnText: pbtn ? (pbtn.innerText || "").replace(/\\s+/g, " ").trim() : null, hasPlaceBtn: !!pbtn };
  })()`;
  try { return await win.webContents.executeJavaScript(js); }
  catch (e) { return { error: e.message }; }
}

// Шаг 3: боевой клик по кнопке постановки + ПОДТВЕРЖДЕНИЕ модалки (Pinnacle «OK»).
async function clickPlace(win, cfg) {
  try {
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const words = ${JSON.stringify(cfg.placeWords)};
      const b = [...document.querySelectorAll("button")].find((x) => { const t = (x.innerText || "").toUpperCase(); return words.every((w) => t.includes(w.toUpperCase())); });
      if (b) { b.click(); return true; } return false;
    })()`);
    if (!clicked) return false;
    // После кнопки постановки контора может показать модалку подтверждения — без неё ставка НЕ принята.
    // Поллим до ~3с и кликаем «OK» (Pinnacle: .confirm-bet-modal-btn-ok).
    if (cfg.confirmSel) {
      for (let i = 0; i < 8; i++) {
        await sleep(400);
        const ok = await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(cfg.confirmSel)}); if (el) { el.click(); return true; } return false; })()`);
        if (ok) { logger.log("INFO", "  ставка: подтвердил модалку (OK)"); break; }
      }
    }
    return true;
  } catch { return false; }
}

// Проверка, что ставка ПРИНЯТА конторой: после успешной постановки кнопка постановки ИСЧЕЗАЕТ
// (купон → чек/приём) и модалка подтверждения закрыта. Если кнопка осталась — НЕ принято.
// Консервативно: не уверены = НЕ принято (лучше ложный стоп, чем незамеченная экспозиция).
async function verifyPlaced(win, cfg) {
  if (!win || win.isDestroyed() || !cfg) return false;
  const js = `(() => {
    const words = ${JSON.stringify(cfg.placeWords)};
    const stillBtn = [...document.querySelectorAll("button")].some((b) => { const t = (b.innerText || "").toUpperCase(); return words.every((w) => t.includes(w.toUpperCase())); });
    const modal = ${cfg.confirmSel ? JSON.stringify(cfg.confirmSel) : "null"};
    const modalOpen = modal ? !!document.querySelector(modal) : false;
    return !stillBtn && !modalOpen; // принято = кнопки постановки и модалки больше нет
  })()`;
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    try { if (await win.webContents.executeJavaScript(js)) return true; } catch (_) { /* ignore */ }
  }
  return false;
}

// Простановка ОДНОГО плеча (IPC dry-run/place): выбор → сумма → (live) клик.
async function placeBet(id, stake, live = false) {
  const s = await selectLegOutcome(id);
  if (!s.ok) {
    const r = { ok: false, error: s.error, selected: s.selected, selectedOdds: s.selectedOdds, how: s.how };
    logger.log("WARN", "dry-run/place", id, JSON.stringify(r));
    return r;
  }
  const f = await fillStakeOnly(s.win, s.cfg, stake);
  const r = { ...f, selected: s.selected, selectedOdds: s.selectedOdds, how: s.how, maxStake: s.maxStake, expectedOdds: s.expectedOdds, oddsOk: s.oddsOk };
  if (r.error) { r.ok = false; logger.log("WARN", "dry-run/place", id, JSON.stringify(r)); return r; }
  r.placed = false;
  if (live && r.hasPlaceBtn && s.oddsOk !== false) { await clickPlace(s.win, s.cfg); r.placed = true; }
  logger.log("INFO", live ? "PLACE" : "dry-run", id, JSON.stringify(r));
  return r;
}

// === Оркестратор «Запуск бота»: вилка → оба плеча → выбор → калькулятор → суммы → (live) клик ===

// Открыть событие плеча по surebet-nav (резолв → окно конторы → дойти до события). Возвращает,
// когда окно конторы на событии (есть числовой id). Используется кликом по плечу и оркестратором.
async function routeLeg(navUrl) {
  const nav = resolveSurebetNav(navUrl, settings.bookers || []);
  if (!nav || !nav.booker) return { ok: false, error: "плечо не сопоставлено с конторой" };
  pendingBet.set(nav.booker.id, { outcomeId: nav.outcomeId, expectedOdds: nav.expectedOdds, desc: nav.desc, descFull: nav.descFull });
  const initial = nav.targetUrl || nav.booker.url;
  logger.log("INFO", "  → контора:", nav.booker.id, "| исход:", nav.desc, "| кэф:", nav.expectedOdds, "| открываю:", initial);
  try { logger.log("INFO", "  [диаг] descFull:", nav.descFull || "—", "| markers:", JSON.stringify(nav.markers || {}).slice(0, 400)); } catch { /* ignore */ }
  await openBookerProfile(nav.booker, initial).catch((e) => logger.log("WARN", "route booker:", e));
  if (!isEventUrl(initial)) {
    const eventUrl = await resolveEventViaNav(navUrl, nav.booker).catch(() => null);
    const w0 = bookerWins.get(nav.booker.id);
    if (eventUrl && eventUrl !== initial && w0 && !w0.isDestroyed()) { logger.log("INFO", "  глубокая ссылка события:", eventUrl); await w0.loadURL(eventUrl).catch(() => {}); await sleep(2500); }
    // Фолбэк: всё ещё не на КОНКРЕТНОМ событии (Pinnacle часто застревает на /standard/home) →
    // ищем матч на читаемой standard-странице по имени из вилки (имя теперь англ.).
    let cur = ""; try { cur = w0 && !w0.isDestroyed() ? w0.webContents.getURL() : ""; } catch { /* ignore */ }
    if (!isEventUrl(cur) && w0 && !w0.isDestroyed()) {
      const subject = extractSubject(nav.descFull) || extractSubject(nav.desc);
      if (subject) { logger.log("INFO", "  редирект не дал событие — ищу по имени:", subject); await navigateToEventByName(nav.booker, w0, subject); }
    }
  } else { logger.log("INFO", "  глубокая ссылка уже есть — surebet-редирект пропускаю"); }
  const w = bookerWins.get(nav.booker.id);
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (!w || w.isDestroyed()) return { ok: false, booker: nav.booker, error: "окно закрылось" };
    let u = ""; try { u = w.webContents.getURL(); } catch { /* ignore */ }
    if (isEventUrl(u)) return { ok: true, booker: nav.booker, win: w };
  }
  return { ok: false, booker: nav.booker, error: "событие не открылось за 15с" };
}

// Найти в сканере вилку Betano + Pinnacle (Delayed) ПО ИМЕНАМ контор. НЕ кликает — возвращает
// токен вилки и индексы плеч (prong), чтобы кликать их ПО ОЧЕРЕДИ (дохождение события через
// surebet тогда идёт по одному, без параллельного конфликта). skip — токены уже пробованных.
async function findVilka(skip = []) {
  if (!surebetWin || surebetWin.isDestroyed()) return { ok: false, error: "окно surebet закрыто" };
  try {
    return await surebetWin.webContents.executeJavaScript(`(() => {
      const SKIP = ${JSON.stringify(skip)};
      let records = 0, pairs = 0, fresh = 0, hit = null; // счётчики для «пульса» (почему бот простаивает)
      for (const tb of document.querySelectorAll('tbody.surebet_record')) {
        records++;
        const books = [...tb.querySelectorAll('[data-testid="surebet-leg-bookmaker"]')].map((e) => (e.innerText || '').trim());
        const byProng = {}; let token = '';
        tb.querySelectorAll('a[href*="/nav/surebet/prong/"]').forEach((a) => {
          const m = (a.getAttribute('href') || a.href || '').match(/\\/prong\\/(\\d+)\\/([^/]+)/);
          if (m) { if (byProng[m[1]] === undefined) byProng[m[1]] = a; token = m[2]; }
        });
        let bi = -1, pi = -1;
        books.forEach((nm, i) => {
          const low = nm.toLowerCase();
          if (/betano/.test(low) && bi < 0) bi = i;
          else if (/pinnacle/.test(low) && /delayed/.test(low) && pi < 0) pi = i;
        });
        if (!(bi >= 0 && pi >= 0 && byProng[bi] && byProng[pi])) continue; // не пара Betano+Pinnacle(Delayed)
        pairs++;
        if (token && SKIP.indexOf(token) >= 0) continue; // уже пробованная
        fresh++;
        if (!hit) hit = { token, betano: { name: books[bi], prong: bi }, pinnacle: { name: books[pi], prong: pi } };
      }
      if (hit) return { ok: true, records, pairs, fresh, token: hit.token, betano: hit.betano, pinnacle: hit.pinnacle };
      return { ok: false, records, pairs, fresh };
    })()`);
  } catch (e) { return { ok: false, error: "чтение сканера: " + e.message }; }
}

// Кликнуть ОДНО плечо вилки (по токену + индексу пронга). surebet строит nav-ссылку →
// setWindowOpenHandler ловит → routeLeg открывает событие.
async function clickVilkaLeg(token, prong) {
  if (!surebetWin || surebetWin.isDestroyed()) return false;
  try {
    return await surebetWin.webContents.executeJavaScript(`(() => {
      for (const tb of document.querySelectorAll('tbody.surebet_record')) {
        const byProng = {}; let token = '';
        tb.querySelectorAll('a[href*="/nav/surebet/prong/"]').forEach((a) => {
          const m = (a.getAttribute('href') || a.href || '').match(/\\/prong\\/(\\d+)\\/([^/]+)/);
          if (m) { if (byProng[m[1]] === undefined) byProng[m[1]] = a; token = m[2]; }
        });
        if (token === ${JSON.stringify(token)} && byProng[${Number(prong)}]) { byProng[${Number(prong)}].click(); return true; }
      }
      return false;
    })()`);
  } catch { return false; }
}

function bookerUrl(id) { const w = bookerWins.get(id); try { return w && !w.isDestroyed() ? w.webContents.getURL() : "—"; } catch { return "—"; } }

// Дождаться, что окно конторы открылось на КОНКРЕТНОМ событии (числовой id в URL).
// 40с: дохождение через surebet + фолбэк-поиск по имени могут занять время.
async function waitBookerEvent(id, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await sleep(1000);
    const w = bookerWins.get(id);
    if (w && !w.isDestroyed()) { let u = ""; try { u = w.webContents.getURL(); } catch { /* ignore */ } if (isEventUrl(u)) return true; }
  }
  return false;
}

let botBusy = false;
let lastBotHeartbeat = 0;      // троттлинг ЛОГА простоя (раз в ~минуту)
let botWaitMsg = null;         // причина паузы-ожидания (нехватка баланса плеча) — НЕ выключаемся, ждём
let botPulseState = { records: 0, pairs: 0, fresh: 0, error: null }; // для живого пульса в панель
// Отправить живой статус бота в панель (видно: жив / ждёт / обрабатывает / ошибка)
function sendBotPulse(extra) {
  if (!panelWin || panelWin.isDestroyed()) return;
  try {
    panelWin.webContents.send("bot-pulse", {
      armed: botArmed, busy: botBusy, tried: triedVilkas.size,
      success: botStats ? botStats.completed : 0, target: TEST_TARGET,
      records: botPulseState.records, pairs: botPulseState.pairs, fresh: botPulseState.fresh,
      // счётчики сессии: всего обработано / оба плеча (хедж) / незахеджировано / пропущено
      total: botStats ? botStats.attempts : 0, hedged: botStats ? botStats.hedged : 0,
      exposed: botStats ? botStats.exposed : 0, skipped: botStats ? botStats.skipped : 0,
      wait: botWaitMsg, error: botPulseState.error, at: Date.now(), ...(extra || {}),
    });
  } catch (_) { /* ignore */ }
}
let botArmed = false;          // «взведён»: ждём вилку и отрабатываем цикл
let botArmLive = false;        // боевой ли цикл (только при тумблере БОЕВОЙ)
const triedVilkas = new Set(); // токены вилок, которые бот пробовал → пропускаем дальше (и успех, и скип)

// === Тест-режим: бот НЕ останавливается на успехе, крутит до TEST_TARGET успешных циклов, потом отчёт ===
const TEST_TARGET = 10;        // сколько успешных циклов собрать в тесте
let botStats = null;           // счётчики текущего захода (null = ещё не взводили)
function newBotStats() {
  return { startedAt: Date.now(), attempts: 0, completed: 0, skipped: 0, skipReasons: {}, sports: {}, completedDetails: [],
           hedged: 0, exposed: 0, placeNone: 0, // боевые: оба приняты / экспозиция / Betano не принят
           reads: { bMax: 0, bBal: 0, pMax: 0, pBal: 0, bothOddsOk: 0 } };
}
// категория причины скипа (для сводки)
function skipCategory(reason) {
  const r = String(reason || "");
  if (/Betano:.*не нашёл исход/i.test(r)) return "Betano: не нашёл исход";
  if (/Pinnacle:.*не нашёл исход/i.test(r)) return "Pinnacle: не нашёл исход";
  if (/Betano:.*событие не открыл/i.test(r)) return "Betano: событие не открылось";
  if (/Pinnacle:.*событие не открыл/i.test(r)) return "Pinnacle: событие не открылось";
  if (/плечо не кликнул/i.test(r)) return "плечо не кликнулось";
  if (/расчёт без сумм/i.test(r)) return "расчёт без сумм";
  return r.slice(0, 40) || "прочее";
}
function recordBotStat(res) {
  if (!botStats || res.waiting) return; // ожидание баланса — не вилка-результат, не считаем
  botStats.attempts++;
  if (res.skipped) {
    botStats.skipped++;
    const c = skipCategory(res.reason);
    botStats.skipReasons[c] = (botStats.skipReasons[c] || 0) + 1;
  } else if (res.ok) {
    botStats.completed++;
    botStats.sports[res.sport || "?"] = (botStats.sports[res.sport || "?"] || 0) + 1;
    if (res.betano.max > 0) botStats.reads.bMax++;
    if (res.betano.balance > 0) botStats.reads.bBal++;
    if (res.pinnacle.max > 0) botStats.reads.pMax++;
    if (res.pinnacle.balance > 0) botStats.reads.pBal++;
    if (res.betano.oddsOk !== false && res.pinnacle.oddsOk !== false) botStats.reads.bothOddsOk++;
    if (res.hedge === "ok") botStats.hedged++;
    else if (res.hedge === "exposed") botStats.exposed++;
    else if (res.hedge === "none") botStats.placeNone++;
    botStats.completedDetails.push({
      n: botStats.completed, sport: res.sport, pair: res.pair, profitPct: res.profitPct,
      b: res.betano.selected, bMax: res.betano.max, bBal: res.betano.balance,
      p: res.pinnacle.selected, pMax: res.pinnacle.max, pBal: res.pinnacle.balance,
    });
    logger.log("INFO", "[бот ТЕСТ] успешный цикл " + botStats.completed + "/" + TEST_TARGET + " · " + (res.sport || "?") + " · " + res.profitPct + "%");
  }
}
function formatBotStats(s) {
  const secs = Math.round((Date.now() - s.startedAt) / 1000);
  const dur = Math.floor(secs / 60) + "м " + (secs % 60) + "с";
  const profits = s.completedDetails.map((d) => d.profitPct).filter((x) => typeof x === "number");
  const avg = profits.length ? (profits.reduce((a, b) => a + b, 0) / profits.length) : 0;
  const L = [];
  L.push("════ СТАТИСТИКА ТЕСТА (" + s.completed + " успешных циклов) ════");
  L.push("Длительность: " + dur);
  L.push("Вилок поймано: " + s.attempts + " (успешно " + s.completed + ", пропущено " + s.skipped + ")");
  L.push("Хит-рейт: " + (s.attempts ? Math.round((s.completed / s.attempts) * 100) : 0) + "%");
  L.push("— БОЕВОЙ: оба плеча (хедж): " + s.hedged + " | НЕЗАХЕДЖИРОВАНО: " + s.exposed + " | Betano не принят: " + s.placeNone);
  L.push("— Пропуски по причинам:");
  Object.entries(s.skipReasons).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L.push("    " + k + ": " + v));
  L.push("— Успешные по спорту:");
  Object.entries(s.sports).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L.push("    " + k + ": " + v));
  L.push("— Чтение данных (из " + s.completed + " успешных):");
  L.push("    Betano макс: " + s.reads.bMax + "/" + s.completed + " | баланс: " + s.reads.bBal + "/" + s.completed + " (баланс by design ?)");
  L.push("    Pinnacle макс: " + s.reads.pMax + "/" + s.completed + " | баланс: " + s.reads.pBal + "/" + s.completed);
  L.push("    кэф oddsOk обоих: " + s.reads.bothOddsOk + "/" + s.completed);
  L.push("— Профит: средн " + (Math.round(avg * 100) / 100) + "% | мин " + (profits.length ? Math.min(...profits) : 0) + "% | макс " + (profits.length ? Math.max(...profits) : 0) + "%");
  L.push("— Детали успешных:");
  s.completedDetails.forEach((d) => L.push("    " + d.n + ". " + (d.sport || "?") + " · " + d.pair + " · B[" + d.b + "] maxB=" + d.bMax + " balB=" + d.bBal + " | P[" + d.p + "] maxP=" + d.pMax + " balP=" + d.pBal + " · " + d.profitPct + "%"));
  return L.join("\n");
}

// Один цикл: поймать+кликнуть НОВУЮ (не пробованную) вилку → события → выбор → расчёт → суммы →
// (live) клик. Возврат: null — подходящей вилки сейчас нет (ждём); {skipped} — вилку не смог,
// занёс в пропуск, ищем дальше; {ok} — успех (бот разоружается).
async function runOneBotCycle(live = false) {
  botBusy = true;
  botWaitMsg = null; // сброс ожидания; выставится заново, если плечо снова не покрывается
  try {
    const v = await findVilka([...triedVilkas]);
    botPulseState = { records: v.records || 0, pairs: v.pairs || 0, fresh: v.fresh || 0, error: v.error || null };
    if (!v.ok) {
      // «пульс»: бот ЖИВ, просто нет новой годной вилки. В панель — сразу, в ЛОГ — раз в ~минуту.
      sendBotPulse();
      const now = Date.now();
      if (now - lastBotHeartbeat > 55000) {
        lastBotHeartbeat = now;
        logger.log("INFO", "[бот] жив, жду вилку: в фиде", v.records || 0, "записей | годных пар Betano+Pinnacle(Delayed):", v.pairs || 0, "| новых (не пробованных):", v.fresh || 0, "| уже пробовано:", triedVilkas.size);
      }
      return null; // нет НОВОЙ подходящей вилки — ждём следующий тик
    }
    const tok = v.token || "";
    const pair = (v.betano.name || "Betano") + " + " + (v.pinnacle.name || "Pinnacle");
    // на любом провале — заносим вилку в «пробованные» и просим бота искать дальше (skipped)
    const skip = (reason) => { if (tok) triedVilkas.add(tok); logger.log("INFO", "[бот] пропускаю вилку:", reason); return { skipped: true, reason, pair }; };
    logger.log("INFO", "[бот] вилка:", pair, "| token:", tok, "— открываю плечи по очереди");
    if (!fxRate || !(fxRate.rate > 0)) await refreshFx();
    // ПОСЛЕДОВАТЕЛЬНО: сначала Betano (клик → ждём событие), потом Pinnacle — чтобы дохождение
    // события через surebet не шло параллельно (это и валило Pinnacle).
    if (!(await clickVilkaLeg(tok, v.betano.prong))) return skip("Betano: плечо не кликнулось");
    if (!(await waitBookerEvent("betano"))) return skip("Betano: событие не открылось (застряло: " + bookerUrl("betano") + ")");
    if (!(await clickVilkaLeg(tok, v.pinnacle.prong))) return skip("Pinnacle: плечо не кликнулось");
    if (!(await waitBookerEvent("pinnacle"))) return skip("Pinnacle: событие не открылось (застряло: " + bookerUrl("pinnacle") + ")");
    const sB = await selectLegOutcome("betano");
    if (!sB.ok) return skip("Betano: " + sB.error);
    const sP = await selectLegOutcome("pinnacle");
    // Pinnacle не вышел, а Betano уже выбран → снимаем выбор Betano, чтобы купон не копил экспресс
    if (!sP.ok) { await deselectLeg("betano", sB.selectedIndex); return skip("Pinnacle: " + sP.error); }
    // ПОТОЛОК ПЛЕЧА.
    // Betano: НЕ читаем баланс для капа — ридер ненадёжен (хватает уже ПОСТАВЛЕННЫЕ ставки «Single X€»/
    // «CASH OUT» и занижал ставку до копеек, по нарастающей). Кнопка MAX уже = min(макс события, баланс),
    // поэтому Betano-кап = только maxStake.
    const balB = null;
    const balP = await readBookmakerBalance(sP.win, "pinnacle"); // Pinnacle-баланс надёжен (шапка «X USDT»)
    const capEur = sB.maxStake || Infinity;
    const capUsd = Math.min(sP.maxStake || Infinity, balP || Infinity);
    const limit = Number(settings.vilkaLimitEur) > 0 ? Number(settings.vilkaLimitEur) : Infinity;
    const calc = vilkaStakes({ oddsEur: sB.selectedOdds, oddsUsd: sP.selectedOdds, usdToEur: fxRate.rate, maxEur: capEur, maxUsd: capUsd, limitEur: limit });
    if (!(calc.eur > 0) || !(calc.usd > 0)) {
      await deselectLeg("betano", sB.selectedIndex); await deselectLeg("pinnacle", sP.selectedIndex); // оба выбора снять
      return skip("расчёт без сумм: " + (calc.error || "проверь кэфы/максы/баланс"));
    }
    // БОЕВОЙ: ПЕРЕД первым плечом (Betano) убедиться, что ВТОРОЕ (Pinnacle) покроется балансом.
    // Если нет — НЕ ставим вообще (нет экспозиции) и НЕ блоклистим вилку: остаёмся в ожидании пополнения.
    if (live && (!(balP > 0) || calc.usd > balP)) {
      await deselectLeg("betano", sB.selectedIndex); await deselectLeg("pinnacle", sP.selectedIndex);
      botWaitMsg = "Pinnacle баланс " + (balP || 0) + " USDT < нужно " + calc.usd + " — жду пополнения (Betano не ставлю)";
      logger.log("INFO", "[бот] " + botWaitMsg + " · остаюсь в ожидании, вилку не блоклистю");
      return { waiting: true, reason: botWaitMsg, pair };
    }
    await dismissConsent(sB.win); await dismissConsent(sP.win); // снять оверлей перед заполнением купона
    const fB = await fillStakeOnly(sB.win, sB.cfg, calc.eur);
    const fP = await fillStakeOnly(sP.win, sP.cfg, calc.usd);
    let placed = false, hedge = null; // hedge: "ok"=оба приняты | "exposed"=Betano да, Pinnacle нет | "none"=Betano не принят
    if (live && fB.hasPlaceBtn && fP.hasPlaceBtn && sB.oddsOk !== false && sP.oddsOk !== false) {
      // Betano ПЕРВЫМ → проверяем ПРИЁМ → Pinnacle ставим ТОЛЬКО если Betano принят (иначе обратная экспозиция).
      await clickPlace(sB.win, sB.cfg);
      const bOk = await verifyPlaced(sB.win, sB.cfg);
      if (!bOk) {
        hedge = "none"; // Betano не принял → Pinnacle НЕ ставим → экспозиции нет
        logger.log("WARN", "[БОТ] Betano НЕ принял ставку — Pinnacle не ставлю (экспозиции нет)");
      } else {
        await clickPlace(sP.win, sP.cfg); // второе плечо — закрываем позицию безусловно
        const pOk = await verifyPlaced(sP.win, sP.cfg);
        placed = true;
        hedge = pOk ? "ok" : "exposed";
        if (!pOk) logger.log("ERROR", "🔴 [БОТ] НЕЗАХЕДЖИРОВАНО: Betano принят, Pinnacle НЕ принят — АВТО-СТОП");
        else logger.log("INFO", "[БОТ] оба плеча приняты (хедж есть)");
      }
    }
    const sportOf = (u) => { const m = String(u || "").match(/\/standard\/([a-z-]+)\//i); return m ? m[1] : "?"; };
    const summary = {
      ok: true, placed, hedge, profitable: calc.ok, rate: fxRate.rate, pair, token: tok, sport: sportOf(bookerUrl("pinnacle")),
      profitPct: calc.profitPct, profitEur: calc.profitEur, totalEur: calc.totalEur,
      betano: { selected: sB.selected, odds: sB.selectedOdds, oddsOk: sB.oddsOk, max: sB.maxStake, balance: balB, stake: calc.eur, stakeValue: fB.stakeValue, placeBtn: fB.placeBtnText },
      pinnacle: { selected: sP.selected, odds: sP.selectedOdds, oddsOk: sP.oddsOk, max: sP.maxStake, balance: balP, stake: calc.usd, stakeValue: fP.stakeValue, placeBtn: fP.placeBtnText },
    };
    if (tok) triedVilkas.add(tok); // успешную вилку тоже блоклистим — чтобы следующий цикл искал НОВУЮ
    logger.log("INFO", live ? "[БОТ PLACE]" : "[бот dry-run]", JSON.stringify(summary));
    // КУПОН не должен копиться: реальная ставка очищает купон сама, а вот если НЕ поставили
    // (dry-run; или кэф съехал и live-гейт не пустил) — выборы остаются и блокируют следующую ставку.
    // Поэтому при !placed сразу снимаем ОБА выбора (повторный клик по тем же кнопкам = убрать из купона).
    if (!placed) {
      // DRY-RUN: дать УВИДЕТЬ заполненный купон (снимок-доказательство + пауза), потом уже чистим.
      // Иначе авто-очистка снимает выбор за ~1.5с и кажется, будто купон «не открывался».
      if (!live) {
        const shotB = await screenshotBooker(sB.win, "betano");
        const shotP = await screenshotBooker(sP.win, "pinnacle");
        logger.log("INFO", "  [купон-снимок] betano:", shotB || "-", "| pinnacle:", shotP || "-", "— держу 4с, смотри купоны");
        await sleep(4000);
      }
      // если видим накопление (Pinnacle «SINGLE BETS» мн.ч.) — повторный клик не справился: дамп кнопок «удалить»
      if (/SINGLE BETS/i.test(fP.placeBtnText || "")) {
        try { logger.log("INFO", "  [диаг купона betano]:", JSON.stringify(await sB.win.webContents.executeJavaScript(SLIP_DIAG_JS))); } catch (_) {}
        try { logger.log("INFO", "  [диаг купона pinnacle]:", JSON.stringify(await sP.win.webContents.executeJavaScript(SLIP_DIAG_JS))); } catch (_) {}
      }
      await deselectLeg("betano", sB.selectedIndex);
      await deselectLeg("pinnacle", sP.selectedIndex);
    }
    return summary;
  } catch (e) {
    logger.log("ERROR", "runOneBotCycle:", e);
    botPulseState.error = e.message; sendBotPulse({ busy: false }); // ошибку — сразу в панель
    return { skipped: true, reason: e.message, pair: "?" };
  }
  finally { botBusy = false; }
}

function findBooker(id) { return (settings.bookers || []).find((b) => b.id === id); }
function activeBookerWin() {
  let w = lastBookerId && bookerWins.get(lastBookerId);
  if (w && !w.isDestroyed()) return w;
  for (const win of bookerWins.values()) if (win && !win.isDestroyed()) return win;
  return null;
}

// Краткая сводка интерактивных элементов купона (видимые поля и кнопки) — её удобно
// скопировать и прислать. Заодно сохраняем полный HTML на всякий случай.
const BOOKER_SUMMARY_JS = `(() => {
  const cut = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const vis = (e) => e.offsetParent !== null || (e.getClientRects && e.getClientRects().length);
  const inputs = [...document.querySelectorAll('input, [contenteditable=""], [contenteditable="true"]')]
    .filter(vis).slice(0, 50)
    .map((e) => 'INPUT type=' + (e.type || 'text') + ' name=' + (e.name || '-') + ' id=' + (e.id || '-') +
      ' ph="' + cut(e.placeholder, 30) + '" cls="' + cut(e.className, 70) + '"');
  const btns = [...document.querySelectorAll('button, [role=button], input[type=submit], a[class*=btn], a[class*=button]')]
    .filter(vis).slice(0, 80)
    .map((b) => 'BTN "' + cut(b.innerText || b.value, 35) + '" id=' + (b.id || '-') + ' cls="' + cut(b.className, 70) + '"');
  // элементы, где может быть МАКСИМУМ ставки: текст с max/min/limit/лимит/макс (+ рядом число)
  const limRe = /\\b(max|min|limit|лимит|макс|мин)\\b/i;
  const lims = [...document.querySelectorAll('span,div,small,label,p,td,button,a')]
    .filter((e) => vis(e) && limRe.test(e.innerText || '') && (e.children.length === 0 || (e.innerText || '').length < 60))
    .slice(0, 40)
    .map((e) => 'LIM <' + e.tagName.toLowerCase() + '> "' + cut(e.innerText, 50) + '" cls="' + cut(e.className, 50) + '"');
  return 'URL: ' + location.href + '\\n\\n=== ПОЛЯ ВВОДА (' + inputs.length + ') ===\\n' + inputs.join('\\n') +
    '\\n\\n=== КНОПКИ (' + btns.length + ') ===\\n' + btns.join('\\n') +
    '\\n\\n=== ЛИМИТЫ/MAX (' + lims.length + ') ===\\n' + lims.join('\\n');
})()`;

async function captureBooker(id) {
  let win = id && bookerWins.get(id);
  if (!win || win.isDestroyed()) { win = activeBookerWin(); id = lastBookerId; }
  if (!win) return { ok: false, error: "окно конторы не открыто (нажми «Войти»)" };
  try {
    const dir = logger.dir() || app.getPath("userData");
    const fs = require("node:fs");
    const summary = await win.webContents.executeJavaScript(BOOKER_SUMMARY_JS);
    const html = await win.webContents.executeJavaScript("document.documentElement.outerHTML");
    const sumFile = join(dir, `booker-elements-${id || "x"}.txt`);
    fs.writeFileSync(sumFile, summary);
    fs.writeFileSync(join(dir, `booker-dump-${id || "x"}-${Date.now()}.html`), html);
    logger.log("INFO", "снята разметка конторы:", win.webContents.getURL());
    await shell.openPath(sumFile); // откроем саму сводку — скопируешь и пришлёшь
    return { ok: true, summary, file: sumFile };
  } catch (e) { return { ok: false, error: e.message }; }
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
    tray.on("click", () => createPanelWindow()); // клик по иконке в трее → открыть панель
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
    proxy: settings.proxy || "",
    pollMs: settings.pollMs,
    keyword: settings.keyword,
    liveMode: !!settings.liveMode,
    vilkaLimitEur: settings.vilkaLimitEur || 0,
    hasToken: !!settings.tgToken,
  };
}

function setRunning(v) {
  running = v;
  status.running = v;
  pushStatus();
}

// ── Telegram через сетевой стек Electron (с поддержкой прокси) ─────────────────
// Прокси задаётся в настройках строкой: "host:port", "host:port:user:pass" или
// "scheme://user:pass@host:port" (scheme: http/https/socks5). Так Telegram обходит
// блокировку провайдера через твой прокси (те же, что для контор).
// Поддерживаемые форматы:
//   host:port | host:port:user:pass
//   scheme://host:port | scheme://host:port:user:pass | scheme://user:pass@host:port
// scheme: http/https/socks5/socks (по умолчанию http).
function parseProxy(s) {
  s = String(s || "").trim();
  if (!s) return null;
  let scheme = "http";
  const m = s.match(/^([a-z][a-z0-9]*):\/\//i);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }
  if (scheme === "socks") scheme = "socks5";
  let user = "", pass = "", host = "", port = "";
  if (s.includes("@")) {
    const at = s.lastIndexOf("@");
    const cred = s.slice(0, at), hp = s.slice(at + 1);
    const ci = cred.indexOf(":");
    user = ci >= 0 ? cred.slice(0, ci) : cred;
    pass = ci >= 0 ? cred.slice(ci + 1) : "";
    const parts = hp.split(":");
    host = parts[0]; port = parts[1] || "";
  } else {
    const parts = s.split(":");
    host = parts[0]; port = parts[1] || "";
    if (parts.length >= 4) { user = parts[2]; pass = parts.slice(3).join(":"); }
  }
  if (!host || !port) return null;
  return { scheme, host, port, user, pass };
}

let tgSes = null;
let tgCreds = null;
let appliedProxy = " ";
async function ensureTgProxy() {
  if (!tgSes) tgSes = session.fromPartition("persist:tgproxy");
  const raw = settings.proxy || "";
  if (raw === appliedProxy) return;
  appliedProxy = raw;
  const p = parseProxy(raw);
  if (!p || !p.host || !p.port) {
    tgCreds = null;
    try { await tgSes.setProxy({ mode: "direct" }); } catch { /* ignore */ }
    if (raw) logger.log("WARN", "прокси не распознан:", raw);
    return;
  }
  tgCreds = (p.user || p.pass) ? { user: p.user, pass: p.pass } : null;
  try { await tgSes.setProxy({ proxyRules: `${p.scheme}://${p.host}:${p.port}` }); logger.log("INFO", "прокси Telegram:", `${p.scheme}://${p.host}:${p.port}`); }
  catch (e) { logger.log("WARN", "setProxy:", e); }
}

function sendTgNet(text, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const base = String(settings.tgApiBase || "https://api.telegram.org").trim().replace(/\/+$/, "");
    const url = `${base}/bot${settings.tgToken}/sendMessage`;
    const payload = JSON.stringify({ chat_id: settings.tgChat, text, parse_mode: "HTML", disable_web_page_preview: true });
    let req;
    try { req = net.request({ method: "POST", url, session: tgSes || undefined }); }
    catch (e) { resolve({ ok: false, error: e.message }); return; }
    req.setHeader("Content-Type", "application/json");
    req.on("login", (authInfo, cb) => { if (authInfo.isProxy && tgCreds) cb(tgCreds.user, tgCreds.pass); else cb(); });
    let body = "";
    const timer = setTimeout(() => { try { req.abort(); } catch { /* ignore */ } resolve({ ok: false, error: "таймаут" }); }, timeoutMs);
    req.on("response", (res) => {
      res.on("data", (d) => { body += d.toString(); });
      res.on("end", () => {
        clearTimeout(timer);
        try { const j = JSON.parse(body); resolve(j.ok ? { ok: true, messageId: j.result && j.result.message_id } : { ok: false, error: j.description || ("HTTP " + res.statusCode) }); }
        catch { resolve({ ok: false, error: "HTTP " + res.statusCode }); }
      });
    });
    req.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    try { req.write(payload); req.end(); } catch (e) { clearTimeout(timer); resolve({ ok: false, error: e.message }); }
  });
}

// Пересылка в Telegram ЗАМОРОЖЕНА (фокус на простановке вилок). Код ниже сохранён,
// чтобы при необходимости вернуть — снять заморозку = убрать ранний return.
const TELEGRAM_FROZEN = true;
async function tg(text) {
  if (TELEGRAM_FROZEN) return { ok: false, error: "telegram заморожен" };
  if (!settings.tgToken || !settings.tgChat) return { ok: false, error: "не заданы токен/chat_id" };
  await ensureTgProxy();
  return sendTgNet(text);
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
    loggedOutCount++;
    if (loggedOutCount >= 3) { // ~3 проверки подряд → точно разлогинено (а не миг загрузки)
      status.loggedOut = true;
      await watchdog("⚠️ Нужен вход в surebet — открой приложение и залогинься. Сигналы на паузе.");
      pushStatus();
    }
    return;
  }
  loggedOutCount = 0;
  status.loggedOut = false;

  // Авто-восстановление застрявшего потока: перезагружаем страницу, если автообновление
  // встало (пауза) или раз в несколько минут для профилактики. Только когда окно НЕ в
  // фокусе — чтобы не прерывать тебя, если ты правишь фильтр.
  {
    const now = Date.now();
    const idle = !surebetWin.isFocused();
    const periodic = now - lastReloadAt > 4 * 60 * 1000;
    // пока бот занят — НЕ перезагружаем surebet: дохождение события идёт через эту же сессию
    if (!botBusy && idle && (r.paused || periodic) && now - lastReloadAt > 30000) {
      lastReloadAt = now;
      logger.log("INFO", "перезагрузка surebet:", r.paused ? "была пауза" : "профилактика");
      try { surebetWin.webContents.reload(); } catch (e) { logger.log("WARN", "reload:", e); }
      return; // на этом тике дальше не читаем
    }
  }

  if (settings.tgToken && settings.tgChat && !startupSent) {
    startupSent = true;
    await tg("🟢 Surebet Signal запущен. Слежу за вилками с Pinnacle.");
  }

  const arbs = parseSurebets(r.html);
  const wanted = pickWanted(arbs, settings.keyword);
  status.total = arbs.length;
  status.pinnacle = wanted.length;

  for (const s of wanted) {
    if (TELEGRAM_FROZEN) break; // пересылка заморожена — не дёргаем и не спамим лог
    if (!dedupe.shouldSend(s.id)) continue;
    if (!settings.tgToken || !settings.tgChat) break; // некуда слать
    const res = await tg(formatSignal(s, settings.keyword));
    if (res.ok) { dedupe.markSent(s.id); status.sent++; status.lastSignal = { event: s.event, profit: s.profitPct, at: Date.now() }; }
    else { status.lastError = "Telegram: " + res.error; logger.log("WARN", "Telegram send:", res.error); }
  }

  // Живой пульс в панель КАЖДЫЙ тик, пока взведён — видно, что бот жив (и «обрабатываю», пока busy).
  if (botArmed) sendBotPulse();
  // Режим ожидания бота: взведён и не занят → ловим НОВУЮ вилку и отрабатываем цикл.
  // Запускаем без await (цикл долгий) — botBusy не даёт перезапуститься на следующем тике.
  // ТЕСТ-РЕЖИМ: НЕ останавливаемся на успехе, копим статистику и крутим до TEST_TARGET успехов, потом отчёт.
  if (botArmed && !botBusy) {
    runOneBotCycle(botArmLive).then((res) => {
      if (!res) return; // подходящей вилки нет — ждём дальше
      if (res.waiting) { sendBotPulse(); return; } // нехватка баланса плеча — ОСТАЁМСЯ взведёнными, ждём пополнения
      recordBotStat(res); // обновить счётчики сессии (успехи/скипы/хедж/экспозиция)
      if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send("bot", res);
      sendBotPulse(); // обновить счётчики в панели сразу после цикла
      // 🔴 АВТО-СТОП без участия владельца: незахеджированная ставка (Betano принят, Pinnacle нет)
      if (res.hedge === "exposed") {
        botArmed = false; status.botArmed = false;
        botPulseState.error = "НЕЗАХЕДЖИРОВАНО — авто-стоп";
        logger.log("ERROR", "🔴 [БОТ] АВТО-СТОП: незахеджированная ставка (одно плечо в игре). Разбирайся вручную!");
        const report = formatBotStats(botStats);
        logger.log("INFO", "[бот ИТОГ при авто-стопе]:\n" + report);
        if (panelWin && !panelWin.isDestroyed()) { panelWin.webContents.send("bot-stats", report); }
        sendBotPulse({ armed: false }); pushStatus();
        return;
      }
      if (botStats && botStats.completed >= TEST_TARGET) { // собрали 10 успешных → стоп + отчёт
        botArmed = false; status.botArmed = false;
        const report = formatBotStats(botStats);
        logger.log("INFO", "[бот ТЕСТ] ИТОГ:\n" + report);
        if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send("bot-stats", report);
        pushStatus();
      }
      // иначе (успех или скип) остаёмся взведёнными и ищем следующую вилку
    }).catch((e) => logger.log("ERROR", "bot cycle:", e));
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
  if (typeof patch.proxy === "string") clean.proxy = patch.proxy.trim();
  if (patch.pollMs) clean.pollMs = Math.max(3000, Number(patch.pollMs) || 8000);
  if (patch.keyword) clean.keyword = String(patch.keyword).trim().toLowerCase();
  if (typeof patch.liveMode === "boolean") clean.liveMode = patch.liveMode;
  if (patch.vilkaLimitEur !== undefined) clean.vilkaLimitEur = Math.max(0, Number(patch.vilkaLimitEur) || 0);
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
ipcMain.handle("get-bookers", () => {
  const list = (settings.bookers || []).map(normalizeBooker); // миграция старого формата
  settings = settingsStore.save({ bookers: list });
  return settings.bookers || [];
});
ipcMain.handle("save-bookers", (_e, list) => {
  if (Array.isArray(list)) settings = settingsStore.save({ bookers: list.map(normalizeBooker) });
  return settings.bookers || [];
});
ipcMain.handle("reset-booker-data", async (_e, id) => {
  try {
    const ses = session.fromPartition("persist:booker-" + id);
    await ses.clearStorageData();
    try { await ses.clearCache(); } catch { /* ignore */ }
    const w = bookerWins.get(id);
    if (w && !w.isDestroyed()) w.close(); // закроем — откроется чисто при следующем «Войти»
    logger.log("INFO", "сброс данных браузера конторы:", id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("open-booker", async (_e, id) => {
  const b = findBooker(id);
  if (!b) return { ok: false, error: "нет такой конторы" };
  await openBookerProfile(b);
  return { ok: true };
});
ipcMain.handle("randomize-fp", (_e, id) => {
  const list = settings.bookers || [];
  const b = list.find((x) => x.id === id);
  if (b) {
    const keep = b.fp || {};
    b.fp = randomFingerprint({ timezone: keep.timezone, locale: keep.locale, languages: keep.languages, lat: keep.lat, lon: keep.lon });
    settings = settingsStore.save({ bookers: list });
  }
  return b ? b.fp : null;
});
// Сгенерировать НОВЫЙ User-Agent для конторы (по кнопке), не трогая остальной отпечаток.
ipcMain.handle("randomize-ua", (_e, id) => {
  const list = settings.bookers || [];
  const b = list.find((x) => x.id === id);
  if (b) { b.fp = b.fp || {}; b.fp.ua = randomUA(b.fp.ua); settings = settingsStore.save({ bookers: list }); }
  return b && b.fp ? b.fp.ua : null;
});
ipcMain.handle("get-fx", async () => { await refreshFx(); return fxRate; });
ipcMain.handle("capture-booker", async (_e, id) => await captureBooker(id));
ipcMain.handle("dry-run-place", async (_e, id, stake) => await placeBet(id, stake, false));
ipcMain.handle("place-bet", async (_e, id, stake) => {
  if (!settings.liveMode) return { ok: false, error: "боевой режим ВЫКЛ — включи тумблер, чтобы ставить реально" };
  return await placeBet(id, stake, true);
});
// «Запуск бота» = ВЗВЕСТИ режим ожидания (повторное нажатие = СТОП). Когда взведён, цикл слежения
// сам ловит вилку Betano + Pinnacle(Delayed), проходит оба плеча и в конце разоружается.
// live=true разрешён только при тумблере БОЕВОЙ; иначе dry-run (без ставки).
ipcMain.handle("run-bot", (_e, live) => {
  if (botArmed) {
    botArmed = false; status.botArmed = false; pushStatus();
    // ручная остановка посреди теста → выложить промежуточный отчёт (что успели собрать)
    if (botStats && botStats.attempts > 0) logger.log("INFO", "[бот ТЕСТ] остановлен вручную, промежуточный итог:\n" + formatBotStats(botStats));
    logger.log("INFO", "[бот] остановлен (снят с ожидания)");
    sendBotPulse({ armed: false }); // мгновенно обновить панель
    return { armed: false };
  }
  triedVilkas.clear(); // новый запуск — снова можно пробовать все вилки
  botStats = newBotStats(); // сброс статистики теста
  botPulseState = { records: 0, pairs: 0, fresh: 0, error: null };
  botArmed = true; botArmLive = !!live && !!settings.liveMode; status.botArmed = true; pushStatus();
  sendBotPulse(); // мгновенно показать «взведён»
  logger.log("INFO", "[бот] взведён, жду вилку; режим:", botArmLive ? "БОЕВОЙ" : "dry-run", "| тест до", TEST_TARGET, "успешных");
  return { armed: true, live: botArmLive };
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
      createPanelWindow(); // панель показываем всегда (можно закрыть в трей)
      startLoop();
      refreshFx(); // подтянуть курс USD→EUR (для калькулятора вилки)
      setInterval(refreshFx, 60 * 60 * 1000); // освежать раз в час (внутри есть кэш на 6ч)
      // заранее открываем конторы с «автооткрытием» — чтобы к клику по вилке были залогинены
      for (const b of (settings.bookers || [])) {
        if (b && b.autoOpen) openBookerProfile(b).catch((e) => logger.log("WARN", "auto-open booker:", e));
      }
    } catch (e) {
      logger.log("FATAL", "ошибка инициализации:", e);
    }

    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createSurebetWindow(); });
  });

  app.on("window-all-closed", (e) => { /* живём в трее, не выходим */ });
  app.on("before-quit", () => { app.isQuitting = true; });
}
