-- Buying, made safe to tap twice.
--
-- A shopkeeper on a slow line taps Submit again because nothing on the screen
-- said the first one was heard. Every other money path in this application
-- already survives that: a sale carries `client_id`, so does a refund, so does
-- a settlement, and the retry finds the first write instead of making a second
-- one. Purchasing was the one row of the table with nothing in that column,
-- which is how one press of "Raise orders from the worksheet" became four
-- draft orders per supplier with no way to remove them.
--
-- SQLite cannot add a UNIQUE column by ALTER, so each key is a nullable column
-- plus a unique index — which enforces the same thing and, because SQLite
-- treats NULLs as distinct in a unique index, leaves every row written before
-- today valid.
ALTER TABLE purchase_orders ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX purchase_orders_client ON purchase_orders (client_id);

ALTER TABLE supplier_invoices ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX supplier_invoices_client ON supplier_invoices (client_id);

ALTER TABLE supplier_payments ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX supplier_payments_client ON supplier_payments (client_id);

-- An order that was actually sent, withdrawn.
--
-- `cancelled` has been in the CHECK on `purchase_orders.status` since the first
-- migration and nothing has ever written it: `/receive` reads it, refuses it,
-- and no door sets it. These are the two columns it needs to mean anything,
-- named and worded exactly as `supplier_invoices` names its own — the same
-- event, recorded the same way.
--
-- A *draft* is deleted rather than cancelled, and that is not an inconsistency.
-- The rule this schema keeps is that what happened happened; a draft is not
-- something that happened. No stock moved, no money moved, no journal entry
-- exists, and the supplier was never told. Keeping a row for it buys nothing
-- and costs the shopkeeper a purchase-order list they cannot read.
ALTER TABLE purchase_orders ADD COLUMN cancelled_at INTEGER;
ALTER TABLE purchase_orders ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';

-- What a delivery booked straight into stock is.
--
-- Goods In writes a purchase order that was born received, because a walk-in
-- purchase and an ordered one are the same event with a different amount of
-- warning. Reusing the table means one definition of "what stock arrived",
-- one place the movements come from and one payables list. This flag is only
-- so the purchase-order list can say which is which; nothing branches on it.
ALTER TABLE purchase_orders ADD COLUMN direct INTEGER NOT NULL DEFAULT 0;

-- Buying without ordering.
--
-- "Purchasing" in this application meant raising an order with a wholesaler and
-- waiting for a van — and a corner shop does not mostly buy that way. The owner
-- walks to the market, buys four cases of cola with notes out of their pocket,
-- and carries them back. There is nobody to raise an order with, no invoice to
-- record, and no account to put it on.
--
-- A supplier is still needed, because a payable, an aging report and a
-- supplier's ledger are all built on one and a nullable supplier would mean a
-- second shape for every one of them. So the shop is given one, out of the box,
-- that says exactly what it is. Goods In selects it first, so a market run is:
-- add the lines, say cash, book it. Nothing is owed to it and nothing is aged
-- against it, because a cash purchase is paid in the same press that books it.
--
-- `sup_cash` is a fixed id rather than a generated one so the front end can put
-- it at the top of the list without matching on a name the shopkeeper is free
-- to change — and they should: a shop that buys from one market every week
-- should rename this to that market.
INSERT INTO suppliers (id, name, phone, email, address, lead_days, active)
VALUES ('sup_cash', 'Bought by the shop (cash)', '', '', '', 0, 1);
