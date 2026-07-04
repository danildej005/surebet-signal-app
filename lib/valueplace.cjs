"use strict";
// Ставочная часть — ЧИСТАЯ логика: из value-сигналов выбрать, ЧТО ставить, и собрать кандидата для исполнения.
// НИЧЕГО не кликает и не трогает детект/бэктест — только решает. Исполнение (Octo-клик) — в main.cjs за флагом
// `valuePlace` (по умолчанию ВЫКЛ), dry-run пока `valueLive` не включён. Кандидат синтезирует desc/subject в нотации,
// которую понимает classifyDesc/pickOutcome (переиспуем ПРОВЕРЕННЫЙ выбор исхода Betano), а НЕ дублирует его.

// Ключ уникальности исхода (тот же, что в сессионной стате) — для дедупа «уже ставили».
const sigKey = (s) => s.t1 + "~" + s.t2 + "|" + s.market + "|" + s.side;

// desc/subject/unit для Betano-выбора из СТРУКТУРНОГО сигнала (kind, ЗНАКОВЫЙ param, side A/B).
// ML:   side A→«1», B→«2» (subject=команда).
// TOTAL:«Over N»/«Under N» (subject не нужен), единица — по st (геймы/сеты).
// SPREAD:«AH{1|2}(±L)» со стороны, на которую ставим (A=team1 линия L; B=team2 линия −L) + subject=команда + единица.
//        Единица важна: фора по сетам (/Main/Main) не должна путаться с форой по геймам (/Main/Main/Game).
function betDesc(sig) {
  const A = sig.side === "A";
  const team = A ? sig.t1 : sig.t2;
  const unit = sig.st === "/Main/Main/Game" ? "геймы" : sig.st === "/Main/Main" ? "сеты" : null;
  if (sig.kind === "ML") return { desc: A ? "1" : "2", subject: team, unit: null };
  if (sig.kind === "TOTAL") return { desc: (A ? "Over " : "Under ") + sig.param, subject: "", unit };
  if (sig.kind === "SPREAD") {
    const L = A ? Number(sig.param) : -Number(sig.param);       // линия со стороны, на которую ставим
    return { desc: "AH" + (A ? "1" : "2") + "(" + (L >= 0 ? "+" : "") + L + ")", subject: team, unit };
  }
  return { desc: "", subject: "", unit: null };                 // рынок, который не умеем ставить
}

// Кандидат для runValueCycle: url события + desc/subject/descFull + ожидаемый кэф + сумма + ключ.
function signalToCandidate(sig, stake) {
  const d = betDesc(sig);
  const descFull = (d.desc + (d.subject ? " " + d.subject : "") + (d.unit ? " - " + d.unit : "")).trim();
  return {
    url: sig.link, desc: d.desc, subject: d.subject, descFull,
    expectedOdds: sig.betanoOdds, stake: Number(stake) || 0, outcomeId: "",
    key: sigKey(sig), t1: sig.t1, t2: sig.t2, market: sig.market, side: sig.side,
    kind: sig.kind, param: sig.param, value: sig.value, arbPct: sig.arbPct,
  };
}

// Проходит ли сигнал фильтры ставки. cfg: {minValue, oddsMin, oddsMax, requireArb, kinds}.
function eligible(sig, cfg = {}) {
  if (!sig || !sig.link) return false;                          // без ссылки на событие не открыть
  if (!betDesc(sig).desc) return false;                         // рынок, который не умеем ставить
  if (cfg.kinds && cfg.kinds.length && !cfg.kinds.includes(sig.kind)) return false; // (опция) только выбранные рынки
  if (sig.value < (cfg.minValue != null ? cfg.minValue : 0.02)) return false;
  if (cfg.oddsMin && sig.betanoOdds < cfg.oddsMin) return false;
  if (cfg.oddsMax && sig.betanoOdds > cfg.oddsMax) return false;
  if (cfg.requireArb && !(sig.arbPct > 0)) return false;        // (опция) ставить только реальные вилки
  return true;
}

// Выбрать ОДИН сигнал на ставку: лучший по value среди прошедших фильтр и ещё не ставленных, с защитами.
// Дедуп исходов (ДУБЛИ — тот же t1~t2|market|side) + лимит ставок на СОБЫТИЕ (cfg.maxPerEvent, 0=без лимита —
// чтобы не влупить по 5 доп-ставок в один матч) + суточный лимит + занятость.
// state: {busy, placedToday, maxPerDay, placedKeys}. Возврат {candidate}|{skip}.
function choosePlacement(sigs, cfg = {}, state = {}) {
  if (state.busy) return { skip: "занято" };
  const maxPerDay = cfg.maxPerDay || state.maxPerDay || 0;
  if (maxPerDay && (state.placedToday || 0) >= maxPerDay) return { skip: "лимит/сутки" };
  const placed = state.placedKeys instanceof Set ? state.placedKeys : new Set(state.placedKeys || []);
  const maxPerEvent = cfg.maxPerEvent || 0;                        // всего ставок на СОБЫТИЕ (0 = без лимита; доп-ставки в матче ок)
  const maxPerMarket = cfg.maxPerMarket != null ? cfg.maxPerMarket : 1; // ставок на СОБЫТИЕ+МАРКЕТ (деф 1: не две форы/тотала в матче)
  // Счётчики уже поставленного: по СОБЫТИЮ (t1~t2) и по СОБЫТИЕ+МАРКЕТ (маркет = st+kind, БЕЗ линии/стороны).
  const evCount = {}, mkCount = {};
  for (const k of placed) {
    const p = k.split("|"), ev = p[0], toks = (p[1] || "").split(" "); // p = [t1~t2, market, side]; market = «st kind param»
    evCount[ev] = (evCount[ev] || 0) + 1;
    const grp = ev + "|" + (toks[0] || "") + "|" + (toks[1] || "");
    mkCount[grp] = (mkCount[grp] || 0) + 1;
  }
  const evKey = (s) => s.t1 + "~" + s.t2;
  const mkKey = (s) => evKey(s) + "|" + (s.st || "") + "|" + (s.kind || "");
  const cand = (sigs || [])
    .filter((s) => eligible(s, cfg) && !placed.has(sigKey(s))
      && !(maxPerEvent && (evCount[evKey(s)] || 0) >= maxPerEvent)
      && !(maxPerMarket && (mkCount[mkKey(s)] || 0) >= maxPerMarket))
    .sort((a, b) => b.value - a.value)[0];
  if (!cand) return { skip: "нет подходящих" };
  return { candidate: signalToCandidate(cand, cfg.stake) };
}

module.exports = { sigKey, betDesc, signalToCandidate, eligible, choosePlacement };
