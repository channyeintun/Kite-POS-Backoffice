import { newId } from "./crypto.js";
import { stmt } from "./db.js";

/**
 * Double entry, posted from the events that caused it.
 *
 * No balance is stored anywhere. Every figure in every report is summed from
 * `journal_lines`, so there is no cached total that can quietly diverge from
 * the postings — and the postings themselves cannot be edited, because triggers
 * on the tables refuse UPDATE and DELETE whatever this file tries.
 *
 * One signed `amount` per line rather than two columns: debit is positive,
 * credit is negative, and "the entry balances" is `sum === 0`. Two columns give
 * two sums that can each be individually right and still disagree.
 */

export type Posting = { account: string; amount: number; memo?: string };

export type Entry = {
  valueAt: number;
  bookedAt: number;
  memo: string;
  refType: string;
  refId: string;
  userId: string | null;
  /**
   * The entry this one puts right, when it is a correction.
   *
   * Nothing here can be edited or deleted — the triggers say so, and their
   * message tells you to post a correction instead. This is what makes that
   * instruction followable: the reversal and the entry it reverses are linked,
   * so the history shows both what happened and that it was undone, rather
   * than two entries that happen to cancel out.
   */
  correctsId?: string | null;
  postings: Posting[];
};

export class Unbalanced extends Error {}

/**
 * Statements that post one entry, or a refusal.
 *
 * The two conditions are checked here rather than by a trigger because SQLite
 * cannot see the lines while the entry is being inserted — the entry row lands
 * first. So this is the barrier, and it is a hard one: an entry that does not
 * balance, or that moves money within a single account, is not written at all.
 * Minting money is a rejected insert rather than a logic bug found in March.
 */
export function post(db: D1Database, entry: Entry): D1PreparedStatement[] {
  const live = entry.postings.filter((p) => p.amount !== 0);
  if (live.length === 0) return [];

  const sum = live.reduce((a, p) => a + p.amount, 0);
  if (sum !== 0) {
    throw new Unbalanced(
      `entry for ${entry.refType}:${entry.refId} is out by ${sum} — it was not posted`,
    );
  }
  const accounts = new Set(live.map((p) => p.account));
  if (accounts.size < 2) {
    throw new Unbalanced(
      `entry for ${entry.refType}:${entry.refId} moves money within one account`,
    );
  }

  const id = newId("je");
  const out: D1PreparedStatement[] = [
    stmt(
      db,
      `INSERT INTO journal_entries (id, value_at, booked_at, memo, ref_type, ref_id, corrects_id, user_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8, ?7)`,
      id,
      entry.valueAt,
      entry.bookedAt,
      entry.memo,
      entry.refType,
      entry.refId,
      entry.userId,
      entry.correctsId ?? null,
    ),
  ];
  for (const p of live) {
    out.push(
      stmt(
        db,
        `INSERT INTO journal_lines (id, entry_id, account_code, amount, memo)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
        newId("jl"),
        id,
        p.account,
        p.amount,
        p.memo ?? "",
      ),
    );
  }
  return out;
}

export const ACC = {
  drawer: "1000",
  safe: "1010",
  clearing: "1020",
  stock: "1200",
  grni: "1300",
  payables: "2000",
  taxPayable: "2100",
  storeCredit: "2200",
  capital: "3000",
  sales: "4000",
  discounts: "4100",
  cogs: "5000",
  waste: "5100",
  overShort: "5200",
  operating: "6000",
} as const;

/** Where the money for a tender lands. */
export function accountForTender(method: string): string {
  if (method === "cash") return ACC.drawer;
  if (method === "store_credit") return ACC.storeCredit;
  return ACC.clearing;
}

export type SaleForBooks = {
  saleId: string;
  at: number;
  /** What the customer actually paid, net of tax. */
  net: number;
  tax: number;
  /** Offers and discounts, together — what the shop gave away. */
  discount: number;
  cost: number;
  /**
   * What each tender actually left behind, **after change**. A customer handing
   * over 4,000 against a 2,900 balance puts 2,900 in the drawer, not 4,000.
   */
  payments: { method: string; amount: number }[];
  userId: string;
};

/**
 * A completed sale, in four movements.
 *
 * Revenue is booked **net of tax**, because the tax in a tax-inclusive price was
 * never the shop's money — it is collected on somebody else's behalf and sits in
 * a liability until it is paid over. Booking the gross as income and the tax as
 * an expense would give the same bottom line and the wrong VAT return.
 *
 * What the shop gave away is booked **gross**: Sales is credited what the goods
 * would have fetched at the shelf price, and the offers and discounts are
 * debited back out of it. The bottom line is identical either way, and this way
 * a profit and loss can answer "what did the promotions cost us" without
 * reconstructing it from the sale lines.
 *
 * That grossing-up is also what makes the entry balance, and getting it wrong
 * is how this was found: debiting discounts *without* raising the sales credit
 * to match left every sale out by exactly what it had discounted, and
 * `post` refused all of them.
 *
 * Cost of goods is posted at the same moment as the revenue that earned it, so
 * a margin computed for any window is a margin for the same set of sales.
 */
export function saleEntry(s: SaleForBooks): Entry {
  const postings: Posting[] = [];
  for (const p of s.payments) {
    postings.push({ account: accountForTender(p.method), amount: p.amount, memo: p.method });
  }
  postings.push({ account: ACC.sales, amount: -(s.net + s.discount), memo: "at shelf price, net of tax" });
  if (s.discount !== 0) postings.push({ account: ACC.discounts, amount: s.discount, memo: "given away" });
  if (s.tax !== 0) postings.push({ account: ACC.taxPayable, amount: -s.tax });
  if (s.cost !== 0) {
    postings.push({ account: ACC.cogs, amount: s.cost });
    postings.push({ account: ACC.stock, amount: -s.cost });
  }
  return {
    valueAt: s.at,
    bookedAt: s.at,
    memo: "Sale",
    refType: "sale",
    refId: s.saleId,
    userId: s.userId,
    postings,
  };
}

/** A refund is a sale run backwards, and is posted as one rather than netted off. */
export function refundEntry(args: {
  refundId: string;
  at: number;
  net: number;
  tax: number;
  cost: number;
  method: string;
  /**
   * Which pile of cash the money came out of.
   *
   * A return at a lane comes out of that lane's drawer and belongs in its
   * count. A refund from the back office comes out of the safe, the same way
   * [`expenseEntry`] pays a bill — the office has no drawer, and charging one
   * anyway left it short with no shift to explain the difference.
   */
  cashFrom: "drawer" | "safe";
  userId: string;
}): Entry {
  const paidFrom =
    args.method === "cash" && args.cashFrom === "safe" ? ACC.safe : accountForTender(args.method);
  const postings: Posting[] = [
    { account: ACC.sales, amount: args.net },
    { account: paidFrom, amount: -(args.net + args.tax) },
  ];
  if (args.tax !== 0) postings.push({ account: ACC.taxPayable, amount: args.tax });
  if (args.cost !== 0) {
    postings.push({ account: ACC.stock, amount: args.cost });
    postings.push({ account: ACC.cogs, amount: -args.cost });
  }
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: "Refund",
    refType: "refund",
    refId: args.refundId,
    userId: args.userId,
    postings,
  };
}

/**
 * The float going into a drawer, and the takings coming back out.
 *
 * Between these two the drawer account holds exactly what is physically in the
 * drawer, and returns to zero when the shift closes. Without the first one it
 * goes negative the moment any change is given — which is what it did, and it
 * makes a balance sheet that is arithmetically sound and visibly nonsense.
 *
 * The float comes from the safe and the counted total goes back to it, which is
 * what a shopkeeper actually does with the cash at the end of the day.
 */
export function floatEntry(args: {
  shiftId: string;
  at: number;
  amount: number;
  userId: string;
}): Entry {
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: "Opening float",
    refType: "shift",
    refId: args.shiftId,
    userId: args.userId,
    postings: [
      { account: ACC.drawer, amount: args.amount },
      { account: ACC.safe, amount: -args.amount },
    ],
  };
}

export function sweepEntry(args: {
  shiftId: string;
  at: number;
  amount: number;
  userId: string;
}): Entry {
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: "Drawer counted out to the safe",
    refType: "shift",
    refId: args.shiftId,
    userId: args.userId,
    postings: [
      { account: ACC.safe, amount: args.amount },
      { account: ACC.drawer, amount: -args.amount },
    ],
  };
}

/**
 * The variance found when a drawer is counted.
 *
 * Closing books the difference so the ledger's idea of cash agrees with the
 * physical count rather than drifting away from it a few kyat at a time. A
 * surplus is a credit to over-and-short, a shortfall a debit — either way the
 * drawer account ends the shift saying what is actually in the drawer.
 */
export function varianceEntry(args: {
  shiftId: string;
  at: number;
  variance: number;
  userId: string;
}): Entry {
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: args.variance >= 0 ? "Cash over at close" : "Cash short at close",
    refType: "shift",
    refId: args.shiftId,
    userId: args.userId,
    postings: [
      { account: ACC.drawer, amount: args.variance },
      { account: ACC.overShort, amount: -args.variance },
    ],
  };
}

export function cashMovementEntry(args: {
  movementId: string;
  at: number;
  kind: "paid_in" | "paid_out" | "safe_drop";
  amount: number;
  reason: string;
  userId: string;
}): Entry {
  const postings: Posting[] =
    args.kind === "safe_drop"
      ? [
          { account: ACC.safe, amount: args.amount },
          { account: ACC.drawer, amount: -args.amount },
        ]
      : args.kind === "paid_in"
        ? [
            { account: ACC.drawer, amount: args.amount },
            { account: ACC.capital, amount: -args.amount },
          ]
        : [
            { account: ACC.operating, amount: args.amount, memo: args.reason },
            { account: ACC.drawer, amount: -args.amount },
          ];
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: args.reason || args.kind,
    refType: "cash_movement",
    refId: args.movementId,
    userId: args.userId,
    postings,
  };
}

/** Stock arriving, before the supplier's invoice does. */
export function receiptEntry(args: {
  poId: string;
  at: number;
  value: number;
  userId: string;
}): Entry {
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: "Goods received",
    refType: "purchase_order",
    refId: args.poId,
    userId: args.userId,
    postings: [
      { account: ACC.stock, amount: args.value },
      { account: ACC.grni, amount: -args.value },
    ],
  };
}

/** The invoice that follows it, clearing the accrual into a real payable. */
export function invoiceEntry(args: {
  invoiceId: string;
  at: number;
  total: number;
  userId: string | null;
}): Entry {
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: "Supplier invoice",
    refType: "supplier_invoice",
    refId: args.invoiceId,
    userId: args.userId,
    postings: [
      { account: ACC.grni, amount: args.total },
      { account: ACC.payables, amount: -args.total },
    ],
  };
}

/**
 * Money paid to a supplier.
 *
 * Cash comes out of the **safe**, for exactly the reason `expenseEntry` says:
 * a drawer is reconciled against a physical count, and that count knows about
 * floats, sales, change and till payouts — it does not know the back office
 * paid a delivery driver out of it. Booking this against the drawer left it
 * short by the bill permanently, with no shift to explain it. Paying a supplier
 * *from the till* is a `paid_out` cash movement instead, which is on the shift
 * and therefore in the count.
 */
export function supplierPaymentEntry(args: {
  paymentId: string;
  at: number;
  amount: number;
  method: string;
  userId: string | null;
}): Entry {
  const from = args.method === "cash" ? ACC.safe : accountForTender(args.method);
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: "Paid supplier",
    refType: "supplier_payment",
    refId: args.paymentId,
    userId: args.userId,
    postings: [
      { account: ACC.payables, amount: args.amount },
      { account: from, amount: -args.amount },
    ],
  };
}

/**
 * A bill the shop paid.
 *
 * Cash comes out of the **safe**, not the drawer. A drawer is reconciled
 * against a physical count at the end of every shift, and that count knows
 * about floats, sales, change and till payouts — it does not know somebody paid
 * the electricity from it. Booking a cash expense against the drawer therefore
 * left the drawer short by the bill, permanently, with no shift to explain it.
 *
 * Paying a bill *from the till* is a `paid_out` cash movement instead
 * ([`cashMovementEntry`]), which is on the shift and so is in the count.
 */
export function expenseEntry(args: {
  expenseId: string;
  at: number;
  /** What was paid in total, tax included. */
  amount: number;
  /**
   * The tax inside that amount.
   *
   * Debited to `2100 Tax payable`, which *reduces* the liability — the tax a
   * shop pays on a purchase offsets the tax it collects on a sale, and without
   * this leg 2100 only ever grows and the balance sheet overstates what is
   * owed. Zero for an unregistered shop or an untaxed cost, and `post` drops a
   * zero-valued line, so the entry is two legs again.
   */
  tax: number;
  method: string;
  /** Which expense account this is a cost of. */
  account: string;
  category: string;
  userId: string | null;
  /** Paid on account rather than in money — the shop now owes it instead. */
  onAccount?: boolean;
}): Entry {
  // Cash comes out of the safe, never the drawer — see the note above. Paying
  // on account takes nothing out at all: it adds to what the shop owes.
  const from = args.onAccount
    ? ACC.payables
    : args.method === "cash"
      ? ACC.safe
      : accountForTender(args.method);
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: args.category,
    refType: "expense",
    refId: args.expenseId,
    userId: args.userId,
    postings: [
      { account: args.account, amount: args.amount - args.tax, memo: args.category },
      { account: ACC.taxPayable, amount: args.tax, memo: "tax paid on a purchase" },
      { account: from, amount: -args.amount },
    ],
  };
}

/** Stock written off: waste, breakage, or a count that came up short. */
export function stockAdjustEntry(args: {
  movementId: string;
  at: number;
  value: number;
  reason: string;
  userId: string | null;
}): Entry {
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: args.reason,
    refType: "stock_movement",
    refId: args.movementId,
    userId: args.userId,
    postings: [
      { account: ACC.waste, amount: -args.value },
      { account: ACC.stock, amount: args.value },
    ],
  };
}

/**
 * An entry, run backwards.
 *
 * The only way to undo something in a ledger that refuses UPDATE and DELETE.
 * Every line is negated, so the pair nets to zero and both remain visible —
 * which is the difference between an audit trail and a redaction.
 *
 * It carries **today's** date, not the original's. A correction discovered in
 * March for something posted in January belongs in March: January may already
 * have been closed and reported to the outside world, and backdating into it is
 * exactly the write the period trigger exists to stop.
 */
export function reversalEntry(args: {
  original: { id: string; memo: string; ref_type: string; ref_id: string };
  lines: readonly { account_code: string; amount: number; memo: string }[];
  at: number;
  reason: string;
  userId: string | null;
}): Entry {
  return {
    valueAt: args.at,
    bookedAt: args.at,
    memo: `Reversal of ${args.original.memo || args.original.ref_type} — ${args.reason}`,
    refType: args.original.ref_type,
    refId: args.original.ref_id,
    correctsId: args.original.id,
    userId: args.userId,
    postings: args.lines.map((l) => ({
      account: l.account_code,
      amount: -l.amount,
      memo: l.memo,
    })),
  };
}
