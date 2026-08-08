import { all, batch, one, run, stmt } from "./db.js";
import { newId } from "./crypto.js";
import { conflict, notFound } from "./http.js";
import { extend } from "./money.js";
import { post, refundEntry } from "./ledger.js";

/**
 * Taking goods back.
 *
 * One implementation for both doors — the back office's refund and the lane's
 * Return — because they had the same two defects and fixing them twice is how
 * one of them drifts back.
 *
 * ## What was wrong
 *
 * **The money was re-rounded on every call.** The amount was
 * `round(line.total * qty / line.qty)`, computed afresh each time, and the
 * guard against refunding twice counted only *quantity*. So a 6-unit line
 * charged 1,000 refunded one unit at a time paid `round(166.67) = 167` six
 * times — 1,002 against a line that took 1,000. In the other direction a
 * 3-unit line charged 1,000 paid 333 three times and short-changed the
 * customer by 1. The fix is below: the units that *close a line out* are paid
 * the remainder, so the parts always sum to exactly what the line was charged.
 *
 * **The header and the ledger were unconditional.** Only the `refund_items`
 * inserts were guarded, and they sat in one batch with the `refunds` row and
 * the journal entry — which cannot abort, because an `INSERT … SELECT` that
 * matches nothing is a success. A replay therefore committed a second refunds
 * row and a second journal entry and *then* raised 409, so the drawer was
 * reconciled against a refund that had been refused. Worse, two entries naming
 * the same `sale_item_id` in one request both read `refunded = 0` — nothing
 * had been written yet — and both passed the quantity guard.
 *
 * So this works in three steps: claim the units, read back what actually
 * landed, and derive everything else from that.
 */

export type RefundRequest = {
  saleId: string;
  /** Raw `{sale_item_id, qty}` entries as they arrived. Duplicates are merged. */
  wanted: { sale_item_id: string; qty: number }[];
  reason: string;
  method: string;
  restock: boolean;
  userId: string;
  approvedBy: string;
  /**
   * The drawer session the cash came out of, or null when it did not come out
   * of a drawer at all.
   *
   * This must be the shift that is **open now on the lane paying it**, never
   * the shift the sale was rung on. Charging a refund to the original sale's
   * shift meant a manager refunding today against last week's receipt took the
   * cash out of today's drawer and recorded it against a session that closed
   * days ago: today's count came up short by the refund, the shortfall was
   * booked to cash over and short against a cashier who had done nothing wrong,
   * and the drawer account never returned to zero.
   */
  shiftId: string | null;
  registerId: string | null;
  /**
   * Where cash physically comes from — a lane's drawer, or the safe.
   *
   * The back office has no drawer, so its refunds come from the safe, the same
   * way `expenseEntry` pays a bill in cash. A drawer is reconciled against a
   * physical count that knows about floats, sales, change and till payouts and
   * nothing else; booking a back-office payout against it leaves it short with
   * no shift to explain the difference.
   */
  cashFrom: "drawer" | "safe";
  clientId: string | null;
  at: number;
  accounting: boolean;
  /// What the audit trail calls this: "refund" from the office, "return" at a
  /// lane. The same event, told in the words of the person who did it.
  action: string;
};

/** Floating quantities are compared with a tolerance; money never is. */
const EPS = 1e-9;

type LineState = {
  id: string;
  product_id: string | null;
  qty: number;
  total: number;
  tax: number;
  cost: number;
  refunded_qty: number;
  refunded_amount: number;
  refunded_tax: number;
};

export async function applyRefund(
  db: D1Database,
  r: RefundRequest,
): Promise<{ id: string; total: number; tax: number }> {
  // Store credit has to have somebody to belong to.
  //
  // A liability posted to "store credit owed" with no holder is a credit that
  // can never be drawn down: the `UPDATE customers … WHERE id = (SELECT
  // customer_id …)` matches nothing when the sale was a walk-in, so the shop
  // kept the cash, booked an obligation that sits on the balance sheet forever,
  // and handed the customer a receipt saying they had been refunded. The till
  // already refuses store credit as a *tender* without a customer; this is the
  // same rule at the other end.
  const owner = await one<{ customer_id: string | null }>(
    db,
    "SELECT customer_id FROM sales WHERE id = ?1",
    r.saleId,
  );
  if (r.method === "store_credit" && !owner?.customer_id) {
    throw conflict("no_customer", "store credit has to go to a customer — this sale has none");
  }

  // Merge duplicates first. Two entries for one line in a single request used
  // to read `refunded = 0` twice and both pass the guard, because neither had
  // been written when the other was checked.
  const merged = new Map<string, number>();
  for (const entry of r.wanted) {
    if (entry.qty <= 0) continue;
    merged.set(entry.sale_item_id, (merged.get(entry.sale_item_id) ?? 0) + entry.qty);
  }
  if (merged.size === 0) {
    throw conflict("no_lines", "nothing was chosen to come back");
  }

  const refundId = newId("ref");

  // The header has to exist first: `refund_items.refund_id` is a foreign key.
  // It is written with a placeholder total and corrected from what lands, and
  // removed again if nothing does.
  await run(
    db,
    `INSERT INTO refunds (id, client_id, sale_id, user_id, approved_by, shift_id, reason, method, total, restock, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)`,
    refundId,
    r.clientId,
    r.saleId,
    r.userId,
    r.approvedBy,
    r.shiftId,
    r.reason,
    r.method,
    r.restock ? 1 : 0,
    r.at,
  );

  const planned = new Map<string, { line: LineState; qty: number; amount: number; tax: number }>();
  const claims: D1PreparedStatement[] = [];

  for (const [lineId, qty] of merged) {
    const line = await one<LineState>(
      db,
      `SELECT i.id, i.product_id, i.qty, i.total, i.tax, i.cost,
              COALESCE((SELECT SUM(x.qty) FROM refund_items x WHERE x.sale_item_id = i.id), 0)
                AS refunded_qty,
              COALESCE((SELECT SUM(x.amount) FROM refund_items x WHERE x.sale_item_id = i.id), 0)
                AS refunded_amount,
              COALESCE((SELECT SUM(x.tax) FROM refund_items x WHERE x.sale_item_id = i.id), 0)
                AS refunded_tax
         FROM sale_items i WHERE i.id = ?1 AND i.sale_id = ?2`,
      lineId,
      r.saleId,
    );
    if (!line) {
      await run(db, "DELETE FROM refunds WHERE id = ?1", refundId);
      throw notFound("that line is not on this sale");
    }

    const left = line.qty - line.refunded_qty;
    if (qty > left + EPS) {
      await run(db, "DELETE FROM refunds WHERE id = ?1", refundId);
      throw conflict("over_refund", `only ${left} of that line is still refundable`, {
        sale_item_id: lineId,
        refundable: left,
      });
    }

    // **The units that close a line out are paid the remainder**, so however
    // many refunds a line is split across, they sum to exactly what it was
    // charged. Only a partial refund takes a proportional share, and its
    // rounding error is carried by whichever refund finishes the line.
    //
    // The tax is treated the same way and for the same reason, against what
    // *has already been given back* rather than against a proportion of the
    // quantity. Re-deriving it per call left the residual nowhere: a 3-unit
    // line carrying 100 of VAT returned a unit at a time reversed 99, and a
    // 4-unit line carrying 10 reversed 11. Both entries balance, so nothing
    // flagged either one — only the VAT return was wrong.
    const closesTheLine = qty >= left - EPS;
    const share = line.qty > 0 ? qty / line.qty : 0;
    const amount = closesTheLine
      ? line.total - line.refunded_amount
      : Math.round(line.total * share);
    const tax = closesTheLine
      ? line.tax - line.refunded_tax
      : Math.round(line.tax * share);

    planned.set(lineId, { line, qty, amount, tax });
    claims.push(
      stmt(
        db,
        `INSERT INTO refund_items (id, refund_id, sale_item_id, qty, amount, tax)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE (SELECT i.qty - COALESCE((SELECT SUM(x.qty) FROM refund_items x
                                           WHERE x.sale_item_id = i.id), 0)
                   FROM sale_items i WHERE i.id = ?3) >= ?4 - ${EPS}`,
        newId("ri"),
        refundId,
        lineId,
        qty,
        amount,
        tax,
      ),
    );
  }

  // Step two: claim the units. Each insert is conditional on those units still
  // being unrefunded, and a claim that matches nothing is a quiet no-op.
  await batch(db, claims);

  // Step three: read back what actually landed, and build everything else from
  // that rather than from what was hoped for.
  const landed = await all<{ sale_item_id: string; qty: number; amount: number; tax: number }>(
    db,
    "SELECT sale_item_id, qty, amount, tax FROM refund_items WHERE refund_id = ?1",
    refundId,
  );
  if (landed.length === 0) {
    await run(db, "DELETE FROM refunds WHERE id = ?1", refundId);
    throw conflict("already_refunded", "those units have already come back");
  }

  let total = 0;
  let tax = 0;
  let cost = 0;
  const after: D1PreparedStatement[] = [];

  for (const row of landed) {
    const plan = planned.get(row.sale_item_id);
    if (!plan) continue;
    total += row.amount;
    tax += row.tax;
    cost += extend(row.qty, plan.line.cost);

    if (r.restock && plan.line.product_id) {
      after.push(
        stmt(db, "UPDATE products SET stock = stock + ?2 WHERE id = ?1", plan.line.product_id, row.qty),
      );
      after.push(
        stmt(
          db,
          `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, unit_cost, user_id, created_at)
           VALUES (?1, ?2, ?3, 'refund', 'refund', ?4, ?5, ?6, ?7)`,
          newId("sm"),
          plan.line.product_id,
          row.qty,
          refundId,
          plan.line.cost,
          r.userId,
          r.at,
        ),
      );
    }
  }

  after.push(stmt(db, "UPDATE refunds SET total = ?2 WHERE id = ?1", refundId, total));

  if (r.method === "store_credit") {
    after.push(
      stmt(
        db,
        `UPDATE customers SET credit = credit + ?2
          WHERE id = (SELECT customer_id FROM sales WHERE id = ?1)`,
        r.saleId,
        total,
      ),
    );
  }

  after.push(
    stmt(
      db,
      `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sale', ?7, ?8, ?9)`,
      newId("aud"),
      r.at,
      r.userId,
      r.approvedBy,
      r.registerId,
      r.action,
      r.saleId,
      -total,
      r.reason,
    ),
  );

  if (r.accounting) {
    after.push(
      ...post(
        db,
        refundEntry({
          refundId,
          at: r.at,
          net: total - tax,
          tax,
          cost: r.restock ? cost : 0,
          method: r.method,
          cashFrom: r.cashFrom,
          userId: r.userId,
        }),
      ),
    );
  }

  await batch(db, after);
  // The tax goes back with the total. It is what the entry reversed, and
  // without it in the answer there is no way for a caller — or a test — to see
  // that the parts of a split return sum to the tax the sale collected.
  return { id: refundId, total, tax };
}
