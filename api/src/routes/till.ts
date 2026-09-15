import { Hono } from "hono";
import type { Context } from "hono";
import type { Ctx, Actor } from "../env.js";
import { now } from "../env.js";
import {
  all,
  batch,
  currencyOf,
  need,
  nextNumber,
  one,
  readSettings,
  run,
  settingBool,
  stmt,
  type Settings,
} from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { approvalFor, requireManagerSession } from "../lib/auth.js";
import { badRequest, conflict, forbidden, int, notFound, num, oneOf, optStr, str } from "../lib/http.js";
import { extend } from "../lib/money.js";
import { commandsFor } from "../lib/commands.js";
import { linesOf, livePromotions, priceSale, writeBack, type LineRow, type SaleRow } from "../lib/sales.js";
import { expectedInDrawer } from "./shifts.js";
import { post, saleEntry, sweepEntry, varianceEntry } from "../lib/ledger.js";
import { applyRefund } from "../lib/refunds.js";
import { settleTab } from "../lib/credit.js";

export const till = new Hono<Ctx>();

/**
 * The lane a request is coming from.
 *
 * A till session carries its register; a manager signing in with a password has
 * none, and cannot ring a sale without taking a lane over from Tills. That is
 * the role-routing rule showing up as a missing value rather than as a check.
 */
function laneOf(actor: Actor): string {
  if (!actor.registerId) {
    throw forbidden("this session is not signed in at a lane");
  }
  return actor.registerId;
}

async function openShift(db: D1Database, registerId: string): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    "SELECT id FROM shifts WHERE register_id = ?1 AND closed_at IS NULL",
    registerId,
  );
  return row?.id ?? null;
}

/**
 * The basket this lane is ringing, made if it is not there yet.
 *
 * A basket is a real row from the first scan, not something the browser is
 * holding — so a refresh, a flat battery or a second tab never loses a
 * customer's shopping. `sales_one_active` makes "one active basket per lane" a
 * constraint, and the INSERT below is written to lose that race harmlessly:
 * whoever gets there second reads the row the winner made.
 */
async function activeBasket(db: D1Database, actor: Actor): Promise<SaleRow> {
  const registerId = laneOf(actor);
  const existing = await one<SaleRow>(
    db,
    "SELECT * FROM sales WHERE register_id = ?1 AND status = 'held' AND hold_label = ''",
    registerId,
  );
  if (existing) return existing;

  const id = newId("sale");
  const shiftId = await openShift(db, registerId);
  await run(
    db,
    `INSERT INTO sales (id, register_id, shift_id, user_id, status, hold_label, created_at)
     VALUES (?1, ?2, ?3, ?4, 'held', '', ?5)
     ON CONFLICT DO NOTHING`,
    id,
    registerId,
    shiftId,
    actor.userId,
    now(),
  );
  return await need<SaleRow>(
    db,
    "a basket",
    "SELECT * FROM sales WHERE register_id = ?1 AND status = 'held' AND hold_label = ''",
    registerId,
  );
}

/**
 * Price the basket and answer with the whole of it.
 *
 * **Every mutating endpoint below returns this.** A scan, a quantity change and
 * a discount all come back from the same shape, and the till pulls the lines,
 * the totals and the badges out of that one response — so they cannot show
 * different numbers to each other, and there is no second request whose failure
 * would leave the screen half updated.
 */
async function basketView(
  db: D1Database,
  actor: Actor,
  sale: SaleRow,
): Promise<Record<string, unknown>> {
  const settings = await readSettings(db);
  const taxInclusive = settingBool(settings, "tax.inclusive", true);
  const at = now();

  const lines = await linesOf(db, sale.id);
  const promotions = await livePromotions(db, at);
  const priced = priceSale(lines, promotions, sale.basket_discount, taxInclusive, at);

  // Recomputing on read costs nothing and means a basket whose offer expired
  // while it was parked is repriced when it is picked back up, rather than
  // charging yesterday's promotion today.
  const changed =
    priced.totals.total !== sale.total ||
    priced.lines.some((l, i) => l.total !== lines[i]?.total || l.promo_id !== lines[i]?.promo_id);
  if (changed) await batch(db, writeBack(db, sale.id, priced));

  const heldCount = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM sales
      WHERE register_id = ?1 AND status = 'held' AND hold_label <> ''`,
    sale.register_id,
  );
  // The tab comes with the basket, because the decision it feeds is taken on
  // the tender screen: how much of this basket may go on the customer's
  // account, and how much they already owe. A till that had to ask separately
  // would be asking about a figure it had just been shown.
  const customer = sale.customer_id
    ? await one<{
        id: string;
        name: string;
        points: number;
        credit: number;
        credit_limit: number;
        owed: number;
      }>(
        db,
        "SELECT id, name, points, credit, credit_limit, owed FROM customers WHERE id = ?1",
        sale.customer_id,
      )
    : null;
  const shiftId = await openShift(db, laneOf(actor));

  return {
    sale: {
      id: sale.id,
      status: sale.status,
      register_id: sale.register_id,
      shift_id: shiftId,
      customer,
      ...priced.totals,
      item_count: priced.lines.reduce((a, l) => a + l.qty, 0),
    },
    lines: priced.lines.map((l) => ({
      id: l.id,
      product_id: l.product_id,
      name: l.name,
      name_my: l.name_my ?? "",
      sku: l.sku,
      qty: l.qty,
      unit_price: l.unit_price,
      list_price: l.list_price,
      line_discount: l.line_discount,
      promo_id: l.promo_id,
      promo_name: l.promo_name,
      promo_saved: l.promo_saved,
      price_override: l.price_override === 1,
      tax: l.tax,
      total: l.total,
      min_age: l.min_age,
      age_checked: l.age_checked === 1,
    })),
    held_count: heldCount?.n ?? 0,
    commands: commandsFor(actor.role, "sale"),
    currency: currencyOf(settings),
    tax_inclusive: taxInclusive,
    shift_open: shiftId !== null,
  };
}

/** Reprice and answer, after something changed. */
async function answer(c: Context<Ctx>, saleId: string) {
  const sale = await need<SaleRow>(c.env.DB, "that basket", "SELECT * FROM sales WHERE id = ?1", saleId);
  return c.json(await basketView(c.env.DB, c.get("actor"), sale));
}

/** A basket may only be changed while it is still being rung. */
function mustBeHeld(sale: SaleRow): void {
  if (sale.status !== "held") {
    throw conflict("sale_closed", "that sale has already been finished");
  }
}

// ---------------------------------------------------------------------------
// Reading the basket
// ---------------------------------------------------------------------------

till.get("/basket", async (c) => {
  const sale = await activeBasket(c.env.DB, c.get("actor"));
  return c.json(await basketView(c.env.DB, c.get("actor"), sale));
});

// ---------------------------------------------------------------------------
// Putting things in it
// ---------------------------------------------------------------------------

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  name_my: string;
  price: number;
  cost: number;
  tax_bp: number;
  min_age: number;
  ask_price: number;
  unit: string;
  stock: number;
  active: number;
};

/**
 * A scan, resolved.
 *
 * A barcode is not a product: a tray of six eggs and a single egg are two
 * barcodes for the same product, and `pack_size` is what one scan means in
 * stock units. Scanning the tray adds six and prices it once, which is why this
 * returns a quantity alongside the product rather than assuming one.
 */
async function resolveScan(
  db: D1Database,
  code: string,
): Promise<{ product: ProductRow; qty: number; label: string } | null> {
  const byBarcode = await one<ProductRow & { pack_size: number; label: string }>(
    db,
    `SELECT p.*, b.pack_size, b.label
       FROM product_barcodes b JOIN products p ON p.id = b.product_id
      WHERE b.barcode = ?1`,
    code,
  );
  if (byBarcode) {
    return { product: byBarcode, qty: byBarcode.pack_size, label: byBarcode.label };
  }
  const bySku = await one<ProductRow>(
    db,
    "SELECT * FROM products WHERE sku = ?1 AND active = 1",
    code,
  );
  if (bySku) return { product: bySku, qty: 1, label: "" };
  return null;
}

till.post("/scan", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);

  const code = optStr(body, "code");
  const productId = optStr(body, "product_id");
  let product: ProductRow;
  let qty = num(body, "qty", 0);

  if (code) {
    const hit = await resolveScan(c.env.DB, code);
    if (!hit) throw notFound(`nothing is filed under ${code}`);
    product = hit.product;
    if (qty === 0) qty = hit.qty;
  } else if (productId) {
    product = await need<ProductRow>(
      c.env.DB,
      "that product",
      "SELECT * FROM products WHERE id = ?1",
      productId,
    );
    if (qty === 0) qty = 1;
  } else {
    throw badRequest("bad_field", "send a code or a product_id");
  }

  if (product.active !== 1) throw badRequest("inactive", `${product.name} is not for sale`);
  if (qty <= 0) throw badRequest("bad_qty", "a quantity has to be more than nothing");

  // "Price at till": the shelf price is not in the system, so the operator is
  // asked. The till refuses the scan and names what it needs rather than
  // ringing a zero.
  //
  // The price has to be a **whole number of minor units**, checked the same way
  // every other price entry point checks it. Read with a bare `typeof ===
  // "number"` this was the one hole in "a float never touches a price": 1500.5
  // went in, `extend()` does not round when the quantity is a whole number, and
  // the fraction propagated into `sale_items`, `sales`, `payments` and — worst
  // — `journal_lines`, which is immutable and therefore uncorrectable. None of
  // the tables are STRICT, so SQLite keeps the REAL in an INTEGER column.
  const askedPrice = (body as { price?: unknown }).price;
  const askedIsAmount = typeof askedPrice === "number" && Number.isInteger(askedPrice);
  if (product.ask_price === 1 && !askedIsAmount) {
    if (askedPrice !== undefined && askedPrice !== null) {
      throw badRequest("bad_price", "a price has to be a whole number");
    }
    return c.json(
      {
        needs: "price",
        product: { id: product.id, name: product.name, unit: product.unit },
      },
      422,
    );
  }
  const unitPrice = product.ask_price === 1 && askedIsAmount ? askedPrice : product.price;
  if (unitPrice < 0) throw badRequest("bad_price", "a price cannot be negative");

  // Scanning an age-restricted item stops the sale and asks for ID. The dialog
  // wants the actual date to check against, so nobody is doing arithmetic at
  // the counter with a queue waiting — the till sends the year, the client
  // renders the date.
  const existing = await one<LineRow>(
    c.env.DB,
    `SELECT * FROM sale_items
      WHERE sale_id = ?1 AND product_id = ?2 AND price_override = 0 AND line_discount = 0`,
    sale.id,
    product.id,
  );
  const alreadyChecked = existing?.age_checked === 1;
  if (product.min_age > 0 && !alreadyChecked && body.age_checked !== true) {
    return c.json(
      {
        needs: "age_check",
        min_age: product.min_age,
        born_on_or_before: Math.floor(Date.now() / 1000) - product.min_age * 31_557_600,
        product: { id: product.id, name: product.name },
      },
      422,
    );
  }

  const statements: D1PreparedStatement[] = [];
  if (existing) {
    // A rescanned item merges into its line rather than stacking duplicates, so
    // "×3" reads at a glance instead of three identical rows.
    statements.push(
      stmt(
        c.env.DB,
        "UPDATE sale_items SET qty = qty + ?2, age_checked = ?3 WHERE id = ?1",
        existing.id,
        qty,
        product.min_age > 0 ? 1 : 0,
      ),
    );
  } else {
    const sortRow = await one<{ next: number }>(
      c.env.DB,
      "SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM sale_items WHERE sale_id = ?1",
      sale.id,
    );
    statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO sale_items
           (id, sale_id, product_id, name, sku, qty, unit_price, list_price, tax_bp,
            cost, min_age, age_checked, sort)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12)`,
        newId("li"),
        sale.id,
        product.id,
        product.name,
        product.sku,
        qty,
        unitPrice,
        product.tax_bp,
        product.cost,
        product.min_age,
        product.min_age > 0 ? 1 : 0,
        sortRow?.next ?? 1,
      ),
    );
  }
  await batch(c.env.DB, statements);
  return await answer(c, sale.id);
});

till.patch("/line/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const qty = num(body, "qty");
  const actor = c.get("actor");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);

  if (qty <= 0) {
    await run(c.env.DB, "DELETE FROM sale_items WHERE id = ?1 AND sale_id = ?2", c.req.param("id"), sale.id);
    return await answer(c, sale.id);
  }
  const result = await run(
    c.env.DB,
    "UPDATE sale_items SET qty = ?3 WHERE id = ?1 AND sale_id = ?2",
    c.req.param("id"),
    sale.id,
    qty,
  );
  if (result.meta.changes === 0) throw notFound("that line is not in this basket");
  return await answer(c, sale.id);
});

till.delete("/line/:id", async (c) => {
  const actor = c.get("actor");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);
  await run(c.env.DB, "DELETE FROM sale_items WHERE id = ?1 AND sale_id = ?2", c.req.param("id"), sale.id);
  return await answer(c, sale.id);
});

/**
 * A line discount, or a price the operator typed.
 *
 * Both are the "PIN" row of the command matrix: a cashier may do either with a
 * manager's PIN entered at the lane, and a manager needs nobody. The approval
 * is written to `audit_log` with who asked and who approved, because an
 * authorisation nobody can name afterwards is not an authorisation.
 */
till.post("/line/:id/adjust", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);

  const kind = oneOf(body, "kind", ["discount", "override", "age_check"] as const);
  const lineId = c.req.param("id");
  const line = await need<LineRow>(
    c.env.DB,
    "that line",
    "SELECT * FROM sale_items WHERE id = ?1 AND sale_id = ?2",
    lineId,
    sale.id,
  );

  if (kind === "age_check") {
    await run(c.env.DB, "UPDATE sale_items SET age_checked = 1 WHERE id = ?1", lineId);
    return await answer(c, sale.id);
  }

  const approvedBy = await approvalFor(c.env.DB, actor, optStr(body, "manager_pin") || undefined);
  const statements: D1PreparedStatement[] = [];
  let amount = 0;

  if (kind === "discount") {
    amount = int(body, "amount");
    if (amount < 0) throw badRequest("bad_amount", "a discount cannot be negative");
    statements.push(stmt(c.env.DB, "UPDATE sale_items SET line_discount = ?2 WHERE id = ?1", lineId, amount));
  } else {
    amount = int(body, "price");
    if (amount < 0) throw badRequest("bad_amount", "a price cannot be negative");
    statements.push(
      stmt(
        c.env.DB,
        "UPDATE sale_items SET unit_price = ?2, list_price = ?2, price_override = 1 WHERE id = ?1",
        lineId,
        amount,
      ),
    );
  }

  statements.push(
    stmt(
      c.env.DB,
      `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sale_item', ?7, ?8, ?9)`,
      newId("aud"),
      now(),
      actor.userId,
      approvedBy,
      sale.register_id,
      kind === "discount" ? "line_discount" : "price_override",
      lineId,
      amount,
      line.name,
    ),
  );
  await batch(c.env.DB, statements);
  return await answer(c, sale.id);
});

/** A discount on the whole basket, spread across the lines by value. */
till.post("/discount", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);
  const amount = int(body, "amount");
  if (amount < 0) throw badRequest("bad_amount", "a discount cannot be negative");

  const approvedBy = await approvalFor(c.env.DB, actor, optStr(body, "manager_pin") || undefined);
  await batch(c.env.DB, [
    stmt(c.env.DB, "UPDATE sales SET basket_discount = ?2 WHERE id = ?1", sale.id, amount),
    stmt(
      c.env.DB,
      `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, 'basket_discount', 'sale', ?6, ?7, '')`,
      newId("aud"),
      now(),
      actor.userId,
      approvedBy,
      sale.register_id,
      sale.id,
      amount,
    ),
  ]);
  return await answer(c, sale.id);
});

till.post("/customer", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);
  const customerId = optStr(body, "customer_id");
  await run(
    c.env.DB,
    "UPDATE sales SET customer_id = ?2 WHERE id = ?1",
    sale.id,
    customerId.length > 0 ? customerId : null,
  );
  return await answer(c, sale.id);
});

// ---------------------------------------------------------------------------
// Holding and recalling
// ---------------------------------------------------------------------------

till.post("/hold", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);

  const label = str(body, "label").trim();
  if (label.length === 0) throw badRequest("bad_label", "a parked basket needs a name to find it by");

  const count = await one<{ n: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ?1",
    sale.id,
  );
  if ((count?.n ?? 0) === 0) throw badRequest("empty", "there is nothing to hold");

  // Labelling the active basket is what parks it: the lane's next scan finds no
  // unlabelled held row and starts a fresh one. Hold and recall are the same
  // mechanism read in two directions.
  await run(c.env.DB, "UPDATE sales SET hold_label = ?2 WHERE id = ?1 AND status = 'held'", sale.id, label);
  const fresh = await activeBasket(c.env.DB, actor);
  return c.json(await basketView(c.env.DB, actor, fresh));
});

till.get("/held", async (c) => {
  const registerId = laneOf(c.get("actor"));
  const rows = await all<{
    id: string;
    hold_label: string;
    total: number;
    created_at: number;
    items: number;
    customer: string | null;
  }>(
    c.env.DB,
    `SELECT s.id, s.hold_label, s.total, s.created_at,
            (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items,
            c.name AS customer
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.register_id = ?1 AND s.status = 'held' AND s.hold_label <> ''
      ORDER BY s.created_at DESC`,
    registerId,
  );
  return c.json({ held: rows });
});

/**
 * Pick a parked basket back up.
 *
 * The lane's current basket is parked first if it has anything in it, so
 * recalling never discards what the operator was in the middle of. An empty
 * one is deleted rather than parked — a lane should not accumulate empty rows
 * because somebody pressed Held to look.
 */
till.post("/held/:id/recall", async (c) => {
  const actor = c.get("actor");
  const registerId = laneOf(actor);
  const wanted = c.req.param("id");

  const target = await need<SaleRow>(
    c.env.DB,
    "that parked basket",
    "SELECT * FROM sales WHERE id = ?1 AND register_id = ?2 AND status = 'held' AND hold_label <> ''",
    wanted,
    registerId,
  );

  const current = await one<SaleRow>(
    c.env.DB,
    "SELECT * FROM sales WHERE register_id = ?1 AND status = 'held' AND hold_label = ''",
    registerId,
  );
  const statements: D1PreparedStatement[] = [];
  if (current) {
    const count = await one<{ n: number }>(
      c.env.DB,
      "SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ?1",
      current.id,
    );
    if ((count?.n ?? 0) > 0) {
      statements.push(
        stmt(
          c.env.DB,
          "UPDATE sales SET hold_label = ?2 WHERE id = ?1",
          current.id,
          `Parked ${new Date().toISOString().slice(11, 16)}`,
        ),
      );
    } else {
      statements.push(stmt(c.env.DB, "DELETE FROM sales WHERE id = ?1", current.id));
    }
  }
  statements.push(
    stmt(
      c.env.DB,
      "UPDATE sales SET hold_label = '' WHERE id = ?1 AND status = 'held'",
      target.id,
    ),
  );
  await batch(c.env.DB, statements);
  return await answer(c, target.id);
});

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

till.post("/void", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const reason = str(body, "reason").trim();
  if (reason.length === 0) throw badRequest("bad_reason", "voiding a sale needs a reason");

  requireManagerSession(actor, "voiding a sale");
  const sale = await activeBasket(c.env.DB, actor);
  mustBeHeld(sale);
  const approvedBy = actor.userId;

  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      "UPDATE sales SET status = 'voided', void_reason = ?2 WHERE id = ?1 AND status = 'held'",
      sale.id,
      reason,
    ),
    stmt(
      c.env.DB,
      `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, 'void_sale', 'sale', ?6, ?7, ?8)`,
      newId("aud"),
      now(),
      actor.userId,
      approvedBy,
      sale.register_id,
      sale.id,
      sale.total,
      reason,
    ),
  ]);
  const fresh = await activeBasket(c.env.DB, actor);
  return c.json(await basketView(c.env.DB, actor, fresh));
});

// ---------------------------------------------------------------------------
// Taking payment
// ---------------------------------------------------------------------------

type TenderIn = { method: string; amount: number; tendered?: number; reference?: string };

const TENDERS = ["cash", "card", "wallet", "store_credit", "on_account"] as const;

/**
 * Finish the sale.
 *
 * Two rules about tenders, and both are refusals rather than corrections:
 *
 *   * **Only cash returns change.** A card or a wallet charged more than the
 *     balance due is an overcharge, so the till refuses it instead of quietly
 *     making change from a card.
 *   * **The payments must cover the total.** Short payment is still not a
 *     partial sale: a basket that is not fully tendered stays held.
 *
 * Paying later does not bend the second rule, it uses it. `on_account` is a
 * tender like any other — it settles the part of the basket the customer is
 * not paying for now, so a tab and a half-paid tab are the same arithmetic as
 * a split between cash and a card, and every figure downstream still adds up.
 * What it tenders is not money: the goods leave and the shop books what it is
 * owed, against the customer's limit and nobody else's.
 *
 * The barrier against ringing twice is the state itself: the UPDATE requires
 * the sale to still be `held`, so a double-tapped Pay button and a replayed
 * offline request both find it already completed and get the same sale back
 * rather than a second one.
 */
/**
 * What a sale looks like on the way back out, for a call that has already been
 * answered once. The change comes from the payments rather than from the
 * request, because on a replay there is no request left to compute it from.
 */
async function payAnswer(db: D1Database, sale: SaleRow) {
  const paid = await one<{ change: number; on_account: number }>(
    db,
    `SELECT COALESCE(SUM(change), 0) AS change,
            COALESCE(SUM(CASE WHEN method = 'on_account' THEN amount ELSE 0 END), 0) AS on_account
       FROM payments WHERE sale_id = ?1`,
    sale.id,
  );
  return {
    sale_id: sale.id,
    number: sale.number,
    total: sale.total,
    change: paid?.change ?? 0,
    // What went on the tab, read back rather than remembered. A receipt that
    // says "K3,000 to pay" has to say the same thing on the retry as it did on
    // the call that was lost, and the only figure that can is the one in the
    // rows.
    on_account: paid?.on_account ?? 0,
    completed_at: sale.completed_at,
    replayed: true,
  };
}

till.post("/pay", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");

  // **The idempotency key is the barrier, and nothing runs before it.**
  //
  // `sales.client_id` was written and never read — a write-only key, which is
  // no key at all. The `status = 'held'` claim below catches a *simultaneous*
  // double-tap, but not the case the key exists for: the sale completes, the
  // answer is lost on the way back, and the cashier presses Pay again. By then
  // the sale is no longer held, so `activeBasket` opened a brand-new empty
  // basket and the call died with "there is nothing to pay for" — no receipt
  // number, no change figure, and nothing to say sale 412 existed. The cashier
  // rings the basket again, and the shop has two sales, stock down twice for
  // goods that left once, and a drawer that comes up a full basket short at
  // close, booked as a loss against the cashier.
  //
  // Checked before `activeBasket` so the retry does not leave an empty basket
  // behind it either.
  const clientId = optStr(body, "client_id") || null;
  if (clientId) {
    const already = await one<SaleRow>(
      c.env.DB,
      "SELECT * FROM sales WHERE client_id = ?1",
      clientId,
    );
    if (already) return c.json(await payAnswer(c.env.DB, already));
  }

  const sale = await activeBasket(c.env.DB, actor);

  const raw = (body as { payments?: unknown }).payments;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest("no_payment", "say how the customer is paying");
  }
  const tenders: TenderIn[] = raw.map((t) => {
    const method = oneOf(t, "method", TENDERS);
    const amount = int(t, "amount");
    if (amount <= 0) throw badRequest("bad_amount", "a payment has to be more than nothing");
    return { method, amount, tendered: (t as TenderIn).tendered, reference: (t as TenderIn).reference };
  });

  const settings = await readSettings(c.env.DB);
  const taxInclusive = settingBool(settings, "tax.inclusive", true);
  const at = now();
  const lines = await linesOf(c.env.DB, sale.id);
  if (lines.length === 0) throw badRequest("empty", "there is nothing to pay for");

  const unchecked = lines.find((l) => l.min_age > 0 && l.age_checked !== 1);
  if (unchecked) {
    throw conflict("age_check_required", `${unchecked.name} needs ID before it can be sold`, {
      line_id: unchecked.id,
      min_age: unchecked.min_age,
    });
  }

  const priced = priceSale(lines, await livePromotions(c.env.DB, at), sale.basket_discount, taxInclusive, at);
  const total = priced.totals.total;

  const paid = tenders.reduce((a, t) => a + t.amount, 0);
  if (paid < total) {
    throw conflict("short", `that is ${total - paid} short of the total`, { due: total - paid });
  }
  const overpaid = paid - total;
  if (overpaid > 0) {
    const cash = tenders.filter((t) => t.method === "cash");
    const cashPaid = cash.reduce((a, t) => a + t.amount, 0);
    if (cashPaid < overpaid) {
      throw badRequest(
        "no_change_from_card",
        "only cash can produce change — a card cannot be charged more than the amount due",
      );
    }
  }

  // Store credit has to exist before it can be spent, and it has to come *off*
  // the customer when it is.
  //
  // It was accepted as a tender and never drawn down: the same 5,000 of credit
  // could buy 5,000 of goods over and over, and a basket with no customer at
  // all could be settled entirely in store credit against a balance that did
  // not exist. The decrement below is conditional on the balance still being
  // there, so two lanes spending it at once cannot both win.
  const onCredit = tenders
    .filter((t) => t.method === "store_credit")
    .reduce((a, t) => a + t.amount, 0);
  if (onCredit > 0) {
    if (!sale.customer_id) {
      throw badRequest("no_customer", "store credit needs a customer on the sale");
    }
    const held = await one<{ credit: number }>(
      c.env.DB,
      "SELECT credit FROM customers WHERE id = ?1",
      sale.customer_id,
    );
    if (!held || held.credit < onCredit) {
      throw conflict("not_enough_credit", "that is more store credit than they have", {
        available: held?.credit ?? 0,
      });
    }
  }

  // **The tab, and the limit that bounds it.**
  //
  // Credit is a decision about a person, so it needs a person: a walk-in basket
  // has nobody to chase and nobody to refuse, and `customers.credit_limit`
  // defaults to 0 so a customer nobody has decided about is refused here too.
  //
  // The limit is checked by the write that takes it rather than by a read
  // before one. D1 has no interactive transaction, so `SELECT owed` followed by
  // `UPDATE owed = owed + x` is a race two lanes can both win — and both would,
  // against a customer standing at one of them with a queue at the other. This
  // is the same conditional-write shape as the store-credit drawdown below it,
  // read in the other direction.
  //
  // It runs **alone and before the sale is claimed**, because a statement that
  // matches no rows is a success in SQLite and cannot abort a batch. Batched
  // with the consequences it would refuse nothing: the sale would complete, the
  // stock would go down and the journal would take a posting, and the 409 would
  // be raised over work that had already committed.
  const onAccount = tenders
    .filter((t) => t.method === "on_account")
    .reduce((a, t) => a + t.amount, 0);
  if (onAccount > 0) {
    if (!sale.customer_id) {
      throw badRequest("no_customer", "a tab needs a customer — put one on the sale first");
    }
    const took = await run(
      c.env.DB,
      "UPDATE customers SET owed = owed + ?2 WHERE id = ?1 AND owed + ?2 <= credit_limit",
      sale.customer_id,
      onAccount,
    );
    if (took.meta.changes === 0) {
      // Read only now, and only to write the sentence. The decision was taken
      // by the statement above; this says how much room there actually is so
      // the cashier can offer to split the basket rather than guess.
      const who = await one<{ owed: number; credit_limit: number }>(
        c.env.DB,
        "SELECT owed, credit_limit FROM customers WHERE id = ?1",
        sale.customer_id,
      );
      const room = Math.max(0, (who?.credit_limit ?? 0) - (who?.owed ?? 0));
      throw conflict("over_credit_limit", "that is more than this customer may owe", {
        owed: who?.owed ?? 0,
        credit_limit: who?.credit_limit ?? 0,
        available: room,
      });
    }
  }

  // **Everything from here to the batch has to give the tab back if it throws.**
  //
  // The claim above is the only piece of this call that commits before the sale
  // is won, and `sales.client_id` — the idempotency key the retry is recognised
  // by — is not written until the sale claim itself. So a failure in between
  // leaves `owed` raised against a sale that never completed, and an honest
  // retry with the same key finds no sale, runs the whole flow again, and
  // raises it a second time: the customer is chased for twice what they took
  // and half their limit is consumed by nothing.
  //
  // `nextNumber` throws when its counter row is missing, the batch throws on
  // any constraint or a posting into a closed period, and the sale claim can
  // lose. All three now land here.
  try {
    return await completeSale(c, {
      sale, tenders, priced, clientId, onAccount, onCredit, overpaid, settings, at, actor,
    });
  } catch (err) {
    // **Put the sale back before the tab, and only give the tab back if the
    // sale went back.**
    //
    // The claim inside `completeSale` wins the sale on its own, before the
    // batch that writes everything the sale means. So a throw can land on
    // either side of it, and the two sides need opposite treatment:
    //
    //   * **Before**, the sale is still held and the tab has to come off.
    //   * **After**, the sale row is `completed` while the payments, the stock
    //     movements and the journal entry all rolled back with the batch. That
    //     is a sale with no tender behind it, and every takings figure in the
    //     system is `SUM(sales.total)` over completed sales — the overview, the
    //     lane cards, the shift, four reports — so it inflates all of them by a
    //     basket the ledger has never heard of, and the accounting equation
    //     still holds *because* nothing was posted. Nothing would flag it.
    //
    // A completed sale with no payments can only be that, because `/pay`
    // refuses a tender list that does not cover the total and every tender is
    // more than nothing. So it is safe to hand it back to the lane, and the
    // cashier rings it again. The receipt number is spent either way, which is
    // what a gap in a receipt sequence is for.
    //
    // The tab then comes off only if the sale really did go back — otherwise a
    // throw *after* a batch that succeeded would cancel a debt the shop is owed.
    const torn = await run(
      c.env.DB,
      `UPDATE sales SET status = 'held', completed_at = NULL, number = NULL,
                        shift_id = NULL, client_id = NULL
        WHERE id = ?1 AND status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = ?1)`,
      sale.id,
    );
    if (onAccount > 0 && sale.customer_id) {
      await run(
        c.env.DB,
        `UPDATE customers SET owed = owed - ?2
          WHERE id = ?1 AND owed >= ?2
            AND EXISTS (SELECT 1 FROM sales s WHERE s.id = ?3 AND s.status = 'held')`,
        sale.customer_id,
        onAccount,
        sale.id,
      );
    }
    if (torn.meta.changes > 0) {
      console.error("a sale was claimed and then rolled back", sale.id);
    }
    throw err;
  }
});

/**
 * The half of `POST /pay` that runs once the tab has been claimed.
 *
 * Split out so the claim has something to wrap. Everything in here either
 * completes the sale or throws, and a throw is the caller's signal to give the
 * customer's credit back.
 */
async function completeSale(
  c: Context<Ctx>,
  p: {
    sale: SaleRow;
    tenders: TenderIn[];
    priced: ReturnType<typeof priceSale>;
    clientId: string | null;
    /** What went on the customer's tab, already claimed against their limit. */
    onAccount: number;
    /** What is being spent from store credit, already checked as available. */
    onCredit: number;
    overpaid: number;
    settings: Settings;
    at: number;
    actor: Actor;
  },
) {
  const { sale, tenders, priced, clientId, onAccount, onCredit, overpaid, settings, at, actor } = p;
  const total = priced.totals.total;

  const shiftId = await openShift(c.env.DB, laneOf(actor));
  const number = await nextNumber(c.env.DB, "sale_number");

  // **Claim the sale first, and check the claim.**
  //
  // This UPDATE is the barrier against ringing twice, and its result used to be
  // discarded: everything else — the payments, the stock, the loyalty points,
  // the journal — went into the same batch unconditionally, so a double-tapped
  // Pay or a replayed offline request wrote every side effect a second time
  // while the sale row itself matched nothing. Stock went down twice for one
  // basket and the drawer was credited twice.
  //
  // Taken on its own it is a compare-and-set: whoever flips `held` to
  // `completed` owns the sale, and everybody else finds it already rung and
  // gets the same answer back rather than a second set of consequences.
  const claimed = await run(
    c.env.DB,
    `UPDATE sales SET status = 'completed', completed_at = ?2, number = ?3, shift_id = ?4,
                      client_id = COALESCE(client_id, ?5)
      WHERE id = ?1 AND status = 'held'`,
    sale.id,
    at,
    number,
    shiftId,
    clientId,
  );
  if (claimed.meta.changes === 0) {
    // Somebody — probably this same till, retrying — already rang it. Answer
    // with the sale as it stands; a replay must not be a second sale.
    //
    // **Give the tab back first.** The credit claim above is the one piece of
    // this call that lands before the sale is won, because it has to: a limit
    // enforced after the sale is a limit that refuses nothing. So the loser of
    // a simultaneous double-tap has already put the basket on the customer's
    // account, and the winner is about to put it there again. Without this the
    // customer is charged twice for shopping that left the shop once, their
    // remaining credit is short by a basket, and there is no row anywhere
    // saying why — `owed` would disagree with the payments that are supposed to
    // explain it, which is precisely the property that makes it trustworthy.
    if (onAccount > 0 && sale.customer_id) {
      await run(
        c.env.DB,
        "UPDATE customers SET owed = owed - ?2 WHERE id = ?1",
        sale.customer_id,
        onAccount,
      );
    }
    const already = await need<SaleRow>(
      c.env.DB,
      "that sale",
      "SELECT * FROM sales WHERE id = ?1",
      sale.id,
    );
    return c.json(await payAnswer(c.env.DB, already));
  }

  const statements: D1PreparedStatement[] = [];
  statements.push(...writeBack(c.env.DB, sale.id, priced));
  if (onCredit > 0) {
    statements.push(
      stmt(
        c.env.DB,
        "UPDATE customers SET credit = credit - ?2 WHERE id = ?1 AND credit >= ?2",
        sale.customer_id,
        onCredit,
      ),
    );
  }

  // Change comes off the last cash tender, so the drawer is credited what was
  // actually put in it rather than what was handed over.
  //
  // `credited` is that same figure, kept for the ledger. Posting the *gross*
  // tendered instead is a real bug this had: a sale settled with more cash than
  // it was worth booked the whole note as revenue and the entry came out over
  // by the change — which `post` refused, so the sale failed rather than
  // silently minting money. That refusal is the ledger doing its job.
  const credited: { method: string; amount: number }[] = [];
  let changeLeft = overpaid;
  for (const t of [...tenders].reverse()) {
    let change = 0;
    if (t.method === "cash" && changeLeft > 0) {
      change = Math.min(changeLeft, t.amount);
      changeLeft -= change;
    }
    credited.push({ method: t.method, amount: t.amount - change });
    statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO payments (id, sale_id, method, amount, tendered, change, reference, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        newId("pay"),
        sale.id,
        t.method,
        t.amount - change,
        t.tendered ?? t.amount,
        change,
        t.reference ?? "",
        at,
      ),
    );
  }

  let cost = 0;
  for (const line of priced.lines) {
    cost += extend(line.qty, line.cost);
    statements.push(
      stmt(
        c.env.DB,
        "UPDATE products SET stock = stock - ?2 WHERE id = ?1",
        line.product_id,
        line.qty,
      ),
    );
    statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO stock_movements (id, product_id, qty_delta, reason, ref_type, ref_id, unit_cost, user_id, created_at)
         VALUES (?1, ?2, ?3, 'sale', 'sale', ?4, ?5, ?6, ?7)`,
        newId("sm"),
        line.product_id,
        -line.qty,
        sale.id,
        line.cost,
        actor.userId,
        at,
      ),
    );
  }

  // A tab is an authorisation, so it is written where the authorisations are.
  //
  // The back office reads `audit_log` as "what was authorised at the till", and
  // letting stock leave against a promise is exactly the kind of decision that
  // belongs in it — not because the cashier needed a manager for it (the limit
  // is the control, and it is enforced above) but because a debt that appears
  // on a customer's account should be traceable to the moment and the person
  // who allowed it.
  if (onAccount > 0) {
    statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
         VALUES (?1, ?2, ?3, ?3, ?4, 'sell_on_account', 'sale', ?5, ?6, ?7)`,
        newId("aud"),
        at,
        actor.userId,
        sale.register_id,
        sale.id,
        onAccount,
        sale.customer_id ?? "",
      ),
    );
  }

  // Points are earned on the shopping, not on the settling.
  //
  // A decided policy rather than an oversight: a customer who takes goods on
  // their tab has bought them, and the loyalty scheme is a discount on what
  // they buy. Awarding on payment instead would mean a shopper who always pays
  // cash and one who always pays on Friday earn differently for the same
  // basket, and it would need a second award path down the settlement route
  // that nothing would reconcile. The exposure is bounded by the credit limit,
  // which is what the limit is for.
  if (sale.customer_id) {
    const perUnit = Number(settings["loyalty.points_per_unit"] ?? "0");
    if (perUnit > 0) {
      statements.push(
        stmt(
          c.env.DB,
          "UPDATE customers SET points = points + ?2 WHERE id = ?1",
          sale.customer_id,
          Math.floor(total * perUnit),
        ),
      );
    }
  }

  if (settingBool(settings, "accounting.enabled", false)) {
    statements.push(
      ...post(
        c.env.DB,
        saleEntry({
          saleId: sale.id,
          at,
          net: total - priced.totals.tax,
          tax: priced.totals.tax,
          discount: priced.totals.discount + priced.totals.promoSaved,
          cost,
          payments: credited,
          userId: actor.userId,
        }),
      ),
    );
  }

  await batch(c.env.DB, statements);

  const finished = await need<SaleRow>(
    c.env.DB,
    "that sale",
    "SELECT * FROM sales WHERE id = ?1",
    sale.id,
  );
  return c.json({
    sale_id: finished.id,
    number: finished.number,
    total: finished.total,
    change: overpaid,
    on_account: onAccount,
    completed_at: finished.completed_at,
  });
}

// ---------------------------------------------------------------------------
// The rest of the command bar
// ---------------------------------------------------------------------------

/**
 * Open the drawer without a sale.
 *
 * A manager-only command, and one that exists to be *logged*: the drawer coming
 * open outside a transaction is the single most useful line in an audit trail,
 * so this writes to `audit_log` against the shift and refuses when there is no
 * shift to write it against.
 */
till.post("/no-sale", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  requireManagerSession(actor, "opening the drawer");
  const registerId = laneOf(actor);
  const reason = str(body, "reason").trim();
  if (reason.length === 0) throw badRequest("bad_reason", "say why the drawer is being opened");

  const shiftId = await openShift(c.env.DB, registerId);
  if (!shiftId) throw conflict("no_shift", "open a drawer before opening the drawer");

  const approvedBy = actor.userId;

  await run(
    c.env.DB,
    `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, 'no_sale', 'shift', ?6, ?7)`,
    newId("aud"),
    now(),
    actor.userId,
    approvedBy,
    registerId,
    shiftId,
    reason,
  );
  return c.json({ ok: true, opened: true });
});

/**
 * Find a receipt to return against.
 *
 * The till needs this and the back office's `/sales` is manager-only, so it is
 * here — scoped to completed sales and to a receipt number or a recent one,
 * which is what a customer at the counter can actually produce.
 */
till.get("/receipts", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const binds: unknown[] = [];
  let where = "s.status = 'completed'";
  if (q.length > 0) {
    binds.push(`%${q}%`);
    where += ` AND CAST(s.number AS TEXT) LIKE ?${binds.length}`;
  }
  const rows = await all(
    c.env.DB,
    `SELECT s.id, s.number, s.total, s.completed_at, u.name AS cashier,
            (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items
       FROM sales s JOIN users u ON u.id = s.user_id
      WHERE ${where}
      ORDER BY s.completed_at DESC LIMIT 20`,
    ...binds,
  );
  return c.json({ receipts: rows });
});

/** One receipt, with what is still returnable on each line. */
till.get("/receipts/:id", async (c) => {
  const id = c.req.param("id");
  const sale = await need(
    c.env.DB,
    "that receipt",
    `SELECT s.id, s.number, s.total, s.completed_at, u.name AS cashier
       FROM sales s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?1 AND s.status = 'completed'`,
    id,
  );
  const lines = await all(
    c.env.DB,
    `SELECT i.id, i.name, i.qty, i.total, i.unit_price,
            i.qty - COALESCE((SELECT SUM(r.qty) FROM refund_items r WHERE r.sale_item_id = i.id), 0)
              AS returnable
       FROM sale_items i WHERE i.sale_id = ?1 ORDER BY i.sort, i.rowid`,
    id,
  );
  return c.json({ sale, lines });
});

/**
 * A return, taken at the lane.
 *
 * The same barrier as the back office's refund — the units must still be
 * unrefunded, checked in the statement that writes them — with a manager's PIN
 * in front of it, because Return is the "PIN" row of the command matrix.
 */
till.post("/return", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const registerId = laneOf(actor);
  const saleId = str(body, "sale_id");
  const reason = str(body, "reason").trim();
  if (reason.length === 0) throw badRequest("bad_reason", "a return needs a reason");

  const approvedBy = await approvalFor(c.env.DB, actor, optStr(body, "manager_pin") || undefined);

  const wanted = (body as { lines?: unknown }).lines;
  if (!Array.isArray(wanted) || wanted.length === 0) {
    throw badRequest("no_lines", "say which lines are coming back");
  }

  const sale = await need<{ id: string; status: string }>(
    c.env.DB,
    "that sale",
    "SELECT id, status FROM sales WHERE id = ?1",
    saleId,
  );
  if (sale.status !== "completed") throw conflict("not_refundable", "only a completed sale can be returned");

  // **Goods bought on a tab go back onto the tab, and the lane does not ask.**
  //
  // A cashier pressing Return has one question in front of them — which units
  // are coming back — and "is this customer still paying this sale off" is not
  // a thing they should have to remember at a counter. `applyRefund` reads the
  // rows and splits it: anything still outstanding comes off the debt, and only
  // the remainder is counted out of this drawer.
  const settings = await readSettings(c.env.DB);
  const result = await applyRefund(c.env.DB, {
    saleId,
    wanted: wanted.map((entry) => ({
      sale_item_id: str(entry, "sale_item_id"),
      qty: num(entry, "qty"),
    })),
    reason,
    method: "cash",
    restock: true,
    userId: actor.userId,
    approvedBy,
    // The lane pays it out of its own drawer, and it is the *open* shift that
    // has to carry it — the one whose count the money is about to be missing
    // from — never the shift the sale was rung on.
    shiftId: await openShift(c.env.DB, registerId),
    registerId,
    cashFrom: "drawer",
    clientId: optStr(body, "client_id") || null,
    at: now(),
    accounting: settingBool(settings, "accounting.enabled", false),
    action: "return",
  });
  return c.json(result, 201);
});

/** Customers, for attaching one to a basket at the lane. */
till.get("/customers", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const binds: unknown[] = [];
  let where = "";
  if (q.length > 0) {
    binds.push(`%${q}%`);
    where = "WHERE name LIKE ?1 OR phone LIKE ?1";
  }
  const rows = await all(
    c.env.DB,
    // `owed` and `credit_limit` come with the row because the lane cannot
    // decide without them. "Can this basket go on the tab" is a question asked
    // at the counter with somebody waiting, and a till that has to make a
    // second request to answer it is a till that asks the server what it
    // already showed the cashier.
    `SELECT id, name, phone, points, credit, credit_limit, owed
       FROM customers ${where} ORDER BY name LIMIT 25`,
    ...binds,
  );
  return c.json({ customers: rows });
});


/**
 * Money off a tab, taken at the counter.
 *
 * This is where a corner shop's credit actually comes back: somebody who took
 * their shopping on Tuesday puts notes on the counter on Friday. It is not a
 * sale — no goods move, no revenue is earned, nothing is priced — so it is not
 * rung through the basket. It is money arriving against a debt.
 *
 * The cash goes into **this lane's drawer**, which is why the lane's open shift
 * is stamped on it: that drawer is counted at the end of the shift, and cash
 * the count does not know about is a surplus booked to cash over and short
 * against whoever was standing there.
 */
till.post("/account-payment", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const registerId = laneOf(actor);
  const customerId = str(body, "customer_id");
  const amount = int(body, "amount");
  const method = oneOf(body, "method", ["cash", "card", "wallet"] as const);

  // **A lane with no drawer open cannot take money.**
  //
  // `expectedInDrawer` finds a settlement by its `shift_id`, so one taken with
  // no shift is cash that physically went into a till and that no count will
  // ever expect. It stays in `1000 Cash in drawer` for good: every close sweeps
  // out only what was counted, so the account never returns to zero and the
  // balance sheet reports money in a drawer nobody has a session for. The same
  // refusal as No sale, for the same reason.
  const shiftId = await openShift(c.env.DB, registerId);
  if (!shiftId) throw conflict("no_shift", "open a drawer before taking money off a tab");

  const settings = await readSettings(c.env.DB);
  const settled = await settleTab(c.env.DB, {
    customerId,
    amount,
    method,
    reference: optStr(body, "reference"),
    note: optStr(body, "note"),
    userId: actor.userId,
    shiftId,
    registerId,
    cashTo: "drawer",
    clientId: optStr(body, "client_id") || null,
    at: now(),
    accounting: settingBool(settings, "accounting.enabled", false),
  });
  return c.json(settled);
});

/** A new customer, signed up at the counter. */
till.post("/customers", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = newId("cus");
  await run(
    c.env.DB,
    `INSERT INTO customers (id, name, phone, points, credit, note, created_at)
     VALUES (?1, ?2, ?3, 0, 0, '', ?4)`,
    id,
    str(body, "name"),
    optStr(body, "phone"),
    now(),
  );
  return c.json({ id }, 201);
});

/**
 * Count this lane's drawer and close it, from the till.
 *
 * The same close the back office does — the variance booked, the drawer swept
 * to the safe — with a manager's PIN in front of it, because Close lane is a
 * manager-only command. The operator is signed out afterwards: a closed drawer
 * with somebody still on the lane is a lane that looks open and cannot sell.
 */
till.post("/close-lane", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  requireManagerSession(actor, "closing a lane");
  const registerId = laneOf(actor);
  const counted = int(body, "counted_total");
  if (counted < 0) throw badRequest("bad_count", "a count cannot be negative");

  const approvedBy = actor.userId;

  const shiftId = await openShift(c.env.DB, registerId);
  if (!shiftId) throw conflict("no_shift", "this lane has no open drawer");

  const drawer = await expectedInDrawer(c.env.DB, shiftId);
  const variance = counted - drawer.expected;
  const at = now();

  // **Close the shift first, on its own, and check that this call is the one
  // that closed it.**
  //
  // Two managers pressing Close lane at the same moment both read an open
  // shift and both compute the same variance. The loser's UPDATE matches no
  // rows — which is a *success* in SQLite and cannot abort a batch — so
  // everything batched behind it committed anyway: a second variance and a
  // second sweep, leaving the drawer account negative by the whole shift's
  // takings and the safe overstated by the same amount, while the manager was
  // shown a 409 saying nothing had been written. Both entries balance on their
  // own, so the trial balance still summed to zero.
  //
  // The same shape as `shifts.ts`, which is where this door's twin already
  // got it right.
  const closed = await run(
    c.env.DB,
    `UPDATE shifts SET closed_at = ?2, closed_by = ?3, counted_total = ?4,
                       expected_total = ?5, variance = ?6, note = ?7
      WHERE id = ?1 AND closed_at IS NULL`,
    shiftId,
    at,
    approvedBy,
    counted,
    drawer.expected,
    variance,
    optStr(body, "note", "Closed at the lane"),
  );
  if (closed.meta.changes === 0) {
    throw conflict("already_closed", "that drawer has already been closed");
  }

  const statements: D1PreparedStatement[] = [
    stmt(
      c.env.DB,
      `INSERT INTO audit_log (id, at, user_id, approved_by, register_id, action, ref_type, ref_id, amount, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, 'close_lane', 'shift', ?6, ?7, 'counted close')`,
      newId("aud"),
      at,
      actor.userId,
      approvedBy,
      registerId,
      shiftId,
      variance,
    ),
  ];

  const settings = await readSettings(c.env.DB);
  if (settingBool(settings, "accounting.enabled", false)) {
    if (variance !== 0) {
      statements.push(
        ...post(c.env.DB, varianceEntry({ shiftId, at, variance, userId: approvedBy })),
      );
    }
    if (counted !== 0) {
      statements.push(
        ...post(c.env.DB, sweepEntry({ shiftId, at, amount: counted, userId: approvedBy })),
      );
    }
  }

  await batch(c.env.DB, statements);

  // Everybody on this lane is signed out — the next person opens a fresh
  // drawer, which is what closing one means.
  await run(c.env.DB, "DELETE FROM sessions WHERE register_id = ?1", registerId);
  return c.json({ ok: true, expected: drawer.expected, counted, variance });
});

// ---------------------------------------------------------------------------
// Looking things up
// ---------------------------------------------------------------------------

till.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length === 0) return c.json({ products: [] });
  const like = `%${q}%`;
  const rows = await all(
    c.env.DB,
    `SELECT p.id, p.sku, p.name, p.name_my, p.price, p.stock, p.min_age, p.unit,
            p.ask_price, p.photo_key
       FROM products p
      WHERE p.active = 1
        AND (p.name LIKE ?1 OR p.name_my LIKE ?1 OR p.sku LIKE ?1
             OR EXISTS (SELECT 1 FROM product_barcodes b
                         WHERE b.product_id = p.id AND b.barcode LIKE ?1))
      ORDER BY p.name
      LIMIT 40`,
    like,
  );
  return c.json({ products: rows });
});

/**
 * The Favourites grid and the category tabs behind it.
 *
 * One request rather than one per tab: a corner shop's catalogue is a few
 * hundred rows, and the till holding all of it is what makes a tap on a
 * category instant and a scan work with the network down.
 */
till.get("/grid", async (c) => {
  const categories = await all(
    c.env.DB,
    "SELECT id, name, name_my, sort FROM categories ORDER BY sort, name",
  );
  const products = await all(
    c.env.DB,
    `SELECT id, sku, name, name_my, category_id, price, stock, min_age, unit,
            ask_price, quick_key, photo_key
       FROM products WHERE active = 1 ORDER BY quick_key DESC, name`,
  );
  const at = now();
  const promotions = await livePromotions(c.env.DB, at);
  return c.json({ categories, products, promotions });
});

/** A price check: what one item costs right now, offer and all. */
till.get("/price/:code", async (c) => {
  const hit = await resolveScan(c.env.DB, c.req.param("code"));
  if (!hit) throw notFound("nothing is filed under that code");
  const at = now();
  const promotions = await livePromotions(c.env.DB, at);
  const product = await one<{ category_id: string | null }>(
    c.env.DB,
    "SELECT category_id FROM products WHERE id = ?1",
    hit.product.id,
  );
  const priced = priceSale(
    [
      {
        id: "probe",
        sale_id: "probe",
        product_id: hit.product.id,
        name: hit.product.name,
        sku: hit.product.sku,
        qty: hit.qty,
        unit_price: hit.product.price,
        list_price: hit.product.price,
        line_discount: 0,
        promo_id: null,
        promo_name: "",
        promo_saved: 0,
        price_override: 0,
        tax_bp: hit.product.tax_bp,
        tax: 0,
        total: 0,
        cost: hit.product.cost,
        min_age: hit.product.min_age,
        age_checked: 0,
        sort: 0,
        category_id: product?.category_id ?? null,
      },
    ],
    promotions,
    0,
    true,
    at,
  );
  const line = priced.lines[0]!;
  return c.json({
    product: {
      id: hit.product.id,
      name: hit.product.name,
      name_my: hit.product.name_my,
      sku: hit.product.sku,
      unit: hit.product.unit,
      stock: hit.product.stock,
      min_age: hit.product.min_age,
    },
    qty: hit.qty,
    list_price: hit.product.price,
    promo_name: line.promo_name,
    promo_saved: line.promo_saved,
    total: line.total,
  });
});
