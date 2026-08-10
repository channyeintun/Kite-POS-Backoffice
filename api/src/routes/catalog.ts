import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, batch, need, one, run, stmt } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, bool, conflict, int, notFound, num, optInt, optStr, str } from "../lib/http.js";

export const catalog = new Hono<Ctx>();

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

catalog.get("/products", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const category = c.req.query("category") ?? "";
  const only = c.req.query("only") ?? "";
  const where: string[] = [];
  const binds: unknown[] = [];

  if (q.length > 0) {
    binds.push(`%${q}%`);
    where.push(
      `(p.name LIKE ?${binds.length} OR p.name_my LIKE ?${binds.length} OR p.sku LIKE ?${binds.length}
        OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode LIKE ?${binds.length}))`,
    );
  }
  if (category.length > 0) {
    binds.push(category);
    where.push(`p.category_id = ?${binds.length}`);
  }
  if (only === "low") where.push("p.stock <= p.reorder_point AND p.reorder_point > 0");
  if (only === "inactive") where.push("p.active = 0");
  else if (only !== "all") where.push("p.active = 1");

  const rows = await all(
    c.env.DB,
    `SELECT p.*, c.name AS category_name, s.name AS supplier_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.name
      LIMIT 500`,
    ...binds,
  );
  return c.json({ products: rows });
});

catalog.get("/products/:id", async (c) => {
  const id = c.req.param("id");
  const product = await need(
    c.env.DB,
    "that product",
    `SELECT p.*, c.name AS category_name, s.name AS supplier_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = ?1`,
    id,
  );
  const barcodes = await all(
    c.env.DB,
    "SELECT barcode, pack_size, label FROM product_barcodes WHERE product_id = ?1",
    id,
  );
  const movements = await all(
    c.env.DB,
    `SELECT id, qty_delta, reason, ref_type, ref_id, unit_cost, note, created_at
       FROM stock_movements WHERE product_id = ?1 ORDER BY created_at DESC LIMIT 50`,
    id,
  );
  // Thirty days of takings for this one line, so a price change can be judged
  // against what it did rather than against a hunch.
  const sold = await all(
    c.env.DB,
    `SELECT DATE(s.completed_at, 'unixepoch') AS day,
            SUM(i.qty) AS qty, SUM(i.total) AS revenue
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE i.product_id = ?1 AND s.status = 'completed' AND s.completed_at >= ?2
      GROUP BY day ORDER BY day`,
    id,
    now() - 30 * 86400,
  );
  return c.json({ product, barcodes, movements, sold });
});

function productFields(body: unknown) {
  return {
    name: str(body, "name"),
    name_my: optStr(body, "name_my"),
    category_id: optStr(body, "category_id") || null,
    supplier_id: optStr(body, "supplier_id") || null,
    cost: optInt(body, "cost", 0),
    price: optInt(body, "price", 0),
    tax_bp: optInt(body, "tax_bp", 0),
    min_age: optInt(body, "min_age", 0),
    unit: optStr(body, "unit", "each"),
    ask_price: bool(body, "ask_price", false) ? 1 : 0,
    reorder_point: num(body, "reorder_point", 0),
    reorder_qty: num(body, "reorder_qty", 0),
    quick_key: optInt(body, "quick_key", 0),
    // Set by the photo upload, and carried on a create so a picture taken
    // before the product existed still lands on it.
    photo_key: optStr(body, "photo_key") || null,
    active: bool(body, "active", true) ? 1 : 0,
  };
}

catalog.post("/products", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sku = str(body, "sku").trim();
  const f = productFields(body);
  const id = newId("prd");
  const at = now();

  const clash = await one(c.env.DB, "SELECT id FROM products WHERE sku = ?1", sku);
  if (clash) throw conflict("sku_taken", `SKU ${sku} is already in the catalogue`);

  await run(
    c.env.DB,
    `INSERT INTO products (id, sku, name, name_my, category_id, supplier_id, cost, price,
                           tax_bp, min_age, unit, ask_price, stock, reorder_point, reorder_qty,
                           quick_key, active, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13,?14,?15,?16,?17,?17)`,
    id,
    sku,
    f.name,
    f.name_my,
    f.category_id,
    f.supplier_id,
    f.cost,
    f.price,
    f.tax_bp,
    f.min_age,
    f.unit,
    f.ask_price,
    f.reorder_point,
    f.reorder_qty,
    f.quick_key,
    f.active,
    at,
    f.photo_key,
  );
  return c.json({ id }, 201);
});

catalog.patch("/products/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const f = productFields(body);
  const result = await run(
    c.env.DB,
    `UPDATE products SET name=?2, name_my=?3, category_id=?4, supplier_id=?5, cost=?6, price=?7,
                         tax_bp=?8, min_age=?9, unit=?10, ask_price=?11, reorder_point=?12,
                         reorder_qty=?13, quick_key=?14, active=?15, updated_at=?16
      WHERE id = ?1`,
    c.req.param("id"),
    f.name,
    f.name_my,
    f.category_id,
    f.supplier_id,
    f.cost,
    f.price,
    f.tax_bp,
    f.min_age,
    f.unit,
    f.ask_price,
    f.reorder_point,
    f.reorder_qty,
    f.quick_key,
    f.active,
    now(),
  );
  if (result.meta.changes === 0) throw badRequest("no_such_product", "that product is not here");
  return c.json({ ok: true });
});

/**
 * Retiring a product rather than deleting it.
 *
 * A product that has ever been sold is referenced by a `sale_items` row, and
 * deleting it would break a receipt somebody may reprint years later. So this
 * deactivates: it leaves the shelf and the till, and the history it is part of
 * stays readable.
 */
catalog.delete("/products/:id", async (c) => {
  await run(
    c.env.DB,
    "UPDATE products SET active = 0, quick_key = 0, updated_at = ?2 WHERE id = ?1",
    c.req.param("id"),
    now(),
  );
  return c.json({ ok: true, retired: true });
});

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

catalog.post("/products/:id/barcodes", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const barcode = str(body, "barcode").trim();
  const packSize = num(body, "pack_size", 1);
  if (packSize <= 0) throw badRequest("bad_pack", "a pack has to hold something");

  const taken = await one<{ product_id: string }>(
    c.env.DB,
    "SELECT product_id FROM product_barcodes WHERE barcode = ?1",
    barcode,
  );
  if (taken) {
    throw conflict("barcode_taken", "that barcode already belongs to another product", {
      product_id: taken.product_id,
    });
  }
  await run(
    c.env.DB,
    "INSERT INTO product_barcodes (barcode, product_id, pack_size, label) VALUES (?1, ?2, ?3, ?4)",
    barcode,
    c.req.param("id"),
    packSize,
    optStr(body, "label"),
  );
  return c.json({ ok: true }, 201);
});

catalog.delete("/barcodes/:barcode", async (c) => {
  await run(c.env.DB, "DELETE FROM product_barcodes WHERE barcode = ?1", c.req.param("barcode"));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Categories and suppliers
// ---------------------------------------------------------------------------

catalog.get("/categories", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS products
       FROM categories c ORDER BY c.sort, c.name`,
  );
  return c.json({ categories: rows });
});

catalog.post("/categories", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = newId("cat");
  await run(
    c.env.DB,
    "INSERT INTO categories (id, name, name_my, sort) VALUES (?1, ?2, ?3, ?4)",
    id,
    str(body, "name"),
    optStr(body, "name_my"),
    optInt(body, "sort", 0),
  );
  return c.json({ id }, 201);
});

catalog.patch("/categories/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await run(
    c.env.DB,
    "UPDATE categories SET name = ?2, name_my = ?3, sort = ?4 WHERE id = ?1",
    c.req.param("id"),
    str(body, "name"),
    optStr(body, "name_my"),
    optInt(body, "sort", 0),
  );
  return c.json({ ok: true });
});

/**
 * Removing a category.
 *
 * A real delete, unlike a product's — and the difference is what the row is.
 * A product is referenced by `sale_items` and deleting one breaks a receipt
 * somebody may reprint years later, so it retires instead. A category is an
 * organising label with no history hanging off it: the only thing pointing at
 * it is `products.category_id`, and a receipt records the product, never the
 * category it happened to be filed under.
 *
 * **Refused while anything is still in it**, rather than orphaning those
 * products or silently reassigning them. The count comes back with the refusal
 * so the shopkeeper knows how much moving there is to do.
 */
catalog.delete("/categories/:id", async (c) => {
  const id = c.req.param("id");
  const held = await one<{ n: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS n FROM products WHERE category_id = ?1",
    id,
  );
  const count = held?.n ?? 0;
  if (count > 0) {
    throw conflict("not_empty", "move what is in that category before removing it", {
      products: count,
    });
  }
  const gone = await run(c.env.DB, "DELETE FROM categories WHERE id = ?1", id);
  if (gone.meta.changes === 0) throw notFound("that category is not here");
  return c.json({ ok: true });
});

catalog.get("/suppliers", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT s.*,
            (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS products,
            (SELECT COALESCE(SUM(i.total), 0) - COALESCE(
               (SELECT SUM(sp.amount) FROM supplier_payments sp
                 JOIN supplier_invoices si ON si.id = sp.invoice_id
                WHERE si.supplier_id = s.id), 0)
               FROM supplier_invoices i WHERE i.supplier_id = s.id) AS owed
       FROM suppliers s ORDER BY s.name`,
  );
  return c.json({ suppliers: rows });
});

catalog.post("/suppliers", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = newId("sup");
  await run(
    c.env.DB,
    `INSERT INTO suppliers (id, name, phone, email, address, lead_days, active)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)`,
    id,
    str(body, "name"),
    optStr(body, "phone"),
    optStr(body, "email"),
    optStr(body, "address"),
    optInt(body, "lead_days", 3),
  );
  return c.json({ id }, 201);
});

catalog.patch("/suppliers/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await run(
    c.env.DB,
    `UPDATE suppliers SET name=?2, phone=?3, email=?4, address=?5, lead_days=?6, active=?7
      WHERE id = ?1`,
    c.req.param("id"),
    str(body, "name"),
    optStr(body, "phone"),
    optStr(body, "email"),
    optStr(body, "address"),
    optInt(body, "lead_days", 3),
    bool(body, "active", true) ? 1 : 0,
  );
  return c.json({ ok: true });
});

/**
 * The Favourites grid, set in one write.
 *
 * Positions are rewritten wholesale rather than patched one product at a time,
 * because a grid is an arrangement and two products cannot share a slot. Doing
 * it as a batch means the grid is never briefly missing a tile.
 */
catalog.post("/quick-keys", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids = (body as { product_ids?: unknown }).product_ids;
  if (!Array.isArray(ids)) throw badRequest("bad_field", "product_ids must be a list");

  const statements = [stmt(c.env.DB, "UPDATE products SET quick_key = 0 WHERE quick_key > 0")];
  ids.forEach((id, i) => {
    if (typeof id === "string" && id.length > 0) {
      statements.push(stmt(c.env.DB, "UPDATE products SET quick_key = ?2 WHERE id = ?1", id, i + 1));
    }
  });
  await batch(c.env.DB, statements);
  return c.json({ ok: true, pinned: statements.length - 1 });
});
