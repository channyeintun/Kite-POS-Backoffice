// What `lang.ts` must say: the reading rules every form in the shop leans on.
//
// Run with `npm test`, beside the money tests, and for the same reason: these
// are pure functions over strings, so every edge a person can type is
// checkable without a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parse_float, parse_int, trim } from "../src/lang.ts";

test("a whole number is digits with an optional minus, and nothing else", () => {
  assert.equal(parse_int("0"), 0);
  assert.equal(parse_int("-0"), 0);
  assert.equal(parse_int("007"), 7);
  assert.equal(parse_int("-12"), -12);
  assert.equal(parse_int(""), null);
  assert.equal(parse_int("-"), null);
  assert.equal(parse_int("+1"), null);
  assert.equal(parse_int(" 1"), null);
  assert.equal(parse_int("12a"), null);
  assert.equal(parse_int("١٢"), null);
});

test("a whole number too long to hold exactly is nothing", () => {
  assert.equal(parse_int("9007199254740991"), 9007199254740991);
  assert.equal(parse_int("9007199254740992"), null);
  assert.equal(parse_int("99999999999999999999"), null);
  assert.equal(parse_int("-99999999999999999999"), null);
  assert.equal(parse_float("99999999999999999999.5"), null);
  assert.equal(parse_float("0.12345678901234567890"), null);
});

test("a fraction is read from the two whole numbers either side of the point", () => {
  assert.equal(parse_float("1.5"), 1.5);
  assert.equal(parse_float("-1.5"), -1.5);
  assert.equal(parse_float(".5"), 0.5);
  assert.equal(parse_float("5."), null);
  assert.equal(parse_float("1e3"), null);
});

test("trimming strips Unicode White_Space and nothing else", () => {
  assert.equal(trim("  a b \t\n"), "a b");
  assert.equal(trim("\u0085x\u3000"), "x");
  assert.equal(trim("\ufeffx"), "\ufeffx");
});
