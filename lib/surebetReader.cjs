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
    const btn = document.querySelector('#navigation-autoupdate-button');
    if (btn) { const ic = btn.querySelector('i'); if (ic && /play-circle/.test(ic.className)) btn.click(); }
    const tbl = document.querySelector('#surebets-table');
    const loginForm = document.querySelector('form[action*="sign_in"] input[type="password"]');
    return {
      url: location.href,
      loggedOut: /\\/users\\/sign_in/.test(location.href) || (!!loginForm && !tbl),
      hasTable: !!tbl,
      html: tbl ? tbl.outerHTML : ''
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
