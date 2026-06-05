"use strict";
// Фильтр «нужной» вилки. Доходность/диапазон коэф. задаются в самом сканере surebet.
// Здесь единственное условие: в вилке участвует контора-получатель (Pinnacle).

const norm = (s) => String(s || "").toLowerCase();

function receiverLegs(surebet, keyword) {
  const k = norm(keyword);
  if (!surebet || !Array.isArray(surebet.legs)) return [];
  return surebet.legs.filter((l) => norm(l.book).includes(k));
}
function isWanted(surebet, keyword) {
  return receiverLegs(surebet, keyword).length > 0;
}
function pickWanted(surebets, keyword) {
  return (surebets || []).filter((s) => isWanted(s, keyword));
}

module.exports = { receiverLegs, isWanted, pickWanted };
