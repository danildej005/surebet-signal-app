"use strict";
// Чтение вилок из окна Electron с surebet. Выполняет JS в странице:
//   • спуфит видимость вкладки (иначе сайт ставит автообновление на паузу),
//   • включает автообновление (кнопка #navigation-autoupdate-button), если выключено,
//   • возвращает HTML таблицы вилок + признак, залогинены ли мы.
// Разбор HTML делает lib/parse.cjs.

const READ_JS = `(() => {
  try {
    try {
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      document.hasFocus = () => true;
    } catch (e) {}
    let paused = false;
    const btn = document.querySelector('#navigation-autoupdate-button');
    if (btn) { const ic = btn.querySelector('i'); if (ic && /play-circle/.test(ic.className)) { btn.click(); paused = true; } }
    const tbl = document.querySelector('#surebets-table');
    const pw = document.querySelector('form[action*="sign_in"] input[type="password"]');
    const loginVisible = !!(pw && pw.offsetParent !== null); // форма входа реально видима (не скрытая модалка)
    const ready = document.readyState === 'complete';          // не во время загрузки/перезагрузки
    const upd = document.querySelector('#autoupdate-last-updated-at-timer');
    return {
      url: location.href,
      loggedOut: /\\/users\\/sign_in/.test(location.href) || (ready && !tbl && loginVisible),
      hasTable: !!tbl,
      html: tbl ? tbl.outerHTML : '',
      paused: paused,
      updText: upd ? upd.textContent.trim() : ''
    };
  } catch (e) { return { error: String(e && e.message || e) }; }
})()`;

async function readSurebet(webContents) {
  if (!webContents || webContents.isDestroyed()) return { error: "окно surebet не готово" };
  try {
    return await webContents.executeJavaScript(READ_JS, true);
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { readSurebet };
