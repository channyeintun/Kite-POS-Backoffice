-- Defaults: the chart of accounts, the shop's settings, and one lane.
--
-- No users are seeded here, and that is deliberate. A migration cannot compute
-- a PBKDF2 hash, so seeding a staff account from SQL would mean shipping a
-- known digest of a known password in a file that lives in version control —
-- and a default credential that works is one nobody changes. `POST /api/setup`
-- creates the first owner instead, and refuses once any user exists.

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
--
-- Small on purpose. A corner shop's books answer four questions — what did we
-- sell, what did it cost us, what do we owe, what is in the drawer — and every
-- account here exists because one of the postings in `lib/ledger.ts` needs it.

INSERT INTO accounts (code, name, kind, normal, sort) VALUES
  ('1000', 'Cash in drawer',      'asset',     'debit',  10),
  ('1010', 'Cash in safe',        'asset',     'debit',  20),
  ('1020', 'Card & wallet clearing', 'asset',  'debit',  30),
  ('1200', 'Stock on hand',       'asset',     'debit',  40),
  ('1300', 'Goods received not invoiced', 'asset', 'debit', 50),
  ('2000', 'Trade payables',      'liability', 'credit', 60),
  ('2100', 'Tax payable',         'liability', 'credit', 70),
  ('2200', 'Store credit owed',   'liability', 'credit', 80),
  ('3000', 'Owner capital',       'equity',    'credit', 90),
  ('3900', 'Retained earnings',   'equity',    'credit', 95),
  ('4000', 'Sales',               'income',    'credit', 100),
  ('4100', 'Promotions & discounts', 'income', 'debit',  110),
  ('5000', 'Cost of goods sold',  'expense',   'debit',  120),
  ('5100', 'Stock loss & waste',  'expense',   'debit',  130),
  ('5200', 'Cash over and short', 'expense',   'debit',  140),
  ('6000', 'Operating expenses',  'expense',   'debit',  150);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
--
-- `currency.minor_units` is the one that matters most: 0 means the integer in
-- every money column *is* the amount, which is how Myanmar kyat works. Set it
-- to 2 for a currency with cents and nothing else in the system changes — the
-- arithmetic is already in whole minor units.

INSERT INTO settings (key, value, updated_at) VALUES
  ('shop.name',            'Corner Mart',        unixepoch()),
  ('shop.name_my',         '',                   unixepoch()),
  ('shop.address',         '',                   unixepoch()),
  ('shop.phone',           '',                   unixepoch()),
  ('shop.tax_id',          '',                   unixepoch()),
  ('shop.receipt_footer',  'Thank you — see you again',  unixepoch()),
  ('currency.code',        'MMK',                unixepoch()),
  ('currency.symbol',      'K',                  unixepoch()),
  ('currency.minor_units', '0',                  unixepoch()),
  -- Where the symbol goes, because 'K31,700' and '31,700 Ks' are both right
  -- depending on who is reading.
  ('currency.symbol_first', '1',                 unixepoch()),
  -- Prices on the shelf include tax, as they do in a Myanmar shop. The till
  -- extracts the tax from the price rather than adding it on top.
  ('tax.inclusive',        '1',                  unixepoch()),
  ('tax.default_bp',       '0',                  unixepoch()),
  ('locale.default',       'en',                 unixepoch()),
  ('loyalty.points_per_unit', '0',               unixepoch()),
  -- Accounting is off until somebody turns it on; a shop that does not want a
  -- ledger should not be made to carry one.
  ('accounting.enabled',   '0',                  unixepoch()),
  ('accounting.started_at', '',                  unixepoch());

INSERT INTO counters (name, value) VALUES ('sale_number', 0), ('po_number', 0);

-- One lane to sell from, so a fresh install can take money.
INSERT INTO registers (id, name, kind, active, created_at)
  VALUES ('reg_1', 'Lane 1', 'counter', 1, unixepoch());
