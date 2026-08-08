import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, run } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, bool, int, oneOf, optInt, optStr, str } from "../lib/http.js";

export const promotions = new Hono<Ctx>();

promotions.get("/", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT p.*, pr.name AS product_name, cat.name AS category_name
       FROM promotions p
       LEFT JOIN products pr ON pr.id = p.product_id
       LEFT JOIN categories cat ON cat.id = p.category_id
      ORDER BY p.active DESC, p.priority DESC, p.created_at DESC`,
  );
  return c.json({ promotions: rows, now: now() });
});

/**
 * An offer, checked for the shapes that cannot mean anything.
 *
 * Each kind reads `value` differently and two of them need `n` as well, so a
 * form that lets any combination through produces offers the engine has to
 * silently ignore. Refusing here means an offer that exists is an offer that
 * applies.
 */
function validate(body: unknown) {
  const kind = oneOf(body, "kind", ["percent_off", "amount_off", "fixed_price", "n_for_x"] as const);
  const scope = oneOf(body, "scope", ["product", "category", "all"] as const);
  const value = int(body, "value");
  const n = optInt(body, "n", 0);

  if (value < 0) throw badRequest("bad_value", "an offer cannot have a negative value");
  if (kind === "percent_off" && value > 10_000) {
    throw badRequest("bad_value", "a percentage is basis points — 10000 is 100%");
  }
  if (kind === "n_for_x" && n < 2) {
    throw badRequest("bad_n", "an n-for-x offer needs an n of at least 2");
  }

  const productId = optStr(body, "product_id") || null;
  const categoryId = optStr(body, "category_id") || null;
  if (scope === "product" && !productId) throw badRequest("bad_scope", "name the product this is for");
  if (scope === "category" && !categoryId) throw badRequest("bad_scope", "name the category this is for");

  const startsAt = (body as { starts_at?: number }).starts_at ?? null;
  const endsAt = (body as { ends_at?: number }).ends_at ?? null;
  if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
    throw badRequest("bad_window", "that offer ends before it starts");
  }

  return {
    name: str(body, "name"),
    name_my: optStr(body, "name_my"),
    kind,
    value,
    n,
    scope,
    product_id: scope === "product" ? productId : null,
    category_id: scope === "category" ? categoryId : null,
    starts_at: startsAt,
    ends_at: endsAt,
    priority: optInt(body, "priority", 0),
    active: bool(body, "active", true) ? 1 : 0,
  };
}

promotions.post("/", async (c) => {
  const f = validate(await c.req.json().catch(() => ({})));
  const id = newId("promo");
  await run(
    c.env.DB,
    `INSERT INTO promotions (id, name, name_my, kind, value, n, scope, product_id, category_id,
                             starts_at, ends_at, priority, active, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
    id,
    f.name,
    f.name_my,
    f.kind,
    f.value,
    f.n,
    f.scope,
    f.product_id,
    f.category_id,
    f.starts_at,
    f.ends_at,
    f.priority,
    f.active,
    now(),
  );
  return c.json({ id }, 201);
});

promotions.patch("/:id", async (c) => {
  const f = validate(await c.req.json().catch(() => ({})));
  await run(
    c.env.DB,
    `UPDATE promotions SET name=?2, name_my=?3, kind=?4, value=?5, n=?6, scope=?7,
                           product_id=?8, category_id=?9, starts_at=?10, ends_at=?11,
                           priority=?12, active=?13
      WHERE id = ?1`,
    c.req.param("id"),
    f.name,
    f.name_my,
    f.kind,
    f.value,
    f.n,
    f.scope,
    f.product_id,
    f.category_id,
    f.starts_at,
    f.ends_at,
    f.priority,
    f.active,
  );
  return c.json({ ok: true });
});

/**
 * Ending an offer rather than deleting it.
 *
 * A sale line records which promotion priced it, and deleting the row would
 * leave a receipt naming an offer nobody can look up. Deactivating takes it out
 * of the engine's window and leaves the history intact.
 */
promotions.delete("/:id", async (c) => {
  await run(c.env.DB, "UPDATE promotions SET active = 0 WHERE id = ?1", c.req.param("id"));
  return c.json({ ok: true, ended: true });
});

/** What each offer actually saved customers, so a manager can judge it. */
promotions.get("/performance", async (c) => {
  const from = Number(c.req.query("from") ?? String(now() - 30 * 86400));
  const rows = await all(
    c.env.DB,
    `SELECT i.promo_id, i.promo_name,
            COUNT(*) AS lines, SUM(i.qty) AS units,
            SUM(i.promo_saved) AS saved, SUM(i.total) AS revenue
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'completed' AND s.completed_at >= ?1 AND i.promo_id IS NOT NULL
      GROUP BY i.promo_id, i.promo_name
      ORDER BY saved DESC`,
    from,
  );
  return c.json({ performance: rows });
});
