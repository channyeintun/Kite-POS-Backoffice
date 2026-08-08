-- Kite POS — the shape of the shop.
--
-- Every money column is an INTEGER count of the currency's minor unit. Which
-- unit that is comes from the `currency.minor_units` setting: 0 for MMK, where
-- 31700 means K31,700, and 2 for a currency with cents. Nothing in this schema
-- knows which — it counts whole minor units and the presentation layer decides
-- where a separator goes. A REAL price column is how a till loses a kyat a day
-- and nobody can say where it went.
--
-- Quantities are the one legitimate float, because 0.35 kg of loose goods is a
-- measurement rather than a count. They are REAL, and every product of a
-- quantity and a price is rounded back to a whole minor unit at that boundary.

-- Foreign keys are enforced by D1 by default, and `PRAGMA foreign_keys` is a
-- no-op inside a transaction — which is what a migration runs in. So there is
-- no pragma here: the constraints below are live because of the platform, not
-- because this file asked.

-- ---------------------------------------------------------------------------
-- Settings, staff, and the devices that sell
-- ---------------------------------------------------------------------------

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A role decides which app a sign-in opens, and there is no navigation between
-- them: `sale_staff` opens the till, `manager` and `owner` open the back
-- office. That is the whole of the app-routing rule, held in one column.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('sale_staff', 'manager', 'owner')),
  -- Sale staff sign in with a PIN at the lane; managers and owners with a
  -- username and password. Both are PBKDF2 with a per-user salt, never a bare
  -- digest — a 4-digit PIN has ten thousand possibilities and an unsalted hash
  -- of one is a lookup table.
  pin_hash      TEXT,
  username      TEXT UNIQUE,
  password_hash TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX users_role ON users (role, active);

-- A lane. The back office reaches a till through this table and never by
-- navigating into the POS app.
--
-- Declared before `sessions` because `sessions` points at it. SQLite resolves
-- a foreign key when it is used rather than when it is declared, so the other
-- order would also load — and would leave a schema whose tables cannot be
-- created one at a time, which is a thing a person doing surgery on a database
-- at 6am wants to be able to do.
CREATE TABLE registers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'counter' CHECK (kind IN ('counter', 'handheld')),
  active       INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  register_id TEXT REFERENCES registers (id),
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Shifts: a drawer session
-- ---------------------------------------------------------------------------
--
-- `expected` is never written by a human. It is opening_float + cash taken −
-- change given + cash in − cash out − cash refunds, derived at close from the
-- rows that caused each term. `counted` is the only figure a person types, and
-- the difference between them is the variance the books have to absorb.

CREATE TABLE shifts (
  id             TEXT PRIMARY KEY,
  register_id    TEXT NOT NULL REFERENCES registers (id),
  user_id        TEXT NOT NULL REFERENCES users (id),
  opened_at      INTEGER NOT NULL,
  opening_float  INTEGER NOT NULL,
  closed_at      INTEGER,
  closed_by      TEXT REFERENCES users (id),
  counted_total  INTEGER,
  expected_total INTEGER,
  variance       INTEGER,
  note           TEXT
);
CREATE INDEX shifts_register ON shifts (register_id, closed_at);
-- One open shift per lane. A partial unique index is what makes "this drawer is
-- already open" a constraint violation rather than a race two tills can win.
CREATE UNIQUE INDEX shifts_one_open ON shifts (register_id) WHERE closed_at IS NULL;

CREATE TABLE cash_movements (
  id         TEXT PRIMARY KEY,
  shift_id   TEXT NOT NULL REFERENCES shifts (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('paid_in', 'paid_out', 'safe_drop')),
  amount     INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  user_id    TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL
);
CREATE INDEX cash_movements_shift ON cash_movements (shift_id);

-- ---------------------------------------------------------------------------
-- The catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  name_my  TEXT NOT NULL DEFAULT '',
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE suppliers (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  phone    TEXT NOT NULL DEFAULT '',
  email    TEXT NOT NULL DEFAULT '',
  address  TEXT NOT NULL DEFAULT '',
  lead_days INTEGER NOT NULL DEFAULT 3,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- The catalogue does not translate: a product name is one database field and
  -- is shown as stored. `name_my` exists for shops that keep a second name on
  -- purpose, and is empty for everything else.
  name_my       TEXT NOT NULL DEFAULT '',
  category_id   TEXT REFERENCES categories (id),
  supplier_id   TEXT REFERENCES suppliers (id),
  cost          INTEGER NOT NULL DEFAULT 0,
  price         INTEGER NOT NULL DEFAULT 0,
  -- Tax as basis points, so 5% is 500 and the arithmetic stays integral.
  tax_bp        INTEGER NOT NULL DEFAULT 0,
  -- 0 for anything a child may buy; 18 or 21 for the shelf behind the counter.
  min_age       INTEGER NOT NULL DEFAULT 0,
  -- Loose goods are sold by weight, so the till asks for a quantity rather than
  -- counting scans.
  unit          TEXT NOT NULL DEFAULT 'each',
  -- "Price at till": the operator is asked for the amount, because the shelf
  -- price is not in the system.
  ask_price     INTEGER NOT NULL DEFAULT 0,
  stock         REAL NOT NULL DEFAULT 0,
  reorder_point REAL NOT NULL DEFAULT 0,
  reorder_qty   REAL NOT NULL DEFAULT 0,
  -- Pinned to the till's Favourites grid, and where in it.
  quick_key     INTEGER NOT NULL DEFAULT 0,
  photo_key     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX products_category ON products (category_id, active);
CREATE INDEX products_supplier ON products (supplier_id);
CREATE INDEX products_quick ON products (quick_key) WHERE quick_key > 0;
CREATE INDEX products_name ON products (name);

-- A barcode is not a product: a tray of six eggs and a single egg are two
-- barcodes for one product, and `pack_size` is what one scan means in stock
-- units. Scanning the tray adds six and prices it once.
CREATE TABLE product_barcodes (
  barcode    TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  pack_size  REAL NOT NULL DEFAULT 1,
  label      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX product_barcodes_product ON product_barcodes (product_id);

-- ---------------------------------------------------------------------------
-- Promotions
-- ---------------------------------------------------------------------------
--
-- Which one wins is decided at the till, not here: the engine takes every offer
-- whose window contains the sale and whose scope matches the line, and applies
-- the one that saves the customer the most. Ties break on `priority`, then on
-- the older offer, so the answer never depends on row order.

CREATE TABLE promotions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_my     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL CHECK (kind IN ('percent_off', 'amount_off', 'fixed_price', 'n_for_x')),
  -- percent_off: basis points. amount_off / fixed_price: minor units.
  -- n_for_x: `value` is the price of `n` units.
  value       INTEGER NOT NULL,
  n           INTEGER NOT NULL DEFAULT 0,
  scope       TEXT NOT NULL CHECK (scope IN ('product', 'category', 'all')),
  product_id  TEXT REFERENCES products (id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories (id) ON DELETE CASCADE,
  starts_at   INTEGER,
  ends_at     INTEGER,
  priority    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX promotions_window ON promotions (active, starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  points     INTEGER NOT NULL DEFAULT 0,
  -- Store credit owed to the customer, in minor units.
  credit     INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX customers_phone ON customers (phone);
CREATE INDEX customers_name ON customers (name);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
--
-- A basket is a real row with status `held`, not something the browser is
-- holding: a refresh, a crash, a flat battery or a second tab never loses a
-- customer's shopping. The held row with an empty `hold_label` is the lane's
-- active basket; the rest are parked.
--
-- `client_id` is the idempotency key, and it is not optional on an online till.
-- A lane that sold something while the network was down replays the request
-- when it comes back, and the replay must land on the same sale rather than a
-- second one. UNIQUE is what makes "already rung" a constraint the database
-- enforces rather than a check the application hopes it ran.

CREATE TABLE sales (
  id           TEXT PRIMARY KEY,
  client_id    TEXT UNIQUE,
  number       INTEGER,
  register_id  TEXT REFERENCES registers (id),
  shift_id     TEXT REFERENCES shifts (id),
  user_id      TEXT NOT NULL REFERENCES users (id),
  customer_id  TEXT REFERENCES customers (id),
  status       TEXT NOT NULL CHECK (status IN ('held', 'completed', 'voided')),
  hold_label   TEXT NOT NULL DEFAULT '',
  -- The one amount on this row a person sets: a discount on the whole basket,
  -- which the pricer spreads across the lines by value.
  --
  -- Kept apart from `discount` below because they are an **input** and an
  -- **output**, and collapsing them into one column is a bug with a compound
  -- interest rate: the pricer reads the input, computes a total that includes
  -- the line discounts, writes it back over the input, and takes a little more
  -- off the basket every time it is read.
  basket_discount INTEGER NOT NULL DEFAULT 0,
  -- Every amount below is derived, recomputed from the lines by one function
  -- and written nowhere else. `discount` is everything that came off: the line
  -- discounts plus the basket's own.
  subtotal     INTEGER NOT NULL DEFAULT 0,
  promo_saved  INTEGER NOT NULL DEFAULT 0,
  discount     INTEGER NOT NULL DEFAULT 0,
  tax          INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  void_reason  TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX sales_status ON sales (status, created_at);
CREATE INDEX sales_shift ON sales (shift_id);
CREATE INDEX sales_completed ON sales (completed_at);
CREATE UNIQUE INDEX sales_number ON sales (number) WHERE number IS NOT NULL;
-- One active basket per lane: the held sale with no label.
CREATE UNIQUE INDEX sales_one_active ON sales (register_id)
  WHERE status = 'held' AND hold_label = '';

CREATE TABLE sale_items (
  id           TEXT PRIMARY KEY,
  sale_id      TEXT NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  product_id   TEXT REFERENCES products (id),
  -- Snapshots, so a receipt reprinted years later reads as it did on the day —
  -- after the product was renamed, repriced, or deleted.
  name         TEXT NOT NULL,
  sku          TEXT NOT NULL DEFAULT '',
  qty          REAL NOT NULL,
  unit_price   INTEGER NOT NULL,
  -- What the line would have cost with no offer, for the struck-through price.
  list_price   INTEGER NOT NULL,
  line_discount INTEGER NOT NULL DEFAULT 0,
  promo_id     TEXT REFERENCES promotions (id),
  promo_name   TEXT NOT NULL DEFAULT '',
  promo_saved  INTEGER NOT NULL DEFAULT 0,
  price_override INTEGER NOT NULL DEFAULT 0,
  tax_bp       INTEGER NOT NULL DEFAULT 0,
  tax          INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  cost         INTEGER NOT NULL DEFAULT 0,
  min_age      INTEGER NOT NULL DEFAULT 0,
  age_checked  INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sale_items_sale ON sale_items (sale_id, sort);
CREATE INDEX sale_items_product ON sale_items (product_id);

CREATE TABLE payments (
  id         TEXT PRIMARY KEY,
  sale_id    TEXT NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  method     TEXT NOT NULL CHECK (method IN ('cash', 'card', 'wallet', 'store_credit')),
  -- What the sale is credited. `tendered` is what the customer handed over, and
  -- only cash may exceed the amount due — a card charged more than the balance
  -- is an overcharge, so the till refuses it rather than making change from one.
  amount     INTEGER NOT NULL,
  tendered   INTEGER NOT NULL DEFAULT 0,
  change     INTEGER NOT NULL DEFAULT 0,
  reference  TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX payments_sale ON payments (sale_id);

CREATE TABLE refunds (
  id          TEXT PRIMARY KEY,
  client_id   TEXT UNIQUE,
  sale_id     TEXT NOT NULL REFERENCES sales (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  approved_by TEXT REFERENCES users (id),
  shift_id    TEXT REFERENCES shifts (id),
  reason      TEXT NOT NULL DEFAULT '',
  method      TEXT NOT NULL DEFAULT 'cash',
  total       INTEGER NOT NULL DEFAULT 0,
  restock     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX refunds_sale ON refunds (sale_id);

CREATE TABLE refund_items (
  id           TEXT PRIMARY KEY,
  refund_id    TEXT NOT NULL REFERENCES refunds (id) ON DELETE CASCADE,
  sale_item_id TEXT NOT NULL REFERENCES sale_items (id),
  qty          REAL NOT NULL,
  amount       INTEGER NOT NULL
);
CREATE INDEX refund_items_refund ON refund_items (refund_id);
CREATE INDEX refund_items_line ON refund_items (sale_item_id);

-- ---------------------------------------------------------------------------
-- Stock
-- ---------------------------------------------------------------------------
--
-- `products.stock` is a running figure kept for the till, which needs an answer
-- in one read. This table is why it can be trusted: every change to it is a row
-- here saying who moved it, by how much, and what caused it, so a level that
-- looks wrong can be walked back to the movement that made it wrong.

CREATE TABLE stock_movements (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  qty_delta  REAL NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN (
                'sale', 'refund', 'receive', 'adjust', 'waste', 'count', 'open'
              )),
  ref_type   TEXT NOT NULL DEFAULT '',
  ref_id     TEXT NOT NULL DEFAULT '',
  unit_cost  INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  user_id    TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL
);
CREATE INDEX stock_movements_product ON stock_movements (product_id, created_at);
CREATE INDEX stock_movements_ref ON stock_movements (ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- Buying
-- ---------------------------------------------------------------------------

CREATE TABLE purchase_orders (
  id          TEXT PRIMARY KEY,
  number      INTEGER,
  supplier_id TEXT NOT NULL REFERENCES suppliers (id),
  status      TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'part_received', 'received', 'cancelled')),
  expected_at INTEGER,
  total       INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  received_at INTEGER
);
CREATE INDEX purchase_orders_supplier ON purchase_orders (supplier_id, status);

CREATE TABLE purchase_order_items (
  id         TEXT PRIMARY KEY,
  po_id      TEXT NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products (id),
  qty        REAL NOT NULL,
  qty_received REAL NOT NULL DEFAULT 0,
  unit_cost  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX purchase_order_items_po ON purchase_order_items (po_id);

CREATE TABLE supplier_invoices (
  id          TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers (id),
  po_id       TEXT REFERENCES purchase_orders (id),
  reference   TEXT NOT NULL DEFAULT '',
  issued_at   INTEGER NOT NULL,
  due_at      INTEGER,
  total       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX supplier_invoices_supplier ON supplier_invoices (supplier_id);

CREATE TABLE supplier_payments (
  id         TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES supplier_invoices (id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  method     TEXT NOT NULL DEFAULT 'cash',
  paid_at    INTEGER NOT NULL,
  user_id    TEXT REFERENCES users (id)
);
CREATE INDEX supplier_payments_invoice ON supplier_payments (invoice_id);

CREATE TABLE expenses (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL,
  payee      TEXT NOT NULL DEFAULT '',
  amount     INTEGER NOT NULL,
  method     TEXT NOT NULL DEFAULT 'cash',
  note       TEXT NOT NULL DEFAULT '',
  spent_at   INTEGER NOT NULL,
  user_id    TEXT REFERENCES users (id),
  created_at INTEGER NOT NULL
);
CREATE INDEX expenses_date ON expenses (spent_at);

-- ---------------------------------------------------------------------------
-- The books
-- ---------------------------------------------------------------------------
--
-- Four properties make this ledger worth trusting, and three of them are
-- enforced here rather than in application code:
--
--   * No balance is stored. Every figure in every report is summed from
--     `journal_lines`. There is no cached total that can quietly diverge.
--   * Postings are immutable by construction — the triggers below refuse
--     UPDATE and DELETE whatever the application tries.
--   * An entry must balance and must touch at least two accounts, checked when
--     it is posted. Minting money is a rejected write.
--   * Value time and booking time are separate, so a backfilled correction
--     lands in the period it economically belongs to.

CREATE TABLE accounts (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
  -- Which way a positive balance runs, so a report never has to guess.
  normal    TEXT NOT NULL CHECK (normal IN ('debit', 'credit')),
  sort      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE fiscal_periods (
  id        TEXT PRIMARY KEY,
  starts_at INTEGER NOT NULL,
  ends_at   INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE journal_entries (
  id          TEXT PRIMARY KEY,
  -- When it economically happened.
  value_at    INTEGER NOT NULL,
  -- When it was written down.
  booked_at   INTEGER NOT NULL,
  memo        TEXT NOT NULL DEFAULT '',
  ref_type    TEXT NOT NULL DEFAULT '',
  ref_id      TEXT NOT NULL DEFAULT '',
  corrects_id TEXT REFERENCES journal_entries (id),
  user_id     TEXT REFERENCES users (id)
);
CREATE INDEX journal_entries_value ON journal_entries (value_at);
CREATE INDEX journal_entries_ref ON journal_entries (ref_type, ref_id);

CREATE TABLE journal_lines (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL REFERENCES journal_entries (id),
  account_code TEXT NOT NULL REFERENCES accounts (code),
  -- One signed column rather than two: debit is positive, credit is negative,
  -- and "the entry balances" is SUM(amount) = 0 — one condition instead of a
  -- comparison between two sums that can each be right and still disagree.
  amount       INTEGER NOT NULL,
  memo         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX journal_lines_account ON journal_lines (account_code);

CREATE TRIGGER journal_entries_immutable_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal entries are immutable — post a correction');
END;

CREATE TRIGGER journal_entries_immutable_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal entries are immutable — post a correction');
END;

CREATE TRIGGER journal_lines_immutable_update
BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal lines are immutable — post a correction');
END;

CREATE TRIGGER journal_lines_immutable_delete
BEFORE DELETE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'journal lines are immutable — post a correction');
END;

-- Nothing may be posted into a month that has been closed and reported to the
-- outside world — including a backdated correction, which is exactly the write
-- this is here to stop. Corrections go into the open period, linked to what
-- they fix.
CREATE TRIGGER journal_entries_period_open
BEFORE INSERT ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'that accounting period is closed')
  WHERE EXISTS (
    SELECT 1 FROM fiscal_periods
    WHERE closed_at IS NOT NULL
      AND NEW.value_at >= starts_at
      AND NEW.value_at <= ends_at
  );
END;

-- ---------------------------------------------------------------------------
-- Bookkeeping of the other kind
-- ---------------------------------------------------------------------------

-- Sale numbers, per year, allocated with an UPDATE ... RETURNING so two tills
-- asking at once get two numbers.
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Failed sign-ins, per lane.
--
-- A 4-digit PIN has ten thousand possibilities, so the iteration count of the
-- hash is not what protects it — this table is. A lane that has failed five
-- times in a row stops accepting PINs until the window passes, which turns an
-- exhaustive search from twenty minutes into something nobody standing at a
-- counter can finish.
CREATE TABLE sign_in_attempts (
  scope       TEXT PRIMARY KEY,
  failures    INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  last_at     INTEGER NOT NULL DEFAULT 0
);

-- Who authorised what at a lane. The back office reads this as "Authorisations
-- at the till", and it is the record that makes a PIN-gated command auditable
-- rather than merely gated.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  user_id     TEXT REFERENCES users (id),
  approved_by TEXT REFERENCES users (id),
  register_id TEXT REFERENCES registers (id),
  action      TEXT NOT NULL,
  ref_type    TEXT NOT NULL DEFAULT '',
  ref_id      TEXT NOT NULL DEFAULT '',
  amount      INTEGER,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_register ON audit_log (register_id, at);
