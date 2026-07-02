"use strict";
// Движок LIVE-value на сыром фиде bettingco: держит сессии Betano+Pinnacle (стартовый пул + дельты-снимки),
// синхронно опрашивает обе книги ~1с, сканит value (Pinnacle de-vig эталон vs Betano). ТОЛЬКО ДЕТЕКЦИЯ —
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

  // Полный пул книги с соблюдением лимита 1/5с (init + пере-инициализация на mismatch/протухании).
  async _initBook(book) {
    const wait = 5200 - (Date.now() - this.lastPull);
    if (wait > 0) await sleep(wait);
    this.lastPull = Date.now();
    const data = await bc.getBookmakerData(book, this.key, this.opts);
    if (!data || !data.gamesOriginModel) throw new Error(book + ": пустой GetBookmakerData");
    return bc.stateFromData(book, data);
  }

  async init() { this.B = await this._initBook("Betano"); this.P = await this._initBook("Pinnacle"); return this; }
  ready() { return !!(this.B && this.P); }

  // Один цикл опроса: снимки обеих книг ПАРАЛЛЕЛЬНО (синхронно), накат дельт, сторож протухания плеча.
  // Возврат {ok, reinit, ageB, ageP} — ok=false если в этом цикле было протухание/реинит (скан пропустить).
  async poll() {
    if (!this.ready()) return { ok: false };
    const [rb, rp] = await Promise.all([
      bc.getSnapshots("Betano", this.key, this.B.sessionGuid, this.B.cursor, this.opts),
      bc.getSnapshots("Pinnacle", this.key, this.P.sessionGuid, this.P.cursor, this.opts),
    ]);
    const ab = bc.applySnapshotsResponse(this.B, rb), ap = bc.applySnapshotsResponse(this.P, rp);
    this.B.empty = ab.applied ? 0 : (this.B.empty || 0) + 1;
    this.P.empty = ap.applied ? 0 : (this.P.empty || 0) + 1;
    const staleMs = this.opts.staleMs || 8000, staleEmpty = this.opts.staleEmpty || 6, now = Date.now();
    const stale = (s) => (now - new Date(s.cursor)) > staleMs || s.empty >= staleEmpty;
    let reinit = false;
    if (ab.mismatch || stale(this.B)) { this.B = await this._initBook("Betano"); reinit = true; }
    if (ap.mismatch || stale(this.P)) { this.P = await this._initBook("Pinnacle"); reinit = true; }
    return { ok: !reinit && !ab.rate && !ap.rate, reinit, rate: !!(ab.rate || ap.rate),
      ageB: Date.now() - new Date(this.B.cursor), ageP: Date.now() - new Date(this.P.cursor) };
  }

  // Скан value по текущим (свежим) состояниям. cfg: {threshold, maxPlausible, markets, oddsMin, oddsMax}.
  scan(cfg = {}) { return this.ready() ? bc.scanValueState(this.B, this.P, cfg) : []; }

  counts() { return this.ready() ? { games: Object.keys(this.B.games).length, pinGames: Object.keys(this.P.games).length } : { games: 0, pinGames: 0 }; }
}

module.exports = { ValueLiveEngine };
