import { one, stmt } from "./db.js";

/**
 * A new shelf price that waits for the old stock to sell.
 *
 * Goods In can say "these are going out at 1500" of a product that has been
 * selling for 1000. The units already on the shelf keep their 1000 and the till
 * switches to 1500 once that many more have been sold. The queue lives in
 * `price_layers` and exists only while a switch is waiting — see migration
 * 0008 for why the switch point counts units sold rather than watching stock.
 *
 * `products.price` stays the price in force throughout, so the catalogue, the
 * reports and every screen that shows a price read what they always read.
 */

/**
 * Statements that queue `price` behind the stock already on the shelf.
 *
 * Put them **before** the delivery's own stock increase, in the same batch:
 * "what is on the shelf" has to mean what was there before these units came.
 * Written as SQL rather than worked out from a read beforehand so that a sale
 * checking out while the delivery is being booked cannot slip between them.
 */
export function repriceOnDelivery(db: D1Database, productId: string, price: number): D1PreparedStatement[] {
  return [
    // No queue yet: the price in force becomes the first layer, and it lasts
    // for exactly the stock on hand.
    stmt(
      db,
      `INSERT INTO price_layers (product_id, seq, price, until_sold)
       SELECT id, 1, price, sold_qty + stock FROM products
        WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM price_layers WHERE product_id = ?1)`,
      productId,
    ),
    // A queue already: its open-ended last price now ends where today's shelf does.
    stmt(
      db,
      `UPDATE price_layers
          SET until_sold = (SELECT sold_qty + stock FROM products WHERE id = ?1)
        WHERE product_id = ?1 AND until_sold IS NULL`,
      productId,
    ),
    stmt(
      db,
      `INSERT INTO price_layers (product_id, seq, price, until_sold)
       SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, NULL FROM price_layers WHERE product_id = ?1`,
      productId,
      price,
    ),
    ...settle(db, productId),
  ];
}

/**
 * Statements that change the price for everything, the shelf included.
 *
 * The other answer to a delivery at a new price: the shop has decided the old
 * stock goes up too. Whatever an earlier delivery left waiting is cancelled,
 * for the same reason a price typed in on the product cancels it — this is
 * the newer decision, and it is about every unit.
 */
export function repriceNow(db: D1Database, productId: string, price: number): D1PreparedStatement[] {
  return [
    stmt(db, "DELETE FROM price_layers WHERE product_id = ?1", productId),
    stmt(db, "UPDATE products SET price = ?2 WHERE id = ?1", productId, price),
  ];
}

/**
 * Statements that bring `products.price` up to date with what has been sold,
 * and drop the layers that are used up.
 *
 * Run after `sold_qty` moves. A layer is used up when the count has reached its
 * end, or when it ends no later than the layer before it — which is what a
 * price given to an empty shelf looks like, and why a delivery onto nothing
 * takes its new price straight away. When only the open-ended layer is left
 * there is nothing waiting, and it goes too.
 */
export function settle(db: D1Database, productId: string): D1PreparedStatement[] {
  return [
    stmt(
      db,
      `DELETE FROM price_layers
        WHERE product_id = ?1 AND until_sold IS NOT NULL
          AND until_sold <= MAX(
                (SELECT sold_qty FROM products WHERE id = ?1),
                COALESCE((SELECT MAX(p.until_sold) FROM price_layers p
                           WHERE p.product_id = ?1 AND p.seq < price_layers.seq), 0))`,
      productId,
    ),
    stmt(
      db,
      `UPDATE products
          SET price = (SELECT price FROM price_layers WHERE product_id = ?1 ORDER BY seq LIMIT 1)
        WHERE id = ?1 AND EXISTS (SELECT 1 FROM price_layers WHERE product_id = ?1)`,
      productId,
    ),
    stmt(
      db,
      `DELETE FROM price_layers
        WHERE product_id = ?1 AND until_sold IS NULL
          AND NOT EXISTS (SELECT 1 FROM price_layers WHERE product_id = ?1 AND until_sold IS NOT NULL)`,
      productId,
    ),
  ];
}

/**
 * The price the till charges for the next unit of a product.
 *
 * `inBasket` is how many are already on this sale, so a basket that crosses
 * the switch gets the new price on the unit that crosses it rather than on
 * whichever sale happens to check out next.
 */
export async function priceNow(
  db: D1Database,
  product: { id: string; price: number },
  inBasket: number,
): Promise<number> {
  const row = await one<{ price: number }>(
    db,
    `SELECT l.price FROM price_layers l JOIN products p ON p.id = l.product_id
      WHERE l.product_id = ?1 AND (l.until_sold IS NULL OR l.until_sold > p.sold_qty + ?2)
      ORDER BY l.seq LIMIT 1`,
    product.id,
    inBasket,
  );
  return row?.price ?? product.price;
}

/** What is waiting, for the back office: each price and how many are left at it. */
export type PendingPrice = { price: number; left: number | null };
