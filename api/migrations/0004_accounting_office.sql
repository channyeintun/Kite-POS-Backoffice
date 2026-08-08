-- The books, as a shopkeeper's accountant expects to find them.
--
-- Three things, and each one exists because a figure that mattered had nowhere
-- to live.
--
-- **Running costs get a chart, not a single line.** Every expense posted to
-- `6000 Operating expenses` with the category kept as free text on the journal
-- line, so a profit and loss could only ever say "Operating expenses" and one
-- number, however carefully the shopkeeper typed "Rent" or "Wages". These are
-- the accounts a corner shop actually spends against; `6000` stays as the
-- fallback for anything that does not fit one.
--
-- The 5000-series is deliberately not extended here. `5000` cost of goods,
-- `5100` waste and `5200` cash over and short are posted from sales, stock
-- movements and drawer counts. Offering them as somewhere to book an expense
-- would double-count the same money, so the expense screen refuses them.
INSERT INTO accounts (code, name, kind, normal, sort) VALUES
  ('6100', 'Rent',                   'expense', 'debit', 160),
  ('6200', 'Utilities',              'expense', 'debit', 170),
  ('6300', 'Wages',                  'expense', 'debit', 180),
  ('6400', 'Store supplies',         'expense', 'debit', 190),
  ('6500', 'Bank & card charges',    'expense', 'debit', 200),
  ('6600', 'Repairs & upkeep',       'expense', 'debit', 210),
  ('6900', 'Other operating costs',  'expense', 'debit', 220);

-- **An expense knows which account it belongs to.**
ALTER TABLE expenses ADD COLUMN account_code TEXT NOT NULL DEFAULT '6000'
  REFERENCES accounts (code);

-- **Tax paid on a purchase offsets tax collected on a sale.**
--
-- Without this column `2100 Tax payable` only ever grows: the shop books the
-- tax it charges its customers and never the tax it is itself charged, so the
-- liability on the balance sheet is the gross figure rather than what is
-- actually owed. A shop with `tax.inclusive` set is registered for tax, and a
-- registered shop reclaims its input tax.
ALTER TABLE expenses ADD COLUMN tax INTEGER NOT NULL DEFAULT 0;

-- **Who it was paid to, and what the paperwork says.** A cash expense with no
-- supplier and no reference is a number nobody can audit a year later.
ALTER TABLE expenses ADD COLUMN supplier_id TEXT REFERENCES suppliers (id);
ALTER TABLE expenses ADD COLUMN reference TEXT NOT NULL DEFAULT '';

CREATE INDEX expenses_account ON expenses (account_code);

-- A closed month should say who closed it and why it was closed then. Closing
-- the books is the one irreversible-feeling act in the back office, and "the
-- period is closed" with nobody's name against it is not an audit trail.
ALTER TABLE fiscal_periods ADD COLUMN closed_by TEXT REFERENCES users (id);
ALTER TABLE fiscal_periods ADD COLUMN note TEXT NOT NULL DEFAULT '';
