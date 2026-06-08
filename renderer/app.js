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
$("openBetano").onclick = () => window.api.openBooker("https://www.betano.pt/");
$("openPinnacle").onclick = () => window.api.openBooker("https://www.pinnacle.com/");
$("openBooker").onclick = () => { const u = $("bookerUrl").value.trim(); if (u) window.api.openBooker(u.includes("://") ? u : "https://" + u); };
$("captureBooker").onclick = async () => {
  $("saveHint").textContent = "снимаю разметку купона…";
  const r = await window.api.captureBooker();
  $("saveHint").textContent = r.ok ? "✅ снято: " + r.file : "⚠️ " + r.error;
};
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
