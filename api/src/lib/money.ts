/**
 * Money, as whole minor units.
 *
 * Every amount in this system is an integer count of the currency's minor unit
 * — kyat for MMK, cents for USD — and a float never touches a price, a total or
 * a tax figure. What follows is the handful of operations where the boundary
 * between an exact integer and something else actually is, each rounding once
 * and saying where.
 */

/** Half-up, and away from zero, so −0.5 goes to −1 rather than to 0. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * A quantity times a unit price, as whole minor units.
 *
 * This is the one place a float legitimately meets money: 0.35 kg of loose
 * goods is a measurement, and the product of a measurement and a price has to
 * come back to a whole unit somewhere. It comes back here, once.
 */
export function extend(qty: number, unitPrice: number): number {
  if (Number.isInteger(qty)) return qty * unitPrice;
  return roundHalfUp(qty * unitPrice);
}

/** A percentage of an amount, where the rate is basis points. */
export function applyBp(amount: number, bp: number): number {
  return roundHalfUp((amount * bp) / 10_000);
}

/**
 * The tax inside a tax-inclusive price.
 *
 * `gross × bp / (10000 + bp)`, computed exactly and rounded once at the end.
 * Adding `bp%` to a net figure and subtracting it back does not return the
 * price on the shelf, which is why this is its own function rather than a
 * rearrangement of `applyBp` at the call site.
 */
export function taxWithin(gross: number, bp: number): number {
  if (bp <= 0) return 0;
  return roundHalfUp((gross * bp) / (10_000 + bp));
}

/** The tax added on top of a tax-exclusive price. */
export function taxOn(net: number, bp: number): number {
  if (bp <= 0) return 0;
  return applyBp(net, bp);
}

/**
 * Spread an amount across weights so the parts sum to exactly the whole.
 *
 * A basket discount is apportioned by line value, and the obvious
 * implementation — round each share independently — produces parts that miss
 * the total by a unit or two. The remainder goes to the largest weight rather
 * than to the last line, so the adjustment lands where it is proportionally
 * smallest and a receipt does not show a rounding artefact on a 100-unit item
 * next to a 20,000-unit one.
 *
 * Returns a share per weight, in the order given.
 */
export function spread(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    // Nothing to weigh by. Give it all to the first line rather than dividing
    // by zero or silently dropping the discount.
    const out = new Array<number>(n).fill(0);
    out[0] = total;
    return out;
  }
  const out = weights.map((w) => roundHalfUp((total * w) / sum));
  const drift = total - out.reduce((a, b) => a + b, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < n; i++) if (weights[i]! > weights[biggest]!) biggest = i;
    out[biggest] = out[biggest]! + drift;
  }
  return out;
}

/**
 * An amount typed by a person, read as digits.
 *
 * Never `parseFloat`. `"1.005"` is really 1.00499999999999989 as a double and
 * rounds *down* to 1.00; read as digits it correctly becomes 1.01. Anything
 * that is not an amount is refused rather than read as zero, so a typo at the
 * keypad can never quietly become a free item.
 *
 * @param text   what the operator typed
 * @param minor  digits after the separator for this currency: 0 for MMK, 2 for USD
 */
export function parseAmount(text: string, minor: number): number | null {
  const body = text.trim().replace(/[\s,_']/g, "");
  if (body.length === 0) return null;
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(body);
  if (!m) return null;
  const [, sign, whole = "", frac = ""] = m;
  if (whole.length === 0 && frac.length === 0) return null;
  // More precision than the currency has is a typo, not a rounding request.
  if (frac.length > minor) return null;
  const padded = (frac + "0".repeat(minor)).slice(0, minor);
  const digits = (whole || "0") + padded;
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  return sign === "-" ? -value : value;
}

/** How a currency is written down. Read from settings once per request. */
export type Currency = {
  code: string;
  symbol: string;
  minorUnits: number;
  symbolFirst: boolean;
};

/**
 * An amount, as a person reads it.
 *
 * Grouped in threes and carrying the currency's own separator count. The till
 * shows Latin digits regardless of interface language, because money,
 * quantities, SKUs and dates do not translate.
 */
export function formatAmount(value: number, c: Currency): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(c.minorUnits + 1, "0");
  const cut = digits.length - c.minorUnits;
  const whole = digits.slice(0, cut).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = c.minorUnits > 0 ? "." + digits.slice(cut) : "";
  const body = whole + frac;
  // The sign goes outside the symbol — "-K300", never "K-300". A minus tucked
  // between the symbol and the digits reads as part of the number.
  const withSymbol = c.symbolFirst ? c.symbol + body : body + " " + c.symbol;
  return negative ? "-" + withSymbol : withSymbol;
}
