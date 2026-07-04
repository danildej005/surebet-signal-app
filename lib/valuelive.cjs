"use strict";
// Движок LIVE-value на сыром фиде bettingco: держит сессии Betano+Pinnacle (стартовый пул + дельты-снимки),
// синхронно опрашивает обе БК ~1с, сканит value (Pinnacle de-vig эталон vs Betano). ТОЛЬКО ДЕТЕКЦИЯ —
// простановки тут нет (её подключают отдельно через Octo). Тонкая обёртка над lib/bettingco.cjs (там чистая
// логика + тесты). Ключ (X-Api-Key) передаётся аргументом, в модуле не хранится на диск.
const bc = require("./bettingco.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ValueLiveEngine {
  constructor(key, opts = {}) {
    this.key = String(key || "").trim();
    this.opts = opts;            // { staleMs, staleEmpty, host, timeoutMs }
    this.B = null; this.P = null;
    this.lastPull = 0;           // для лимита GetBookmakerData 1/5с
  }

  // Полный пул БК (init + реинит на mismatch). УСТОЙЧИВ к rate-limit и «пусто»: НЕ спамим и НЕ хаммерим ключ —
  // лимит (429, общий на ключ; ловим ПО СТАТУСУ) ждём по его сроку, пусто/нет-игр — с растущим backoff, терпеливо
  // повторяя (быстрые ретраи сами держат лимит → движок не поднимался). Логируем ЧТО пришло через onInitDiag
  // (диагностика на ВДС). Сеть/парс — до 3 ошибок, потом бросаем.
  async _initBook(book) {
    const minPull = this.opts.minPullMs || 5200;
    let waits = 0, errs = 0;
    for (;;) {
      const wait = minPull - (Date.now() - this.lastPull);
      if (wait > 0) await sleep(wait);
      this.lastPull = Date.now();
      let data = null;
      try { data = await bc.getBookmakerData(book, this.key, this.opts); }
      catch (e) { if (++errs >= 3) throw e; await sleep(1500); continue; }
      if (data && data.gamesOriginModel) return bc.stateFromData(book, data);
      // НЕ готово: 429 (rateLimited) или пусто/нет-игр. Ждём и терпеливо повторяем; логируем форму ответа.
      const ra = data && data.rateLimited ? (Number(data.retryAfterMs) || 4000)
        : (data && data.retryAfterMilliseconds != null ? Number(data.retryAfterMilliseconds) : null);
      const shape = data == null ? "пусто(204/empty)"
        : data.rateLimited ? ("rate-limit 429, retryAfter=" + ra + "мс")
        : ("нет игр, keys=[" + Object.keys(data).join(",") + "]");
      if (++waits > 20) throw new Error(book + ": не готов после ожиданий (" + shape + ")");
      if (this.opts.onInitDiag) { try { this.opts.onInitDiag(book, shape, waits); } catch { /* ignore */ } }
      await sleep(ra != null ? Math.min(ra + 400, 8000) : Math.min(3000 + waits * 1000, 12000)); // 429 — его срок; пусто — растущий backoff
    }
  }

  async init() { this.B = await this._initBook("Betano"); this.P = await this._initBook("Pinnacle"); return this; }
  ready() { return !!(this.B && this.P); }

  // Один цикл опроса: снимки обеих БК ПАРАЛЛЕЛЬНО (синхронно), накат дельт, сторож протухания плеча.
  // Возврат {ok, reinit, ageB, ageP} — ok=false если в этом цикле было протухание/реинит (скан пропустить).
  async poll() {
    if (!this.ready()) return { ok: false };
    const [rb, rp] = await Promise.all([
      bc.getSnapshots("Betano", this.key, this.B.sessionGuid, this.B.cursor, this.opts),
      bc.getSnapshots("Pinnacle", this.key, this.P.sessionGuid, this.P.cursor, this.opts),
    ]);
    const ab = bc.applySnapshotsResponse(this.B, rb), ap = bc.applySnapshotsResponse(this.P, rp);
    // Реинит ТОЛЬКО на SessionId mismatch (сервер прямо сказал «сессия сдохла»). Курсор-возраст/пустые снимки
    // НЕ триггерят реинит — они ложно срабатывали на тихой БК (мало событий ночью → долгое молчание ≠ протухло).
    // Баг замороженных кэфов, ради которого был сторож, пофикшен в 0.10.3; качество сигналов бережёт свежесть
    // ПО СОБЫТИЮ в scanValueState. Реинит устойчив (ретрай в _initBook) и не валит цикл (ловим ошибку).
    let reinit = false, reinitFail = null;
    try {
      if (ab.mismatch) { this.B = await this._initBook("Betano"); reinit = true; }
      if (ap.mismatch) { this.P = await this._initBook("Pinnacle"); reinit = true; }
    } catch (e) { reinitFail = e && e.message; }
    return { ok: !reinit && !reinitFail && !ab.rate && !ap.rate, reinit, reinitFail, rate: !!(ab.rate || ap.rate),
      ageB: Date.now() - new Date(this.B.cursor), ageP: Date.now() - new Date(this.P.cursor) };
  }

  // Скан value по текущим (свежим) состояниям. cfg: {threshold, maxPlausible, markets, oddsMin, oddsMax}.
  scan(cfg = {}) { return this.ready() ? bc.scanValueState(this.B, this.P, cfg) : []; }

  counts() { return this.ready() ? { games: Object.keys(this.B.games).length, pinGames: Object.keys(this.P.games).length } : { games: 0, pinGames: 0 }; }

  // Снимок счёта/статуса ВСЕХ событий Betano (счёт-эталон — со стороны, куда ставим). Для захвата
  // финального счёта под сеттлмент: main.cjs копит последний счёт на событие-с-валуем и морозит его,
  // когда событие уходит из фида. key = «team1~team2» (как в сигнале s.t1~s.t2). statusType сырой —
  // код «завершено» не угадываем, фиксируем как есть (позже сверим эмпирически).
  eventScores() {
    if (!this.ready()) return [];
    const out = [];
    for (const g of Object.values(this.B.games)) {
      if (!g || g.team1NameEn == null) continue;
      out.push({ key: g.team1NameEn + "~" + g.team2NameEn, score: g.currentScore || "", status: g.statusType != null ? g.statusType : null });
    }
    return out;
  }
}

module.exports = { ValueLiveEngine };
