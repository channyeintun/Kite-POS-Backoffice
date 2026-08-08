import { applyBp, extend, roundHalfUp } from "./money.js";

export type PromoKind = "percent_off" | "amount_off" | "fixed_price" | "n_for_x";

export type Promotion = {
  id: string;
  name: string;
  name_my: string;
  kind: PromoKind;
  value: number;
  n: number;
  scope: "product" | "category" | "all";
  product_id: string | null;
  category_id: string | null;
  starts_at: number | null;
  ends_at: number | null;
  priority: number;
  created_at: number;
};

/** What a line is before an offer has been looked at. */
export type Priced = {
  productId: string | null;
  categoryId: string | null;
  qty: number;
  /** The shelf price for one unit. */
  listPrice: number;
  /** Set when the operator typed a price: an override beats every offer. */
  overridden: boolean;
};

export type Offer = {
  promoId: string;
  name: string;
  nameMy: string;
  /** What the whole line costs with this offer applied. */
  lineTotal: number;
  /** List value less `lineTotal`; always positive when an offer is returned. */
  saved: number;
};

/** Whether an offer is live at this instant, and applies to this line. */
function applies(p: Promotion, line: Priced, at: number): boolean {
  if (p.starts_at !== null && at < p.starts_at) return false;
  if (p.ends_at !== null && at > p.ends_at) return false;
  if (p.scope === "all") return true;
  if (p.scope === "product") return p.product_id !== null && p.product_id === line.productId;
  if (p.scope === "category") return p.category_id !== null && p.category_id === line.categoryId;
  return false;
}

/**
 * What one offer would charge for this line, in whole minor units.
 *
 * Returns the line total, not the saving, because `n_for_x` cannot be expressed
 * as a per-unit discount: three-for-two on seven units is two full groups and
 * one unit at the shelf price, and the arithmetic only closes at the line.
 */
function lineTotalUnder(p: Promotion, line: Priced): number {
  const list = extend(line.qty, line.listPrice);
  switch (p.kind) {
    case "percent_off":
      return list - applyBp(list, p.value);
    case "amount_off": {
      // Per unit, floored at zero — an offer larger than the price makes an
      // item free, never a refund.
      const unit = Math.max(0, line.listPrice - p.value);
      return extend(line.qty, unit);
    }
    case "fixed_price":
      return extend(line.qty, Math.max(0, p.value));
    case "n_for_x": {
      if (p.n <= 0) return list;
      // Only whole groups qualify. A loose-goods line measured at 2.5 units
      // takes two units into the group and prices the remainder normally, which
      // is what a shelf label saying "3 for 2,500" means at the counter.
      const groups = Math.floor(line.qty / p.n);
      if (groups <= 0) return list;
      const remainder = line.qty - groups * p.n;
      return groups * p.value + extend(remainder, line.listPrice);
    }
  }
}

/**
 * The offer that saves the customer the most.
 *
 * Offers do not stack. Every live offer whose scope matches is costed, and the
 * cheapest line total wins — ties break on `priority` and then on the older
 * offer, so the answer never depends on the order rows came back in. A price
 * the operator typed beats all of them: an override is a decision somebody made
 * at the counter and an offer is a rule, and the person is in front of the
 * customer.
 */
export function bestOffer(
  promotions: readonly Promotion[],
  line: Priced,
  at: number,
): Offer | null {
  if (line.overridden || line.qty <= 0) return null;
  const list = extend(line.qty, line.listPrice);

  let winner: Promotion | null = null;
  let winnerTotal = list;

  for (const p of promotions) {
    if (!applies(p, line, at)) continue;
    const total = lineTotalUnder(p, line);
    if (total >= list) continue;
    if (winner === null || total < winnerTotal) {
      winner = p;
      winnerTotal = total;
      continue;
    }
    if (total === winnerTotal) {
      if (p.priority > winner.priority) winner = p;
      else if (p.priority === winner.priority && p.created_at < winner.created_at) winner = p;
    }
  }

  if (winner === null) return null;
  return {
    promoId: winner.id,
    name: winner.name,
    nameMy: winner.name_my,
    lineTotal: winnerTotal,
    saved: list - winnerTotal,
  };
}

/**
 * A unit price implied by a line total, for the receipt.
 *
 * A three-for-two line has no honest per-unit price — this is the average, and
 * it is shown as "900 each" beside the struck-through shelf price rather than
 * being used for any arithmetic. Every total in the system is computed from the
 * line, never rebuilt from this number.
 */
export function impliedUnit(lineTotal: number, qty: number): number {
  if (qty <= 0) return 0;
  return roundHalfUp(lineTotal / qty);
}
