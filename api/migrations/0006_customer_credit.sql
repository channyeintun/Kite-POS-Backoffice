-- Selling on credit: the tab, and what is still on it.
--
-- A corner shop gives credit. Somebody takes their shopping and pays on
-- payday, or pays half now and the rest when they can, and the shopkeeper
-- writes it in a book by the till. This is that book.
--
-- **It is the opposite of `customers.credit`, and the two must never be
-- confused.** `credit` is store credit *owed to the customer* — a liability,
-- posted to `2200`, created by a refund and spent as a tender. `owed` below is
-- money the *customer owes the shop* — an asset, posted to `1100`. Netting one
-- into the other would be a sign error that balances perfectly and is wrong in
-- both directions at once, so they are separate columns against separate
-- accounts with separate words in both languages.

-- ---------------------------------------------------------------------------
-- The account the debt lives in
-- ---------------------------------------------------------------------------
--
-- `1100` sits between `1020 Card & wallet clearing` and `1200 Stock on hand`,
-- which is where an accountant looks for it: current assets in the order they
-- turn back into cash. It has to exist before anything posts, because
-- `journal_lines.account_code` is a foreign key to `accounts (code)` and a sale
-- posts its lines in the same batch as its stock movements — so a missing
-- account does not fail a posting, it rolls back the sale.

INSERT INTO accounts (code, name, kind, normal, sort) VALUES
  ('1100', 'Owed by customers', 'asset', 'debit', 35);

-- ---------------------------------------------------------------------------
-- What a customer may owe, and what they do owe
-- ---------------------------------------------------------------------------
--
-- **`credit_limit` defaults to 0, and 0 means no credit.** Trusting somebody
-- with the shop's stock is a decision a person makes about a person; it is not
-- a default. A shopkeeper raises the limit in the back office for the
-- customers they know, and everybody else is refused at the lane with a
-- sentence that says so.
--
-- **`owed` is a running figure, kept for the same reason `products.stock` is.**
-- The till has to answer "can this basket go on the tab" in one read, with a
-- queue waiting. What makes it trustworthy is that every change to it is a row
-- somewhere else that says what moved it: a `payments` row with method
-- `on_account` put it up, a `customer_payments` row brought it down, and a
-- refund against an unpaid sale takes it back off. It is never typed by a
-- person and never written except beside one of those rows.
--
-- It is also what makes the credit limit enforceable. D1 has no interactive
-- transaction, so "are they under their limit" cannot be a SELECT followed by
-- an INSERT that assumes the answer held — two lanes would both read the same
-- balance and both sell. With the figure on the row it is a conditional write,
-- `WHERE owed + ?2 <= credit_limit`, which one of the two loses.

ALTER TABLE customers ADD COLUMN credit_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN owed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX customers_owing ON customers (owed) WHERE owed > 0;

-- ---------------------------------------------------------------------------
-- `on_account` as a tender
-- ---------------------------------------------------------------------------
--
-- The unpaid part of a sale is a **payment row**, not a column on the sale, and
-- that choice does most of the work of this feature:
--
--   * The rule that payments must cover the total survives untouched. A sale
--     settled half in cash and half on the tab still tenders its full value, so
--     "short" stays the refusal it was and nothing downstream has to learn that
--     a sale might not add up.
--   * `saleEntry` already walks the payments and posts each to the account its
--     tender lands in. Giving `on_account` an account is the whole ledger
--     change: the shop debits what it is owed instead of what it took.
--   * The tender breakdown on a shift, on a report and on a receipt gains a
--     line saying how much of the day went on tabs, for free and in the right
--     place.
--   * The amount owed is a snapshot on a row that nothing reprices, which
--     `sales.total` is not — it is rewritten every time a held basket is read.
--
-- The cost is this table rebuild. SQLite cannot alter a CHECK constraint in
-- place, and the constraint is worth keeping: it is what stops a typo becoming
-- a tender. Nothing has a foreign key into `payments`, so the copy is the plain
-- twelve-step and the only index to put back is `payments_sale`.

CREATE TABLE payments_new (
  id         TEXT PRIMARY KEY,
  sale_id    TEXT NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  -- `on_account` is the customer's tab. It is the one tender that moves no
  -- money at all: the shop hands over the goods and books what it is owed.
  method     TEXT NOT NULL CHECK (method IN ('cash', 'card', 'wallet', 'store_credit', 'on_account')),
  -- What the sale is credited. `tendered` is what the customer handed over, and
  -- only cash may exceed the amount due — a card charged more than the balance
  -- is an overcharge, so the till refuses it rather than making change from one.
  amount     INTEGER NOT NULL,
  tendered   INTEGER NOT NULL DEFAULT 0,
  change     INTEGER NOT NULL DEFAULT 0,
  reference  TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

INSERT INTO payments_new (id, sale_id, method, amount, tendered, change, reference, created_at)
  SELECT id, sale_id, method, amount, tendered, change, reference, created_at FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX payments_sale ON payments (sale_id);

-- ---------------------------------------------------------------------------
-- Money coming back against a tab
-- ---------------------------------------------------------------------------
--
-- Shaped like `refunds` and `refund_items`, because it is the same kind of
-- event: one thing a person did, and the several older things it settled.
--
--   * `customer_payments` is what happened — somebody put money on the counter,
--     at a lane or in the back office, on a date, taken by a named person.
--   * `customer_payment_items` is where it went, oldest tab first. Allocation
--     is what makes aging mean anything: without it "K40,000 owed" cannot say
--     whether it is last week's shopping or last year's.
--
-- `shift_id` is **the drawer open now on the lane taking the money**, never the
-- one the original sale was rung on. That distinction is written down in
-- `lib/refunds.ts` because getting it wrong once already cost a cashier a
-- shortfall they had not caused: cash that physically enters today's drawer has
-- to be counted in today's drawer, whatever week the debt is from. It is null
-- for a settlement taken in the back office, which has no drawer — that money
-- goes to the safe, the way a supplier is paid.
--
-- `client_id` is the idempotency key and it is not optional at a counter. A
-- settlement that completes and loses its answer on the way back must find
-- itself on the retry rather than be taken twice.

CREATE TABLE customer_payments (
  id          TEXT PRIMARY KEY,
  client_id   TEXT UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  shift_id    TEXT REFERENCES shifts (id),
  register_id TEXT REFERENCES registers (id),
  -- No `on_account` here, and no `store_credit`: a tab is settled with money.
  method      TEXT NOT NULL CHECK (method IN ('cash', 'card', 'wallet')),
  total       INTEGER NOT NULL,
  reference   TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX customer_payments_customer ON customer_payments (customer_id, created_at);
CREATE INDEX customer_payments_shift ON customer_payments (shift_id);

-- **How much of a refund went back onto the tab rather than into a hand.**
--
-- Goods bought on credit cannot be refunded in money: the shop would be paying
-- out cash it never received, against stock it now has back. But a basket paid
-- half in cash and half on the tab cannot be refused either — that is the most
-- ordinary thing this feature creates, and the first version of it refused
-- exactly that case from every screen and every method, which left the goods on
-- the shelf, the customer's cash gone and the debt standing.
--
-- So a refund has two legs. The tab is paid down first, up to what it still
-- holds, and whatever is left over goes back by `method` like any other refund.
-- `on_account` is the first leg and `total - on_account` is the second, which
-- is why the drawer's own figure is now `total - on_account` rather than
-- `total`: a refund that took nothing out of the till must not be counted as
-- though it did.
ALTER TABLE refunds ADD COLUMN on_account INTEGER NOT NULL DEFAULT 0;

-- Every receivables query starts "this customer's completed sales", and there
-- was no index that could answer it: `sales` is indexed by status, by shift, by
-- completion and by number, and not once by who the sale was for. On a shop
-- with a year of trading behind it, opening the Customers screen scanned every
-- sale ever rung, once per subquery.
CREATE INDEX sales_customer ON sales (customer_id, completed_at);

CREATE TABLE customer_payment_items (
  id         TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES customer_payments (id) ON DELETE CASCADE,
  sale_id    TEXT NOT NULL REFERENCES sales (id),
  amount     INTEGER NOT NULL
);
CREATE INDEX customer_payment_items_payment ON customer_payment_items (payment_id);
CREATE INDEX customer_payment_items_sale ON customer_payment_items (sale_id);
