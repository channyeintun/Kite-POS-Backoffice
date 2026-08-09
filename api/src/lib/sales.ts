import { extend, spread, taxOn, taxWithin } from "./money.js";
import { bestOffer, type Promotion, type Priced } from "./pricing.js";
import { all, stmt } from "./db.js";

/**
 * Recomputing a sale.
 *
 * **This is the only writer of any derived amount in the system.** Every
 * `total`, `tax`, `promo_saved` and `subtotal` on a sale or one of its lines is
 * written here and nowhere else, so there is exactly one place where the
 * arithmetic can be wrong and exactly one place to look when a receipt does not
 * add up. Adding an item, changing a quantity, taking a discount, applying an
 * override and voiding a line all end in a call to `recalc`.
 */

export type LineRow = {
  /** The product's Burmese name *now*, for display. Not the receipt's record. */
  name_my?: string;
  id: string;
  sale_id: string;
  product_id: string | null;
  name: string;
  sku: string;
  qty: number;
  unit_price: number;
  list_price: number;
  line_discount: number;
  promo_id: string | null;
  promo_name: string;
  promo_saved: number;
  price_override: number;
  tax_bp: number;
  tax: number;
  total: number;
  cost: number;
  min_age: number;
  age_checked: number;
  sort: number;
  /** Joined from the product, for scoping category offers. Not a column. */
  category_id?: string | null;
};

export type SaleRow = {
  id: string;
  client_id: string | null;
  number: number | null;
  register_id: string | null;
  shift_id: string | null;
  user_id: string;
  customer_id: string | null;
  status: "held" | "completed" | "voided";
  hold_label: string;
  /** The input: a discount on the whole basket. See `basket_discount` in 0001. */
  basket_discount: number;
  subtotal: number;
  promo_saved: number;
  discount: number;
  tax: number;
  total: number;
  void_reason: string;
  created_at: number;
  completed_at: number | null;
};

export type Totals = {
  subtotal: number;
  promoSaved: number;
  discount: number;
  tax: number;
  total: number;
};

export type Recalculated = {
  lines: LineRow[];
  totals: Totals;
};

/**
 * Price every line, then the basket.
 *
 * The order matters and is the whole of the pricing policy:
 *
 *   1. A **price override** replaces the shelf price and suppresses offers.
 *   2. Otherwise the best live **offer** is chosen (see `pricing.ts`).
 *   3. A **line discount** comes off what is left.
 *   4. A **basket discount** is spread across the lines by value.
 *   5. **Tax** is computed last, per line, from what the line actually costs.
 *
 * Tax is per line rather than on the basket total because rates differ by
 * product, and extracting one blended rate from a mixed basket is a figure that
 * agrees with nothing an auditor can recompute.
 */
export function priceSale(
  lines: readonly LineRow[],
  promotions: readonly Promotion[],
  basketDiscount: number,
  taxInclusive: boolean,
  at: number,
): Recalculated {
  const priced: LineRow[] = [];

  for (const line of lines) {
    const overridden = line.price_override === 1;
    const shelf = overridden ? line.unit_price : line.list_price;
    const candidate: Priced = {
      productId: line.product_id,
      categoryId: line.category_id ?? null,
      qty: line.qty,
      listPrice: shelf,
      overridden,
    };

    const listValue = extend(line.qty, shelf);
    const offer = bestOffer(promotions, candidate, at);
    const afterOffer = offer ? offer.lineTotal : listValue;

    // A line discount cannot make a line negative. A cashier who types more
    // than the line is worth has made a mistake, and a free item is the
    // charitable reading of it.
    const lineDiscount = Math.min(Math.max(0, line.line_discount), afterOffer);

    priced.push({
      ...line,
      list_price: shelf,
      unit_price: shelf,
      promo_id: offer?.promoId ?? null,
      promo_name: offer?.name ?? "",
      promo_saved: offer?.saved ?? 0,
      line_discount: lineDiscount,
      total: afterOffer - lineDiscount,
    });
  }

  // The basket discount is apportioned by what each line is actually worth
  // after its own offer, so a line already cut in half does not absorb a share
  // sized by a price nobody is paying.
  const netTotals = priced.map((l) => l.total);
  const netSum = netTotals.reduce((a, b) => a + b, 0);
  const basket = Math.min(Math.max(0, basketDiscount), netSum);
  const shares = basket > 0 ? spread(basket, netTotals) : netTotals.map(() => 0);

  let subtotal = 0;
  let promoSaved = 0;
  let tax = 0;
  let total = 0;

  for (let i = 0; i < priced.length; i++) {
    const line = priced[i]!;
    const share = shares[i]!;
    const lineTotal = Math.max(0, line.total - share);
    const lineTax = taxInclusive ? taxWithin(lineTotal, line.tax_bp) : taxOn(lineTotal, line.tax_bp);

    line.total = lineTotal;
    line.tax = lineTax;

    subtotal += extend(line.qty, line.list_price);
    promoSaved += line.promo_saved;
    tax += lineTax;
    total += taxInclusive ? lineTotal : lineTotal + lineTax;
  }

  return {
    lines: priced,
    totals: {
      subtotal,
      promoSaved,
      // What came off, all told: line discounts and the basket's own.
      discount: priced.reduce((a, l) => a + l.line_discount, 0) + basket,
      tax,
      total,
    },
  };
}

/** Offers that could bear on a basket rung now. */
export async function livePromotions(db: D1Database, at: number): Promise<Promotion[]> {
  return await all<Promotion>(
    db,
    `SELECT id, name, name_my, kind, value, n, scope, product_id, category_id,
            starts_at, ends_at, priority, created_at
       FROM promotions
      WHERE active = 1
        AND (starts_at IS NULL OR starts_at <= ?1)
        AND (ends_at   IS NULL OR ends_at   >= ?1)`,
    at,
  );
}

/** The lines of a sale, with the category each product sits in. */
export async function linesOf(db: D1Database, saleId: string): Promise<LineRow[]> {
  return await all<LineRow>(
    db,
    // `i.name` is the snapshot the receipt is printed from and must not move.
    // `p.name_my` is joined live, for the *screen* only — a cashier working in
    // မြန်မာ scans a tile that reads ကြက်ဥ ၁၀ လုံး and the ledger beside it
    // said "Eggs, tray of 10".
    `SELECT i.*, p.category_id AS category_id, COALESCE(p.name_my, '') AS name_my
       FROM sale_items i LEFT JOIN products p ON p.id = i.product_id
      WHERE i.sale_id = ?1
      ORDER BY i.sort, i.rowid`,
    saleId,
  );
}

/**
 * Write the recomputed figures back.
 *
 * Returned as statements rather than executed, so a caller can put them in the
 * same `batch` as whatever caused the change — a scan and the totals it implies
 * land together or not at all.
 *
 * `basket_discount` is deliberately **not** written here. It is the operator's
 * input to this calculation, and a function that overwrites its own input with
 * its output is one that gives a different answer every time it is called.
 */
export function writeBack(
  db: D1Database,
  saleId: string,
  result: Recalculated,
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const line of result.lines) {
    out.push(
      stmt(
        db,
        `UPDATE sale_items
            SET unit_price = ?2, list_price = ?3, line_discount = ?4, promo_id = ?5,
                promo_name = ?6, promo_saved = ?7, tax = ?8, total = ?9
          WHERE id = ?1`,
        line.id,
        line.unit_price,
        line.list_price,
        line.line_discount,
        line.promo_id,
        line.promo_name,
        line.promo_saved,
        line.tax,
        line.total,
      ),
    );
  }
  const t = result.totals;
  out.push(
    stmt(
      db,
      `UPDATE sales SET subtotal = ?2, promo_saved = ?3, discount = ?4, tax = ?5, total = ?6
        WHERE id = ?1`,
      saleId,
      t.subtotal,
      t.promoSaved,
      t.discount,
      t.tax,
      t.total,
    ),
  );
  return out;
}
