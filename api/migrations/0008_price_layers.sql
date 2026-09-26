-- A delivery that comes in at a new shelf price.
--
-- Most deliveries do not touch the price: the shop buys more of the same thing
-- and sells it for what it always did. Sometimes the new stock is dearer — the
-- old tins sold for 1000 and these are going out at 1500 — and the tins already
-- on the shelf were bought and priced at the old figure. Those sell out first,
-- at 1000, and only then does the till start charging 1500.
--
-- That only happens when Goods In is told a new price. A product that is never
-- given one never has a row here, and its price is `products.price` exactly as
-- before.
--
-- **The switch point is a count of units sold, not a stock level.** Stock goes
-- up with every later delivery and sideways with every count, so "the old
-- price until stock falls to 20" would move under anybody's feet. `sold_qty`
-- only ever rises, at checkout, so "the old price until 1,240 have been sold"
-- stays true whatever else happens to the shelf.
ALTER TABLE products ADD COLUMN sold_qty REAL NOT NULL DEFAULT 0;

-- The prices a product has queued, oldest first. A layer is in force until
-- `products.sold_qty` reaches `until_sold`; the last one has no end, and is
-- the price the product keeps once the older stock has gone. While there are
-- rows here `products.price` is kept equal to the layer in force, so every
-- screen that shows a price goes on reading the one column.
CREATE TABLE price_layers (
  product_id  TEXT NOT NULL REFERENCES products(id),
  seq         INTEGER NOT NULL,
  price       INTEGER NOT NULL,
  until_sold  REAL,
  PRIMARY KEY (product_id, seq)
);

-- What a delivery said the new price was, so the purchase record shows why the
-- price moved.
ALTER TABLE purchase_order_items ADD COLUMN new_price INTEGER;
