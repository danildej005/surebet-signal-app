"use strict";
const $ = (id) => document.getElementById(id);

function renderStatus(s) {
  if (!s) return;
  const dot = $("dot");
  dot.className = "dot " + (s.loggedOut ? "warn" : s.running ? "on" : "pause");
  $("stateText").textContent = s.loggedOut
    ? "Нужен вход в surebet"
    : s.running ? "Слежу за вилками" : "Пауза";
  $("counts").textContent = `вилок: ${s.total} · Pinnacle: ${s.pinnacle} · отправлено: ${s.sent}`;
  $("lastSignal").textContent = s.lastSignal
    ? `последний сигнал: ${s.lastSignal.event} (${s.lastSignal.profit}%)`
    : "";
  $("lastError").textContent = s.lastError ? "⚠️ " + s.lastError : "";
  if (s.settings) {
    if (s.settings.tgChat && !$("tgChat").value) $("tgChat").value = s.settings.tgChat;
    if (s.settings.tgApiBase && document.activeElement !== $("tgApiBase")) $("tgApiBase").value = s.settings.tgApiBase;
    if (s.settings.proxy !== undefined && document.activeElement !== $("proxy") && !$("proxy").value) $("proxy").value = s.settings.proxy;
    if (s.settings.keyword && document.activeElement !== $("keyword")) $("keyword").value = s.settings.keyword;
    if (s.settings.pollMs && document.activeElement !== $("pollSec")) $("pollSec").value = Math.round(s.settings.pollMs / 1000);
    if (s.settings.hasToken && !$("tgToken").placeholder.includes("сохранён"))
      $("tgToken").placeholder = "токен сохранён — оставь пустым, чтобы не менять";
  }
}

async function refresh() { renderStatus(await window.api.getStatus()); }

window.api.onStatus(renderStatus);

$("openSurebet").onclick = () => window.api.openSurebet();
$("openLogs").onclick = () => window.api.openLogs();
$("captureBooker").onclick = async () => {
  $("saveHint").textContent = "снимаю разметку купона…";
  const r = await window.api.captureBooker();
  $("saveHint").textContent = r.ok ? "✅ снято: " + r.file : "⚠️ " + r.error;
};

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

async function renderBookers() {
  bookersCache = await window.api.getBookers();
  const root = $("bookers");
  root.innerHTML = "";
  bookersCache.forEach((b) => {
    b.fp = b.fp || {};
    b.proxy = b.proxy || { protocol: "", host: "", port: "", user: "", pass: "" };
    b.login = b.login || { user: "", pass: "" };

    const head = el("div", { className: "row" }, [
      el("b", { textContent: b.name || b.id }),
      el("button", { textContent: "Войти", onclick: async () => { await window.api.saveBookers(bookersCache); await window.api.openBooker(b.id); } }),
    ]);

    // Прокси (структурно)
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
    const dryResult = el("div", { className: "muted", textContent: "сначала выбери исход в купоне, потом жми тест" });
    const dryRow = el("div", {}, [
      el("div", { className: "row" }, [
        stakeBox,
        el("button", { className: "ghost", textContent: "Тест ставки (dry-run)", onclick: async () => {
          dryResult.textContent = "проверяю…";
          try {
            const r = await window.api.dryRunPlace(b.id, stakeBox.value.trim() || "10");
            dryResult.textContent = r.ok ? "🧪 вписал сумму: " + r.stakeValue + " · кнопка ставки: " + (r.placeBtn || "НЕ найдена") : "⚠️ " + r.error;
          } catch (e) { dryResult.textContent = "⚠️ " + e.message; }
        } }),
      ]),
      dryResult,
    ]);

    const card = el("div", { className: "booker" }, [
      head,
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
$("test").onclick = async () => {
  $("saveHint").textContent = "отправляю тест…";
  const r = await window.api.testTelegram();
  $("saveHint").textContent = r.ok ? "✅ тест отправлен — проверь Telegram" : "⚠️ " + r.error;
};
$("save").onclick = async () => {
  const patch = {
    tgToken: $("tgToken").value.trim(),
    tgChat: $("tgChat").value.trim(),
    tgApiBase: $("tgApiBase").value.trim() || "https://api.telegram.org",
    proxy: $("proxy").value.trim(),
    pollMs: Math.max(3, Number($("pollSec").value) || 8) * 1000,
    keyword: $("keyword").value.trim().toLowerCase() || "pinnacle",
  };
  await window.api.saveSettings(patch);
  $("tgToken").value = "";
  $("saveHint").textContent = "✅ сохранено";
  refresh();
};

refresh();
setInterval(refresh, 5000);
