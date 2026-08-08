import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, batch, currencyOf, need, one, readSettings, settingBool, stmt } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, int, notFound, num, oneOf, optStr, str } from "../lib/http.js";
import { extend, taxWithin } from "../lib/money.js";
import { applyRefund } from "../lib/refunds.js";

export const sales = new Hono<Ctx>();

sales.get("/", async (c) => {
  const from = Number(c.req.query("from") ?? "0");
  const to = Number(c.req.query("to") ?? String(now()));
  const status = c.req.query("status") ?? "completed";
  const q = (c.req.query("q") ?? "").trim();

  const binds: unknown[] = [from, to];
  let extra = "";
  if (q.length > 0) {
    binds.push(`%${q}%`);
    extra = ` AND (CAST(s.number AS TEXT) LIKE ?${binds.length} OR c.name LIKE ?${binds.length}
                   OR u.name LIKE ?${binds.length})`;
  }
  binds.push(status);

  const rows = await all(
    c.env.DB,
    `SELECT s.id, s.number, s.total, s.tax, s.discount, s.promo_saved, s.status,
            s.completed_at, s.created_at, s.void_reason,
            u.name AS cashier, c.name AS customer, r.name AS register_name,
            (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items,
            (SELECT COALESCE(SUM(rf.total), 0) FROM refunds rf WHERE rf.sale_id = s.id) AS refunded
       FROM sales s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN registers r ON r.id = s.register_id
      WHERE COALESCE(s.completed_at, s.created_at) BETWEEN ?1 AND ?2
        ${extra}
        AND s.status = ?${binds.length}
      ORDER BY COALESCE(s.completed_at, s.created_at) DESC
      LIMIT 200`,
    ...binds,
  );
  return c.json({ sales: rows });
});

/**
 * One sale, in full — which is also the receipt.
 *
 * Every line carries the name, SKU, price and offer as they were **on the day**,
 * from the snapshot columns rather than a join to the product. A reprint years
 * later reads exactly as it did at the counter, after the product was renamed,
 * repriced, or retired.
 */
sales.get("/:id", async (c) => {
  const id = c.req.param("id");
  const sale = await need(
    c.env.DB,
    "that sale",
    `SELECT s.*, u.name AS cashier, c.name AS customer, c.phone AS customer_phone,
            r.name AS register_name
       FROM sales s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN registers r ON r.id = s.register_id
      WHERE s.id = ?1`,
    id,
  );
  const lines = await all(
    c.env.DB,
    `SELECT i.*,
            (SELECT COALESCE(SUM(ri.qty), 0) FROM refund_items ri WHERE ri.sale_item_id = i.id) AS refunded_qty
       FROM sale_items i WHERE i.sale_id = ?1 ORDER BY i.sort, i.rowid`,
    id,
  );
  const payments = await all(c.env.DB, "SELECT * FROM payments WHERE sale_id = ?1", id);
  const refunds = await all(
    c.env.DB,
    `SELECT r.*, u.name AS by_name FROM refunds r JOIN users u ON u.id = r.user_id
      WHERE r.sale_id = ?1 ORDER BY r.created_at DESC`,
    id,
  );
  const settings = await readSettings(c.env.DB);
  return c.json({
    sale,
    lines,
    payments,
    refunds,
    currency: currencyOf(settings),
    shop: {
      name: settings["shop.name"] ?? "",
      address: settings["shop.address"] ?? "",
      phone: settings["shop.phone"] ?? "",
      tax_id: settings["shop.tax_id"] ?? "",
      footer: settings["shop.receipt_footer"] ?? "",
    },
  });
});

/**
 * A refund, against the lines it is for.
 *
 * The barrier against refunding the same unit twice is the arithmetic itself:
 * the INSERT for each refund line is conditional on the units still being
 * unrefunded, checked in the same statement that writes them. Two cashiers
 * refunding the same receipt at once means one of the writes changes nothing,
 * and this refuses rather than paying out twice.
 */
sales.post("/:id/refund", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const saleId = c.req.param("id");
  const reason = str(body, "reason").trim();
  if (reason.length === 0) throw badRequest("bad_reason", "a refund needs a reason");
  const method = oneOf(body, "method", ["cash", "card", "wallet", "store_credit"] as const);

  const sale = await need<{ id: string; status: string }>(
    c.env.DB,
    "that sale",
    "SELECT id, status FROM sales WHERE id = ?1",
    saleId,
  );
  if (sale.status !== "completed") throw conflict("not_refundable", "only a completed sale can be refunded");

  const wanted = (body as { lines?: unknown }).lines;
  if (!Array.isArray(wanted) || wanted.length === 0) {
    throw badRequest("no_lines", "say which lines are coming back");
  }

  const settings = await readSettings(c.env.DB);
  return c.json(
    await applyRefund(c.env.DB, {
      saleId,
      wanted: wanted.map((entry) => ({
        sale_item_id: str(entry, "sale_item_id"),
        qty: num(entry, "qty"),
      })),
      reason,
      method,
      restock: (body as { restock?: boolean }).restock !== false,
      userId: actor.userId,
      approvedBy: actor.userId,
      // **No shift, and the cash comes from the safe.**
      //
      // This used to be `sale.shift_id` — the drawer session the sale was rung
      // on, which for a refund taken days later is a session that closed days
      // ago. The cash left today's till, `expectedInDrawer` looked for refunds
      // on *today's* shift and found none, and the count came up short by the
      // refund: booked to cash over and short against a cashier who had done
      // nothing wrong, with the drawer account left permanently negative and
      // every later shift inheriting the offset.
      //
      // The office has no drawer to take it from, so it takes it from the safe
      // and no drawer count is involved at all. A refund a lane pays goes
      // through Return, which does have a shift and does credit the drawer.
      shiftId: null,
      registerId: null,
      cashFrom: "safe",
      clientId: optStr(body, "client_id") || null,
      at: now(),
      accounting: settingBool(settings, "accounting.enabled", false),
      action: "refund",
    }),
    201,
  );
});

/**
 * Voiding a completed sale.
 *
 * Kept separate from a refund because they are different events: a void says
 * the sale should not have been rung, a refund says goods came back. Both leave
 * the sale readable — nothing here deletes a transaction.
 */
sales.post("/:id/void", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const reason = str(body, "reason").trim();
  if (reason.length === 0) throw badRequest("bad_reason", "voiding a sale needs a reason");

  const result = await c.env.DB.prepare(
    "UPDATE sales SET status = 'voided', void_reason = ?2 WHERE id = ?1 AND status = 'held'",
  )
    .bind(c.req.param("id"), reason)
    .run();
  if (result.meta.changes === 0) {
    throw conflict("not_voidable", "a completed sale is refunded, not voided");
  }
  await c.env.DB.prepare(
    `INSERT INTO audit_log (id, at, user_id, approved_by, action, ref_type, ref_id, detail)
     VALUES (?1, ?2, ?3, ?3, 'void_sale', 'sale', ?4, ?5)`,
  )
    .bind(newId("aud"), now(), actor.userId, c.req.param("id"), reason)
    .run();
  return c.json({ ok: true });
});

/** The authorisations register: who approved what, at which lane. */
sales.get("/audit/log", async (c) => {
  const from = Number(c.req.query("from") ?? String(now() - 86400));
  const rows = await all(
    c.env.DB,
    `SELECT a.*, u.name AS asked_by_name, ap.name AS approved_by_name, r.name AS register_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users ap ON ap.id = a.approved_by
       LEFT JOIN registers r ON r.id = a.register_id
      WHERE a.at >= ?1
      ORDER BY a.at DESC LIMIT 200`,
    from,
  );
  return c.json({ entries: rows });
});
