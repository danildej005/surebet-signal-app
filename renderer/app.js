"use strict";
const $ = (id) => document.getElementById(id);

function renderStatus(s) {
  if (!s) return;
  const setText = (id, t) => { const e = $(id); if (e) e.textContent = t; }; // верхние элементы могли быть убраны
  setText("lastError", s.lastError ? "⚠️ " + s.lastError : "");
  // Telegram-поля: заполняем ОДИН раз при загрузке (токен не показываем — только подсказку «задан»).
  if (!tgInit && s.settings) {
    tgInit = true;
    if ($("tgChat") && s.settings.tgChat) $("tgChat").value = s.settings.tgChat;
    if ($("tgKeyword") && s.settings.keyword) $("tgKeyword").value = s.settings.keyword;
    if ($("tgToken")) $("tgToken").placeholder = s.settings.hasToken ? "токен задан — оставь пустым, чтобы не менять" : "вставь токен бота";
  }
  // Value-режим: заполняем поля ОДИН раз при загрузке (секреты — только placeholder).
  if (!valueInit && s.settings && $("bettingcoKey")) {
    valueInit = true;
    const v = s.settings;
    $("valueThreshold").value = Math.round((v.valueThreshold != null ? v.valueThreshold : 0.05) * 1000) / 10; // доля → %
    $("valueOddsMin").value = v.valueOddsMin || "";
    $("valueOddsMax").value = v.valueOddsMax || "";
    if (v.valueStake) $("valueStake").value = v.valueStake;
    $("valueMaxPerDay").value = v.valueMaxPerDay != null ? v.valueMaxPerDay : 20;
    $("valueLive").checked = !!v.valueLive;
    if ($("valuePlace")) $("valuePlace").checked = !!v.valuePlace;
    if ($("valuePlaceRequireArb")) $("valuePlaceRequireArb").checked = !!v.valuePlaceRequireArb;
    if ($("valuePlaceMlOnly")) $("valuePlaceMlOnly").checked = Array.isArray(v.valuePlaceKinds) && v.valuePlaceKinds.length === 1 && v.valuePlaceKinds[0] === "ML";
    $("bettingcoKey").value = v.bettingcoKey || "";   // ключ Betano-фида (bettingco), показываем целиком (его машина)
    valueSportsState = (v.valueSports && v.valueSports.length) ? v.valueSports.map((x) => ({ ...x })) : [];
    valueMarketsState = Array.isArray(v.valueMarkets) ? v.valueMarkets.slice() : [];
    renderValueSports();
    renderValueMarkets();
  }
}
let tgInit = false;         // Telegram-поля инициализированы (заполняем только раз)
let valueInit = false;      // value-поля инициализированы (заполняем только раз)

async function refresh() { renderStatus(await window.api.getStatus()); }

window.api.onStatus(renderStatus);

if ($("openLogs")) $("openLogs").onclick = () => window.api.openLogs();

// ── Статистика value в шапке (push из main каждый тик/скан) ───────────────────
if (window.api.onValuePulse) window.api.onValuePulse((p) => {
  const el = $("valuePulse"); if (!el || !p) return;
  const t = new Date(p.at || Date.now()).toLocaleTimeString();
  let s, color;
  if (!p.on) { color = "#7f8c8d"; s = "🎯 value: выключен"; }
  else if (p.error) { color = "#c0392b"; s = "🔴 value ОШИБКА: " + p.error; }
  else if (p.scanning) { color = "#2980b9"; s = "⚙️ сканирую кэфы…"; }
  else {
    color = p.live ? "#1a9e4b" : "#e67e22";
    s = "🎯 value " + (p.live ? "⚡БОЕВОЙ" : "dry-run") + " · кандидатов " + (p.candidates != null ? p.candidates : 0) +
      (p.top != null ? " (топ +" + (p.top * 100).toFixed(1) + "%)" : "") +
      " · поставлено " + (p.placedToday || 0) + "/" + (p.max || 0) + (p.note ? " · " + p.note : "");
    if (p.lastBet) s += "\nпоследняя: " + p.lastBet;
  }
  el.style.color = color;
  el.style.whiteSpace = "pre-wrap";
  el.textContent = "value " + t + ": " + s;
});

// ── Telegram: сохранение настроек + тест ──────────────────────────────────────
async function saveTg() {
  const patch = { tgChat: $("tgChat").value.trim() };
  const tok = $("tgToken").value.trim();
  if (tok) patch.tgToken = tok; // пустой токен не затирает сохранённый (см. main.cjs save-settings)
  await window.api.saveSettings(patch);
  $("tgToken").value = ""; // не держим токен в поле
}
if ($("tgSave")) $("tgSave").onclick = async () => {
  try { await saveTg(); $("tgResult").textContent = "✅ сохранено"; }
  catch (e) { $("tgResult").textContent = "⚠️ " + e.message; }
};
if ($("tgTest")) $("tgTest").onclick = async () => {
  $("tgResult").textContent = "сохраняю и отправляю тест…";
  try {
    await saveTg(); // тест шлёт по СОХРАНённым настройкам — сначала сохраняем поля
    const r = await window.api.testTelegram();
    $("tgResult").textContent = (r && r.ok) ? "✅ тест отправлен — проверь Telegram" : "⚠️ " + ((r && r.error) || "ошибка");
  } catch (e) { $("tgResult").textContent = "⚠️ " + e.message; }
};

// ── Value-режим: спорты/маркеты галочками, пороги/кэф списками ────────────────
const MARKET_GROUPS = [
  ["Исход (1X2 / мани-лайн)", ["1x2", "moneyline"]],
  ["Тоталы", ["totals"]],
  ["Форы (азиатские)", ["spreads"]],
  ["DNB (без ничьи)", ["drawnobet"]],
  ["Двойной шанс", ["doublechance"]],
];
let valueSportsState = [];   // [{key,name,oa,ps,on,leagues}]
let valueMarketsState = [];  // [marketType,…]

function fillSelect(id, items, cur) {
  const s = $(id); if (!s) return;
  s.innerHTML = "";
  items.forEach((it) => { const o = el("option", { value: String(it.val), textContent: it.txt }); if (String(it.val) === String(cur)) o.selected = true; s.append(o); });
}
function renderValueSports() {
  const root = $("valueSports"); if (!root) return;
  root.innerHTML = "";
  valueSportsState.forEach((sp) => {
    sp.exclude = Array.isArray(sp.exclude) ? sp.exclude : [];
    const cb = el("input", { type: "checkbox", checked: !!sp.on }); cb.style.width = "auto";
    const status = el("span", { className: "muted", textContent: sp.on ? "все лиги (авто)" : "выкл" });
    const lgWrap = el("div", { style: "margin:2px 0 8px 22px;" });

    // при включённом спорте — авто-показ ВСЕХ его лиг (галочки, все включены кроме exclude). Новые лиги
    // бот подхватывает сам (список освежается); сними галочку, чтобы исключить лигу.
    const renderLeagues = async () => {
      lgWrap.innerHTML = "";
      if (!sp.on) { status.textContent = "выкл"; return; }
      status.textContent = "все лиги (авто)";
      lgWrap.append(el("div", { className: "muted", textContent: "загружаю лиги…" }));
      const r = await window.api.getTournaments(sp.oa).catch((e) => ({ error: e.message }));
      lgWrap.innerHTML = "";
      if (!r || r.error) { lgWrap.append(el("div", { className: "muted", textContent: "лиги: ⚠️ " + ((r && r.error) || "ошибка — сохрани ключ oddspapi") })); return; }
      const list = r.list || [];
      const ex = new Set((sp.exclude || []).map(String));
      lgWrap.append(el("div", { className: "muted", textContent: "лиги: " + list.length + " (все включены; сними галочку — исключить):" }));
      const box = el("div", { style: "max-height:150px; overflow:auto; border:1px solid #eee; border-radius:6px; padding:4px;" });
      list.forEach((t) => {
        const c = el("input", { type: "checkbox", checked: !ex.has(t.id) }); c.style.width = "auto";
        c.onchange = () => { if (c.checked) ex.delete(t.id); else ex.add(t.id); sp.exclude = [...ex]; };
        box.append(el("label", { className: "muted", style: "display:flex; gap:6px; align-items:center; font-size:12px; margin:1px 0;" }, [c, el("span", { textContent: t.label + " · " + t.n })]));
      });
      if (!list.length) box.append(el("div", { className: "muted", textContent: "нет активных лиг (проверь ключ/спорт)" }));
      lgWrap.append(box);
    };
    cb.onchange = () => { sp.on = cb.checked; renderLeagues(); };
    root.append(el("div", { className: "row", style: "gap:6px; align-items:center; margin:6px 0 0 0;" }, [
      cb, el("span", { textContent: sp.name, style: "flex:0 0 150px; font-weight:600;" }), status,
    ]));
    root.append(lgWrap);
    if (sp.on) renderLeagues();
  });
}
function renderValueMarkets() {
  const root = $("valueMarkets"); if (!root) return;
  root.innerHTML = "";
  MARKET_GROUPS.forEach(([label, types]) => {
    const on = types.every((t) => valueMarketsState.includes(t));
    const cb = el("input", { type: "checkbox", checked: on }); cb.style.width = "auto";
    cb.onchange = () => {
      valueMarketsState = valueMarketsState.filter((t) => !types.includes(t));
      if (cb.checked) types.forEach((t) => valueMarketsState.push(t));
    };
    root.append(el("label", { className: "muted", style: "display:flex; align-items:center; gap:6px; margin:2px 0;" }, [cb, el("span", { textContent: " " + label })]));
  });
}

function saveValue() {
  const patch = {
    valueThreshold: (Number($("valueThreshold").value) || 5) / 100,
    valueStake: Number($("valueStake").value) || 0,
    valueMaxPerDay: Number($("valueMaxPerDay").value) || 0,
    valueOddsMin: Number($("valueOddsMin").value) || 0,
    valueOddsMax: Number($("valueOddsMax").value) || 0,
    valueLive: $("valueLive").checked,
    valuePlace: $("valuePlace") ? $("valuePlace").checked : false,
    valuePlaceRequireArb: $("valuePlaceRequireArb") ? $("valuePlaceRequireArb").checked : false,
    valuePlaceKinds: ($("valuePlaceMlOnly") && $("valuePlaceMlOnly").checked) ? ["ML"] : [],
    valueSports: valueSportsState.map((s) => ({ key: s.key, name: s.name, oa: s.oa, ps: s.ps, on: !!s.on, exclude: Array.isArray(s.exclude) ? s.exclude : [] })),
    valueMarkets: valueMarketsState.slice(),
  };
  const k = $("bettingcoKey").value.trim(); if (k) patch.bettingcoKey = k;
  return window.api.saveSettings(patch); // поле НЕ очищаем — ключ остаётся виден
}
if ($("valueSave")) $("valueSave").onclick = async () => {
  try { await saveValue(); $("valueResult").textContent = "✅ сохранено"; }
  catch (e) { $("valueResult").textContent = "⚠️ " + e.message; }
};
// тумблеры value — это КОНФИГ: сохраняем сразу, но движок НЕ трогаем (сессия — отдельной кнопкой ниже).
if ($("valueLive")) $("valueLive").onchange = () => saveValue().then(() => { $("valueResult").textContent = $("valueLive").checked ? "⚡ боевой ВКЛ (применится к идущей сессии)" : "dry-run"; }).catch(() => {});
if ($("valuePlace")) $("valuePlace").onchange = () => saveValue().then(() => { $("valueResult").textContent = $("valuePlace").checked ? "🅱️ простановка ВКЛ" : "простановка выкл"; }).catch(() => {});
if ($("valuePlaceRequireArb")) $("valuePlaceRequireArb").onchange = () => saveValue().catch(() => {});
if ($("valuePlaceMlOnly")) $("valuePlaceMlOnly").onchange = () => saveValue().catch(() => {});

// Старт/стоп value-сессии — ОТДЕЛЬНАЯ кнопка (тумблеры её не запускают). Перед стартом сохраняем конфиг.
let valueSessionOn = false;
function setRunBtn(on) {
  valueSessionOn = !!on;
  const b = $("valueRunBtn"); if (b) b.textContent = on ? "⏹ Остановить сессию" : "▶ Запустить сессию";
}
if ($("valueRunBtn")) $("valueRunBtn").onclick = async () => {
  const b = $("valueRunBtn"); if (b) b.disabled = true;
  try {
    if (!valueSessionOn) { await saveValue(); setRunBtn(await window.api.runValueSession(true)); $("valueResult").textContent = "▶ сессия запущена"; }
    else { setRunBtn(await window.api.runValueSession(false)); $("valueResult").textContent = "⏹ сессия остановлена"; }
  } catch (e) { $("valueResult").textContent = "⚠️ " + e.message; }
  finally { if (b) b.disabled = false; }
};
if (window.api.valueRunState) window.api.valueRunState().then((on) => setRunBtn(on)).catch(() => {});

// ── конторы (антидетект-профили) ──────────────────────────────────────────────
let bookersCache = [];
const FP_FIELDS = [
  ["ua", "User-Agent"], ["cores", "Ядра CPU"], ["memory", "Память, ГБ"],
  ["screenW", "Экран, ширина"], ["screenH", "Экран, высота"],
  ["webglVendor", "WebGL vendor"], ["webglRenderer", "WebGL renderer"],
  ["languages", "Языки (через запятую)"], ["timezone", "Таймзона"], ["locale", "Локаль"],
  ["lat", "Гео широта"], ["lon", "Гео долгота"],
];
const NUM_FP = ["cores", "memory", "screenW", "screenH", "lat", "lon"];

function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  kids.forEach((k) => e.append(k));
  return e;
}
function field(label, value, onchange) {
  const i = el("input", { type: "text", value: value == null ? "" : String(value) });
  i.oninput = () => onchange(i.value);
  return el("label", { textContent: label }, [i]);
}
function checkRow(label, checked, onchange) {
  const c = el("input", { type: "checkbox", checked: !!checked });
  c.style.width = "auto";
  c.onchange = () => onchange(c.checked);
  const wrap = el("label", { className: "muted" }, [c, el("span", { textContent: " " + label })]);
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "6px";
  return wrap;
}

function selectField(label, value, options, onchange) {
  const s = el("select");
  options.forEach(([val, txt]) => {
    const o = el("option", { value: val, textContent: txt });
    if (val === value) o.selected = true;
    s.append(o);
  });
  s.onchange = () => onchange(s.value);
  return el("label", { textContent: label }, [s]);
}

function fmtPlace(r) {
  if (!r || !r.ok) {
    let s = "⚠️ " + ((r && r.error) || "ошибка");
    if (r && r.selected) s += " · (выбран: " + r.selected + ")";
    return s;
  }
  const p = [];
  if (r.selected) p.push("исход: " + r.selected + (r.how === "id" ? " [id]" : r.how === "name" ? " [имя+линия]" : r.how === "desc" ? " [по описанию]" : ""));
  if (r.selectedOdds != null) {
    let s = "кэф: " + r.selectedOdds;
    if (r.expectedOdds) s += " (ждали " + r.expectedOdds + ")";
    if (r.oddsOk === false) s += " ⚠️УЕХАЛ"; else if (r.oddsOk) s += " ✓";
    p.push(s);
  }
  p.push("сумма: " + r.stakeValue);
  if (r.maxStake != null) p.push("макс: " + r.maxStake);
  p.push("кнопка: " + (r.placeBtnText || "НЕ найдена"));
  return "🧪 " + p.join(" · ");
}

async function renderBookers() {
  bookersCache = await window.api.getBookers();
  const st = await window.api.getStatus();
  const octoCfg = (st && st.settings) || {}; // octoProfileId / octoApiUrl / octoMode для карточки Betano
  const root = $("bookers");
  root.innerHTML = "";
  bookersCache.forEach((b) => {
    b.fp = b.fp || {};
    b.proxy = b.proxy || { protocol: "", host: "", port: "", user: "", pass: "" };
    b.login = b.login || { user: "", pass: "" };

    // BETANO — Octo-режим: анонимка (прокси/UA/отпечаток) ВНУТРИ Octo-профиля. Здесь только UUID профиля,
    // адрес Local API, логин/пароль конторы и тест простановки. «Войти» открывает профиль Betano в Octo.
    if (b.id === "betano") {
      const pidInput = el("input", { type: "text", value: octoCfg.octoProfileId || "", placeholder: "UUID профиля Betano из Octo" });
      const apiInput = el("input", { type: "text", value: octoCfg.octoApiUrl || "http://127.0.0.1:58888" });
      const exeInput = el("input", { type: "text", value: octoCfg.octoExePath || "", placeholder: "необяз.: путь к Octo.exe (если автозапуск не находит)" });
      const octoStatus = el("div", { style: "font-size:12px; margin-top:4px; white-space:pre-wrap;",
        textContent: octoCfg.octoProfileId ? "профиль задан — нажми «Войти», чтобы открыть в Octo" : "впиши UUID профиля из Octo и нажми «Войти»" });
      const enterOcto = el("button", { textContent: "Войти (Octo)", onclick: async () => {
        octoStatus.style.color = "#2980b9"; octoStatus.textContent = "сохраняю и открываю Octo (если закрыт — запущу)…";
        await window.api.saveSettings({ octoProfileId: pidInput.value.trim(), octoApiUrl: apiInput.value.trim() || "http://127.0.0.1:58888", octoExePath: exeInput.value.trim(), octoMode: true });
        await window.api.saveBookers(bookersCache); // сохранить логин/пароль Betano
        try {
          const r = await window.api.openOcto();
          if (r && r.ok) { octoStatus.style.color = "#1a9e4b"; octoStatus.textContent = "✅ Octo открыт" + (r.url ? ": " + r.url : " (профиль запущен)"); }
          else { octoStatus.style.color = "#c0392b"; octoStatus.textContent = "🔴 " + ((r && r.error) || "не удалось открыть Octo"); }
        } catch (e) { octoStatus.style.color = "#c0392b"; octoStatus.textContent = "⚠️ " + e.message; }
      } });
      const octoBox = el("div", { className: "subbox" }, [
        el("div", { className: "muted", textContent: "Octo Browser (антидетект) — прокси / UA / отпечаток внутри профиля. Если Octo закрыт — бот запустит его сам." }),
        el("label", { textContent: "UUID профиля Octo (Betano)" }, [pidInput]),
        el("label", { textContent: "Адрес Octo Local API" }, [apiInput]),
        el("label", { textContent: "Путь к Octo.exe (необязательно)" }, [exeInput]),
        octoStatus,
      ]);
      const loginBox = el("div", { className: "subbox" }, [
        el("div", { className: "muted", textContent: "Аккаунт Betano (логин / пароль)" }),
        el("div", { className: "grid2" }, [
          field("Логин", b.login.user || "", (v) => (b.login.user = v)),
          field("Пароль", b.login.pass || "", (v) => (b.login.pass = v)),
        ]),
      ]);
      const stakeBox = el("input", { type: "text", placeholder: "сумма" }); stakeBox.style.maxWidth = "120px";
      const dryResult = el("div", { className: "muted", textContent: "открой событие (value-цикл или вручную в Octo) → впиши сумму → тест" });
      const dryRow = el("div", {}, [
        el("div", { className: "row" }, [
          stakeBox,
          el("button", { className: "ghost", textContent: "Тест (dry-run)", onclick: async () => {
            dryResult.textContent = "проверяю…";
            try { dryResult.textContent = fmtPlace(await window.api.dryRunPlace(b.id, stakeBox.value.trim() || "10")); }
            catch (e) { dryResult.textContent = "⚠️ " + e.message; }
          } }),
          el("button", { className: "ghost", textContent: "Снять купон", onclick: async () => {
            const r = await window.api.captureBooker(b.id);
            $("saveHint").textContent = r.ok ? "🧾 купон снят: " + r.file : "⚠️ " + r.error;
          } }),
        ]),
        dryResult,
      ]);
      const card = el("details", { className: "booker", open: true }, [
        el("summary", {}, [el("b", { textContent: (b.name || b.id) + " · Octo" })]),
        enterOcto, octoBox, loginBox, dryRow,
      ]);
      root.append(card);
      return; // карточку Betano собрали — общий (Electron) рендер пропускаем
    }

    const enterBtn = el("button", { textContent: "Войти", onclick: async () => { await window.api.saveBookers(bookersCache); await window.api.openBooker(b.id); } });

    // Панель User-Agent: показ текущего + кнопка сгенерировать новый (не трогая остальной отпечаток)
    const uaText = el("div", { style: "font-size:12px; word-break:break-all; margin:4px 0;", textContent: "UA: " + (b.fp.ua || "—") });
    const uaRow = el("div", { className: "subbox" }, [
      el("div", { className: "muted", textContent: "User-Agent" }),
      uaText,
      el("button", { className: "ghost", textContent: "🎲 новый UA", onclick: async () => {
        const ua = await window.api.randomizeUa(b.id);
        if (ua) { b.fp.ua = ua; uaText.textContent = "UA: " + ua; }
      } }),
    ]);

    // Прокси (структурно) + индикатор «работает ли прокси»
    const proxyStatus = el("div", { style: "font-size:12px; margin-top:4px;", textContent: "прокси: не проверен" });
    const checkProxyBtn = el("button", { className: "ghost", textContent: "🌐 Проверить прокси", onclick: async () => {
      await window.api.saveBookers(bookersCache); // сначала сохранить поля, чтобы проверять актуальное
      proxyStatus.textContent = "прокси: проверяю…"; proxyStatus.style.color = "#555";
      try {
        const r = await window.api.checkProxy(b.id);
        if (!r || r.error) { proxyStatus.textContent = "прокси: ⚠️ " + ((r && r.error) || "ошибка"); proxyStatus.style.color = "#c0392b"; return; }
        if (!r.configured) { proxyStatus.textContent = "прокси: ⚪ НЕ задан — идёт реальный IP ВДС " + (r.realIp || "?") + (r.realCountry ? " (" + r.realCountry + ")" : ""); proxyStatus.style.color = "#7f8c8d"; }
        else if (r.viaProxy) { proxyStatus.textContent = "прокси: ✅ работает · " + r.proxyIp + (r.proxyCountry ? " (" + r.proxyCountry + ")" : ""); proxyStatus.style.color = "#1a9e4b"; }
        else if (!r.proxyIp || r.proxyError) { proxyStatus.textContent = "прокси: 🔴 НЕ отвечает (" + (r.proxyError || "нет ответа") + ") — мёртв / вайтлист / неверный тип"; proxyStatus.style.color = "#c0392b"; }
        else { proxyStatus.textContent = "прокси: 🔴 НЕ применяется — идёт напрямую, реальный IP " + r.realIp + (r.realCountry ? " (" + r.realCountry + ")" : ""); proxyStatus.style.color = "#c0392b"; }
      } catch (e) { proxyStatus.textContent = "прокси: ⚠️ " + e.message; proxyStatus.style.color = "#c0392b"; }
    } });
    const proxyBox = el("div", { className: "subbox" }, [
      el("div", { className: "muted", textContent: "Прокси конторы" }),
      selectField("Протокол", b.proxy.protocol || "", [["", "нет прокси"], ["http", "HTTP"], ["https", "HTTPS"], ["socks5", "SOCKS5"]], (v) => (b.proxy.protocol = v)),
      el("div", { className: "grid2" }, [
        field("Хост", b.proxy.host || "", (v) => (b.proxy.host = v)),
        field("Порт", b.proxy.port || "", (v) => (b.proxy.port = v)),
      ]),
      el("div", { className: "grid2" }, [
        field("Логин прокси", b.proxy.user || "", (v) => (b.proxy.user = v)),
        field("Пароль прокси", b.proxy.pass || "", (v) => (b.proxy.pass = v)),
      ]),
      el("div", { className: "row" }, [checkProxyBtn]),
      proxyStatus,
    ]);

    // Аккаунт конторы (для будущего автологина)
    const loginBox = el("div", { className: "subbox" }, [
      el("div", { className: "muted", textContent: "Аккаунт конторы (для будущего автологина)" }),
      el("div", { className: "grid2" }, [
        field("Логин", b.login.user || "", (v) => (b.login.user = v)),
        field("Пароль", b.login.pass || "", (v) => (b.login.pass = v)),
      ]),
    ]);

    // Отпечаток
    const det = el("details");
    det.append(el("summary", { className: "muted", textContent: "Отпечаток (изменить вручную)" }));
    FP_FIELDS.forEach(([key, lbl]) => {
      const val = Array.isArray(b.fp[key]) ? b.fp[key].join(",") : b.fp[key];
      det.append(field(lbl, val, (v) => {
        if (key === "languages") b.fp[key] = v.split(",").map((s) => s.trim()).filter(Boolean);
        else if (NUM_FP.includes(key)) b.fp[key] = v === "" ? null : Number(v);
        else b.fp[key] = v;
      }));
    });
    det.append(el("button", { className: "ghost", textContent: "Рандом отпечатка", onclick: async () => { await window.api.randomizeFp(b.id); renderBookers(); } }));

    const actions = el("div", { className: "row" }, [
      el("button", { className: "ghost", textContent: "🌍 Гео-диаг", onclick: async () => {
        $("saveHint").textContent = "гео-диагностика…";
        try {
          const r = await window.api.geoDiag(b.id);
          if (!r || r.error) { $("saveHint").textContent = "⚠️ " + ((r && r.error) || "ошибка"); return; }
          $("saveHint").textContent = "🌍 WebRTC: " + r.webrtc + " | гео: " + r.geo + " | язык: " + r.lang + " | tz: " + r.tz + " | IP через прокси: " + r.ipЧерезПрокси;
        } catch (e) { $("saveHint").textContent = "⚠️ " + e.message; }
      } }),
      el("button", { className: "ghost", textContent: "Снять купон", onclick: async () => {
        const r = await window.api.captureBooker(b.id);
        $("saveHint").textContent = r.ok ? "🧾 купон «" + (b.name || b.id) + "» снят: " + r.file : "⚠️ " + r.error;
      } }),
      el("button", { className: "ghost", textContent: "Сбросить данные браузера", onclick: async () => {
        if (!confirm("Сбросить cookies/сессию «" + (b.name || b.id) + "»? Логин слетит, надо будет войти заново.")) return;
        const r = await window.api.resetBookerData(b.id);
        $("saveHint").textContent = r.ok ? "🧹 данные «" + (b.name || b.id) + "» сброшены" : "⚠️ " + r.error;
      } }),
    ]);

    const stakeBox = el("input", { type: "text", placeholder: "сумма" });
    stakeBox.style.maxWidth = "120px";
    const dryResult = el("div", { className: "muted", textContent: "клик по плечу вилки откроет событие; впиши сумму → тест" });
    const dryRow = el("div", {}, [
      el("div", { className: "row" }, [
        stakeBox,
        el("button", { className: "ghost", textContent: "Тест (dry-run)", onclick: async () => {
          dryResult.textContent = "проверяю…";
          try { dryResult.textContent = fmtPlace(await window.api.dryRunPlace(b.id, stakeBox.value.trim() || "10")); }
          catch (e) { dryResult.textContent = "⚠️ " + e.message; }
        } }),
        el("button", { textContent: "ПОСТАВИТЬ ⚡", onclick: async () => {
          const sum = stakeBox.value.trim() || "10";
          if (!confirm("РЕАЛЬНО поставить на «" + (b.name || b.id) + "» сумму " + sum + "?")) return;
          dryResult.textContent = "ставлю…";
          try { const r = await window.api.placeBet(b.id, sum); dryResult.textContent = (r.placed ? "✅ ПОСТАВЛЕНО · " : "") + fmtPlace(r); }
          catch (e) { dryResult.textContent = "⚠️ " + e.message; }
        } }),
      ]),
      dryResult,
    ]);

    const card = el("details", { className: "booker" }, [
      el("summary", {}, [el("b", { textContent: b.name || b.id })]),
      enterBtn,
      uaRow,
      field("Адрес для входа (главная конторы)", b.url || "", (v) => (b.url = v)),
      proxyBox,
      loginBox,
      checkRow("Открывать при старте (войти заранее)", b.autoOpen, (v) => (b.autoOpen = v)),
      det,
      dryRow,
      actions,
    ]);
    root.append(card);
  });
  root.append(el("button", { textContent: "Сохранить конторы", onclick: async () => { await window.api.saveBookers(bookersCache); $("saveHint").textContent = "✅ конторы сохранены"; } }));
}
renderBookers();
if ($("logout")) $("logout").onclick = async () => { await window.api.logoutSurebet(); };
$("toggleRun").onclick = async () => {
  const s = await window.api.getStatus();
  await window.api.setRunning(!s.running);
  refresh();
};
refresh();
setInterval(refresh, 5000);
