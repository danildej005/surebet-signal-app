"use strict";
// Прелоад страницы surebet: «лучшее усилие» притвориться видимой вкладкой,
// чтобы сайт не ставил автообновление на паузу, когда окно свёрнуто.
// Основное удержание делает READ_JS в lib/surebetReader.cjs на каждом тике.
try {
  Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
  document.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);
} catch (e) { /* ignore */ }
