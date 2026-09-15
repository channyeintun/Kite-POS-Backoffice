import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, need, readSettings, run, settingBool } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { conflict, int, oneOf, optInt, optStr, str } from "../lib/http.js";
import { OPEN_TABS_SQL, OUTSTANDING_ON_SALE, settleTab } from "../lib/credit.js";

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

/**
 * Who owes the shop, and how long they have owed it.
 *
 * Declared before `/:id` because Hono would otherwise read "receivables" as a
 * customer id and answer 404 for the whole screen.
 *
 * **Summed by the database over every debtor**, with no limit on it — for the
 * reason the payables report gives in the same words: an aging report that
 * quietly stops at the two hundredth row tells a shopkeeper the oldest debt
 * does not exist. It is the one figure on the Customers screen that is not
 * capped, and it is the one the headline stat is taken from, so the card and
 * the foot of the table beneath it cannot disagree.
 *
 * The bands are measured from **the day the goods left**, because a shop tab
 * has no agreed date to break. Nobody signed terms; somebody said "put it on
 * my account" and the clock started. So there is no "not yet due" band here,
 * which is the one difference from the supplier aging beside it — everything
 * on this report is money the shop is waiting for, and the only question is
 * how long it has been waiting.
 */
customers.get("/receivables", async (c) => {
  const at = now();

  type Aged = {
    customer_id: string;
    customer: string;
    d30: number;
    d60: number;
    d90: number;
    d90up: number;
    total: number;
  };
  const aging = await all<Aged>(
    c.env.DB,
    `SELECT cu.id AS customer_id, cu.name AS customer,
            SUM(CASE WHEN days <= 30              THEN out ELSE 0 END) AS d30,
            SUM(CASE WHEN days BETWEEN 31 AND 60  THEN out ELSE 0 END) AS d60,
            SUM(CASE WHEN days BETWEEN 61 AND 90  THEN out ELSE 0 END) AS d90,
            SUM(CASE WHEN days > 90               THEN out ELSE 0 END) AS d90up,
            SUM(out) AS total
       FROM (
         SELECT s.customer_id,
                ${OUTSTANDING_ON_SALE} AS out,
                (?1 - COALESCE(s.completed_at, ?1)) / 86400 AS days
           FROM sales s
          WHERE s.status = 'completed' AND s.customer_id IS NOT NULL
       ) x
       JOIN customers cu ON cu.id = x.customer_id
      WHERE x.out > 0
      GROUP BY cu.id, cu.name
      ORDER BY total DESC`,
    at,
  );

  const totals = {
    owed: aging.reduce((a, r) => a + Number(r.total ?? 0), 0),
    d30: aging.reduce((a, r) => a + Number(r.d30 ?? 0), 0),
    d60: aging.reduce((a, r) => a + Number(r.d60 ?? 0), 0),
    d90: aging.reduce((a, r) => a + Number(r.d90 ?? 0), 0),
    d90up: aging.reduce((a, r) => a + Number(r.d90up ?? 0), 0),
    debtors: aging.length,
  };

  const payments = await all(
    c.env.DB,
    `SELECT cp.id, cp.customer_id, cp.method, cp.total, cp.reference, cp.note, cp.created_at,
            cu.name AS customer, u.name AS taken_by
       FROM customer_payments cp
       JOIN customers cu ON cu.id = cp.customer_id
       JOIN users u ON u.id = cp.user_id
      ORDER BY cp.created_at DESC LIMIT 50`,
  );

  return c.json({ aging: { rows: aging, totals }, payments });
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
  // The tab, receipt by receipt and oldest first — the same list and the same
  // order a settlement pays off, so what the screen shows is what the shop
  // will do.
  const tab = await all(c.env.DB, OPEN_TABS_SQL, id);
  const settlements = await all(
    c.env.DB,
    `SELECT cp.id, cp.method, cp.total, cp.reference, cp.note, cp.created_at, u.name AS taken_by
       FROM customer_payments cp JOIN users u ON u.id = cp.user_id
      WHERE cp.customer_id = ?1 ORDER BY cp.created_at DESC LIMIT 50`,
    id,
  );
  return c.json({ customer, history, favourites, tab, settlements });
});

customers.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = newId("cus");
  const limit = optInt(body, "credit_limit", 0);
  if (limit < 0) throw conflict("bad_limit", "a credit limit cannot be negative");
  await run(
    c.env.DB,
    `INSERT INTO customers (id, name, phone, points, credit, credit_limit, owed, note, created_at)
     VALUES (?1, ?2, ?3, 0, 0, ?4, 0, ?5, ?6)`,
    id,
    str(body, "name"),
    optStr(body, "phone"),
    limit,
    optStr(body, "note"),
    now(),
  );
  // A limit granted at sign-up is the same decision as one raised a month later
  // and is written down the same way. Without this, the only credit limits with
  // nobody's name against them would be the ones set on the day somebody was
  // added — which is exactly when a limit is most likely to be set carelessly.
  if (limit > 0) {
    const actor = c.get("actor");
    await run(
      c.env.DB,
      `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?3, NULL, 'credit_limit', 'customer', ?4, ?5, 'set when they were added')`,
      newId("aud"),
      now(),
      actor.userId,
      id,
      limit,
    );
  }
  return c.json({ id }, 201);
});

/**
 * Edit a customer.
 *
 * `credit_limit` is **optional here in a way the other fields are not**, and
 * the `COALESCE` is the reason. This is a whole-row overwrite: a client that
 * omits `phone` blanks it, which is the existing contract and is fine for a
 * field somebody can retype. A credit limit is a decision about trust, and a
 * form that does not carry it — an older build of the app, a script, the till
 * signing somebody up at the counter — must not silently revoke it and leave
 * the customer refused at the lane with nobody able to say what changed.
 *
 * Lowering a limit below what is already owed is allowed on purpose. It stops
 * the tab growing without pretending the existing debt is not there, which is
 * exactly what a shopkeeper means by "no more until you settle up".
 */
customers.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = c.req.param("id");
  const raw = (body as { credit_limit?: unknown }).credit_limit;
  const limit = raw === undefined || raw === null ? null : int(body, "credit_limit");
  if (limit !== null && limit < 0) throw conflict("bad_limit", "a credit limit cannot be negative");

  const before = await need<{ credit_limit: number }>(
    c.env.DB,
    "that customer",
    "SELECT credit_limit FROM customers WHERE id = ?1",
    id,
  );
  await run(
    c.env.DB,
    `UPDATE customers SET name = ?2, phone = ?3, note = ?4,
                          credit_limit = COALESCE(?5, credit_limit)
      WHERE id = ?1`,
    id,
    str(body, "name"),
    optStr(body, "phone"),
    optStr(body, "note"),
    limit,
  );

  // A change to what somebody may owe is written where the authorisations are.
  // "Who let them run up that much" is the question this answers, and a limit
  // that moved with nobody's name against it is not an answer.
  if (limit !== null && limit !== before.credit_limit) {
    const actor = c.get("actor");
    await run(
      c.env.DB,
      `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?3, NULL, 'credit_limit', 'customer', ?4, ?5, ?6)`,
      newId("aud"),
      now(),
      actor.userId,
      id,
      limit,
      `was ${before.credit_limit}`,
    );
  }
  return c.json({ ok: true });
});

/**
 * Money off a tab, taken in the back office.
 *
 * The same settlement the lane takes, from the other door — so it allocates the
 * same way, posts the same entry, and is refused by the same balance check.
 * What differs is where the cash goes: the office has no drawer to count, so it
 * goes to the safe, exactly as `expenseEntry` pays a bill and
 * `supplierPaymentEntry` pays a supplier. Charging it to a lane's drawer would
 * leave that lane over by the settlement at its next count, with no shift to
 * explain the difference.
 */
customers.post("/:id/payments", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const settings = await readSettings(c.env.DB);
  const settled = await settleTab(c.env.DB, {
    customerId: c.req.param("id"),
    amount: int(body, "amount"),
    method: oneOf(body, "method", ["cash", "card", "wallet"] as const),
    reference: optStr(body, "reference"),
    note: optStr(body, "note"),
    userId: actor.userId,
    shiftId: null,
    registerId: null,
    cashTo: "safe",
    clientId: optStr(body, "client_id") || null,
    at: now(),
    accounting: settingBool(settings, "accounting.enabled", false),
  });
  return c.json(settled, 201);
});
