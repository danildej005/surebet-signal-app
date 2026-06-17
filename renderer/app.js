"use strict";
const $ = (id) => document.getElementById(id);

function renderStatus(s) {
  if (!s) return;
  const setText = (id, t) => { const e = $(id); if (e) e.textContent = t; }; // верхние элементы могли быть убраны
  const dot = $("dot");
  if (dot) dot.className = "dot " + (s.loggedOut ? "warn" : s.running ? "on" : "pause");
  setText("stateText", s.loggedOut ? "Нужен вход в surebet" : s.running ? "Слежу за вилками" : "Пауза");
  setText("counts", `вилок: ${s.total} · Pinnacle: ${s.pinnacle} · отправлено: ${s.sent}`);
  setText("lastSignal", s.lastSignal ? `последний сигнал: ${s.lastSignal.event} (${s.lastSignal.profit}%)` : "");
  setText("lastError", s.loggedOut ? "⚠️ Нужен вход в surebet — бот не работает" : (s.lastError ? "⚠️ " + s.lastError : ""));
  if (s.settings && typeof s.settings.liveMode === "boolean" && document.activeElement !== $("liveMode")) {
    $("liveMode").checked = s.settings.liveMode;
  }
  if (typeof s.botArmed === "boolean" && s.botArmed !== botArmedUi) setBotBtn(s.botArmed);
  // Лимит вилки: заполняем поле ОДИН раз при загрузке. Дальше НЕ трогаем — иначе очистка/новое
  // значение затирались сохранённым на каждом тике (бот «застревал» на старом лимите 5€).
  if (!vilkaLimitInit && s.settings && s.settings.vilkaLimitEur != null) {
    vilkaLimitInit = true;
    if (s.settings.vilkaLimitEur > 0 && document.activeElement !== $("vilkaLimit")) $("vilkaLimit").value = s.settings.vilkaLimitEur;
  }
  // Telegram-поля: заполняем ОДИН раз при загрузке (токен не показываем — только подсказку «задан»).
  if (!tgInit && s.settings) {
    tgInit = true;
    if ($("tgChat") && s.settings.tgChat) $("tgChat").value = s.settings.tgChat;
    if ($("tgKeyword") && s.settings.keyword) $("tgKeyword").value = s.settings.keyword;
    if ($("tgToken")) $("tgToken").placeholder = s.settings.hasToken ? "токен задан — оставь пустым, чтобы не менять" : "вставь токен бота";
  }
}
let vilkaLimitInit = false; // лимит вилки в поле инициализирован (заполняем только раз)
let tgInit = false;         // Telegram-поля инициализированы (заполняем только раз)
let botArmedUi = false;
function setBotBtn(armed) {
  botArmedUi = armed;
  const live = $("liveMode").checked;
  $("runBot").textContent = armed ? "⏹ Стоп (жду вилку)" : (live ? "▶ Запуск бота ⚡БОЕВОЙ" : "▶ Запуск бота (dry-run)");
}

async function refresh() { renderStatus(await window.api.getStatus()); }

window.api.onStatus(renderStatus);

$("openSurebet").onclick = () => window.api.openSurebet();
$("openLogs").onclick = () => window.api.openLogs();
$("liveMode").onchange = () => { window.api.saveSettings({ liveMode: $("liveMode").checked }); setBotBtn(botArmedUi); };

function showFx(r) {
  if (!r || !$("fxRate")) return;
  $("fxRate").textContent = Number(r.rate).toFixed(4);
  const ago = r.at ? new Date(r.at).toLocaleTimeString() : "";
  $("fxSrc").textContent = r.stale ? "⚠️ (не обновился, " + (r.source || "") + ")" : (ago ? "· " + ago : "");
}
if (window.api.getFx) window.api.getFx().then(showFx).catch(() => {});
if (window.api.onFx) window.api.onFx(showFx);

// лимит вилки на плечо (€) — сохраняем при изменении
$("vilkaLimit").onchange = () => window.api.saveSettings({ vilkaLimitEur: Number($("vilkaLimit").value) || 0 });

// ── Telegram: сохранение настроек + тест ──────────────────────────────────────
async function saveTg() {
  const patch = { tgChat: $("tgChat").value.trim(), keyword: $("tgKeyword").value.trim() || "pinnacle" };
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

function fmtLeg(name, l) {
  if (!l) return name + ": —";
  const ok = l.oddsOk === false ? " ⚠️УЕХАЛ" : (l.oddsOk ? " ✓" : "");
  return name + ": " + (l.selected || "?") + " · кэф " + (l.odds ?? "?") + ok +
    " · ставка " + (l.stake ?? "?") + " (вписано " + (l.stakeValue ?? "?") + ")" +
    " · макс " + (l.max ?? "?") + " · баланс " + (l.balance ?? "?") + " · кнопка: " + (l.placeBtn || "—");
}
function fmtBot(r) {
  if (!r) return "—";
  if (!r.ok) return "⚠️ " + (r.error || "ошибка") + (r.calc ? " · профит " + r.calc.profitPct + "%" : "");
  const head = (r.placed ? "✅ ПОСТАВЛЕНО · " : "🧪 dry-run · ") +
    "профит " + r.profitPct + "% (" + r.profitEur + "€ с " + r.totalEur + "€) · курс " + r.rate;
  return head + "\n  " + fmtLeg("Betano", r.betano) + "\n  " + fmtLeg("Pinnacle", r.pinnacle);
}
$("runBot").onclick = async () => {
  const live = $("liveMode").checked;
  try {
    const r = await window.api.runBot(live);
    setBotBtn(!!(r && r.armed));
    $("botResult").textContent = (r && r.armed)
      ? "⏳ жду вилку Betano + Pinnacle(Delayed)… как поймаю — проставлю и остановлюсь"
      : "бот снят с ожидания";
  } catch (e) { $("botResult").textContent = "⚠️ " + e.message; }
};
// результат цикла приходит push-ом: пропуск (ищем дальше, остаёмся в ожидании) или успех (стоп)
if (window.api.onBot) window.api.onBot((res) => {
  // ТЕСТ-РЕЖИМ: и скип, и успех — остаёмся взведёнными (бот крутит до 10 успехов, потом отчёт)
  if (res && res.skipped) {
    $("botResult").textContent = "⏭ пропустил «" + (res.pair || "?") + "» (" + (res.reason || "не умею") + ") — ищу дальше…";
  } else {
    $("botResult").textContent = fmtBot(res) + "\n…тест продолжается, ищу следующую вилку";
  }
  setBotBtn(true);
});
if (window.api.onBotStats) window.api.onBotStats((report) => {
  const el = $("botResult");
  el.style.whiteSpace = "pre-wrap";
  el.textContent = report;            // развёрнутый отчёт по тесту
  setBotBtn(false);                   // тест завершён → бот разоружён
});
// ЖИВОЙ ПУЛЬС: обновляется каждый тик — видно, что бот жив / ждёт / обрабатывает / упал в ошибку
if (window.api.onBotPulse) window.api.onBotPulse((p) => {
  const el = $("botPulse");
  if (!el || !p) return;
  const t = new Date(p.at || Date.now()).toLocaleTimeString();
  let s, color;
  if (p.armed === false) {
    color = "#7f8c8d"; s = "⏹ остановлен";
  } else if (p.error) {
    color = "#c0392b"; s = "🔴 ОШИБКА: " + p.error;
  } else if (p.wait) {
    color = "#e67e22"; s = "⏸ жду пополнения баланса: " + p.wait; // плечо не покрывается — ждём, не выключаемся
  } else if (p.busy) {
    color = "#2980b9"; s = "⚙️ обрабатываю вилку… · успехов " + (p.success || 0) + "/" + (p.target || "?") + " · пробовано " + (p.tried || 0);
  } else {
    color = "#27ae60"; s = "🟢 жив, жду вилку · в фиде " + (p.records || 0) + ", годных пар " + (p.pairs || 0) + ", новых " + (p.fresh || 0) +
      " · успехов " + (p.success || 0) + "/" + (p.target || "?") + " · пробовано " + (p.tried || 0);
  }
  el.style.color = color;
  el.textContent = "бот " + t + ": " + s;
  // счётчики сессии
  const cnt = $("botCounters");
  if (cnt) {
    const exposed = p.exposed || 0;
    cnt.textContent = "сессия: всего " + (p.total || 0) + " · ✅ хедж " + (p.hedged || 0) +
      " · 🔴 незахедж. " + exposed + " · ⏭ пропущено " + (p.skipped || 0);
    cnt.style.color = exposed > 0 ? "#c0392b" : "#333";
    cnt.style.fontWeight = exposed > 0 ? "700" : "400";
  }
});

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
  const root = $("bookers");
  root.innerHTML = "";
  bookersCache.forEach((b) => {
    b.fp = b.fp || {};
    b.proxy = b.proxy || { protocol: "", host: "", port: "", user: "", pass: "" };
    b.login = b.login || { user: "", pass: "" };

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
$("logout").onclick = async () => { await window.api.logoutSurebet(); };
$("toggleRun").onclick = async () => {
  const s = await window.api.getStatus();
  await window.api.setRunning(!s.running);
  refresh();
};
refresh();
setInterval(refresh, 5000);
