//! The handful of rules every other module leans on, written down once.
//!
//! JavaScript's own versions of these are close to what the shop needs and
//! differ at exactly the edges a till reaches: `parseInt("12abc")` is 12,
//! `Math.round(-2.5)` is -2, and `"😀".length` is 2. Each function here says
//! which of those answers this application gives instead, and every module that
//! reads a number a person typed, rounds an amount or counts the characters of
//! a label goes through one of them.

/**
 * A whole number, or `null`. A leading `-` and digits, and nothing else: no
 * spaces, no `+`, no separators, no trailing units. A caller who wants those
 * trims first, which is a decision this cannot make for them.
 *
 * Read as 64-bit integer arithmetic reads it, wrapping and all: twenty nines
 * are 7,766,279,631,452,241,919, not a refusal, and a figure past 2^53 that
 * does fit is held as the nearest double. Nobody types either on purpose, and
 * one typed by accident reaches the Worker as the number it always has.
 */
export function parse_int(text: string): number | null {
  if (!/^-?[0-9]+$/.test(text)) {
    return null;
  }
  return Number(BigInt.asIntN(64, BigInt(text)));
}

/**
 * A number with an optional fractional part, or `null`. No exponent, no `+`,
 * no leading or trailing spaces, and a point must have a digit after it:
 * `.5` is a half and `5.` is nothing.
 *
 * Built from the two whole numbers either side of the point, the way every
 * quantity in this application has always been read, so a figure typed into a
 * form reaches the Worker as the same double it always did.
 */
export function parse_float(text: string): number | null {
  const point = text.indexOf(".");
  if (point < 0) {
    return parse_int(text);
  }
  const left = text.slice(0, point);
  const right = text.slice(point + 1);
  if (right.length === 0) {
    return null;
  }
  const whole = parse_int(left.length === 0 ? "0" : left);
  const fraction = parse_int(right);
  if (whole === null || fraction === null) {
    return null;
  }
  let scale = 1.0;
  for (let i = 0; i < right.length; i++) {
    scale = scale * 10.0;
  }
  const magnitude = Math.abs(whole) + fraction / scale;
  if (text.startsWith("-")) {
    return 0.0 - magnitude;
  }
  return magnitude;
}

/**
 * Rounded to the nearest whole number, halves away from zero: 2.5 is 3 and
 * -2.5 is -3. `Math.round` sends -2.5 to -2, which on a refund is a kyat the
 * customer is short.
 */
export function round_to(x: number): number {
  return trunc_to(x < 0 ? 0 - Math.floor(0 - x + 0.5) : Math.floor(x + 0.5));
}

/**
 * Truncated towards zero — the cast, named, and a 64-bit one: a value past
 * either end of that range is held at the end (±2^63, as the nearest doubles
 * have it), and NaN is 0. An amount is never that large, and a figure read off
 * the wire that is comes out as the same number it always did.
 */
export function trunc_to(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }
  const t = Math.trunc(clamp(x, -INT_END, INT_END));
  return t === 0 ? 0 : t;
}

/** 2^63: where a 64-bit whole number runs out, either way. */
const INT_END = 9223372036854775808;

/** Whole-number division, towards zero, as integer arithmetic does it. */
export function div(a: number, b: number): number {
  return trunc_to(a / b);
}

/** Held within `[low, high]`. */
export function clamp(x: number, low: number, high: number): number {
  return Math.min(Math.max(x, low), high);
}

/** Floating-point equality within a tolerance. */
export function approx_eq(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

/**
 * How many characters a string has — characters a reader sees one of, not the
 * UTF-16 halves JavaScript counts. A label padded to a column has to be
 * measured the way it will be read.
 */
export function str_len(s: string): number {
  let n = 0;
  for (const _ of s) {
    n++;
  }
  return n;
}

/** Characters `from` up to `to`, counted as [`str_len`] counts them. */
export function str_slice(s: string, from: number, to: number): string {
  return Array.from(s).slice(from, to).join("");
}

/**
 * Upper case for ASCII letters only. Case is a property of a language rather
 * than of a character, and a name's initials are drawn exactly as it was
 * written apart from those 26 letters.
 */
export function upper(text: string): string {
  return text.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** At least `width` characters, padded on the left with `with`. */
export function pad_start(text: string, width: number, with_: string): string {
  if (with_.length === 0) {
    return text;
  }
  let out = text;
  while (str_len(out) < width) {
    out = with_ + out;
  }
  return out;
}

/**
 * `s` without whitespace at either end, where whitespace is Unicode's
 * White_Space property and nothing else.
 *
 * `String.prototype.trim` differs at two characters: it strips U+FEFF, the
 * byte-order mark, which is not whitespace, and keeps U+0085, the next-line
 * control, which is. A barcode that arrives with a byte-order mark stuck to it
 * is not the code on the shelf, and every field a person types into is
 * trimmed here, so it is looked up exactly as it was read.
 */
export function trim(s: string): string {
  return s.replace(WHITE_SPACE_ENDS, "");
}

const WHITE_SPACE_ENDS =
  /^[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** The words of `s`, with runs of spaces collapsed. */
export function words(s: string): string[] {
  return trim(s).split(" ").filter((w) => w.length > 0);
}

/**
 * A whole number with every digit written out, as a 64-bit integer prints.
 *
 * `String` agrees below 2^53. Above it every double is still a whole number,
 * but `String` writes the shortest spelling that reads back as the same double
 * and pads it with zeros, so 7,766,279,631,452,241,920 — twenty nines, wrapped
 * — would read 7,766,279,631,452,242,000 in one place and its real digits
 * everywhere the Worker sends it back.
 */
export function int_text(n: number): string {
  return Number.isInteger(n) && !Number.isSafeInteger(n) ? BigInt(n).toString() : `${n}`;
}

/** Every occurrence of `from` replaced by `to`. */
export function replace(s: string, from: string, to: string): string {
  if (from.length === 0) {
    return s;
  }
  return s.split(from).join(to);
}

/**
 * `items` in the order `less` puts them, keeping items it does not separate in
 * the order they were given.
 */
export function sorted<T>(items: readonly T[], less: (a: T, b: T) => boolean): T[] {
  return [...items].sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
}

/**
 * A fresh idempotency key: sixteen random bytes as thirty-two hex digits.
 */
export function token(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
