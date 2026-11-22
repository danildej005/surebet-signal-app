"use strict";
// ПРЕМАТЧ: HTTP-клиент фида bettingco (docs/PREMATCH-HANDBOOK.md, 2.1 и 2.4).
// Прематч или лайв определяется КЛЮЧОМ, а не параметром. Ключ — секрет: только аргументом, на диск не пишем.
// Возврат всегда { status, data, error } — коды разбирает движок (engine.cjs):
//   200 изменения · 204 изменений нет · 400 SessionId mismatch → полная перезагрузка ·
//   401 ключ истёк → остановиться · 429 один ключ опрашивают два клиента → оставить одного.
const https = require("https");
const HOST = "apiparsers.bettingco.pro";

function get(path, key, opts = {}) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: opts.host || HOST, path, headers: { "X-Api-Key": key, Accept: "application/json" }, timeout: opts.timeoutMs || 60000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode, body = Buffer.concat(chunks).toString("utf8");
          if (status === 204 || (status === 200 && !body)) return resolve({ status: 204, data: null });
          if (status !== 200) return resolve({ status, data: null, error: body.slice(0, 200) });
          try { resolve({ status: 200, data: JSON.parse(body) }); }
          catch (e) { resolve({ status: 0, data: null, error: "не JSON: " + body.slice(0, 120) }); }
        });
        res.on("error", (e) => resolve({ status: 0, data: null, error: e.message }));
      });
    req.on("timeout", () => req.destroy(new Error("таймаут")));
    req.on("error", (e) => resolve({ status: 0, data: null, error: e.message }));
  });
}

// Полное состояние плюс накопленные изменения. Не чаще 1 раза в 5 секунд, ответ 30–110 МБ.
const getData = (book, key, opts) => get("/GameData/GetBookmakerData?bookmakerType=" + encodeURIComponent(book), key, { timeoutMs: 90000, ...opts });

// Изменения после lastSnapshotTime в сессии sessionId. Не чаще 500 мс.
const getSnapshots = (book, key, sessionGuid, cursor, opts) => get(
  "/GameData/GetBookmakerSnapshots?bookmakerType=" + encodeURIComponent(book) +
  "&SessionId=" + encodeURIComponent(sessionGuid) + "&lastSnapshotTime=" + encodeURIComponent(cursor), key, { timeoutMs: 30000, ...opts });

// Фид, привязанный к ключу: { getData(book), getSnapshots(book, guid, cursor) } — такой объект ждёт движок.
// Полная загрузка ограничена поставщиком: не чаще 1 раза в 5 секунд на ключ. Движок опрашивает конторы чаще, поэтому
// паузу между полными загрузками держим здесь.
const DATA_GAP_MS = 5200;
const makeFeed = (key, opts) => {
  let lastData = 0;
  return {
    getData: async (book) => {
      const wait = DATA_GAP_MS - (Date.now() - lastData);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastData = Date.now();
      return getData(book, key, opts);
    },
    getSnapshots: (book, guid, cursor) => getSnapshots(book, key, guid, cursor, opts),
  };
};

module.exports = { getData, getSnapshots, makeFeed };
