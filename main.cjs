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
const { defaultBookers, emptyProxy, buildProxyString, randomFingerprint, buildFingerprintScript, bookerForUrl, resolveSurebetNav, pickOutcome } = require("./lib/bookers.cjs");
const { startSocksBridge } = require("./lib/proxyBridge.cjs");

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
      // 1) surebet-редирект /nav/.../prong/N/ → контора и событие по индексу плеча
      const nav = resolveSurebetNav(url, settings.bookers || []);
      if (nav && nav.booker) {
        pendingBet.set(nav.booker.id, { outcomeId: nav.outcomeId, expectedOdds: nav.expectedOdds, desc: nav.desc });
        const initial = nav.targetUrl || nav.booker.url;
        logger.log("INFO", "  → контора:", nav.booker.id, "| исход:", nav.desc, "| кэф:", nav.expectedOdds, "| открываю:", initial);
        openBookerProfile(nav.booker, initial).catch((e) => logger.log("WARN", "route booker:", e));
        // Проход через surebet-редирект нужен ТОЛЬКО если глубокой ссылки нет (Betano = только домен).
        // Для Pinnacle глубокая ссылка уже в данных → НЕ трогаем surebet (иначе цепляли логин).
        let hasDeepLink = false;
        try { const pu = new URL(initial); hasDeepLink = pu.pathname.replace(/\/+$/, "").length > 1; } catch { /* ignore */ }
        if (!hasDeepLink) {
          resolveEventViaNav(url, nav.booker).then((eventUrl) => {
            if (eventUrl && eventUrl !== initial) {
              logger.log("INFO", "  глубокая ссылка события:", eventUrl);
              const w = bookerWins.get(nav.booker.id);
              if (w && !w.isDestroyed()) w.loadURL(eventUrl);
            }
          }).catch((e) => logger.log("WARN", "resolveEventViaNav:", e));
        } else {
          logger.log("INFO", "  глубокая ссылка уже есть — surebet-редирект пропускаю");
        }
        return { action: "deny" };
      }
      if (nav) {
        // Это surebet-ссылка плеча, но bk не сопоставлен с профилем. НЕ открываем «по слову
        // в URL» (bookerForUrl) — в URL лежат ОБА плеча, откроется не та контора и в её окно
        // загрузится surebet-ссылка → логин surebet. Лучше явно отказать (без misroute).
        logger.log("WARN", "  bk не сопоставлен с профилем:", nav.bk, "— пропускаю (без misroute)");
        return { action: "deny" };
      }

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
  if (!p || !p.host || !p.port) { ses.__creds = null; try { await ses.setProxy({ mode: "direct" }); } catch { /* ignore */ } return; }

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
  try { await ses.setProxy({ proxyRules: `${p.scheme}://${p.host}:${p.port}` }); }
  catch (e) { logger.log("WARN", "booker setProxy:", e); }
}

async function openBookerProfile(profile, overrideUrl) {
  if (!profile || !profile.id) return null;
  normalizeBooker(profile);
  const id = profile.id;
  const partition = "persist:booker-" + id;
  const ses = session.fromPartition(partition);
  await applySessionProxy(ses, buildProxyString(profile.proxy));

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
      logger.log("INFO", "контора открыта:", id, "прокси:", profile.proxy ? "да" : "нет", "tz:", fp.timezone);
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
const BETSLIP = {
  betano: { outcomeSel: ".selections__selection", stake: 'input[id^="stakeInput"]', placeWords: ["BET NOW"] },
  pinnacle: { outcomeSel: '[id*="|"]', stake: 'input[name="stake"]', placeWords: ["CONFIRM", "SINGLE BET"] },
};
const ODDS_TOLERANCE = 0.05; // допустимое падение кэфа (5%)

// Простановка: авто-выбор исхода (Pinnacle и Betano — по id из вилки или по описанию+кэфу) →
// сверка кэфа → ввод суммы → (для live) клик постановки. live=false (dry-run) — НЕ нажимает.
async function placeBet(id, stake, live = false) {
  const win = bookerWins.get(id);
  if (!win || win.isDestroyed()) return { ok: false, error: "окно конторы не открыто (нажми «Войти»)" };
  const cfg = BETSLIP[id];
  if (!cfg) return { ok: false, error: "нет разметки купона для «" + id + "»" };
  const bet = pendingBet.get(id) || {};
  let selected = null, selectedOdds = null, how = null;

  // 1) авто-выбор исхода: собрать кнопки-исходы по селектору конторы → выбрать чистой функцией →
  //    кликнуть по ИНДЕКСУ (id есть только у Pinnacle; у Betano исходы без id).
  if (cfg.outcomeSel) {
    const sel = cfg.outcomeSel;
    let buttons = [];
    try {
      buttons = await win.webContents.executeJavaScript(`(() => {
        const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
        return [...document.querySelectorAll(${JSON.stringify(sel)})].map((el, i) => ({ i, id: el.id || "", text: norm(el.innerText) }));
      })()`);
    } catch (e) { return { ok: false, error: "не прочитал кнопки исходов: " + e.message }; }
    const choice = pickOutcome({ desc: bet.desc, expectedOdds: bet.expectedOdds, outcomeId: bet.outcomeId, buttons });
    if (!choice) {
      const r = { ok: false, error: "не нашёл исход на странице (линия/кэф не совпали). desc=" + (bet.desc || "—") + " кэф=" + (bet.expectedOdds || "?") + " кнопок:" + buttons.length };
      logger.log("WARN", "dry-run/place", id, JSON.stringify(r));
      return r;
    }
    selected = choice.text; selectedOdds = choice.odds; how = choice.how;
    try {
      const clicked = await win.webContents.executeJavaScript(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = els[${Number(choice.i)}]; if (el) { el.click(); return true; } return false; })()`);
      if (!clicked) return { ok: false, error: "кнопка исхода не кликнулась (i=" + choice.i + ")", selected, selectedOdds, how };
    } catch (e) { return { ok: false, error: "клик исхода: " + e.message, selected, selectedOdds, how }; }
    await new Promise((r) => setTimeout(r, 800)); // дать купону открыться
  }

  // 2) ввод суммы (React value-tracker) + поиск кнопки постановки.
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
    const pbtn = [...document.querySelectorAll("button")].find((b) => {
      const t = (b.innerText || "").toUpperCase(); return words.every((w) => t.includes(w.toUpperCase()));
    });
    return { ok: true, stakeValue: inp.value, placeBtnText: pbtn ? (pbtn.innerText || "").replace(/\\s+/g, " ").trim() : null, hasPlaceBtn: !!pbtn };
  })()`;
  try {
    const r = await win.webContents.executeJavaScript(js);
    r.selected = selected; r.selectedOdds = selectedOdds; r.how = how;
    if (r.error) {
      r.ok = false;
      logger.log("WARN", "dry-run/place", id, JSON.stringify(r));
      return r;
    }
    const exp = bet.expectedOdds;
    r.expectedOdds = exp || null;
    r.oddsOk = (exp && r.selectedOdds) ? (r.selectedOdds >= exp * (1 - ODDS_TOLERANCE)) : null;
    // боевой клик — только если live И кэф не уехал (или сверять нечего)
    if (live && r.hasPlaceBtn && r.oddsOk !== false) {
      await win.webContents.executeJavaScript(`(() => {
        const words = ${JSON.stringify(cfg.placeWords)};
        const b = [...document.querySelectorAll("button")].find((x) => { const t=(x.innerText||"").toUpperCase(); return words.every((w)=>t.includes(w.toUpperCase())); });
        if (b) b.click(); return !!b;
      })()`);
      r.placed = true;
    } else { r.placed = false; }
    logger.log("INFO", live ? "PLACE" : "dry-run", id, JSON.stringify(r));
    return r;
  } catch (e) { return { ok: false, error: e.message, selected, selectedOdds, how }; }
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
  return 'URL: ' + location.href + '\\n\\n=== ПОЛЯ ВВОДА (' + inputs.length + ') ===\\n' + inputs.join('\\n') +
    '\\n\\n=== КНОПКИ (' + btns.length + ') ===\\n' + btns.join('\\n');
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

async function tg(text) {
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
    if (idle && (r.paused || periodic) && now - lastReloadAt > 30000) {
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
    if (!dedupe.shouldSend(s.id)) continue;
    if (!settings.tgToken || !settings.tgChat) break; // некуда слать
    const res = await tg(formatSignal(s, settings.keyword));
    if (res.ok) { dedupe.markSent(s.id); status.sent++; status.lastSignal = { event: s.event, profit: s.profitPct, at: Date.now() }; }
    else { status.lastError = "Telegram: " + res.error; logger.log("WARN", "Telegram send:", res.error); }
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
ipcMain.handle("capture-booker", async (_e, id) => await captureBooker(id));
ipcMain.handle("dry-run-place", async (_e, id, stake) => await placeBet(id, stake, false));
ipcMain.handle("place-bet", async (_e, id, stake) => {
  if (!settings.liveMode) return { ok: false, error: "боевой режим ВЫКЛ — включи тумблер, чтобы ставить реально" };
  return await placeBet(id, stake, true);
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
