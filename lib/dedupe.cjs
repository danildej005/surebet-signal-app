"use strict";
// Антиспам: одну и ту же вилку не шлём чаще, чем раз в ttlMs. Хранит id→timestamp,
// опционально пишет в файл (переживает перезапуск).
const { readFileSync, writeFileSync } = require("node:fs");

function makeDeduper({ ttlMs = 10 * 60 * 1000, file = null, now = () => Date.now() } = {}) {
  let seen = new Map();

  if (file) {
    try {
      const obj = JSON.parse(readFileSync(file, "utf8"));
      for (const [id, ts] of Object.entries(obj)) seen.set(id, Number(ts));
    } catch { /* первый запуск */ }
  }

  const prune = () => {
    const t = now();
    for (const [id, ts] of seen) if (t - ts > ttlMs) seen.delete(id);
  };
  const persist = () => {
    if (!file) return;
    try { writeFileSync(file, JSON.stringify(Object.fromEntries(seen))); } catch { /* не критично */ }
  };

  return {
    shouldSend(id) {
      prune();
      const ts = seen.get(id);
      return ts === undefined || now() - ts > ttlMs;
    },
    markSent(id) { seen.set(id, now()); persist(); },
    size() { return seen.size; },
  };
}

module.exports = { makeDeduper };
