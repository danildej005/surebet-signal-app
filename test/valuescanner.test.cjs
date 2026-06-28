"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { chunk } = require("../lib/valuescanner.cjs");

test("chunk: бьёт массив турниров по 5 (лимит odds-by-tournaments)", () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5, 6, 7], 5), [[1, 2, 3, 4, 5], [6, 7]]);
  assert.deepStrictEqual(chunk([], 5), []);
  assert.deepStrictEqual(chunk([1, 2], 5), [[1, 2]]);
});
