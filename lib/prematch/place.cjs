"use strict";
// ПРЕМАТЧ: из найденных вилок выбрать, какую пробовать на странице Betano, и собрать кандидата в том виде,
// который понимает существующая простановка (runValueCycle / placeBet / судьи). Чистая логика, покрыта тестами.
// НИЧЕГО не кликает. Простановку прематча приложение пока запускает только в dry-run.
const { parseKey, describeKey, fmtLine } = require("./markets.cjs");
const { arbOf } = require("./arb.cjs");

// PURE: единый ключ исхода → поля старого формата сигнала (st / kind / param / side), по которым работают судьи.
//   ML, TOTAL, SPREAD — рынки, которые судьи уже знают (проверены на теннисе в лайве).
//   X (ничья), DNB (фора 0), DC (двойной шанс), TT (тотал команды) — судьи их пока не знают и пропускают;
//   dry-run нужен как раз затем, чтобы собрать ярлыки купона этих рынков.
function legacyOf(key) {
  const k = parseKey(key);
  const st = k.period === "FT" ? "/Main/Main" : k.period === "1H" ? "/Time/Main/1" : k.period === "2H" ? "/Time/Main/2" : k.period;
  const A = k.side === "h" || k.side === "o" || k.side === "1x" || k.side === "y";
  const side = A ? "A" : "B";
  if (k.family === "ml") return { st, kind: "ML", param: "", side };
  if (k.family === "x") return k.side === "d" ? { st, kind: "X", param: "", side: "X" } : { st, kind: "ML", param: "", side };
  if (k.family === "tot") return { st, kind: "TOTAL", param: fmtLine(k.line), side };
  if (k.family === "hc") return { st, kind: "SPREAD", param: fmtLine(k.line), side };     // линия со стороны первой команды
  if (k.family === "dnb") return { st, kind: "DNB", param: "", side };
  if (k.family === "dc") return { st, kind: "DC", param: k.side, side: k.side.toUpperCase() };
  if (k.family === "tt1" || k.family === "tt2") return { st, kind: "TT", param: fmtLine(k.line), side: (k.family === "tt1" ? "1" : "2") + (k.side === "o" ? "O" : "U") };
  return { st, kind: String(k.family).toUpperCase(), param: fmtLine(k.line), side };
}

// Знают ли судьи этот рынок (тогда их вердикт что-то значит; иначе dry-run только собирает ярлык купона).
const KNOWN_KINDS = new Set(["ML", "TOTAL", "SPREAD"]);

// PURE: вилка из engine.scan() → кандидат для runValueCycle.
//   stake — сумма; minArb — порог вилки (доля): по нему на странице считается «вилка ещё есть при цене кнопки».
function arbToCandidate(a, stake, minArb) {
  const L = legacyOf(a.key);
  const A = L.side === "A";
  // описание для судей и логов — в нотации, которую понимает старый выбор исхода (для известных рынков)
  let desc, subject = "";
  if (L.kind === "ML") { desc = A ? "1" : "2"; subject = A ? a.t1 : a.t2; }
  else if (L.kind === "TOTAL") desc = (A ? "Over " : "Under ") + L.param;
  else if (L.kind === "SPREAD") { const ln = A ? Number(L.param) : -Number(L.param); desc = "AH" + (A ? "1" : "2") + "(" + (ln >= 0 ? "+" : "") + fmtLine(ln) + ")"; subject = A ? a.t1 : a.t2; }
  else desc = a.what || describeKey(a.key, a.t1, a.t2);
  const unit = Number(a.sportType) === 3 && (L.kind === "TOTAL" || L.kind === "SPREAD") ? (L.st === "/Main/Main/Game" ? "геймы" : "сеты") : null;
  const descFull = (desc + (subject ? " " + subject : "") + (unit ? " - " + unit : "")).trim();
  const market = L.st + " " + L.kind + (L.param !== "" ? " " + L.param : "");
  return {
    url: a.link, desc, subject, descFull, expectedOdds: a.price, stake: Number(stake) || 0, outcomeId: "",
    key: a.pairId + "|" + a.key, t1: a.t1, t2: a.t2, market, side: L.side, kind: L.kind, param: L.param, st: L.st,
    sportType: a.sportType, value: a.arb, arbPct: a.arb, betanoSelId: a.selId || "",
    // прематч: гейт на странице — «вилка при цене кнопки ещё не меньше порога» (см. arbAtPrice)
    prematch: true, arbKey: a.key, pairId: a.pairId, what: a.what, arbOpp: a.opp, arbMin: Number(minArb) || 0,
    judged: KNOWN_KINDS.has(L.kind), identity: a.identity || null, pairCheck: a.pairCheck || null, mins: a.mins,
  };
}

// PURE: размер вилки при цене, которую показывает страница Betano.
const arbAtPrice = (price, opp) => arbOf(price, opp);

// Группы исходов для галочек в панели: win победа · draw ничья · dc двойной шанс · dnb фора 0 · hc фора · tot тотал ·
// tt тотал команды/игрока. Список и подписи — OUTCOME_GROUPS (его же рисует панель).
const OUTCOME_GROUPS = [["win", "Победа"], ["draw", "Ничья"], ["dc", "Двойной шанс"], ["dnb", "Фора 0"], ["hc", "Фора"], ["tot", "Тотал"], ["tt", "Тотал команды или игрока"]];
function outcomeGroup(key) {
  const k = parseKey(key);
  if (k.family === "ml") return "win";
  if (k.family === "x") return k.side === "d" ? "draw" : "win";
  if (k.family === "tt1" || k.family === "tt2") return "tt";
  return k.family; // dc, dnb, hc, tot (btts/odd вилок не дают — у Pinnacle таких рынков нет)
}
// Отрезок: весь матч или его часть (тайм, половина, четверть, период, сет, карта).
const FULL_PERIODS = new Set(["FT", "/Main/Main", "/Main/Main/Game", "/Main/Main/Overtime"]);
const isFullMatch = (key) => FULL_PERIODS.has(parseKey(key).period);

// PURE: выбрать одну вилку для попытки. arbs — engine.scan(); cfg — { minArb, maxArb, sports, outcomes, full, parts,
// oddsMin, oddsMax, minToStartMin, onlyConfirmed, maxPerPair }; пустой список sports / outcomes = все;
// state — { tried: Set ключей «пара|исход», perPair: Map пара → число попыток }. Возврат { arb } или { skip: причина }.
function choosePrematch(arbs, cfg = {}, state = {}) {
  const tried = state.tried || new Set(), perPair = state.perPair || new Map();
  const minArb = Number(cfg.minArb) || 0, maxArb = Number(cfg.maxArb) || 0, maxPerPair = cfg.maxPerPair != null ? cfg.maxPerPair : 2;
  const sports = cfg.sports && cfg.sports.length ? new Set(cfg.sports.map(Number)) : null;
  const outcomes = cfg.outcomes && cfg.outcomes.length ? new Set(cfg.outcomes) : null;
  const full = cfg.full !== false, parts = cfg.parts !== false;
  const why = {};
  const no = (r) => { why[r] = (why[r] || 0) + 1; return false; };
  const ok = (a) => {
    if (!a.link || !a.selId) return no("нет ссылки или id кнопки");
    if (!(a.arb >= minArb)) return no("вилка меньше порога");
    if (maxArb && a.arb > maxArb) return no("вилка больше потолка");
    if (sports && !sports.has(Number(a.sportType))) return no("вид спорта выключен");
    if (outcomes && !outcomes.has(outcomeGroup(a.key))) return no("исход выключен");
    if (!(isFullMatch(a.key) ? full : parts)) return no("отрезок выключен");
    if (a.flick) return no("матч мигает");
    if (a.identity === "mismatch") return no("не тот матч");
    if (cfg.onlyConfirmed && a.identity !== "confirmed") return no("матч не подтверждён");
    if (cfg.minToStartMin != null && !(a.mins >= cfg.minToStartMin)) return no("до старта мало времени");
    if (cfg.oddsMin && a.price < cfg.oddsMin) return no("цена ниже границы");
    if (cfg.oddsMax && a.price > cfg.oddsMax) return no("цена выше границы");
    if (tried.has(a.pairId + "|" + a.key)) return no("уже пробовали");
    if (maxPerPair && (perPair.get(a.pairId) || 0) >= maxPerPair) return no("лимит попыток на матч");
    return true;
  };
  const cand = (arbs || []).filter(ok).sort((x, y) => y.arb - x.arb)[0];
  if (!cand) return { skip: Object.keys(why).length ? Object.entries(why).map(([k, v]) => k + " ×" + v).join(", ") : "вилок нет" };
  return { arb: cand };
}

module.exports = { legacyOf, arbToCandidate, arbAtPrice, choosePrematch, KNOWN_KINDS, OUTCOME_GROUPS, outcomeGroup, isFullMatch };
