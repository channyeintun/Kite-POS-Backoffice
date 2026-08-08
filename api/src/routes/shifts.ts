import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, batch, need, one, readSettings, run, settingBool, stmt } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, int, oneOf, optStr, str } from "../lib/http.js";
import { cashMovementEntry, floatEntry, post, sweepEntry, varianceEntry } from "../lib/ledger.js";

export const shifts = new Hono<Ctx>();

/**
 * What the drawer should hold.
 *
 * **Derived, never typed.** Opening float, plus cash taken, less change given,
 * plus cash in, less cash out, less cash refunds — each term summed from the
 * rows that caused it. The only figure a person enters is the counted total,
 * and the difference between the two is the variance the books absorb.
 *
 * Written as one query so the terms cannot be computed against different
 * moments: a sale landing between two round trips would otherwise appear in the
 * takings and not in the count, and read as a shortfall that never happened.
 */
export async function expectedInDrawer(db: D1Database, shiftId: string): Promise<{
  opening_float: number;
  cash_taken: number;
  change_given: number;
  cash_in: number;
  cash_out: number;
  cash_refunds: number;
  expected: number;
}> {
  const row = await one<{
    opening_float: number;
    cash_taken: number;
    change_given: number;
    cash_in: number;
    cash_out: number;
    cash_refunds: number;
  }>(
    db,
    `SELECT
       sh.opening_float AS opening_float,
       COALESCE((SELECT SUM(p.amount + p.change) FROM payments p
                   JOIN sales s ON s.id = p.sale_id
                  WHERE s.shift_id = sh.id AND s.status = 'completed' AND p.method = 'cash'), 0) AS cash_taken,
       COALESCE((SELECT SUM(p.change) FROM payments p
                   JOIN sales s ON s.id = p.sale_id
                  WHERE s.shift_id = sh.id AND s.status = 'completed' AND p.method = 'cash'), 0) AS change_given,
       COALESCE((SELECT SUM(m.amount) FROM cash_movements m
                  WHERE m.shift_id = sh.id AND m.kind = 'paid_in'), 0) AS cash_in,
       COALESCE((SELECT SUM(m.amount) FROM cash_movements m
                  WHERE m.shift_id = sh.id AND m.kind IN ('paid_out', 'safe_drop')), 0) AS cash_out,
       COALESCE((SELECT SUM(r.total) FROM refunds r
                  WHERE r.shift_id = sh.id AND r.method = 'cash'), 0) AS cash_refunds
     FROM shifts sh WHERE sh.id = ?1`,
    shiftId,
  );
  if (!row) throw badRequest("no_shift", "that shift is not here");
  const expected =
    row.opening_float +
    (row.cash_taken - row.change_given) +
    row.cash_in -
    row.cash_out -
    row.cash_refunds;
  return { ...row, expected };
}

shifts.get("/", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT sh.*, r.name AS register_name, u.name AS user_name, cu.name AS closed_by_name,
            (SELECT COUNT(*) FROM sales s WHERE s.shift_id = sh.id AND s.status = 'completed') AS sales,
            (SELECT COALESCE(SUM(s.total), 0) FROM sales s WHERE s.shift_id = sh.id AND s.status = 'completed') AS takings
       FROM shifts sh
       JOIN registers r ON r.id = sh.register_id
       JOIN users u ON u.id = sh.user_id
       LEFT JOIN users cu ON cu.id = sh.closed_by
      ORDER BY sh.opened_at DESC LIMIT 100`,
  );
  return c.json({ shifts: rows });
});

shifts.get("/:id", async (c) => {
  const id = c.req.param("id");
  const shift = await need(
    c.env.DB,
    "that shift",
    `SELECT sh.*, r.name AS register_name, u.name AS user_name
       FROM shifts sh JOIN registers r ON r.id = sh.register_id JOIN users u ON u.id = sh.user_id
      WHERE sh.id = ?1`,
    id,
  );
  const drawer = await expectedInDrawer(c.env.DB, id);
  const movements = await all(
    c.env.DB,
    `SELECT m.*, u.name AS user_name FROM cash_movements m
       JOIN users u ON u.id = m.user_id WHERE m.shift_id = ?1 ORDER BY m.created_at`,
    id,
  );
  const tenders = await all(
    c.env.DB,
    `SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS amount
       FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.shift_id = ?1 AND s.status = 'completed'
      GROUP BY p.method`,
    id,
  );
  const sales = await all(
    c.env.DB,
    `SELECT id, number, total, completed_at FROM sales
      WHERE shift_id = ?1 AND status = 'completed' ORDER BY completed_at DESC LIMIT 100`,
    id,
  );
  return c.json({ shift, drawer, movements, tenders, sales });
});

/**
 * Open a drawer.
 *
 * `shifts_one_open` is a partial unique index, so two people opening the same
 * lane at once is a constraint violation rather than two shifts nobody can
 * reconcile. The insert is allowed to lose that race and says so plainly.
 */
shifts.post("/open", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const registerId = str(body, "register_id");
  const float = int(body, "opening_float");
  if (float < 0) throw badRequest("bad_float", "a float cannot be negative");

  const id = newId("sft");
  const at = now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO shifts (id, register_id, user_id, opened_at, opening_float)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(id, registerId, optStr(body, "user_id") || actor.userId, at, float)
      .run();
  } catch (e) {
    const open = await one<{ id: string }>(
      c.env.DB,
      "SELECT id FROM shifts WHERE register_id = ?1 AND closed_at IS NULL",
      registerId,
    );
    if (open) throw conflict("already_open", "that lane already has an open drawer", { shift_id: open.id });
    throw e;
  }

  const settings = await readSettings(c.env.DB);
  if (float !== 0 && settingBool(settings, "accounting.enabled", false)) {
    await batch(c.env.DB, post(c.env.DB, floatEntry({ shiftId: id, at, amount: float, userId: actor.userId })));
  }
  return c.json({ id }, 201);
});

shifts.post("/:id/movement", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const shiftId = c.req.param("id");
  const kind = oneOf(body, "kind", ["paid_in", "paid_out", "safe_drop"] as const);
  const amount = int(body, "amount");
  if (amount <= 0) throw badRequest("bad_amount", "an amount has to be more than nothing");

  const shift = await need<{ id: string; closed_at: number | null }>(
    c.env.DB,
    "that shift",
    "SELECT id, closed_at FROM shifts WHERE id = ?1",
    shiftId,
  );
  if (shift.closed_at !== null) throw conflict("shift_closed", "that drawer is already counted and closed");

  const id = newId("cm");
  const at = now();
  const reason = optStr(body, "reason");
  const statements = [
    stmt(
      c.env.DB,
      `INSERT INTO cash_movements (id, shift_id, kind, amount, reason, user_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      id,
      shiftId,
      kind,
      amount,
      reason,
      actor.userId,
      at,
    ),
  ];
  const settings = await readSettings(c.env.DB);
  if (settingBool(settings, "accounting.enabled", false)) {
    statements.push(
      ...post(
        c.env.DB,
        cashMovementEntry({ movementId: id, at, kind, amount, reason, userId: actor.userId }),
      ),
    );
  }
  await batch(c.env.DB, statements);
  return c.json({ id }, 201);
});

/**
 * Count the drawer and close it.
 *
 * The variance is booked to the accounts as part of the same write, so the
 * ledger's idea of cash agrees with the physical count rather than drifting
 * away from it. Closing is conditional on the shift still being open, so two
 * people counting the same drawer cannot both close it.
 */
shifts.post("/:id/close", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const shiftId = c.req.param("id");
  const counted = int(body, "counted_total");
  if (counted < 0) throw badRequest("bad_count", "a count cannot be negative");

  const drawer = await expectedInDrawer(c.env.DB, shiftId);
  const variance = counted - drawer.expected;
  const at = now();

  // **The close is written on its own, first, and the postings wait for it.**
  //
  // An UPDATE that matches no rows is a successful statement, not an error, so
  // it cannot abort a batch. With the journal entries in the same batch, a
  // replayed close — a retried request, or a second manager on a stale screen —
  // committed a second variance and a second sweep and only *then* raised 409.
  // The books ended up with the drawer permanently negative by a whole shift's
  // takings, the safe overstated by the same, and nothing to flag it: each
  // duplicated entry balances on its own, so the trial balance still summed to
  // zero. `expectedInDrawer` cannot notice either — none of its terms mention
  // `closed_at`, so a replay recomputes exactly the same variance.
  const closed = await run(
    c.env.DB,
    `UPDATE shifts SET closed_at = ?2, closed_by = ?3, counted_total = ?4,
                       expected_total = ?5, variance = ?6, note = ?7
      WHERE id = ?1 AND closed_at IS NULL`,
    shiftId,
    at,
    actor.userId,
    counted,
    drawer.expected,
    variance,
    optStr(body, "note"),
  );
  if (closed.meta.changes === 0) {
    throw conflict("already_closed", "that drawer has already been closed");
  }

  const settings = await readSettings(c.env.DB);
  if (settingBool(settings, "accounting.enabled", false)) {
    // Variance first, which brings the drawer account to what was actually
    // counted; then the sweep, which empties it into the safe. In that order
    // the drawer ends every shift at zero.
    const statements: D1PreparedStatement[] = [];
    if (variance !== 0) {
      statements.push(
        ...post(c.env.DB, varianceEntry({ shiftId, at, variance, userId: actor.userId })),
      );
    }
    if (counted !== 0) {
      statements.push(
        ...post(c.env.DB, sweepEntry({ shiftId, at, amount: counted, userId: actor.userId })),
      );
    }
    await batch(c.env.DB, statements);
  }
  return c.json({ ok: true, expected: drawer.expected, counted, variance });
});
