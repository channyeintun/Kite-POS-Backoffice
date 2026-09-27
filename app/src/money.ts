//! Money, as a person reads it.
//!
//! Every amount that crosses from the API is a whole count of the currency's
//! minor unit — kyat for MMK, cents for USD — and stays an integer for its
//! whole life in this program. Nothing here does arithmetic on a price: the
//! server owns every total, and this file's only job is deciding where the
//! separators go.
//!
//! **Money does not translate.** Amounts, quantities, SKUs and dates are shown
//! in Latin digits whatever the interface language is, exactly as the shop's
//! current till does. The chrome switches; the numbers do not.

import { approx_eq, div, int_text, pad_start, parse_int, round_to, trunc_to } from "./lang.ts";

/** How this shop writes an amount down. Read once, from the API. */
export interface Currency {
  code: string;
  symbol: string;
  /** Digits after the separator: 0 for MMK, 2 for a currency with cents. */
  minor_units: number;
  symbol_first: boolean;
}

export function kyat(): Currency {
  return { code: "MMK", symbol: "K", minor_units: 0, symbol_first: true };
}

/**
 * Digits grouped in threes.
 *
 * Walked forwards with a separator wherever the number of digits still to come
 * is a multiple of three: there is no index to step backwards and nothing to
 * get wrong at the ends.
 */
function grouped(digits: string): string {
  const n = digits.length;
  if (n <= 3) {
    return digits;
  }
  let out = "";
  for (let i = 0; i < n; i++) {
    if (i > 0 && (n - i) % 3 === 0) {
      out = out + ",";
    }
    out = out + digits.slice(i, i + 1);
  }
  return out;
}

/** An amount with its symbol: `K31,700`, `$12.50`. */
export function show(value: number, c: Currency): string {
  const body = plain(value, c);
  // The sign goes outside the symbol — "-K300", never "K-300", where a minus
  // between the symbol and the digits reads as part of the number.
  if (value < 0) {
    const unsigned = body.slice(1);
    if (c.symbol_first) {
      return `-${c.symbol}${unsigned}`;
    }
    return `-${unsigned} ${c.symbol}`;
  }
  if (c.symbol_first) {
    return `${c.symbol}${body}`;
  }
  return `${body} ${c.symbol}`;
}

/** The digits alone, for a column where the symbol is in the heading. */
export function plain(value: number, c: Currency): string {
  const negative = value < 0;
  const magnitude = Math.abs(value);
  let digits = int_text(magnitude);
  if (c.minor_units > 0) {
    digits = pad_start(digits, c.minor_units + 1, "0");
    const cut = digits.length - c.minor_units;
    const whole = grouped(digits.slice(0, cut));
    const frac = digits.slice(cut);
    if (negative) {
      return `-${whole}.${frac}`;
    }
    return `${whole}.${frac}`;
  }
  if (negative) {
    return `-${grouped(digits)}`;
  }
  return grouped(digits);
}

/**
 * A quantity, shown as a count when it is one and as a measurement when not.
 *
 * "×3" and "0.35 kg" are different things and a till that renders the first as
 * "3.00" is asking a cashier to read a decimal point at speed for no reason.
 */
export function quantity(value: number): string {
  const whole = trunc_to(value);
  if (approx_eq(value, whole, 0.0001)) {
    return int_text(whole);
  }
  // Three decimals is a gram on a kilo, which is finer than any shop scale
  // reads — so the trim below can only ever remove two of them.
  const scaled = round_to(value * 1000.0);
  let frac = pad_start(`${scaled % 1000}`, 3, "0");
  if (frac.endsWith("0")) {
    frac = frac.slice(0, 2);
  }
  if (frac.endsWith("0")) {
    frac = frac.slice(0, 1);
  }
  return `${div(scaled, 1000)}.${frac}`;
}

/**
 * An amount as a person wrote it, in whole minor units.
 *
 * Read as **digits, never as a float**. `"1.005"` is really
 * 1.00499999999999989 as a double and would round *down* to 1.00; read as
 * digits it correctly becomes 1.01. More precision than the currency has is a
 * typo rather than a rounding request, and anything that is not an amount is
 * refused rather than read as zero — so a slip in a form cannot quietly become
 * a free item.
 *
 * The same rule as the server's `parseAmount`, because the two have to agree
 * about what somebody typed.
 */
export function from_text(text: string, c: Currency): number | null {
  let body = "";
  for (const ch of text) {
    if (ch === " " || ch === "," || ch === "_") {
      continue;
    }
    body = body + ch;
  }
  if (body.length === 0) {
    return null;
  }
  let negative = false;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  const parts = body.split(".");
  if (parts.length > 2) {
    return null;
  }
  const whole = parts[0];
  const frac = parts.length === 2 ? parts[1] : "";
  if (whole.length === 0 && frac.length === 0) {
    return null;
  }
  if (frac.length > c.minor_units) {
    return null;
  }
  const digits = whole.length === 0 ? "0" : whole;
  let padded = frac;
  for (let i = 0; i < c.minor_units - frac.length; i++) {
    padded = padded + "0";
  }
  const value = parse_int(digits + padded);
  if (value === null) {
    return null;
  }
  if (negative) {
    return 0 - value;
  }
  return value;
}

/**
 * What the operator typed on the keypad, as whole minor units.
 *
 * The keypad only ever produces digits, so this is a digit walk rather than a
 * parse — there is no separator to interpret and no float anywhere near it.
 * An empty entry is nothing rather than zero, so "Add tender" on an untouched
 * keypad is refused rather than adding a payment of zero.
 */
export function from_keys(entry: string, _c: Currency): number | null {
  if (entry.length === 0) {
    return null;
  }
  const parsed = parse_int(entry);
  if (parsed === null) {
    return null;
  }
  // The keypad is in minor units already for a zero-decimal currency; for one
  // with cents the operator types "1250" and means twelve fifty.
  return parsed;
}
