"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSurebets } = require("../lib/parse.cjs");
const { pickWanted } = require("../lib/filter.cjs");

const HTML = `
<table id="surebets-table">
<tr><th>Доход</th><th>Букмекер</th><th>Событие</th><th>Ставка</th><th>Коэффициент</th></tr>
<tbody class="surebet_record" id="surebet_record_AAA" data-id="AAA" data-signature="sig1" data-profit="-2.14" data-start-at="1780705800">
  <tr data-testid="surebet-leg">
    <td class="profit-box"><span data-testid="surebet-profit">-2.14%</span></td>
    <td class="booker"><a class="bookmaker-name" data-testid="surebet-leg-bookmaker">Betano (PT)</a></td>
    <td class="event"><a data-testid="surebet-leg-event">Mikal Bridges</a></td>
    <td class="coeff">Тотал &#8805;4 ОТ - подборы
      <div class="dropdown-menu"><table><tr><td>вложенная мусорная таблица</td></tr></table></div>
    </td>
    <td class="value"><div><a class="value_link" data-testid="surebet-leg-odds">2.55</a></div></td>
  </tr>
  <tr data-testid="surebet-leg">
    <td class="booker"><a data-testid="surebet-leg-bookmaker">Pinnacle888 (Delayed)</a></td>
    <td class="event"><a data-testid="surebet-leg-event">Mikal Bridges</a></td>
    <td class="coeff">Тм(3.5) ОТ - подборы</td>
    <td class="value"><a data-testid="surebet-leg-odds">1.588</a></td>
  </tr>
</tbody>
<tbody class="surebet_record" data-id="BBB" data-profit="0.80" data-start-at="1780700000">
  <tr data-testid="surebet-leg"><td class="booker"><a data-testid="surebet-leg-bookmaker">Betano (PT)</a></td><td class="event"><a data-testid="surebet-leg-event">A — B</a></td><td class="coeff">П1</td><td class="value"><a data-testid="surebet-leg-odds">2.0</a></td></tr>
  <tr data-testid="surebet-leg"><td class="booker"><a data-testid="surebet-leg-bookmaker">Bet365</a></td><td class="event"><a data-testid="surebet-leg-event">A — B</a></td><td class="coeff">П2</td><td class="value"><a data-testid="surebet-leg-odds">2.1</a></td></tr>
</tbody>
</table>`;

test("парсит обе вилки", () => {
  assert.equal(parseSurebets(HTML).length, 2);
});

test("первая вилка: id, доход, кф Pinnacle (не обрывается на вложенной таблице)", () => {
  const [a] = parseSurebets(HTML);
  assert.equal(a.id, "AAA");
  assert.equal(a.profitPct, -2.14);
  assert.equal(a.legs.length, 2);
  const pin = a.legs.find((l) => /pinnacle/i.test(l.book));
  assert.ok(pin);
  assert.equal(pin.odds, 1.588);
  assert.equal(a.event, "Mikal Bridges");
});

test("сущности раскодируются (&#8805; → ≥)", () => {
  const [a] = parseSurebets(HTML);
  assert.match(a.legs.find((l) => /betano/i.test(l.book)).outcome, /≥4/);
});

test("связка с фильтром: нужная только с Pinnacle", () => {
  const w = pickWanted(parseSurebets(HTML), "pinnacle");
  assert.equal(w.length, 1);
  assert.equal(w[0].id, "AAA");
});

test("мусор не валит парсер", () => {
  assert.deepEqual(parseSurebets(""), []);
  assert.deepEqual(parseSurebets(null), []);
});
