import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, one, run } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, oneOf, optStr, str } from "../lib/http.js";
import { expectedInDrawer } from "./shifts.js";

export const tills = new Hono<Ctx>();

/**
 * The lanes, as a manager sees them.
 *
 * This is how the back office reaches a till: the register itself is not in
 * that navigation, because a manager cannot ring a sale from a desk. What they
 * can do from here is see the state of a lane, read its drawer, and close one
 * that a cashier has walked away from.
 *
 * "Last seen" is the honest connection indicator on an online till: a lane that
 * has not spoken to this Worker in two minutes is reported as offline whatever
 * its own screen says, because that is all this end can actually know.
 */
const STALE_AFTER = 120;

tills.get("/", async (c) => {
  const at = now();
  const rows = await all<{
    id: string;
    name: string;
    kind: string;
    last_seen_at: number | null;
    shift_id: string | null;
    opened_at: number | null;
    opening_float: number | null;
    operator: string | null;
    operator_id: string | null;
    sales: number;
    takings: number;
    active_items: number;
    active_total: number | null;
    last_close: number | null;
    last_variance: number | null;
  }>(
    c.env.DB,
    `SELECT r.id, r.name, r.kind, r.last_seen_at,
            sh.id AS shift_id, sh.opened_at, sh.opening_float,
            u.name AS operator, u.id AS operator_id,
            COALESCE((SELECT COUNT(*) FROM sales s WHERE s.shift_id = sh.id AND s.status = 'completed'), 0) AS sales,
            COALESCE((SELECT SUM(s.total) FROM sales s WHERE s.shift_id = sh.id AND s.status = 'completed'), 0) AS takings,
            COALESCE((SELECT COUNT(*) FROM sale_items i
                        JOIN sales s ON s.id = i.sale_id
                       WHERE s.register_id = r.id AND s.status = 'held' AND s.hold_label = ''), 0) AS active_items,
            (SELECT s.total FROM sales s
              WHERE s.register_id = r.id AND s.status = 'held' AND s.hold_label = '') AS active_total,
            (SELECT MAX(closed_at) FROM shifts WHERE register_id = r.id) AS last_close,
            (SELECT variance FROM shifts WHERE register_id = r.id AND closed_at IS NOT NULL
              ORDER BY closed_at DESC LIMIT 1) AS last_variance
       FROM registers r
       LEFT JOIN shifts sh ON sh.register_id = r.id AND sh.closed_at IS NULL
       LEFT JOIN users u ON u.id = sh.user_id
      WHERE r.active = 1
      ORDER BY r.name`,
  );

  const lanes = [];
  for (const row of rows) {
    const online = row.last_seen_at !== null && at - row.last_seen_at < STALE_AFTER;
    const drawer = row.shift_id ? await expectedInDrawer(c.env.DB, row.shift_id) : null;
    lanes.push({
      ...row,
      state: row.shift_id === null ? "closed" : online ? "open" : "offline",
      online,
      held: await one<{ n: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS n FROM sales
          WHERE register_id = ?1 AND status = 'held' AND hold_label <> ''`,
        row.id,
      ).then((r) => r?.n ?? 0),
      drawer_expected: drawer?.expected ?? 0,
    });
  }
  return c.json({ lanes, stale_after: STALE_AFTER });
});

tills.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = optStr(body, "id") || newId("reg");
  await run(
    c.env.DB,
    "INSERT INTO registers (id, name, kind, active, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
    id,
    str(body, "name"),
    oneOf(body, "kind", ["counter", "handheld"] as const),
    now(),
  );
  return c.json({ id }, 201);
});

/**
 * Force a lane closed from the back office.
 *
 * A drawer still has to be counted — this is not a way to skip that. What it
 * does is let a manager close a shift the cashier left open, entering the count
 * themselves, and it signs that lane's sessions out so the next person has to
 * open a fresh drawer.
 */
tills.post("/:id/close", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const registerId = c.req.param("id");
  const counted = (body as { counted_total?: number }).counted_total;
  if (typeof counted !== "number" || !Number.isInteger(counted) || counted < 0) {
    throw badRequest("bad_count", "count the drawer before closing it");
  }

  const shift = await one<{ id: string }>(
    c.env.DB,
    "SELECT id FROM shifts WHERE register_id = ?1 AND closed_at IS NULL",
    registerId,
  );
  if (!shift) throw conflict("not_open", "that lane has no open drawer");

  const drawer = await expectedInDrawer(c.env.DB, shift.id);
  const variance = counted - drawer.expected;
  await run(
    c.env.DB,
    `UPDATE shifts SET closed_at = ?2, closed_by = ?3, counted_total = ?4,
                       expected_total = ?5, variance = ?6, note = ?7
      WHERE id = ?1 AND closed_at IS NULL`,
    shift.id,
    now(),
    actor.userId,
    counted,
    drawer.expected,
    variance,
    optStr(body, "note", "Closed from the back office"),
  );
  await run(c.env.DB, "DELETE FROM sessions WHERE register_id = ?1", registerId);
  return c.json({ ok: true, expected: drawer.expected, counted, variance });
});

tills.delete("/:id", async (c) => {
  const registerId = c.req.param("id");
  const open = await one(
    c.env.DB,
    "SELECT id FROM shifts WHERE register_id = ?1 AND closed_at IS NULL",
    registerId,
  );
  if (open) throw conflict("still_open", "close that lane's drawer before retiring it");
  await run(c.env.DB, "UPDATE registers SET active = 0 WHERE id = ?1", registerId);
  return c.json({ ok: true, retired: true });
});
