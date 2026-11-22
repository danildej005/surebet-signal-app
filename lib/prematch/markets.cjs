"use strict";
// ПРЕМАТЧ: приведение рынков обеих контор к ЕДИНОМУ КЛЮЧУ ИСХОДА (docs/PREMATCH-HANDBOOK.md, раздел 4).
//   ключ = «период|семейство|линия|сторона», напр. FT|tot|2.5|o · 2H|x|0|a · 1H|dc|0|x2 · FT|hc|0.5|a
// Чистая логика, покрыта test/prematch.test.cjs.
//
// ФУТБОЛ — правила хендбука дословно (classify_pinnacle / classify_betano, проверены на записи 16–19.11.2026):
//   период: marketType 0 → FT; marketType 3 + marketMeta '1' → 1H; marketType 3 + marketMeta '2' → 2H (только Betano).
// ОСТАЛЬНЫЕ ВИДЫ СПОРТА — в хендбуке их нет; правило выведено из дампа фида 19.11.2026 и записью НЕ проверено:
//   период = surebetTextId фида («/Main/Main/Game», «/Main/Main/Overtime», «/Map/Main/1»…) — он нормализован
//   поставщиком и одинаков у обеих контор, поэтому сегменты (геймы/сеты/с овертаймом/карта) не смешиваются.
//
// Семейства: x исход (с ничьей) · ml победа без ничьей (только не-футбол Betano) · dc двойной шанс · dnb фора 0 ·
//   tot тотал · tt1/tt2 тоталы команд · hc фора (линия в терминах ХОЗЯЕВ) · btts обе забьют · odd чёт/нечет.
// Стороны: h a d · 1x x2 12 · o u · y n · o e.

// Коды surebetType фида → [семейство, сторона].
const SB = {
  0: ["x", "h"], 1: ["x", "a"], 2: ["x", "d"],
  3: ["dc", "1x"], 4: ["dc", "x2"], 5: ["dc", "12"],
  6: ["tt1", "o"], 7: ["tt1", "u"], 8: ["tt2", "o"], 9: ["tt2", "u"],
  10: ["tot", "o"], 11: ["tot", "u"],
  12: ["odd", "o"], 13: ["odd", "e"],
  15: ["hc", "h"], 16: ["hc", "a"],
  17: ["btts", "y"], 18: ["btts", "n"],
};

const isFootball = (game) => !!game && /\/Football\//.test(String(game.textId || ""));
const fmtLine = (n) => { const v = Number(n); return String(v === 0 ? 0 : v); }; // −0 → «0»
const mkKey = (period, family, line, side) => period + "|" + family + "|" + fmtLine(line) + "|" + side;
const emptyParam = (p) => p == null || p === "";
const numParam = (p) => (emptyParam(p) || !Number.isFinite(Number(p))) ? null : Number(p);

function parseKey(key) {
  const p = String(key).split("|");
  return { period: p[0], family: p[1], line: Number(p[2]), side: p[3] };
}

// Период футбольного рынка (хендбук 4.1). allow2H — только для Betano.
function footballPeriod(m, allow2H) {
  if (m.marketType === 0) return "FT";
  if (m.marketType === 3 && String(m.marketMeta) === "1") return "1H";
  if (m.marketType === 3 && String(m.marketMeta) === "2") return allow2H ? "2H" : null;
  return null;
}

// PURE: рынок Pinnacle → { period, family, line, side, key } или null.
function classifyPinnacle(m, game) {
  if (!m || !game) return null;
  if (m.subMarketType !== 0 || m.specialKind !== 0) return null;
  const football = isFootball(game);
  // ФУТБОЛ: meta обязан начинаться с «<compareEventId>|». Угловые и карточки висят на той же игре с теми же
  // типами, но с другим id в начале meta; без проверки тоталы угловых попадают в лесенку тоталов голов.
  // НЕ-ФУТБОЛ: проверку НЕ применяем — там период берётся из surebetTextId, и «чужие» рынки уже разведены
  // самим фидом по сегментам (теннис: рынки по геймам идут под другим id, но в своём сегменте «/Main/Main/Game»;
  // с проверкой все теннисные тоталы и форы по геймам терялись — замер на дампе 19.11.2026).
  if (football && (!game.compareEventId || !String(m.meta || "").startsWith(game.compareEventId + "|"))) return null;
  const sb = SB[m.surebetType]; if (!sb) return null;
  const [family, side] = sb;
  const period = football ? footballPeriod(m, false) : (m.surebetTextId || null);
  if (!period) return null;
  if (!(Number(m.marketValue) > 1)) return null;
  let line = 0;
  if (family === "x") { if (!emptyParam(m.marketParameter)) return null; }      // исход — только при пустом параметре
  else if (family === "tot" || family === "tt1" || family === "tt2") { line = numParam(m.marketParameter); if (line == null) return null; }
  else if (family === "hc") {                                                    // линия в терминах хозяев
    const v = numParam(m.marketParameter); if (v == null) return null;
    line = side === "h" ? v : -v;
  } else return null;                                                            // dc/btts/odd у Pinnacle нет
  return { period, family, line: Number(fmtLine(line)), side, key: mkKey(period, family, line, side) };
}

// Betano, футбол: всё, что не про голы (хендбук 4.3).
const NOT_GOALS = /corner|card|booking|offside|shot|foul|penalt|throw|goal kick|player|scorer|minute|next|race|interval/i;
const HALF_WORDS = /Half|Second|2nd|1st/;
const BTTS_RE = /^Both Teams to Score( in (First|Second) Half)? \|/;

function classifyBetanoFootball(m) {
  const meta = String(m.meta || "");
  if (NOT_GOALS.test(meta)) return null;
  const period = footballPeriod(m, true); if (!period) return null;
  if (period === "FT" && HALF_WORDS.test(meta)) return null;       // рынки таймов с неправильным типом
  const sb = SB[m.surebetType]; if (!sb) return null;
  let [family, side] = sb, line = 0;
  if (m.specialKind === 200) {                                     // фора 0 (Draw No Bet)
    if (m.surebetType !== 0 && m.surebetType !== 1) return null;
    family = "dnb";
  } else if (m.specialKind !== 0) return null;                     // прочие specialKind (3 = угловые и т. п.) — мимо
  else if (family === "x") { if (!/Result/.test(meta)) return null; }
  else if (family === "dc") { if (!/Double Chance/.test(meta)) return null; }
  else if (family === "tot" || family === "tt1" || family === "tt2") {
    if (!/Goals/.test(meta)) return null;
    line = numParam(m.marketParameter); if (line == null) return null;
  } else if (family === "btts") { if (!BTTS_RE.test(meta)) return null; }
  else if (family === "odd") { if (period !== "FT" || !/Total Goals Odd\/Even/.test(meta)) return null; }
  else return null;                                                // фор у Betano в футболе нет (не проверено → не берём)
  return { period, family, line: Number(fmtLine(line)), side, key: mkKey(period, family, line, side) };
}

// Betano, не-футбол (правило из дампа 19.11, записью не проверено). Название рынка = часть meta до «|».
function classifyBetanoOther(m) {
  const period = m.surebetTextId; if (!period) return null;
  const head = String(m.meta || "").split("|")[0];
  const sb = SB[m.surebetType]; if (!sb) return null;
  let [family, side] = sb, line = 0;
  if (m.specialKind === 200) {
    if (m.surebetType !== 0 && m.surebetType !== 1) return null;
    family = "dnb";
  } else if (m.specialKind !== 0) return null;                     // напр. «3-way Total Runs» (specialKind 3)
  else if (family === "x") {
    // В одном сегменте у Betano бывают И «… Result» (3 исхода), И «… Winner» (2 исхода) с теми же кодами.
    if (/result/i.test(head)) { if (!emptyParam(m.marketParameter)) return null; }   // с параметром = евро-гандикап
    else if (/winner/i.test(head) && side !== "d") family = "ml";
    else return null;                                              // «First Blood» и прочее — не исход матча/сегмента
  } else if (family === "dc") { if (!/double chance/i.test(head)) return null; }
  else if (family === "tot" || family === "tt1" || family === "tt2") {
    if (/3.?way/i.test(head)) return null;
    line = numParam(m.marketParameter); if (line == null) return null;
  } else if (family === "hc") {
    // только азиатская фора: евро-гандикап («Handicap Match Result», 3 исхода) даёт ложную вилку
    if (!/handicap/i.test(head) || /result|3.?way|european/i.test(head)) return null;
    const v = numParam(m.marketParameter); if (v == null) return null;
    line = side === "h" ? v : -v;                                  // у стороны гостей параметр — её собственная линия
  } else if (family === "odd") { /* берём как есть: пары в Pinnacle нет, вилки не будет */ }
  else return null;                                                // btts вне футбола — это «Extra Innings — Yes/No» и т. п.
  return { period, family, line: Number(fmtLine(line)), side, key: mkKey(period, family, line, side) };
}

// PURE: рынок Betano → { period, family, line, side, key } или null.
function classifyBetano(m, game) {
  if (!m || !game) return null;
  if (m.subMarketType !== 0) return null;
  if (!(Number(m.marketValue) > 0)) return null;
  return isFootball(game) ? classifyBetanoFootball(m) : classifyBetanoOther(m);
}

// PURE: ключ в «перевёрнутом» порядке команд (пара, где Pinnacle перечислил команды наоборот).
function flipKey(key) {
  const k = parseKey(key);
  const swap = { h: "a", a: "h", "1x": "x2", x2: "1x" };
  if (k.family === "x" || k.family === "ml" || k.family === "dnb" || k.family === "dc") return mkKey(k.period, k.family, k.line, swap[k.side] || k.side);
  if (k.family === "tt1") return mkKey(k.period, "tt2", k.line, k.side);
  if (k.family === "tt2") return mkKey(k.period, "tt1", k.line, k.side);
  if (k.family === "hc") return mkKey(k.period, "hc", -k.line, swap[k.side] || k.side);
  return key;
}

// Человекочитаемое описание ключа для логов.
function describeKey(key, t1, t2) {
  const k = parseKey(key);
  const per = k.period === "FT" ? "матч" : k.period === "1H" ? "1-й тайм" : k.period === "2H" ? "2-й тайм" : k.period;
  const sgn = (v) => (v > 0 ? "+" : "") + fmtLine(v);
  let what;
  if (k.family === "x" || k.family === "ml") what = k.side === "h" ? "победа " + t1 : k.side === "a" ? "победа " + t2 : "ничья";
  else if (k.family === "dnb") what = "фора 0 " + (k.side === "h" ? t1 : t2);
  else if (k.family === "dc") what = "двойной шанс " + k.side.toUpperCase();
  else if (k.family === "tot") what = "тотал " + (k.side === "o" ? "больше " : "меньше ") + fmtLine(k.line);
  else if (k.family === "tt1" || k.family === "tt2") what = "тотал " + (k.family === "tt1" ? t1 : t2) + (k.side === "o" ? " больше " : " меньше ") + fmtLine(k.line);
  else if (k.family === "hc") what = "фора " + (k.side === "h" ? t1 + " " + sgn(k.line) : t2 + " " + sgn(-k.line));
  else if (k.family === "btts") what = "обе забьют: " + (k.side === "y" ? "да" : "нет");
  else if (k.family === "odd") what = k.side === "o" ? "нечет" : "чёт";
  else what = k.family + " " + k.side;
  return per + " · " + what;
}

module.exports = { SB, isFootball, fmtLine, mkKey, parseKey, classifyPinnacle, classifyBetano, flipKey, describeKey };
