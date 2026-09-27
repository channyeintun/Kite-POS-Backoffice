// What `money.ts` and `i18n.ts` must say.
//
// Run with `npm test`. There is no DOM in here and none is needed: these two
// modules are pure functions over values, which is what makes the formatting
// of every price in the shop checkable without a browser. Node runs the
// TypeScript directly; nothing is compiled first.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as money from "../src/money.ts";
import * as i18n from "../src/i18n.ts";

const mmk = money.kyat();
const usd: money.Currency = { code: "USD", symbol: "$", minor_units: 2, symbol_first: true };
const ks: money.Currency = { code: "MMK", symbol: "Ks", minor_units: 0, symbol_first: false };

const checks: [string, string, string][] = [
  ["31700 MMK", money.show(31700, mmk), "K31,700"],
  ["zero", money.show(0, mmk), "K0"],
  ["under a thousand", money.show(900, mmk), "K900"],
  ["exactly a thousand", money.show(1000, mmk), "K1,000"],
  ["millions", money.show(1234567, mmk), "K1,234,567"],
  ["the sign goes outside the symbol", money.show(-300, mmk), "-K300"],
  ["symbol last", money.show(31700, ks), "31,700 Ks"],
  ["cents", money.show(1299, usd), "$12.99"],
  ["padded, so it is not $12.5", money.show(1250, usd), "$12.50"],
  ["under a unit", money.show(5, usd), "$0.05"],
  ["grouped with cents", money.show(123456, usd), "$1,234.56"],
  ["a count is not a decimal", money.quantity(3.0), "3"],
  ["a weighed quantity is", money.quantity(0.35), "0.35"],
  ["half", money.quantity(2.5), "2.5"],
  ["three decimals", money.quantity(1.125), "1.125"],
  ["english", i18n.t("En", "total"), "TOTAL"],
  ["burmese", i18n.t("My", "total"), "စုစုပေါင်း"],
  ["a key with no phrase falls through", i18n.t("En", "nope"), "nope"],
  ["the switch goes both ways", i18n.code_of(i18n.other("En")), "my"],
];

for (const [what, got, want] of checks) {
  test(what, () => {
    assert.equal(got, want);
  });
}

test("an amount is read as digits, and anything else is refused", () => {
  assert.equal(money.from_text("1,200", mmk), 1200);
  assert.equal(money.from_text("1,200.00", mmk), null);
  assert.equal(money.from_text("12.5", usd), 1250);
  assert.equal(money.from_text("1.005", usd), null);
  assert.equal(money.from_text("", mmk), null);
  assert.equal(money.from_text("-300", mmk), -300);
  assert.equal(money.from_text("abc", mmk), null);
});
