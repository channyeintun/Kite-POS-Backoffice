import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, need, run } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { optStr, str } from "../lib/http.js";

export const customers = new Hono<Ctx>();

customers.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const binds: unknown[] = [];
  let where = "";
  if (q.length > 0) {
    binds.push(`%${q}%`);
    where = "WHERE c.name LIKE ?1 OR c.phone LIKE ?1";
  }
  const rows = await all(
    c.env.DB,
    `SELECT c.*,
            (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS visits,
            (SELECT COALESCE(SUM(s.total), 0) FROM sales s
              WHERE s.customer_id = c.id AND s.status = 'completed') AS spent,
            (SELECT MAX(s.completed_at) FROM sales s
              WHERE s.customer_id = c.id AND s.status = 'completed') AS last_seen
       FROM customers c ${where}
      ORDER BY c.name LIMIT 200`,
    ...binds,
  );
  return c.json({ customers: rows });
});

customers.get("/:id", async (c) => {
  const id = c.req.param("id");
  const customer = await need(c.env.DB, "that customer", "SELECT * FROM customers WHERE id = ?1", id);
  const history = await all(
    c.env.DB,
    `SELECT s.id, s.number, s.total, s.completed_at,
            (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items
       FROM sales s WHERE s.customer_id = ?1 AND s.status = 'completed'
      ORDER BY s.completed_at DESC LIMIT 50`,
    id,
  );
  const favourites = await all(
    c.env.DB,
    `SELECT i.name, SUM(i.qty) AS qty, SUM(i.total) AS spent
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.customer_id = ?1 AND s.status = 'completed'
      GROUP BY i.product_id, i.name ORDER BY qty DESC LIMIT 10`,
    id,
  );
  return c.json({ customer, history, favourites });
});

customers.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = newId("cus");
  await run(
    c.env.DB,
    `INSERT INTO customers (id, name, phone, points, credit, note, created_at)
     VALUES (?1, ?2, ?3, 0, 0, ?4, ?5)`,
    id,
    str(body, "name"),
    optStr(body, "phone"),
    optStr(body, "note"),
    now(),
  );
  return c.json({ id }, 201);
});

customers.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await run(
    c.env.DB,
    "UPDATE customers SET name = ?2, phone = ?3, note = ?4 WHERE id = ?1",
    c.req.param("id"),
    str(body, "name"),
    optStr(body, "phone"),
    optStr(body, "note"),
  );
  return c.json({ ok: true });
});
