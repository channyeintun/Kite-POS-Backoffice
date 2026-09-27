//! JSON, read with fallbacks.
//!
//! A naming layer rather than an implementation: `Doc` is whatever
//! `JSON.parse` produced — or `undefined` for a value that is not there — and
//! every function below is one line over it. Two things earn the layer its
//! keep:
//!
//!   * The accessors take a fallback and return a plain value, which is the
//!     shape a screen wants: the API is ours, its shape is a contract, and a
//!     missing field is its empty value rather than an optional that a
//!     thousand call sites have to unwrap.
//!   * `int_of` rounds where a cast truncates. Every amount of money in this
//!     application crossed the wire as a JSON number.
//!
//! **Only the right type counts.** A field that is present with the wrong type
//! — `"3"` where a number was wanted, `1` where a boolean was — reads as its
//! fallback, exactly as a missing one does. `JSON.parse` is lenient about
//! nothing, and neither is this.

import { round_to } from "./lang.ts";

/** A JSON value, or nothing. */
export type Doc = unknown;

/** A value that is not there. */
export function nothing(): Doc {
  return undefined;
}

/**
 * Whether a value is absent — **or explicitly `null`**, which is the same
 * question a caller is asking.
 */
export function missing(d: Doc): boolean {
  return d === undefined || d === null;
}

export function is_object(d: Doc): d is Record<string, unknown> {
  return typeof d === "object" && d !== null && !Array.isArray(d);
}

// ---- reading ---------------------------------------------------------------

/** A body as a document, or an error saying it is not one. */
export function parse(body: string): Doc {
  try {
    return JSON.parse(body) as Doc;
  } catch (e) {
    throw new Error(`that is not JSON: json: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * A field of an object, or nothing.
 *
 * Every accessor answers with nothing rather than failing, which is what makes
 * them chain: `field(field(d, "sale"), "total")` reads left to right and is
 * absent the moment anything on the path is.
 */
export function field(d: Doc, name: string): Doc {
  if (!is_object(d)) {
    return undefined;
  }
  return Object.hasOwn(d, name) ? d[name] : undefined;
}

/** The elements of an array, or nothing at all. */
export function items(d: Doc): Doc[] {
  return Array.isArray(d) ? d : [];
}

/** This value as text, or "" when it is not text. */
export function text_of(d: Doc): string {
  return typeof d === "string" ? d : "";
}

export function text(d: Doc, name: string, fallback: string): string {
  const v = field(d, name);
  return typeof v === "string" ? v : fallback;
}

/** A number held directly, or nothing. */
export function number_of(d: Doc): number | null {
  return typeof d === "number" ? d : null;
}

/**
 * A whole-number field, rounded rather than cast.
 *
 * JSON has one numeric type and a count crosses as a double; truncating
 * towards zero is the wrong answer for anything that was a whole number before
 * it crossed — and every amount of money in this application is one.
 */
export function int_of(d: Doc, name: string, fallback: number): number {
  return round_to(number_of(field(d, name)) ?? fallback);
}

/** A quantity, which is the one field that is legitimately fractional. */
export function num_of(d: Doc, name: string, fallback: number): number {
  return number_of(field(d, name)) ?? fallback;
}

export function bool_of(d: Doc, name: string, fallback: boolean): boolean {
  const v = field(d, name);
  return typeof v === "boolean" ? v : fallback;
}

/** An int held directly rather than under a name, for an array of numbers. */
export function as_int(d: Doc): number {
  return round_to(number_of(d) ?? 0);
}
