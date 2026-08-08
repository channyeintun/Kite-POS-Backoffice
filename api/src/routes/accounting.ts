import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, batch, currencyOf, one, readSettings, run, stmt } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, int, oneOf, optInt, optStr, str } from "../lib/http.js";
import { ACC, expenseEntry, post, reversalEntry } from "../lib/ledger.js";
import { csvDoc, csvResponse, isoDay, isoStamp, plainAmount, preamble } from "../lib/csv.js";

export const accounting = new Hono<Ctx>();

/**
 * The books.
 *
 * Nothing here stores a balance. Every figure is `SUM(amount)` over
 * `journal_lines` for a window, which is why a trial balance in this system
 * cannot disagree with the profit and loss above it — they are two groupings of
 * one set of rows rather than two tallies that have to be kept in step.
 *
 * Sign convention: a debit is positive and a credit is negative, so an income
 * account's balance comes back negative and is flipped where it is presented.
 * The flip is done once, in `presentable`, and the raw sums stay honest.
 */

/**
 * The window a report covers.
 *
 * Validated rather than trusted. A non-numeric `from` becomes `NaN`, and every
 * comparison against `NaN` is false — so a window that should have selected
 * nothing selects nothing *silently*, and the reader sees an empty profit and
 * loss rather than an error. A backwards window is refused for the same
 * reason: it is a mistake, not a request for nothing.
 */
const window = (c: { req: { query: (k: string) => string | undefined } }) => {
  const to = Number(c.req.query("to") ?? String(now()));
  const from = Number(c.req.query("from") ?? String(to - 30 * 86400));
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw badRequest("bad_window", "that window is not a pair of times");
  }
  if (from > to) throw badRequest("bad_window", "that window ends before it starts");
  return { from, to };
};

type Balance = { code: string; name: string; kind: string; normal: string; balance: number };

/**
 * A balance as its own account would state it: positive when normal.
 *
 * **For showing one line, never for adding a group up.** `4100 Promotions &
 * discounts` is a contra-revenue account — income by kind, debit by nature — so
 * this returns it positive, which is what a reader wants to see beside the
 * revenue it came off. Summing a group with it *adds* discounts to income, and
 * that is a real bug this had: the balance sheet came out over by exactly what
 * the shop had discounted, twice.
 *
 * Groups are totalled by [`totalOf`] instead, which works on the raw signed
 * amounts the accounting identity is actually defined on.
 */
const presentable = (b: Balance): number => (b.normal === "credit" ? -b.balance : b.balance);

/**
 * What a group of accounts is worth, as a positive figure.
 *
 * Debit is positive in `journal_lines`, so an asset or an expense sums as it
 * stands and everything credit-natured is flipped **by kind rather than by the
 * account's own `normal`**. That is the whole difference: a contra account
 * inside a group carries the opposite sign and has to keep it, because that is
 * how it reduces the group it belongs to.
 */
function totalOf(rows: readonly Balance[], kind: string): number {
  const credit = kind === "income" || kind === "liability" || kind === "equity";
  const sum = rows.filter((r) => r.kind === kind).reduce((a, r) => a + r.balance, 0);
  return credit ? -sum : sum;
}

/**
 * Every account's balance over a window.
 *
 * The window is applied **inside the SUM**, not in the join. Putting
 * `e.value_at BETWEEN ?1 AND ?2` in the `ON` clause of a LEFT JOIN does not
 * remove anything: the `journal_lines` row survives with a NULL entry beside
 * it and `SUM(l.amount)` counts it anyway. That bug made every windowed report
 * — profit and loss, trial balance, and the balance sheet's `as_at` — return
 * lifetime figures, while `/journal` for the same window correctly returned
 * nothing. The two directly contradicted each other.
 *
 * The LEFT JOIN is still a LEFT JOIN so that an account with no activity is
 * listed at zero rather than missing.
 */
async function balances(db: D1Database, from: number, to: number): Promise<Balance[]> {
  return await all<Balance>(
    db,
    `SELECT a.code, a.name, a.kind, a.normal,
            COALESCE(SUM(CASE WHEN e.value_at >= ?1 AND e.value_at <= ?2
                              THEN l.amount ELSE 0 END), 0) AS balance
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_code = a.code
       LEFT JOIN journal_entries e ON e.id = l.entry_id
      GROUP BY a.code, a.name, a.kind, a.normal
      ORDER BY a.sort`,
    from,
    to,
  );
}

accounting.get("/summary", async (c) => {
  const enabled = await one<{ value: string }>(
    c.env.DB,
    "SELECT value FROM settings WHERE key = 'accounting.enabled'",
  );
  const entries = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM journal_entries");
  const periods = await all(c.env.DB, "SELECT * FROM fiscal_periods ORDER BY starts_at DESC LIMIT 24");
  return c.json({
    enabled: (enabled?.value ?? "0") === "1",
    entries: entries?.n ?? 0,
    periods,
  });
});

/**
 * Profit and loss for a window.
 *
 * Revenue is already net of tax when it was posted, because the tax in a
 * tax-inclusive price was never the shop's money. So gross profit here is
 * revenue less cost of goods, and neither term needs a tax adjustment applied
 * to it afterwards.
 */
accounting.get("/profit-and-loss", async (c) => {
  const { from, to } = window(c);
  const rows = await balances(c.env.DB, from, to);

  const income = rows.filter((r) => r.kind === "income");
  const expense = rows.filter((r) => r.kind === "expense");

  // Net of the contra-revenue account, which `totalOf` handles by sign.
  const revenue = totalOf(rows, "income");
  const cogs = expense
    .filter((r) => r.code === "5000" || r.code === "5100")
    .reduce((a, r) => a + r.balance, 0);
  const operating = expense
    .filter((r) => r.code !== "5000" && r.code !== "5100")
    .reduce((a, r) => a + r.balance, 0);

  return c.json({
    from,
    to,
    income: income.map((r) => ({ ...r, amount: presentable(r) })),
    expenses: expense.map((r) => ({ ...r, amount: presentable(r) })),
    revenue,
    cost_of_sales: cogs,
    gross_profit: revenue - cogs,
    operating_expenses: operating,
    net_profit: revenue - cogs - operating,
  });
});

/**
 * The balance sheet, as at a date.
 *
 * Assets and liabilities are cumulative from the beginning of the records
 * rather than for a window — a balance sheet is a photograph, not a period —
 * so `from` is 0 here whatever the query says. Retained earnings is the
 * accumulated profit, computed rather than posted, which is what makes the
 * sheet balance without a year-end journal nobody has run yet.
 */
accounting.get("/balance-sheet", async (c) => {
  const asAt = Number(c.req.query("as_at") ?? String(now()));
  const rows = await balances(c.env.DB, 0, asAt);

  const assets = rows.filter((r) => r.kind === "asset");
  const liabilities = rows.filter((r) => r.kind === "liability");
  const equity = rows.filter((r) => r.kind === "equity");

  const totalAssets = totalOf(rows, "asset");
  const totalLiabilities = totalOf(rows, "liability");
  const postedEquity = totalOf(rows, "equity");

  // Accumulated profit, computed rather than posted — which is what lets the
  // sheet balance without a year-end journal nobody has run yet.
  const earned = totalOf(rows, "income") - totalOf(rows, "expense");

  return c.json({
    as_at: asAt,
    assets: assets.map((r) => ({ ...r, amount: presentable(r) })),
    liabilities: liabilities.map((r) => ({ ...r, amount: presentable(r) })),
    equity: equity.map((r) => ({ ...r, amount: presentable(r) })),
    retained_earnings: earned,
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    total_equity: postedEquity + earned,
    // Zero when the books are sound. Shown rather than hidden, because a sheet
    // that does not balance is the single most important thing on the page.
    out_by: totalAssets - (totalLiabilities + postedEquity + earned),
  });
});

accounting.get("/trial-balance", async (c) => {
  const { from, to } = window(c);
  const rows = await balances(c.env.DB, from, to);
  const lines = rows
    .filter((r) => r.balance !== 0)
    .map((r) => ({
      code: r.code,
      name: r.name,
      kind: r.kind,
      debit: r.balance > 0 ? r.balance : 0,
      credit: r.balance < 0 ? -r.balance : 0,
    }));
  return c.json({
    from,
    to,
    lines,
    total_debit: lines.reduce((a, l) => a + l.debit, 0),
    total_credit: lines.reduce((a, l) => a + l.credit, 0),
  });
});

/**
 * The journal, filtered the way somebody actually looks for an entry.
 *
 * Three filters, and they compose: what caused it, which account it touched,
 * and free text over the entry number and the memo. The account filter is an
 * `EXISTS` over the lines rather than a join, so an entry that touches the
 * account once is returned once and still carries *all* of its lines — an
 * entry shown with only the leg you searched for is not a journal entry, it is
 * half of one.
 */
/**
 * The number a person quotes when they ask about an entry.
 *
 * Derived from the rowid rather than stored, and that is sound *here*
 * specifically: `journal_entries` refuses both UPDATE and DELETE at the
 * database, so a row's rowid is fixed from the moment it is written and can
 * never be reused. A stored counter would need a round trip inside `post()`,
 * which builds its statements synchronously — and would be a second source of
 * truth for an ordering the table already has.
 */
const ENTRY_NUMBER = `printf('J-%06d', e.rowid)`;

type JournalFilter = { refType: string; accountCode: string; q: string };

function journalFilter(c: {
  req: { query: (k: string) => string | undefined };
}): JournalFilter {
  return {
    refType: (c.req.query("ref_type") ?? "").trim(),
    accountCode: (c.req.query("account_code") ?? "").trim(),
    q: (c.req.query("q") ?? "").trim(),
  };
}

function journalWhere(f: JournalFilter, from: number, to: number) {
  const binds: unknown[] = [from, to];
  let sql = "e.value_at BETWEEN ?1 AND ?2";
  if (f.refType.length > 0) {
    binds.push(f.refType);
    sql += ` AND e.ref_type = ?${binds.length}`;
  }
  if (f.accountCode.length > 0) {
    binds.push(f.accountCode);
    sql += ` AND EXISTS (SELECT 1 FROM journal_lines x
                          WHERE x.entry_id = e.id AND x.account_code = ?${binds.length})`;
  }
  if (f.q.length > 0) {
    binds.push(`%${f.q}%`);
    sql += ` AND (e.memo LIKE ?${binds.length} OR ${ENTRY_NUMBER} LIKE ?${binds.length}
                  OR e.ref_id LIKE ?${binds.length})`;
  }
  return { sql, binds };
}

const JOURNAL_LIMIT = 200;

accounting.get("/journal", async (c) => {
  const { from, to } = window(c);
  const f = journalFilter(c);
  const { sql, binds } = journalWhere(f, from, to);

  // What the window holds, before the limit — so the screen can say "200 of
  // 1,842" rather than implying the window contained exactly what fitted.
  const counted = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM journal_entries e WHERE ${sql}`,
    ...binds,
  );

  const entries = await all<{ id: string }>(
    c.env.DB,
    `SELECT e.*, ${ENTRY_NUMBER} AS number, u.name AS user_name
       FROM journal_entries e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${sql}
      ORDER BY e.value_at DESC, e.rowid DESC LIMIT ${JOURNAL_LIMIT}`,
    ...binds,
  );

  // The lines for exactly the entries returned, so a filtered journal cannot
  // show an entry whose legs are missing or legs whose entry is not there.
  //
  // Selected by **repeating the query**, not by binding the ids that came
  // back: `IN (?1 … ?200)` is 200 bind variables and D1 allows 100, so the
  // unfiltered journal — the common case — failed with a SQLITE_ERROR while a
  // filtered one that happened to return fewer than a hundred entries worked.
  // The subquery carries the same filter binds and needs none of its own.
  const lines = await all(
    c.env.DB,
    `SELECT l.*, a.name AS account_name
       FROM journal_lines l JOIN accounts a ON a.code = l.account_code
      WHERE l.entry_id IN (
        SELECT e.id FROM journal_entries e
         WHERE ${sql}
         ORDER BY e.value_at DESC, e.rowid DESC LIMIT ${JOURNAL_LIMIT}
      )
      ORDER BY l.entry_id, l.rowid`,
    ...binds,
  );

  return c.json({
    from,
    to,
    entries,
    lines,
    total: counted?.n ?? entries.length,
    shown: entries.length,
  });
});

accounting.get("/accounts", async (c) => {
  const rows = await all(c.env.DB, "SELECT * FROM accounts ORDER BY sort");
  return c.json({ accounts: rows });
});

// ---------------------------------------------------------------------------
// The general ledger
// ---------------------------------------------------------------------------

type LedgerLine = {
  entry_id: string;
  number: string;
  value_at: number;
  booked_at: number;
  memo: string;
  line_memo: string;
  ref_type: string;
  ref_id: string;
  user_name: string | null;
  amount: number;
};

/**
 * One account, movement by movement, with the balance after each.
 *
 * The **opening balance** is everything before the window, summed — without it
 * a running balance is a running total of an arbitrary slice and means
 * nothing. Ordering is `value_at, rowid`: two entries value-dated the same day
 * still have to come out in the order they were written, or the running
 * balance is not reproducible.
 */
async function generalLedger(db: D1Database, code: string, from: number, to: number) {
  const opening = await one<{ balance: number }>(
    db,
    `SELECT COALESCE(SUM(l.amount), 0) AS balance
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_code = ?1 AND e.value_at < ?2`,
    code,
    from,
  );
  const rows = await all<LedgerLine>(
    db,
    `SELECT l.entry_id, l.amount, l.memo AS line_memo,
            ${ENTRY_NUMBER} AS number, e.value_at, e.booked_at, e.memo, e.ref_type, e.ref_id,
            u.name AS user_name
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE l.account_code = ?1 AND e.value_at BETWEEN ?2 AND ?3
      ORDER BY e.value_at, e.rowid, l.rowid
      LIMIT 2000`,
    code,
    from,
    to,
  );
  let balance = opening?.balance ?? 0;
  const lines = rows.map((r) => {
    balance += r.amount;
    return { ...r, balance };
  });
  return { opening: opening?.balance ?? 0, lines, closing: balance };
}

accounting.get("/ledger", async (c) => {
  const { from, to } = window(c);
  const code = (c.req.query("account_code") ?? "").trim();
  if (code.length === 0) throw badRequest("no_account", "say which account to open");
  const account = await one<{ code: string; name: string; kind: string; normal: string }>(
    c.env.DB,
    "SELECT code, name, kind, normal FROM accounts WHERE code = ?1",
    code,
  );
  if (!account) throw badRequest("no_account", "there is no account with that code");
  const ledger = await generalLedger(c.env.DB, code, from, to);
  return c.json({ from, to, account, ...ledger });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const VIEWS = ["trial", "pl", "balance", "journal", "ledger", "accounts"] as const;

/**
 * The books as a file somebody else can open.
 *
 * One route with a `view`, rather than six routes, because every sheet takes
 * the same window and produces the same shape of answer — and because the
 * screen's Export button then needs to know one URL and the name of the sheet
 * it is already showing.
 *
 * **An unrecognised view is refused.** Falling back to a default would hand
 * somebody a trial balance in a file named `profit-and-loss.csv`, which is a
 * worse outcome than an error: they would file it.
 */
accounting.get("/export", async (c) => {
  const view = (c.req.query("view") ?? "trial").trim();
  if (!(VIEWS as readonly string[]).includes(view)) {
    throw badRequest("bad_view", `no such sheet: ${view}`, { views: VIEWS });
  }
  const { from, to } = window(c);
  const currency = currencyOf(await readSettings(c.env.DB));
  const money = (v: number) => plainAmount(v, currency);
  const rows: string[][] = preamble(view, from, to);

  if (view === "trial") {
    const all_ = await balances(c.env.DB, from, to);
    const lines = all_.filter((r) => r.balance !== 0);
    rows.push(["Code", "Account", "Kind", "Normal", "Debit", "Credit", "Balance"]);
    for (const r of lines) {
      rows.push([
        r.code,
        r.name,
        r.kind,
        r.normal,
        money(r.balance > 0 ? r.balance : 0),
        money(r.balance < 0 ? -r.balance : 0),
        money(presentable(r)),
      ]);
    }
    const debit = lines.reduce((a, r) => a + (r.balance > 0 ? r.balance : 0), 0);
    const credit = lines.reduce((a, r) => a + (r.balance < 0 ? -r.balance : 0), 0);
    rows.push([]);
    rows.push(["", "Totals", "", "", money(debit), money(credit), money(debit - credit)]);
  }

  if (view === "pl") {
    const all_ = await balances(c.env.DB, from, to);
    const income = all_.filter((r) => r.kind === "income");
    const expense = all_.filter((r) => r.kind === "expense");
    // Split on the same rule the totals use, so the sections and the footer
    // cannot disagree about which account is a cost of sale.
    const isCogs = (code: string) => code === "5000" || code === "5100";
    rows.push(["Section", "Code", "Account", "Amount"]);
    for (const r of income) rows.push(["Revenue", r.code, r.name, money(presentable(r))]);
    for (const r of expense.filter((r) => isCogs(r.code))) {
      rows.push(["Cost of sales", r.code, r.name, money(presentable(r))]);
    }
    for (const r of expense.filter((r) => !isCogs(r.code))) {
      rows.push(["Operating expenses", r.code, r.name, money(presentable(r))]);
    }
    const revenue = totalOf(all_, "income");
    const cogs = expense.filter((r) => isCogs(r.code)).reduce((a, r) => a + r.balance, 0);
    const operating = expense.filter((r) => !isCogs(r.code)).reduce((a, r) => a + r.balance, 0);
    rows.push([]);
    rows.push(["", "", "Revenue", money(revenue)]);
    rows.push(["", "", "Cost of sales", money(cogs)]);
    rows.push(["", "", "Gross profit", money(revenue - cogs)]);
    rows.push(["", "", "Operating expenses", money(operating)]);
    rows.push(["", "", "Net profit", money(revenue - cogs - operating)]);
  }

  if (view === "balance") {
    const asAt = Number(c.req.query("as_at") ?? String(to));
    const all_ = await balances(c.env.DB, 0, asAt);
    rows.push(["Section", "Code", "Account", "Amount"]);
    for (const r of all_.filter((r) => r.kind === "asset")) {
      rows.push(["Asset", r.code, r.name, money(presentable(r))]);
    }
    for (const r of all_.filter((r) => r.kind === "liability")) {
      rows.push(["Liability", r.code, r.name, money(presentable(r))]);
    }
    for (const r of all_.filter((r) => r.kind === "equity")) {
      rows.push(["Equity", r.code, r.name, money(presentable(r))]);
    }
    const earned = totalOf(all_, "income") - totalOf(all_, "expense");
    const assets = totalOf(all_, "asset");
    const liabilities = totalOf(all_, "liability");
    const posted = totalOf(all_, "equity");
    rows.push(["Equity", "", "Retained earnings (computed)", money(earned)]);
    rows.push([]);
    rows.push(["", "", "Total assets", money(assets)]);
    rows.push(["", "", "Total liabilities", money(liabilities)]);
    rows.push(["", "", "Total equity", money(posted + earned)]);
    // The number that says whether the sheet can be trusted. It belongs in the
    // file, not only on the screen.
    rows.push(["", "", "Out by", money(assets - (liabilities + posted + earned))]);
  }

  if (view === "journal") {
    const f = journalFilter(c);
    const { sql, binds } = journalWhere(f, from, to);
    const LIMIT = 5000;
    const lines = await all<{
      number: string;
      value_at: number;
      booked_at: number;
      ref_type: string;
      memo: string;
      account_code: string;
      account_name: string;
      amount: number;
      line_memo: string;
      user_name: string | null;
    }>(
      c.env.DB,
      `SELECT ${ENTRY_NUMBER} AS number, e.value_at, e.booked_at, e.ref_type, e.memo,
              l.account_code, a.name AS account_name, l.amount, l.memo AS line_memo,
              u.name AS user_name
         FROM journal_entries e
         JOIN journal_lines l ON l.entry_id = e.id
         JOIN accounts a ON a.code = l.account_code
         LEFT JOIN users u ON u.id = e.user_id
        WHERE ${sql}
        ORDER BY e.value_at, e.rowid, l.rowid
        LIMIT ${LIMIT}`,
      ...binds,
    );
    rows.push([
      "Entry", "Value date", "Booked", "Caused by", "Memo",
      "Code", "Account", "Debit", "Credit", "Line memo", "Who",
    ]);
    for (const l of lines) {
      rows.push([
        l.number,
        isoDay(l.value_at),
        isoDay(l.booked_at),
        l.ref_type.replaceAll("_", " "),
        l.memo,
        l.account_code,
        l.account_name,
        money(l.amount > 0 ? l.amount : 0),
        money(l.amount < 0 ? -l.amount : 0),
        l.line_memo ?? "",
        l.user_name ?? "",
      ]);
    }
    // Say so rather than stopping silently. A file that is quietly short is a
    // file somebody reconciles against and cannot make balance.
    if (lines.length === LIMIT) {
      rows.push([]);
      rows.push(["", "", "", "", `Truncated at ${LIMIT} lines — narrow the window`]);
    }
  }

  if (view === "ledger") {
    const code = (c.req.query("account_code") ?? "").trim();
    if (code.length === 0) throw badRequest("no_account", "say which account to export");
    const account = await one<{ code: string; name: string }>(
      c.env.DB,
      "SELECT code, name FROM accounts WHERE code = ?1",
      code,
    );
    if (!account) throw badRequest("no_account", "there is no account with that code");
    const ledger = await generalLedger(c.env.DB, code, from, to);
    rows.push(["Account", `${account.code} ${account.name}`]);
    rows.push([]);
    rows.push(["Date", "Entry", "Memo", "Caused by", "Who", "Debit", "Credit", "Balance"]);
    rows.push([isoDay(from), "", "Opening balance", "", "", "", "", money(ledger.opening)]);
    for (const l of ledger.lines) {
      rows.push([
        isoDay(l.value_at),
        l.number,
        l.line_memo || l.memo,
        l.ref_type.replaceAll("_", " "),
        l.user_name ?? "",
        money(l.amount > 0 ? l.amount : 0),
        money(l.amount < 0 ? -l.amount : 0),
        money(l.balance),
      ]);
    }
    rows.push([]);
    rows.push(["", "", "Closing balance", "", "", "", "", money(ledger.closing)]);
  }

  if (view === "accounts") {
    const all_ = await balances(c.env.DB, 0, to);
    rows.push(["Code", "Name", "Kind", "Normal", "Balance to date"]);
    for (const r of all_) {
      rows.push([r.code, r.name, r.kind, r.normal, money(presentable(r))]);
    }
  }

  return csvResponse(`${view}-${isoDay(from)}.csv`, csvDoc(rows));
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

accounting.get("/expenses", async (c) => {
  const { from, to } = window(c);
  const account = (c.req.query("account_code") ?? "").trim();
  const binds: unknown[] = [from, to];
  let extra = "";
  if (account.length > 0) {
    binds.push(account);
    extra = ` AND e.account_code = ?${binds.length}`;
  }
  const rows = await all(
    c.env.DB,
    `SELECT e.*, u.name AS user_name, a.name AS account_name, s.name AS supplier_name
       FROM expenses e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN accounts a ON a.code = e.account_code
       LEFT JOIN suppliers s ON s.id = e.supplier_id
      WHERE e.spent_at BETWEEN ?1 AND ?2 ${extra}
      ORDER BY e.spent_at DESC LIMIT 200`,
    ...binds,
  );
  const byCategory = await all(
    c.env.DB,
    `SELECT category, COUNT(*) AS count, SUM(amount) AS amount
       FROM expenses WHERE spent_at BETWEEN ?1 AND ?2
      GROUP BY category ORDER BY amount DESC`,
    from,
    to,
  );
  // By account as well as by category: the account is what the profit and loss
  // is built from, and the category is the shopkeeper's own wording for it.
  const byAccount = await all(
    c.env.DB,
    `SELECT e.account_code, COALESCE(a.name, e.account_code) AS account_name,
            COUNT(*) AS count, SUM(e.amount) AS amount, SUM(e.tax) AS tax
       FROM expenses e LEFT JOIN accounts a ON a.code = e.account_code
      WHERE e.spent_at BETWEEN ?1 AND ?2
      GROUP BY e.account_code, account_name ORDER BY amount DESC`,
    from,
    to,
  );
  const totals = await one<{ amount: number; tax: number; count: number }>(
    c.env.DB,
    `SELECT COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(tax), 0) AS tax,
            COUNT(*) AS count
       FROM expenses WHERE spent_at BETWEEN ?1 AND ?2`,
    from,
    to,
  );
  return c.json({
    from,
    to,
    expenses: rows,
    by_category: byCategory,
    by_account: byAccount,
    totals: totals ?? { amount: 0, tax: 0, count: 0 },
  });
});

/**
 * Which accounts a running cost may be booked against.
 *
 * The 5000-series is withheld deliberately. `5000` cost of goods, `5100` waste
 * and `5200` cash over and short are posted by sales, stock movements and
 * drawer counts — offering them here would let the same money be counted
 * twice, once by the machinery and once by hand.
 */
accounting.get("/expense-accounts", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT code, name FROM accounts
      WHERE kind = 'expense' AND code NOT LIKE '5%' ORDER BY sort`,
  );
  return c.json({ accounts: rows });
});

accounting.post("/expenses", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const amount = int(body, "amount");
  if (amount <= 0) throw badRequest("bad_amount", "an expense has to be more than nothing");
  const method = oneOf(body, "method", ["cash", "card", "wallet", "on_account"] as const);
  const category = str(body, "category");

  // The tax inside the amount, not on top of it — so it can never exceed it.
  const tax = optInt(body, "tax", 0);
  if (tax < 0) throw badRequest("bad_tax", "the tax cannot be negative");
  if (tax > amount) throw badRequest("bad_tax", "the tax cannot be more than the amount");

  // The account has to exist, has to be an expense account, and must not be
  // one the machinery already posts to.
  const accountCode = optStr(body, "account_code") || "6000";
  const account = await one<{ code: string; kind: string }>(
    c.env.DB,
    "SELECT code, kind FROM accounts WHERE code = ?1",
    accountCode,
  );
  if (!account || account.kind !== "expense" || account.code.startsWith("5")) {
    throw badRequest("bad_account", "that is not an account a running cost can be booked to");
  }

  const supplierId = optStr(body, "supplier_id") || null;
  const id = newId("exp");
  const at = now();
  const spentAt = optInt(body, "spent_at", at);

  const statements = [
    stmt(
      c.env.DB,
      `INSERT INTO expenses (id, category, payee, amount, tax, method, account_code,
                             supplier_id, reference, note, spent_at, user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      id,
      category,
      optStr(body, "payee"),
      amount,
      tax,
      method,
      accountCode,
      supplierId,
      optStr(body, "reference"),
      optStr(body, "note"),
      spentAt,
      actor.userId,
      at,
    ),
  ];
  const enabled = await one<{ value: string }>(
    c.env.DB,
    "SELECT value FROM settings WHERE key = 'accounting.enabled'",
  );
  if ((enabled?.value ?? "0") === "1") {
    statements.push(
      ...post(
        c.env.DB,
        expenseEntry({
          expenseId: id,
          at: spentAt,
          amount,
          tax,
          method,
          account: accountCode,
          category,
          userId: actor.userId,
          // Paying on account is not a payment. It moves the cost onto what
          // the shop owes rather than out of the safe, and the payables list
          // is where it is settled from.
          onAccount: method === "on_account",
        }),
      ),
    );
  }
  // Money leaving the shop is logged whoever authorised it. Once the journal
  // entry is written it is immutable, so the audit trail is the only place
  // left to ask who recorded this and when.
  statements.push(
    stmt(
      c.env.DB,
      `INSERT INTO audit_log (id, at, user_id, approved_by, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?3, 'expense', 'expense', ?4, ?5, ?6)`,
      newId("aud"),
      at,
      actor.userId,
      id,
      -amount,
      `${accountCode} ${category}`,
    ),
  );
  await batch(c.env.DB, statements);
  return c.json({ id }, 201);
});

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/**
 * Closing a month.
 *
 * Once closed, nothing can be posted into it — including a backdated
 * correction, which is the write this exists to stop, because the month has
 * already been reported to the outside world. The refusal is a trigger on
 * `journal_entries` rather than a check here, so it holds against every path
 * into the database and not only against this endpoint.
 */
accounting.post("/periods/close", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const startsAt = int(body, "starts_at");
  const endsAt = int(body, "ends_at");
  if (endsAt <= startsAt) throw badRequest("bad_window", "a period has to end after it starts");

  const overlap = await one<{ id: string }>(
    c.env.DB,
    `SELECT id FROM fiscal_periods
      WHERE closed_at IS NOT NULL AND starts_at <= ?2 AND ends_at >= ?1`,
    startsAt,
    endsAt,
  );
  if (overlap) throw conflict("already_closed", "part of that window is already closed");

  // A month that has not finished cannot be reported, so closing it is either
  // a mistake or a decision to stop trading in it. Refused rather than
  // second-guessed — the only way back out is Reopen, which is an event of its
  // own in the audit trail.
  const at = now();
  if (endsAt > at) {
    throw badRequest("not_over", "that period has not finished yet");
  }

  const id = newId("per");
  const actor = c.get("actor");
  await run(
    c.env.DB,
    `INSERT INTO fiscal_periods (id, starts_at, ends_at, closed_at, closed_by, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    id,
    startsAt,
    endsAt,
    at,
    actor.userId,
    optStr(body, "note"),
  );
  await run(
    c.env.DB,
    `INSERT INTO audit_log (id, at, user_id, approved_by, action, ref_type, ref_id, detail)
     VALUES (?1, ?2, ?3, ?3, 'close_period', 'period', ?4, ?5)`,
    newId("aud"),
    at,
    actor.userId,
    id,
    optStr(body, "note"),
  );
  return c.json({ id }, 201);
});

/**
 * Undo a posting, by posting its opposite.
 *
 * Not a delete — there is no delete. The reversal is a second entry linked to
 * the first, dated today, and both stay in the journal. A reader sees what
 * happened *and* that it was undone, which is the whole reason the tables
 * refuse UPDATE in the first place.
 *
 * Reversing a reversal is refused: two entries that already net to zero do not
 * need a third, and allowing it makes an unbounded chain out of what should be
 * a pair.
 */
accounting.post("/entries/:id/reverse", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const entryId = c.req.param("id");
  const reason = str(body, "reason").trim();
  if (reason.length === 0) throw badRequest("bad_reason", "a correction needs a reason");

  const original = await one<{
    id: string; memo: string; ref_type: string; ref_id: string; corrects_id: string | null;
  }>(
    c.env.DB,
    "SELECT id, memo, ref_type, ref_id, corrects_id FROM journal_entries WHERE id = ?1",
    entryId,
  );
  if (!original) throw badRequest("no_entry", "there is no entry with that id");
  if (original.corrects_id) {
    throw conflict("already_a_reversal", "that entry is itself a correction");
  }

  const undone = await one<{ id: string }>(
    c.env.DB,
    "SELECT id FROM journal_entries WHERE corrects_id = ?1",
    entryId,
  );
  if (undone) throw conflict("already_reversed", "that entry has already been reversed");

  const lines = await all<{ account_code: string; amount: number; memo: string }>(
    c.env.DB,
    "SELECT account_code, amount, memo FROM journal_lines WHERE entry_id = ?1 ORDER BY rowid",
    entryId,
  );
  if (lines.length === 0) throw conflict("no_lines", "that entry has nothing to reverse");

  const at = now();
  await batch(
    c.env.DB,
    post(c.env.DB, reversalEntry({ original, lines, at, reason, userId: actor.userId })),
  );
  await run(
    c.env.DB,
    `INSERT INTO audit_log (id, at, user_id, approved_by, action, ref_type, ref_id, detail)
     VALUES (?1, ?2, ?3, ?3, 'reverse_entry', 'journal', ?4, ?5)`,
    newId("aud"),
    at,
    actor.userId,
    entryId,
    reason,
  );
  return c.json({ ok: true, reversed: entryId }, 201);
});

accounting.post("/periods/:id/reopen", async (c) => {
  await run(c.env.DB, "UPDATE fiscal_periods SET closed_at = NULL WHERE id = ?1", c.req.param("id"));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Is any of this still true?
// ---------------------------------------------------------------------------

/**
 * The sweep.
 *
 * Structure stops most mistakes here — a signed amount column makes "balanced"
 * one condition, and triggers make an entry immutable — and the posting rules
 * stop most of the rest. But neither catches a bug that already shipped, and
 * every figure below is cheap enough to re-derive whenever somebody opens the
 * page. That is the point: an invariant nobody checks is a comment.
 *
 * The one thing here that is *not* a failure is the last: the shelves are
 * valued at what each product costs **today**, while account 1200 carries what
 * that stock cost **when it was bought**. A supplier raising their price
 * revalues the shelf and must not rewrite history, so the two are shown side by
 * side with the reason rather than raised as an alarm.
 */
accounting.get("/health", async (c) => {
  const sides = await one<{ debit: number; credit: number }>(
    c.env.DB,
    `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS debit,
            COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS credit
       FROM journal_lines`,
  );
  const entries = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM journal_entries");

  // An entry whose lines do not sum to zero. `post` refuses to build one, so
  // this is asking whether anything ever got past `post`.
  const unbalanced = await all<{ id: string; memo: string; out_by: number }>(
    c.env.DB,
    `SELECT e.id, e.memo, SUM(l.amount) AS out_by
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      GROUP BY e.id, e.memo HAVING SUM(l.amount) <> 0 LIMIT 20`,
  );

  // A line whose entry is not there. `journal_lines.entry_id` carries a
  // REFERENCES clause, but D1 does not enforce foreign keys unless they are
  // switched on — so the constraint is documentation until this counts it.
  const orphans = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM journal_lines l
      WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = l.entry_id)`,
  );

  const rows = await balances(c.env.DB, 0, now());
  const assets = totalOf(rows, "asset");
  const liabilities = totalOf(rows, "liability");
  const equity = totalOf(rows, "equity");
  const earned = totalOf(rows, "income") - totalOf(rows, "expense");

  // `products.stock` is a running cache of the movements. Nothing has ever
  // checked that the cache still agrees with what it caches.
  const drift = await all<{
    sku: string; name: string; stock: number; moved: number;
  }>(
    c.env.DB,
    `SELECT p.sku, p.name, p.stock,
            COALESCE((SELECT SUM(m.qty_delta) FROM stock_movements m
                       WHERE m.product_id = p.id), 0) AS moved
       FROM products p
      WHERE p.active = 1
        AND ABS(p.stock - COALESCE((SELECT SUM(m.qty_delta) FROM stock_movements m
                                     WHERE m.product_id = p.id), 0)) > 0.001
      ORDER BY p.name LIMIT 20`,
  );

  const shelf = await one<{ at_cost: number }>(
    c.env.DB,
    `SELECT COALESCE(SUM(CAST(ROUND(stock * cost) AS INTEGER)), 0) AS at_cost
       FROM products WHERE active = 1`,
  );
  const booked = await one<{ amount: number }>(
    c.env.DB,
    "SELECT COALESCE(SUM(amount), 0) AS amount FROM journal_lines WHERE account_code = '1200'",
  );

  const debit = sides?.debit ?? 0;
  const credit = sides?.credit ?? 0;
  const outBy = assets - (liabilities + equity + earned);
  return c.json({
    total_debit: debit,
    total_credit: credit,
    sides_agree: debit === credit,
    entries: entries?.n ?? 0,
    unbalanced,
    orphan_lines: orphans?.n ?? 0,
    equation_holds: outBy === 0,
    out_by: outBy,
    stock_drift: drift,
    stock_at_cost: shelf?.at_cost ?? 0,
    stock_in_ledger: booked?.amount ?? 0,
    stock_gap: (shelf?.at_cost ?? 0) - (booked?.amount ?? 0),
    // One verdict, so a card can be green or red without re-deriving the rule.
    healthy:
      debit === credit && unbalanced.length === 0 && (orphans?.n ?? 0) === 0 &&
      outBy === 0 && drift.length === 0,
  });
});

/**
 * Switching the books on in a shop that has already been trading.
 *
 * Accounting is off until somebody turns it on, and until then nothing is
 * posted. So on the day it is switched on the ledger says the shop owns
 * nothing — while the shelves are full and there is money in the safe. Every
 * report is then wrong in the same direction until enough time passes for
 * nobody to remember why.
 *
 * This posts the one entry that fixes it: what is actually on hand, against
 * owner capital. It is the shopkeeper stating what they are starting with,
 * which is exactly what owner capital means.
 *
 * Refused once it has been done. Two opening entries is not an opening
 * balance, it is a shop that owns its stock twice.
 */
accounting.post("/opening-balances", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");

  const already = await one<{ id: string }>(
    c.env.DB,
    "SELECT id FROM journal_entries WHERE ref_type = 'opening' LIMIT 1",
  );
  if (already) throw conflict("already_opened", "the opening balances have already been posted");

  const safe = optInt(body, "cash_in_safe", 0);
  const drawer = optInt(body, "cash_in_drawer", 0);
  if (safe < 0 || drawer < 0) throw badRequest("bad_amount", "cash cannot be negative");

  // Stock is not typed in. It is what the catalogue already says is on the
  // shelf, at what each product cost — asking for it again would invite a
  // figure that disagrees with the stock the till is about to sell from.
  const shelf = await one<{ at_cost: number }>(
    c.env.DB,
    `SELECT COALESCE(SUM(CAST(ROUND(stock * cost) AS INTEGER)), 0) AS at_cost
       FROM products WHERE active = 1`,
  );
  const stock = shelf?.at_cost ?? 0;
  const capital = stock + safe + drawer;
  if (capital === 0) {
    throw badRequest("nothing_to_open", "there is no stock and no cash to open with");
  }

  const at = optInt(body, "at", now());
  await batch(
    c.env.DB,
    post(c.env.DB, {
      valueAt: at,
      bookedAt: now(),
      memo: "Opening balances",
      refType: "opening",
      refId: "opening",
      userId: actor.userId,
      postings: [
        { account: ACC.stock, amount: stock, memo: "stock on hand at cost" },
        { account: ACC.safe, amount: safe, memo: "cash in the safe" },
        { account: ACC.drawer, amount: drawer, memo: "cash in the drawer" },
        { account: ACC.capital, amount: -capital, memo: "what the shop is starting with" },
      ],
    }),
  );
  return c.json({ ok: true, stock, cash_in_safe: safe, cash_in_drawer: drawer, capital }, 201);
});
