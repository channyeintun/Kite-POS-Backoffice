import { all, batch, one, run, stmt } from "./db.js";
import { newId } from "./crypto.js";
import { conflict } from "./http.js";
import { customerPaymentEntry, post } from "./ledger.js";

/**
 * The tab: what a customer owes, and what settles it.
 *
 * One implementation for both doors — the lane's "Pay tab" and the back
 * office's settlement — for the reason `refunds.ts` gives for the same choice:
 * they are the same event told by two different people, and money that moves
 * differently depending on which screen took it is money nobody can reconcile.
 *
 * ## Two figures that must agree
 *
 * `customers.owed` is a running total, kept so the lane can answer "can this
 * basket go on the tab" in one read. [`OPEN_TABS_SQL`] derives the same number
 * from the rows that caused it — the `on_account` payments, less what has been
 * settled, less what came back as goods. They are equal by construction:
 * nothing moves one without writing a row that moves the other.
 *
 * That redundancy is deliberate and is the point. `products.stock` and
 * `stock_movements` stand in exactly this relationship, for exactly this
 * reason: a running figure is what a counter needs, and a figure derived from
 * events is what makes the running one auditable. A shop that finds the two
 * disagreeing has found a bug, which is better than a shop that cannot ask.
 */

/**
 * One customer's unsettled sales, oldest first.
 *
 * Bind: the customer id.
 *
 * Oldest first is not presentation — it is the allocation order. A settlement
 * pays the longest-standing shopping off before this week's, so the aging
 * report means what an accountant reads it to mean, and the list the cashier
 * is looking at is the list the shop is about to book against.
 *
 * Three terms, each a row somewhere:
 *
 *   * what went on the tab — the `on_account` tender on that sale,
 *   * what has been paid against it — the settlement allocations,
 *   * what came back — a refund given against the tab rather than in money.
 *
 * The third is what stops a customer being chased for shopping the shop has
 * back on its shelf.
 */
/**
 * What is still on one sale's tab, as SQL over a `sales` row aliased `s`.
 *
 * **One expression, interpolated, rather than four copies of it.** It had four:
 * the customer list, the debtor list, the aging table and the CSV each carried
 * their own, and when the shape of a refund changed — a tab leg and a money
 * leg, instead of a whole refund that was one or the other — two of them were
 * updated and two were not. The two that were not went on subtracting a term
 * that had stopped existing, so every sale that had been returned still counted
 * as owed: the aging report said K3,000 against a customer who owed K200, and
 * the number it disagreed with was on the same screen.
 *
 * It is a constant with nothing interpolated into it, so the composition is
 * only ever what is written here.
 */
export const OUTSTANDING_ON_SALE = `
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
      WHERE p.sale_id = s.id AND p.method = 'on_account')
  - (SELECT COALESCE(SUM(k.amount), 0) FROM customer_payment_items k
      WHERE k.sale_id = s.id)
  - (SELECT COALESCE(SUM(rf.on_account), 0) FROM refunds rf
      WHERE rf.sale_id = s.id)`;

export const OPEN_TABS_SQL = `
  SELECT id, number, completed_at, total, outstanding FROM (
    SELECT s.id, s.number, s.completed_at, s.total, s.rowid AS seq,
           ${OUTSTANDING_ON_SALE} AS outstanding
      FROM sales s
     WHERE s.customer_id = ?1 AND s.status = 'completed'
       AND EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.method = 'on_account')
  ) WHERE outstanding > 0
   ORDER BY completed_at, seq`;

export type OpenTab = {
  id: string;
  number: number | null;
  completed_at: number | null;
  total: number;
  outstanding: number;
};

/** What is still on one sale's tab. Zero for a sale that never went on one. */
export async function outstandingOn(db: D1Database, saleId: string): Promise<number> {
  const row = await one<{ outstanding: number }>(
    db,
    `SELECT ${OUTSTANDING_ON_SALE} AS outstanding FROM sales s WHERE s.id = ?1`,
    saleId,
  );
  return row?.outstanding ?? 0;
}

export type Settlement = {
  customerId: string;
  /** Money handed over, in whole minor units. Never more than is owed. */
  amount: number;
  method: "cash" | "card" | "wallet";
  reference: string;
  note: string;
  userId: string;
  /**
   * The drawer open **now on the lane taking the money**, or null in the back
   * office, which has none.
   *
   * Never the shift the original sale was rung on. `lib/refunds.ts` records
   * what that mistake costs in the other direction: cash physically leaves or
   * enters the drawer that is in front of the person handling it, and a count
   * that does not know about it comes up over or short against a cashier who
   * did nothing wrong.
   */
  shiftId: string | null;
  registerId: string | null;
  /** Where the cash physically goes: a lane's drawer, or the office's safe. */
  cashTo: "drawer" | "safe";
  clientId: string | null;
  at: number;
  accounting: boolean;
};

export type Settled = {
  id: string;
  total: number;
  /** What the customer still owes across every tab, after this. */
  owed: number;
  allocations: { sale_id: string; amount: number }[];
  replayed: boolean;
};

/**
 * Take money off a tab.
 *
 * Claim, check, then write — the shape this codebase arrived at the hard way,
 * six times over. D1 has no interactive transaction and a statement that
 * matches no rows is a *success* that cannot abort a batch, so a balance check
 * batched with its own consequences refuses nothing: the settlement would be
 * written, the ledger posted, and the 409 raised over work that had already
 * committed.
 *
 * So the decrement of `customers.owed` goes first, alone, conditional on the
 * money actually being owed, and its `meta.changes` is the answer to "may this
 * happen". Everything else is built from the fact that it did.
 */
export async function settleTab(db: D1Database, s: Settlement): Promise<Settled> {
  // **The key is read before anything runs.** A settlement taken at a counter
  // on a bad connection completes, loses its answer on the way back, and is
  // sent again — and the second one must find the first rather than take the
  // money twice. Relying on the UNIQUE constraint to catch it instead gives the
  // caller a 500 and no receipt, which is the same outcome as a lost answer.
  if (s.clientId) {
    const already = await one<{ id: string; total: number }>(
      db,
      "SELECT id, total FROM customer_payments WHERE client_id = ?1",
      s.clientId,
    );
    if (already) return await settledAnswer(db, already.id, s.customerId, true);
  }

  if (s.amount <= 0) {
    throw conflict("bad_amount", "a settlement has to be more than nothing");
  }

  // Step one: claim the money against the balance.
  //
  // `owed >= ?2` is both halves of the guard at once. It refuses a settlement
  // larger than the debt — taking money for shopping nobody had — and it makes
  // two settlements arriving together safe, because the second one is measured
  // against what the first left rather than against what both of them read.
  const claimed = await run(
    db,
    "UPDATE customers SET owed = owed - ?2 WHERE id = ?1 AND owed >= ?2",
    s.customerId,
    s.amount,
  );
  if (claimed.meta.changes === 0) {
    const who = await one<{ owed: number }>(
      db,
      "SELECT owed FROM customers WHERE id = ?1",
      s.customerId,
    );
    throw conflict("over_owed", "that is more than this customer owes", {
      owed: who?.owed ?? 0,
    });
  }

  // Step two: everything the claim entitles us to write. If any of it fails the
  // batch rolls back, and the claim — which is outside it — has to be given
  // back by hand, or the customer's balance falls by a payment nobody took.
  let committed = "";
  try {
    const paymentId = newId("cpay");
    const tabs = await all<OpenTab>(db, OPEN_TABS_SQL, s.customerId);

    // Oldest first, and **the tab that exhausts the money takes the
    // remainder**. Splitting proportionally and rounding each part is how a
    // total stops summing to itself; this is the same rule `refunds.ts` uses
    // for the units that close a line out, and it is exact by subtraction
    // rather than by hoping the rounding agrees.
    const allocations: { sale_id: string; amount: number }[] = [];
    let left = s.amount;
    for (const tab of tabs) {
      if (left <= 0) break;
      const take = Math.min(left, tab.outstanding);
      if (take <= 0) continue;
      allocations.push({ sale_id: tab.id, amount: take });
      left -= take;
    }

    // **Money with no shopping to put it against is a refusal, not a rounding.**
    //
    // The claim above is measured against `customers.owed`; the allocation is
    // measured against what the rows derive. They are equal by construction, so
    // reaching here with anything left over means they have stopped being —
    // and dropping the difference would take the money, credit the receivable
    // the full amount, and leave no row anywhere saying which shopping it paid
    // for. Throwing puts the claim back (see the catch) and leaves the two
    // figures exactly as they were, which is the state a person can look at.
    if (left > 0) {
      throw conflict("tab_disagrees", "what this customer owes does not add up — check their account", {
        unallocated: left,
      });
    }

    const statements: D1PreparedStatement[] = [
      stmt(
        db,
        `INSERT INTO customer_payments
           (id, client_id, customer_id, user_id, shift_id, register_id, method, total, reference, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        paymentId,
        s.clientId,
        s.customerId,
        s.userId,
        s.shiftId,
        s.registerId,
        s.method,
        s.amount,
        s.reference,
        s.note,
        s.at,
      ),
    ];
    for (const a of allocations) {
      statements.push(
        stmt(
          db,
          "INSERT INTO customer_payment_items (id, payment_id, sale_id, amount) VALUES (?1, ?2, ?3, ?4)",
          newId("cpi"),
          paymentId,
          a.sale_id,
          a.amount,
        ),
      );
    }
    statements.push(
      stmt(
        db,
        `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
         VALUES (?1, ?2, ?3, ?3, ?4, 'tab_payment', 'customer', ?5, ?6, ?7)`,
        newId("aud"),
        s.at,
        s.userId,
        s.registerId,
        s.customerId,
        s.amount,
        s.note || s.reference,
      ),
    );
    if (s.accounting) {
      statements.push(
        ...post(
          db,
          customerPaymentEntry({
            paymentId,
            at: s.at,
            amount: s.amount,
            method: s.method,
            cashTo: s.cashTo,
            userId: s.userId,
          }),
        ),
      );
    }

    await batch(db, statements);
    committed = paymentId;
  } catch (err) {
    // **Only the window before the commit.**
    //
    // `settledAnswer` below used to sit inside this `try`, so a read that
    // failed *after* the batch had landed put the claim back over work that had
    // already committed: the settlement row, its allocations and the ledger
    // posting all stood, and `customers.owed` was quietly raised by the amount
    // the customer had just paid. Restoring a claim is only ever right while
    // nothing it paid for exists.
    await run(
      db,
      "UPDATE customers SET owed = owed + ?2 WHERE id = ?1",
      s.customerId,
      s.amount,
    );
    throw err;
  }
  return await settledAnswer(db, committed, s.customerId, false);
}

/**
 * A settlement as it stands in the database.
 *
 * Read back rather than returned from what was intended, so the answer to a
 * replay is the same answer as the first one — the figures come from the rows
 * either way, and there is no request left to recompute them from on a retry.
 */
async function settledAnswer(
  db: D1Database,
  paymentId: string,
  customerId: string,
  replayed: boolean,
): Promise<Settled> {
  const payment = await one<{ total: number }>(
    db,
    "SELECT total FROM customer_payments WHERE id = ?1",
    paymentId,
  );
  const allocations = await all<{ sale_id: string; amount: number }>(
    db,
    "SELECT sale_id, amount FROM customer_payment_items WHERE payment_id = ?1",
    paymentId,
  );
  const who = await one<{ owed: number }>(db, "SELECT owed FROM customers WHERE id = ?1", customerId);
  return {
    id: paymentId,
    total: payment?.total ?? 0,
    owed: who?.owed ?? 0,
    allocations,
    replayed,
  };
}
