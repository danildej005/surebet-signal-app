"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseRate, FALLBACK } = require("../lib/fx.cjs");

test("parseRate: frankfurter и er-api (оба кладут rates.EUR)", () => {
  assert.strictEqual(parseRate('{"amount":1,"base":"USD","rates":{"EUR":0.921}}'), 0.921);
  assert.strictEqual(parseRate('{"result":"success","base_code":"USD","rates":{"EUR":0.934,"GBP":0.79}}'), 0.934);
});

test("parseRate: мусор/неадекватный курс → null", () => {
  assert.strictEqual(parseRate("not json"), null);
  assert.strictEqual(parseRate('{"rates":{}}'), null);
  assert.strictEqual(parseRate('{"rates":{"EUR":0}}'), null);
  assert.strictEqual(parseRate('{"rates":{"EUR":9999}}'), null); // защита от бреда
});

test("фолбэк — разумное число", () => {
  assert.ok(FALLBACK > 0.5 && FALLBACK < 1.5);
});
