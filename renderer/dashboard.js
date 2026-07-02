"use strict";
// Дашборд: живой лог (стрим из main по каналу "log") + статус value (value-pulse). CSP: только self.
const $ = (id) => document.getElementById(id);
const logEl = $("log");
let count = 0;
const MAX = 800; // держим не больше N строк в DOM

function cls(line) {
  if (/\[value\]|VALUE|🎯/.test(line)) return "v";
  if (/\bERROR\b|\bFATAL\b|🔴/.test(line)) return "e";
  if (/\bWARN\b|⚠️/.test(line)) return "w";
  return "";
}
function append(line) {
  const div = document.createElement("div");
  const c = cls(line);
  if (c) div.className = c;
  div.textContent = String(line).replace(/\n$/, "");
  logEl.append(div);
  count++;
  while (logEl.childElementCount > MAX) logEl.removeChild(logEl.firstChild);
  if ($("autoscroll").checked) logEl.scrollTop = logEl.scrollHeight;
  $("lines").textContent = count + " строк";
}
if (window.api.onLog) window.api.onLog(append);

if (window.api.onValuePulse) window.api.onValuePulse((p) => {
  const el = $("valuePulse"); if (!el || !p) return;
  const t = new Date(p.at || Date.now()).toLocaleTimeString();
  let s, color;
  if (!p.on) { color = "#7f8c8d"; s = "🎯 value: выключен"; }
  else if (p.error) { color = "#c0392b"; s = "🔴 ОШИБКА: " + p.error; }
  else if (p.scanning) { color = "#2980b9"; s = "⚙️ сканирую кэфы…"; }
  else {
    color = p.live ? "#1a9e4b" : "#e67e22";
    s = "value " + (p.live ? "⚡БОЕВОЙ" : "детект") + " · сейчас на доске " + (p.candidates != null ? p.candidates : 0) +
      (p.top != null ? " (топ +" + (p.top * 100).toFixed(1) + "%)" : "") +
      (p.ageMs != null ? " · возраст плеч " + p.ageMs + "мс" : "") + (p.note ? " · " + p.note : "");
    // сессионная статистика (накопительно за сессию)
    s += "\nСЕССИЯ: задетектировано " + (p.sessDetected || 0) + " · проставлено " + (p.sessPlaced || 0) +
      (p.sessDetected ? " · средний +" + ((p.sessAvg || 0) * 100).toFixed(1) + "% · ср. жизнь " + (p.sessLife || 0).toFixed(0) + "с" : "");
    if (p.lastBet) s += "\nтоп сейчас: " + p.lastBet;
  }
  el.style.color = color;
  el.style.whiteSpace = "pre-wrap";
  el.textContent = "value " + t + ": " + s;
});

$("clear").onclick = () => { logEl.innerHTML = ""; count = 0; $("lines").textContent = ""; };
if ($("openLogs")) $("openLogs").onclick = () => window.api.openLogs();
