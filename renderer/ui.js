"use strict";
// Разделы панели: переключение по клику в левом меню. Выбранный раздел запоминается (если хранилище доступно).
(() => {
  const nav = document.getElementById("nav");
  if (!nav) return;
  const show = (tab) => {
    let found = false;
    for (const p of document.querySelectorAll(".panel")) { const on = p.dataset.panel === tab; p.classList.toggle("on", on); if (on) found = true; }
    if (!found) return false;
    for (const b of nav.querySelectorAll("button[data-tab]")) b.classList.toggle("on", b.dataset.tab === tab);
    const c = document.querySelector(".content"); if (c) c.scrollTop = 0;
    try { localStorage.setItem("tab", tab); } catch (e) { /* хранилище недоступно — не критично */ }
    return true;
  };
  nav.addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) show(b.dataset.tab); });
  let saved = null;
  try { saved = localStorage.getItem("tab"); } catch (e) { /* ignore */ }
  if (saved) show(saved);
})();
