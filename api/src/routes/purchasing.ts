import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, batch, need, nextNumber, one, readSettings, run, settingBool, stmt } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, conflict, int, num, oneOf, optInt, optStr, str } from "../lib/http.js";
import { extend } from "../lib/money.js";
import { invoiceEntry, post, receiptEntry, reversalEntry, supplierPaymentEntry } from "../lib/ledger.js";

export const purchasing = new Hono<Ctx>();

/**
 * The reorder worksheet.
 *
 * What to buy, worked out from what sold rather than from a fixed level alone:
 * `sold` over the window gives a daily rate, the supplier's lead time says how
 * long the shelf has to last, and the suggestion is what covers that plus the
 * reorder quantity, less what is already on order. A shop that reorders on the
 * level alone buys the same amount of a line that trebled in July as one that
 * stopped selling in May.
 */
purchasing.get("/worksheet", async (c) => {
  const days = Math.max(1, Number(c.req.query("days") ?? "28"));
  const since = now() - days * 86400;

  const rows = await all<{
    id: string;
    sku: string;
    name: string;
    stock: number;
    reorder_point: number;
    reorder_qty: number;
    cost: number;
    unit: string;
    supplier_id: string | null;
    supplier_name: string | null;
    lead_days: number;
    sold: number;
    on_order: number;
  }>(
    c.env.DB,
    `SELECT p.id, p.sku, p.name, p.stock, p.reorder_point, p.reorder_qty, p.cost, p.unit,
            p.supplier_id, s.name AS supplier_name, COALESCE(s.lead_days, 3) AS lead_days,
            COALESCE((SELECT SUM(i.qty) FROM sale_items i JOIN sales sa ON sa.id = i.sale_id
                       WHERE i.product_id = p.id AND sa.status = 'completed'
                         AND sa.completed_at >= ?1), 0) AS sold,
            COALESCE((SELECT SUM(poi.qty - poi.qty_received) FROM purchase_order_items poi
                        JOIN purchase_orders po ON po.id = poi.po_id
                       WHERE poi.product_id = p.id
                         AND po.status IN ('sent', 'part_received')), 0) AS on_order
       FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.active = 1
      ORDER BY p.name`,
    since,
  );

  const lines = rows
    .map((r) => {
      const perDay = r.sold / days;
      const cover = perDay * r.lead_days;
      const target = Math.max(r.reorder_point + r.reorder_qty, cover + r.reorder_qty);
      const suggested = Math.max(0, Math.ceil(target - r.stock - r.on_order));
      return {
        ...r,
        per_day: Math.round(perDay * 100) / 100,
        days_left: perDay > 0 ? Math.round((r.stock / perDay) * 10) / 10 : null,
        suggested,
        value: extend(suggested, r.cost),
      };
    })
    .filter((r) => r.suggested > 0 || r.stock <= r.reorder_point);

  return c.json({ days, lines });
});

purchasing.get("/orders", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT po.*, s.name AS supplier_name, u.name AS created_by_name,
            (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS lines
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by
      ORDER BY po.created_at DESC LIMIT 100`,
  );
  return c.json({ orders: rows });
});

purchasing.get("/orders/:id", async (c) => {
  const id = c.req.param("id");
  const order = await need(
    c.env.DB,
    "that order",
    `SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?1`,
    id,
  );
  const lines = await all(
    c.env.DB,
    `SELECT i.*, p.name AS product_name, p.sku, p.unit
       FROM purchase_order_items i JOIN products p ON p.id = i.product_id
      WHERE i.po_id = ?1 ORDER BY p.name`,
    id,
  );
  return c.json({ order, lines });
});

purchasing.post("/orders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const supplierId = str(body, "supplier_id");
  const wanted = (body as { lines?: unknown }).lines;
  if (!Array.isArray(wanted) || wanted.length === 0) {
    throw badRequest("no_lines", "an order needs something on it");
  }

  const id = newId("po");
  const number = await nextNumber(c.env.DB, "po_number");
  const at = now();
  let total = 0;
  const statements: D1PreparedStatement[] = [];

  for (const line of wanted) {
    const productId = str(line, "product_id");
    const qty = num(line, "qty");
    const unitCost = optInt(line, "unit_cost", 0);
    if (qty <= 0) continue;
    total += extend(qty, unitCost);
    statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO purchase_order_items (id, po_id, product_id, qty, qty_received, unit_cost)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)`,
        newId("poi"),
        id,
        productId,
        qty,
        unitCost,
      ),
    );
  }
  if (statements.length === 0) throw badRequest("no_lines", "every line had a quantity of nothing");

  statements.unshift(
    stmt(
      c.env.DB,
      `INSERT INTO purchase_orders (id, number, supplier_id, status, expected_at, total, note, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      id,
      number,
      supplierId,
      optStr(body, "status", "draft") === "sent" ? "sent" : "draft",
      (body as { expected_at?: number }).expected_at ?? null,
      total,
      optStr(body, "note"),
      actor.userId,
      at,
    ),
  );
  await batch(c.env.DB, statements);
  return c.json({ id, number, total }, 201);
});

purchasing.post("/orders/:id/send", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE purchase_orders SET status = 'sent' WHERE id = ?1 AND status = 'draft'",
  )
    .bind(c.req.param("id"))
    .run();
  if (result.meta.changes === 0) throw conflict("not_draft", "that order has already been sent");
  return c.json({ ok: true });
});

/**
 * Receiving.
 *
 * Goods arrive before the invoice does, so stock is debited against **goods
 * received not invoiced** rather than against payables — an accrual that the
 * invoice later clears. Booking it straight to payables would mean a supplier
 * balance that moves when a van arrives rather than when a bill does.
 *
 * A cost that differs from the order updates the product, because the price on
 * the delivery note is the price actually paid and every margin computed after
 * today should use it.
 */
purchasing.post("/orders/:id/receive", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const poId = c.req.param("id");
  const wanted = (body as { lines?: unknown }).lines;
  if (!Array.isArray(wanted) || wanted.length === 0) {
    throw badRequest("no_lines", "say what turned up");
  }

  const order = await need<{ id: string; status: string }>(
    c.env.DB,
    "that order",
    "SELECT id, status FROM purchase_orders WHERE id = ?1",
    poId,
  );
  if (order.status === "cancelled" || order.status === "received") {
    throw conflict("not_receivable", `that order is ${order.status}`);
  }

  const at = now();
  const statements: D1PreparedStatement[] = [];
  let value = 0;

  for (const entry of wanted) {
    const itemId = str(entry, "item_id");
    const qty = num(entry, "qty");
    if (qty <= 0) continue;

    const item = await one<{
      id: string;
      product_id: string;
      qty: number;
      qty_received: number;
      unit_cost: number;
    }>(
      c.env.DB,
      "SELECT id, product_id, qty, qty_received, unit_cost FROM purchase_order_items WHERE id = ?1 AND po_id = ?2",
      itemId,
      poId,
    );
    if (!item) throw badRequest("no_line", "that line is not on this order");

    const unitCost = optInt(entry, "unit_cost", item.unit_cost);
    const outstanding = item.qty - item.qty_received;
    if (qty > outstanding + 1e-9) {
      throw conflict("over_receipt", "that is more than the order still expects", {
        item_id: itemId,
        outstanding,
      });
    }
    value += extend(qty, unitCost);

    statements.push(
      stmt(
        c.env.DB,
        `UPDATE purchase_order_items SET qty_received = qty_received + ?2, unit_cost = ?3
          WHERE id = ?1 AND qty_received + ?2 <= qty + 0.000001`,
        itemId,
        qty,
        unitCost,
      ),
    );
    statements.push(
      stmt(c.env.DB, "UPDATE products SET stock = stock + ?2, cost = ?3, updated_at = ?4 WHERE id = ?1",
        item.product_id, qty, unitCost, at),
    );
    statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, unit_cost, user_id, created_at)
         VALUES (?1, ?2, ?3, 'receive', 'purchase_order', ?4, ?5, ?6, ?7)`,
        newId("sm"),
        item.product_id,
        qty,
        poId,
        unitCost,
        actor.userId,
        at,
      ),
    );
  }

  // Fully received when nothing is outstanding, in the same statement that
  // asks the question — so a partial delivery and a final one need no separate
  // bookkeeping call.
  statements.push(
    stmt(
      c.env.DB,
      `UPDATE purchase_orders
          SET status = CASE
                WHEN (SELECT SUM(qty - qty_received) FROM purchase_order_items WHERE po_id = ?1) <= 0.000001
                THEN 'received' ELSE 'part_received' END,
              received_at = CASE
                WHEN (SELECT SUM(qty - qty_received) FROM purchase_order_items WHERE po_id = ?1) <= 0.000001
                THEN ?2 ELSE received_at END
        WHERE id = ?1`,
      poId,
      at,
    ),
  );

  const settings = await readSettings(c.env.DB);
  if (value !== 0 && settingBool(settings, "accounting.enabled", false)) {
    statements.push(...post(c.env.DB, receiptEntry({ poId, at, value, userId: actor.userId })));
  }
  await batch(c.env.DB, statements);
  return c.json({ ok: true, value });
});

// ---------------------------------------------------------------------------
// Invoices and paying for them
// ---------------------------------------------------------------------------

purchasing.get("/payables", async (c) => {
  const rows = await all<{ outstanding: number; due_at: number | null }>(
    c.env.DB,
    `SELECT i.*, s.name AS supplier_name,
            COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.invoice_id = i.id), 0) AS paid,
            i.total - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p WHERE p.invoice_id = i.id), 0) AS outstanding
       FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.status = 'open'
      ORDER BY (i.due_at IS NULL), i.due_at, i.issued_at DESC LIMIT 200`,
  );
  /**
   * How overdue it is, by supplier — **summed by the database, over every
   * outstanding invoice**.
   *
   * Not from `rows` above, which is one page of 200. Aging is the figure a
   * shopkeeper decides who to pay from, and an aging report that quietly stops
   * at the two hundredth invoice tells them the oldest debt does not exist.
   *
   * The buckets are the ones an accountant expects: not yet due, then 1–30,
   * 31–60, 61–90 and over 90 days past the due date. An invoice with no due
   * date counts as not yet due — the shop has not agreed a date to break.
   */
  const at = now();
  type Aged = {
    supplier_id: string; supplier: string;
    current: number; d30: number; d60: number; d90: number; d90up: number; total: number;
  };
  const aging = await all<Aged>(
    c.env.DB,
    `SELECT s.id AS supplier_id, s.name AS supplier,
            SUM(CASE WHEN days = 0             THEN out ELSE 0 END) AS current,
            SUM(CASE WHEN days BETWEEN 1 AND 30  THEN out ELSE 0 END) AS d30,
            SUM(CASE WHEN days BETWEEN 31 AND 60 THEN out ELSE 0 END) AS d60,
            SUM(CASE WHEN days BETWEEN 61 AND 90 THEN out ELSE 0 END) AS d90,
            SUM(CASE WHEN days > 90            THEN out ELSE 0 END) AS d90up,
            SUM(out) AS total
       FROM (
         SELECT i.supplier_id,
                i.total - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p
                                     WHERE p.invoice_id = i.id), 0) AS out,
                CASE WHEN i.due_at IS NULL OR i.due_at >= ?1 THEN 0
                     ELSE (?1 - i.due_at) / 86400 END AS days
           FROM supplier_invoices i WHERE i.status = 'open'
       ) x
       JOIN suppliers s ON s.id = x.supplier_id
      WHERE x.out > 0
      GROUP BY s.id, s.name
      ORDER BY total DESC`,
    at,
  );
  const bucket = (k: keyof Aged) => aging.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const agingTotals = {
    current: bucket("current"),
    d30: bucket("d30"),
    d60: bucket("d60"),
    d90: bucket("d90"),
    d90up: bucket("d90up"),
    total: bucket("total"),
  };

  const totals = {
    outstanding: agingTotals.total,
    overdue: agingTotals.d30 + agingTotals.d60 + agingTotals.d90 + agingTotals.d90up,
    current: agingTotals.current,
    late_over_30: agingTotals.d60 + agingTotals.d90 + agingTotals.d90up,
  };
  return c.json({ invoices: rows, totals, aging: { rows: aging, totals: agingTotals } });
});

purchasing.post("/invoices", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const id = newId("inv");
  const at = now();
  const total = int(body, "total");
  // An invoice for nothing is not an invoice. It is what a form sends when the
  // amount could not be read — and it is the one that gets through silently:
  // `post` drops zero-valued lines, so a zero invoice writes no journal entry
  // at all and the payable to that supplier simply does not exist. Paying a
  // bill, recording an expense and moving cash all already refuse a
  // non-positive amount; this was the gap in the row.
  if (total <= 0) throw badRequest("bad_total", "an invoice has to be for more than nothing");
  const issuedAt = optInt(body, "issued_at", at);

  const statements = [
    stmt(
      c.env.DB,
      `INSERT INTO supplier_invoices (id, supplier_id, po_id, reference, issued_at, due_at, total, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      id,
      str(body, "supplier_id"),
      optStr(body, "po_id") || null,
      optStr(body, "reference"),
      issuedAt,
      (body as { due_at?: number }).due_at ?? null,
      total,
      at,
    ),
  ];
  const settings = await readSettings(c.env.DB);
  if (settingBool(settings, "accounting.enabled", false)) {
    statements.push(
      ...post(c.env.DB, invoiceEntry({ invoiceId: id, at: issuedAt, total, userId: actor.userId })),
    );
  }
  await batch(c.env.DB, statements);
  return c.json({ id }, 201);
});

purchasing.post("/invoices/:id/pay", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const invoiceId = c.req.param("id");
  const amount = int(body, "amount");
  const method = oneOf(body, "method", ["cash", "card", "wallet"] as const);
  if (amount <= 0) throw badRequest("bad_amount", "a payment has to be more than nothing");

  const id = newId("sp");
  const at = optInt(body, "paid_at", now());

  // Conditional on there still being a balance, so two people paying the same
  // invoice at once cannot overpay it.
  //
  // **The payment is written on its own, first.** An `INSERT … SELECT` whose
  // WHERE is false inserts nothing and does *not* error, so it cannot abort a
  // batch — which means putting the journal entry in the same batch booked a
  // payment that had been refused, and the 409 was raised only afterwards. The
  // caller was told nothing happened while the books said 3,000 had moved, and
  // the entry is immutable so it could only be undone by a correction nobody
  // knew to post. The ledger now waits for the payment to actually exist.
  const written = await run(
    c.env.DB,
    `INSERT INTO supplier_payments (id, invoice_id, amount, method, paid_at, user_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT i.total - COALESCE((SELECT SUM(p.amount) FROM supplier_payments p
                                         WHERE p.invoice_id = i.id), 0)
               FROM supplier_invoices i WHERE i.id = ?2) >= ?3`,
    id,
    invoiceId,
    amount,
    method,
    at,
    actor.userId,
  );
  if (written.meta.changes === 0) {
    throw conflict("overpay", "that is more than the invoice still owes");
  }

  const settings = await readSettings(c.env.DB);
  if (settingBool(settings, "accounting.enabled", false)) {
    await batch(
      c.env.DB,
      post(
        c.env.DB,
        supplierPaymentEntry({ paymentId: id, at, amount, method, userId: actor.userId }),
      ),
    );
  }
  return c.json({ id }, 201);
});

/**
 * Cancel an invoice that should never have been raised.
 *
 * Not a delete. Receiving a delivery raises an invoice on its own, so a
 * delivery booked twice or against the wrong order leaves a payable the shop
 * does not owe — and the only way out used to be to pay it. The row stays,
 * marked, with the reason on it.
 *
 * Refused once anything has been paid against it: a part-paid invoice is a
 * real obligation with real money already moved, and unwinding that is a
 * credit note rather than a cancellation.
 */
purchasing.post("/invoices/:id/cancel", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const id = c.req.param("id");
  const reason = str(body, "reason").trim();
  if (reason.length === 0) throw badRequest("bad_reason", "cancelling an invoice needs a reason");

  const paid = await one<{ amount: number }>(
    c.env.DB,
    "SELECT COALESCE(SUM(amount), 0) AS amount FROM supplier_payments WHERE invoice_id = ?1",
    id,
  );
  if ((paid?.amount ?? 0) > 0) {
    throw conflict("already_paid", "something has been paid against that invoice");
  }

  const at = now();
  const cancelled = await run(
    c.env.DB,
    `UPDATE supplier_invoices SET status = 'cancelled', cancelled_at = ?2, cancel_reason = ?3
      WHERE id = ?1 AND status = 'open'`,
    id,
    at,
    reason,
  );
  if (cancelled.meta.changes === 0) {
    throw conflict("not_open", "that invoice is not open");
  }

  // The accrual it raised has to come back off the books, or the shop still
  // owes it in the ledger while the list says it does not.
  const invoice = await one<{ total: number; po_id: string | null }>(
    c.env.DB,
    "SELECT total, po_id FROM supplier_invoices WHERE id = ?1",
    id,
  );
  const settings = await readSettings(c.env.DB);
  if (invoice && settingBool(settings, "accounting.enabled", false)) {
    const original = await one<{
      id: string; memo: string; ref_type: string; ref_id: string;
    }>(
      c.env.DB,
      `SELECT id, memo, ref_type, ref_id FROM journal_entries
        WHERE ref_type = 'supplier_invoice' AND ref_id = ?1
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.corrects_id = journal_entries.id)
        ORDER BY rowid LIMIT 1`,
      id,
    );
    if (original) {
      const lines = await all<{ account_code: string; amount: number; memo: string }>(
        c.env.DB,
        "SELECT account_code, amount, memo FROM journal_lines WHERE entry_id = ?1 ORDER BY rowid",
        original.id,
      );
      if (lines.length > 0) {
        await batch(
          c.env.DB,
          post(c.env.DB, reversalEntry({ original, lines, at, reason, userId: actor.userId })),
        );
      }
    }
  }

  await run(
    c.env.DB,
    `INSERT INTO audit_log (id, at, user_id, approved_by, action, ref_type, ref_id, detail)
     VALUES (?1, ?2, ?3, ?3, 'cancel_invoice', 'supplier_invoice', ?4, ?5)`,
    newId("aud"),
    at,
    actor.userId,
    id,
    reason,
  );
  return c.json({ ok: true });
});
