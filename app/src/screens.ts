//! Every screen, as a function from one API answer to `desk.Block[]`.
//!
//! Split out of `office.tsx` because that file is the wiring — render, listen,
//! dispatch — and this is the reading. Nothing here starts a request: each
//! function is handed the values it needs and returns what the view knows how
//! to draw.
//!
//! **Values, not documents.** Every parameter below is a [`model`] type, so a
//! cell is `p.name` rather than a lookup by key — which means a misremembered
//! key is a type error here rather than a blank column in a shop. Where the
//! shape allows a null, [`model`] already decided what it reads as, against
//! the schema; nothing on this side guesses.
//!
//! The one exception is [`settings`], which is a key→value map of setting names
//! rather than a record — see `api.settings`.
//!
//! Sixteen screens and four drill-downs, and the whole vocabulary is five
//! shapes: stat cards, a ranked list with meters, a table, lane cards, and the
//! detail header. That is what keeps this a long file rather than a hard one.

import * as desk from "./desk.ts";
import * as doc from "./doc.ts";
import type { Doc } from "./doc.ts";
import * as browser from "./browser.ts";
import type { Lang } from "./i18n.ts";
import type * as model from "./model.ts";
import * as money from "./money.ts";
import type { Currency } from "./money.ts";
import * as words from "./words.ts";
import { div, pad_start, sorted, str_len } from "./lang.ts";

// ---- small helpers ---------------------------------------------------------

/**
 * A dash where there is nothing to show.
 *
 * The nullable columns arrive here as the empty string — see [`model`] — and a
 * table cell that is simply blank reads as a column that failed to draw rather
 * than as a fact about the row.
 */
function or_dash(value: string): string {
  if (value.length === 0) {
    return "—";
  }
  return value;
}

export function row(key: string, cells: string[], tone: string): desk.Row {
  return { key, cells, tone, action: "", id: "" };
}

export function touchable(key: string, cells: string[], tone: string, what: string, id: string): desk.Row {
  return { key, cells, tone, action: what, id };
}

export function table(heading: string, note: string, columns: string[], rows: desk.Row[]): desk.Block {
  return { tag: "Grid", table: { heading, note, columns, rows } };
}

/**
 * Meter widths against the biggest in the set.
 *
 * Two parallel lists rather than a list of rows and the names of two fields to
 * read off it: the four screens that draw meters draw them from four different
 * types.
 */
export function meters(names: string[], values: number[], sub: string[], c: Currency): desk.Meter[] {
  let largest = 0;
  for (const value of values) {
    largest = Math.max(largest, value);
  }
  return names.map((name, i) => {
    const value = values[i] ?? 0;
    return {
      key: `m${i}`,
      rank: `${i + 1}`,
      name,
      value: money.show(value, c),
      sub: sub[i] ?? "",
      width: desk.width_of(value, largest),
    };
  });
}

/**
 * One line of a receipt's foot: a label on the left, the amount on the right.
 *
 * Padded by counting characters rather than written with a run of spaces,
 * because the မြန်မာ word for a subtotal is not eight letters long and a
 * hard-coded gap put the amounts in a different place in each language.
 */
function foot_line(label: string, amount: string): string {
  return label + pad_start(amount, Math.max(32 - str_len(label), 1), " ");
}

function when(epoch: number): string {
  if (epoch <= 0) {
    return "—";
  }
  return `${browser.day_of(epoch)} ${browser.clock_of(epoch)}`;
}

// ---- codes, said in words ---------------------------------------------------
//
// The database stores machine words — `part_received`, `safe_drop`, `n_for_x` —
// and every code a screen shows goes through one of these. An unknown code
// falls back to the code itself for the same reason a missing key does:
// findable, and obviously wrong.

/**
 * The window a books sheet is showing.
 *
 * `desk.window_label` answers this in English only. The books' notes are the
 * one place a window is read as prose rather than pressed as a chip, so it is
 * said here in the reader's own language.
 */
function window_of(l: Lang, name: string): string {
  switch (name) {
    case "today":
      return words.t(l, "common.today");
    case "7":
      return words.t(l, "common.7_days");
    case "month":
      return words.t(l, "common.this_month");
    case "all":
      return words.t(l, "common.all_time");
    default:
      return words.t(l, "common.30_days");
  }
}

/** What a movement of stock was for — `stock_movements.reason`. */
function stock_reason_of(l: Lang, code: string): string {
  switch (code) {
    case "sale":
      return words.t(l, "movements.reason_sale");
    case "refund":
      return words.t(l, "sales.refund");
    case "receive":
      return words.t(l, "inventory.delivery_received");
    case "adjust":
      return words.t(l, "inventory.manual_correction");
    case "waste":
      return words.t(l, "movements.reason_waste");
    case "count":
      return words.t(l, "movements.reason_count");
    case "open":
      return words.t(l, "products.opening_stock");
    default:
      return code;
  }
}

/** Whether a lane is being worked, shut, or has gone quiet. */
function lane_state_of(l: Lang, code: string): string {
  switch (code) {
    case "open":
      return words.t(l, "common.open_state");
    case "closed":
      return words.t(l, "common.closed");
    case "offline":
      return words.t(l, "tills.offline");
    default:
      return code;
  }
}

/** What moved the cash in a drawer — `cash_movements.kind`. */
function drawer_kind_of(l: Lang, code: string): string {
  switch (code) {
    case "paid_in":
      return words.t(l, "shift_detail.cash_paid_in");
    case "paid_out":
      return words.t(l, "shift_detail.cash_paid_out");
    case "safe_drop":
      return words.t(l, "shifts.safe_drop");
    default:
      return code;
  }
}

/** How money changed hands — a tender, a refund or an expense. */
function method_of(l: Lang, code: string): string {
  switch (code) {
    case "cash":
      return words.t(l, "common.cash");
    case "card":
      return words.t(l, "common.card");
    case "wallet":
      return words.t(l, "common.wallet");
    case "store_credit":
      return words.t(l, "common.store_credit");
    case "on_account":
      return words.t(l, "expenses.on_account");
    default:
      return code;
  }
}

/** What a person may open and how far they may reach — `users.role`. */
function role_of(l: Lang, code: string): string {
  switch (code) {
    case "sale_staff":
      return words.t(l, "staff.sale_staff");
    case "manager":
      return words.t(l, "staff.manager");
    case "owner":
      return words.t(l, "staff.owner");
    default:
      return code;
  }
}

/** Where a purchase order has got to — `purchase_orders.status`. */
function order_status_of(l: Lang, code: string): string {
  switch (code) {
    case "draft":
      return words.t(l, "ui.draft");
    case "sent":
      return words.t(l, "purchasing.sent");
    case "part_received":
      return words.t(l, "ui.part_received");
    case "received":
      return words.t(l, "common.received");
    case "cancelled":
      return words.t(l, "common.cancelled");
    default:
      return code;
  }
}

/** Where a sale has got to — `sales.status`. */
function sale_status_of(l: Lang, code: string): string {
  switch (code) {
    case "held":
      return words.t(l, "ui.held");
    case "completed":
      return words.t(l, "common.completed");
    case "voided":
      return words.t(l, "common.voided");
    default:
      return code;
  }
}

/** The shape of an offer — `promotions.kind`. */
function offer_kind_of(l: Lang, code: string): string {
  switch (code) {
    case "percent_off":
      return words.t(l, "promotions.percentage_off");
    case "amount_off":
      return words.t(l, "promotions.amount_off");
    case "fixed_price":
      return words.t(l, "promotions.fixed_price");
    case "n_for_x":
      return words.t(l, "promotions.multibuy");
    default:
      return code;
  }
}

/** How wide an offer casts — `promotions.scope`. */
function offer_scope_of(l: Lang, code: string): string {
  switch (code) {
    case "product":
      return words.t(l, "common.product");
    case "category":
      return words.t(l, "common.category");
    case "all":
      return words.t(l, "common.all");
    default:
      return code;
  }
}

/** Which side of the sheet an account sits on — `accounts.kind`. */
function account_kind_of(l: Lang, code: string): string {
  switch (code) {
    case "asset":
      return words.t(l, "accounting.asset");
    case "liability":
      return words.t(l, "accounting.liability");
    case "equity":
      return words.t(l, "accounting.equity");
    case "income":
      return words.t(l, "accounting.income");
    case "expense":
      return words.t(l, "accounting.expense");
    default:
      return code;
  }
}

/** Which way an account normally moves — `accounts.normal`. */
function normal_of(l: Lang, code: string): string {
  switch (code) {
    case "debit":
      return words.t(l, "accounting.debit");
    case "credit":
      return words.t(l, "accounting.credit");
    default:
      return code;
  }
}

/**
 * What caused a journal entry — `journal_entries.ref_type`. Public because
 * the journal's filter dialog offers the same list it renders.
 */
export function caused_by_of(l: Lang, code: string): string {
  switch (code) {
    case "sale":
      return words.t(l, "movements.reason_sale");
    case "refund":
      return words.t(l, "sales.refund");
    case "shift":
      return words.t(l, "nav.shift");
    case "cash_movement":
      return words.t(l, "movements.cash_movement");
    case "expense":
      return words.t(l, "accounting.expense");
    case "stock_movement":
      return words.t(l, "movements.stock_movement");
    case "supplier_invoice":
      return words.t(l, "payables.supplier_invoice");
    case "supplier_payment":
      return words.t(l, "payables.supplier_payment");
    case "purchase_order":
      return words.t(l, "nav.purchase_order");
    case "opening":
      return words.t(l, "accounting.opening_balance");
    default:
      return code;
  }
}

/** What somebody had to be authorised for — `audit_log.action`. */
function authorised_of(l: Lang, code: string): string {
  switch (code) {
    case "void_sale":
      return words.t(l, "tills.void_sale");
    case "no_sale":
      return words.t(l, "tills.no_sale");
    case "return":
      return words.t(l, "tills.return");
    case "refund":
      return words.t(l, "sales.refund");
    case "price_override":
      return words.t(l, "tills.price_override");
    case "line_discount":
      return words.t(l, "tills.line_discount");
    case "basket_discount":
      return words.t(l, "register.basket_discount");
    case "close_lane":
      return words.t(l, "tills.close_lane");
    case "expense":
      return words.t(l, "accounting.expense");
    case "close_period":
      return words.t(l, "accounting.close_the_month");
    case "reverse_entry":
      return words.t(l, "accounting.entry_reversed");
    default:
      return code;
  }
}

/**
 * One of the till's own command words.
 *
 * The API sends the command bar's English labels rather than its ids, so this
 * maps back to the id and then into the shop's vocabulary. A label nobody
 * recognises comes through untouched, which is what a new command would do
 * until somebody adds a line here.
 */
function command_of(l: Lang, label: string): string {
  switch (label) {
    case "Hold":
      return words.t(l, "tills.hold");
    case "Held":
      return words.t(l, "tills.held");
    case "Customer":
      return words.t(l, "common.customer");
    case "Price check":
      return words.t(l, "tills.price_check");
    case "Void line":
      return words.t(l, "tills.void_line");
    case "Discount":
      return words.t(l, "common.discount");
    case "Price override":
      return words.t(l, "tills.price_override");
    case "Return":
      return words.t(l, "tills.return");
    case "Void sale":
      return words.t(l, "tills.void_sale");
    case "No sale":
      return words.t(l, "tills.no_sale");
    case "Close lane":
      return words.t(l, "tills.close_lane");
    default:
      return label;
  }
}

/** Whether a role may reach a command, and what it costs them. */
function allowance_of(l: Lang, code: string): string {
  switch (code) {
    case "yes":
      return words.t(l, "accounting.yes");
    case "pin":
      return words.t(l, "tills.manager_pin");
    case "no":
      return words.t(l, "error.not_allowed");
    default:
      return code;
  }
}

/** What the till asks for before it runs a command. */
function confirm_of(l: Lang, code: string): string {
  switch (code) {
    case "none":
      return words.t(l, "common.none");
    case "explicit":
      return words.t(l, "tills.confirm");
    case "reason":
      return words.t(l, "common.reason");
    default:
      return code;
  }
}

// ---- the day ---------------------------------------------------------------

export function overview(answer: model.Overview, l: Lang, c: Currency, _who: string): desk.Block[] {
  const sales = answer.today.sales;
  const takings = answer.today.takings;
  const net = answer.margin.net;
  const cost = answer.margin.cost;
  const low = answer.stock.low;

  const stats: desk.Stat[] = [
    {
      label: words.t(l, "dashboard.takings_today"),
      value: money.show(takings, c),
      meta: `${words.fill_n(l, "shifts.n_sales", `${sales}`)} · ${words.fill(l, "sales.avg_n", money.show(sales > 0 ? div(takings, sales) : 0, c))}`,
      tone: "ok",
    },
    {
      label: words.t(l, "dashboard.margin_today"),
      value: money.show(net - cost, c),
      meta: words.fill(l, "dashboard.on_n_net_of_tax", money.show(net, c)),
      tone: "info",
    },
    {
      label: words.t(l, "common.stock_at_cost"),
      value: money.show(answer.stock.at_cost, c),
      meta: `${words.fill_n(l, "dashboard.n_skus", `${answer.stock.skus}`)} · ${words.fill_n(l, "dashboard.n_low", `${low}`)}`,
      tone: low > 0 ? "warn" : "",
    },
    {
      label: words.t(l, "dashboard.given_away"),
      value: money.show(answer.today.given_away, c),
      meta: words.t(l, "promotions.offers_and_discounts"),
      tone: "",
    },
  ];

  const seller_names: string[] = [];
  const seller_revenue: number[] = [];
  const sold: string[] = [];
  for (const s of answer.top_sellers) {
    seller_names.push(s.name);
    seller_revenue.push(s.revenue);
    sold.push(words.fill(l, "dashboard.n_sold", money.quantity(s.sold)));
  }

  const lanes: desk.Row[] = [];
  for (const lane of answer.lanes) {
    const open = lane.shift_id.length > 0;
    lanes.push(
      row(
        lane.id,
        [
          lane.name,
          open ? words.t(l, "common.open_state") : words.t(l, "common.closed"),
          or_dash(lane.operator),
          `${lane.sales}`,
          money.show(lane.takings, c),
        ],
        open ? "ok" : "",
      ),
    );
  }

  const days: desk.Row[] = [];
  for (const d of answer.fortnight) {
    days.push(row(d.day, [d.day, `${d.sales}`, money.show(d.takings, c)], ""));
  }

  return [
    { tag: "Stats", items: stats },
    {
      tag: "Meters",
      heading: words.t(l, "dashboard.top_sellers"),
      note: words.t(l, "dashboard.last_7_days"),
      rows: meters(seller_names, seller_revenue, sold, c),
    },
    table(
      words.t(l, "dashboard.lanes_today"),
      "",
      [
        words.t(l, "common.lane"),
        words.t(l, "common.state"),
        words.t(l, "shifts.operator"),
        words.t(l, "common.sales"),
        words.t(l, "common.takings"),
      ],
      lanes,
    ),
    table(
      words.t(l, "dashboard.the_fortnight"),
      "",
      [words.t(l, "common.day"), words.t(l, "common.sales"), words.t(l, "common.takings")],
      days,
    ),
  ];
}

export function tills(lanes: model.Lane[], audit: model.AuditEntry[], l: Lang, c: Currency): desk.Block[] {
  const cards: desk.LaneCard[] = [];
  for (const lane of lanes) {
    const state = lane.state;
    const operator = lane.operator;
    const open = state !== "closed";
    const items = lane.active_items;
    let note = words.t(l, "tills.ready_for_a_float");
    if (open && items > 0) {
      note = `${words.t(l, "tills.a_sale_is_in_progress")} · ${words.fill(l, "register.n_items", `${items}`)} · ${money.show(lane.active_total, c)}`;
    } else if (open) {
      note = words.t(l, "tills.signed_in_and_waiting");
    }
    if (state === "offline") {
      note = words.t(l, "tills.lane_has_not_spoken");
    }
    cards.push({
      id: lane.id,
      name: lane.name,
      state: lane_state_of(l, state),
      tone: state === "open" ? "ok" : state === "offline" ? "warn" : "",
      initials: operator.length > 0 ? desk.initials_of(operator) : "—",
      operator: operator.length > 0 ? operator : words.t(l, "tills.unattended"),
      since: open
        ? `${words.fill(l, "tills.since_n", browser.clock_of(lane.opened_at))} · ${words.fill(l, "tills.float_n", money.show(lane.opening_float, c))}`
        : words.fill(l, "tills.closed_n", browser.day_of(lane.last_close)),
      drawer: money.show(lane.drawer_expected, c),
      sales: `${lane.sales}`,
      held: `${lane.held}`,
      note,
      close_label: open ? words.t(l, "tills.force_close") : words.t(l, "tills.retire_device"),
      closeable: true,
    });
  }

  const auths: desk.Row[] = [];
  for (const a of audit) {
    const what = a.action;
    auths.push(
      row(
        a.id,
        [
          browser.clock_of(a.at),
          or_dash(a.register_name),
          authorised_of(l, what),
          or_dash(a.asked_by_name),
          or_dash(a.approved_by_name),
          money.show(a.amount, c),
        ],
        what === "void_sale" || what === "no_sale" ? "stop" : "",
      ),
    );
  }

  return [
    { tag: "Note", heading: words.t(l, "nav.tills"), body: words.t(l, "tills.every_lane_running_the_pos_app") },
    { tag: "Buttons", items: [desk.action(words.t(l, "tills.add_a_lane"), "form-register", "", "soft")] },
    { tag: "Lanes", cards },
    table(
      words.t(l, "tills.authorisations_at_the_till"),
      words.t(l, "common.today"),
      [
        words.t(l, "shift_detail.time"),
        words.t(l, "common.lane"),
        words.t(l, "tills.command"),
        words.t(l, "tills.asked_by"),
        words.t(l, "tills.approved_by"),
        words.t(l, "common.amount"),
      ],
      auths,
    ),
  ];
}

// ---- selling ---------------------------------------------------------------

export function sales(answer: model.SaleRow[], l: Lang, c: Currency): desk.Block[] {
  const rows: desk.Row[] = [];
  let total = 0;
  let refunds = 0;
  for (const s of answer) {
    const refunded = s.refunded;
    total = total + s.total;
    refunds = refunds + refunded;
    rows.push(
      touchable(
        s.id,
        [
          `#${s.number}`,
          when(s.completed_at),
          s.cashier,
          or_dash(s.customer),
          `${s.items}`,
          money.show(s.total, c),
          refunded > 0 ? `−${money.show(refunded, c)}` : "",
        ],
        refunded > 0 ? "warn" : "",
        "open-sale",
        s.id,
      ),
    );
  }
  return [
    {
      tag: "Stats",
      items: [
        {
          label: words.t(l, "common.takings"),
          value: money.show(total, c),
          meta: words.fill(l, "sales.n_sales_in_seven_days", `${rows.length}`),
          tone: "ok",
        },
        {
          label: words.t(l, "common.refunded"),
          value: money.show(refunds, c),
          meta: words.t(l, "sales.returned_to_customers"),
          tone: refunds > 0 ? "warn" : "",
        },
      ],
    },
    table(
      words.t(l, "common.sales"),
      words.t(l, "sales.seven_days_touch_a_row"),
      [
        "#",
        words.t(l, "common.when"),
        words.t(l, "common.cashier"),
        words.t(l, "common.customer"),
        words.t(l, "register.items"),
        words.t(l, "common.total"),
        words.t(l, "common.refunded"),
      ],
      rows,
    ),
  ];
}

export function sale_detail(answer: model.SalePage, l: Lang, c: Currency): desk.Block[] {
  const sale = answer.sale;
  const shop = answer.shop;
  const lines = answer.lines;
  const number = sale.number;

  const facts: desk.Fact[] = [
    { label: words.t(l, "common.total"), value: money.show(sale.total, c), tone: "" },
    { label: words.t(l, "common.when"), value: when(sale.completed_at), tone: "" },
    { label: words.t(l, "common.cashier"), value: sale.cashier, tone: "" },
    { label: words.t(l, "common.lane"), value: or_dash(sale.register_name), tone: "" },
  ];
  const customer = sale.customer;
  if (customer.length > 0) {
    facts.push({ label: words.t(l, "common.customer"), value: customer, tone: "" });
  }

  let refunded = 0;
  for (const r of answer.refunds) {
    refunded = refunded + r.total;
  }
  if (refunded > 0) {
    facts.push({ label: words.t(l, "common.refunded"), value: money.show(refunded, c), tone: "warn" });
  }

  const actions: desk.Action[] = [desk.action(words.t(l, "common.print"), "print", "", "soft")];
  if (sale.status === "completed") {
    actions.push(desk.action(words.t(l, "sales.refund"), "form-refund", sale.id, "danger"));
  }

  // The receipt, exactly as it prints. Every line is a snapshot from the sale
  // itself — the name, the price and the offer as they were on the day — so a
  // reprint years later reads as it did at the counter.
  const head: string[] = [shop.name];
  const address = shop.address;
  if (address.length > 0) {
    head.push(address);
  }
  const phone = shop.phone;
  if (phone.length > 0) {
    head.push(phone);
  }
  const tax_id = shop.tax_id;
  if (tax_id.length > 0) {
    head.push(`${words.t(l, "common.tax_id")} ${tax_id}`);
  }
  head.push(`${words.fill(l, "title.receipt", `#${number}`)} · ${when(sale.completed_at)}`);
  head.push(`${words.t(l, "receipt.served_by")} ${sale.cashier}`);

  const body: string[] = [];
  const table_rows: desk.Row[] = [];
  for (const line of lines) {
    const name = line.name;
    const q = line.qty;
    body.push(`${money.quantity(q)} × ${name}`);
    body.push(
      `      ${money.show(line.unit_price, c)} ${words.t(l, "receipt.each")}      ${money.show(line.total, c)}`,
    );
    const promo = line.promo_name;
    if (promo.length > 0) {
      body.push(`      ${promo} − ${money.show(line.promo_saved, c)}`);
    }
    const back = line.refunded_qty;
    table_rows.push(
      row(
        line.id,
        [
          name,
          line.sku,
          money.quantity(q),
          money.show(line.unit_price, c),
          promo,
          money.show(line.total, c),
          back > 0.0 ? money.quantity(back) : "",
        ],
        back > 0.0 ? "warn" : "",
      ),
    );
  }

  const foot: string[] = [foot_line(words.t(l, "common.subtotal"), money.show(sale.subtotal, c))];
  const saved = sale.promo_saved + sale.discount;
  if (saved > 0) {
    foot.push(foot_line(words.t(l, "receipt.you_saved_label"), money.show(saved, c)));
  }
  if (sale.tax > 0) {
    foot.push(foot_line(words.t(l, "common.tax_included"), money.show(sale.tax, c)));
  }
  foot.push(foot_line(words.t(l, "receipt.total"), money.show(sale.total, c)));
  for (const p of answer.payments) {
    foot.push(foot_line(method_of(l, p.method), money.show(p.amount, c)));
    if (p.change > 0) {
      foot.push(foot_line(words.t(l, "common.change"), money.show(p.change, c)));
    }
  }
  const footer = shop.footer;
  if (footer.length > 0) {
    foot.push("");
    foot.push(footer);
  }

  // **How it was given back, in two columns, because it can be two things.**
  // Anything the customer still owed on this sale came off their tab first;
  // only the remainder left by `method`. Showing the total under the method
  // said a refund had paid out cash it had not, which is the figure a drawer
  // is reconciled against.
  const refunds: desk.Row[] = [];
  for (const r of answer.refunds) {
    const tab = r.on_account;
    refunds.push(
      row(
        r.id,
        [
          when(r.created_at),
          r.by_name,
          r.reason,
          tab >= r.total ? words.t(l, "receivables.off_the_tab") : method_of(l, r.method),
          money.show(r.total - tab, c),
          money.show(tab, c),
        ],
        "warn",
      ),
    );
  }

  const out: desk.Block[] = [
    {
      tag: "Detail",
      title: words.fill(l, "title.receipt", `#${number}`),
      subtitle: sale_status_of(l, sale.status),
      facts,
      actions,
    },
    table(
      words.t(l, "common.lines"),
      "",
      [
        words.t(l, "common.product"),
        words.t(l, "products.sku"),
        words.t(l, "sales.qty"),
        words.t(l, "common.each"),
        words.t(l, "promotions.offer"),
        words.t(l, "common.total"),
        words.t(l, "sales.returned"),
      ],
      table_rows,
    ),
    { tag: "Receipt", lines: body, head, foot },
  ];
  if (refunds.length > 0) {
    out.push(
      table(
        words.t(l, "reports.refunds"),
        "",
        [
          words.t(l, "common.when"),
          words.t(l, "movements.by"),
          words.t(l, "common.reason"),
          words.t(l, "sales.refund_to"),
          words.t(l, "common.amount"),
          words.t(l, "receivables.off_the_tab"),
        ],
        refunds,
      ),
    );
  }
  return out;
}

// ---- drawers ---------------------------------------------------------------

export function shifts(answer: model.ShiftRow[], l: Lang, c: Currency): desk.Block[] {
  const rows: desk.Row[] = [];
  let variance = 0;
  let open_id = "";
  for (const s of answer) {
    const closed = s.closed_at;
    const v = s.variance;
    variance = variance + v;
    if (closed === 0) {
      open_id = s.id;
    }
    rows.push(
      touchable(
        s.id,
        [
          s.register_name,
          s.user_name,
          when(s.opened_at),
          closed > 0 ? browser.clock_of(closed) : words.t(l, "common.open_state"),
          `${s.sales}`,
          money.show(s.takings, c),
          closed > 0 ? money.show(v, c) : "",
        ],
        closed === 0 ? "ok" : v !== 0 ? "warn" : "",
        "open-shift-detail",
        s.id,
      ),
    );
  }
  const buttons: desk.Action[] = [desk.action(words.t(l, "shifts.open_a_drawer"), "form-open-shift", "", "filled")];
  if (open_id.length > 0) {
    buttons.push(desk.action(words.t(l, "shifts.count_and_close"), "form-close-shift", open_id, "soft"));
  }
  return [
    {
      tag: "Stats",
      items: [
        {
          label: words.t(l, "common.over_short"),
          value: money.show(variance, c),
          meta: words.t(l, "shifts.across_every_closed_drawer"),
          tone: variance === 0 ? "ok" : "warn",
        },
      ],
    },
    { tag: "Buttons", items: buttons },
    table(
      words.t(l, "shifts.shifts"),
      words.t(l, "shifts.expected_is_derived"),
      [
        words.t(l, "common.lane"),
        words.t(l, "shifts.operator"),
        words.t(l, "common.opened"),
        words.t(l, "common.closed"),
        words.t(l, "common.sales"),
        words.t(l, "common.takings"),
        words.t(l, "common.over_short"),
      ],
      rows,
    ),
  ];
}

export function shift_detail(answer: model.ShiftPage, l: Lang, c: Currency): desk.Block[] {
  const shift = answer.shift;
  const drawer = answer.drawer;
  const closed = shift.closed_at;
  const id = shift.id;

  const facts: desk.Fact[] = [
    { label: words.t(l, "common.expected_in_drawer"), value: money.show(drawer.expected, c), tone: "" },
    {
      label: words.t(l, "common.counted"),
      value: closed > 0 ? money.show(shift.counted_total, c) : words.t(l, "shift_detail.not_counted_yet"),
      tone: "",
    },
    {
      label: words.t(l, "common.over_short"),
      value: closed > 0 ? money.show(shift.variance, c) : "—",
      tone: closed > 0 && shift.variance !== 0 ? "warn" : "",
    },
    { label: words.t(l, "common.opened"), value: when(shift.opened_at), tone: "" },
  ];
  const actions: desk.Action[] = [];
  if (closed === 0) {
    actions.push(desk.action(words.t(l, "shifts.cash_in_or_out"), "form-movement", id, "soft"));
    actions.push(desk.action(words.t(l, "shifts.count_and_close"), "form-close-shift", id, "filled"));
  }

  // The derivation, spelled out. This is the screen that answers "why does it
  // think there should be that much in the drawer", and the answer is every
  // term that went into it.
  const workings: desk.Row[] = [
    row("float", [words.t(l, "shifts.opening_float"), money.show(drawer.opening_float, c)], ""),
    row("taken", [words.t(l, "shifts.cash_taken"), money.show(drawer.cash_taken, c)], ""),
    row("change", [words.t(l, "shift_detail.change_given"), `−${money.show(drawer.change_given, c)}`], ""),
    row("in", [words.t(l, "shifts.paid_in"), money.show(drawer.cash_in, c)], ""),
    row("tabs", [words.t(l, "receivables.payments_taken"), money.show(drawer.tabs_settled, c)], ""),
    row("out", [words.t(l, "shifts.paid_out_and_safe_drops"), `−${money.show(drawer.cash_out, c)}`], ""),
    row("refunds", [words.t(l, "shifts.cash_refunds"), `−${money.show(drawer.cash_refunds, c)}`], ""),
    row("expected", [words.t(l, "common.expected"), money.show(drawer.expected, c)], "ok"),
  ];

  const movements: desk.Row[] = [];
  for (const m of answer.movements) {
    movements.push(
      row(
        m.id,
        [browser.clock_of(m.created_at), drawer_kind_of(l, m.kind), m.reason, m.user_name, money.show(m.amount, c)],
        "",
      ),
    );
  }
  const tenders: desk.Row[] = [];
  for (const t of answer.tenders) {
    tenders.push(row(t.method, [method_of(l, t.method), `${t.count}`, money.show(t.amount, c)], ""));
  }
  const sales_rows: desk.Row[] = [];
  for (const s of answer.sales) {
    sales_rows.push(
      touchable(
        s.id,
        [`#${s.number}`, browser.clock_of(s.completed_at), money.show(s.total, c)],
        "",
        "open-sale",
        s.id,
      ),
    );
  }

  return [
    {
      tag: "Detail",
      title: `${shift.register_name} · ${shift.user_name}`,
      subtitle: closed > 0 ? words.fill(l, "tills.closed_n", when(closed)) : words.t(l, "common.open_state"),
      facts,
      actions,
    },
    table(
      words.t(l, "shift_detail.how_the_expected_figure_is_reached"),
      words.t(l, "shift_detail.derived_never_typed"),
      ["", words.t(l, "common.amount")],
      workings,
    ),
    table(
      words.t(l, "shifts.cash_in_and_out"),
      "",
      [
        words.t(l, "shift_detail.time"),
        words.t(l, "common.kind"),
        words.t(l, "common.why"),
        words.t(l, "settings.who"),
        words.t(l, "common.amount"),
      ],
      movements,
    ),
    table(
      words.t(l, "shift_detail.how_they_paid"),
      "",
      [words.t(l, "common.tender"), words.t(l, "common.count"), words.t(l, "common.amount")],
      tenders,
    ),
    table(
      words.t(l, "common.sales"),
      "",
      ["#", words.t(l, "shift_detail.time"), words.t(l, "common.total")],
      sales_rows,
    ),
  ];
}

// ---- the catalogue ---------------------------------------------------------

export function products(answer: model.CatalogProduct[], l: Lang, c: Currency, query: string): desk.Block[] {
  const rows: desk.Row[] = [];
  for (const p of answer) {
    const stock = p.stock;
    const reorder = p.reorder_point;
    const age = p.min_age;
    rows.push(
      touchable(
        p.id,
        [
          p.name,
          p.sku,
          or_dash(p.category_name),
          money.show(p.price, c),
          money.show(p.cost, c),
          money.quantity(stock),
          age > 0 ? `${age}+` : "",
        ],
        stock <= 0.0 ? "stop" : reorder > 0.0 && stock <= reorder ? "warn" : "",
        "open-product",
        p.id,
      ),
    );
  }
  return [
    {
      tag: "Buttons",
      items: [
        desk.action(words.t(l, "products.add_a_product"), "form-product", "", "filled"),
        desk.action(words.t(l, "common.categories"), "go", "categories", "quiet"),
      ],
    },
    table(
      words.t(l, "common.products"),
      query.length > 0
        ? words.fill(l, "products.matching_n", query)
        : words.fill_n(l, "products.n_in_the_catalogue_touch_a_row", `${rows.length}`),
      [
        words.t(l, "common.name"),
        words.t(l, "products.sku"),
        words.t(l, "common.category"),
        words.t(l, "common.price"),
        words.t(l, "common.cost"),
        words.t(l, "products.stock"),
        words.t(l, "products.age"),
      ],
      rows,
    ),
  ];
}

export function product_detail(answer: model.ProductPage, l: Lang, c: Currency): desk.Block[] {
  const p = answer.product;
  const id = p.id;
  const stock = p.stock;
  const price = p.price;
  const cost = p.cost;
  const margin = price - cost;

  const facts: desk.Fact[] = [
    { label: words.t(l, "products.shelf_price"), value: money.show(price, c), tone: "" },
    { label: words.t(l, "common.cost"), value: money.show(cost, c), tone: "" },
    {
      label: words.t(l, "common.margin_2"),
      value: `${money.show(margin, c)}${price > 0 ? ` · ${div(margin * 100, price)}%` : ""}`,
      tone: margin <= 0 ? "stop" : "",
    },
    { label: words.t(l, "products.on_the_shelf"), value: money.quantity(stock), tone: stock <= 0.0 ? "stop" : "" },
    { label: words.t(l, "products.reorder_level"), value: money.quantity(p.reorder_point), tone: "" },
    { label: words.t(l, "common.supplier"), value: or_dash(p.supplier_name), tone: "" },
    { label: words.t(l, "products.next_price"), value: or_dash(next_prices(answer.waiting, l, c)), tone: "" },
  ];
  const actions: desk.Action[] = [
    desk.action(words.t(l, "common.edit"), "form-product", id, "soft"),
    desk.action(words.t(l, "inventory.adjust_stock"), "form-adjust", id, "soft"),
    desk.action(words.t(l, "products.add_a_barcode"), "form-barcode", id, "quiet"),
    desk.action(words.t(l, "products.retire"), "retire-product", id, "danger"),
  ];

  const barcodes: desk.Row[] = [];
  for (const b of answer.barcodes) {
    barcodes.push(
      touchable(b.barcode, [b.barcode, money.quantity(b.pack_size), b.label], "", "drop-barcode", b.barcode),
    );
  }
  const movements: desk.Row[] = [];
  for (const m of answer.movements) {
    const delta = m.qty_delta;
    movements.push(
      row(
        m.id,
        [when(m.created_at), stock_reason_of(l, m.reason), money.quantity(delta), money.show(m.unit_cost, c), m.note],
        delta < 0.0 ? "" : "ok",
      ),
    );
  }
  const sold: desk.Row[] = [];
  for (const s of answer.sold) {
    sold.push(row(s.day, [s.day, money.quantity(s.qty), money.show(s.revenue, c)], ""));
  }

  return [
    {
      tag: "Detail",
      title: p.name,
      subtitle: `${p.sku} · ${p.category_name.length > 0 ? p.category_name : words.t(l, "products.uncategorised")}`,
      facts,
      actions,
    },
    table(
      words.t(l, "products.barcodes"),
      words.t(l, "products.touch_one_to_remove_it"),
      [words.t(l, "common.barcode"), words.t(l, "products.units_per_scan"), words.t(l, "common.label")],
      barcodes,
    ),
    table(
      words.t(l, "sales.sold"),
      words.t(l, "common.30_days"),
      [words.t(l, "common.day"), words.t(l, "common.quantity"), words.t(l, "common.revenue")],
      sold,
    ),
    table(
      words.t(l, "common.stock_movements"),
      words.t(l, "movements.every_change_to_the_level"),
      [
        words.t(l, "common.when"),
        words.t(l, "common.because"),
        words.t(l, "movements.change"),
        words.t(l, "purchasing.at_cost"),
        words.t(l, "common.note"),
      ],
      movements,
    ),
  ];
}

export function categories(answer: model.CatalogCategory[], l: Lang): desk.Block[] {
  const rows: desk.Row[] = [];
  for (const cat of answer) {
    rows.push(
      touchable(cat.id, [cat.name, cat.name_my, `${cat.products}`, `${cat.sort}`], "", "form-category", cat.id),
    );
  }
  return [
    {
      tag: "Buttons",
      items: [
        desk.action(words.t(l, "categories.add_a_category"), "form-category", "", "filled"),
        desk.action(words.t(l, "categories.remove_a_category"), "form-remove-category", "", "quiet"),
        desk.action(words.t(l, "categories.back_to_products"), "go", "products", "quiet"),
      ],
    },
    // "မြန်မာ" names its own column in both languages, the way "English"
    // would: it is the header of the field the till reads a Burmese name from.
    table(
      words.t(l, "common.categories"),
      words.t(l, "common.touch_a_row_to_edit"),
      [words.t(l, "common.name"), "မြန်မာ", words.t(l, "common.products"), words.t(l, "categories.position")],
      rows,
    ),
  ];
}

export function suppliers(answer: model.Supplier[], l: Lang, c: Currency): desk.Block[] {
  const rows: desk.Row[] = [];
  for (const s of answer) {
    const owed = s.owed;
    rows.push(
      touchable(
        s.id,
        [
          s.name,
          or_dash(s.phone),
          words.fill(l, "replenishment.n_days", `${s.lead_days}`),
          `${s.products}`,
          money.show(owed, c),
        ],
        owed > 0 ? "warn" : "",
        "form-supplier",
        s.id,
      ),
    );
  }
  return [
    { tag: "Buttons", items: [desk.action(words.t(l, "suppliers.add_a_supplier"), "form-supplier", "", "filled")] },
    table(
      words.t(l, "common.suppliers"),
      words.t(l, "common.touch_a_row_to_edit"),
      [
        words.t(l, "common.name"),
        words.t(l, "common.phone"),
        words.t(l, "suppliers.lead_time"),
        words.t(l, "common.products"),
        words.t(l, "payables.owed"),
      ],
      rows,
    ),
  ];
}

export function inventory(answer: model.Inventory, l: Lang, c: Currency): desk.Block[] {
  const totals = answer.totals;
  const low = totals.low;
  const out = totals.out;

  const stats: desk.Stat[] = [
    {
      label: words.t(l, "purchasing.at_cost"),
      value: money.show(totals.at_cost, c),
      meta: words.fill_n(l, "dashboard.n_skus", `${totals.skus}`),
      tone: "info",
    },
    {
      label: words.t(l, "inventory.at_retail"),
      value: money.show(totals.at_retail, c),
      meta: words.t(l, "inventory.if_it_all_sold_at_the_shelf_price"),
      tone: "",
    },
    {
      label: words.t(l, "inventory.low"),
      value: `${low}`,
      meta: words.t(l, "inventory.at_or_below_the_reorder_point"),
      tone: low > 0 ? "warn" : "ok",
    },
    {
      label: words.t(l, "inventory.out"),
      value: `${out}`,
      meta: words.t(l, "inventory.nothing_on_the_shelf"),
      tone: out > 0 ? "stop" : "ok",
    },
  ];

  const attention: desk.Row[] = [];
  for (const p of answer.attention) {
    const stock = p.stock;
    attention.push(
      touchable(
        p.id,
        [
          p.name,
          p.sku,
          money.quantity(stock),
          money.quantity(p.reorder_point),
          money.quantity(p.reorder_qty),
          or_dash(p.supplier_name),
        ],
        stock <= 0.0 ? "stop" : "warn",
        "open-product",
        p.id,
      ),
    );
  }

  const category_names: string[] = [];
  const category_cost: number[] = [];
  const skus: string[] = [];
  for (const cat of answer.by_category) {
    category_names.push(cat.category);
    category_cost.push(cat.at_cost);
    skus.push(words.fill_n(l, "dashboard.n_skus", `${cat.skus}`));
  }

  return [
    { tag: "Stats", items: stats },
    { tag: "Buttons", items: [desk.action(words.t(l, "common.stock_movements"), "go", "movements", "quiet")] },
    table(
      words.t(l, "accounting.needs_attention"),
      words.t(l, "inventory.low_or_out_touch_a_row"),
      [
        words.t(l, "common.product"),
        words.t(l, "products.sku"),
        words.t(l, "products.stock"),
        words.t(l, "products.reorder_level"),
        words.t(l, "products.reorder_qty"),
        words.t(l, "common.supplier"),
      ],
      attention,
    ),
    {
      tag: "Meters",
      heading: words.t(l, "reports.by_category"),
      note: words.t(l, "purchasing.at_cost"),
      rows: meters(category_names, category_cost, skus, c),
    },
  ];
}

export function movements(answer: model.StockMovement[], l: Lang, c: Currency): desk.Block[] {
  const rows: desk.Row[] = [];
  for (const m of answer) {
    const delta = m.qty_delta;
    const reason = m.reason;
    rows.push(
      touchable(
        m.id,
        [
          when(m.created_at),
          m.product_name,
          m.sku,
          stock_reason_of(l, reason),
          money.quantity(delta),
          money.show(m.unit_cost, c),
          or_dash(m.user_name),
        ],
        reason === "waste" ? "stop" : delta < 0.0 ? "" : "ok",
        "open-product",
        m.product_id,
      ),
    );
  }
  return [
    {
      tag: "Note",
      heading: words.t(l, "common.stock_movements"),
      body: words.t(l, "movements.every_change_to_every_level"),
    },
    table(
      words.t(l, "movements.the_last_seven_days"),
      "",
      [
        words.t(l, "common.when"),
        words.t(l, "common.product"),
        words.t(l, "products.sku"),
        words.t(l, "common.because"),
        words.t(l, "movements.change"),
        words.t(l, "purchasing.at_cost"),
        words.t(l, "settings.who"),
      ],
      rows,
    ),
  ];
}

// ---- buying ----------------------------------------------------------------

/**
 * The buttons at the top of Purchasing.
 *
 * Two states, because a delivery half entered is the only thing on this screen
 * that is unfinished: while there are lines on it, the press that matters is
 * the one that books them, and the one that abandons them has to be reachable
 * too.
 */
function buying_actions(booking: boolean, l: Lang): desk.Action[] {
  if (booking) {
    return [
      desk.action(words.t(l, "purchasing.book_it_into_stock"), "form-goods-in-book", "", "filled"),
      desk.action(words.t(l, "purchasing.add_a_line"), "form-goods-in-line", "", "soft"),
      desk.action(words.t(l, "purchasing.start_again"), "goods-in-clear", "", "danger"),
    ];
  }
  return [
    desk.action(words.t(l, "purchasing.goods_in"), "form-goods-in-line", "", "filled"),
    desk.action(words.t(l, "purchasing.raise_orders_from_the_worksheet"), "raise-orders", "", "soft"),
    desk.action(words.t(l, "payables.record_an_invoice"), "form-invoice", "", "quiet"),
    desk.action(words.t(l, "payables.cancel_invoice"), "form-cancel-invoice", "", "quiet"),
    desk.action(words.t(l, "common.suppliers"), "go", "suppliers", "quiet"),
  ];
}

/**
 * The delivery being entered, before anything is written.
 *
 * An empty table rather than no table when there is nothing on it: the heading
 * is where a shopkeeper looks to see whether the last press landed, and a
 * region that appears and disappears is one they have to hunt for.
 */
function delivery_table(lines: desk.GoodsInLine[], value: number, l: Lang, c: Currency): desk.Block {
  const rows: desk.Row[] = [];
  for (const line of lines) {
    rows.push(
      touchable(
        line.product_id,
        [
          line.name,
          money.quantity(line.qty),
          money.show(line.unit_cost, c),
          new_price_of(line.new_price, line.price_now, l, c),
          money.show(desk.goods_in_line_value(line), c),
        ],
        "warn",
        "goods-in-drop",
        line.product_id,
      ),
    );
  }
  if (rows.length > 0) {
    rows.push(row("total", [words.t(l, "common.total"), "", "", "", money.show(value, c)], "ok"));
  }
  return table(
    words.t(l, "purchasing.delivery_being_booked"),
    words.t(l, "purchasing.touch_a_line_to_take_it_off"),
    [
      words.t(l, "common.product"),
      words.t(l, "purchasing.qty_arrived"),
      words.t(l, "purchasing.cost_each"),
      words.t(l, "purchasing.new_sell_price"),
      words.t(l, "common.value"),
    ],
    rows,
  );
}

/**
 * The new price on a delivery line, and when it starts — so the table says
 * which of the two was chosen before anything is booked.
 */
function new_price_of(price: number | null, now: boolean, l: Lang, c: Currency): string {
  if (price === null) {
    return "—";
  }
  const at = now ? words.t(l, "purchasing.from_now") : words.t(l, "purchasing.after_the_shelf");
  return `${money.show(price, c)} · ${at}`;
}

/**
 * What a delivery's new price is waiting on, as one line: each price still to
 * come and how many more have to sell before it starts. Empty when nothing is
 * waiting, which is nearly always.
 */
function next_prices(waiting: model.PendingPrice[], l: Lang, c: Currency): string {
  let out = "";
  let before = 0.0;
  let i = 0;
  for (const w of waiting) {
    if (i > 0) {
      if (out.length > 0) {
        out = out + " · ";
      }
      out = out + `${money.show(w.price, c)} ${words.fill(l, "products.after_more_sold", money.quantity(before))}`;
    }
    if (w.left >= 0.0) {
      before = before + w.left;
    }
    i = i + 1;
  }
  return out;
}

export function purchasing(
  sheet: model.WorksheetLine[],
  orders: model.PurchaseOrder[],
  payables: model.Payables | null,
  delivery: desk.GoodsInLine[],
  delivery_value: number,
  l: Lang,
  c: Currency,
): desk.Block[] {
  const lines: desk.Row[] = [];
  let value = 0;
  for (const line of sheet) {
    const suggested = line.suggested;
    value = value + line.value;
    const left = line.days_left;
    lines.push(
      touchable(
        line.id,
        [
          line.name,
          or_dash(line.supplier_name),
          money.quantity(line.stock),
          words.fill(l, "replenishment.n_per_day", money.quantity(line.per_day)),
          left >= 0.0 ? words.fill(l, "replenishment.n_days", money.quantity(left)) : "—",
          money.quantity(line.on_order),
          money.quantity(suggested),
          money.show(line.value, c),
        ],
        suggested > 0.0 ? "warn" : "",
        "open-product",
        line.id,
      ),
    );
  }

  const order_rows: desk.Row[] = [];
  for (const o of orders) {
    const status = o.status;
    order_rows.push(
      touchable(
        o.id,
        [
          `#${o.number}`,
          o.supplier_name,
          // A delivery booked straight in says so, rather than reading as an
          // order somebody placed and forgot.
          o.direct
            ? `${order_status_of(l, status)} · ${words.t(l, "purchasing.direct")}`
            : order_status_of(l, status),
          `${o.lines}`,
          money.show(o.total, c),
          browser.day_of(o.created_at),
        ],
        status === "received" ? "ok" : status === "draft" || status === "cancelled" ? "" : "warn",
        "open-order",
        o.id,
      ),
    );
  }

  // Everything below the worksheet is what the shop owes, and it is allowed
  // to be absent: the payables request is made beside the worksheet's and one
  // may come back without the other. Absent means the tables are empty rather
  // than that nothing is owed, which is why the whole block is skipped rather
  // than drawn with zeros in it.
  let outstanding = 0;
  let overdue = 0;
  let not_due = 0;
  let late_over_30 = 0;
  let suppliers_owed = 0;
  const owing: desk.Row[] = [];
  const aged: desk.Row[] = [];
  if (payables !== null) {
    const totals = payables.totals;
    outstanding = totals.outstanding;
    overdue = totals.overdue;
    not_due = totals.current;
    late_over_30 = totals.late_over_30;
    for (const i of payables.invoices) {
      const left = i.outstanding;
      const due = i.due_at;
      owing.push(
        touchable(
          i.id,
          [
            i.supplier_name,
            or_dash(i.reference),
            browser.day_of(i.issued_at),
            due > 0 ? browser.day_of(due) : "—",
            money.show(i.total, c),
            money.show(left, c),
          ],
          left > 0 && due > 0 && due < browser.now() ? "stop" : left > 0 ? "warn" : "ok",
          left > 0 ? "form-pay-invoice" : "",
          i.id,
        ),
      );
    }

    // Aging, by supplier. Which invoice to pay first is the question this
    // screen exists to answer, and one lump sum cannot answer it. The buckets
    // are summed by the database over *every* outstanding invoice, not over
    // the page of two hundred drawn above.
    const aging = payables.aging;
    suppliers_owed = aging.rows.length;
    for (const a of aging.rows) {
      aged.push(
        row(
          a.supplier_id,
          [
            a.supplier,
            money.show(a.current, c),
            money.show(a.d30, c),
            money.show(a.d60, c),
            money.show(a.d90, c),
            money.show(a.d90up, c),
            money.show(a.total, c),
          ],
          a.d90up > 0 ? "stop" : a.d60 > 0 ? "warn" : "",
        ),
      );
    }
    if (aged.length > 0) {
      const sums = aging.totals;
      aged.push(
        row(
          "all",
          [
            words.t(l, "payables.all_suppliers"),
            money.show(sums.current, c),
            money.show(sums.d30, c),
            money.show(sums.d60, c),
            money.show(sums.d90, c),
            money.show(sums.d90up, c),
            money.show(sums.total, c),
          ],
          "ok",
        ),
      );
    }
  }

  return [
    {
      tag: "Stats",
      items: [
        {
          label: words.t(l, "purchasing.to_order"),
          value: money.show(value, c),
          meta: words.fill_n(l, "replenishment.n_lines_on_the_worksheet", `${lines.length}`),
          tone: value > 0 ? "warn" : "ok",
        },
        {
          label: words.t(l, "accounting.owed_to_suppliers"),
          value: money.show(outstanding, c),
          meta: words.t(l, "payables.across_every_open_invoice"),
          tone: "info",
        },
        {
          label: words.t(l, "purchasing.overdue"),
          value: money.show(overdue, c),
          meta: words.t(l, "payables.past_the_due_date"),
          tone: overdue > 0 ? "stop" : "ok",
        },
        {
          label: words.t(l, "payables.not_yet_due"),
          value: money.show(not_due, c),
          meta: words.fill_n(l, "payables.n_suppliers", `${suppliers_owed}`),
          tone: "ok",
        },
        {
          label: words.t(l, "payables.over_30_days_late"),
          value: money.show(late_over_30, c),
          meta: words.t(l, "payables.past_the_due_date"),
          tone: late_over_30 > 0 ? "stop" : "ok",
        },
      ],
    },
    // **Goods in comes first**, because it is what a shop does most: a van
    // turns up and the stock has to go on. Raising an order against a
    // wholesaler is the less frequent thing.
    { tag: "Buttons", items: buying_actions(delivery.length > 0, l) },
    delivery_table(delivery, delivery_value, l, c),
    table(
      words.t(l, "replenishment.reorder_worksheet"),
      words.t(l, "replenishment.what_to_buy_over_28_days"),
      [
        words.t(l, "common.product"),
        words.t(l, "common.supplier"),
        words.t(l, "products.stock"),
        words.t(l, "common.rate"),
        words.t(l, "replenishment.cover"),
        words.t(l, "replenishment.on_order"),
        words.t(l, "purchasing.suggested"),
        words.t(l, "common.value"),
      ],
      lines,
    ),
    table(
      words.t(l, "purchasing.purchase_orders"),
      words.t(l, "purchasing.touch_a_row_to_receive"),
      [
        "#",
        words.t(l, "common.supplier"),
        words.t(l, "common.status"),
        words.t(l, "common.lines"),
        words.t(l, "common.total"),
        words.t(l, "purchasing.raised"),
      ],
      order_rows,
    ),
    table(
      words.t(l, "common.payables"),
      words.t(l, "payables.touch_a_row_to_pay_it"),
      [
        words.t(l, "common.supplier"),
        words.t(l, "common.reference"),
        words.t(l, "payables.issued"),
        words.t(l, "payables.due"),
        words.t(l, "common.total"),
        words.t(l, "common.outstanding"),
      ],
      owing,
    ),
    table(
      words.t(l, "payables.aging_by_supplier"),
      words.t(l, "payables.past_the_due_date"),
      [
        words.t(l, "common.supplier"),
        words.t(l, "payables.not_due"),
        words.t(l, "payables.d1_30"),
        words.t(l, "payables.d31_60"),
        words.t(l, "payables.d61_90"),
        words.t(l, "payables.d90_plus"),
        words.t(l, "common.total"),
      ],
      aged,
    ),
  ];
}

export function order_detail(answer: model.OrderPage, l: Lang, c: Currency): desk.Block[] {
  const order = answer.order;
  const id = order.id;
  const status = order.status;

  const facts: desk.Fact[] = [
    { label: words.t(l, "common.supplier"), value: order.supplier_name, tone: "" },
    {
      label: words.t(l, "common.status"),
      value: order_status_of(l, status),
      tone: status === "received" ? "ok" : status === "draft" ? "" : "warn",
    },
    { label: words.t(l, "common.total"), value: money.show(order.total, c), tone: "" },
    { label: words.t(l, "purchasing.raised"), value: browser.day_of(order.created_at), tone: "" },
  ];
  if (order.cancel_reason.length > 0) {
    facts.push({ label: words.t(l, "purchasing.why_cancelled"), value: order.cancel_reason, tone: "stop" });
  }
  const actions: desk.Action[] = [];
  if (status === "draft") {
    actions.push(desk.action(words.t(l, "purchasing.send_to_supplier"), "send-order", id, "filled"));
  }
  if (status === "sent" || status === "part_received") {
    actions.push(desk.action(words.t(l, "purchasing.receive_everything_outstanding"), "receive-all", id, "filled"));
  }
  // **Not on a Goods In.** That one wrote its own invoice in the same press
  // that booked the stock, and offering to record another is how a shop ends
  // up owing a supplier twice for one van — with `1300 Goods received not
  // invoiced` left permanently credited, because two invoices cleared an
  // accrual that was raised once.
  if (status !== "draft" && !order.direct) {
    actions.push(desk.action(words.t(l, "payables.record_an_invoice"), "form-invoice", id, "soft"));
  }
  // **The way out.** A draft is deleted, because nothing happened to it; an
  // order the supplier was told about is cancelled and keeps its row with the
  // reason on it. Both go through a form rather than a bare press, which is
  // also what gives them the guard that stops a slow line turning one tap
  // into four.
  if (status === "draft") {
    actions.push(desk.action(words.t(l, "purchasing.delete_draft"), "form-delete-order", id, "danger"));
  }
  if (status === "sent") {
    actions.push(desk.action(words.t(l, "purchasing.cancel_this_order"), "form-cancel-order", id, "danger"));
  }

  const lines: desk.Row[] = [];
  for (const line of answer.lines) {
    const ordered = line.qty;
    const received = line.qty_received;
    const left = ordered - received;
    lines.push(
      touchable(
        line.id,
        [
          line.product_name,
          line.sku,
          money.quantity(ordered),
          money.quantity(received),
          money.quantity(left),
          money.show(line.unit_cost, c),
        ],
        left <= 0.0 ? "ok" : "warn",
        left > 0.0 ? "form-receive" : "",
        line.id,
      ),
    );
  }

  return [
    {
      tag: "Detail",
      title: words.fill(l, "purchase_order.order_n", `#${order.number}`),
      subtitle: order.supplier_name,
      facts,
      actions,
    },
    table(
      words.t(l, "common.lines"),
      words.t(l, "purchase_order.touch_a_line_to_receive"),
      [
        words.t(l, "common.product"),
        words.t(l, "products.sku"),
        words.t(l, "common.ordered"),
        words.t(l, "common.received"),
        words.t(l, "common.outstanding"),
        words.t(l, "purchase_order.cost_each"),
      ],
      lines,
    ),
  ];
}

// ---- people ----------------------------------------------------------------

/**
 * The people, and what stands between them and the shop.
 *
 * Two money columns that point in opposite directions sit on this screen, and
 * the whole of the presentation problem is keeping them apart. `credit` is
 * store credit the shop **owes** a customer — a liability, from a refund.
 * `owed` is shopping the customer owes **the shop** — an asset, from a tab.
 * They have different headings, different stat cards and different tones, and
 * they are never summed into one figure, because a shop whose books net them
 * together is a shop that cannot tell a debtor from a creditor.
 *
 * `debts` is the aging half and is allowed to be absent: it is fetched beside
 * the list and one may arrive without the other. Absent means the table is
 * skipped rather than drawn with zeros in it — nobody owing anything and
 * nobody having asked are different answers.
 */
export function customers(
  answer: model.CustomerAccount[],
  debts: model.Receivables | null,
  l: Lang,
  c: Currency,
): desk.Block[] {
  const people = answer;
  const rows: desk.Row[] = [];
  let credit = 0;
  let owed = 0;
  for (const cu of people) {
    credit = credit + cu.credit;
    owed = owed + cu.owed;
    const seen = cu.last_seen;
    // Somebody over their limit is a row a shopkeeper has to see: it can
    // happen without anybody breaking a rule, because lowering a limit is
    // allowed while the existing debt stands.
    const tone = cu.owed > 0 && cu.owed >= cu.credit_limit ? "stop" : cu.owed > 0 ? "warn" : "";
    rows.push(
      touchable(
        cu.id,
        [
          cu.name,
          or_dash(cu.phone),
          `${cu.visits}`,
          money.show(cu.spent, c),
          `${cu.points}`,
          money.show(cu.credit, c),
          money.show(cu.owed, c),
          money.show(cu.credit_limit, c),
          seen > 0 ? browser.day_of(seen) : words.t(l, "common.never"),
        ],
        tone,
        "form-customer",
        cu.id,
      ),
    );
  }
  const best = sorted(people, (a, b) => a.spent > b.spent).slice(0, 8);
  const best_names: string[] = [];
  const best_spent: number[] = [];
  const visits: string[] = [];
  for (const cu of best) {
    best_names.push(cu.name);
    best_spent.push(cu.spent);
    visits.push(words.fill_n(l, "register.n_visits", `${cu.visits}`));
  }
  // The aging table, and the settlements that have come in against it.
  const aged: desk.Row[] = [];
  const taken: desk.Row[] = [];
  let debtors = 0;
  let late = 0;
  for (const cu of people) {
    if (cu.owed > 0) {
      debtors = debtors + 1;
    }
  }
  if (debts !== null) {
    // **The headline comes off the aging table, not off the list.** The
    // customer list is capped at 200 by name, and summing `owed` across it
    // put a smaller figure in the more prominent place than the "Everybody"
    // row at the foot of the table below — two totals of the same thing,
    // disagreeing, on one screen. The database sums the aging over every
    // unsettled receipt with no limit, so that is the true one; the capped
    // sum survives only as the fallback for when the request failed.
    owed = debts.aging.totals.owed;
    const aging = debts.aging;
    debtors = aging.totals.debtors;
    // Over sixty days means over sixty days. `d60` is the 31–60 band — the
    // table three blocks down heads that very column "31–60" — so counting
    // it here would put money in a card labelled "Owed over 60 days" that
    // the table beneath said was not.
    late = aging.totals.d90 + aging.totals.d90up;
    for (const a of aging.rows) {
      aged.push(
        row(
          a.customer_id,
          [
            a.customer,
            money.show(a.d30, c),
            money.show(a.d60, c),
            money.show(a.d90, c),
            money.show(a.d90up, c),
            money.show(a.total, c),
          ],
          a.d90up > 0 ? "stop" : a.d60 > 0 ? "warn" : "",
        ),
      );
    }
    if (aged.length > 0) {
      const sums = aging.totals;
      aged.push(
        row(
          "all",
          [
            words.t(l, "receivables.everybody"),
            money.show(sums.d30, c),
            money.show(sums.d60, c),
            money.show(sums.d90, c),
            money.show(sums.d90up, c),
            money.show(sums.owed, c),
          ],
          "ok",
        ),
      );
    }
    for (const p of debts.payments) {
      taken.push(
        row(
          p.id,
          [
            browser.day_of(p.created_at),
            p.customer,
            words.t(l, `common.${p.method}`),
            money.show(p.total, c),
            or_dash(p.note),
            p.taken_by,
          ],
          "ok",
        ),
      );
    }
  }

  // `owed` comes off the customer rows and is always known; how much of it is
  // *late* comes from the aging request, which is allowed to fail on its own.
  // The "over 60 days" card is therefore only drawn when somebody actually
  // asked and got an answer — a zero there would say nothing is overdue,
  // which is not the same as not knowing.
  const stats: desk.Stat[] = [
    {
      label: words.t(l, "customers.customers"),
      value: `${rows.length}`,
      meta: words.t(l, "customers.on_the_loyalty_list"),
      tone: "info",
    },
    {
      label: words.t(l, "receivables.owed_by_customers"),
      value: money.show(owed, c),
      meta: words.fill_n(l, "receivables.n_on_a_tab", `${debtors}`),
      tone: late > 0 ? "stop" : owed > 0 ? "warn" : "ok",
    },
  ];
  if (debts !== null) {
    stats.push({
      label: words.t(l, "receivables.owed_over_60_days"),
      value: money.show(late, c),
      meta: words.t(l, "receivables.the_part_worth_chasing"),
      tone: late > 0 ? "stop" : "ok",
    });
  }
  stats.push({
    label: words.t(l, "customers.store_credit_owed"),
    value: money.show(credit, c),
    meta: words.t(l, "customers.a_liability_not_a_takings_figure"),
    tone: credit > 0 ? "warn" : "ok",
  });

  const blocks: desk.Block[] = [
    { tag: "Stats", items: stats },
    {
      tag: "Buttons",
      items: [
        desk.action(words.t(l, "customers.add_a_customer"), "form-customer", "", "filled"),
        desk.action(words.t(l, "receivables.take_a_payment"), "form-settle-tab", "", ""),
      ],
    },
    {
      tag: "Meters",
      heading: words.t(l, "customers.best_customers"),
      note: words.t(l, "customers.by_what_they_have_spent"),
      rows: meters(best_names, best_spent, visits, c),
    },
    table(
      words.t(l, "customers.customers"),
      words.t(l, "common.touch_a_row_to_edit"),
      [
        words.t(l, "common.name"),
        words.t(l, "common.phone"),
        words.t(l, "customers.visits"),
        words.t(l, "customers.spent"),
        words.t(l, "customers.points"),
        words.t(l, "customers.credit"),
        words.t(l, "receivables.owed"),
        words.t(l, "receivables.limit"),
        words.t(l, "customers.last_seen"),
      ],
      rows,
    ),
  ];
  if (aged.length > 0) {
    blocks.push(
      table(
        words.t(l, "receivables.what_is_owed"),
        words.t(l, "receivables.measured_from_the_day_the_goods_left"),
        [
          words.t(l, "common.customer"),
          words.t(l, "receivables.up_to_30_days"),
          words.t(l, "receivables.d60"),
          words.t(l, "receivables.d90"),
          words.t(l, "receivables.over_90"),
          words.t(l, "receivables.owed"),
        ],
        aged,
      ),
    );
  }
  if (taken.length > 0) {
    blocks.push(
      table(
        words.t(l, "receivables.payments_taken"),
        words.t(l, "receivables.money_off_a_tab"),
        [
          words.t(l, "common.when"),
          words.t(l, "common.customer"),
          words.t(l, "common.how"),
          words.t(l, "common.amount"),
          words.t(l, "common.note"),
          words.t(l, "movements.by"),
        ],
        taken,
      ),
    );
  }
  return blocks;
}

export function staff(answer: model.Staff[], rules: model.CommandRule[], l: Lang): desk.Block[] {
  const people: desk.Row[] = [];
  let active = 0;
  for (const u of answer) {
    const on = u.active;
    if (on) {
      active = active + 1;
    }
    people.push(
      touchable(
        u.id,
        [
          u.name,
          role_of(l, u.role),
          u.app === "pos" ? words.t(l, "staff.the_till") : words.t(l, "layout.back_office"),
          u.signs_in_with === "pin" ? words.t(l, "staff.pin_at_the_lane") : words.t(l, "staff.username_password"),
          or_dash(u.at_lane),
        ],
        on ? "" : "stop",
        "staff-menu",
        u.id,
      ),
    );
  }
  const matrix: desk.Row[] = [];
  rules.forEach((m, i) => {
    const may = m.sale_staff;
    matrix.push(
      row(
        `m${i}`,
        [command_of(l, m.command), allowance_of(l, may), allowance_of(l, m.manager), confirm_of(l, m.confirm)],
        may === "no" ? "stop" : may === "pin" ? "warn" : "ok",
      ),
    );
  });
  return [
    { tag: "Note", heading: words.t(l, "nav.staff_access"), body: words.t(l, "staff.a_role_decides_which_app") },
    { tag: "Buttons", items: [desk.action(words.t(l, "staff.add_staff"), "form-staff", "", "filled")] },
    {
      tag: "Roles",
      cards: [
        {
          role: words.t(l, "staff.sale_staff"),
          opens: words.t(l, "staff.opens_the_pos_app"),
          body: words.t(l, "staff.sale_staff_body"),
          chips: [
            words.t(l, "staff.chip_sell"),
            words.t(l, "staff.chip_hold_and_recall"),
            words.t(l, "tills.price_check"),
            words.t(l, "staff.chip_discounts_locked"),
          ],
        },
        {
          role: words.t(l, "staff.manager_owner"),
          opens: words.t(l, "staff.opens_the_back_office"),
          body: words.t(l, "staff.manager_owner_body"),
          chips: [
            words.t(l, "staff.chip_approve_at_any_lane"),
            words.t(l, "staff.chip_voids_and_returns"),
            words.t(l, "tills.close_lane"),
          ],
        },
      ],
    },
    table(
      words.t(l, "common.staff"),
      words.fill_n(l, "staff.n_active_touch_a_row", `${active}`),
      [
        words.t(l, "common.name"),
        words.t(l, "staff.role"),
        words.t(l, "staff.signs_in_to"),
        words.t(l, "staff.sign_in_method"),
        words.t(l, "customers.last_seen"),
      ],
      people,
    ),
    table(
      words.t(l, "tills.till_commands_by_role"),
      words.t(l, "tills.the_pos_command_bar_is_built_from_this"),
      [words.t(l, "tills.command"), words.t(l, "staff.sale_staff"), words.t(l, "staff.manager"), words.t(l, "tills.confirm")],
      matrix,
    ),
  ];
}

// ---- insight ---------------------------------------------------------------

/**
 * Every offer, judged against `at` — the moment the *server* read the clock.
 *
 * Not `browser.now()`. Whether an offer is running is the same comparison the
 * till makes when it prices a line, and a back office whose clock has drifted
 * must not draw an offer as live that no lane will apply.
 */
export function promotions(
  answer: model.Promotion[],
  at: number,
  perf: model.PromotionResult[],
  l: Lang,
  c: Currency,
): desk.Block[] {
  const rows: desk.Row[] = [];
  let live = 0;
  for (const p of answer) {
    const active = p.active;
    const starts = p.starts_at;
    const ends = p.ends_at;
    const running = active && (starts === 0 || starts <= at) && (ends === 0 || ends >= at);
    if (running) {
      live = live + 1;
    }
    const kind = p.kind;
    let value = money.show(p.value, c);
    if (kind === "percent_off") {
      value = `${div(p.value, 100)}%`;
    }
    if (kind === "n_for_x") {
      value = `${words.fill(l, "promotions.n_for", `${p.n}`)} ${money.show(p.value, c)}`;
    }
    let applies = p.product_name;
    if (applies.length === 0) {
      applies = p.category_name;
    }
    rows.push(
      touchable(
        p.id,
        [
          p.name,
          offer_kind_of(l, kind),
          value,
          offer_scope_of(l, p.scope),
          or_dash(applies),
          running
            ? words.t(l, "promotions.running")
            : active
              ? words.t(l, "promotions.scheduled")
              : words.t(l, "promotions.ended"),
        ],
        running ? "ok" : active ? "warn" : "",
        "form-promotion",
        p.id,
      ),
    );
  }

  const performance: desk.Row[] = [];
  for (const p of perf) {
    performance.push(
      row(
        p.promo_id,
        [p.promo_name, `${p.lines}`, money.quantity(p.units), money.show(p.revenue, c), money.show(p.saved, c)],
        "",
      ),
    );
  }

  return [
    {
      tag: "Stats",
      items: [
        {
          label: words.t(l, "promotions.live_offers"),
          value: `${live}`,
          meta: words.t(l, "promotions.running_at_this_moment"),
          tone: live > 0 ? "ok" : "",
        },
      ],
    },
    { tag: "Buttons", items: [desk.action(words.t(l, "promotions.add_an_offer"), "form-promotion", "", "filled")] },
    // The note is the whole sentence and nothing after it: the "touch a row"
    // hint the other tables carry is lower case, and reads as a typo when it
    // follows a full stop rather than standing on its own.
    table(
      words.t(l, "promotions.offers"),
      words.t(l, "promotions.offers_do_not_stack"),
      [
        words.t(l, "common.name"),
        words.t(l, "common.kind"),
        words.t(l, "common.value"),
        words.t(l, "promotions.scope"),
        words.t(l, "promotions.applies_to"),
        words.t(l, "common.state"),
      ],
      rows,
    ),
    table(
      words.t(l, "promotions.what_they_cost"),
      words.t(l, "common.30_days"),
      [
        words.t(l, "promotions.offer"),
        words.t(l, "common.lines"),
        words.t(l, "common.units"),
        words.t(l, "common.revenue"),
        words.t(l, "dashboard.given_away"),
      ],
      performance,
    ),
  ];
}

/**
 * The reporting page — five reports, each fetched on its own.
 *
 * Only the first is required. The other four are asked for beside it and any
 * of them may come back empty-handed, which is what the nulls say: an absent
 * report draws no rows rather than a table of noughts that reads as a quiet
 * week.
 */
export function reports(
  products_answer: model.ProductReport,
  daily: model.SalesReport | null,
  shrink: model.ShrinkageReport | null,
  tax: model.TaxReport | null,
  dead: model.DeadStockReport | null,
  l: Lang,
  c: Currency,
): desk.Block[] {
  const products_rows: desk.Row[] = [];
  for (const p of products_answer.products) {
    const margin = p.margin;
    products_rows.push(
      touchable(
        p.product_id,
        [p.name, p.sku, money.quantity(p.sold), money.show(p.revenue, c), money.show(p.cost, c), money.show(margin, c)],
        margin < 0 ? "stop" : "",
        "open-product",
        p.product_id,
      ),
    );
  }
  const categories_rows: desk.Row[] = [];
  for (const cat of products_answer.categories) {
    categories_rows.push(
      row(
        cat.category,
        [cat.category, money.quantity(cat.sold), money.show(cat.revenue, c), money.show(cat.margin, c)],
        "",
      ),
    );
  }

  let by_hour: model.HourlySales[] = [];
  const tenders: desk.Row[] = [];
  const by_staff: desk.Row[] = [];
  if (daily !== null) {
    by_hour = daily.hourly;
    for (const t of daily.tenders) {
      tenders.push(row(t.method, [method_of(l, t.method), `${t.count}`, money.show(t.amount, c)], ""));
    }
    for (const s of daily.staff) {
      by_staff.push(row(s.name, [s.name, `${s.sales}`, money.show(s.takings, c)], ""));
    }
  }
  const hours: desk.Meter[] = [];
  let largest = 0;
  for (const h of by_hour) {
    largest = Math.max(largest, h.takings);
  }
  by_hour.forEach((h, i) => {
    const takings = h.takings;
    hours.push({
      key: `h${i}`,
      rank: `${h.hour}`,
      name: `${pad_start(`${h.hour}`, 2, "0")}:00`,
      value: money.show(takings, c),
      sub: words.fill_n(l, "shifts.n_sales", `${h.sales}`),
      width: desk.width_of(takings, largest),
    });
  });

  const shrinkage: desk.Row[] = [];
  const worst: desk.Row[] = [];
  if (shrink !== null) {
    for (const s of shrink.by_reason) {
      shrinkage.push(
        row(
          s.reason,
          [stock_reason_of(l, s.reason), `${s.movements}`, money.quantity(s.units), money.show(s.value, c)],
          "warn",
        ),
      );
    }
    for (const w of shrink.worst) {
      worst.push(row(w.sku, [w.name, w.sku, money.quantity(w.units), money.show(w.value, c)], "stop"));
    }
  }

  // Tax banded by the rate as it was on the line, which is what a VAT return
  // is made from. Nothing else in this system reports it.
  const tax_rows: desk.Row[] = [];
  if (tax !== null) {
    for (const r of tax.rates) {
      const bp = r.tax_bp;
      tax_rows.push(
        row(
          `r${bp}`,
          [
            `${div(bp, 100)}.${div(bp % 100, 10)}${bp % 10}`,
            money.show(r.net, c),
            money.show(r.tax, c),
            money.show(r.gross, c),
            `${r.sales}`,
          ],
          "",
        ),
      );
    }
    if (tax_rows.length > 0) {
      tax_rows.push(
        row(
          "tax-total",
          [words.t(l, "common.total"), money.show(tax.net, c), money.show(tax.tax, c), money.show(tax.gross, c), ""],
          "ok",
        ),
      );
    }
  }

  // Ranked by what it is worth, not by how long it has sat: the decision this
  // feeds is what to discount or send back, and a hundred kyat of dust is not
  // worth an afternoon.
  const now_at = browser.now();
  const dead_rows: desk.Row[] = [];
  if (dead !== null) {
    for (const d of dead.products) {
      const last = d.last_sold;
      dead_rows.push(
        touchable(
          d.id,
          [
            d.name,
            d.sku,
            money.quantity(d.stock),
            last > 0 ? `${div(now_at - last, 86400)}` : words.t(l, "reports.never_sold"),
            money.show(d.at_cost, c),
          ],
          "warn",
          "open-product",
          d.id,
        ),
      );
    }
  }

  return [
    {
      tag: "Meters",
      heading: words.t(l, "reports.the_trading_day"),
      note: words.t(l, "reports.thirty_days_by_hour"),
      rows: hours,
    },
    table(
      words.t(l, "common.products"),
      words.t(l, "reports.ranked_by_revenue"),
      [
        words.t(l, "common.product"),
        words.t(l, "products.sku"),
        words.t(l, "sales.sold"),
        words.t(l, "common.revenue"),
        words.t(l, "common.cost"),
        words.t(l, "common.margin_2"),
      ],
      products_rows,
    ),
    table(
      words.t(l, "common.categories"),
      "",
      [words.t(l, "common.category"), words.t(l, "sales.sold"), words.t(l, "common.revenue"), words.t(l, "common.margin_2")],
      categories_rows,
    ),
    table(
      words.t(l, "shift_detail.how_they_paid"),
      "",
      [words.t(l, "common.tender"), words.t(l, "common.count"), words.t(l, "common.amount")],
      tenders,
    ),
    table(
      words.t(l, "reports.by_cashier"),
      "",
      [words.t(l, "common.name"), words.t(l, "common.sales"), words.t(l, "common.takings")],
      by_staff,
    ),
    table(
      words.t(l, "reports.shrinkage"),
      words.t(l, "reports.waste_counts_and_corrections"),
      [words.t(l, "common.because"), words.t(l, "common.movements"), words.t(l, "common.units"), words.t(l, "common.value")],
      shrinkage,
    ),
    table(
      words.t(l, "reports.worst_affected"),
      "",
      [words.t(l, "common.product"), words.t(l, "products.sku"), words.t(l, "common.units"), words.t(l, "common.value")],
      worst,
    ),
    table(
      words.t(l, "reports.tax_collected_by_rate"),
      words.t(l, "reports.the_only_vat_output"),
      [
        words.t(l, "reports.rate"),
        words.t(l, "reports.net"),
        words.t(l, "common.tax"),
        words.t(l, "reports.gross"),
        words.t(l, "common.sales"),
      ],
      tax_rows,
    ),
    table(
      words.t(l, "reports.dead_stock"),
      words.t(l, "reports.on_the_shelf_not_selling"),
      [
        words.t(l, "common.product"),
        words.t(l, "products.sku"),
        words.t(l, "products.stock"),
        words.t(l, "reports.days_since_sold"),
        words.t(l, "common.value"),
      ],
      dead_rows,
    ),
  ];
}

export function expenses(answer: model.ExpenseReport, l: Lang, c: Currency): desk.Block[] {
  const rows: desk.Row[] = [];
  for (const e of answer.expenses) {
    rows.push(
      row(
        e.id,
        [
          browser.day_of(e.spent_at),
          // The account's name, or the code when the join found no account to
          // name.
          e.account_name.length > 0 ? e.account_name : e.account_code,
          e.category,
          or_dash(e.payee),
          e.reference,
          method_of(l, e.method),
          money.show(e.tax, c),
          money.show(e.amount, c),
        ],
        "",
      ),
    );
  }

  const totals = answer.totals;
  const spent = totals.amount;
  const tax = totals.tax;

  // One card per account, so "what is rent costing us" is a figure on the
  // screen rather than an addition somebody does in their head.
  const cards: desk.Stat[] = [
    {
      label: words.t(l, "expenses.spent"),
      value: money.show(spent, c),
      meta: `${words.fill_n(l, "accounting.n_entries", `${totals.count}`)} · ${words.fill(l, "accounting.n_net_of_tax", money.show(spent - tax, c))}`,
      tone: "warn",
    },
  ];
  for (const a of answer.by_account) {
    cards.push({
      label: a.account_name,
      value: money.show(a.amount, c),
      meta: words.fill_n(l, "accounting.n_entries", `${a.count}`),
      tone: "info",
    });
  }

  const category_names: string[] = [];
  const category_amount: number[] = [];
  const counts: string[] = [];
  for (const cat of answer.by_category) {
    category_names.push(cat.category);
    category_amount.push(cat.amount);
    counts.push(words.fill_n(l, "expenses.n_times", `${cat.count}`));
  }
  return [
    { tag: "Stats", items: cards },
    { tag: "Buttons", items: [desk.action(words.t(l, "expenses.record_an_expense"), "form-expense", "", "filled")] },
    {
      tag: "Meters",
      heading: words.t(l, "expenses.where_it_went"),
      note: words.t(l, "reports.by_category"),
      rows: meters(category_names, category_amount, counts, c),
    },
    table(
      words.t(l, "common.expenses"),
      words.t(l, "common.90_days"),
      [
        words.t(l, "common.date"),
        words.t(l, "common.account"),
        words.t(l, "expenses.what_for"),
        words.t(l, "expenses.paid_to"),
        words.t(l, "common.reference"),
        words.t(l, "common.how"),
        words.t(l, "common.tax"),
        words.t(l, "common.amount"),
      ],
      rows,
    ),
  ];
}

export function accounting_off(l: Lang): desk.Block[] {
  return [
    {
      tag: "Note",
      heading: words.t(l, "accounting.the_books_are_off"),
      body: words.t(l, "accounting.the_books_are_off_body"),
    },
    { tag: "Buttons", items: [desk.action(words.t(l, "common.settings"), "go", "settings", "filled")] },
  ];
}

/**
 * The tab strip, the window picker, and the way out to a file.
 *
 * A row of chips rather than a menu, because there are eight sheets and a
 * shopkeeper moves between them constantly — and because the selected one has
 * to be visible at a glance from across a back-office desk.
 */
function books_chrome(view: string, win: string, l: Lang): desk.Block[] {
  const sheets: desk.Action[] = [];
  // The second half of each pair is a phrase key rather than the phrase, so a
  // chip is named the same way the sheet under it is.
  for (const pair of [
    ["summary", "accounting.summary"],
    ["pl", "accounting.profit_and_loss"],
    ["balance", "accounting.balance_sheet"],
    ["trial", "accounting.trial_balance"],
    ["ledger", "accounting.general_ledger"],
    ["journal", "accounting.journal"],
    ["accounts", "accounting.chart_of_accounts"],
    ["periods", "accounting.periods"],
  ]) {
    sheets.push(desk.action(words.t(l, pair[1]), "books-view", pair[0], view === pair[0] ? "filled" : "quiet"));
  }
  const windows: desk.Action[] = [];
  for (const pair of [
    ["today", "common.today"],
    ["7", "common.7_days"],
    ["30", "common.30_days"],
    ["month", "common.month"],
    ["all", "common.all_time"],
  ]) {
    windows.push(desk.action(words.t(l, pair[1]), "books-window", pair[0], win === pair[0] ? "filled" : "quiet"));
  }
  const actions: desk.Action[] = [
    desk.action(words.t(l, "expenses.record_an_expense"), "form-expense", "", "soft"),
    desk.action(words.t(l, "accounting.close_a_month"), "form-close-period", "", "soft"),
  ];
  // Two buttons that belong to one sheet each rather than to the chrome: a
  // filter with nothing to filter, and an opening balance offered from a
  // trial balance, are both noise.
  if (view === "journal") {
    actions.push(desk.action(words.t(l, "accounting.filter_the_journal"), "books-filter", "", "soft"));
  } else if (view === "summary") {
    actions.push(desk.action(words.t(l, "accounting.opening_balances"), "books-opening", "", "quiet"));
  }
  actions.push(desk.action(words.t(l, "common.print"), "print", "", "quiet"));
  actions.push(desk.action(words.t(l, "accounting.export_this_sheet"), "books-export", view, "filled"));

  return [
    { tag: "Buttons", items: sheets },
    { tag: "Buttons", items: windows },
    { tag: "Buttons", items: actions },
  ];
}

/**
 * The sweep, as the shopkeeper sees it.
 *
 * The last table is deliberately not a failure. The shelves are valued at what
 * each product costs **today** and account 1200 carries what that stock cost
 * **when it was bought** — a supplier raising their price revalues the shelf
 * and must not rewrite history. Shown side by side with the reason, rather
 * than raised as an alarm nobody can act on.
 *
 * A sweep that did not arrive draws **nothing**. `office.load_accounting` lets
 * this one request fail on its own so that a slow sweep does not take the
 * revenue figure down with it, and every verdict on the panel is a boolean
 * that is false when it is missing — so a panel built from an absent sweep
 * would read "debits do not equal credits" and "the equation does not hold" in
 * red, about books that are very probably fine. Saying nothing is the only
 * honest answer to a question that was never answered.
 */
function books_health(sweep: model.Health | null, l: Lang, c: Currency): desk.Block[] {
  if (sweep === null) {
    return [];
  }
  const health = sweep;
  const sides = health.sides_agree;
  const unbalanced = health.unbalanced.length;
  const orphans = health.orphan_lines;
  const holds = health.equation_holds;
  const drift = health.stock_drift;
  const tabs = health.tab_drift;

  const checks: desk.Row[] = [
    row("debits", [words.t(l, "accounting.debits_equal_credits"), money.show(health.total_debit, c)], sides ? "ok" : "stop"),
    row("entries", [words.t(l, "accounting.journal_entries"), `${health.entries}`], ""),
    row("unbal", [words.t(l, "accounting.unbalanced_entries"), `${unbalanced}`], unbalanced === 0 ? "ok" : "stop"),
    row("orphans", [words.t(l, "accounting.lines_with_no_entry"), `${orphans}`], orphans === 0 ? "ok" : "stop"),
    row(
      "equation",
      [
        words.t(l, "accounting.accounting_equation"),
        holds ? words.t(l, "accounting.holds") : words.fill(l, "accounting.out_by_n", money.show(health.out_by, c)),
      ],
      holds ? "ok" : "stop",
    ),
    row(
      "stock",
      [
        words.t(l, "accounting.stock_matches_its_movements"),
        drift.length === 0 ? words.t(l, "accounting.yes") : words.fill_n(l, "accounting.n_adrift", `${drift.length}`),
      ],
      drift.length === 0 ? "ok" : "stop",
    ),
    row(
      "tabs",
      [
        words.t(l, "receivables.owed_matches_its_rows"),
        tabs.length === 0 ? words.t(l, "accounting.yes") : words.fill_n(l, "accounting.n_adrift", `${tabs.length}`),
      ],
      tabs.length === 0 ? "ok" : "stop",
    ),
    row("owed", [words.t(l, "receivables.owed_by_customers"), money.show(health.owed_by_customers, c)], ""),
    // Side by side rather than compared. The two are allowed to differ for
    // one reason — a shop that gave credit before switching the books on has
    // debts the ledger never saw — and the check that is *not* allowed to
    // fail is the row above it.
    row("receivable", [words.t(l, "receivables.owed_in_the_ledger"), money.show(health.receivable_in_ledger, c)], ""),
    row(
      "untendered",
      [
        words.t(l, "receivables.every_sale_was_paid_for"),
        health.untendered_sales.length === 0
          ? words.t(l, "accounting.yes")
          : words.fill_n(l, "accounting.n_adrift", `${health.untendered_sales.length}`),
      ],
      health.untendered_sales.length === 0 ? "ok" : "stop",
    ),
  ];

  const blocks: desk.Block[] = [
    table(
      words.t(l, "accounting.ledger_health"),
      words.t(l, "accounting.rechecked_every_time_this_page_is_opened"),
      [words.t(l, "accounting.check"), words.t(l, "accounting.reading")],
      checks,
    ),
  ];

  if (drift.length > 0) {
    const rows: desk.Row[] = [];
    for (const d of drift) {
      const stock = d.stock;
      const moved = d.moved;
      rows.push(
        row(d.sku, [d.name, d.sku, money.quantity(stock), money.quantity(moved), money.quantity(stock - moved)], "stop"),
      );
    }
    blocks.push(
      table(
        words.t(l, "accounting.stock_adrift_from_its_movements"),
        words.t(l, "accounting.the_level_against_what_moved_it"),
        [
          words.t(l, "common.product"),
          words.t(l, "products.sku"),
          words.t(l, "accounting.on_the_product"),
          words.t(l, "accounting.in_the_movements"),
          words.t(l, "accounting.adrift_by"),
        ],
        rows,
      ),
    );
  }

  if (tabs.length > 0) {
    const owing: desk.Row[] = [];
    for (const t of tabs) {
      owing.push(
        row(t.id, [t.name, money.show(t.owed, c), money.show(t.derived, c), money.show(t.owed - t.derived, c)], "stop"),
      );
    }
    blocks.push(
      table(
        words.t(l, "receivables.balances_adrift_from_their_rows"),
        words.t(l, "receivables.the_balance_against_what_moved_it"),
        [
          words.t(l, "common.customer"),
          words.t(l, "receivables.on_the_customer"),
          words.t(l, "receivables.in_the_rows"),
          words.t(l, "accounting.adrift_by"),
        ],
        owing,
      ),
    );
  }

  const shelf = health.stock_at_cost;
  const booked = health.stock_in_ledger;
  blocks.push(
    table(words.t(l, "accounting.stock_valuation"), words.t(l, "accounting.a_gap_here_is_normal"), ["", words.t(l, "common.amount")], [
      row("shelf", [words.t(l, "accounting.the_shelves_at_todays_cost"), money.show(shelf, c)], ""),
      row("booked", [words.t(l, "accounting.the_ledger_stock_on_hand"), money.show(booked, c)], ""),
      row("gap", [words.t(l, "accounting.difference"), money.show(shelf - booked, c)], ""),
    ]),
  );
  return blocks;
}

function books_summary(
  pl: model.ProfitAndLoss | null,
  sheet: model.BalanceSheet | null,
  health: model.Health | null,
  payables: model.Payables | null,
  win: string,
  l: Lang,
  c: Currency,
): desk.Block[] {
  // Each of the four is asked for separately and any of them may be missing —
  // "a health sweep that times out should not take the revenue figure down
  // with it". A missing one reads as zero here.
  let revenue = 0;
  let gross = 0;
  let net = 0;
  let cost_of_sales = 0;
  let operating = 0;
  if (pl !== null) {
    revenue = pl.revenue;
    gross = pl.gross_profit;
    net = pl.net_profit;
    cost_of_sales = pl.cost_of_sales;
    operating = pl.operating_expenses;
  }
  let out_by = 0;
  let total_assets = 0;
  let total_liabilities = 0;
  let total_equity = 0;
  let retained = 0;
  if (sheet !== null) {
    out_by = sheet.out_by;
    total_assets = sheet.total_assets;
    total_liabilities = sheet.total_liabilities;
    total_equity = sheet.total_equity;
    retained = sheet.retained_earnings;
  }
  let owed = 0;
  let overdue = 0;
  if (payables !== null) {
    owed = payables.totals.outstanding;
    overdue = payables.totals.overdue;
  }
  const margin = revenue > 0 ? div(gross * 100, revenue) : 0;

  const blocks: desk.Block[] = [
    {
      tag: "Stats",
      items: [
        {
          label: words.t(l, "common.revenue"),
          value: money.show(revenue, c),
          meta: `${window_of(l, win)} · ${words.t(l, "accounting.net_of_discounts_and_tax")}`,
          tone: "ok",
        },
        {
          label: words.t(l, "common.gross_profit"),
          value: money.show(gross, c),
          meta: words.fill(l, "common.n_margin", `${margin}%`),
          tone: gross < 0 ? "stop" : "ok",
        },
        {
          label: words.t(l, "accounting.net_profit"),
          value: money.show(net, c),
          meta: words.fill(l, "accounting.after_running_costs", money.show(operating, c)),
          tone: net < 0 ? "stop" : "ok",
        },
        {
          label: words.t(l, "accounting.owed_to_suppliers"),
          value: money.show(owed, c),
          meta: words.fill(l, "accounting.n_overdue", money.show(overdue, c)),
          tone: overdue > 0 ? "warn" : "info",
        },
      ],
    },
  ];
  for (const b of books_health(health, l, c)) {
    blocks.push(b);
  }
  blocks.push(
    table(words.t(l, "accounting.profit_and_loss_2"), window_of(l, win), ["", words.t(l, "common.amount")], [
      row("rev", [words.t(l, "common.revenue"), money.show(revenue, c)], ""),
      row("cogs", [words.t(l, "accounting.cost_of_sales"), money.show(cost_of_sales, c)], ""),
      row("gross", [words.t(l, "common.gross_profit"), money.show(gross, c)], "ok"),
      row("opex", [words.t(l, "accounting.running_costs"), money.show(operating, c)], ""),
      row("net", [words.t(l, "accounting.net_profit"), money.show(net, c)], net < 0 ? "stop" : "ok"),
    ]),
  );
  blocks.push(
    table(words.t(l, "accounting.balance_sheet"), words.t(l, "accounting.as_at_today"), ["", words.t(l, "common.amount")], [
      row("as", [words.t(l, "accounting.assets"), money.show(total_assets, c)], ""),
      row("li", [words.t(l, "accounting.liabilities"), money.show(total_liabilities, c)], ""),
      row("eq", [words.t(l, "accounting.equity"), money.show(total_equity, c)], ""),
      row("re", [words.t(l, "accounting.retained_profit"), money.show(retained, c)], ""),
      row(
        "ck",
        [words.t(l, "accounting.balances"), out_by === 0 ? words.t(l, "accounting.yes") : money.show(out_by, c)],
        out_by === 0 ? "ok" : "stop",
      ),
    ]),
  );
  return blocks;
}

/**
 * Profit and loss, **account by account**.
 *
 * Discounts are kept visible rather than netted away: revenue is booked at the
 * shelf price and what was given away sits against it, so "how much did we
 * discount this month" is a number that can be read rather than reconstructed.
 */
function books_pl(sheet: model.ProfitAndLoss | null, win: string, l: Lang, c: Currency): desk.Block[] {
  // Unreachable on this sheet: `office` fails the whole screen when the
  // profit and loss will not load, rather than drawing the page without it.
  // The guard is here because the type admits it, not because it happens.
  if (sheet === null) {
    return [];
  }
  const pl = sheet;
  const rows: desk.Row[] = [];
  for (const a of pl.income) {
    rows.push(
      touchable(
        `i${a.code}`,
        [words.t(l, "common.revenue"), a.code, a.name, money.show(a.amount, c)],
        "",
        "books-account",
        a.code,
      ),
    );
  }
  rows.push(row("revenue", ["", "", words.t(l, "common.revenue"), money.show(pl.revenue, c)], "ok"));
  for (const e of pl.expenses) {
    const code = e.code;
    // The same split the totals use, so the sections and the footer cannot
    // disagree about which account is a cost of sale.
    const section =
      code === "5000" || code === "5100" ? words.t(l, "accounting.cost_of_sales") : words.t(l, "accounting.running_costs");
    rows.push(touchable(`e${code}`, [section, code, e.name, money.show(e.amount, c)], "", "books-account", code));
  }
  rows.push(row("cogs", ["", "", words.t(l, "accounting.cost_of_sales"), money.show(pl.cost_of_sales, c)], ""));
  rows.push(row("gross", ["", "", words.t(l, "common.gross_profit"), money.show(pl.gross_profit, c)], "ok"));
  rows.push(row("opex", ["", "", words.t(l, "accounting.running_costs"), money.show(pl.operating_expenses, c)], ""));
  const net = pl.net_profit;
  rows.push(row("net", ["", "", words.t(l, "accounting.net_profit"), money.show(net, c)], net < 0 ? "stop" : "ok"));
  return [
    table(
      words.t(l, "accounting.profit_and_loss_2"),
      `${window_of(l, win)} · ${words.t(l, "accounting.touch_an_account_for_its_ledger")}`,
      [words.t(l, "accounting.section"), words.t(l, "common.code"), words.t(l, "common.account"), words.t(l, "common.amount")],
      rows,
    ),
  ];
}

/** One section of a balance sheet, as touchable rows. */
function balance_rows(prefix: string, section: string, accounts: model.AccountBalance[], c: Currency): desk.Row[] {
  return accounts.map((a) =>
    touchable(`${prefix}${a.code}`, [section, a.code, a.name, money.show(a.amount, c)], "", "books-account", a.code),
  );
}

/**
 * The balance sheet, or nothing at all.
 *
 * The sheet draws nothing rather than a sheet of zeros when it is absent: the
 * totals row asserts that assets less liabilities and equity is 0 and paints
 * itself green for it, which on an answer that never came is a clean bill of
 * health invented on this side of the wire.
 */
function books_balance(as_at: model.BalanceSheet | null, l: Lang, c: Currency): desk.Block[] {
  if (as_at === null) {
    return [];
  }
  const sheet = as_at;
  const rows: desk.Row[] = [];
  for (const r of balance_rows("assets", words.t(l, "accounting.asset"), sheet.assets, c)) {
    rows.push(r);
  }
  for (const r of balance_rows("liabilities", words.t(l, "accounting.liability"), sheet.liabilities, c)) {
    rows.push(r);
  }
  for (const r of balance_rows("equity", words.t(l, "accounting.equity"), sheet.equity, c)) {
    rows.push(r);
  }
  rows.push(
    row(
      "re",
      [
        words.t(l, "accounting.equity"),
        "",
        `${words.t(l, "accounting.retained_profit")}, ${words.t(l, "accounting.not_yet_moved_to_equity")}`,
        money.show(sheet.retained_earnings, c),
      ],
      "",
    ),
  );
  const out_by = sheet.out_by;
  rows.push(row("ta", ["", "", words.t(l, "accounting.total_assets"), money.show(sheet.total_assets, c)], ""));
  rows.push(row("tl", ["", "", words.t(l, "accounting.total_liabilities"), money.show(sheet.total_liabilities, c)], ""));
  rows.push(row("te", ["", "", words.t(l, "accounting.total_equity"), money.show(sheet.total_equity, c)], ""));
  rows.push(
    row(
      "ck",
      ["", "", words.t(l, "accounting.assets_less_liabilities_and_equity"), money.show(out_by, c)],
      out_by === 0 ? "ok" : "stop",
    ),
  );
  return [
    table(
      words.t(l, "accounting.balance_sheet"),
      `${words.t(l, "accounting.as_at_today")} · ${words.t(l, "accounting.touch_an_account_for_its_ledger")}`,
      [words.t(l, "accounting.section"), words.t(l, "common.code"), words.t(l, "common.account"), words.t(l, "common.amount")],
      rows,
    ),
  ];
}

/**
 * Every account with its debits, credits and balance — and a way in.
 *
 * Touching a row opens that account's general ledger. Without it a trial
 * balance is a list of figures with no way to ask where any of them came
 * from, which is the one question it exists to raise.
 */
function books_trial(balance: model.TrialBalance | null, win: string, l: Lang, c: Currency): desk.Block[] {
  // As in `books_pl`: `office` fails the screen instead, so this cannot fire.
  if (balance === null) {
    return [];
  }
  const trial = balance;
  const rows: desk.Row[] = [];
  for (const line of trial.lines) {
    const code = line.code;
    const debit = line.debit;
    const credit = line.credit;
    rows.push(
      touchable(
        `t${code}`,
        [
          code,
          line.name,
          account_kind_of(l, line.kind),
          debit === 0 ? "" : money.show(debit, c),
          credit === 0 ? "" : money.show(credit, c),
          money.show(debit - credit, c),
        ],
        "",
        "books-account",
        code,
      ),
    );
  }
  const td = trial.total_debit;
  const tc = trial.total_credit;
  rows.push(
    row(
      "total",
      [
        "",
        words.t(l, "accounting.totals"),
        "",
        money.show(td, c),
        money.show(tc, c),
        td === tc ? words.t(l, "common.balanced") : money.show(td - tc, c),
      ],
      td === tc ? "ok" : "stop",
    ),
  );
  return [
    table(
      words.t(l, "accounting.trial_balance"),
      `${window_of(l, win)} · ${words.t(l, "accounting.touch_a_row_for_its_ledger")}`,
      [
        words.t(l, "common.code"),
        words.t(l, "common.account"),
        words.t(l, "common.type"),
        words.t(l, "accounting.debits"),
        words.t(l, "accounting.credits"),
        words.t(l, "common.balance"),
      ],
      rows,
    ),
  ];
}

/** One account, movement by movement, with the balance after each. */
function books_ledger(opened: model.Ledger | null, code: string, win: string, l: Lang, c: Currency): desk.Block[] {
  if (code.length === 0) {
    return [
      { tag: "Note", heading: words.t(l, "accounting.pick_an_account"), body: words.t(l, "accounting.pick_an_account_body") },
    ];
  }
  // An account is named and `office` fetches its ledger under exactly that
  // condition, failing the screen if it will not come. As in `books_pl`.
  if (opened === null) {
    return [];
  }
  const ledger = opened;
  const account = ledger.account;
  const rows: desk.Row[] = [
    row("opening", ["", "", words.t(l, "accounting.opening_balance"), "", "", "", money.show(ledger.opening, c)], ""),
  ];
  for (const line of ledger.lines) {
    const amount = line.amount;
    rows.push(
      row(
        line.entry_id + line.number,
        [
          browser.day_of(line.value_at),
          line.number,
          line.line_memo.length > 0 ? line.line_memo : line.memo,
          caused_by_of(l, line.ref_type),
          amount > 0 ? money.show(amount, c) : "",
          amount < 0 ? money.show(0 - amount, c) : "",
          money.show(line.balance, c),
        ],
        "",
      ),
    );
  }
  rows.push(row("closing", ["", "", words.t(l, "accounting.closing_balance"), "", "", "", money.show(ledger.closing, c)], "ok"));
  return [
    table(
      `${account.code} ${account.name}`,
      `${window_of(l, win)} · ${account_kind_of(l, account.kind)} · ${words.fill(l, "accounting.n_normal", normal_of(l, account.normal))}`,
      [
        words.t(l, "common.date"),
        words.t(l, "accounting.entry"),
        words.t(l, "accounting.memo"),
        words.t(l, "accounting.caused_by"),
        words.t(l, "accounting.debit"),
        words.t(l, "accounting.credit"),
        words.t(l, "common.balance"),
      ],
      rows,
    ),
  ];
}

/**
 * The journal, **with the lines that make each entry up**.
 *
 * Each entry is followed by its legs, indented by an empty first cell — a
 * journal with no debits and no credits on it would be a list of events rather
 * than a journal.
 */
function books_journal(book: model.Journal | null, win: string, l: Lang, c: Currency): desk.Block[] {
  // As in `books_pl`: `office` fails the screen instead, so this cannot fire.
  if (book === null) {
    return [];
  }
  const journal = book;
  const lines = journal.lines;
  const rows: desk.Row[] = [];
  for (const e of journal.entries) {
    const id = e.id;
    rows.push(
      touchable(
        `e${id}`,
        [e.number, browser.day_of(e.value_at), e.memo, caused_by_of(l, e.ref_type), or_dash(e.user_name), "", ""],
        e.corrects_id.length > 0 ? "warn" : "",
        "books-reverse",
        id,
      ),
    );
    for (const line of lines) {
      if (line.entry_id === id) {
        const amount = line.amount;
        rows.push(
          row(
            `l${line.id}`,
            [
              "",
              "",
              `${line.account_code} ${line.account_name}`,
              line.memo,
              "",
              amount > 0 ? money.show(amount, c) : "",
              amount < 0 ? money.show(0 - amount, c) : "",
            ],
            "",
          ),
        );
      }
    }
  }
  const shown = journal.shown;
  const total = journal.total;
  // "3 / 40" rather than "3 of 40": a word between two numbers has to be
  // ordered, and the slash reads the same in both languages.
  return [
    table(
      words.t(l, "accounting.journal"),
      `${window_of(l, win)} · ${words.fill_n(l, "accounting.n_entries_newest_first", `${shown} / ${total}`)} · ${words.t(l, "accounting.touch_an_entry_to_correct_it")}`,
      [
        words.t(l, "accounting.entry"),
        words.t(l, "common.date"),
        words.t(l, "common.detail"),
        words.t(l, "accounting.caused_by"),
        words.t(l, "settings.who"),
        words.t(l, "accounting.debit"),
        words.t(l, "accounting.credit"),
      ],
      rows,
    ),
  ];
}

function books_accounts(accounts: model.Account[], l: Lang, _c: Currency): desk.Block[] {
  const rows: desk.Row[] = [];
  for (const a of accounts) {
    const code = a.code;
    rows.push(
      touchable(`a${code}`, [code, a.name, account_kind_of(l, a.kind), normal_of(l, a.normal)], "", "books-account", code),
    );
  }
  return [
    table(
      words.t(l, "accounting.chart_of_accounts"),
      words.t(l, "accounting.touch_an_account_for_its_ledger"),
      [words.t(l, "common.code"), words.t(l, "common.name"), words.t(l, "common.kind"), words.t(l, "accounting.normal_balance")],
      rows,
    ),
  ];
}

/**
 * Months that have been closed, and the way back out of one.
 *
 * Reopening is a real button rather than a support call. Closing is the guard
 * against a backdated correction landing in a month already reported to the
 * outside world — reopening is admitting the report was wrong, which happens.
 */
function books_periods(summary: model.BooksSummary, l: Lang, _c: Currency): desk.Block[] {
  const periods = summary.periods;
  if (periods.length === 0) {
    return [
      {
        tag: "Note",
        heading: words.t(l, "accounting.no_month_has_been_closed"),
        body: words.t(l, "accounting.closing_a_month_stops_anything"),
      },
      { tag: "Buttons", items: [desk.action(words.t(l, "accounting.close_a_month"), "form-close-period", "", "filled")] },
    ];
  }
  const rows: desk.Row[] = [];
  for (const p of periods) {
    const closed = p.closed_at;
    rows.push(
      touchable(
        p.id,
        [
          browser.day_of(p.starts_at),
          browser.day_of(p.ends_at),
          closed > 0 ? browser.day_of(closed) : words.t(l, "common.open_state"),
          p.note,
          closed > 0 ? words.t(l, "accounting.reopen") : "",
        ],
        closed > 0 ? "ok" : "",
        "books-reopen",
        p.id,
      ),
    );
  }
  return [
    table(
      words.t(l, "accounting.fiscal_periods"),
      words.t(l, "accounting.touch_a_closed_month_to_reopen_it"),
      [words.t(l, "movements.from"), words.t(l, "movements.to"), words.t(l, "common.closed"), words.t(l, "common.note"), ""],
      rows,
    ),
  ];
}

/**
 * What the books screen was able to fetch.
 *
 * A bundle rather than nine positional parameters: the sheets do not all need
 * the same data, and threading them all through would mean every new sheet
 * changes the signature of all of them.
 *
 * Every field but `summary` may be absent, and that is the point of the type
 * rather than an inconvenience of it. `office.load_accounting` asks only for
 * what the open sheet needs — eight requests to look at one would be eight
 * round trips — so on any given draw most of these are legitimately absent.
 * The summary is the exception: nothing is drawn at all until it has arrived,
 * because it is what says whether the books are switched on.
 */
export interface Books {
  summary: model.BooksSummary;
  pl: model.ProfitAndLoss | null;
  sheet: model.BalanceSheet | null;
  health: model.Health | null;
  payables: model.Payables | null;
  trial: model.TrialBalance | null;
  journal: model.Journal | null;
  accounts: model.Account[];
  ledger: model.Ledger | null;
}

/**
 * A bundle with nothing in it but the summary.
 *
 * The starting point `office` fills in, so a sheet nobody asked for is absent
 * rather than stale from the last time it was open.
 */
export function books_of(summary: model.BooksSummary): Books {
  return {
    summary,
    pl: null,
    sheet: null,
    health: null,
    payables: null,
    trial: null,
    journal: null,
    accounts: [],
    ledger: null,
  };
}

/** The books, whichever sheet is open. */
export function accounting(view: string, win: string, data: Books, code: string, l: Lang, c: Currency): desk.Block[] {
  const blocks = books_chrome(view, win, l);
  let body: desk.Block[];
  switch (view) {
    case "pl":
      body = books_pl(data.pl, win, l, c);
      break;
    case "balance":
      body = books_balance(data.sheet, l, c);
      break;
    case "trial":
      body = books_trial(data.trial, win, l, c);
      break;
    case "ledger":
      body = books_ledger(data.ledger, code, win, l, c);
      break;
    case "journal":
      body = books_journal(data.journal, win, l, c);
      break;
    case "accounts":
      body = books_accounts(data.accounts, l, c);
      break;
    case "periods":
      body = books_periods(data.summary, l, c);
      break;
    // Summary is the default sheet, so it is also the sheet an unknown view
    // falls to rather than an empty page.
    default:
      body = books_summary(data.pl, data.sheet, data.health, data.payables, win, l, c);
      break;
  }
  for (const b of body) {
    blocks.push(b);
  }
  return blocks;
}

export function settings(answer: Doc, l: Lang): desk.Block[] {
  const s = doc.field(answer, "settings");
  const rows: desk.Row[] = [];
  // Setting key on the left, phrase key on the right: the first is what the
  // shop stores and never translates, the second is what a reader is shown.
  for (const pair of [
    ["shop.name", "settings.shop_name"],
    ["shop.name_my", "settings.shop_name_my"],
    ["shop.address", "common.address"],
    ["shop.phone", "common.phone"],
    ["shop.tax_id", "common.tax_id"],
    ["shop.receipt_footer", "settings.receipt_footer"],
    ["currency.code", "settings.currency"],
    ["currency.symbol", "settings.symbol"],
    ["currency.minor_units", "settings.decimal_places"],
    ["currency.symbol_first", "settings.symbol_first"],
    ["tax.inclusive", "settings.prices_include_tax"],
    ["tax.default_bp", "settings.default_tax_bp"],
    ["locale.default", "settings.language"],
    ["loyalty.points_per_unit", "settings.loyalty_points_per_unit"],
    ["accounting.enabled", "settings.accounting_on"],
  ]) {
    const key = pair[0];
    rows.push(row(key, [words.t(l, pair[1]), key, doc.text(s, key, "")], ""));
  }
  return [
    {
      tag: "Buttons",
      items: [
        desk.action(words.t(l, "settings.edit_settings"), "form-settings", "", "filled"),
        desk.action(words.t(l, "accounting.close_a_month"), "form-close-period", "", "soft"),
      ],
    },
    table(
      words.t(l, "settings.the_shop"),
      "",
      [words.t(l, "settings.setting"), words.t(l, "common.code"), words.t(l, "common.value")],
      rows,
    ),
  ];
}
