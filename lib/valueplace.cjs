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
  // Единица сеты/геймы — ТОЛЬКО теннис (sportType 3): там фора/тотал по сетам и по геймам — РАЗНЫЕ рынки, и
  // Betano/Pinnacle держат их в разных вкладках. У прочих спортов деления нет (голы/очки/шайбы — один рынок),
  // единица не нужна и мешала бы: «сеты» на футбольной форе включала set→счёт-конвертацию в pickOutcome (мисселект).
  const unit = Number(sig.sportType) === 3
    ? (sig.st === "/Main/Main/Game" ? "геймы" : "сеты")
    : null;
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
    kind: sig.kind, param: sig.param, st: sig.st, sportType: sig.sportType, value: sig.value, arbPct: sig.arbPct,
    betanoSelId: sig.betanoSelId || "", // id выбора Betano из фида — для связки с data-selnid кнопки (замер)
  };
}

// Проходит ли сигнал фильтры ставки. cfg: {minValue, oddsMin, oddsMax, requireArb, kinds}.
function eligible(sig, cfg = {}) {
  if (!sig || !sig.link) return false;                          // без ссылки на событие не открыть
  if (!betDesc(sig).desc) return false;                         // рынок, который не умеем ставить (любой спорт)
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
  // placed — СПИСОК уже поставленных sigKey (с повторами, для лимита дублей). Три НЕЗАВИСИМЫХ лимита — ставка
  // проходит, только если укладывается во ВСЕ три; значение = сколько ДОПОЛНИТЕЛЬНО к первой (0 = только первая):
  //   dupExtra    — тот же ТОЧНЫЙ исход (событие+маркет+линия+сторона);
  //   eventExtra  — всего на СОБЫТИЕ (матч);
  //   marketExtra — на СОБЫТИЕ+МАРКЕТ (маркет = st+kind, БЕЗ линии).
  const placed = Array.isArray(state.placed) ? state.placed
    : state.placedKeys instanceof Set ? [...state.placedKeys] : Array.isArray(state.placedKeys) ? state.placedKeys : [];
  const dupMax = cfg.dupExtra || 0, evMax = cfg.eventExtra || 0, mkMax = cfg.marketExtra || 0;
  const grp = (k) => { const p = k.split("|"), toks = (p[1] || "").split(" "); return { k, ev: p[0], mk: p[0] + "|" + (toks[0] || "") + "|" + (toks[1] || "") }; };
  const pg = placed.map(grp);
  // ГАРД «ОБЕ СТОРОНЫ» (НЕЗАВИСИМ от лимитов dup/event/market): не берём ПРОТИВОПОЛОЖНУЮ сторону того же
  // рынка события, если та сторона уже в работе — ОБЕ победы в матче, Over и Under ОДНОЙ линии, +L и −L.
  // Одна сторона гарантированно проигрывает → флэт на оба не наша стратегия (реальный баг: Fritz И Bublik на
  // победу). Ключ рынка = событие|st|kind|abs(линия); сторону сравниваем. Консервативно: блокируем, даже если
  // та сторона лишь ПРОБОВАНА (fail-safe — не держим два встречных плеча). abs(линия) роднит +L и −L.
  const oppSig = (ev, st, kind, param) => ev + "|" + (st || "") + "|" + (kind || "") + "|" + (param != null && param !== "" && Number.isFinite(Number(param)) ? Math.abs(Number(param)) : "");
  const placedOpp = new Map(); // oppSig → Set(поставленных сторон)
  for (const k of placed) {
    const p = String(k).split("|"); if (p.length < 3) continue;       // "t1~t2|<st> <kind> [param]|side"
    const mk = (p[1] || "").split(" ");
    const sg = oppSig(p[0], mk[0], mk[1], mk[2]);
    if (!placedOpp.has(sg)) placedOpp.set(sg, new Set());
    placedOpp.get(sg).add(p[2]);
  }
  const fits = (s) => {
    if (!eligible(s, cfg)) return false;
    const sk = sigKey(s), eK = s.t1 + "~" + s.t2, mK = eK + "|" + (s.st || "") + "|" + (s.kind || "");
    const oppSides = placedOpp.get(oppSig(eK, s.st, s.kind, s.param));
    if (oppSides && [...oppSides].some((sd) => sd !== s.side)) return false; // противоположная сторона уже в работе → отказ
    let dup = 0, ev = 0, mk = 0;
    for (const g of pg) { if (g.k === sk) dup++; if (g.ev === eK) ev++; if (g.mk === mK) mk++; }
    return dup <= dupMax && ev <= evMax && mk <= mkMax; // ВСЕ три лимита должны пройти (независимо)
  };
  const cand = (sigs || []).filter(fits).sort((a, b) => b.value - a.value)[0];
  if (!cand) return { skip: "нет подходящих" };
  return { candidate: signalToCandidate(cand, cfg.stake) };
}

module.exports = { sigKey, betDesc, signalToCandidate, eligible, choosePlacement };
