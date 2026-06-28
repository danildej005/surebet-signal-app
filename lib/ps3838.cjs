"use strict";
// Клиент ps3838 (= Pinnacle, та же контора/кэфы) как АЛЬТЕРНАТИВНЫЙ эталон вместо oddspapi-Pinnacle
// (не ждём поддержку + запасной источник). ТОЛЬКО ЧТЕНИЕ кэфов — никаких ставок/баланса/вывода.
// Basic-auth; eventId ps3838 == pinnacleId в oddspapi → матч точный. Тесты в test/ps3838.test.cjs.
const https = require("https");
const { devigProportional, devigPower } = require("./value.cjs");

const HOST = "api.ps3838.com";

// READ-ONLY GET (Basic auth "user:pass"). Дёргаем ТОЛЬКО /v3/sports|fixtures|odds.
function getJson(path, auth) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: HOST, path, auth, headers: { Accept: "application/json" }, timeout: 30000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("ps3838 не JSON (" + res.statusCode + "): " + b.slice(0, 150))); } });
    });
    req.on("timeout", () => req.destroy(new Error("ps3838 таймаут " + path)));
    req.on("error", reject);
  });
}
const sports = (auth) => getJson("/v3/sports", auth);
const fixtures = (sportId, auth) => getJson("/v3/fixtures?sportId=" + sportId, auth);
const odds = (sportId, auth) => getJson("/v3/odds?sportId=" + sportId + "&oddsFormat=Decimal", auth);

// PURE: odds-ответ ps3838 → Map(eventId(строка) → ЧЕСТНЫЕ вероятности рынков ПОЛНОГО матча (period.number=0)):
//   { ml:{home,draw?,away}, tot:{"8.5":{over,under},…}, ah:{"-1.5":{home,away},…} }  (де-виг method).
function fairByEvent(oddsJson, method = "proportional") {
  const devig = method === "power" ? devigPower : devigProportional;
  const m = new Map();
  for (const lg of (oddsJson && oddsJson.leagues) || []) {
    for (const ev of lg.events || []) {
      const p0 = (ev.periods || []).find((p) => p.number === 0);
      if (!p0) continue;
      const out = { ml: null, tot: {}, ah: {} };
      const ml = p0.moneyline;
      if (ml && ml.home > 1 && ml.away > 1) {
        if (ml.draw > 1) { const [h, d, a] = devig([ml.home, ml.draw, ml.away]); out.ml = { home: h, draw: d, away: a }; }
        else { const [h, a] = devig([ml.home, ml.away]); out.ml = { home: h, away: a }; }
      }
      for (const t of p0.totals || []) if (t.over > 1 && t.under > 1) { const [o, u] = devig([t.over, t.under]); out.tot[String(t.points)] = { over: o, under: u }; }
      for (const s of p0.spreads || []) if (s.home > 1 && s.away > 1) { const [h, a] = devig([s.home, s.away]); out.ah[String(s.hdp)] = { home: h, away: a }; }
      m.set(String(ev.id), out);
    }
  }
  return m;
}

module.exports = { HOST, getJson, sports, fixtures, odds, fairByEvent };
