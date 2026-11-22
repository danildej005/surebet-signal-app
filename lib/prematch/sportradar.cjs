"use strict";
// ПРЕМАТЧ: медленная проверка «тот ли это матч» по номеру Sportradar.
// У игры Betano в фиде поле extId — номер матча Sportradar (заполнен у ~92% игр; теннис ~39%, киберспорт — нет).
// По номеру открытый справочник отдаёт каноническое название команд, страну турнира и точное время старта.
// Сверяем их с игрой Pinnacle — это независимое от цен подтверждение, что обе конторы говорят про один матч.
//
// ВАЖНО: справочник — служебный адрес виджетов статистики Sportradar, а не документированный API. Условий и
// лимитов не знаем. Поэтому ходим редко: только по матчам, где найдена вилка, один запрос на матч, с кэшем.
const https = require("https");
const { parseGame, pairScore, sim, TENNIS, TOL_SEC, TOL_TENNIS_SEC } = require("./names.cjs");

const HOST = "stats.fn.sportradar.com";

// Запрос карточки матча. Возврат { home, away, country, tournament, start, score, periods } или null.
function fetchMatch(extId, opts = {}) {
  return new Promise((resolve) => {
    const req = https.get({ host: opts.host || HOST, path: "/common/en/Etc:UTC/gismo/match_info/" + encodeURIComponent(extId),
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, timeout: opts.timeoutMs || 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve(parseMatchInfo(JSON.parse(Buffer.concat(chunks).toString("utf8")))); } catch { resolve(null); } });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// PURE: ответ справочника → короткая карточка матча (или null, если матча в ответе нет).
function parseMatchInfo(json) {
  const d = json && json.doc && json.doc[0] && json.doc[0].data;
  const m = d && d.match;
  if (!m || !m.teams) return null;
  const cat = d.realcategory || d.category || {};
  return {
    home: (m.teams.home || {}).name || "", away: (m.teams.away || {}).name || "",
    country: cat.name || "", tournament: (d.tournament || {}).name || "",
    start: Number((m._dt || {}).uts) || 0,
    score: m.result && m.result.home != null ? [Number(m.result.home), Number(m.result.away)] : null,
    periods: m.periods || null,
  };
}

// PURE: страна из названия лиги Pinnacle («Spain - Segunda Federacion» → «spain»); нет « - » → null.
function pinnacleCountry(league) {
  const s = String(league || "");
  const i = s.indexOf(" - ");
  return i > 0 ? s.slice(0, i).trim().toLowerCase() : null;
}

// PURE: сверка карточки Sportradar (матч Betano) с игрой Pinnacle. sportType — вид спорта пары.
// Возврат { status, why }:
//   confirmed — названия Sportradar сходятся с Pinnacle по строгим правилам, ИЛИ совпали время и страна;
//   mismatch  — время старта расходится, либо страна другая и названия не сходятся;
//   unknown   — данных для вывода мало (страны у Pinnacle нет, названия пишутся по-разному).
function identityCheck(sr, pinGame, sportType) {
  if (!sr || !sr.start) return { status: "unknown", why: "справочник не ответил" };
  const sport = Number(sportType);
  const tol = sport === TENNIS ? TOL_TENNIS_SEC : TOL_SEC;
  const dt = Math.abs(sr.start - Number(pinGame.startTimeStamp));
  const timeOk = dt <= tol;
  const srGame = parseGame({ textId: "sr", sportType: sport, startTimeStamp: sr.start,
    leagueName: sr.country + " " + sr.tournament, team1NameEn: sr.home, team2NameEn: sr.away });
  const pin = parseGame(pinGame);
  const names = pairScore(srGame, pin);                                  // те же строгие правила, что при склейке
  const pc = pinnacleCountry(pinGame.leagueName), sc = String(sr.country || "").trim().toLowerCase();
  const countryEq = pc && sc ? pc === sc : null;
  const flagsOk = srGame.h.women === pin.h.women && (srGame.h.age === pin.h.age || !srGame.h.age || !pin.h.age);
  const mins = Math.round(dt / 60);
  if (names) return { status: "confirmed", why: "названия и время совпали" };
  if (!timeOk) return { status: "mismatch", why: "время старта расходится на " + mins + " мин" };
  if (countryEq === true && flagsOk) {
    // страна и время совпали, названия пишутся по-разному («Aalborg» и «AaB») — хватает одного совпавшего названия
    const one = Math.max(sim(srGame.h.tokens, pin.h.tokens), sim(srGame.a.tokens, pin.a.tokens),
      sim(srGame.h.tokens, pin.a.tokens), sim(srGame.a.tokens, pin.h.tokens));
    if (one >= 1) return { status: "confirmed", why: "страна и время совпали, одна команда названа одинаково" };
    return { status: "unknown", why: "страна и время совпали, названия разные" };
  }
  if (countryEq === false) return { status: "mismatch", why: "страна другая: " + sr.country + " / " + pc };
  return { status: "unknown", why: "названия разные, страны у Pinnacle нет" };
}

// Справочник с кэшем: один запрос на матч. fetchImpl подменяется в тестах.
function makeDirectory(opts = {}) {
  const cache = new Map(), fetchImpl = opts.fetch || fetchMatch, ttl = opts.ttlMs || 6 * 3600 * 1000, now = opts.now || (() => Date.now());
  return {
    cache,
    async get(extId) {
      const hit = cache.get(extId);
      if (hit && now() - hit.at < ttl) return hit.data;
      const data = await fetchImpl(extId, opts);
      if (data) cache.set(extId, { at: now(), data });                   // неудачу не кэшируем — повторим позже
      return data;
    },
  };
}

module.exports = { fetchMatch, parseMatchInfo, pinnacleCountry, identityCheck, makeDirectory };
