import { all, batch, one, run, stmt } from "./db.js";
import { newId } from "./crypto.js";
import { conflict, notFound } from "./http.js";
import { extend } from "./money.js";
import { post, refundEntry } from "./ledger.js";
import { OUTSTANDING_ON_SALE, outstandingOn } from "./credit.js";

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
): Promise<{ id: string; total: number; tax: number; on_account: number }> {
  // Store credit has to have somebody to belong to.
  //
  // A liability posted to "store credit owed" with no holder is a credit that
  // can never be drawn down: the `UPDATE customers … WHERE id = (SELECT
  // customer_id …)` matches nothing when the sale was a walk-in, so the shop
  // kept the cash, booked an obligation that sits on the balance sheet forever,
  // and handed the customer a receipt saying they had been refunded. The till
  // already refuses store credit as a *tender* without a customer; this is the
  // same rule at the other end.
  // **The key is read before anything runs**, the way `POST /pay` and a tab
  // settlement both read theirs. The column has been UNIQUE since the first
  // migration and nothing ever read it back, so a retried return — the same
  // cashier pressing the same button after a dropped answer — hit the
  // constraint on the header insert and got a 500 with no receipt. Money was
  // never at risk, because the per-unit conditional insert holds; what was at
  // risk was the operator's understanding of whether the goods had come back.
  if (r.clientId) {
    const already = await one<{ id: string; total: number; on_account: number }>(
      db,
      "SELECT id, total, on_account FROM refunds WHERE client_id = ?1",
      r.clientId,
    );
    if (already) {
      const back = await one<{ tax: number }>(
        db,
        "SELECT COALESCE(SUM(tax), 0) AS tax FROM refund_items WHERE refund_id = ?1",
        already.id,
      );
      return {
        id: already.id,
        total: already.total,
        tax: back?.tax ?? 0,
        on_account: already.on_account,
      };
    }
  }

  const owner = await one<{ customer_id: string | null }>(
    db,
    "SELECT customer_id FROM sales WHERE id = ?1",
    r.saleId,
  );
  if (r.method === "store_credit" && !owner?.customer_id) {
    throw conflict("no_customer", "store credit has to go to a customer — this sale has none");
  }

  // **Goods bought on a tab come back onto the tab first, and only then into a
  // hand.**
  //
  // A sale the customer has not paid for cannot be refunded in money: paying it
  // out of the drawer hands over cash the shop never received, against goods it
  // now has back on the shelf — a loss of exactly the refund, taken twice, with
  // the customer still owing the original debt. Store credit is the same
  // mistake wearing a liability.
  //
  // But refusing is not the answer either, and the first version of this did
  // refuse: a basket paid half in cash and half on the tab could not be taken
  // back by any method from any screen, because whatever came back was worth
  // more than the tab still held. That is the most ordinary case this whole
  // feature creates, and it left the goods on the shelf, the cash gone and the
  // debt standing.
  //
  // So a refund has two legs. The debt is paid down first, up to what it still
  // holds, and the remainder goes back by `method` like any other refund — one
  // operation at one counter, with `refunds.on_account` recording how it split.
  // `method` therefore means "how the *money* part was paid", and a refund that
  // was entirely a tab has none.
  const outstanding = await outstandingOn(db, r.saleId);

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
    `INSERT INTO refunds (id, client_id, sale_id, user_id, approved_by, shift_id, reason, method, total, on_account, restock, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, ?9, ?10)`,
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

  // **Claim the debt before the units, and claim the most this could take.**
  //
  // This is the same compare-and-set `credit.ts` uses to settle a tab, and it
  // is here because the read above is not a barrier. A refund is several round
  // trips — read the sale, write the header, read each line, claim the units,
  // read what landed — and every `await` in it is a point where another request
  // is served. A settlement arriving in one of those gaps pays off the very
  // debt this refund has already decided to cancel, and both succeed: the
  // customer's balance is reduced once while two rows say it was reduced twice,
  // so `customers.owed` and the rows that are supposed to explain it stop
  // agreeing. That is exactly what a reviewer produced by firing the two
  // together, and it is the sixth time in this codebase that a check which was
  // a read rather than a write has let two callers spend one thing.
  //
  // `owed >= ?2` is the barrier. It is against the customer's whole balance
  // rather than this sale's share of it, because `owed` is the only figure
  // there is a row to compare and set — an outstanding-per-sale is derived and
  // has nothing to lock. What that buys is the figure that matters: the total
  // a customer owes can never be reduced twice for the same goods, whatever
  // order two requests arrive in.
  //
  // It claims what the refund *intends* to take, because the amount it will
  // actually take is not known until the units have landed. Whatever it does
  // not use is given back below.
  let claimedFromTab = 0;
  if (outstanding > 0) {
    let planTotal = 0;
    for (const plan of planned.values()) planTotal += plan.amount;
    const wanted = Math.min(planTotal, outstanding);
    // **Both limits in the one statement.** `owed >= ?2` alone is the
    // customer's whole balance, which for somebody with several tabs is not
    // this sale's share of it: a settlement landing between the read above and
    // this write can pay *this* sale off in full while the claim still
    // succeeds against the debt on the others. The total stays right and the
    // sub-ledger goes wrong — one sale relieved twice, once by money and once
    // by returned goods, with a negative outstanding to show for it. So the
    // per-sale figure is re-derived here, inside the write, where it is the
    // barrier rather than a number that was true a few round trips ago.
    const took = await run(
      db,
      `UPDATE customers SET owed = owed - ?2
        WHERE id = (SELECT customer_id FROM sales WHERE id = ?1)
          AND owed >= ?2
          AND ?2 <= (SELECT ${OUTSTANDING_ON_SALE} FROM sales s WHERE s.id = ?1)`,
      r.saleId,
      wanted,
    );
    if (took.meta.changes === 0) {
      // The balance moved between the read above and here — settled, or
      // refunded from another counter. Nothing but the header has been written,
      // so this is a clean refusal, and the right one: the split this call
      // computed was built on a figure that no longer exists.
      await run(db, "DELETE FROM refunds WHERE id = ?1", refundId);
      throw conflict("tab_moved", "this customer's balance changed — try that again", {
        outstanding,
      });
    }
    claimedFromTab = wanted;
  }

  // **Everything from here on has to give the tab back if it throws.**
  //
  // The claim above commits on its own — it has to, because a guard batched
  // with its own consequences guards nothing — and three exits below can throw
  // after it: the unit claims, the read-back, and the final batch, which aborts
  // on any constraint or on a posting into a closed month. Releasing only on
  // the "nothing landed" path left the other three leaking, and the wreckage
  // was not recoverable: the debt was cancelled, the units were consumed by
  // `refund_items` rows whose header carried a zero total, the stock never came
  // back, and no journal entry existed at all — goods in the shop, off the
  // books, with nobody owing for them and no endpoint able to put it right.
  //
  // The header goes with it. Deleting it takes the claimed units too, because
  // `refund_items.refund_id` cascades — which is what makes the retry work
  // rather than meeting "only 0 of that line is still refundable".
  //
  // This is the shape `completeSale` in `routes/till.ts` uses for the same
  // reason, and it was left out of here once already.
  try {
    return await applyRefundClaimed(db, r, refundId, claimedFromTab, planned, claims, outstanding);
  } catch (err) {
    if (claimedFromTab > 0) {
      await run(
        db,
        `UPDATE customers SET owed = owed + ?2
          WHERE id = (SELECT customer_id FROM sales WHERE id = ?1)`,
        r.saleId,
        claimedFromTab,
      );
    }
    await run(db, "DELETE FROM refunds WHERE id = ?1", refundId);
    throw err;
  }
}

/**
 * The half of a refund that runs once the tab has been claimed.
 *
 * Split out so the claim has something to wrap, exactly as `completeSale` is
 * split out of `POST /till/pay`. Everything in here either finishes the refund
 * or throws, and a throw is the caller's signal to give the debt back and take
 * the header away with it.
 */
async function applyRefundClaimed(
  db: D1Database,
  r: RefundRequest,
  refundId: string,
  claimedFromTab: number,
  planned: Map<string, { line: LineState; qty: number; amount: number; tax: number }>,
  claims: D1PreparedStatement[],
  outstanding: number,
): Promise<{ id: string; total: number; tax: number; on_account: number }> {
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
  // The catch above undoes both the claim and the header, so this is a throw
  // and nothing else.
  if (landed.length === 0) {
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

  // **The split, computed from what actually landed.**
  //
  // The claim above took the smaller of what this call planned to refund and
  // what the tab held. `total` is what the units actually came to, and it can
  // only be less than the plan — a unit another cashier got to first drops out
  // of the conditional insert — so the tab leg is capped again here and the
  // difference handed straight back. Unconditional, because it is returning
  // something this call is holding rather than taking something it has to be
  // allowed to have.
  const onTab = Math.min(claimedFromTab, total);
  const inMoney = total - onTab;
  if (claimedFromTab > onTab) {
    after.push(
      stmt(
        db,
        "UPDATE customers SET owed = owed + ?2 WHERE id = (SELECT customer_id FROM sales WHERE id = ?1)",
        r.saleId,
        claimedFromTab - onTab,
      ),
    );
  }

  after.push(
    stmt(db, "UPDATE refunds SET total = ?2, on_account = ?3 WHERE id = ?1", refundId, total, onTab),
  );

  // Store credit is given for the money part only. The rest was never money:
  // crediting the customer for it would hand them a balance to spend against
  // shopping they had not paid for.
  if (r.method === "store_credit" && inMoney > 0) {
    after.push(
      stmt(
        db,
        `UPDATE customers SET credit = credit + ?2
          WHERE id = (SELECT customer_id FROM sales WHERE id = ?1)`,
        r.saleId,
        inMoney,
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
          onAccount: onTab,
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
  //
  // `on_account` says how much of it came off the customer's tab rather than
  // out of a till, which is the difference between "K900 back" and "K900 off
  // what you owe" — two sentences a customer at a counter hears very
  // differently.
  return { id: refundId, total, tax, on_account: onTab };
}
