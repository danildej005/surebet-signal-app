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

async function renderBookers() {
  bookersCache = await window.api.getBookers();
  const root = $("bookers");
  root.innerHTML = "";
  bookersCache.forEach((b) => {
    b.fp = b.fp || {};
    const head = el("div", { className: "row" }, [
      el("b", { textContent: b.name || b.id }),
      el("button", { textContent: "Войти", onclick: async () => { await window.api.saveBookers(bookersCache); await window.api.openBooker(b.id); } }),
    ]);
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

    const card = el("div", { className: "booker" }, [
      head,
      field("Адрес для входа (главная конторы)", b.url || "", (v) => (b.url = v)),
      field("Прокси (host:port[:user:pass])", b.proxy || "", (v) => (b.proxy = v)),
      checkRow("Открывать при старте (войти заранее)", b.autoOpen, (v) => (b.autoOpen = v)),
      det,
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
