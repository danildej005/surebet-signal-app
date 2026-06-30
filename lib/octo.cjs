"use strict";
// Клиент Octo Browser (настоящий антидетект) — замена нашему Electron-антидетекту для простановки на
// Betano. Прокси/отпечаток/логин живут ВНУТРИ Octo-профиля (по UUID), мы лишь стартуем профиль через
// Local API и подключаемся к нему puppeteer-core по ws_endpoint (CDP). Профиль персистентный: cookies и
// логин betano.bg переиспользуются между запусками — профиль НЕ пересоздавать/не чистить.
//
// Поверхность Local API (Octo должен быть запущен на ВДС, без Authorization — он локальный):
//   POST http://127.0.0.1:58888/api/profiles/start  {uuid, headless, debug_port:true}
//        → { state:"STARTED", ws_endpoint:"ws://127.0.0.1:<port>/devtools/browser/<id>", debug_port, ... }
//   POST http://127.0.0.1:58888/api/profiles/stop   {uuid}
//   GET  http://127.0.0.1:58888/api/profiles/active → список активных uuid
//
// ЧИСТЫЕ функции (apiBase/endpoint/buildStartBody/parseStartResponse/parseActiveResponse/pageWindow)
// покрыты тестами в test/octo.test.cjs. Сетевые (startProfile/stopProfile/listActive) и connect —
// тонкие обёртки над http/puppeteer. Документация: docs.octobrowser.net/en/api/start-api/.
const http = require("http");

const DEFAULT_API = "http://127.0.0.1:58888";

// PURE: нормализовать адрес Local API → "http://host:port" (без хвостового слэша). Принимает
// "127.0.0.1:58888", "http://localhost:58888/", пустую строку (→ дефолт).
function apiBase(input) {
  let s = String(input || "").trim();
  if (!s) return DEFAULT_API;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  return s.replace(/\/+$/, "");
}

// PURE: полный URL эндпоинта профилей ("start" | "stop" | "active").
function endpoint(base, name) {
  return apiBase(base) + "/api/profiles/" + name;
}

// PURE: тело запроса старта профиля. debug_port:true обязателен — иначе в ответе не будет ws_endpoint.
function buildStartBody(uuid, opts = {}) {
  const body = { uuid: String(uuid || ""), headless: !!opts.headless, debug_port: true };
  if (opts.flags) body.flags = opts.flags; // доп. флаги Chromium, если когда-то понадобятся
  return body;
}

// PURE: разобрать ответ старта. ws_endpoint лежит на верхнем уровне; на всякий случай заглядываем в
// .data/.state (разные версии Octo). Ошибка Octo приходит как {success:false}/{error}/{msg|message}.
function parseStartResponse(json) {
  if (!json || typeof json !== "object") return { ok: false, error: "пустой ответ Octo Local API" };
  const node = json.ws_endpoint ? json : (json.data && json.data.ws_endpoint ? json.data : (json.state && json.state.ws_endpoint ? json.state : json));
  const ws = node.ws_endpoint;
  if (!ws) {
    const msg = json.message || json.msg || json.error || (json.success === false ? "профиль не стартовал" : "нет ws_endpoint в ответе");
    return { ok: false, error: String(msg) };
  }
  return { ok: true, wsEndpoint: String(ws), debugPort: node.debug_port != null ? String(node.debug_port) : null, state: node.state || json.state || null };
}

// PURE: вытащить список активных uuid из разных форм ответа /active (массив, {uuids:[]}, {data:[]},
// объект-карта uuid→инфо, массив объектов с полем uuid).
function parseActiveResponse(json) {
  let arr = null;
  if (Array.isArray(json)) arr = json;
  else if (json && Array.isArray(json.uuids)) arr = json.uuids;
  else if (json && Array.isArray(json.data)) arr = json.data;
  else if (json && json.data && typeof json.data === "object") arr = Object.keys(json.data);
  else if (json && typeof json === "object") arr = Object.keys(json);
  if (!arr) return [];
  return arr.map((x) => (x && typeof x === "object" ? x.uuid : x)).filter(Boolean).map(String);
}

// PURE: профиль с данным uuid активен?
function isProfileActive(json, uuid) {
  return parseActiveResponse(json).includes(String(uuid));
}

// Низкоуровневый JSON-запрос к Local API (http, localhost). Возвращает {ok, status, json|error}.
function requestJson(method, url, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(url);
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: { Accept: "application/json", ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) },
        timeout: timeoutMs },
      (res) => {
        let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => { let j = null; try { j = d ? JSON.parse(d) : {}; } catch { return fin({ ok: false, status: res.statusCode, error: "Octo не JSON (" + res.statusCode + "): " + d.slice(0, 150) }); } fin({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: j }); });
      });
    req.on("timeout", () => { req.destroy(); fin({ ok: false, error: "Octo Local API таймаут (запущен ли Octo на " + u.host + "?)" }); });
    req.on("error", (e) => fin({ ok: false, error: "Octo Local API недоступен (" + e.message + ") — Octo запущен?" }));
    if (payload) req.write(payload);
    req.end();
  });
}

// Стартовать профиль по UUID → {ok, wsEndpoint, debugPort} или {ok:false, error}.
async function startProfile(uuid, opts = {}) {
  if (!uuid) return { ok: false, error: "не задан UUID Octo-профиля" };
  const r = await requestJson("POST", endpoint(opts.apiBase, "start"), buildStartBody(uuid, opts), opts.timeoutMs);
  if (!r.ok && !r.json) return { ok: false, error: r.error || "старт профиля не удался" };
  return parseStartResponse(r.json);
}

// Остановить профиль по UUID.
async function stopProfile(uuid, opts = {}) {
  if (!uuid) return { ok: false, error: "не задан UUID" };
  const r = await requestJson("POST", endpoint(opts.apiBase, "stop"), { uuid: String(uuid) }, opts.timeoutMs);
  return { ok: !!r.ok, error: r.ok ? null : (r.error || "stop не удался"), json: r.json };
}

// Список активных профилей (uuid[]).
async function listActive(opts = {}) {
  const r = await requestJson("GET", endpoint(opts.apiBase, "active"), null, opts.timeoutMs);
  return r.ok ? parseActiveResponse(r.json) : [];
}

// Запущено ли приложение Octo (отвечает ли Local API). Любой HTTP-ответ (даже не-2xx) = поднят;
// ECONNREFUSED/таймаут = приложение закрыто.
async function ping(opts = {}) {
  const r = await requestJson("GET", endpoint(opts.apiBase, "active"), null, opts.timeoutMs || 2500);
  return r.json !== undefined || r.ok === true;
}

// PURE: кандидаты путей к исполняемому файлу Octo по платформе (для автозапуска, если не задан явный путь).
// На Windows точное имя/папка зависят от версии установщика → пробуем несколько; на 100% надёжен явный путь.
function defaultExeCandidates(platform, env = {}) {
  const out = [];
  if (platform === "win32") {
    const names = ["Octo Browser\\Octo Browser.exe", "Programs\\Octo Browser\\Octo Browser.exe",
      "Programs\\octobrowser\\Octo Browser.exe", "octobrowser\\octobrowser.exe", "Octo\\Octo.exe"];
    for (const base of [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(Boolean))
      for (const n of names) out.push(base + "\\" + n);
  } else if (platform === "darwin") {
    out.push("/Applications/Octo Browser.app/Contents/MacOS/Octo Browser");
  } else {
    out.push("/opt/octobrowser/octobrowser");
    if (env.HOME) out.push(env.HOME + "/.local/share/octobrowser/octobrowser");
  }
  return out;
}

// Убедиться, что Octo запущено: если Local API уже отвечает — ок; иначе (autoStart!==false) найти .exe
// (явный путь opts.exePath или кандидаты) и поднять его detached, ждать готовности API до startTimeoutMs.
async function ensureRunning(opts = {}) {
  if (await ping(opts)) return { ok: true, started: false };
  if (opts.autoStart === false) return { ok: false, error: "Octo не запущен (автозапуск выключен)" };
  const fs = require("fs");
  const candidates = [];
  if (opts.exePath) candidates.push(opts.exePath);
  candidates.push(...defaultExeCandidates(process.platform, process.env));
  const exe = candidates.find((p) => { try { return p && fs.existsSync(p); } catch { return false; } });
  if (!exe) return { ok: false, error: "Octo не запущен, и .exe не найден автоматически — укажи путь к Octo в настройках карточки Betano" };
  try {
    const { spawn } = require("child_process");
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  } catch (e) { return { ok: false, error: "не удалось запустить Octo (" + exe + "): " + e.message }; }
  const startTimeoutMs = opts.startTimeoutMs || 45000;
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await ping(opts)) return { ok: true, started: true, exe };
  }
  return { ok: false, error: "Octo запущено, но Local API не ответил за " + Math.round(startTimeoutMs / 1000) + "с (залогинься в Octo вручную один раз?)", exe };
}

// PURE-тестируемый адаптер: оборачивает puppeteer-страницу в объект с поверхностью Electron-окна
// (win.webContents.executeJavaScript/getURL/capturePage, win.loadURL, win.isDestroyed) — тогда ВСЯ
// существующая простановка (selectLegOutcome/fillStakeOnly/clickPlace/readBookmakerMax/dismissConsent)
// работает над Octo-страницей БЕЗ изменений. page.evaluate принимает строку-выражение и ждёт промис —
// как Electron executeJavaScript, поэтому код купонов передаётся как есть.
function pageWindow(page) {
  return {
    __octo: true,
    page,
    isDestroyed: () => { try { return page.isClosed(); } catch { return true; } },
    loadURL: (url) => page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).then(() => {}),
    webContents: {
      getURL: () => { try { return page.url(); } catch { return ""; } },
      executeJavaScript: (code) => page.evaluate(code),
      capturePage: async () => { const buf = await page.screenshot({ type: "png" }); return { toPNG: () => buf }; },
    },
  };
}

// Стартовать профиль + подключиться puppeteer-core → {ok, browser, page, win, wsEndpoint}. win — адаптер
// под Electron-окно (см. pageWindow), кладётся в bookerWins, дальше работает обычная простановка.
// puppeteer-core грузим лениво (чтобы lib/* оставался без сети-зависимостей в тестах).
async function connect(uuid, opts = {}) {
  const run = await ensureRunning(opts); // авто-поднять приложение Octo, если закрыто
  if (!run.ok) return run;
  const started = await startProfile(uuid, opts);
  if (!started.ok) return started;
  let puppeteer;
  try { puppeteer = require("puppeteer-core"); }
  catch { return { ok: false, error: "не установлен puppeteer-core (npm i puppeteer-core)" }; }
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: started.wsEndpoint, defaultViewport: null });
    const pages = await browser.pages();
    let page = pages.find((p) => { try { const u = p.url(); return u && !u.startsWith("devtools://"); } catch { return false; } }) || pages[0] || (await browser.newPage());
    return { ok: true, browser, page, win: pageWindow(page), wsEndpoint: started.wsEndpoint, started: !!run.started };
  } catch (e) {
    return { ok: false, error: "puppeteer.connect не удался: " + e.message };
  }
}

module.exports = {
  apiBase, endpoint, buildStartBody, parseStartResponse, parseActiveResponse, isProfileActive,
  requestJson, startProfile, stopProfile, listActive, ping, defaultExeCandidates, ensureRunning,
  pageWindow, connect, DEFAULT_API,
};
