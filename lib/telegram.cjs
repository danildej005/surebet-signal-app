"use strict";
// Отправка сообщений в Telegram (нативный fetch, есть в Electron/Node 18+).

async function sendTelegram(token, chatId, text, { timeoutMs = 10000 } = {}) {
  if (!token || !chatId) return { ok: false, error: "не заданы токен/chat_id" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) return { ok: false, error: j.description || `HTTP ${res.status}` };
    return { ok: true, messageId: j.result && j.result.message_id };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "таймаут" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendTelegram };
