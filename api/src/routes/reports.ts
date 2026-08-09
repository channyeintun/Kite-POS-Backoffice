import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { all, currencyOf, one, readSettings } from "../lib/db.js";
import { badRequest } from "../lib/http.js";
import { csvDoc, csvResponse, isoDay, isoStamp, plainAmount, plainNumber, preamble } from "../lib/csv.js";
import { expectedInDrawer } from "./shifts.js";

export const reports = new Hono<Ctx>();

/**
 * Reports, computed by the database.
 *
 * Every figure below is a `GROUP BY` rather than rows pulled across and added
 * up in this Worker. That is not a style preference on D1's free tier: rows
 * *read* are the metered quantity, so a month of takings summed here would cost
 * a few thousand row reads and summed there costs the same few thousand — but a
 * year of them is the difference between a report and a bill.
 */

/** The window, validated — see the note in `accounting.ts`. */
const window = (c: { req: { query: (k: string) => string | undefined } }) => {
  const to = Number(c.req.query("to") ?? String(now()));
  const from = Number(c.req.query("from") ?? String(to - 30 * 86400));
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw badRequest("bad_window", "that window is not a pair of times");
  }
  if (from > to) throw badRequest("bad_window", "that window ends before it starts");
  return { from, to };
};

/** The dashboard: today at a glance. */
reports.get("/overview", async (c) => {
  const startOfDay = Math.floor(now() / 86400) * 86400;

  const today = await one(
    c.env.DB,
    `SELECT COUNT(*) AS sales,
            COALESCE(SUM(total), 0) AS takings,
            COALESCE(SUM(tax), 0) AS tax,
            COALESCE(SUM(promo_saved + discount), 0) AS given_away
       FROM sales WHERE status = 'completed' AND completed_at >= ?1`,
    startOfDay,
  );

  const margin = await one(
    c.env.DB,
    `SELECT COALESCE(SUM(i.total - i.tax), 0) AS net,
            COALESCE(SUM(CAST(ROUND(i.qty * i.cost) AS INTEGER)), 0) AS cost
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'completed' AND s.completed_at >= ?1`,
    startOfDay,
  );

  const stock = await one(
    c.env.DB,
    `SELECT COALESCE(SUM(CAST(ROUND(stock * cost) AS INTEGER)), 0) AS at_cost,
            COUNT(*) AS skus,
            COALESCE(SUM(CASE WHEN reorder_point > 0 AND stock <= reorder_point THEN 1 ELSE 0 END), 0) AS low
       FROM products WHERE active = 1`,
  );

  const lanes = await all(
    c.env.DB,
    `SELECT r.id, r.name, r.kind,
            sh.id AS shift_id, sh.opening_float, sh.opened_at,
            u.name AS operator,
            COALESCE((SELECT SUM(s.total) FROM sales s
                       WHERE s.shift_id = sh.id AND s.status = 'completed'), 0) AS takings,
            COALESCE((SELECT COUNT(*) FROM sales s
                       WHERE s.shift_id = sh.id AND s.status = 'completed'), 0) AS sales
       FROM registers r
       LEFT JOIN shifts sh ON sh.register_id = r.id AND sh.closed_at IS NULL
       LEFT JOIN users u ON u.id = sh.user_id
      WHERE r.active = 1
      ORDER BY r.name`,
  );

  const topSellers = await all(
    c.env.DB,
    `SELECT i.product_id, i.name, SUM(i.qty) AS sold, SUM(i.total) AS revenue
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'completed' AND s.completed_at >= ?1
      GROUP BY i.product_id, i.name ORDER BY revenue DESC LIMIT 8`,
    now() - 7 * 86400,
  );

  const week = await all(
    c.env.DB,
    `SELECT DATE(completed_at, 'unixepoch') AS day,
            COUNT(*) AS sales, COALESCE(SUM(total), 0) AS takings
       FROM sales WHERE status = 'completed' AND completed_at >= ?1
      GROUP BY day ORDER BY day`,
    now() - 13 * 86400,
  );

  return c.json({ today, margin, stock, lanes, top_sellers: topSellers, fortnight: week });
});

/** Takings by day, with the shape of the trading week under it. */
reports.get("/sales", async (c) => {
  const { from, to } = window(c);
  const daily = await all(
    c.env.DB,
    `SELECT DATE(completed_at, 'unixepoch') AS day,
            COUNT(*) AS sales,
            COALESCE(SUM(total), 0) AS takings,
            COALESCE(SUM(tax), 0) AS tax,
            COALESCE(SUM(promo_saved + discount), 0) AS given_away
       FROM sales WHERE status = 'completed' AND completed_at BETWEEN ?1 AND ?2
      GROUP BY day ORDER BY day`,
    from,
    to,
  );
  const hourly = await all(
    c.env.DB,
    `SELECT CAST(STRFTIME('%H', completed_at, 'unixepoch') AS INTEGER) AS hour,
            COUNT(*) AS sales, COALESCE(SUM(total), 0) AS takings
       FROM sales WHERE status = 'completed' AND completed_at BETWEEN ?1 AND ?2
      GROUP BY hour ORDER BY hour`,
    from,
    to,
  );
  const tenders = await all(
    c.env.DB,
    `SELECT p.method, COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
      GROUP BY p.method ORDER BY amount DESC`,
    from,
    to,
  );
  const staff = await all(
    c.env.DB,
    `SELECT u.name, COUNT(*) AS sales, COALESCE(SUM(s.total), 0) AS takings
       FROM sales s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
      GROUP BY u.id, u.name ORDER BY takings DESC`,
    from,
    to,
  );
  return c.json({ from, to, daily, hourly, tenders, staff });
});

/**
 * Products, ranked — and by margin as well as by revenue.
 *
 * Ranking by revenue alone is how a shop ends up with a bestseller it loses
 * money on. `margin` here is what the line actually earned: what was charged,
 * less the tax that was never the shop's, less what the goods cost.
 */
reports.get("/products", async (c) => {
  const { from, to } = window(c);
  const rows = await all(
    c.env.DB,
    `SELECT i.product_id, i.name, i.sku,
            SUM(i.qty) AS sold,
            SUM(i.total) AS revenue,
            SUM(i.tax) AS tax,
            SUM(CAST(ROUND(i.qty * i.cost) AS INTEGER)) AS cost,
            SUM(i.total - i.tax - CAST(ROUND(i.qty * i.cost) AS INTEGER)) AS margin,
            SUM(i.promo_saved) AS promo_saved
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
      GROUP BY i.product_id, i.name, i.sku
      ORDER BY revenue DESC LIMIT 200`,
    from,
    to,
  );
  const categories = await all(
    c.env.DB,
    `SELECT COALESCE(c.name, 'Uncategorised') AS category,
            SUM(i.qty) AS sold, SUM(i.total) AS revenue,
            SUM(i.total - i.tax - CAST(ROUND(i.qty * i.cost) AS INTEGER)) AS margin
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
       LEFT JOIN products p ON p.id = i.product_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
      GROUP BY category ORDER BY revenue DESC`,
    from,
    to,
  );
  return c.json({ from, to, products: rows, categories });
});

/** Where the shrinkage went: waste, counts, and refunds that were not restocked. */
reports.get("/shrinkage", async (c) => {
  const { from, to } = window(c);
  const rows = await all(
    c.env.DB,
    `SELECT m.reason, COUNT(*) AS movements,
            SUM(m.qty_delta) AS units,
            SUM(CAST(ROUND(m.qty_delta * m.unit_cost) AS INTEGER)) AS value
       FROM stock_movements m
      WHERE m.reason IN ('waste', 'count', 'adjust') AND m.created_at BETWEEN ?1 AND ?2
      GROUP BY m.reason`,
    from,
    to,
  );
  const worst = await all(
    c.env.DB,
    `SELECT p.name, p.sku, SUM(m.qty_delta) AS units,
            SUM(CAST(ROUND(m.qty_delta * m.unit_cost) AS INTEGER)) AS value
       FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.reason IN ('waste', 'count', 'adjust') AND m.created_at BETWEEN ?1 AND ?2
        AND m.qty_delta < 0
      GROUP BY p.id, p.name, p.sku ORDER BY value LIMIT 20`,
    from,
    to,
  );
  return c.json({ from, to, by_reason: rows, worst });
});

/**
 * Tax collected, by rate.
 *
 * The one report a VAT return is actually made from, and the shop had none.
 * Grouped by the rate **as it was on the line** rather than as the product
 * carries it today: a rate change must not retroactively re-band a sale that
 * was rung under the old one, and `sale_items.tax_bp` is the snapshot that
 * makes that true.
 *
 * `net` is what the shop earned, `tax` is what it is holding for the revenue
 * office, and `gross` is what the customer paid. They are reported separately
 * because only the middle one is owed.
 */
reports.get("/tax", async (c) => {
  const { from, to } = window(c);
  const rows = await all<{ tax_bp: number; net: number; tax: number; gross: number; sales: number }>(
    c.env.DB,
    `SELECT i.tax_bp,
            COALESCE(SUM(i.total - i.tax), 0) AS net,
            COALESCE(SUM(i.tax), 0) AS tax,
            COALESCE(SUM(i.total), 0) AS gross,
            COUNT(DISTINCT i.sale_id) AS sales
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
      GROUP BY i.tax_bp ORDER BY i.tax_bp`,
    from,
    to,
  );
  return c.json({
    from,
    to,
    rates: rows,
    net: rows.reduce((a, r) => a + r.net, 0),
    tax: rows.reduce((a, r) => a + r.tax, 0),
    gross: rows.reduce((a, r) => a + r.gross, 0),
  });
});

/**
 * What is on the shelf and what it is worth, product by product.
 *
 * At cost and at retail, because the two answer different questions: cost is
 * what the shop has tied up, retail is what it stands to take. Neither is a
 * window figure — this is a photograph of now, whatever range is asked for,
 * and the export says so on the face of the file rather than leaving somebody
 * to wonder why last month's valuation looks like today's.
 */
reports.get("/inventory", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT p.sku, p.name, COALESCE(c.name, '') AS category, p.stock, p.unit,
            p.cost, p.price,
            CAST(ROUND(p.stock * p.cost) AS INTEGER) AS at_cost,
            CAST(ROUND(p.stock * p.price) AS INTEGER) AS at_retail
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = 1 ORDER BY p.name`,
  );
  return c.json({ products: rows });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const REPORTS = [
  "products", "categories", "sales", "tenders", "staff",
  "shrinkage", "tax", "inventory", "shifts", "expenses",
] as const;

/**
 * The operational reports as files.
 *
 * Same contract as the accounting export: one route, a named `report`, a
 * refusal rather than a fallback. The window is honoured everywhere it means
 * something — and where it does not, the file says so in a row rather than
 * ignoring the range in silence.
 */
reports.get("/export", async (c) => {
  const report = (c.req.query("report") ?? "").trim();
  if (!(REPORTS as readonly string[]).includes(report)) {
    throw badRequest("bad_report", `no such report: ${report}`, { reports: REPORTS });
  }
  const { from, to } = window(c);
  const currency = currencyOf(await readSettings(c.env.DB));
  const money = (v: number) => plainAmount(v ?? 0, currency);
  const rows: string[][] = preamble(report, from, to);

  if (report === "products" || report === "categories") {
    const LIMIT = 1000;
    if (report === "products") {
      const products = await all<{
        name: string; sku: string; sold: number; revenue: number; tax: number;
        cost: number; margin: number; promo_saved: number;
      }>(
        c.env.DB,
        `SELECT i.name, i.sku, SUM(i.qty) AS sold, SUM(i.total) AS revenue, SUM(i.tax) AS tax,
                SUM(CAST(ROUND(i.qty * i.cost) AS INTEGER)) AS cost,
                SUM(i.total - i.tax - CAST(ROUND(i.qty * i.cost) AS INTEGER)) AS margin,
                SUM(i.promo_saved) AS promo_saved
           FROM sale_items i JOIN sales s ON s.id = i.sale_id
          WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
          GROUP BY i.product_id, i.name, i.sku
          ORDER BY revenue DESC LIMIT ${LIMIT}`,
        from,
        to,
      );
      // The share is over what is in the file. Computing it over a truncated
      // set and printing it as a share of everything is a quiet lie, so when
      // the cap bites the file says which it is.
      const total = products.reduce((a, r) => a + r.revenue, 0);
      rows.push(["Product", "SKU", "Sold", "Revenue", "Tax", "Cost", "Margin", "Given away", "Share %"]);
      for (const r of products) {
        rows.push([
          r.name, r.sku, plainNumber(r.sold), money(r.revenue), money(r.tax), money(r.cost),
          money(r.margin), money(r.promo_saved),
          total > 0 ? ((r.revenue / total) * 100).toFixed(1) : "0.0",
        ]);
      }
      if (products.length === LIMIT) {
        rows.push([]);
        rows.push(["Note", `Capped at ${LIMIT} products — Share % is of the rows in this file`]);
      }
    } else {
      const cats = await all<{ category: string; sold: number; revenue: number; margin: number }>(
        c.env.DB,
        `SELECT COALESCE(c.name, 'Uncategorised') AS category,
                SUM(i.qty) AS sold, SUM(i.total) AS revenue,
                SUM(i.total - i.tax - CAST(ROUND(i.qty * i.cost) AS INTEGER)) AS margin
           FROM sale_items i
           JOIN sales s ON s.id = i.sale_id
           LEFT JOIN products p ON p.id = i.product_id
           LEFT JOIN categories c ON c.id = p.category_id
          WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
          GROUP BY category ORDER BY revenue DESC`,
        from,
        to,
      );
      const total = cats.reduce((a, r) => a + r.revenue, 0);
      rows.push(["Category", "Sold", "Revenue", "Margin", "Share %"]);
      for (const r of cats) {
        rows.push([
          r.category, plainNumber(r.sold), money(r.revenue), money(r.margin),
          total > 0 ? ((r.revenue / total) * 100).toFixed(1) : "0.0",
        ]);
      }
    }
  }

  if (report === "sales") {
    const daily = await all<{ day: string; sales: number; takings: number; tax: number; given_away: number }>(
      c.env.DB,
      `SELECT DATE(completed_at, 'unixepoch') AS day, COUNT(*) AS sales,
              COALESCE(SUM(total), 0) AS takings, COALESCE(SUM(tax), 0) AS tax,
              COALESCE(SUM(promo_saved + discount), 0) AS given_away
         FROM sales WHERE status = 'completed' AND completed_at BETWEEN ?1 AND ?2
        GROUP BY day ORDER BY day`,
      from,
      to,
    );
    rows.push(["Day", "Sales", "Takings", "Tax", "Given away"]);
    for (const r of daily) {
      rows.push([r.day, plainNumber(r.sales), money(r.takings), money(r.tax), money(r.given_away)]);
    }
    rows.push([]);
    rows.push([
      "Totals",
      plainNumber(daily.reduce((a, r) => a + r.sales, 0)),
      money(daily.reduce((a, r) => a + r.takings, 0)),
      money(daily.reduce((a, r) => a + r.tax, 0)),
      money(daily.reduce((a, r) => a + r.given_away, 0)),
    ]);
  }

  if (report === "tenders") {
    const tenders = await all<{ method: string; count: number; amount: number }>(
      c.env.DB,
      `SELECT p.method, COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS amount
         FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
        GROUP BY p.method ORDER BY amount DESC`,
      from,
      to,
    );
    rows.push(["Tender", "Count", "Amount"]);
    for (const r of tenders) rows.push([r.method, plainNumber(r.count), money(r.amount)]);
  }

  if (report === "staff") {
    const staff = await all<{ name: string; sales: number; takings: number }>(
      c.env.DB,
      `SELECT u.name, COUNT(*) AS sales, COALESCE(SUM(s.total), 0) AS takings
         FROM sales s JOIN users u ON u.id = s.user_id
        WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
        GROUP BY u.id, u.name ORDER BY takings DESC`,
      from,
      to,
    );
    rows.push(["Cashier", "Sales", "Takings"]);
    for (const r of staff) rows.push([r.name, plainNumber(r.sales), money(r.takings)]);
  }

  if (report === "shrinkage") {
    const byReason = await all<{ reason: string; movements: number; units: number; value: number }>(
      c.env.DB,
      `SELECT m.reason, COUNT(*) AS movements, SUM(m.qty_delta) AS units,
              SUM(CAST(ROUND(m.qty_delta * m.unit_cost) AS INTEGER)) AS value
         FROM stock_movements m
        WHERE m.reason IN ('waste', 'count', 'adjust') AND m.created_at BETWEEN ?1 AND ?2
        GROUP BY m.reason`,
      from,
      to,
    );
    const worst = await all<{ name: string; sku: string; units: number; value: number }>(
      c.env.DB,
      `SELECT p.name, p.sku, SUM(m.qty_delta) AS units,
              SUM(CAST(ROUND(m.qty_delta * m.unit_cost) AS INTEGER)) AS value
         FROM stock_movements m JOIN products p ON p.id = m.product_id
        WHERE m.reason IN ('waste', 'count', 'adjust') AND m.created_at BETWEEN ?1 AND ?2
          AND m.qty_delta < 0
        GROUP BY p.id, p.name, p.sku ORDER BY value LIMIT 100`,
      from,
      to,
    );
    rows.push(["Because", "Movements", "Units", "Value"]);
    for (const r of byReason) {
      rows.push([r.reason, plainNumber(r.movements), plainNumber(r.units), money(r.value)]);
    }
    rows.push([]);
    rows.push(["Product", "SKU", "Units", "Value"]);
    for (const r of worst) {
      rows.push([r.name, r.sku, plainNumber(r.units), money(r.value)]);
    }
  }

  if (report === "tax") {
    const rates = await all<{ tax_bp: number; net: number; tax: number; gross: number; sales: number }>(
      c.env.DB,
      `SELECT i.tax_bp, COALESCE(SUM(i.total - i.tax), 0) AS net,
              COALESCE(SUM(i.tax), 0) AS tax, COALESCE(SUM(i.total), 0) AS gross,
              COUNT(DISTINCT i.sale_id) AS sales
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.status = 'completed' AND s.completed_at BETWEEN ?1 AND ?2
        GROUP BY i.tax_bp ORDER BY i.tax_bp`,
      from,
      to,
    );
    rows.push(["Rate %", "Net", "Tax", "Gross", "Sales"]);
    for (const r of rates) {
      rows.push([
        (r.tax_bp / 100).toFixed(2), money(r.net), money(r.tax), money(r.gross), plainNumber(r.sales),
      ]);
    }
    rows.push([]);
    rows.push([
      "Totals",
      money(rates.reduce((a, r) => a + r.net, 0)),
      money(rates.reduce((a, r) => a + r.tax, 0)),
      money(rates.reduce((a, r) => a + r.gross, 0)),
      plainNumber(rates.reduce((a, r) => a + r.sales, 0)),
    ]);
  }

  if (report === "inventory") {
    const products = await all<{
      sku: string; name: string; category: string; stock: number; unit: string;
      cost: number; price: number; at_cost: number; at_retail: number;
    }>(
      c.env.DB,
      `SELECT p.sku, p.name, COALESCE(c.name, '') AS category, p.stock, p.unit,
              p.cost, p.price,
              CAST(ROUND(p.stock * p.cost) AS INTEGER) AS at_cost,
              CAST(ROUND(p.stock * p.price) AS INTEGER) AS at_retail
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.active = 1 ORDER BY p.name`,
    );
    rows.push(["Note", "Valuation is as at export time; the period above does not apply"]);
    rows.push([]);
    rows.push([
      "SKU", "Name", "Category", "On hand", "Unit", "Cost", "Price",
      "Stock at cost", "Stock at retail",
    ]);
    for (const r of products) {
      rows.push([
        r.sku, r.name, r.category, plainNumber(r.stock), r.unit,
        money(r.cost), money(r.price), money(r.at_cost), money(r.at_retail),
      ]);
    }
    rows.push([]);
    rows.push([
      "", "Totals", "", "", "", "", "",
      money(products.reduce((a, r) => a + r.at_cost, 0)),
      money(products.reduce((a, r) => a + r.at_retail, 0)),
    ]);
  }

  if (report === "shifts") {
    const shifts = await all<{
      id: string; lane: string; cashier: string; opened_at: number; closed_at: number | null;
      opening_float: number; counted_total: number | null; expected_total: number | null;
      variance: number | null; sales: number; takings: number;
    }>(
      c.env.DB,
      `SELECT sh.id, r.name AS lane, u.name AS cashier, sh.opened_at, sh.closed_at,
              sh.opening_float, sh.counted_total, sh.expected_total, sh.variance,
              (SELECT COUNT(*) FROM sales s WHERE s.shift_id = sh.id AND s.status = 'completed') AS sales,
              (SELECT COALESCE(SUM(s.total), 0) FROM sales s
                WHERE s.shift_id = sh.id AND s.status = 'completed') AS takings
         FROM shifts sh
         LEFT JOIN registers r ON r.id = sh.register_id
         LEFT JOIN users u ON u.id = sh.user_id
        WHERE sh.opened_at BETWEEN ?1 AND ?2
        ORDER BY sh.opened_at DESC LIMIT 500`,
      from,
      to,
    );
    rows.push([
      "Lane", "Cashier", "Opened", "Closed", "Sales", "Takings",
      "Opening float", "Expected cash", "Counted", "Over/short",
    ]);
    for (const s of shifts) {
      // A closed shift keeps what it was reconciled against; an open one is
      // asked live, because there is no stored figure yet and a blank column
      // would read as zero.
      const expected = s.closed_at
        ? (s.expected_total ?? 0)
        : (await expectedInDrawer(c.env.DB, s.id)).expected;
      rows.push([
        s.lane ?? "", s.cashier ?? "",
        isoStamp(s.opened_at), s.closed_at ? isoStamp(s.closed_at) : "",
        plainNumber(s.sales), money(s.takings), money(s.opening_float), money(expected),
        s.closed_at ? money(s.counted_total ?? 0) : "",
        s.closed_at ? money(s.variance ?? 0) : "",
      ]);
    }
  }

  if (report === "expenses") {
    const expenses = await all<{
      spent_at: number; category: string; payee: string; method: string;
      amount: number; note: string; user_name: string | null;
    }>(
      c.env.DB,
      `SELECT e.spent_at, e.category, e.payee, e.method, e.amount, e.note, u.name AS user_name
         FROM expenses e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.spent_at BETWEEN ?1 AND ?2 ORDER BY e.spent_at DESC LIMIT 2000`,
      from,
      to,
    );
    rows.push(["Date", "Category", "Payee", "Method", "Amount", "Note", "Who"]);
    for (const e of expenses) {
      rows.push([
        isoDay(e.spent_at), e.category, e.payee, e.method, money(e.amount),
        e.note, e.user_name ?? "",
      ]);
    }
    rows.push([]);
    rows.push(["", "Totals", "", "", money(expenses.reduce((a, e) => a + e.amount, 0))]);
  }

  return csvResponse(`${report}-${isoDay(from)}.csv`, csvDoc(rows));
});

/**
 * What is sitting on the shelf not selling.
 *
 * Ranked by what it is worth rather than by how long it has sat, because the
 * decision it feeds is what to discount or return, and a hundred kyat of dust
 * is not worth a shopkeeper's afternoon. A product that has *never* sold comes
 * back with `last_sold` null and sorts with the oldest.
 */
reports.get("/dead-stock", async (c) => {
  const days = Math.max(1, Number(c.req.query("days") ?? "60"));
  const since = now() - days * 86400;
  const rows = await all<{
    id: string; sku: string; name: string; stock: number; cost: number;
    at_cost: number; last_sold: number | null;
  }>(
    c.env.DB,
    `SELECT p.id, p.sku, p.name, p.stock, p.cost,
            CAST(ROUND(p.stock * p.cost) AS INTEGER) AS at_cost,
            (SELECT MAX(s.completed_at) FROM sale_items i JOIN sales s ON s.id = i.sale_id
              WHERE i.product_id = p.id AND s.status = 'completed') AS last_sold
       FROM products p
      WHERE p.active = 1 AND p.stock > 0
        AND COALESCE((SELECT MAX(s.completed_at) FROM sale_items i JOIN sales s ON s.id = i.sale_id
                       WHERE i.product_id = p.id AND s.status = 'completed'), 0) < ?1
      ORDER BY at_cost DESC LIMIT 100`,
    since,
  );
  return c.json({
    days,
    products: rows,
    at_cost: rows.reduce((a, r) => a + Number(r.at_cost ?? 0), 0),
  });
});
