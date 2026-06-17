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

// Новый UA из пула, по возможности ОТЛИЧНЫЙ от текущего (чтобы по кнопке видно менялся).
function randomUA(current) {
  const others = UA_PRESETS.filter((u) => u !== current);
  return pick(others.length ? others : UA_PRESETS);
}

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

function emptyProxy() { return { protocol: "", host: "", port: "", user: "", pass: "" }; }

function defaultBookers() {
  return [
    { id: "betano", name: "Betano", url: "https://www.betano.pt/", autoOpen: false, proxy: emptyProxy(), login: { user: "", pass: "" }, fp: randomFingerprint({ timezone: "Europe/Lisbon", locale: "pt-PT", languages: ["pt-PT", "pt", "en"] }) },
    { id: "pinnacle", name: "Pinnacle", url: "https://www.pinnacle888.com/", autoOpen: false, proxy: emptyProxy(), login: { user: "", pass: "" }, fp: randomFingerprint({ timezone: "Europe/Nicosia", locale: "en-US" }) },
  ];
}

// Структурированный прокси {protocol,host,port,user,pass} → строка для parseProxy.
// protocol: "" = без прокси; http/https/socks5. Старый формат-строку пропускаем как есть.
function buildProxyString(p) {
  if (!p) return "";
  if (typeof p === "string") return p.trim();
  const protocol = String(p.protocol || "").trim().toLowerCase();
  const host = String(p.host || "").trim();
  const port = String(p.port || "").trim();
  if (!protocol || !host || !port) return "";
  const user = String(p.user || "").trim();
  const pass = String(p.pass || "").trim();
  return (user || pass) ? `${protocol}://${host}:${port}:${user}:${pass}` : `${protocol}://${host}:${port}`;
}

// Betano работает на разных страновых доменах (Kaizen Gaming), но ID события ОБЩИЙ между странами.
// Фид surebet часто даёт ro.betano.com, а владельцу нужен свой страновой сайт (напр. betano.bg).
// По хосту из booker.url выбираем целевой сайт; null = рерайт не нужен (фид уже даёт нужный домен).
function betanoTarget(bookerUrl) {
  let h = ""; try { h = new URL(bookerUrl).hostname.toLowerCase(); } catch { h = ""; }
  if (/betano\.bg$/.test(h)) return { host: "www.betano.bg", path: "en/match-odds" };
  return null;
}

// Переписать ЛЮБУЮ betano-ссылку события на целевой страновой сайт, сохранив slug+id.
// Пример: ro.betano.com/cote/<slug>/83961881/?bt=14 → www.betano.bg/en/match-odds/<slug>/83961881/?bt=14
// (ID общий между странами → событие то же; slug Betano поправит сам по id).
function localizeBetanoUrl(url, target) {
  if (!target || !url) return url;
  try {
    const u = new URL(url);
    if (!/(^|\.)betano\./i.test(u.hostname)) return url; // не betano — не трогаем
    const segs = u.pathname.split("/").filter(Boolean);
    const idIdx = segs.findIndex((s) => /^\d{5,}$/.test(s)); // сегмент-число = id события
    if (idIdx < 1) return url; // нет пары slug+id (напр. домашняя) — оставляем как есть
    const id = segs[idIdx], slug = segs[idIdx - 1];
    u.protocol = "https:";
    u.hostname = target.host;
    u.pathname = "/" + target.path + "/" + slug + "/" + id + "/";
    return u.toString();
  } catch { return url; }
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

// Имя букмекера из surebet (bk) → id нашего профиля конторы.
const BK_TO_BOOKER = {
  pinnaclesports: "pinnacle", pinnacle888: "pinnacle", pinnacle: "pinnacle", ps3838: "pinnacle",
  betanopt: "betano", betano: "betano",
};

// Надёжное сопоставление кода bk с профилем (по подстроке — surebet шлёт разные бренды:
// pinnaclesports / pinnacle888 / ps3838 для Pinnacle; betanopt / betano для Betano).
function bkToBookerId(bk) {
  const s = String(bk || "").toLowerCase();
  if (/pinnacle|ps3838/.test(s)) return "pinnacle";
  if (/betano/.test(s)) return "betano";
  return BK_TO_BOOKER[s] || null;
}

// Из расширенного описания плеча (tr_expanded) вытащить «субъект» — имя игрока/команды,
// напр. «Sho Shimabukuro победит с форой +1.5 … - сеты» → «Sho Shimabukuro».
// Нужно для поиска матча на странице конторы, когда прямой ссылки на событие нет.
function extractSubject(descFull) {
  const d = String(descFull || "").replace(/\s+/g, " ").trim();
  if (!d) return "";
  const cut = d.split(/\s+(?:победит|выигра\w*|пройдёт|сыграет|тотал|больш\w*|меньш\w*|фор\w*|гандикап|против|vs|\(|[-–—])\s*/i)[0];
  return cut.trim();
}

// Единица рынка из расширенного описания: сеты / геймы (Pinnacle держит их в РАЗНЫХ вкладках,
// напр. «Ф+1.5 сеты» @1.22 и «Ф+1.5 геймы» @2.09 — это разные исходы). Берём из «хвоста»
// описания («… - сеты» / «… - геймы»); имя-фид «(геймы)» в начале не путаем.
function marketUnit(descFull) {
  const d = String(descFull || "").toLowerCase();
  const m = d.match(/[-–—]\s*(сет[а-яё]*|гейм[а-яё]*|sets?|games?)\s*$/);
  if (m) return /сет|set/.test(m[1]) ? "set" : "game";
  const hasSet = /сет/.test(d), hasGame = /гейм/.test(d);
  if (hasSet && !hasGame) return "set";
  if (hasGame && !hasSet) return "game";
  return null;
}

// Похоже ли на ссылку КОНКРЕТНОГО события (а не главная/раздел): в пути есть числовой id
// события (Pinnacle …/1631805342, Betano …/86655013/). Иначе (/, /en/compact/sports …) — не событие
// → нужен проход через surebet-редирект, чтобы найти реальную ссылку события.
function isEventUrl(url) {
  try { return /\/\d{5,}(?=[\/?#]|$)/.test(new URL(url).pathname); } catch { return false; }
}

// Разбор ссылки плеча surebet вида /nav/surebet/prong/{N}/.../if?json_body={...}.
// Возвращает { bk, prongIndex, targetUrl } или null. Контору и ссылку берём по индексу
// плеча из json_body.prongs[N] (а НЕ по слову в URL — там лежат оба плеча).
function parseSurebetNav(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)surebet\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/prong\/(\d+)\b/);
    if (!m) return null;
    const idx = Number(m[1]);
    const jb = u.searchParams.get("json_body");
    if (!jb) return null;
    const body = JSON.parse(jb);
    let prong = body.prongs && body.prongs[idx];
    if (typeof prong === "string") prong = JSON.parse(prong);
    if (!prong) return null;
    const bk = String(prong.bk || "").toLowerCase();
    const mk = prong.markers || {};
    const targetUrl =
      mk.link ||
      (prong.bookie_nav && prong.bookie_nav.links && prong.bookie_nav.links[0] &&
        prong.bookie_nav.links[0].link && prong.bookie_nav.links[0].link.url) ||
      null;
    const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return {
      bk, prongIndex: idx, targetUrl,
      outcomeId: mk.pinnacleBrExternalId || mk.externalId || null, // id исхода (Pinnacle — точный)
      expectedOdds: Number(prong.value) || null,                   // ожидаемый кэф из вилки
      desc: strip(prong.tr_terse),                                 // тип ставки (Ф1(+1.5), Тм(3.5)…), без HTML
      descFull: strip(prong.tr_expanded || prong.tr_long || prong.market || ""), // расширенное (диагностика: имя игрока?)
      markers: mk,                                                 // сырые маркеры (диагностика: есть ли id события?)
    };
  } catch { return null; }
}

// Сопоставить ссылку плеча с профилем конторы и целевым URL события.
function resolveSurebetNav(url, bookers) {
  const nav = parseSurebetNav(url);
  if (!nav) return null;
  const bookerId = bkToBookerId(nav.bk);
  const booker = Array.isArray(bookers) ? bookers.find((b) => b.id === bookerId) || null : null;
  return {
    bk: nav.bk, booker, targetUrl: nav.targetUrl || (booker && booker.url) || null,
    outcomeId: nav.outcomeId, expectedOdds: nav.expectedOdds, desc: nav.desc, descFull: nav.descFull, markers: nav.markers,
  };
}

// Сверка-страховка: макс. отклонение кэфа уже СТРУКТУРНО выбранной кнопки от ожидаемого.
// Не основной критерий выбора (им служит тип+линия+сторона), а отсев грубого «не того рынка».
const PICK_ODDS_GATE = 0.25; // 25%

// Распознать тип ставки из surebet-описания (tr_terse). Намеренно СТРОГО:
// поддерживаем только надёжные рынки (фора/тотал/победа). Пропсы игрока и всё непонятное → kind:null
// (бот не угадывает — лучше «не нашёл», чем чужая ставка).
function classifyDesc(desc) {
  const d = String(desc || "").replace(/\s+/g, " ").trim();
  // пропсы игрока (имени игрока в данных вилки нет, рынок свёрнут) — НЕ беремся
  if (/ассист|очк|подбор|пас|перехват|блок-шот|голы|assists|points|rebound|steal|block/i.test(d)) return { kind: null, reason: "пропс игрока" };
  // ФОРА: РУС «Ф1(+1.5)» / «Ф2(-1.5)» И АНГЛ «AH1(+1.5)» (Asian handicap). Цифра после Ф/AH = сторона.
  // Фид переключён на английский (ради сверки имён, правило #1) → нотация стала AH вместо Ф.
  let m = d.match(/(?:^|\s)(?:Ф|AH)\s*(\d)?\s*\(\s*([+\-−]?\d+(?:[.,]\d+)?)\s*\)/i);
  if (m) return { kind: "hcap", side: m[1] || null, line: m[2].replace(/−/g, "-").replace(",", ".") };
  // ТОТАЛ РУС: «Тб(2.5)» / «Тм(220.5)» (б = больше, м = меньше) — со скобками
  m = d.match(/(?:^|\s)Т([бмБМ])\s*\(\s*(\d+(?:[.,]\d+)?)\s*\)/);
  if (m) return { kind: "total", over: /[бБ]/.test(m[1]), line: m[2].replace(",", ".") };
  // ТОТАЛ АНГЛ: «Over 7.5» / «Under 220.5» (без скобок; возможен суффикс вроде «OT»)
  m = d.match(/(?:^|\s)(Over|Under)\s*\(?\s*(\d+(?:[.,]\d+)?)\s*\)?/i);
  if (m) return { kind: "total", over: /^o/i.test(m[1]), line: m[2].replace(",", ".") };
  // счёт по сетам (теннис = Set Betting) / точный счёт: «2:0» / «2-0»
  m = d.match(/^(\d{1,2})\s*[:\-]\s*(\d{1,2})$/);
  if (m) return { kind: "score", a: m[1], b: m[2] };
  // ДВОЙНОЙ ШАНС (две стороны из трёх): 1X / X2 / 12 — это НЕ одиночная победа, отдельный тип
  m = d.match(/^(1X|X2|12)$/i);
  if (m) { const u = m[1].toUpperCase(); return { kind: "dc", sides: u === "1X" ? ["1", "X"] : u === "X2" ? ["X", "2"] : ["1", "2"] }; }
  // ПОБЕДА (одиночный исход): П1/П2 / 1/2 / W1/W2 / X (ничья) — чистый токен, одинаков на любом языке
  if (/^(П\s*[12]|[12]|W\s*[12]|X)$/i.test(d)) {
    const mm = d.match(/[12]/);
    return { kind: "win", side: mm ? mm[0] : "X" }; // X = ничья (одиночный исход)
  }
  return { kind: null, reason: "нестандартный рынок" };
}

// Имя/слаг в латиницу, нижний регистр, без диакритики → токены через пробел.
function slugify(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function eventSlug(url) { try { return slugify(new URL(url).pathname); } catch { return ""; } }

// Порядок игроков/команд (player1 первым) из URL события по их реальным именам с кнопок.
// surebet кладёт сторону позиционно (Ф1/П1 = первый), а имя — только на кнопке конторы:
// сопоставляем по первому вхождению имени в слаг URL (в слаге игроки идут в порядке матча).
function orderPlayers(eventUrl, names) {
  const slug = " " + eventSlug(eventUrl) + " ";
  if (slug.trim().length < 3) return null;
  const uniq = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))];
  const scored = [];
  for (const n of uniq) {
    let min = Infinity;
    for (const tok of slugify(n).split(/\s+/)) { if (tok.length < 3) continue; const i = slug.indexOf(" " + tok + " "); if (i >= 0 && i < min) min = i; }
    if (min < Infinity) scored.push({ n, idx: min });
  }
  if (scored.length < 2) return null;
  scored.sort((a, b) => a.idx - b.idx);
  return scored.map((x) => x.n);
}

// Выбрать кнопку исхода на странице события (обе конторы) ПО СОВОКУПНОСТИ признаков.
// Вилка часто НЕ даёт id исхода (Pinnacle/ps3838 и Betano) — только описание (tr_terse) и кэф.
// 1) если id из вилки есть и совпал «хвост» — по id;
// 2) иначе — по СТРУКТУРЕ исхода: тип рынка (победа/фора/тотал/счёт) + ТОЧНАЯ линия + сторона.
//    Кэф — лишь сверка (различить ±фору у обоих игроков и отсечь грубо чужой рынок), не основа выбора.
// Если рынок не распознан (пропс/экзотика) или структурно ничего точно не совпало → null (отказ).
// buttons: [{ i, id, text }] — i = позиция кнопки в выборке селектора (для клика по индексу).
function pickOutcome({ desc = "", expectedOdds = 0, outcomeId = "", buttons = [], eventUrl = "", unit = null, subject = "" } = {}) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const oddsOf = (t) => { const ns = norm(t).match(/\d+\.\d+/g); return ns ? Number(ns[ns.length - 1]) : null; };
  const ret = (b, how) => (b ? { i: b.i, id: b.id || "", text: norm(b.text), odds: oddsOf(b.text), how } : null);
  const cands = buttons.filter((b) => /\d+\.\d+/.test(b.text || "")); // кнопка-исход = есть кэф в тексте

  // 1) точный путь — по «хвосту» id из вилки (Pinnacle-бренды, где pinnacleBrExternalId есть)
  const oid = String(outcomeId || "");
  if (oid.includes("|")) {
    const suffix = oid.split("|").slice(1).join("|");
    const hit = cands.find((b) => String(b.id || "").includes("|") && b.id.split("|").slice(1).join("|") === suffix);
    if (hit) return ret(hit, "id");
  }

  // 2) по распознанному рынку из описания + ближайшему кэфу
  const c = classifyDesc(desc);
  if (!c.kind) return null; // пропс/экзотика — не угадываем

  // структурный разбор кнопки: линия форы со знаком / линия тотала / счёт «a-b»
  const numOf = (s) => { const n = parseFloat(String(s).replace(",", ".").replace(/−/g, "-")); return Number.isFinite(n) ? n : null; };
  const hcapLine = (t) => { const m = norm(t).match(/[+\-−]\d+(?:\.\d+)?/); return m ? numOf(m[0]) : null; };
  const totalLine = (t) => { const m = norm(t).match(/(?:over|under|больш\w*|меньш\w*)\s*(\d+(?:\.\d+)?)/i); return m ? numOf(m[1]) : null; };
  const scoreOf = (t) => { const m = norm(t).match(/(?:^|\D)(\d{1,2})\s*[-:]\s*(\d{1,2})(?=\D|$)/); return m ? [Number(m[1]), Number(m[2])] : null; };
  const nameOf = (t) => norm(t).replace(/[+\-−]?\d+(?:[.,]\d+)?/g, " ").replace(/\s+/g, " ").trim(); // текст без чисел (имя)
  // СОСТАВНАЯ кнопка (двойной шанс): «X or Y» / «X ou Y» / «X / Y» / метка «1X»/«X2»/«12» отдельным токеном.
  // (метка как ТОКЕН, не «12» из «Over 12.5» или кэфа «1.26»)
  const isCompound = (t) => { const s = norm(t).toLowerCase(); return /\b(or|ou|или)\b|\s[\/&]\s/.test(s) || /(^|\s)(1x|x2|12)(\s|$)/.test(s); };

  // пул кандидатов = ТОЧНОЕ структурное совпадение по типу+линии+стороне (кэф тут НЕ участвует)
  let pool;
  if (c.kind === "total") {
    const want = numOf(c.line);
    pool = cands.filter((b) => (c.over ? /over|больш/i.test(b.text) : /under|меньш/i.test(b.text)) && totalLine(b.text) === want);
  } else if (c.kind === "hcap") {
    const want = numOf(c.line);
    pool = cands.filter((b) => hcapLine(b.text) === want); // знак+значение форы совпали точно
    // Сетовая фора −1.5 в БО3 ⟺ точный счёт (фаворит 2:0). У Betano нет сетовой форы — есть счёт;
    // у Pinnacle есть фора. Добавляем счёт-кандидата, нужного выберет сверка кэфа.
    if (unit === "set" && want === -1.5 && (c.side === "1" || c.side === "2")) {
      const a = c.side === "1" ? 2 : 0, z = c.side === "1" ? 0 : 2; // счёт от лица игрока 1
      pool = pool.concat(cands.filter((b) => { const s = scoreOf(b.text); return s && s[0] === a && s[1] === z; }));
    }
  } else if (c.kind === "score") {
    const a = Number(c.a), z = Number(c.b);
    pool = cands.filter((b) => { const s = scoreOf(b.text); return s && s[0] === a && s[1] === z; });
  } else if (c.kind === "dc") { // ДВОЙНОЙ ШАНС — СОСТАВНАЯ кнопка из двух сторон
    const lbl = c.sides.join(""); // "1X" / "X2" / "12"
    const drawRe = /draw|empate|ничья|\bx\b/i;
    const comp = cands.filter((b) => isCompound(b.text) && hcapLine(b.text) === null && scoreOf(b.text) === null);
    // 1) метка «1X/X2/12» прямо в тексте кнопки
    let dcPool = comp.filter((b) => new RegExp("(^|[^0-9a-z])" + lbl + "([^0-9a-z]|$)", "i").test(norm(b.text)));
    // 2) иначе по сторонам: имена команд из URL (player1 первым) + признак ничьи
    if (!dcPool.length && eventUrl) {
      const winLike = cands.filter((b) => !isCompound(b.text) && !/over|under|больш|меньш/i.test(b.text) && hcapLine(b.text) === null && scoreOf(b.text) === null && /[a-zA-Z]{2,}/.test(nameOf(b.text)));
      const order = orderPlayers(eventUrl, winLike.map((b) => nameOf(b.text)));
      if (order && order.length >= 2) {
        const t1 = slugify(order[0]), t2 = slugify(order[1]);
        const has = (b, t) => { const nm = slugify(nameOf(b.text)); return t && (nm.includes(t) || t.includes(nm)); };
        dcPool = comp.filter((b) => {
          const draw = drawRe.test(b.text);
          if (lbl === "12") return has(b, t1) && has(b, t2) && !draw;
          if (lbl === "1X") return has(b, t1) && draw;
          if (lbl === "X2") return has(b, t2) && draw;
          return false;
        });
      }
    }
    pool = dcPool; // не нашли однозначно → пусто → отказ (безопасно)
  } else { // win — ОДИНОЧНАЯ кнопка: без линии/счёта И НЕ составная («X or Y» = двойной шанс, не сюда)
    pool = cands.filter((b) => !/over|under|больш|меньш/i.test(b.text) && hcapLine(b.text) === null && scoreOf(b.text) === null && !isCompound(b.text));
  }
  if (!pool.length) return null; // нужный исход структурно не найден (скрыт/нет на странице) → отказ

  // доп. СИГНАЛ: сверка стороны по имени игрока/команды (победа и фора, где у кнопки есть имя).
  // Порядок игроков берём из URL события (player1 первым); имя нужной стороны (Ф1/П1) должно
  // совпасть с именем на кнопке. Это сильнее кэфа: если совпало — кэф для выбора уже не нужен.
  // (nameOf объявлен выше, в блоке структурных хелперов)
  let nameConfirmed = false;
  // Если в пуле есть кнопка-счёт (маппинг сетовой форы −1.5 → счёт), имя НЕ применяем:
  // у счёта нет имени, сторона уже закодирована в счёте, выбор форы-vs-счёта делает кэф.
  const poolHasScore = pool.some((b) => scoreOf(b.text));
  // имена применяем ТОЛЬКО если они есть на кнопках этого пула латиницей (Betano-фора/победа,
  // Pinnacle-победа). У Pinnacle-ФОРЫ имени в кнопке нет → не трогаем (сторону различает кэф).
  const poolHasNames = pool.some((b) => /[a-zA-Z]{2,}/.test(nameOf(b.text)));
  if ((c.kind === "win" || c.kind === "hcap") && c.side && !poolHasScore && poolHasNames) {
    // ЦЕЛЬ по имени — два источника: (1) ПРЯМО имя плеча из вилки (descFull→subject; для Betano англ.,
    // совпадает с кнопкой), (2) запасное — игрок нужной стороны из порядка в URL (для кросс-языка).
    const targets = [];
    const subj = slugify(subject); if (subj) targets.push(subj);
    if (eventUrl) {
      const winLike = cands.filter((b) => !/over|under|больш|меньш/i.test(b.text) && hcapLine(b.text) === null && scoreOf(b.text) === null);
      const order = orderPlayers(eventUrl, winLike.map((b) => nameOf(b.text)));
      const t = order && order[Number(c.side) - 1] ? slugify(order[Number(c.side) - 1]) : null;
      if (t) targets.push(t);
    }
    if (targets.length) {
      const named = pool.filter((b) => { const nm = slugify(nameOf(b.text)); return nm && targets.some((t) => nm.includes(t) || t.includes(nm)); });
      if (named.length) { pool = named; nameConfirmed = true; } // имя однозначно указало сторону
      else return null; // имена на кнопках есть, но НУЖНОЙ стороны (ни по descFull, ни по URL) нет → отказ
    }
  }

  // единственное совпадение → берём; несколько → различаем по ближайшему кэфу из вилки.
  let best = pool[0];
  if (pool.length > 1) {
    if (!expectedOdds) return null; // не можем уверенно выбрать сторону → отказ
    let bd = Infinity; best = null;
    for (const b of pool) { const o = oddsOf(b.text); if (o == null) continue; const dd = Math.abs(o - expectedOdds); if (dd < bd) { bd = dd; best = b; } }
    if (!best) return null;
  }
  // сверка по кэфу — страховка ТОЛЬКО когда сторона НЕ подтверждена именем (иначе исход уже однозначен).
  if (expectedOdds && !nameConfirmed) {
    const o = oddsOf(best.text);
    if (o != null && Math.abs(o - expectedOdds) / expectedOdds > PICK_ODDS_GATE) return null;
  }
  return ret(best, nameConfirmed ? "name" : "desc");
}

module.exports = {
  defaultBookers, emptyProxy, buildProxyString, betanoTarget, localizeBetanoUrl, randomFingerprint, randomUA, buildFingerprintScript, bookerForUrl,
  parseSurebetNav, resolveSurebetNav, bkToBookerId, pickOutcome, classifyDesc, orderPlayers, isEventUrl, extractSubject, marketUnit, BK_TO_BOOKER, BOOKER_KEYWORDS, UA_PRESETS, WEBGL_PRESETS,
};
