-- An invoice raised by mistake needs somewhere to go.
--
-- Receiving a delivery raises an invoice automatically, so a delivery booked
-- against the wrong order — or entered twice — leaves a payable the shop does
-- not owe, and until now the only way out was to pay it. There is no DELETE
-- here for the same reason there is none in the journal: what happened
-- happened. It is marked cancelled, it stops counting toward what is owed, and
-- the reason is stored beside it.
ALTER TABLE supplier_invoices ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'cancelled'));
ALTER TABLE supplier_invoices ADD COLUMN cancelled_at INTEGER;
ALTER TABLE supplier_invoices ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
