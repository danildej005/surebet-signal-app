"use strict";
// Клиент сырого live-фида bettingco (apiparsers.bettingco.pro) + ЧИСТЫЙ расчёт live-value Betano vs Pinnacle.
// Обе конторы приходят с ОДНОГО ключа (X-Api-Key), синхронно, обновление 0.5–1с. Pinnacle — эталон (de-vig),
// Betano — цель ставки. Общего id событий НЕТ → матч по именам; рынки матчим по нормализованному surebetTextId
// (одинаков в обеих БК). Чистая логика покрыта тестами (test/bettingco.test.cjs). Ключ — секрет, в git не кладём.
const https = require("https");
const HOST = "apiparsers.bettingco.pro";

// GET GameData одной конторы (bookmakerType строкой: "Betano" | "Pinnacle"). X-Api-Key в заголовке.
function getBookmakerData(bookmakerType, key, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: opts.host || HOST, path: "/GameData/GetBookmakerData?bookmakerType=" + encodeURIComponent(bookmakerType),
        headers: { "X-Api-Key": key, Accept: "application/json" }, timeout: opts.timeoutMs || 30000 },
      (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => {
          if (res.statusCode === 429) {                          // rate-limit ПО СТАТУСУ (тело может быть пустым/непарсимым)
            let ra = 0; try { ra = Number(JSON.parse(b || "{}").retryAfterMilliseconds) || 0; } catch { /* ignore */ }
            if (!ra) ra = (Number(res.headers["retry-after"]) || 4) * 1000; // fallback: заголовок Retry-After (сек) или 4с
            return resolve({ rateLimited: true, retryAfterMs: ra });
          }
          if (res.statusCode === 204 || !b) return resolve(null);
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("bettingco не JSON (" + res.statusCode + "): " + b.slice(0, 120))); }
        });
      });
    req.on("timeout", () => req.destroy(new Error("bettingco таймаут " + bookmakerType)));
    req.on("error", reject);
  });
}

// PURE: нормализация имени команды/игрока (для матча событий по именам, без общего id).
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

// PURE: ключ КОМАНДЫ для СКЛЕЙКИ событий между БК. Конторы пишут один матч по-разному:
// «Team Yandex»↔«Yandex», «LGD Gaming»↔«LGD» (кибер), «LA Angels»↔«Los Angeles Angels» (MLB),
// «Diablos Rojos del México»↔«Mexico Diablos Rojos» (латам: предлоги + порядок слов). Скобочные ники
// «(Esports)/(Logan)» — вон; шумовые токены (team/gaming/fc… + исп. de/del/y) — вон; US-аббревиатуры городов
// раскрываются (la→los angeles); «saint»→«st»; токены СОРТИРУЮТСЯ (порядок слов не важен). Если после чистки
// пусто — откат к полному norm. Риск ложной склейки мал: ключ = ПАРА команд, совпасть должны обе.
// ВАЖНО: «los/la» как исп. артикли НЕ режем (сломали бы Los Angeles) — они детерминированно раскрываются
// алиасом с обеих сторон, склейка внутри пары остаётся согласованной. Бренд-буквы KBO (LG/KT/SSG/NC) не трогаем.
// dena — спонсорская вставка NPB («Yokohama DeNA Baystars» ↔ «Yokohama Bay Stars»): 14-16 снимков/сутки теряли матч
const TEAM_NOISE = /\b(team|esports?|e-sports|gaming|club|fc|cf|sc|ac|afc|cfc|ssc|bk|bc|cd|ud|if|fk|f\.c\.|the|de|del|y|dena)\b/gi;
// однозначные аббревиатуры городов US-лиг (MLB/NBA/NFL/NHL). Спорные (NO/MIN/DC) сознательно НЕ включены.
const CITY_ALIAS = {
  la: "los angeles", ny: "new york", sf: "san francisco", sd: "san diego", kc: "kansas city",
  tb: "tampa bay", stl: "st louis", okc: "oklahoma city", gs: "golden state", nj: "new jersey", saint: "st",
};
function teamTokens(s) {
  const noParen = String(s || "").replace(/\([^)]*\)/g, " ");
  const base = noParen.replace(TEAM_NOISE, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const toks = [];
  for (const t of base.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    const al = CITY_ALIAS[t];
    if (al) toks.push(...al.split(" ")); else toks.push(t);
  }
  return toks;
}
function teamKey(s) {
  const toks = teamTokens(s);
  return toks.length ? toks.slice().sort().join("") : norm(s);
}

// PURE: sportType (enum bettingco, совпадает с /getsports) → русское название. Для статистики.
const SPORTS = {
  0: "—", 1: "Футбол", 2: "Хоккей", 3: "Теннис", 4: "Баскетбол", 5: "Волейбол", 6: "Гандбол",
  7: "Наст. теннис", 8: "Бадминтон", 9: "Бейсбол", 10: "Регби", 11: "Ам. футбол", 12: "Снукер",
  13: "Дартс", 14: "Водное поло", 21: "Киберспорт", 22: "Кибер-футбол", 23: "Кибер-баскет",
  24: "Кибер-теннис", 25: "Кибер-хоккей", 26: "Футзал", 27: "Крикет", 28: "Флорбол", 29: "CS",
  30: "Dota", 31: "LoL", 32: "Valorant", 33: "Хоккей на траве", 34: "Сквош", 35: "Велоспорт",
};
const sportName = (t) => SPORTS[t] || ("sport#" + t);

// PURE: счёт матча в массив сетов [["6","1"],["1","0"]] (без «|CurrentGame:X» и пробелов).
const parseScore = (s) => { const k = String(s || "").split("|")[0].replace(/\s+/g, ""); return k ? k.split(",").map((x) => x.split("-")) : []; };
// PURE: синхронны ли плечи по событию + перевёрнут ли порядок команд между БК. Возврат {sync, flip}.
// flip=true, если БК перечислили команды в РАЗНОМ порядке (тогда счёт и стороны сравниваем «наоборот»).
// Рассинхрон счёта = одно плечо протухло на событии → value ложный, скипаем.
// одна ли команда: равные teamKey ИЛИ токены одной ⊆ другой (subset-склейка NPB: «Fukuoka SoftBank Hawks»↔«SoftBank Hawks»)
function sameTeam(a, b) {
  if (teamKey(a) === teamKey(b)) return true;
  const ta = teamTokens(a), tb = teamTokens(b);
  if (!ta.length || !tb.length) return false;
  return ta.every((t) => tb.includes(t)) || tb.every((t) => ta.includes(t));
}
// Допуск рассинхрона счёта для БЫСТРО ТИКАЮЩИХ видов (очки идут быстрее снапшотов фида; замер 10-11.07:
// баскет расходился на 2 очка ПОСТОЯННО → весь спорт блокировался). Теннис/футбол/бейсбол/хоккей — строго 0:
// там событие счёта (гейм/гол/ран) радикально меняет рынки, лаг = реальный рассинхрон.
const SCORE_TICK_TOL = { 4: 3, 5: 3, 6: 3, 7: 2 }; // баскет, волейбол, гандбол, наст.теннис
function eventSync(gb, gp) {
  const flip = !sameTeam(gb.team1NameEn, gp.team1NameEn); // subset-осведомлённое сравнение: flip не врёт ни на алиасах, ни на регион-префиксах
  const a = parseScore(gb.currentScore), b = parseScore(gp.currentScore);
  if (!a.length && !b.length) return { sync: true, flip };   // прематч — ок
  // Одна БК НЕ ВЕДЁТ счёт в фиде (пусто/сплошные нули при живом счёте у другой) — данных для сравнения НЕТ,
  // это НЕ рассинхрон (замер 10-11.07: Pinnacle стабильно «0-0» у Dota/Valorant/волейбола → блокировалось ВСЁ).
  const isZero = (s) => s.every((pair) => pair.every((x) => !Number(x)));
  if (!a.length || !b.length || isZero(a) !== isZero(b)) return { sync: true, flip, blind: true };
  if (a.length !== b.length) return { sync: false, flip };
  const tol = SCORE_TICK_TOL[Number(gb.sportType)] || 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = flip ? [b[i][1], b[i][0]] : b[i];      // при flip у Pinnacle меняем местами счёт пары
    if (tol) {
      if (Math.abs(Number(p[0]) - Number(q[0])) > tol || Math.abs(Number(p[1]) - Number(q[1])) > tol) return { sync: false, flip };
    } else if (p[0] !== q[0] || p[1] !== q[1]) return { sync: false, flip };
  }
  return { sync: true, flip };
}

// PURE: игры → Map(ключ-пары имён → игра). Ключ независим от порядка команд.
function gamesByPair(gamesModel) {
  const m = new Map();
  for (const g of Object.values(gamesModel || {})) {
    const k = [teamKey(g.team1NameEn), teamKey(g.team2NameEn)].sort().join("~"); // teamKey — склейка выдерживает разные написания
    m.set(k, g);
  }
  return m;
}

// PURE: сопоставить события Betano↔Pinnacle по именам. Возврат [{key, b, p}].
// Шаг 1 — точная склейка по ключу пары (teamKey). Шаг 2 — SUBSET-фолбэк для остатка: одна контора пишет
// регион-префикс, другая нет («Fukuoka SoftBank Hawks»↔«SoftBank Hawks», NPB; «Tigres del Licey»↔«Licey»).
// Матч по подмножеству токенов ОБЕИХ команд (в любом порядке пары), и ТОЛЬКО если кандидат ЕДИНСТВЕННЫЙ
// с обеих сторон — два «Giants» на доске → отказ (fail-safe, не гадаем; см. [[prefer-refusal-over-guess]]).
function matchEvents(betanoGames, pinnacleGames) {
  const bi = gamesByPair(betanoGames), pi = gamesByPair(pinnacleGames);
  const out = [];
  const usedP = new Set();
  for (const [k, b] of bi) { const p = pi.get(k); if (p) { out.push({ key: k, b, p }); usedP.add(k); } }
  // subset-фолбэк по несклеенному остатку
  const sub = (a, z) => a.every((t) => z.includes(t));           // токены a ⊆ z (все токены a есть в z)
  const pairSub = (x1, x2, y1, y2) => (sub(x1, y1) || sub(y1, x1)) && (sub(x2, y2) || sub(y2, x2));
  const restB = [...bi.entries()].filter(([k]) => !pi.has(k));
  const restP = [...pi.entries()].filter(([k]) => !bi.has(k) && !usedP.has(k));
  const bMatches = new Map(); // ключ B → [кандидаты P]
  const pHits = new Map();    // ключ P → сколько B на него претендует
  for (const [bk, b] of restB) {
    const b1 = teamTokens(b.team1NameEn), b2 = teamTokens(b.team2NameEn);
    if (!b1.length || !b2.length) continue;
    for (const [pk, p] of restP) {
      const p1 = teamTokens(p.team1NameEn), p2 = teamTokens(p.team2NameEn);
      if (pairSub(b1, b2, p1, p2) || pairSub(b1, b2, p2, p1)) {
        if (!bMatches.has(bk)) bMatches.set(bk, []);
        bMatches.get(bk).push({ pk, p });
        pHits.set(pk, (pHits.get(pk) || 0) + 1);
      }
    }
  }
  for (const [bk, cands] of bMatches) {
    if (cands.length !== 1) continue;                 // у B несколько кандидатов → не гадаем
    const { pk, p } = cands[0];
    if ((pHits.get(pk) || 0) !== 1) continue;         // на P претендует несколько B → не гадаем
    out.push({ key: bk, b: bi.get(bk), p });
  }
  return out;
}

// PURE: рынки → Map(gameTextId → [рынки]).
function marketsByGame(marketsModel) {
  const m = new Map();
  for (const x of Object.values(marketsModel || {})) {
    const g = x.gameTextId; if (!g) continue;
    if (!m.has(g)) m.set(g, []); m.get(g).push(x);
  }
  return m;
}

// Разрешённые рынки: только ПОЛНЫЙ матч (без live-подсегментов текущего сета/гейма — там шум и лаг).
const isMainMarket = (st) => st === "/Main/Main" || st === "/Main/Main/Game";

// PURE: исходы Pinnacle одной игры → { "<surebetTextId>|<betType>|<param>": {A:odds, B:odds} }.
// meta структурная: gameId|period|BETTYPE|TEAMSLOT|SIDE|param|extra. A/B: ML/SPREAD → team1/team2, TOTAL → over/under.
// param: ML — пусто; TOTAL — линия (модуль); SPREAD — ЗНАКОВАЯ фора со стороны A (team1).
// flip=true (БК перечислили команды наоборот) → у командных рынков TEAM1↔TEAM2 меняем местами, чтобы A/B
// указывали на ТЕ ЖЕ команды, что у Betano (иначе de-vig считает по чужой стороне).
function pinnacleOutcomes(markets, flip) {
  const T1 = flip ? "B" : "A", T2 = flip ? "A" : "B";
  const out = {};
  for (const x of markets || []) {
    const st = x.surebetTextId; if (!isMainMarket(st)) continue;
    const p = String(x.meta || "").split("|");
    const bet = p[2], slot = p[3], side = p[4];
    let kind, ab;
    if (bet === "MONEYLINE") { kind = "ML"; ab = slot === "TEAM1" ? T1 : slot === "TEAM2" ? T2 : null; }
    else if (bet === "TOTAL_POINTS") { kind = "TOTAL"; ab = side === "OVER" ? "A" : side === "UNDER" ? "B" : null; }
    else if (bet === "SPREAD") { kind = "SPREAD"; ab = slot === "TEAM1" ? T1 : slot === "TEAM2" ? T2 : null; }
    else continue;
    // 3-й исход MONEYLINE (слот ≠ TEAM1/TEAM2 = ничья) → рынок 3-way (1X2), de-vig 2-way завышает fair: помечаем ML-ключ.
    if (kind === "ML" && !ab) { const dk = st + "|ML|"; (out[dk] || (out[dk] = {})).draw = true; continue; }
    if (!ab || !(x.marketValue > 1)) continue;
    // SPREAD — ЗНАКОВАЯ линия со стороны A (team1@L ↔ team2@(−L) = один рынок; Pinnacle отдаёт ОБЕ линии ±L
    // как разные рынки, модуль их схлопывал и терял одну). TOTAL — линия (модуль). ML — без параметра.
    const param = kind === "ML" ? ""
      : kind === "SPREAD" ? String(ab === "A" ? Number(x.marketParameter) : -Number(x.marketParameter))
      : Math.abs(Number(x.marketParameter));
    const key = st + "|" + kind + "|" + param;
    (out[key] || (out[key] = {}))[ab] = x.marketValue;
  }
  return out;
}

// PURE: исходы Betano одной игры → тот же формат ключей. meta человекочитаемая. t1/t2 — имена для маппинга стороны.
// Тоталы с именем игрока (напр. «X Games Won | Over») ОТСЕКАЕМ — это не матчевый тотал (защита от подмены рынка).
function betanoOutcomes(markets, t1, t2) {
  const n1 = norm(t1), n2 = norm(t2), out = {};
  for (const x of markets || []) {
    const st = x.surebetTextId; if (!isMainMarket(st)) continue;
    const meta = String(x.meta || ""), mn = norm(meta), k = x.marketValue;
    if (!(k > 1)) continue;
    let kind, ab, param = "";
    if (/^winner/i.test(meta)) {
      kind = "ML"; const who = norm(meta.split("|").pop());
      ab = who === n1 ? "A" : who === n2 ? "B" : null;
      if (!ab && /^(draw|x|tie|empate)$/.test(who)) { const dk = st + "|ML|"; (out[dk] || (out[dk] = {})).draw = true; continue; } // ничья → рынок 3-way
    } else if (/\bover\b/i.test(meta) || /\bunder\b/i.test(meta)) {
      // матчевый тотал: НЕ содержит имени игрока (иначе это персональный тотал — другой рынок)
      if (mn.includes(n1) || mn.includes(n2)) continue;
      kind = "TOTAL"; ab = /\bover\b/i.test(meta) ? "A" : "B"; param = Math.abs(Number(x.marketParameter));
    } else if (/handicap/i.test(meta)) {
      // фора: сторона по имени из хвоста meta, ЗНАКОВАЯ линия из marketParameter («Heide -1.5» → −1.5).
      // Ключ — линия со стороны A (team1): team1@L ↔ team2@(−L) = один рынок (обе линии не схлопываем).
      kind = "SPREAD"; const who = norm(meta.split("|").pop().replace(/[-\d.\s]+$/, ""));
      // ЕВРОПЕЙСКИЙ хендикап (3-way, «Handicap Match Result» с ничьей) — НЕ азиатская фора: de-vig 2-way
      // против AH Pinnacle даёт ЛОЖНЫЙ value (реальный кейс 08-07: сигнал AH+1.5 → купон «FK Sutjeska +2
      // Handicap Match Result», спас судья). Ничья в хвосте meta → помечаем draw ОБЕ линии рынка → скип.
      if (/^(draw|x|tie|empate)$/.test(who)) {
        const L = Number(x.marketParameter);
        for (const pp of [String(L), String(-L)]) { const dk = st + "|SPREAD|" + pp; (out[dk] || (out[dk] = {})).draw = true; }
        continue;
      }
      ab = who === n1 ? "A" : who === n2 ? "B" : null;
      const line = Number(x.marketParameter);
      if (ab) param = String(ab === "A" ? line : -line);
    } else continue;
    if (!ab) continue;
    const key = st + "|" + kind + "|" + param;
    const slot = out[key] || (out[key] = {});
    slot[ab] = k;
    // id ВЫБОРА Betano (первая часть eventId «9949062375|284…») — гипотеза: он же data-selnid кнопки на странице
    // → прямая связка «сигнал→кнопка» без матчинга по кэфу/имени. Пока только ПРОКИДЫВАЕМ (замер связки).
    const selId = String(x.eventId || "").split("|")[0];
    if (selId) slot[ab === "A" ? "idA" : "idB"] = selId;
  }
  return out;
}

// PURE: de-vig 2-way → [fairA, fairB].
function devig2(oddsA, oddsB) { const ra = 1 / oddsA, rb = 1 / oddsB, o = ra + rb; return [ra / o, rb / o]; }

// PURE: value-сигналы для одного события. Для каждого 2-way рынка, что есть в ОБЕИХ БК (обе стороны):
// de-vig Pinnacle → fair, value = кэф_Betano × fair − 1. maxPlausible режет артефакты (мисматч рынка).
function valueForEvent(betanoMarkets, pinnacleMarkets, t1, t2, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.02;
  const maxPlausible = opts.maxPlausible != null ? opts.maxPlausible : 0.25;
  const marginMax = opts.marginMax != null ? opts.marginMax : 0.06; // ФИЛЬТР ШУМА: маржа Pinnacle шире → эталон не острый → скип рынка
  const oddsMin = opts.oddsMin || 0, oddsMax = opts.oddsMax || 0;    // ФИЛЬТР: коридор кэфов Betano (0 = без границы)
  const B = betanoOutcomes(betanoMarkets, t1, t2), P = pinnacleOutcomes(pinnacleMarkets, opts.flip);
  const sigs = [];
  for (const key of Object.keys(P)) {
    const p = P[key], b = B[key];
    if (!b) continue;
    if (p.draw || b.draw) continue; // 3-исходный рынок (ничья видна хотя бы в одной БК) — de-vig 2-way неверен, пропускаем ML
    if (!(p.A > 1 && p.B > 1 && b.A > 1 && b.B > 1)) continue; // обе стороны в обеих БК
    const margin = 1 / p.A + 1 / p.B - 1;                            // маржа Pinnacle (overround − 1)
    if (marginMax && margin > marginMax) continue;                  // эталон широкий/неострый → шум, не считаем
    // ВИЛКА (доп-вериф, НЕ ставим): лучшие кэфы по сторонам между БК; arbPct>0 = гарантированный перекос,
    // подтверждает реальность расхождения независимо от «остроты» эталона. Считается бесплатно из тех же кэфов.
    const arbSum = 1 / Math.max(b.A, p.A) + 1 / Math.max(b.B, p.B);
    const arbPct = 1 - arbSum; // ПОДПИСАННЫЙ: >0 = реальная вилка (гарант-профит %), <0 = насколько НИЖЕ вилки (ось калибровки)
    const arb = arbPct > 0;
    const [fA, fB] = devig2(p.A, p.B);
    for (const [ab, fair] of [["A", fA], ["B", fB]]) {
      if (oddsMin && b[ab] < oddsMin) continue;
      if (oddsMax && b[ab] > oddsMax) continue;
      const v = b[ab] * fair - 1;
      if (v >= threshold && v <= maxPlausible) {
        const [st, kind, param] = key.split("|");
        sigs.push({ market: st + " " + kind + (param ? " " + param : ""), st, kind, param, side: ab,
          betanoOdds: b[ab], pinnacleOdds: p[ab], fair, value: v, margin, arb, arbPct, t1, t2,
          betanoSelId: (ab === "A" ? b.idA : b.idB) || "" }); // id выбора Betano — для связки с data-selnid кнопки
      }
    }
  }
  return sigs.sort((x, y) => y.value - x.value);
}

// Полный проход по одному ответу пары фидов: матч событий → value-сигналы (плоский список, по убыванию value).
function scanValue(betanoData, pinnacleData, opts = {}) {
  const bmg = marketsByGame(betanoData.marketsOriginModel && betanoData.marketsOriginModel.model);
  const pmg = marketsByGame(pinnacleData.marketsOriginModel && pinnacleData.marketsOriginModel.model);
  const events = matchEvents(betanoData.gamesOriginModel && betanoData.gamesOriginModel.model,
    pinnacleData.gamesOriginModel && pinnacleData.gamesOriginModel.model);
  const out = [];
  for (const e of events) {
    const sync = eventSync(e.b, e.p);
    if (!sync.sync) continue; // плечи рассинхронены по счёту → скип
    // gameTextId рынков = textId игры (в обеих БК свой префикс — берём каждой БК свой)
    const mm = (opts.marginBySport && opts.marginBySport[e.b.sportType] != null) ? Number(opts.marginBySport[e.b.sportType]) : opts.marginMax; // маржа-фильтр НА СПОРТ (панель)
    const sigs = valueForEvent(bmg.get(e.b.textId) || [], pmg.get(e.p.textId) || [], e.b.team1NameEn, e.b.team2NameEn, { ...opts, marginMax: mm, flip: sync.flip });
    for (const s of sigs) { s.league = e.b.leagueName; s.link = e.b.link; s.score = e.b.currentScore; s.sportType = e.b.sportType; s.sport = sportName(e.b.sportType); out.push(s); }
  }
  return out.sort((a, b) => b.value - a.value);
}

// ── СНИМКИ (модель сессии): опрос обеих БК СИНХРОННО каждую ~1с через дельты (штатный путь фида,
// 500–1000мс). Полный GetBookmakerData (лимит 1/5с) — только инициализация + пере-инициализация на mismatch. ──

// GET дельт после lastSnapshotTime. Возврат: тело ответа ({snapshots[], ...} или {error}).
function getSnapshots(bookmakerType, key, sessionGuid, lastSnapshotTime, opts = {}) {
  return new Promise((resolve, reject) => {
    const q = "?bookmakerType=" + encodeURIComponent(bookmakerType) + "&SessionId=" + encodeURIComponent(sessionGuid) +
      "&lastSnapshotTime=" + encodeURIComponent(lastSnapshotTime);
    const req = https.get(
      { host: opts.host || HOST, path: "/GameData/GetBookmakerSnapshots" + q,
        headers: { "X-Api-Key": key, Accept: "application/json" }, timeout: opts.timeoutMs || 20000 },
      (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => {
          if (res.statusCode === 429) return resolve({ error: "429 rate", rate: true });
          if (res.statusCode === 204 || !b) return resolve({ snapshots: [] });
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("snapshots не JSON (" + res.statusCode + "): " + b.slice(0, 120))); }
        });
      });
    req.on("timeout", () => req.destroy(new Error("snapshots таймаут " + bookmakerType)));
    req.on("error", reject);
  });
}

// PURE: применить один снимок-дельту к состоянию {games, markets}. Возврат writeTime снимка (курсор).
function applySnapshot(state, snap) {
  if (!state.touched) state.touched = {}; // gameTextId → writeTime последнего изменения события (для свежести)
  const wt = snap.writeTime || null;
  const bump = (gt) => { if (gt && wt) state.touched[gt] = wt; };
  // ВАЖНО: дельта-обновление рынка приходит как {textId, value:<новый кэф>, marketModel:null} — новый кэф в `value`,
  // полной модели НЕТ. Раньше такие обновления дропались (проверяли marketModel) → кэфы висли на init = артефакты.
  const applyMkt = (it) => {
    const cur = state.markets[it.textId];
    if (it.marketModel) state.markets[it.textId] = it.marketModel;         // полная модель (обычно marketsAdded)
    else if (cur && it.value != null) cur.marketValue = it.value;          // дельта: только новый кэф
    bump(it.gameTextId || (it.marketModel && it.marketModel.gameTextId) || (cur && cur.gameTextId));
  };
  for (const it of snap.marketsRemoved || []) delete state.markets[it.textId];
  for (const it of snap.marketsAdded || []) applyMkt(it);
  for (const it of snap.marketsUpdated || []) applyMkt(it);
  for (const it of snap.gamesRemoved || []) delete state.games[it.textId];
  for (const it of snap.gamesAdded || []) if (it.gameModel) { state.games[it.textId] = it.gameModel; bump(it.textId); }
  for (const it of snap.gamesUpdated || []) {
    const g = state.games[it.textId];
    if (it.gameModel) state.games[it.textId] = it.gameModel;
    else if (g) { if (it.currentScore != null) g.currentScore = it.currentScore; if (it.statusType != null) g.statusType = it.statusType; }
    bump(it.textId);
  }
  return wt;
}

// Состояние БК из GetBookmakerData: {book, sessionGuid, cursor, games, markets}. Применяет начальные снимки.
function stateFromData(book, data) {
  const state = {
    book, sessionGuid: null,
    cursor: (data.gamesOriginModel && data.gamesOriginModel.writeTime) || null,
    games: { ...(data.gamesOriginModel && data.gamesOriginModel.model) },
    markets: { ...(data.marketsOriginModel && data.marketsOriginModel.model) },
    touched: {},
  };
  for (const k of Object.keys(state.games)) state.touched[k] = state.cursor; // все события свежие на момент загрузки
  const snaps = data.snapshots || [];
  for (const s of snaps) { const wt = applySnapshot(state, s); if (wt && (!state.cursor || wt > state.cursor)) state.cursor = wt; }
  if (snaps.length) state.sessionGuid = snaps[snaps.length - 1].sessionGuid;
  return state;
}

// Применить ответ getSnapshots к состоянию (дельты, продвинуть курсор). Возврат {applied, mismatch, rate}.
function applySnapshotsResponse(state, resp) {
  if (resp && resp.rate) return { applied: 0, mismatch: false, rate: true };
  if (resp && resp.error) return { applied: 0, mismatch: /sessionid/i.test(resp.error), rate: false };
  let applied = 0;
  for (const s of (resp && resp.snapshots) || []) { const wt = applySnapshot(state, s); applied++; if (wt && (!state.cursor || wt > state.cursor)) state.cursor = wt; }
  return { applied, mismatch: false, rate: false };
}

// PURE: value-скан из ДВУХ состояний {games, markets} (синхронный путь снимков). СТОРОЖ ПО СОБЫТИЮ:
// (1) счёт матча должен совпасть между плечами; (2) событие должно быть свежим в ОБЕИХ БК — не молчать
// дольше freshMs относительно курсора своей БК. Иначе плечо протухло на этом матче → value ложный, скип.
function scanValueState(bState, pState, opts = {}) {
  const freshMs = opts.freshMs != null ? opts.freshMs : 30000;
  const bmg = marketsByGame(bState.markets), pmg = marketsByGame(pState.markets);
  const bCur = bState.cursor ? new Date(bState.cursor).getTime() : 0, pCur = pState.cursor ? new Date(pState.cursor).getTime() : 0;
  const bT = bState.touched || {}, pT = pState.touched || {};
  const age = (cur, touched, id) => (cur && touched[id]) ? (cur - new Date(touched[id]).getTime()) : 0; // насколько событие отстало от курсора БК
  const out = [];
  for (const e of matchEvents(bState.games, pState.games)) {
    const sync = eventSync(e.b, e.p);
    if (!sync.sync) continue;                                                        // рассинхрон счёта
    if (age(bCur, bT, e.b.textId) > freshMs || age(pCur, pT, e.p.textId) > freshMs) continue; // событие замолчало
    const mm = (opts.marginBySport && opts.marginBySport[e.b.sportType] != null) ? Number(opts.marginBySport[e.b.sportType]) : opts.marginMax; // маржа-фильтр НА СПОРТ (панель)
    const sigs = valueForEvent(bmg.get(e.b.textId) || [], pmg.get(e.p.textId) || [], e.b.team1NameEn, e.b.team2NameEn, { ...opts, marginMax: mm, flip: sync.flip });
    for (const s of sigs) { s.league = e.b.leagueName; s.link = e.b.link; s.score = e.b.currentScore; s.sportType = e.b.sportType; s.sport = sportName(e.b.sportType); out.push(s); }
  }
  return out.sort((a, b) => b.value - a.value);
}

module.exports = {
  getBookmakerData, norm, teamKey, teamTokens, sameTeam, eventSync, SPORTS, sportName, gamesByPair, matchEvents, marketsByGame,
  pinnacleOutcomes, betanoOutcomes, devig2, valueForEvent, scanValue,
  getSnapshots, applySnapshot, stateFromData, applySnapshotsResponse, scanValueState,
};
