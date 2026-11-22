"use strict";
// ПРЕМАТЧ: состояние одной конторы из фида bettingco (docs/PREMATCH-HANDBOOK.md, раздел 2).
// Цены храним по каждой игре в словаре «единый ключ исхода → цена». Чистая логика (без сети), покрыта тестами.
//
// Три правила, ради которых этот файл существует:
//  1. ПЕРЕЗАГРУЗКА СЕССИИ — НЕ СОБЫТИЕ РЫНКА (2.5). Pinnacle в фиде перезапускается ~каждые 40 минут: все рынки
//     «удаляются» и появляются заново. Если превращать это в «удалён/добавлен/цена изменилась», получаются сотни
//     тысяч ложных движений. Поэтому: старый словарь цен откладываем, применяем новую базу, сравниваем — и считаем
//     изменением только то, что реально изменилось.
//  2. ЗАМОРОЗКА НА СТАРТЕ (2.6). Любое изменение со временем t ≥ старта игры игнорируется. То, что осталось, и есть
//     цена закрытия прематча. Удаление игры из фида состояние не стирает.
//  3. ВЛАДЕЛЕЦ КЛЮЧА (4.4). У Betano несколько рынков дают один ключ (обычный и «азиатский» тотал с той же линией).
//     Ключ принадлежит первому занявшему его рынку; остальные игнорируются, пока владелец не снят.
const { classifyPinnacle, classifyBetano } = require("./markets.cjs");

class BookState {
  // opts.acceptGame(game) → брать ли игру (фильтр видов спорта). opts.now() → текущее время, мс.
  constructor(book, opts = {}) {
    this.book = book;
    this.classify = book === "Betano" ? classifyBetano : classifyPinnacle;
    this.acceptGame = opts.acceptGame || (() => true);
    this.now = opts.now || (() => Date.now());
    this.games = new Map();      // textId игры → модель игры
    this.gs = new Map();         // textId игры → состояние цен
    this.m2g = new Map();        // textId рынка → textId игры (обновление цены приходит без модели)
    this.dirty = new Set();      // игры, у которых что-то изменилось с прошлой оценки
    this.newGames = [];          // игры, появившиеся с прошлого забора (для сопоставления)
    this.sessionGuid = null;
    this.cursor = null;          // writeTime последнего применённого снимка
    this.reloads = 0;
  }

  _fresh(prev) {
    return {
      mk: new Map(),             // textId рынка → { key, price, eventId } — все классифицированные рынки игры
      prices: new Map(),         // ключ → { price, owner } — цена владельца ключа
      last: prev ? prev.last : new Map(),   // ключ → последняя ненулевая цена (рынок могут снять за минуты до старта)
      prev: prev ? prev.prev : new Map(),   // ключ → цена ПЕРЕД текущей (для счёта «возвратов»)
      changes: prev ? prev.changes : 0,     // число изменений цены
      returns: prev ? prev.returns : 0,     // из них возвратов к прежней цене («мигание», раздел 8)
    };
  }
  _gs(gid) { let s = this.gs.get(gid); if (!s) { s = this._fresh(null); this.gs.set(gid, s); } return s; }

  startMs(gid) { const g = this.games.get(gid); return g ? Number(g.startTimeStamp) * 1000 : 0; }
  frozen(gid, t) { const s = this.startMs(gid); return s > 0 && t >= s; }

  // Мигающий матч (раздел 8): изменений не меньше 40 и доля возвратов больше 45%.
  flicker(gid) { const s = this.gs.get(gid); return !!s && s.changes >= 40 && s.returns / s.changes > 0.45; }

  setGame(model) {
    if (!model || !model.textId || !this.acceptGame(model)) return;
    const had = this.games.has(model.textId);
    this.games.set(model.textId, had ? { ...this.games.get(model.textId), ...model, removed: false } : { ...model });
    if (!had) this.newGames.push(model.textId);
  }

  // Изменение цены владельца ключа. silent — применение базы при перезагрузке: движения не считаем (см. reload).
  _setPrice(s, gid, key, price, silent) {
    const cur = s.prices.get(key);
    if (cur.price === price) return;
    if (!silent) {
      s.changes++;
      if (s.prev.get(key) === price) s.returns++;
      s.prev.set(key, cur.price);
      this.dirty.add(gid);
    }
    cur.price = price;
    if (price > 0) s.last.set(key, price);
  }

  setMarket(model, t, silent) {
    if (!model || !model.textId) return;
    const gid = model.gameTextId, game = this.games.get(gid);
    if (!game) return;                                   // рынок без известной игры пропускаем
    if (this.frozen(gid, t)) return;
    const c = this.classify(model, game);
    const s = this._gs(gid);
    if (!c) { if (s.mk.has(model.textId)) this.removeMarket(model.textId, gid, t, silent); return; }
    const price = Number(model.marketValue);
    this.m2g.set(model.textId, gid);
    s.mk.set(model.textId, { key: c.key, price, eventId: model.eventId || "" });
    const cur = s.prices.get(c.key);
    if (!cur) {
      s.prices.set(c.key, { price, owner: model.textId });
      if (price > 0) s.last.set(c.key, price);
      if (!silent) this.dirty.add(gid);
    } else if (cur.owner === model.textId) this._setPrice(s, gid, c.key, price, silent);
    // иначе ключ занят другим рынком — этот ждёт, пока владельца не снимут
  }

  updateMarket(textId, value, gameTextId, t, silent) {
    const gid = this.m2g.get(textId) || gameTextId;
    const s = this.gs.get(gid); const rec = s && s.mk.get(textId);
    if (!rec || this.frozen(gid, t)) return;
    const price = Number(value);
    if (!(price > 0)) return;
    rec.price = price;
    const cur = s.prices.get(rec.key);
    if (cur && cur.owner === textId) this._setPrice(s, gid, rec.key, price, silent);
  }

  removeMarket(textId, gameTextId, t, silent) {
    const gid = this.m2g.get(textId) || gameTextId;
    const s = this.gs.get(gid); const rec = s && s.mk.get(textId);
    if (!rec || this.frozen(gid, t)) return;
    s.mk.delete(textId); this.m2g.delete(textId);
    const cur = s.prices.get(rec.key);
    if (!cur || cur.owner !== textId) return;
    // владелец снят → ключ переходит следующему рынку с тем же ключом (смена владельца — не движение цены)
    let heir = null;
    for (const [id, r] of s.mk) if (r.key === rec.key) { heir = [id, r]; break; }
    if (heir) { s.prices.set(rec.key, { price: heir[1].price, owner: heir[0] }); if (heir[1].price > 0) s.last.set(rec.key, heir[1].price); }
    else s.prices.delete(rec.key);
    if (!silent) this.dirty.add(gid);
  }

  // Один снимок изменений. Возврат false, если снимок из ЧУЖОЙ сессии (нужна полная перезагрузка).
  applySnapshot(snap, silent) {
    if (!snap) return true;
    if (this.sessionGuid && snap.sessionGuid && snap.sessionGuid !== this.sessionGuid && !silent) return false;
    const t = snap.writeTime ? Date.parse(snap.writeTime) : this.now();
    for (const it of snap.gamesAdded || []) this.setGame(it.gameModel || it);
    for (const it of snap.gamesUpdated || []) {
      if (it.gameModel) this.setGame(it.gameModel);
      else { const g = this.games.get(it.textId); if (g) { if (it.currentScore != null) g.currentScore = it.currentScore; if (it.statusType != null) g.statusType = it.statusType; } }
    }
    for (const it of snap.marketsRemoved || []) this.removeMarket(it.textId, it.gameTextId, t, silent);
    for (const it of snap.marketsAdded || []) { if (it.marketModel) this.setMarket(it.marketModel, t, silent); }
    for (const it of snap.marketsUpdated || []) {
      if (it.marketModel) this.setMarket(it.marketModel, t, silent);
      else this.updateMarket(it.textId, it.value, it.gameTextId, t, silent);
    }
    for (const it of snap.gamesRemoved || []) { const g = this.games.get(it.textId); if (g) g.removed = true; } // состояние НЕ стираем
    if (snap.sessionGuid) this.sessionGuid = snap.sessionGuid;
    if (snap.writeTime && (!this.cursor || snap.writeTime > this.cursor)) this.cursor = snap.writeTime;
    return true;
  }

  // Полная (пере)загрузка из ответа GetBookmakerData. Возврат { changed, removed, added } — что РЕАЛЬНО
  // изменилось относительно состояния до перезагрузки (на первой загрузке всё «added»).
  reload(data) {
    const t = this.now();
    const old = new Map();
    for (const [gid, s] of this.gs) {
      if (this.frozen(gid, t)) continue;                 // начавшиеся игры заморожены — их не трогаем
      old.set(gid, s);
      this.gs.set(gid, this._fresh(s));                  // пустой словарь цен, счётчики движений сохраняются
      for (const id of s.mk.keys()) this.m2g.delete(id);
    }
    this.sessionGuid = null;
    const gm = (data && data.gamesOriginModel) || {}, mm = (data && data.marketsOriginModel) || {};
    for (const g of Object.values(gm.model || {})) this.setGame(g);
    for (const m of Object.values(mm.model || {})) this.setMarket(m, t, true);
    this.cursor = gm.writeTime || mm.writeTime || this.cursor;
    for (const snap of (data && data.snapshots) || []) this.applySnapshot(snap, true); // снимки из того же ответа новее базы
    // Сравнение «до/после»: движением считаем только реально изменившуюся цену.
    const res = { changed: 0, removed: 0, added: 0 };
    for (const [gid, was] of old) {
      const s = this.gs.get(gid);
      for (const [key, o] of was.prices) {
        const n = s.prices.get(key);
        if (!n) { res.removed++; continue; }             // рынка нет в новой базе → он снят
        if (n.price !== o.price) {
          res.changed++; s.changes++;
          if (s.prev.get(key) === n.price) s.returns++;
          s.prev.set(key, o.price);
        }
      }
      for (const key of s.prices.keys()) if (!was.prices.has(key)) res.added++;
    }
    if (!old.size) for (const s of this.gs.values()) res.added += s.prices.size;
    for (const gid of this.gs.keys()) if (!this.frozen(gid, t)) this.dirty.add(gid); // пары — на пересчёт
    this.reloads++;
    return res;
  }

  takeNewGames() { const a = this.newGames; this.newGames = []; return a; }
  price(gid, key) { const s = this.gs.get(gid); const c = s && s.prices.get(key); return c ? c.price : undefined; }
  lastPrice(gid, key) { const s = this.gs.get(gid); return s ? s.last.get(key) : undefined; }
  // id выбора Betano (первая часть eventId) — он же data-selnid кнопки на странице (проверено на лайве).
  selId(gid, key) {
    const s = this.gs.get(gid); const c = s && s.prices.get(key); const r = c && s.mk.get(c.owner);
    return r ? String(r.eventId || "").split("|")[0] : "";
  }
}

module.exports = { BookState };
