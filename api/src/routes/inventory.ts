import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, batch, need, one, readSettings, run, settingBool, stmt } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, num, oneOf, optStr } from "../lib/http.js";
import { extend } from "../lib/money.js";
import { post, stockAdjustEntry } from "../lib/ledger.js";

export const inventory = new Hono<Ctx>();

/**
 * What is on the shelves, and what it is worth.
 *
 * Valuation is at cost, summed by the database rather than by pulling every
 * product across and adding them up here — which is the difference between one
 * row read and several hundred on a free tier that counts them.
 */
inventory.get("/", async (c) => {
  const totals = await one<{
    skus: number;
    units: number;
    at_cost: number;
    at_retail: number;
    low: number;
    out: number;
  }>(
    c.env.DB,
    `SELECT COUNT(*) AS skus,
            COALESCE(SUM(stock), 0) AS units,
            COALESCE(SUM(CAST(ROUND(stock * cost) AS INTEGER)), 0) AS at_cost,
            COALESCE(SUM(CAST(ROUND(stock * price) AS INTEGER)), 0) AS at_retail,
            COALESCE(SUM(CASE WHEN reorder_point > 0 AND stock <= reorder_point THEN 1 ELSE 0 END), 0) AS low,
            COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END), 0) AS out
       FROM products WHERE active = 1`,
  );

  const byCategory = await all(
    c.env.DB,
    `SELECT COALESCE(c.name, 'Uncategorised') AS category,
            COUNT(*) AS skus,
            COALESCE(SUM(CAST(ROUND(p.stock * p.cost) AS INTEGER)), 0) AS at_cost
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = 1
      GROUP BY category ORDER BY at_cost DESC`,
  );

  const attention = await all(
    c.env.DB,
    `SELECT p.id, p.sku, p.name, p.stock, p.reorder_point, p.reorder_qty, p.cost, p.price,
            p.unit, s.name AS supplier_name
       FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.active = 1 AND ((p.reorder_point > 0 AND p.stock <= p.reorder_point) OR p.stock <= 0)
      ORDER BY (p.stock - p.reorder_point), p.name LIMIT 100`,
  );

  return c.json({ totals, by_category: byCategory, attention });
});

inventory.get("/movements", async (c) => {
  const from = Number(c.req.query("from") ?? String(now() - 7 * 86400));
  const productId = c.req.query("product_id") ?? "";
  const binds: unknown[] = [from];
  let extra = "";
  if (productId.length > 0) {
    binds.push(productId);
    extra = ` AND m.product_id = ?${binds.length}`;
  }
  const rows = await all(
    c.env.DB,
    `SELECT m.*, p.name AS product_name, p.sku, u.name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.created_at >= ?1 ${extra}
      ORDER BY m.created_at DESC LIMIT 300`,
    ...binds,
  );
  return c.json({ movements: rows });
});

/**
 * Adjusting stock, by saying what it should be.
 *
 * The operator enters the **counted** figure and the delta is derived, because
 * a person holding a shelf full of tins knows how many are there and does not
 * know how many the computer thinks are there. Deriving it also means two
 * people counting the same shelf cannot both apply "+3".
 */
inventory.post("/adjust", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const productId = optStr(body, "product_id");
  const counted = num(body, "counted");
  const reason = oneOf(body, "reason", ["count", "waste", "adjust"] as const);
  const note = optStr(body, "note");
  if (counted < 0) throw badRequest("bad_count", "a count cannot be negative");

  const product = await need<{ id: string; stock: number; cost: number; name: string }>(
    c.env.DB,
    "that product",
    "SELECT id, stock, cost, name FROM products WHERE id = ?1",
    productId,
  );
  const delta = counted - product.stock;
  if (delta === 0) return c.json({ ok: true, unchanged: true });

  const id = newId("sm");
  const at = now();

  // **Claim the level first, on its own, and check the claim.**
  //
  // Conditional on the level not having moved since it was read, so a sale
  // ringing at the same moment is not silently overwritten by the count. Its
  // result has to be read *before* anything that depends on it is written: this
  // used to sit at the head of one batch with the movement row and the journal
  // entry, and a statement matching no rows is a success in SQLite, so it could
  // not abort the batch. A count against a stale level therefore wrote a
  // −10 movement and a K5,000 stock-loss posting — both of them immutable, with
  // no reversal path — and *then* told the operator nothing had happened.
  const claimed = await run(
    c.env.DB,
    "UPDATE products SET stock = ?2, updated_at = ?3 WHERE id = ?1 AND stock = ?4",
    product.id,
    counted,
    at,
    product.stock,
  );
  if (claimed.meta.changes === 0) {
    throw badRequest("moved", "that level changed while you were counting — read it again");
  }

  const statements = [
    stmt(
      c.env.DB,
      `INSERT INTO stock_movements (id, product_id, qty_delta, reason, unit_cost, note, user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      id,
      product.id,
      delta,
      reason,
      product.cost,
      note,
      actor.userId,
      at,
    ),
  ];

  const settings = await readSettings(c.env.DB);
  const value = extend(delta, product.cost);
  if (value !== 0 && settingBool(settings, "accounting.enabled", false)) {
    statements.push(
      ...post(
        c.env.DB,
        stockAdjustEntry({
          movementId: id,
          at,
          value,
          reason: note || reason,
          userId: actor.userId,
        }),
      ),
    );
  }

  await batch(c.env.DB, statements);
  return c.json({ ok: true, delta, stock: counted });
});
