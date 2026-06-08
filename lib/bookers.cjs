"use strict";
// Профили контор для встроенного антидетекта.
// Профиль = { id, name, url, proxy, fp:{...отпечаток...} }.
// fp применяется двумя путями: через CDP (UA/таймзона/локаль/гео/метрики) в main.cjs
// и инъекцией скрипта до загрузки страницы (этот файл — buildFingerprintScript).

const UA_PRESETS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
];
const WEBGL_PRESETS = [
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
];
const SCREENS = [{ w: 1920, h: 1080 }, { w: 1536, h: 864 }, { w: 1366, h: 768 }, { w: 2560, h: 1440 }];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function randomFingerprint(overrides = {}) {
  const ua = pick(UA_PRESETS);
  const gl = pick(WEBGL_PRESETS);
  const sc = pick(SCREENS);
  return {
    ua,
    platform: "Win32",
    cores: pick([4, 8, 12, 16]),
    memory: pick([8, 16, 32]),
    screenW: sc.w,
    screenH: sc.h,
    webglVendor: gl.vendor,
    webglRenderer: gl.renderer,
    languages: ["en-US", "en"],
    timezone: "Europe/Lisbon",
    locale: "en-US",
    lat: 38.7223,
    lon: -9.1393,
    canvasNoise: true,
    ...overrides,
  };
}

function defaultBookers() {
  return [
    { id: "betano", name: "Betano", url: "https://www.betano.pt/", proxy: "", autoOpen: false, fp: randomFingerprint({ timezone: "Europe/Lisbon", locale: "pt-PT", languages: ["pt-PT", "pt", "en"] }) },
    { id: "pinnacle", name: "Pinnacle", url: "https://www.pinnacle888.com/", proxy: "", autoOpen: false, fp: randomFingerprint({ timezone: "Europe/Nicosia", locale: "en-US" }) },
  ];
}

// Скрипт, который выполняется ДО скриптов страницы (CDP Page.addScriptToEvaluateOnNewDocument).
// Подменяет navigator.*, screen, WebGL vendor/renderer, добавляет шум в canvas.
function buildFingerprintScript(fp) {
  const f = fp || {};
  const langs = JSON.stringify(f.languages || ["en-US", "en"]);
  return `(() => {
  const def = (obj, prop, val) => { try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch(e){} };
  def(navigator, 'hardwareConcurrency', ${Number(f.cores) || 8});
  def(navigator, 'deviceMemory', ${Number(f.memory) || 8});
  def(navigator, 'platform', ${JSON.stringify(f.platform || "Win32")});
  def(navigator, 'languages', ${langs});
  def(navigator, 'language', ${JSON.stringify((f.languages && f.languages[0]) || "en-US")});
  def(navigator, 'webdriver', false);
  try {
    def(screen, 'width', ${Number(f.screenW) || 1920}); def(screen, 'height', ${Number(f.screenH) || 1080});
    def(screen, 'availWidth', ${Number(f.screenW) || 1920}); def(screen, 'availHeight', ${(Number(f.screenH) || 1080) - 40});
  } catch(e){}
  // WebGL vendor/renderer
  const patchGL = (proto) => {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = function(p) {
      if (p === 37445) return ${JSON.stringify(f.webglVendor || "Google Inc.")};
      if (p === 37446) return ${JSON.stringify(f.webglRenderer || "ANGLE")};
      return orig.apply(this, arguments);
    };
  };
  try { patchGL(WebGLRenderingContext && WebGLRenderingContext.prototype); } catch(e){}
  try { patchGL(WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch(e){}
  // canvas-шум (анти-fingerprint)
  ${f.canvasNoise ? `try {
    const noisify = (orig) => function() {
      try {
        const ctx = this.getContext && this.getContext('2d');
        if (ctx) { const w=this.width, h=this.height; if (w&&h){ const img=ctx.getImageData(0,0,w,h); for(let i=0;i<img.data.length;i+=997){ img.data[i]=img.data[i]^1; } ctx.putImageData(img,0,0);} }
      } catch(e){}
      return orig.apply(this, arguments);
    };
    HTMLCanvasElement.prototype.toDataURL = noisify(HTMLCanvasElement.prototype.toDataURL);
  } catch(e){}` : ""}
})();`;
}

// Ключевые слова доменов контор (для распознавания ссылки при клике по плечу).
const BOOKER_KEYWORDS = {
  betano: ["betano"],
  pinnacle: ["pinnacle888", "ps3838", "pinnacle"],
};

// По URL (ссылке плеча из surebet) определить, какая это контора из профилей.
function bookerForUrl(url, bookers) {
  if (!url || !Array.isArray(bookers)) return null;
  const u = String(url).toLowerCase();
  // 1) по известным ключевым словам контор
  for (const b of bookers) {
    const kws = BOOKER_KEYWORDS[b.id] || [String(b.id || "").toLowerCase(), String(b.name || "").toLowerCase()];
    if (kws.some((k) => k && u.includes(k))) return b;
  }
  // 2) по домену из настроенного URL конторы
  for (const b of bookers) {
    try {
      const base = new URL(b.url).hostname.replace(/^www\./, "").split(".")[0];
      if (base && base.length > 2 && u.includes(base)) return b;
    } catch { /* ignore */ }
  }
  return null;
}

module.exports = { defaultBookers, randomFingerprint, buildFingerprintScript, bookerForUrl, BOOKER_KEYWORDS, UA_PRESETS, WEBGL_PRESETS };
