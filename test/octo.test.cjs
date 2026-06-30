"use strict";
// Тесты клиента Octo Browser: нормализация Local API, тело старта, парс ответов start/active и адаптер
// puppeteer-страницы под поверхность Electron-окна. Сеть и puppeteer не дёргаем — только чистая логика.
const test = require("node:test");
const assert = require("node:assert");
const octo = require("../lib/octo.cjs");

test("apiBase: дефолт, схема и хвостовой слэш", () => {
  assert.equal(octo.apiBase(""), "http://127.0.0.1:58888");
  assert.equal(octo.apiBase(null), "http://127.0.0.1:58888");
  assert.equal(octo.apiBase("127.0.0.1:58888"), "http://127.0.0.1:58888");
  assert.equal(octo.apiBase("http://localhost:58888/"), "http://localhost:58888");
  assert.equal(octo.apiBase("https://10.0.0.5:9999///"), "https://10.0.0.5:9999");
});

test("endpoint: собирает путь профилей", () => {
  assert.equal(octo.endpoint("", "start"), "http://127.0.0.1:58888/api/profiles/start");
  assert.equal(octo.endpoint("localhost:58888", "stop"), "http://localhost:58888/api/profiles/stop");
  assert.equal(octo.endpoint("", "active"), "http://127.0.0.1:58888/api/profiles/active");
});

test("buildStartBody: debug_port:true всегда, headless по опции", () => {
  assert.deepEqual(octo.buildStartBody("abc"), { uuid: "abc", headless: false, debug_port: true });
  assert.deepEqual(octo.buildStartBody("abc", { headless: true }), { uuid: "abc", headless: true, debug_port: true });
  assert.equal(octo.buildStartBody("").uuid, "");
});

test("parseStartResponse: ws_endpoint верхнего уровня (реальная форма)", () => {
  const r = octo.parseStartResponse({
    uuid: "eb5d6441b2b349368b31fd901b82a8ac", state: "STARTED", headless: false,
    ws_endpoint: "ws://127.0.0.1:53215/devtools/browser/d633f197", debug_port: "53215",
  });
  assert.equal(r.ok, true);
  assert.equal(r.wsEndpoint, "ws://127.0.0.1:53215/devtools/browser/d633f197");
  assert.equal(r.debugPort, "53215");
  assert.equal(r.state, "STARTED");
});

test("parseStartResponse: ws_endpoint вложенный в data", () => {
  const r = octo.parseStartResponse({ data: { ws_endpoint: "ws://x/1", debug_port: 42 } });
  assert.equal(r.ok, true);
  assert.equal(r.wsEndpoint, "ws://x/1");
  assert.equal(r.debugPort, "42");
});

test("parseStartResponse: ошибки Octo", () => {
  assert.equal(octo.parseStartResponse(null).ok, false);
  assert.equal(octo.parseStartResponse({}).ok, false);
  assert.equal(octo.parseStartResponse({ success: false }).ok, false);
  const e = octo.parseStartResponse({ message: "profile not found" });
  assert.equal(e.ok, false);
  assert.match(e.error, /profile not found/);
});

test("parseActiveResponse: разные формы → uuid[]", () => {
  assert.deepEqual(octo.parseActiveResponse(["a", "b"]), ["a", "b"]);
  assert.deepEqual(octo.parseActiveResponse({ uuids: ["a"] }), ["a"]);
  assert.deepEqual(octo.parseActiveResponse({ data: [{ uuid: "x" }, { uuid: "y" }] }), ["x", "y"]);
  assert.deepEqual(octo.parseActiveResponse({ data: { aa: {}, bb: {} } }), ["aa", "bb"]);
  assert.deepEqual(octo.parseActiveResponse(null), []);
});

test("isProfileActive", () => {
  assert.equal(octo.isProfileActive({ uuids: ["a", "b"] }, "b"), true);
  assert.equal(octo.isProfileActive(["a"], "z"), false);
});

test("pageWindow: адаптер мимикрирует поверхность Electron-окна", async () => {
  let goneTo = null, evaled = null, closed = false;
  const fakePage = {
    isClosed: () => closed,
    url: () => "https://www.betano.bg/koefitsienti/x/12345/",
    goto: async (u) => { goneTo = u; return {}; },
    evaluate: async (code) => { evaled = code; return 7; },
    screenshot: async () => Buffer.from("PNGDATA"),
  };
  const win = octo.pageWindow(fakePage);
  assert.equal(win.__octo, true);
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.webContents.getURL(), "https://www.betano.bg/koefitsienti/x/12345/");

  // executeJavaScript пробрасывает строку-код в page.evaluate и возвращает результат
  const n = await win.webContents.executeJavaScript("document.querySelectorAll('x').length");
  assert.equal(n, 7);
  assert.equal(evaled, "document.querySelectorAll('x').length");

  // loadURL → page.goto, резолвится в undefined (как Electron)
  const res = await win.loadURL("https://www.betano.bg/e/1");
  assert.equal(res, undefined);
  assert.equal(goneTo, "https://www.betano.bg/e/1");

  // capturePage → {toPNG()} как у Electron NativeImage
  const img = await win.webContents.capturePage();
  assert.equal(img.toPNG().toString(), "PNGDATA");

  // isDestroyed следует за page.isClosed()
  closed = true;
  assert.equal(win.isDestroyed(), true);
});

test("pageWindow: getURL/isDestroyed не падают на брошенной странице", () => {
  const win = octo.pageWindow({ isClosed: () => { throw new Error("detached"); }, url: () => { throw new Error("detached"); } });
  assert.equal(win.isDestroyed(), true);
  assert.equal(win.webContents.getURL(), "");
});

test("defaultExeCandidates: Windows — кандидаты под LOCALAPPDATA/PROGRAMFILES", () => {
  const c = octo.defaultExeCandidates("win32", { LOCALAPPDATA: "C:\\la", PROGRAMFILES: "C:\\pf" });
  assert.ok(c.length > 0);
  assert.ok(c.every((p) => p.endsWith(".exe")));
  assert.ok(c.some((p) => p.startsWith("C:\\la\\")));
  assert.ok(c.some((p) => p.startsWith("C:\\pf\\")));
});

test("defaultExeCandidates: mac/linux", () => {
  assert.ok(octo.defaultExeCandidates("darwin").some((p) => p.includes("Octo Browser.app")));
  assert.ok(octo.defaultExeCandidates("linux", { HOME: "/home/u" }).some((p) => p.includes("/home/u/")));
});

test("ping: закрытый порт → false", async () => {
  assert.equal(await octo.ping({ apiBase: "http://127.0.0.1:59997", timeoutMs: 800 }), false);
});

test("ensureRunning: autoStart:false и Octo закрыт → ошибка без запуска", async () => {
  const r = await octo.ensureRunning({ apiBase: "http://127.0.0.1:59997", autoStart: false, timeoutMs: 800 });
  assert.equal(r.ok, false);
  assert.match(r.error, /не запущен/);
});
