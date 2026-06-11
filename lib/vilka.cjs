"use strict";
// Калькулятор вилки: по кэфам двух плеч, потолкам (максимумы контор) и курсу считает,
// сколько ставить на каждое плечо, чтобы возврат был равен при любом исходе (с учётом валют).
// Betano — EUR, Pinnacle — USD. Курс usdToEur: сколько EUR за 1 USD.
//
// Логика сумм (согласовано):
//  - эффективный потолок на плечо = min(максимум конторы, лимит панели).
//    лимит панели задаётся в EUR; для USD-плеча конвертируется по курсу.
//  - балансируем по наибольшей сумме, влезающей в ОБА потолка;
//  - если получилось упереться в лимит — просто ставим меньше (плечи пересчитаны под потолок).
//  - максимумы контор проверяем ВСЕГДА (могут не дать собрать вилку нужного размера).

const round2 = (x) => Math.floor(Number(x) * 100) / 100; // вниз до копеек — не превышаем потолок

// oddsEur — кэф Betano (EUR), oddsUsd — кэф Pinnacle (USD), usdToEur — курс (EUR за 1 USD).
// maxEur/maxUsd — максимумы контор в их валюте; limitEur — лимит панели на плечо (EUR), опционально.
function vilkaStakes({ oddsEur, oddsUsd, usdToEur, maxEur = Infinity, maxUsd = Infinity, limitEur = Infinity } = {}) {
  oddsEur = Number(oddsEur); oddsUsd = Number(oddsUsd); usdToEur = Number(usdToEur);
  if (!(oddsEur > 1) || !(oddsUsd > 1)) return { ok: false, error: "кэфы должны быть > 1" };
  if (!(usdToEur > 0)) return { ok: false, error: "нет курса USD→EUR" };

  // эффективные потолки на плечо (в своей валюте)
  const capEur = Math.min(Number(maxEur), Number(limitEur));
  const capUsd = Math.min(Number(maxUsd), Number.isFinite(limitEur) ? limitEur / usdToEur : Infinity);
  if (!(capEur > 0) || !(capUsd > 0)) return { ok: false, error: "нулевой потолок (макс/лимит)" };

  // баланс: возврат равен в EUR при любом исходе → sEur*oEur = sUsd*oUsd*курс.
  // упираемся в EUR-потолок; если USD-плечо при этом вылазит за свой потолок — упираемся в USD.
  let sEur = capEur;
  let sUsd = (sEur * oddsEur) / (oddsUsd * usdToEur);
  let bind = "eur";
  if (sUsd > capUsd) {
    sUsd = capUsd;
    sEur = (sUsd * oddsUsd * usdToEur) / oddsEur;
    bind = "usd";
  }
  sEur = round2(sEur); sUsd = round2(sUsd);
  if (!(sEur > 0) || !(sUsd > 0)) return { ok: false, error: "суммы вышли в ноль" };

  const totalEur = sEur + sUsd * usdToEur;
  const retIfEur = sEur * oddsEur;                 // если зашло Betano-плечо (EUR)
  const retIfUsd = sUsd * oddsUsd * usdToEur;       // если зашло Pinnacle-плечо (USD→EUR)
  const worst = Math.min(retIfEur, retIfUsd);       // гарантированный (худший) возврат
  const profitEur = worst - totalEur;
  const profitPct = totalEur > 0 ? (profitEur / totalEur) * 100 : 0;

  return {
    ok: profitEur > 0,                              // настоящая вилка только если плюс гарантирован
    eur: sEur, usd: sUsd, bind,                      // сколько ставить на каждое плечо
    totalEur: round2(totalEur),
    profitEur: round2(profitEur),
    profitPct: Math.round(profitPct * 100) / 100,
    returnIfEur: round2(retIfEur), returnIfUsd: round2(retIfUsd),
  };
}

module.exports = { vilkaStakes, round2 };
