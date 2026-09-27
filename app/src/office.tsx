//! The back office: the rail, the screens, and what a press means.
//!
//! The wiring. `screens.ts` says what each screen shows, `forms.ts` says what
//! each dialog asks for, `office_view.tsx` draws both, and this file is the
//! three-way join: it loads, it dispatches, and it submits.
//!
//! ## One vocabulary
//!
//! A `data-action` on a button, a row or a form is a string, and the same
//! string appears in exactly three places: where the block names it, in
//! [`pressed`], and — for anything that writes — in [`submit`]. Adding a
//! feature is a form constructor, an arm in each of those two, and an API call.
//!
//! ## Drawing is explicit
//!
//! As at the till, the state is one mutable value and nothing reaches the
//! screen until `repaint` says so, synchronously.

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { MouseEvent } from "react";
import * as api from "./api.ts";
import type { Body } from "./api.ts";
import * as browser from "./browser.ts";
import * as desk from "./desk.ts";
import type { App } from "./desk.ts";
import * as doc from "./doc.ts";
import * as forms from "./forms.ts";
import * as i18n from "./i18n.ts";
import type * as model from "./model.ts";
import * as money from "./money.ts";
import { Page } from "./office_view.tsx";
import * as screens from "./screens.ts";
import * as words from "./words.ts";
import { parse_float, parse_int, token, trim } from "./lang.ts";

let view: Root | null = null;

function repaint(app: App): void {
  // The stylesheet keys Burmese's taller line box off the document's own
  // `lang`, so this write is what makes မြန်မာ legible rather than cramped.
  // Written on every repaint rather than only on the switch, because a
  // reload restores the kept language and nothing else would announce it.
  browser.set_document_lang(i18n.tag_of(app.lang));
  const root = view;
  if (root === null) {
    return;
  }
  try {
    flushSync(() => root.render(<Page app={app} press={(e) => clicked(app, e)} />));
  } catch (e) {
    console.error(`office: could not draw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const field_value = browser.field_value;

/** An answer, or the error the call failed with — tested where it arrived. */
async function attempt<T>(call: Promise<T>): Promise<[T, null] | [null, Error]> {
  try {
    return [await call, null];
  } catch (e) {
    return [null, e instanceof Error ? e : new Error(String(e))];
  }
}

/** Seconds in a day. A window into the past is written `30 * DAY`. */
const DAY = 86400;

// ---- signing in ------------------------------------------------------------

function submit_sign_in(app: App): void {
  if (app.signing_in) {
    return;
  }
  const username = field_value("#username");
  const password = field_value("#password");
  if (username.length === 0 || password.length === 0) {
    return;
  }
  desk.signing_in(app, true);
  repaint(app);
  void do_sign_in(app, username, password);
}

async function do_sign_in(app: App, username: string, password: string): Promise<void> {
  const [session, err] = await attempt(api.sign_in_with_password(username, password));
  if (err !== null) {
    desk.signing_in(app, false);
    desk.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  browser.keep("kite-office.token", session.token);
  desk.signed_in(app, session);
  repaint(app);
  load(app);
  void load_header(app);
  void load_refs(app);
}

async function resume(app: App, kept_token: string): Promise<void> {
  const [session, err] = await attempt(api.whoami(kept_token));
  if (err !== null) {
    browser.drop_kept("kite-office.token");
    desk.restoring(app, false);
    repaint(app);
    return;
  }
  desk.signed_in(app, session);
  repaint(app);
  load(app);
  void load_header(app);
  void load_refs(app);
}

function sign_off(app: App): void {
  const kept_token = desk.token_of(app);
  browser.drop_kept("kite-office.token");
  desk.signed_out(app);
  repaint(app);
  void do_sign_out(kept_token);
}

async function do_sign_out(kept_token: string): Promise<void> {
  const [, err] = await attempt(api.sign_out(kept_token));
  if (err !== null) {
    console.error("office: sign-out did not reach the server");
  }
}

/**
 * The lists every dropdown is built from.
 *
 * Asked for once on arrival rather than per form, because a shop's categories
 * and suppliers change about as often as its address and a dialog that waits
 * on two requests before it opens feels broken. A missing list is a screen
 * with an empty dropdown rather than a failure worth stopping for.
 */
async function load_refs(app: App): Promise<void> {
  const tok = desk.token_of(app);
  let categories: model.CatalogCategory[] = [];
  const [cats, cerr] = await attempt(api.categories(tok));
  if (cerr === null) {
    categories = cats;
  }
  let suppliers: model.Supplier[] = [];
  const [sups, serr] = await attempt(api.suppliers(tok));
  if (serr === null) {
    suppliers = sups;
  }
  let products: model.CatalogProduct[] = [];
  const [prods, perr] = await attempt(api.products(tok, ""));
  if (perr === null) {
    products = prods;
  }
  let registers: model.Lane[] = [];
  const [lanes, lerr] = await attempt(api.lanes(tok));
  if (lerr === null) {
    registers = lanes;
  }
  desk.took_refs(app, categories, suppliers, products, registers);

  let expense_accounts: model.AccountOption[] = [];
  const [chart, aerr] = await attempt(api.expense_accounts(tok));
  if (aerr === null) {
    expense_accounts = chart;
  }
  desk.took_expense_accounts(app, expense_accounts);

  let chart_accounts: model.Account[] = [];
  const [whole, werr] = await attempt(api.accounts(tok));
  if (werr === null) {
    chart_accounts = whole;
  }
  desk.took_accounts(app, chart_accounts);

  const [settings, terr] = await attempt(api.settings(tok));
  if (terr === null) {
    const values = doc.field(settings, "settings");
    desk.took_settings(app, values);
    // Seed from the shop's own `locale.default` when nobody at this desk has
    // chosen yet.
    if (browser.kept("kite-office.lang") === null) {
      const code = doc.text(values, "locale.default", "en");
      desk.set_lang(app, i18n.of_code(code));
      repaint(app);
    }
  }
}

async function load_header(app: App): Promise<void> {
  const [answer, err] = await attempt(api.lanes(desk.token_of(app)));
  if (err !== null) {
    return;
  }
  let open = 0;
  let offline = 0;
  let expected = 0;
  for (const lane of answer) {
    const state = lane.state;
    if (state === "open" || state === "offline") {
      open = open + 1;
    }
    if (state === "offline") {
      offline = offline + 1;
    }
    expected = expected + lane.drawer_expected;
  }
  desk.lanes_are(app, open, offline, money.show(expected, desk.currency_of(app)));
  if (open > 0) {
    desk.badge(app, "tills", `${open}`);
  } else {
    desk.unbadge(app, "tills");
  }
  repaint(app);
}

// ---- filling a screen ------------------------------------------------------

function load(app: App): void {
  desk.working(app, true);
  repaint(app);
  const s = app.screen;
  switch (s.tag) {
    case "Overview":
      void load_overview(app);
      return;
    case "Tills":
      void load_tills(app);
      return;
    case "Sales":
      void load_sales(app);
      return;
    case "Shifts":
      void load_shifts(app);
      return;
    case "Products":
      void load_products(app);
      return;
    case "Inventory":
      void load_inventory(app);
      return;
    case "Movements":
      void load_movements(app);
      return;
    case "Purchasing":
      void load_purchasing(app);
      return;
    case "Suppliers":
      void load_suppliers(app);
      return;
    case "Customers":
      void load_customers(app);
      return;
    case "Promotions":
      void load_promotions(app);
      return;
    case "Reports":
      void load_reports(app);
      return;
    case "Accounting":
      void load_accounting(app);
      return;
    case "Expenses":
      void load_expenses(app);
      return;
    case "Staff":
      void load_staff(app);
      return;
    case "Settings":
      void load_settings(app);
      return;
    case "Product":
      void load_product(app, s.id);
      return;
    case "Sale":
      void load_sale(app, s.id);
      return;
    case "Shift":
      void load_shift(app, s.id);
      return;
    case "Order":
      void load_order(app, s.id);
      return;
  }
}

function failed(app: App, why: string): void {
  desk.went_wrong(app, why);
  repaint(app);
}

function done(app: App, blocks: desk.Block[]): void {
  desk.took(app, blocks);
  repaint(app);
}

/**
 * A screen's answer, for the screen that asked for it.
 *
 * A shopkeeper who taps Products and then Purchasing before Products has
 * answered used to see the product list land on the Purchasing page. Each
 * loader says which screen it was loading for: the answer is always kept for
 * that screen, and only drawn if it is still the one on show.
 */
function done_for(app: App, asked: desk.Screen, blocks: desk.Block[]): void {
  desk.took_for(app, asked, blocks);
  repaint(app);
}

/**
 * A refusal, for the screen that asked. One for a screen already left is
 * dropped: its trouble bar would sit over a page it says nothing about.
 */
function failed_for(app: App, asked: desk.Screen, why: string): void {
  if (desk.slug_of(asked) === desk.slug_of(app.screen)) {
    failed(app, why);
  }
}

async function load_overview(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.overview(desk.token_of(app)));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.overview(answer, desk.lang_of(app), desk.currency_of(app), desk.who_of(app)));
}

async function load_tills(app: App): Promise<void> {
  const asked = app.screen;
  const tok = desk.token_of(app);
  const [answer, err] = await attempt(api.lanes(tok));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  let entries: model.AuditEntry[] = [];
  const [audit, aerr] = await attempt(api.audit(tok, browser.now() - DAY));
  if (aerr === null) {
    entries = audit;
  }
  done_for(app, asked, screens.tills(answer, entries, desk.lang_of(app), desk.currency_of(app)));
}

async function load_sales(app: App): Promise<void> {
  const asked = app.screen;
  // Seven days back from this device's clock, and no upper bound — the
  // Worker's own now is the only honest end for a window that means "until
  // now". See `api.sales_history`.
  const [answer, err] = await attempt(api.sales_history(desk.token_of(app), browser.now() - 7 * DAY));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.sales(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_sale(app: App, id: string): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.sale(desk.token_of(app), id));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  desk.took_sale_lines(app, answer.lines);
  done_for(app, asked, screens.sale_detail(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_shifts(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.shifts(desk.token_of(app)));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.shifts(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_shift(app: App, id: string): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.shift(desk.token_of(app), id));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.shift_detail(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_products(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.products(desk.token_of(app), app.query));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.products(answer, desk.lang_of(app), desk.currency_of(app), app.query));
}

async function load_product(app: App, id: string): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.product(desk.token_of(app), id));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  desk.took_product(app, answer.product);
  done_for(app, asked, screens.product_detail(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_categories(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.categories(desk.token_of(app)));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.categories(answer, desk.lang_of(app)));
}

async function load_suppliers(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.suppliers(desk.token_of(app)));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.suppliers(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_inventory(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.inventory(desk.token_of(app)));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  const attention = answer.totals.low + answer.totals.out;
  if (attention > 0) {
    desk.badge(app, "inventory", `${attention}`);
  } else {
    desk.unbadge(app, "inventory");
  }
  done_for(app, asked, screens.inventory(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_movements(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.movements(desk.token_of(app), browser.now() - 7 * DAY, ""));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.movements(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_purchasing(app: App): Promise<void> {
  const asked = app.screen;
  const tok = desk.token_of(app);
  const [sheet, err] = await attempt(api.worksheet(tok, 28));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  let os: model.PurchaseOrder[] = [];
  const [orders, oerr] = await attempt(api.purchase_orders(tok));
  if (oerr === null) {
    os = orders;
  }
  let ps: model.Payables | null = null;
  const [payables, perr] = await attempt(api.payables(tok));
  if (perr === null) {
    ps = payables;
    desk.took_invoices(app, payables.invoices);
  }
  desk.took_purchasing(app, sheet, os, ps);
  done_for(
    app,
    asked,
    screens.purchasing(sheet, os, ps, app.goods_in, desk.goods_in_total(app), desk.lang_of(app), desk.currency_of(app)),
  );
}

async function load_order(app: App, id: string): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.order(desk.token_of(app), id));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  desk.took_order(app, answer.order, answer.lines);
  done_for(app, asked, screens.order_detail(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_customers(app: App): Promise<void> {
  const asked = app.screen;
  const tok = desk.token_of(app);
  const [answer, err] = await attempt(api.customers(tok));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  // Kept for the two dialogs that need a row rather than an id — the edit
  // form, and the picker that takes money off a tab.
  desk.took_customers(app, answer);

  // What is owed is fetched beside the list and is allowed to fail on its
  // own: a shopkeeper who cannot see the aging table can still edit a
  // customer, and `screens.customers` skips the table rather than drawing it
  // with zeros in it.
  let debts: model.Receivables | null = null;
  const [owed, oerr] = await attempt(api.receivables(tok));
  if (oerr === null) {
    debts = owed;
  }

  // The rail carries what is late, not what is outstanding. A tab a week old
  // is the shop working normally; one over sixty days is the thing a manager
  // opened the back office to deal with.
  if (debts !== null) {
    // **The badge counts the people it is about**, so it matches something
    // on the screen it opens.
    let late = 0;
    for (const a of debts.aging.rows) {
      if (a.d90 + a.d90up > 0) {
        late = late + 1;
      }
    }
    if (late > 0) {
      desk.badge(app, "customers", `${late}`);
    } else {
      desk.unbadge(app, "customers");
    }
  }

  done_for(app, asked, screens.customers(answer, debts, desk.lang_of(app), desk.currency_of(app)));
}

async function load_promotions(app: App): Promise<void> {
  const asked = app.screen;
  const tok = desk.token_of(app);
  const [answer, err] = await attempt(api.promotions(tok));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  let p: model.PromotionResult[] = [];
  const [perf, perr] = await attempt(api.promotion_performance(tok, browser.now() - 30 * DAY));
  if (perr === null) {
    p = perf;
  }
  // `[0]` is the offers and `[1]` the moment the server judged them at — see
  // `api.promotions`, which is where the pair is named.
  done_for(app, asked, screens.promotions(answer[0], answer[1], p, desk.lang_of(app), desk.currency_of(app)));
}

async function load_reports(app: App): Promise<void> {
  const asked = app.screen;
  const tok = desk.token_of(app);
  // Zero is "up to now", resolved by the Worker — the same rule
  // `desk.window_seconds` states for the books.
  const to = 0;
  const from = browser.now() - 30 * DAY;
  const [products, err] = await attempt(api.product_report(tok, from, to));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  let d: model.SalesReport | null = null;
  const [daily, derr] = await attempt(api.sales_report(tok, from, to));
  if (derr === null) {
    d = daily;
  }
  let s: model.ShrinkageReport | null = null;
  const [shrink, serr] = await attempt(api.shrinkage(tok, from, to));
  if (serr === null) {
    s = shrink;
  }
  let tax: model.TaxReport | null = null;
  const [rates, terr] = await attempt(api.tax_report(tok, from, to));
  if (terr === null) {
    tax = rates;
  }
  let dead: model.DeadStockReport | null = null;
  const [idle, ierr] = await attempt(api.dead_stock(tok, 60));
  if (ierr === null) {
    dead = idle;
  }
  done_for(app, asked, screens.reports(products, d, s, tax, dead, desk.lang_of(app), desk.currency_of(app)));
}

/**
 * Fetch only what the open sheet needs.
 *
 * Eight sheets, and loading all of them on every switch would be eight round
 * trips to look at one. The summary is the exception: it is a page *about*
 * the whole of the books, so it reads several and each of those is allowed to
 * fail on its own — a health sweep that times out should not take the
 * revenue figure down with it.
 */
async function load_accounting(app: App): Promise<void> {
  const asked = app.screen;
  const tok = desk.token_of(app);
  const [summary, serr] = await attempt(api.accounting_summary(tok));
  if (serr !== null) {
    failed_for(app, asked, serr.message);
    return;
  }
  if (!summary.enabled) {
    done_for(app, asked, screens.accounting_off(desk.lang_of(app)));
    return;
  }

  const sheet_name = app.books_view;
  const span = desk.window_seconds(app.books_window, browser.now());
  const from = span[0];
  const to = span[1];

  // A bundle the sheets each read their own corner of — see [`screens.Books`].
  // Anything that failed is left absent, which is what every reader treats as
  // "not loaded".
  let data = screens.books_of(summary);

  if (sheet_name === "summary" || sheet_name === "pl") {
    const [pl, perr] = await attempt(api.profit_and_loss(tok, from, to));
    if (perr !== null) {
      failed_for(app, asked, perr.message);
      return;
    }
    data = { ...data, pl };
  }
  if (sheet_name === "summary" || sheet_name === "balance") {
    const [sheet, berr] = await attempt(api.balance_sheet(tok, to));
    // Reported rather than swallowed. The screen draws nothing for a sheet it
    // does not have — an invented clean bill of health is worse — but on the
    // Balance tab that would leave the manager looking at an empty page with
    // no way to tell a failed request from an empty ledger.
    if (berr !== null) {
      failed_for(app, asked, berr.message);
      return;
    }
    data = { ...data, sheet };
  }
  if (sheet_name === "summary") {
    const [health, herr] = await attempt(api.books_health(tok));
    if (herr === null) {
      data = { ...data, health };
    }
    const [owing, oerr] = await attempt(api.payables(tok));
    if (oerr === null) {
      data = { ...data, payables: owing };
    }
  }
  if (sheet_name === "trial") {
    const [trial, terr] = await attempt(api.trial_balance(tok, from, to));
    if (terr !== null) {
      failed_for(app, asked, terr.message);
      return;
    }
    data = { ...data, trial };
  }
  if (sheet_name === "journal") {
    const [journal, jerr] = await attempt(
      api.journal_filtered(tok, from, to, app.journal_cause, app.journal_account, app.journal_query),
    );
    if (jerr !== null) {
      failed_for(app, asked, jerr.message);
      return;
    }
    data = { ...data, journal };
  }
  if (sheet_name === "accounts") {
    const [accounts, aerr] = await attempt(api.accounts(tok));
    if (aerr !== null) {
      failed_for(app, asked, aerr.message);
      return;
    }
    data = { ...data, accounts };
  }
  if (sheet_name === "ledger" && app.books_account.length > 0) {
    const [ledger, lerr] = await attempt(api.general_ledger(tok, app.books_account, from, to));
    if (lerr !== null) {
      failed_for(app, asked, lerr.message);
      return;
    }
    data = { ...data, ledger };
  }

  done_for(
    app,
    asked,
    screens.accounting(sheet_name, app.books_window, data, app.books_account, desk.lang_of(app), desk.currency_of(app)),
  );
}

/**
 * Save the open sheet as a file.
 *
 * The window and the account travel with it, so the file matches what is on
 * screen rather than some default the shopkeeper did not choose. Not every
 * sheet is exportable — Periods is a list of four dates — so the ones that
 * are not fall back to the trial balance's window rather than producing an
 * empty file under a misleading name.
 */
async function do_export_books(app: App, sheet_view: string): Promise<void> {
  const tok = desk.token_of(app);
  const span = desk.window_seconds(app.books_window, browser.now());
  let sheet = sheet_view;
  if (sheet_view === "summary" || sheet_view === "periods") {
    sheet = "trial";
  }
  let query = `?view=${sheet}&from=${span[0]}&to=${span[1]}`;
  if (sheet === "ledger") {
    query = `${query}&account_code=${app.books_account}`;
  }
  const [body, err] = await attempt(api.fetch_text(tok, `/accounting/export${query}`));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  const name = `${sheet}-${browser.iso_day(span[0])}.csv`;
  browser.download(name, body, "text/csv;charset=utf-8");
  desk.say(app, words.fill(desk.lang_of(app), "toast.saved_n", name));
  repaint(app);
}

async function load_expenses(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.expenses(desk.token_of(app), browser.now() - 90 * DAY, 0));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.expenses(answer, desk.lang_of(app), desk.currency_of(app)));
}

async function load_staff(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.staff(desk.token_of(app)));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  done_for(app, asked, screens.staff(answer[0], answer[1], desk.lang_of(app)));
}

async function load_settings(app: App): Promise<void> {
  const asked = app.screen;
  const [answer, err] = await attempt(api.settings(desk.token_of(app)));
  if (err !== null) {
    failed_for(app, asked, err.message);
    return;
  }
  desk.took_settings(app, doc.field(answer, "settings"));
  done_for(app, asked, screens.settings(answer, desk.lang_of(app)));
}

// ---- opening a form --------------------------------------------------------

// A row from a list, by id — what an edit form is filled from.

function category_by(list: model.CatalogCategory[], id: string): model.CatalogCategory | null {
  return list.find((cat) => cat.id === id) ?? null;
}

function supplier_by(list: model.Supplier[], id: string): model.Supplier | null {
  return list.find((s) => s.id === id) ?? null;
}

function customer_by(list: model.CustomerAccount[], id: string): model.CustomerAccount | null {
  return list.find((cu) => cu.id === id) ?? null;
}

/**
 * A product's name, for a line of a delivery held on this device.
 *
 * Carried on the line rather than looked up when the table is drawn, because
 * the line outlives one screen's reference list — and a delivery whose rows
 * read as blank while the catalogue reloads is one a shopkeeper cannot check
 * against the note in their hand.
 */
function product_name_by(list: model.CatalogProduct[], id: string): string {
  const hit = list.find((p) => p.id === id);
  if (hit === undefined) {
    return id;
  }
  return hit.name;
}

/**
 * What the open drill-down is about, for the forms opened from it.
 *
 * Each answers the empty value when there is no subject.
 */
function subject_product_name(app: App): string {
  return app.subject_product === null ? "" : app.subject_product.name;
}

function subject_product_stock(app: App): number {
  return app.subject_product === null ? 0.0 : app.subject_product.stock;
}

function subject_order_supplier(app: App): string {
  return app.subject_order === null ? "" : app.subject_order.supplier_id;
}

function subject_order_number(app: App): number {
  return app.subject_order === null ? 0 : app.subject_order.number;
}

function subject_order_total(app: App): number {
  return app.subject_order === null ? 0 : app.subject_order.total;
}

function open_form(app: App, what: string, id: string): void {
  const c = desk.currency_of(app);
  const l = desk.lang_of(app);

  // **No case returns.** Every one — including the default — falls out to the
  // `repaint` below, which is what actually puts the dialog on screen.
  switch (what) {
    case "form-product": {
      let existing: model.CatalogProduct | null = null;
      if (id.length > 0) {
        existing = app.subject_product;
      }
      desk.open_form(app, forms.product(existing, id, app.ref_categories, app.ref_suppliers, l, c));
      break;
    }
    case "form-barcode":
      desk.open_form(app, forms.barcode(id, subject_product_name(app), l));
      break;
    case "form-category":
      desk.open_form(app, forms.category(category_by(app.ref_categories, id), id, l));
      break;
    case "form-supplier":
      desk.open_form(app, forms.supplier(supplier_by(app.ref_suppliers, id), id, l));
      break;
    case "form-promotion":
      desk.open_form(app, forms.promotion(null, id, app.ref_products, app.ref_categories, l, c));
      break;
    // The row, not nothing. Opening this blank would write the blanks back on
    // Save, which is survivable for a name and a phone number and is not for
    // a credit limit — see `forms.customer`.
    case "form-customer":
      desk.open_form(app, forms.customer(customer_by(app.ref_customers, id), id, l, c));
      break;
    // The key is minted here, where the dialog opens, and rides on the form's
    // subject — so Save pressed twice after a lost answer sends the one the
    // server already has. See `forms.settle_tab`.
    case "form-settle-tab":
      desk.open_form(app, forms.settle_tab(l, app.ref_customers, token(), c));
      break;
    case "form-staff":
      desk.open_form(app, forms.staff(l));
      break;
    case "form-expense":
      desk.open_form(app, forms.expense(app.ref_expense_accounts, l, c));
      break;
    case "form-settings":
      desk.open_form(app, forms.settings(app.ref_settings, l));
      break;
    case "form-close-period":
      desk.open_form(app, forms.close_period(l));
      break;
    case "form-register":
      desk.open_form(app, forms.register(l));
      break;
    case "form-adjust":
      desk.open_form(app, forms.adjust(id, subject_product_name(app), subject_product_stock(app), l));
      break;
    case "form-open-shift":
      desk.open_form(
        app,
        forms.open_shift(
          app.ref_registers.map((lane) => lane.id),
          app.ref_registers.map((lane) => lane.name),
          l,
          c,
        ),
      );
      break;
    case "form-invoice":
      desk.open_form(
        app,
        forms.invoice(
          app.ref_suppliers.map((s) => s.id),
          app.ref_suppliers.map((s) => s.name),
          id,
          subject_order_supplier(app),
          subject_order_total(app),
          token(),
          l,
          c,
        ),
      );
      break;
    case "form-goods-in-line":
      desk.open_form(app, forms.goods_in_line(app.ref_products, l, c));
      break;
    // The key rides on the form's subject, the way `form-settle-tab` does —
    // but it was minted when the first line was added, not here, because
    // what is being repeated is the delivery rather than the press.
    case "form-goods-in-book":
      desk.open_form(
        app,
        forms.goods_in_book(
          app.ref_suppliers,
          app.goods_in_key,
          app.goods_in_supplier,
          app.goods_in_settlement,
          desk.goods_in_total(app),
          l,
          c,
        ),
      );
      break;
    case "form-delete-order":
      desk.open_form(app, forms.delete_order(id, subject_order_number(app), l));
      break;
    case "form-cancel-order":
      desk.open_form(app, forms.cancel_order(id, subject_order_number(app), l));
      break;
    // A developer's message, not a shopkeeper's: it only appears when a button
    // names a form nobody wrote, which is a bug rather than a state.
    default:
      desk.went_wrong(app, `${what} is not wired up`);
      break;
  }
  repaint(app);
}

/** Forms that need a read before they can be filled. */
async function open_close_shift(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.shift(desk.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  desk.open_form(
    app,
    forms.close_shift(id, answer.shift.register_name, answer.drawer.expected, desk.lang_of(app), desk.currency_of(app)),
  );
  repaint(app);
}

async function open_pay_invoice(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.payables(desk.token_of(app)));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  for (const i of answer.invoices) {
    if (i.id === id) {
      desk.open_form(
        app,
        forms.pay_invoice(id, i.supplier_name, i.outstanding, token(), desk.lang_of(app), desk.currency_of(app)),
      );
      repaint(app);
      return;
    }
  }
  failed(app, words.t(desk.lang_of(app), "payables.that_invoice_is_not_open_any_more"));
}

async function open_refund(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.sale(desk.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  desk.open_form(app, forms.refund(id, answer.sale.number, answer.lines, desk.lang_of(app), desk.currency_of(app)));
  repaint(app);
}

function open_receive(app: App, item_id: string): void {
  for (const line of app.subject_order_lines) {
    if (line.id === item_id) {
      const left = line.qty - line.qty_received;
      desk.open_form(
        app,
        forms.receive(item_id, line.product_name, left, line.unit_cost, desk.lang_of(app), desk.currency_of(app)),
      );
      repaint(app);
      return;
    }
  }
}

async function open_staff_menu(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.staff(desk.token_of(app)));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  // `[0]` is the people and `[1]` the command table — see `api.staff`.
  for (const u of answer[0]) {
    if (u.id === id) {
      if (u.signs_in_with === "pin") {
        desk.open_form(app, forms.staff_pin(id, u.name, desk.lang_of(app)));
      } else {
        desk.open_form(app, forms.staff_password(id, u.name, desk.lang_of(app)));
      }
      repaint(app);
      return;
    }
  }
}

// ---- reading a form back ---------------------------------------------------

/**
 * A field, by the name the form declared.
 *
 * Matched on the `data-field` attribute rather than on an id, because a
 * settings key contains a dot: `#f-shop.name` parses as "the element with id
 * `f-shop` and class `name`" and matches nothing at all. An attribute selector
 * has no such syntax to trip over.
 */
function field_of(name: string): HTMLInputElement | null {
  try {
    return document.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
  } catch {
    return null;
  }
}

function value_of(name: string): string {
  const f = field_of(name);
  if (f === null) {
    return "";
  }
  return trim(typeof f.value === "string" ? f.value : "");
}

function checked(name: string): boolean {
  const f = field_of(name);
  if (f === null) {
    return false;
  }
  return f.checked === true;
}

/**
 * An amount, after `first_unreadable` has already refused the form if any
 * money field could not be read. The zero here is unreachable, and is a zero
 * rather than a throw because a till has nobody to show a stack trace to.
 */
function money_of(app: App, name: string): number {
  return money.from_text(value_of(name), desk.currency_of(app)) ?? 0;
}

function whole_of(name: string): number {
  return parse_int(value_of(name)) ?? 0;
}

function qty_of(name: string): number {
  return parse_float(value_of(name)) ?? 0.0;
}

/** A field written only when the operator filled it in. */
function text_if(body: Body, key: string, value: string): Body {
  if (value.length === 0) {
    return body;
  }
  return { ...body, [key]: value };
}

// ---- what a press means ----------------------------------------------------

/**
 * Draw Purchasing again from what is already in hand.
 *
 * Not `load`. Adding or removing a line of a delivery changes nothing on the
 * server, and re-asking for the worksheet, the orders and the payables to show
 * one more row would make the shop wait — three requests per line of a
 * delivery note, on the connection this shop actually has.
 */
function redraw_purchasing(app: App): void {
  done(
    app,
    screens.purchasing(
      app.purchasing_sheet,
      app.purchasing_orders,
      app.purchasing_payables,
      app.goods_in,
      desk.goods_in_total(app),
      desk.lang_of(app),
      desk.currency_of(app),
    ),
  );
}

/**
 * A press that writes. **It happens once, however many times it is tapped.**
 *
 * The flag is the one the screen loads behind, so it clears itself: `took` and
 * `went_wrong` both put it down. Written and painted *before* the async call,
 * so the next tap finds it up.
 *
 * Deliberately not applied to `pressed` as a whole: `load` raises the same
 * flag on every screen change, so a blanket test would make the rail dead
 * while a list was settling. Navigation is not a write.
 */
function writing(app: App): boolean {
  if (app.busy) {
    return false;
  }
  desk.working(app, true);
  repaint(app);
  return true;
}

function pressed(app: App, what: string, id: string): void {
  if (what === "sign-in") {
    submit_sign_in(app);
    return;
  }
  if (what === "sign-out") {
    sign_off(app);
    return;
  }
  if (what === "lang") {
    desk.set_lang(app, i18n.of_code(id));
    browser.keep("kite-office.lang", id);
    repaint(app);
    // And ask for the screen again. A block carries its own words — a table's
    // headings were said in whichever language was on when the screen was
    // built — so a repaint alone would change the rail and the page title and
    // leave the body in the old language. An open dialog is deliberately not
    // rebuilt: its labels go stale, but rebuilding it would throw away
    // whatever has been typed into it.
    load(app);
    return;
  }
  if (what === "rail") {
    desk.toggle_rail(app);
    repaint(app);
    return;
  }
  if (what === "go") {
    if (id === "categories") {
      desk.go(app, desk.screen("Products"));
      desk.working(app, true);
      repaint(app);
      void load_categories(app);
      return;
    }
    browser.set_hash(`#/${id}`);
    return;
  }
  if (what === "open-product") {
    browser.set_hash(`#/products/${id}`);
    return;
  }
  if (what === "open-sale") {
    browser.set_hash(`#/sales/${id}`);
    return;
  }
  if (what === "open-shift-detail") {
    browser.set_hash(`#/shifts/${id}`);
    return;
  }
  if (what === "open-order") {
    browser.set_hash(`#/purchasing/${id}`);
    return;
  }
  if (what === "print") {
    browser.print_page();
    return;
  }
  if (what === "form-cancel") {
    desk.close_form(app);
    repaint(app);
    return;
  }
  if (what === "form-submit") {
    submit(app);
    return;
  }
  // ---- the books --------------------------------------------------------
  //
  // Switching sheet or window re-reads only what the new sheet needs, which
  // is why each of these ends in `load` rather than a repaint: the window is
  // what the request is built from, so changing it without re-asking would
  // show last window's figures under this window's label.
  if (what === "books-view") {
    desk.show_books(app, id);
    load(app);
    return;
  }
  if (what === "books-window") {
    desk.set_books_window(app, id);
    load(app);
    return;
  }
  if (what === "books-account") {
    desk.open_account(app, id);
    load(app);
    return;
  }
  if (what === "books-export") {
    void do_export_books(app, id);
    return;
  }
  if (what === "books-reverse") {
    desk.open_form(app, forms.reverse_entry(id, desk.lang_of(app)));
    repaint(app);
    return;
  }
  if (what === "form-remove-category") {
    desk.open_form(app, forms.remove_category(desk.lang_of(app), app.ref_categories));
    repaint(app);
    return;
  }
  if (what === "form-cancel-invoice") {
    desk.open_form(app, forms.cancel_invoice(desk.lang_of(app), app.ref_invoices, desk.currency_of(app)));
    repaint(app);
    return;
  }
  if (what === "photo-remove") {
    if (writing(app)) {
      void do_remove_photo(app);
    }
    return;
  }
  if (what === "books-filter") {
    desk.open_form(
      app,
      forms.journal_filter(desk.lang_of(app), app.journal_cause, app.journal_account, app.journal_query, app.ref_accounts),
    );
    repaint(app);
    return;
  }
  if (what === "books-opening") {
    desk.open_form(app, forms.opening_balances(desk.lang_of(app), desk.currency_of(app)));
    repaint(app);
    return;
  }
  if (what === "books-reopen") {
    if (writing(app)) {
      void do_reopen_period(app, id);
    }
    return;
  }
  if (what === "form-close-shift") {
    void open_close_shift(app, id);
    return;
  }
  if (what === "form-pay-invoice") {
    void open_pay_invoice(app, id);
    return;
  }
  if (what === "form-refund") {
    void open_refund(app, id);
    return;
  }
  if (what === "form-receive") {
    open_receive(app, id);
    return;
  }
  if (what === "form-movement") {
    desk.open_form(app, forms.movement(id, desk.lang_of(app), desk.currency_of(app)));
    repaint(app);
    return;
  }
  if (what === "staff-menu") {
    void open_staff_menu(app, id);
    return;
  }
  if (what === "retire-product") {
    if (writing(app)) {
      void do_retire_product(app, id);
    }
    return;
  }
  if (what === "drop-barcode") {
    if (writing(app)) {
      void do_drop_barcode(app, id);
    }
    return;
  }
  if (what === "send-order") {
    if (writing(app)) {
      void do_send_order(app, id);
    }
    return;
  }
  if (what === "receive-all") {
    if (writing(app)) {
      void do_receive_all(app, id);
    }
    return;
  }
  if (what === "raise-orders") {
    if (writing(app)) {
      void do_raise_orders(app);
    }
    return;
  }
  // Taking a line back off the delivery, and abandoning the whole of it.
  // Neither writes anything, so neither needs the in-flight guard — and
  // neither may be refused while a screen is loading, because the lines are
  // held here and a shopkeeper correcting a mistyped quantity should not have
  // to wait for a worksheet.
  if (what === "goods-in-drop") {
    desk.goods_in_drop(app, id);
    redraw_purchasing(app);
    return;
  }
  if (what === "goods-in-clear") {
    desk.goods_in_clear(app);
    redraw_purchasing(app);
    return;
  }
  if (what === "close-lane") {
    void open_close_lane(app, id);
    return;
  }
  if (what === "authorise") {
    desk.went_wrong(app, words.t(desk.lang_of(app), "tills.authorise_at_the_lane_itself"));
    repaint(app);
    return;
  }
  if (what === "shift-detail") {
    browser.set_hash("#/shifts");
    return;
  }
  if (what.startsWith("form-")) {
    open_form(app, what, id);
    return;
  }
}

// ---- submitting ------------------------------------------------------------

function submit(app: App): void {
  const open = app.form;
  if (open === null) {
    return;
  }
  if (open.busy) {
    return;
  }
  const missing = first_unanswered(open);
  if (missing.length > 0) {
    desk.form_refused(app, words.fill(desk.lang_of(app), "error.answer_first", missing));
    repaint(app);
    return;
  }
  const bad = first_unreadable(app, open);
  if (bad.length > 0) {
    desk.form_refused(app, words.fill(desk.lang_of(app), "error.not_a_number", bad));
    repaint(app);
    return;
  }
  desk.form_working(app);
  repaint(app);
  void do_submit(app, open.id, open.subject, open.key);
}

/**
 * The label of the first amount or quantity the parser refuses, or "".
 *
 * **The refusal has to stop the submission.** `money.from_text` returns
 * nothing rather than guess — "anything that is not an amount is refused
 * rather than read as zero — so a slip in a form cannot quietly become a free
 * item" — and a call site that turned that back into a zero would undo it:
 * a manager retyping a shelf price as "1,200.00" out of habit in a currency
 * with no decimals would send `price: 0`, and the till would give that product
 * away on every scan.
 *
 * Checked here, once, against the fields the form declared, rather than at
 * every call site that would each have to remember.
 */
function first_unreadable(app: App, open: desk.Form): string {
  const c = desk.currency_of(app);
  for (const f of open.fields) {
    if (f.kind.tag === "Money") {
      if (money.from_text(value_of(f.name), c) === null) {
        return f.label;
      }
    }
    if (f.kind.tag === "Quantity") {
      if (parse_float(value_of(f.name)) === null) {
        return f.label;
      }
    }
  }
  return "";
}

/**
 * The first required field nobody answered, or "".
 *
 * A picker with nothing to offer falls back to a single option whose value is
 * the empty string, and sending that would build a URL with a hole in it:
 * `/purchasing/invoices//cancel` matches no route at all, so the shopkeeper
 * would be told "no such endpoint" for what is really "there are no invoices
 * to cancel". This is the guard every such picker shares.
 */
function first_unanswered(open: desk.Form): string {
  for (const f of open.fields) {
    if (f.required && trim(value_of(f.name)).length === 0) {
      return f.label;
    }
  }
  return "";
}

/**
 * Everything that writes, in one place.
 *
 * A long function on purpose: the alternative is twenty small ones that each
 * have to be found before a field can be traced from the form that asked for
 * it to the call that sends it. Every case reads its own fields by name and
 * ends in one API call.
 */
async function do_submit(app: App, id: string, subject: string, key: string): Promise<void> {
  const tok = desk.token_of(app);
  const l = desk.lang_of(app);
  let body: Body = {};

  switch (id) {
    case "product": {
      body["sku"] = value_of("sku");
      body["name"] = value_of("name");
      body["name_my"] = value_of("name_my");
      body["category_id"] = value_of("category_id");
      body["supplier_id"] = value_of("supplier_id");
      body["price"] = money_of(app, "price");
      body["cost"] = money_of(app, "cost");
      body["tax_bp"] = whole_of("tax_bp");
      body["min_age"] = whole_of("min_age");
      body["unit"] = value_of("unit");
      body["ask_price"] = checked("ask_price");
      body["reorder_point"] = qty_of("reorder_point");
      body["reorder_qty"] = qty_of("reorder_qty");
      body["quick_key"] = whole_of("quick_key");
      body["active"] = checked("active");
      const open = app.form;
      if (open !== null) {
        body["photo_key"] = field_value_of(open, "photo_key");
      }
      const [, err] = await attempt(api.save_product(tok, subject, body));
      settle(app, err, words.t(l, "toast.saved"));
      return;
    }
    case "barcode": {
      body["barcode"] = value_of("barcode");
      body["pack_size"] = qty_of("pack_size");
      body["label"] = value_of("label");
      const [, err] = await attempt(api.add_barcode(tok, subject, body));
      settle(app, err, words.t(l, "toast.barcode_added"));
      return;
    }
    case "category": {
      body["name"] = value_of("name");
      body["name_my"] = value_of("name_my");
      body["sort"] = whole_of("sort");
      const [, err] = await attempt(api.save_category(tok, subject, body));
      settle(app, err, words.t(l, "toast.saved"));
      return;
    }
    case "supplier": {
      body["name"] = value_of("name");
      body["phone"] = value_of("phone");
      body["email"] = value_of("email");
      body["address"] = value_of("address");
      body["lead_days"] = whole_of("lead_days");
      body["active"] = checked("active");
      const [, err] = await attempt(api.save_supplier(tok, subject, body));
      settle(app, err, words.t(l, "toast.saved"));
      return;
    }
    case "promotion": {
      body["name"] = value_of("name");
      body["name_my"] = value_of("name_my");
      body["kind"] = value_of("kind");
      body["value"] = whole_of("value");
      body["n"] = whole_of("n");
      body["scope"] = value_of("scope");
      body = text_if(body, "product_id", value_of("product_id"));
      body = text_if(body, "category_id", value_of("category_id"));
      body["priority"] = whole_of("priority");
      body["active"] = checked("active");
      const [, err] = await attempt(api.save_promotion(tok, subject, body));
      settle(app, err, words.t(l, "toast.saved"));
      return;
    }
    case "customer": {
      body["name"] = value_of("name");
      body["phone"] = value_of("phone");
      body["note"] = value_of("note");
      body["credit_limit"] = money_of(app, "credit_limit");
      const [, err] = await attempt(api.save_customer(tok, subject, body));
      settle(app, err, words.t(l, "toast.saved"));
      return;
    }
    case "settle-tab": {
      const who = value_of("customer_id");
      body["amount"] = money_of(app, "amount");
      body["method"] = value_of("method");
      body["note"] = value_of("note");
      body["client_id"] = subject;
      const [, err] = await attempt(api.settle_tab(tok, who, body));
      settle(app, err, words.t(l, "receivables.payment_taken"));
      return;
    }
    case "staff": {
      body["name"] = value_of("name");
      body["role"] = value_of("role");
      body = text_if(body, "pin", value_of("pin"));
      body = text_if(body, "username", value_of("username"));
      body = text_if(body, "password", value_of("password"));
      const [, err] = await attempt(api.save_staff(tok, "", body));
      settle(app, err, words.t(l, "toast.added"));
      return;
    }
    case "staff-pin": {
      const [, err] = await attempt(api.set_staff_pin(tok, subject, value_of("pin")));
      settle(app, err, words.t(l, "toast.pin_set"));
      return;
    }
    case "staff-password": {
      const [, err] = await attempt(api.set_staff_password(tok, subject, value_of("password")));
      settle(app, err, words.t(l, "toast.password_set"));
      return;
    }
    case "staff-edit": {
      body["name"] = value_of("name");
      body["active"] = checked("active");
      const [, err] = await attempt(api.save_staff(tok, subject, body));
      settle(app, err, words.t(l, "toast.saved"));
      return;
    }
    case "adjust": {
      body["product_id"] = subject;
      body["counted"] = qty_of("counted");
      body["reason"] = value_of("reason");
      body["note"] = value_of("note");
      const [, err] = await attempt(api.adjust_stock(tok, body));
      settle(app, err, words.t(l, "toast.stock_was_adjusted"));
      return;
    }
    case "receive": {
      const line: Body = {
        item_id: subject,
        qty: qty_of("qty"),
        unit_cost: money_of(app, "unit_cost"),
      };
      body["lines"] = [line];
      const [, err] = await attempt(api.receive_order(tok, order_id_of(app), body));
      settle(app, err, words.t(l, "common.received"));
      return;
    }
    case "invoice": {
      body["client_id"] = key;
      body["supplier_id"] = value_of("supplier_id");
      body = text_if(body, "po_id", subject);
      body["reference"] = value_of("reference");
      body["total"] = money_of(app, "total");
      body["issued_at"] = browser.now();
      body["due_at"] = browser.now() + whole_of("due_days") * DAY;
      const [, err] = await attempt(api.add_invoice(tok, body));
      settle(app, err, words.t(l, "toast.invoice_recorded"));
      return;
    }
    case "pay-invoice": {
      body["client_id"] = key;
      body["amount"] = money_of(app, "amount");
      body["method"] = value_of("method");
      const [, err] = await attempt(api.pay_invoice(tok, subject, body));
      settle(app, err, words.t(l, "payables.paid"));
      return;
    }
    case "expense": {
      body["account_code"] = value_of("account_code");
      body["category"] = value_of("category");
      body["payee"] = value_of("payee");
      body = text_if(body, "reference", value_of("reference"));
      body["amount"] = money_of(app, "amount");
      body["tax"] = money_of(app, "tax");
      body["method"] = value_of("method");
      body["note"] = value_of("note");
      const [, err] = await attempt(api.add_expense(tok, body));
      settle(app, err, words.t(l, "toast.recorded"));
      return;
    }
    case "open-shift": {
      const [, err] = await attempt(api.open_shift(tok, value_of("register_id"), money_of(app, "opening_float")));
      settle(app, err, words.t(l, "toast.drawer_open"));
      return;
    }
    case "close-shift": {
      const [, err] = await attempt(api.close_shift(tok, subject, money_of(app, "counted_total"), value_of("note")));
      settle(app, err, words.t(l, "toast.drawer_closed"));
      return;
    }
    case "movement": {
      body["kind"] = value_of("kind");
      body["amount"] = money_of(app, "amount");
      body["reason"] = value_of("reason");
      const [, err] = await attempt(api.shift_movement(tok, subject, body));
      settle(app, err, words.t(l, "toast.recorded"));
      return;
    }
    case "register": {
      body["name"] = value_of("name");
      body["kind"] = value_of("kind");
      const [, err] = await attempt(api.add_register(tok, body));
      settle(app, err, words.t(l, "toast.lane_added"));
      return;
    }
    case "remove-category": {
      const [, err] = await attempt(api.remove_category(tok, value_of("category_id")));
      settle(app, err, words.t(l, "toast.category_removed"));
      return;
    }
    case "cancel-invoice": {
      body["reason"] = value_of("reason");
      const [, err] = await attempt(api.cancel_invoice(tok, value_of("invoice_id"), body));
      settle(app, err, words.t(desk.lang_of(app), "payables.cancelled"));
      return;
    }
    case "journal-filter": {
      desk.filter_journal(app, value_of("ref_type"), value_of("account_code"), value_of("q"));
      desk.close_form(app);
      load(app);
      return;
    }
    case "opening-balances": {
      body["cash_in_safe"] = money_of(app, "cash_in_safe");
      body["cash_in_drawer"] = money_of(app, "cash_in_drawer");
      const [, err] = await attempt(api.post_opening_balances(tok, body));
      settle(app, err, words.t(desk.lang_of(app), "accounting.opening_balances"));
      return;
    }
    case "reverse-entry": {
      body["reason"] = value_of("reason");
      const [, err] = await attempt(api.reverse_entry(tok, subject, body));
      settle(app, err, words.t(l, "toast.correction_posted"));
      return;
    }
    case "refund": {
      const lines: Body[] = [];
      for (const line of app.subject_sale_lines) {
        const line_id = line.id;
        const wanted = qty_of(`line:${line_id}`);
        if (wanted > 0.0) {
          lines.push({ sale_item_id: line_id, qty: wanted });
        }
      }
      body["lines"] = lines;
      body["reason"] = value_of("reason");
      body["method"] = value_of("method");
      body["restock"] = checked("restock");
      const [, err] = await attempt(api.refund_sale(tok, subject, body));
      settle(app, err, words.t(l, "common.refunded"));
      return;
    }
    case "settings": {
      for (const k of [
        "shop.name",
        "shop.name_my",
        "shop.address",
        "shop.phone",
        "shop.tax_id",
        "shop.receipt_footer",
        "currency.code",
        "currency.symbol",
        "currency.minor_units",
        "currency.symbol_first",
        "tax.inclusive",
        "tax.default_bp",
        "locale.default",
        "loyalty.points_per_unit",
        "accounting.enabled",
      ]) {
        body[k] = value_of(k);
      }
      const [, err] = await attempt(api.save_settings(tok, body));
      settle(app, err, words.t(l, "toast.saved"));
      return;
    }
    case "close-period": {
      const month = value_of("month");
      const bounds = browser.month_bounds(month);
      if (bounds.length !== 2) {
        desk.form_refused(app, words.t(l, "error.write_the_month_as"));
        repaint(app);
        return;
      }
      body["starts_at"] = bounds[0];
      body["ends_at"] = bounds[1];
      const [, err] = await attempt(api.close_period(tok, body));
      settle(app, err, words.t(l, "toast.month_closed"));
      return;
    }
    // A line of a delivery. **This one writes nothing.**
    //
    // It puts the line on `app.goods_in` and closes the dialog, so a
    // shopkeeper can enter a delivery note line by line with the van driver
    // waiting and never touch the network until the end. Which is also why a
    // mistyped quantity costs nothing to correct: the row is taken off again
    // with one tap and no request.
    case "goods-in-line": {
      const product_id = value_of("product_id");
      if (product_id.length === 0) {
        desk.form_refused(app, words.t(l, "purchasing.which_product"));
        repaint(app);
        return;
      }
      const qty = qty_of("qty");
      if (qty <= 0.0) {
        desk.form_refused(app, words.fill(l, "error.not_a_number", words.t(l, "purchasing.qty_arrived")));
        repaint(app);
        return;
      }
      desk.goods_in_add(app, token(), {
        product_id,
        name: product_name_by(app.ref_products, product_id),
        qty,
        unit_cost: money_of(app, "unit_cost"),
        new_price: money.from_text(value_of("new_price"), desk.currency_of(app)),
        price_now: checked("price_now"),
      });
      desk.close_form(app);
      redraw_purchasing(app);
      return;
    }
    // The one press that writes the delivery — stock, the bill, the payment
    // and the postings, in one request the Worker runs as one transaction.
    // `subject` is the key minted when the first line went on, so four taps
    // on a slow line book one delivery.
    case "goods-in-book": {
      if (app.goods_in.length === 0) {
        desk.form_refused(app, words.t(l, "purchasing.nothing_on_the_delivery"));
        repaint(app);
        return;
      }
      const supplier_id = value_of("supplier_id");
      const settlement = value_of("settlement");
      desk.goods_in_about(app, supplier_id, settlement);
      body["client_id"] = subject;
      body["supplier_id"] = supplier_id;
      body["settlement"] = settlement;
      body["reference"] = value_of("reference");
      body["note"] = value_of("note");
      const lines: Body[] = [];
      for (const held of app.goods_in) {
        const line: Body = {
          product_id: held.product_id,
          qty: held.qty,
          unit_cost: held.unit_cost,
        };
        const new_price = held.new_price;
        if (new_price !== null) {
          line["new_price"] = new_price;
          line["price_now"] = held.price_now;
        }
        lines.push(line);
      }
      body["lines"] = lines;
      // The lines as they were when the request went out. A line added while
      // it was in flight was never sent, and clearing the whole delivery
      // afterwards would throw it away without telling anybody.
      const sent = app.goods_in;
      const [replayed, err] = await attempt(api.goods_in(tok, body));
      if (err !== null) {
        settle(app, err, "");
        return;
      }
      desk.goods_in_took(app, sent);
      // **Say which of the two happened.** A press whose answer was lost and
      // is pressed again books nothing — correctly — and a shopkeeper told
      // "booked into stock" would go looking for a delivery that is there
      // once, having typed it twice.
      settle(app, null, replayed ? words.t(l, "purchasing.already_booked") : words.t(l, "purchasing.delivery_booked"));
      return;
    }
    case "delete-order": {
      const [, err] = await attempt(api.delete_order(tok, subject));
      if (err !== null) {
        desk.form_refused(app, err.message);
        repaint(app);
        return;
      }
      desk.close_form(app);
      desk.say(app, words.t(l, "purchasing.draft_deleted"));
      // Back to the list: the order this page was about is gone, and leaving
      // the manager looking at a 404 is not an answer.
      desk.go(app, desk.screen("Purchasing"));
      browser.set_hash(desk.href_of(desk.screen("Purchasing")));
      load(app);
      return;
    }
    case "cancel-order": {
      const [, err] = await attempt(api.cancel_order(tok, subject, value_of("reason")));
      settle(app, err, words.t(l, "purchasing.order_cancelled"));
      return;
    }
    default:
      // Left in English on purpose, like "is not wired up": it can only
      // appear when a form was written and its submit case was not, which
      // nobody outside this file can act on.
      desk.form_refused(app, `${id} has no handler`);
      repaint(app);
      return;
  }
}

/** The purchase order a receive form belongs to. */
function order_id_of(app: App): string {
  return app.screen.tag === "Order" ? app.screen.id : "";
}

/** What every write does with its answer. */
function settle(app: App, err: Error | null, said: string): void {
  if (err !== null) {
    desk.form_refused(app, err.message);
    repaint(app);
    return;
  }
  desk.close_form(app);
  desk.say(app, said);
  repaint(app);
  load(app);
  void load_refs(app);
}

// ---- writes with no form in front of them ----------------------------------

/**
 * Take the picture off a product.
 *
 * Deletes the object as well as clearing the column — the Worker does both —
 * because a key nothing points at is a file nobody will ever find and R2 bills
 * for storage.
 */
async function do_remove_photo(app: App): Promise<void> {
  const open = app.form;
  if (open === null) {
    return;
  }
  const photo = field_value_of(open, "photo_key");
  if (photo.length === 0) {
    return;
  }
  desk.set_field(app, "photo_key", "");
  repaint(app);
  const [, err] = await attempt(api.remove_photo(desk.token_of(app), photo));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  // **The flag has to come down on the way out as well.** `writing` raises
  // `app.busy` before this is called, and a picture removed cleanly must not
  // leave every button on the page inert until the manager navigates away.
  desk.working(app, false);
  repaint(app);
}

/**
 * What a field currently holds, from the form rather than from the document —
 * a photo has no input to read back.
 */
function field_value_of(f: desk.Form, name: string): string {
  for (const field of f.fields) {
    if (field.name === name) {
      return field.value;
    }
  }
  return "";
}

/**
 * Let a closed month be posted into again.
 *
 * Closing guards against a backdated correction landing in a period already
 * reported to the outside world; reopening is admitting the report itself was
 * wrong, which happens often enough to need a button.
 */
async function do_reopen_period(app: App, id: string): Promise<void> {
  const [, err] = await attempt(api.reopen_period(desk.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  desk.say(app, words.t(desk.lang_of(app), "toast.that_month_is_open_again"));
  load(app);
}

async function do_retire_product(app: App, id: string): Promise<void> {
  const [, err] = await attempt(api.retire_product(desk.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  browser.set_hash("#/products");
}

async function do_drop_barcode(app: App, barcode: string): Promise<void> {
  const [, err] = await attempt(api.drop_barcode(desk.token_of(app), barcode));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  load(app);
}

async function do_send_order(app: App, id: string): Promise<void> {
  const [, err] = await attempt(api.send_order(desk.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  load(app);
}

/** Receive everything a delivery brought, in one press. */
async function do_receive_all(app: App, id: string): Promise<void> {
  const tok = desk.token_of(app);
  const [answer, err] = await attempt(api.order(tok, id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  const lines: Body[] = [];
  for (const l of answer.lines) {
    const left = l.qty - l.qty_received;
    if (left > 0.0) {
      lines.push({ item_id: l.id, qty: left, unit_cost: l.unit_cost });
    }
  }
  const [, rerr] = await attempt(api.receive_order(tok, id, { lines }));
  if (rerr !== null) {
    failed(app, rerr.message);
    return;
  }
  desk.say(app, words.t(desk.lang_of(app), "common.received"));
  load(app);
}

/**
 * Turn the worksheet into draft orders, one per supplier.
 *
 * The worksheet already knows what to buy and from whom; this is the press
 * that writes it down. Grouped by supplier because that is how it will be
 * sent, and left as a draft because somebody should look at it first.
 *
 * **The key is the supplier and the day, not the press.** `writing` refuses
 * the second tap while the first is running, and this key covers the case the
 * guard cannot — a tap after the answer was lost. Today's reorder for a
 * supplier is one order however many times it is asked for, which is what the
 * button already meant.
 */
async function do_raise_orders(app: App): Promise<void> {
  const tok = desk.token_of(app);
  const [lines, err] = await attempt(api.worksheet(tok, 28));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  const suppliers: string[] = [];
  for (const l of lines) {
    const supplier = l.supplier_id;
    if (supplier.length > 0 && l.suggested > 0.0 && !suppliers.includes(supplier)) {
      suppliers.push(supplier);
    }
  }
  if (suppliers.length === 0) {
    desk.went_wrong(app, words.t(desk.lang_of(app), "purchasing.nothing_to_order"));
    repaint(app);
    return;
  }

  const today = browser.iso_day(browser.now());
  let raised = 0;
  for (const supplier of suppliers) {
    const items: Body[] = [];
    for (const l of lines) {
      if (l.supplier_id === supplier && l.suggested > 0.0) {
        items.push({ product_id: l.id, qty: l.suggested, unit_cost: l.cost });
      }
    }
    const body: Body = {
      client_id: `worksheet:${supplier}:${today}`,
      supplier_id: supplier,
      status: "draft",
      lines: items,
    };
    const [replayed, oerr] = await attempt(api.raise_order(tok, body));
    if (oerr === null) {
      if (!replayed) {
        raised = raised + 1;
      }
    }
  }
  // Nothing new: the key above matched, which means today's orders are
  // already on the list. Said plainly rather than reported as "0 raised",
  // which reads like a failure and is not one.
  if (raised === 0) {
    desk.say(app, words.t(desk.lang_of(app), "purchasing.orders_already_raised"));
    load(app);
    return;
  }
  // No singular against plural: မြန်မာ does not mark it, and the reviewed
  // phrase already says "one per supplier", which is the fact worth saying.
  desk.say(app, words.fill_n(desk.lang_of(app), "toast.pos_raised", `${raised}`));
  load(app);
}

async function open_close_lane(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.lanes(desk.token_of(app)));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  for (const lane of answer) {
    if (lane.id === id) {
      const shift = lane.shift_id;
      if (shift.length === 0) {
        desk.went_wrong(app, words.t(desk.lang_of(app), "tills.that_lane_has_no_open_drawer"));
        repaint(app);
        return;
      }
      desk.open_form(
        app,
        forms.close_shift(shift, lane.name, lane.drawer_expected, desk.lang_of(app), desk.currency_of(app)),
      );
      repaint(app);
      return;
    }
  }
}

// ---- events ----------------------------------------------------------------

function arrived(app: App): void {
  const wanted = desk.screen_of(browser.hash());
  desk.go(app, wanted);
  if (app.session === null) {
    repaint(app);
    return;
  }
  load(app);
}

/**
 * A press on anything that carries a `data-action`.
 *
 * The element the handler is attached to is the one whose action counts, and
 * the press stops there.
 *
 * Every control here is a `type="button"` button or a table row, none of which
 * has a default action to cancel — except the photo inputs, which are
 * `<input type="file">`, whose default action is opening the file chooser.
 * That is the entire point of pressing one, and cancelling it is how a
 * product photo once could never be attached: the chooser never opened, so
 * `change` never fired.
 */
function clicked(app: App, e: MouseEvent<HTMLElement>): void {
  const acted = e.currentTarget;
  e.stopPropagation();
  const name = acted.getAttribute("data-action");
  if (name === null) {
    return;
  }
  const id = acted.getAttribute("data-id") ?? "";
  if (name !== "photo-pick") {
    e.preventDefault();
  }
  pressed(app, name, id);
}

/**
 * Something in the dialog changed. Only the photo inputs and the Goods In
 * product chooser care.
 */
function changed(app: App, e: Event): void {
  const target = e.target;
  if (!(target instanceof Element)) {
    return;
  }
  // **The cost follows the product.**
  //
  // The Goods In line form opens with the first product's cost under the
  // chooser so the common case is one field fewer to type. That number is
  // written onto `products.cost` by the Worker, so it must not sit there
  // unchanged while the operator picks a different row — a delivery of crisps
  // could reprice the cola, and every margin the shop reported afterwards
  // would be computed against a price it never paid.
  const open_now = app.form;
  if (open_now !== null) {
    if (open_now.id === "goods-in-line") {
      if ((target.getAttribute("data-field") ?? "") === "product_id") {
        const chosen = (target as HTMLSelectElement).value ?? "";
        for (const p of app.ref_products) {
          if (p.id === chosen) {
            desk.set_field(app, "unit_cost", money.plain(p.cost, desk.currency_of(app)));
            repaint(app);
          }
        }
        return;
      }
    }
  }
  const acted = target.closest("[data-action]");
  if (acted === null) {
    return;
  }
  if ((acted.getAttribute("data-action") ?? "") !== "photo-pick") {
    return;
  }
  const open = app.form;
  if (open === null) {
    return;
  }
  desk.form_working(app);
  repaint(app);
  browser.upload_photo(
    `${api.base()}/photos${open.subject.length > 0 ? `?product_id=${open.subject}` : ""}`,
    desk.token_of(app),
    acted as HTMLInputElement,
    (photo_key) => photo_saved(app, photo_key),
    (why) => photo_failed(app, why),
  );
}

/**
 * A picture landed. The key goes into the open form, so the preview redraws
 * and a Save carries it — which is what attaches it to a product that did not
 * exist yet when the picture was taken.
 */
function photo_saved(app: App, photo_key: string): void {
  desk.set_field(app, "photo_key", photo_key);
  desk.say(app, words.t(desk.lang_of(app), "toast.photo_saved"));
  repaint(app);
}

function photo_failed(app: App, why: string): void {
  desk.form_refused(app, why);
  repaint(app);
}

function typed(app: App, e: KeyboardEvent): void {
  if (e.key !== "Enter") {
    return;
  }
  const hit = e.target;
  if (!(hit instanceof Element)) {
    return;
  }
  const field = hit.getAttribute("id") ?? "";
  if (field === "username" || field === "password") {
    e.preventDefault();
    submit_sign_in(app);
  }
}

function main(): void {
  const root = document.querySelector("#app");
  if (root === null) {
    console.error("office: there is no #app to mount into");
    return;
  }
  view = createRoot(root);

  const app = desk.holding();
  // A kept choice wins over the shop's default: the person at this desk chose
  // it, and the shop's setting is only ever the starting point. The key is
  // the office's own — a manager reading မြန်မာ at the desk should not
  // silently switch every lane in the building.
  const kept_lang = browser.kept("kite-office.lang");
  if (kept_lang !== null) {
    desk.set_lang(app, i18n.of_code(kept_lang));
  }
  desk.go(app, desk.screen_of(browser.hash()));

  // Read before the first paint — see the note in `pos.tsx`. Without this the
  // desk would draw its sign-in card over a session that was already good.
  const kept_token = browser.kept("kite-office.token");
  if (kept_token !== null) {
    desk.restoring(app, true);
  }
  repaint(app);

  // A file input announces itself with `change`, not `click`: the click opens
  // the picker and the file arrives later, on a second event.
  root.addEventListener("change", (e) => changed(app, e));
  root.addEventListener("keydown", (e) => typed(app, e as KeyboardEvent));
  browser.on_window("hashchange", () => arrived(app));

  // The lanes are the one thing on this page that is about *now*, so they are
  // re-read on a slow beat. Everything else is a window and waits to be asked.
  browser.every(30000, () => void load_header(app));

  browser.register_worker("/sw.js");

  if (kept_token !== null) {
    void resume(app, kept_token);
  }
}

main();
