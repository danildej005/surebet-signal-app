"use strict";
// Тесты ставочной части (чистая логика выбора + синтез Betano-desc). Живой клик проверяется на ВДС с Octo;
// тут доказываем контракт: синтезированный desc ПОНИМАЕТСЯ проверенным classifyDesc/marketUnit (переиспуем выбор).
const test = require("node:test");
const assert = require("node:assert");
const vp = require("../lib/valueplace.cjs");
const bk = require("../lib/bookers.cjs");

const sig = (o) => Object.assign({ t1: "Guido Ivan Justo", t2: "Olle Wallin", link: "https://www.betano.bg/live/x/86655013/", betanoOdds: 2.0, value: 0.05, arbPct: -0.01, sportType: 3 }, o);

test("betDesc + classifyDesc: ML → «1»/«2» (победа стороны), subject=команда", () => {
  const a = vp.betDesc(sig({ kind: "ML", param: "", side: "A", market: "/Main/Main ML" }));
  assert.deepEqual([a.desc, a.subject], ["1", "Guido Ivan Justo"]);
  assert.deepEqual(bk.classifyDesc(a.desc), { kind: "win", side: "1" });
  const b = vp.betDesc(sig({ kind: "ML", side: "B" }));
  assert.equal(b.desc, "2"); assert.equal(b.subject, "Olle Wallin");
  assert.equal(bk.classifyDesc("2").side, "2");
});

test("betDesc + classifyDesc: TOTAL(геймы) → Over/Under N, единица game", () => {
  const a = vp.betDesc(sig({ kind: "TOTAL", param: "27.5", side: "A", st: "/Main/Main/Game" }));
  assert.equal(a.desc, "Over 27.5"); assert.equal(a.unit, "геймы");
  assert.deepEqual(bk.classifyDesc(a.desc), { kind: "total", over: true, line: "27.5" });
  const b = vp.betDesc(sig({ kind: "TOTAL", param: "27.5", side: "B", st: "/Main/Main/Game" }));
  assert.equal(b.desc, "Under 27.5");
  assert.equal(bk.classifyDesc(b.desc).over, false);
});

test("betDesc + classifyDesc: SPREAD знаковая линия со стороны ставки (A=team1 L, B=team2 −L)", () => {
  const a = vp.betDesc(sig({ kind: "SPREAD", param: "-6.5", side: "A", st: "/Main/Main/Game" }));
  assert.equal(a.desc, "AH1(-6.5)"); assert.equal(a.subject, "Guido Ivan Justo"); assert.equal(a.unit, "геймы");
  assert.deepEqual(bk.classifyDesc(a.desc), { kind: "hcap", side: "1", line: "-6.5" });
  const b = vp.betDesc(sig({ kind: "SPREAD", param: "-6.5", side: "B", st: "/Main/Main/Game" }));
  assert.equal(b.desc, "AH2(+6.5)"); assert.equal(b.subject, "Olle Wallin"); // team2 берёт зеркальную +6.5
  assert.deepEqual(bk.classifyDesc(b.desc), { kind: "hcap", side: "2", line: "+6.5" });
  // фора по СЕТАМ (/Main/Main) — единица set
  assert.equal(vp.betDesc(sig({ kind: "SPREAD", param: "-1.5", side: "A", st: "/Main/Main" })).unit, "сеты");
});

test("signalToCandidate: descFull несёт единицу (marketUnit её видит), поля перенесены", () => {
  const c = vp.signalToCandidate(sig({ kind: "SPREAD", param: "-6.5", side: "A", st: "/Main/Main/Game", market: "/Main/Main/Game SPREAD -6.5" }), 5);
  assert.equal(c.descFull, "AH1(-6.5) Guido Ivan Justo - геймы");
  assert.equal(bk.marketUnit(c.descFull), "game");   // единица читается из descFull
  assert.equal(c.expectedOdds, 2.0); assert.equal(c.stake, 5);
  assert.equal(c.sportType, 3);                       // несёт спорт — для теннис-гейта боевого клика
  assert.equal(c.url, "https://www.betano.bg/live/x/86655013/");
  assert.equal(c.key, "Guido Ivan Justo~Olle Wallin|/Main/Main/Game SPREAD -6.5|A");
  assert.equal(vp.betDesc(sig({ kind: "SPREAD", param: "-1.5", side: "A", st: "/Main/Main" })).unit, "сеты");
});

test("eligible: фильтры (ссылка, порог value, коридор кэфа, requireArb, kinds)", () => {
  const base = { kind: "ML", param: "", side: "A", st: "/Main/Main", market: "/Main/Main ML" };
  assert.equal(vp.eligible(sig({ ...base, value: 0.05 }), { minValue: 0.03 }), true);
  assert.equal(vp.eligible(sig({ ...base, value: 0.01 }), { minValue: 0.03 }), false);        // ниже порога
  assert.equal(vp.eligible(sig({ ...base, link: "" }), {}), false);                            // нет ссылки
  assert.equal(vp.eligible(sig({ ...base, betanoOdds: 1.2 }), { oddsMin: 1.5 }), false);       // кэф ниже коридора
  assert.equal(vp.eligible(sig({ ...base, arbPct: -0.02 }), { requireArb: true }), false);     // не вилка
  assert.equal(vp.eligible(sig({ ...base, arbPct: 0.03 }), { requireArb: true }), true);       // вилка
  assert.equal(vp.eligible(sig({ ...base, kind: "TOTAL", param: "27.5", st: "/Main/Main/Game" }), { kinds: ["ML"] }), false); // не в списке рынков
  assert.equal(vp.eligible(sig({ kind: "SCORE", param: "", side: "A", market: "x" }), {}), false); // неумеемый рынок
  assert.equal(vp.eligible(sig({ kind: "ML", param: "", side: "A", market: "/Main/Main ML", st: "/Main/Main", sportType: 1 }), {}), true); // не-теннис (футбол) теперь ставим — desc «1»/«2» универсален
});

test("betDesc: НЕ-теннис — без единицы сеты/геймы (голы/очки — один рынок, единица мешала бы pickOutcome)", () => {
  const sp = vp.betDesc(sig({ kind: "SPREAD", param: "-1.5", side: "A", st: "/Main/Main", sportType: 1 })); // футбольная фора (голы)
  assert.equal(sp.desc, "AH1(-1.5)"); assert.equal(sp.subject, "Guido Ivan Justo"); assert.equal(sp.unit, null);
  const to = vp.betDesc(sig({ kind: "TOTAL", param: "2.5", side: "A", st: "/Main/Main", sportType: 1 }));
  assert.equal(to.desc, "Over 2.5"); assert.equal(to.unit, null);
  const c = vp.signalToCandidate(sig({ kind: "SPREAD", param: "-1.5", side: "A", st: "/Main/Main", sportType: 1, market: "/Main/Main SPREAD -1.5" }), 5);
  assert.equal(c.descFull, "AH1(-1.5) Guido Ivan Justo");        // без «- сеты» → pickOutcome не включит set→счёт-конвертацию
  assert.equal(bk.marketUnit(c.descFull), null);
});

test("choosePlacement: лучший по value + занятость/суточный лимит/пусто", () => {
  const sigs = [
    sig({ kind: "ML", side: "A", value: 0.03, market: "/Main/Main ML", st: "/Main/Main" }),
    sig({ kind: "SPREAD", param: "-6.5", side: "A", value: 0.08, market: "/Main/Main/Game SPREAD -6.5", st: "/Main/Main/Game" }),
  ];
  const best = vp.choosePlacement(sigs, { minValue: 0.02, stake: 5 }, {});
  assert.equal(best.candidate.market, "/Main/Main/Game SPREAD -6.5"); // 8% > 3%
  assert.equal(best.candidate.stake, 5);
  assert.equal(vp.choosePlacement(sigs, {}, { busy: true }).skip, "занято");
  assert.equal(vp.choosePlacement(sigs, { maxPerDay: 3 }, { placedToday: 3 }).skip, "лимит/сутки");
  assert.equal(vp.choosePlacement([], {}, {}).skip, "нет подходящих");
});

test("choosePlacement: ДУБЛИ (dupExtra) — тот же ТОЧНЫЙ исход; 0 = раз, 1 = +1", () => {
  const s = sig({ kind: "ML", side: "A", value: 0.05, market: "/Main/Main ML", st: "/Main/Main" });
  const key = "Guido Ivan Justo~Olle Wallin|/Main/Main ML|A";
  const cfg = (d) => ({ minValue: 0.02, dupExtra: d, eventExtra: 9, marketExtra: 9 }); // матч/маркет не режут
  assert.equal(vp.choosePlacement([s], cfg(0), { placed: [key] }).skip, "нет подходящих");        // dupExtra=0: уже стоит → нет
  assert.equal(vp.choosePlacement([s], cfg(1), { placed: [key] }).candidate.market, "/Main/Main ML"); // dupExtra=1: один дубль ок
  assert.equal(vp.choosePlacement([s], cfg(1), { placed: [key, key] }).skip, "нет подходящих");   // два уже стоят → третий нет
});

test("choosePlacement: ДОП-В-МАТЧЕ (eventExtra) — 0 = 1 ставка на матч, 1 = +1 в другом маркете", () => {
  const sml = sig({ kind: "ML", side: "A", value: 0.05, market: "/Main/Main ML", st: "/Main/Main" });
  const stot = sig({ kind: "TOTAL", param: "27.5", side: "A", value: 0.04, market: "/Main/Main/Game TOTAL 27.5", st: "/Main/Main/Game" });
  const placed = ["Guido Ivan Justo~Olle Wallin|/Main/Main/Game SPREAD -6.5|A"]; // 1 ставка в матче (фора)
  assert.equal(vp.choosePlacement([sml, stot], { minValue: 0.02, eventExtra: 0, marketExtra: 9 }, { placed }).skip, "нет подходящих"); // матч занят
  assert.equal(vp.choosePlacement([sml, stot], { minValue: 0.02, eventExtra: 1, marketExtra: 9 }, { placed }).candidate.market, "/Main/Main ML"); // +1 в матче → лучший (ML)
});

test("choosePlacement: ДОП-В-МАРКЕТЕ (marketExtra) — 0 = не две форы, но другой маркет матча ок", () => {
  const sSpread2 = sig({ kind: "SPREAD", param: "-2.5", side: "A", value: 0.08, market: "/Main/Main/Game SPREAD -2.5", st: "/Main/Main/Game" });
  const sTotal = sig({ kind: "TOTAL", param: "27.5", side: "A", value: 0.06, market: "/Main/Main/Game TOTAL 27.5", st: "/Main/Main/Game" });
  const placed = ["Guido Ivan Justo~Olle Wallin|/Main/Main/Game SPREAD -6.5|A"]; // одна фора(геймы) уже стоит
  // eventExtra=5 (матч не режет), marketExtra=0: 2-ю фору НЕ берём (маркет занят), тотал того же матча — берём
  assert.equal(vp.choosePlacement([sSpread2, sTotal], { minValue: 0.02, eventExtra: 5, marketExtra: 0 }, { placed }).candidate.market, "/Main/Main/Game TOTAL 27.5");
  assert.equal(vp.choosePlacement([sSpread2], { minValue: 0.02, eventExtra: 5, marketExtra: 0 }, { placed }).skip, "нет подходящих");
});
