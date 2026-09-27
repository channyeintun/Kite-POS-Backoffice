//! The till: what to mount, what to listen to, and what a touch means.
//!
//! This is the wiring. It renders the page, attaches the one listener React
//! cannot — the keyboard, on the document — and turns each press into a call
//! on somebody else: `till.tsx` says what the screen looks like, `api.ts` talks
//! to the Worker, and `store.ts` holds the value both of them are about.
//!
//! ## Drawing is explicit
//!
//! The store is one mutable value, and nothing reaches the screen until
//! `repaint` says so — synchronously, so that a line which repaints and then
//! focuses a field that has just been drawn finds it there. That is the same
//! contract the till has always had, and it is what lets every handler below
//! decide exactly when the operator sees what it did.
//!
//! ## Work is marked as started on the line that starts it
//!
//! A cashier double-tapping Pay must not get two of everything. Every handler
//! below is an ordinary function that writes its guard and repaints *before*
//! the `async` one behind it is called, so the second tap finds the guard up.

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { MouseEvent } from "react";
import * as api from "./api.ts";
import * as browser from "./browser.ts";
import * as doc from "./doc.ts";
import * as i18n from "./i18n.ts";
import * as model from "./model.ts";
import * as money from "./money.ts";
import * as store from "./store.ts";
import type { App } from "./store.ts";
import { Page } from "./till.tsx";
import { parse_int, str_len, token } from "./lang.ts";

let view: Root | null = null;

// ---- drawing ---------------------------------------------------------------

function repaint(app: App): void {
  // The stylesheet keys Burmese's taller line box off the document's `lang`,
  // so this has to be written before the page that depends on it.
  browser.set_document_lang(i18n.tag_of(app.lang));
  const root = view;
  if (root === null) {
    return;
  }
  try {
    flushSync(() => root.render(<Page app={app} press={(e) => clicked(app, e)} />));
  } catch (e) {
    console.error(`till: could not draw: ${e instanceof Error ? e.message : String(e)}`);
  }
  // **Nothing is focused from here.**
  //
  // Every repaint used to end by pulling the focus into the scan box — and
  // every tap repaints. Tapping a tile, a tab, a basket line or the language
  // chip pulled the caret out of wherever the operator had just put it, and
  // on a tablet it did so inside the tap's own gesture, so the on-screen
  // keyboard came back up and the layout jumped on every single touch.
  //
  // The promise — a barcode scanner is a fast keyboard and whatever it types
  // has to land in the box — is kept at the other end: `typed` listens on the
  // document, so a scanner's burst reaches the till with nothing focused at
  // all, and is written into the box a character at a time.
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

// ---- signing in ------------------------------------------------------------

/**
 * A digit on the pad. **The pad never submits by itself.**
 *
 * It used to, on the fourth digit. The → key was then unreachable: the
 * auto-submit fired before a fifth digit could be pressed, so every PIN of
 * five to eight digits — which the back office invites, in so many words, on
 * the form that sets one — was sent to the Worker as its first four
 * characters, refused, and the pad cleared itself before the cashier could
 * finish. One tap was worth having. It was not worth a member of staff who
 * cannot open a lane, so the → key is the only way in and it means what it
 * says.
 */
function press_pin(app: App, key: string): void {
  store.press_pin(app, key);
  repaint(app);
}

function submit_pin(app: App): void {
  if (app.signing_in) {
    return;
  }
  // Said rather than ignored. → is the only way in, so a press that does
  // nothing at all reads as a broken pad.
  if (app.pin.length < 4) {
    store.went_wrong(app, i18n.t(app.lang, "pin_too_short"));
    repaint(app);
    return;
  }
  store.signing_in(app, true);
  repaint(app);
  void do_sign_in(app, app.pin);
}

async function do_sign_in(app: App, pin: string): Promise<void> {
  const lane = browser.kept("kite-pos.register") ?? "reg_1";
  const [session, err] = await attempt(api.sign_in_with_pin(pin, lane));
  if (err !== null) {
    store.signing_in(app, false);
    store.went_wrong(app, err.message);
    store.press_pin(app, "clear");
    repaint(app);
    return;
  }
  browser.keep("kite-pos.token", session.token);
  store.signed_in(app, session);
  repaint(app);
  load_everything(app);
}

async function resume(app: App, kept_token: string): Promise<void> {
  const [session, err] = await attempt(api.whoami(kept_token));
  if (err !== null) {
    // An expired or unknown token is not an error the cashier can act on;
    // it is simply the sign-in screen.
    browser.drop_kept("kite-pos.token");
    store.signing_in(app, false);
    store.restoring(app, false);
    repaint(app);
    return;
  }
  store.signed_in(app, session);
  repaint(app);
  load_everything(app);
}

/**
 * Signing off, and the one thing that stops it.
 *
 * **A basket with lines on it is refused.** The status bar is a row of small
 * targets beside the scan field, and a mis-tap that signed the cashier out
 * mid-transaction would leave the customer's shopping stranded on a lane
 * nobody is on. Hold parks it in one press and Void clears it; either makes
 * this legal. That is also why there is no "are you sure" here — the refusal
 * is more useful than a dialog, because it names what to do instead.
 */
function sign_off(app: App): void {
  if (app.basket.lines.length > 0) {
    store.went_wrong(app, i18n.t(app.lang, "sign_out_busy"));
    repaint(app);
    return;
  }
  const kept_token = store.token_of(app);
  browser.drop_kept("kite-pos.token");
  store.signed_out(app);
  repaint(app);
  void do_sign_out(kept_token);
}

async function do_sign_out(kept_token: string): Promise<void> {
  const [, err] = await attempt(api.sign_out(kept_token));
  if (err !== null) {
    console.error("till: sign-out did not reach the server");
  }
}

// ---- loading ---------------------------------------------------------------

function load_everything(app: App): void {
  void load_catalogue(app);
  void refresh(app);
}

async function load_catalogue(app: App): Promise<void> {
  // `[0]` is the products and `[1]` the categories — see `api.grid`, which is
  // where the two lists are named and where a heading that will not decode
  // becomes this `err`.
  const [catalogue, err] = await attempt(api.grid(store.token_of(app)));
  if (err !== null) {
    store.reachable(app, false);
    repaint(app);
    return;
  }
  store.took_catalogue(app, catalogue[0], catalogue[1]);
  store.reachable(app, true);
  repaint(app);
}

async function refresh(app: App): Promise<void> {
  const [basket, err] = await attempt(api.basket(store.token_of(app)));
  if (err !== null) {
    store.reachable(app, false);
    store.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  store.took_basket(app, basket);
  repaint(app);
}

/**
 * A call that did not get through.
 *
 * The connection dot is set from this rather than from `navigator.onLine`,
 * which says true for a device attached to a router with no internet behind
 * it. Whether the last request actually worked is the only thing this end can
 * honestly know.
 */
function failed(app: App, why: string): void {
  store.reachable(app, false);
  store.went_wrong(app, why);
  repaint(app);
}

/**
 * What every basket-changing call does with its answer.
 *
 * One shape for all of them: a scan, a quantity change and a discount all come
 * back as the whole basket, so the lines, the totals and the badges cannot
 * show different numbers to each other.
 *
 * Every caller checks its own failure and only a success reaches here — this
 * function is about baskets, not about the network. The branch is on an
 * [`api.Answer`] variant, not on a `needs` string read out of a document.
 */
function settle(app: App, answer: api.Answer): void {
  store.reachable(app, true);
  switch (answer.tag) {
    // A 422 is a step in the sale rather than a failure of one: the till is
    // being told it needs ID, or a price, before this item can go on. Both
    // arms leave the basket exactly as it was — the item did not go on — and
    // neither dismisses, because each is *opening* a dialog.
    case "NeedsAgeCheck":
      // `code` is empty because the server's age_check 422 does not send
      // one: it identifies the product by id, and the re-scan on approval
      // goes back out by `product_id`.
      store.show(app, {
        tag: "AgeCheck",
        name: answer.name,
        min_age: answer.min_age,
        born_before: answer.born_before,
        code: "",
        product_id: answer.product_id,
      });
      repaint(app);
      return;
    // `unit` is carried on the answer and the price dialog has nowhere to put
    // it yet, so it is set aside here rather than at the boundary.
    case "NeedsPrice":
      store.show(app, { tag: "AskPrice", name: answer.name, product_id: answer.product_id });
      repaint(app);
      return;
    // The ordinary path, and the one an untagged answer takes.
    case "Basket":
      store.took_basket(app, answer.basket);
      store.dismiss(app);
      repaint(app);
      return;
  }
}

// ---- ringing ---------------------------------------------------------------

function scan_typed(app: App): void {
  const code = field_value("#scan");
  if (code.length === 0) {
    return;
  }
  browser.clear_field("#scan");
  store.working(app, true);
  void do_scan(app, code, "", 0.0, false, 0, false);
}

function tap_tile(app: App, product_id: string): void {
  const product = store.product_of(app, product_id);
  if (product === null) {
    return;
  }
  store.working(app, true);
  repaint(app);
  void do_scan(app, "", product_id, 1.0, false, 0, false);
}

async function do_scan(
  app: App,
  code: string,
  product_id: string,
  qty: number,
  age_checked: boolean,
  price: number,
  ask_price: boolean,
): Promise<void> {
  const [answer, err] = await attempt(
    api.scan(store.token_of(app), code, product_id, qty, age_checked, price, ask_price),
  );
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  settle(app, answer);
}

async function do_qty(app: App, line_id: string, qty: number): Promise<void> {
  const [answer, err] = await attempt(api.set_qty(store.token_of(app), line_id, qty));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  settle(app, answer);
}

async function do_adjust(app: App, line_id: string, kind: string, value: number, manager_pin: string): Promise<void> {
  const [answer, err] = await attempt(api.adjust_line(store.token_of(app), line_id, kind, value, manager_pin));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  settle(app, answer);
}

async function do_hold(app: App, label: string): Promise<void> {
  const [answer, err] = await attempt(api.hold(store.token_of(app), label));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  settle(app, answer);
}

async function do_recall(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.recall(store.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  settle(app, answer);
}

async function do_void_sale(app: App, reason: string, manager_pin: string): Promise<void> {
  const [answer, err] = await attempt(api.void_sale(store.token_of(app), reason, manager_pin));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  settle(app, answer);
}

async function load_held(app: App): Promise<void> {
  const [parked, err] = await attempt(api.held(store.token_of(app)));
  if (err !== null) {
    store.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  store.took_held(app, parked);
  store.show(app, { tag: "Held" });
  repaint(app);
}

async function do_search(app: App, q: string): Promise<void> {
  const [found, err] = await attempt(api.search(store.token_of(app), q));
  if (err !== null) {
    return;
  }
  store.found_products(app, found);
  repaint(app);
}

async function do_price_check(app: App, code: string): Promise<void> {
  const [answer, err] = await attempt(api.price_check(store.token_of(app), code));
  if (err !== null) {
    store.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  const saved = answer.promo_saved;
  let detail = answer.sku;
  if (saved > 0) {
    detail = `${detail} · ${answer.promo_name} · ${i18n.t(app.lang, "saved")} ${money.show(saved, store.currency_of(app))}`;
  }
  store.show(app, {
    tag: "PriceCheck",
    name: answer.name,
    detail,
    price: money.show(answer.total, store.currency_of(app)),
  });
  repaint(app);
}

// ---- taking payment --------------------------------------------------------

function add_tender(app: App): void {
  const typed = money.from_keys(app.entry, store.currency_of(app));
  if (typed === null) {
    return;
  }
  if (typed <= 0) {
    return;
  }
  const due = store.balance_due(app);
  // Only cash returns change, so a card or a wallet may not be charged more
  // than the balance. The till refuses it here rather than letting the server
  // do it, because the cashier is standing in front of the customer.
  if (!model.returns_change(app.tender) && typed > due) {
    store.went_wrong(app, i18n.t(app.lang, "only_cash_change"));
    repaint(app);
    return;
  }
  // A tab belongs to somebody, and only up to what they are trusted with.
  //
  // Both of these are refused by the server too — they have to be, because a
  // limit enforced only at a lane is not a limit. Saying so here is about
  // *when* the cashier finds out: while the customer is still choosing how
  // to pay, rather than after pressing Pay on a basket that has to be taken
  // apart again.
  if (model.needs_customer(app.tender) && app.basket.customer_name.length === 0) {
    // Two tenders need somebody and they need them for opposite reasons, so
    // they say so differently: store credit is a balance the shop owes and
    // has none to spend without a holder; a tab is a balance the shop is
    // owed and has nobody to chase.
    store.went_wrong(
      app,
      app.tender === "OnAccount"
        ? i18n.t(app.lang, "tab_needs_customer")
        : i18n.t(app.lang, "credit_needs_customer"),
    );
    repaint(app);
    return;
  }
  if (app.tender === "OnAccount" && typed > store.tab_room(app)) {
    store.went_wrong(app, i18n.t(app.lang, "tab_no_room"));
    repaint(app);
    return;
  }
  store.add_payment(app, { tender: app.tender, amount: typed, reference: "" });
  repaint(app);
}

function finish(app: App): void {
  if (app.busy) {
    return;
  }
  if (store.balance_due(app) > 0) {
    return;
  }
  if (app.taken.length === 0) {
    return;
  }
  store.working(app, true);
  repaint(app);
  void do_pay(app);
}

async function do_pay(app: App): Promise<void> {
  // The idempotency key is made once **per basket**, not once per attempt —
  // see `store.pay_key_of`. A lane that loses the answer and presses Pay
  // again sends the same key and lands on the same sale, which is the whole
  // reason the server takes one.
  const [answer, err] = await attempt(
    api.pay(store.token_of(app), app.taken, store.pay_key_of(app, token())),
  );
  if (err !== null) {
    store.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  const change = answer.change;
  const number = answer.number;
  const owing = answer.on_account;
  store.clear_payments(app);
  store.go_to_mode(app, "Sale");
  // The one line the cashier reads back to the customer: change first,
  // because there is money in their hand waiting for it, then what went on
  // the tab. **Both, not one or the other** — a customer who says "put 500 on
  // my tab" and hands over the only note they have gets change *and* a debt.
  // The tab figure comes back off the rows, so a replay says the same thing.
  let said = `#${number}`;
  if (change > 0) {
    said = `${said} · ${i18n.t(app.lang, "change_due")} ${money.show(change, store.currency_of(app))}`;
  }
  if (owing > 0) {
    said = `${said} · ${i18n.t(app.lang, "on_account")} ${money.show(owing, store.currency_of(app))}`;
  }
  store.say(app, said);
  repaint(app);
  void refresh(app);
}

// ---- what a touch means ----------------------------------------------------

function command(app: App, id: string): void {
  switch (id) {
    case "hold":
      store.show(app, { tag: "Confirm", purpose: "hold", message: i18n.t(app.lang, "label") });
      repaint(app);
      return;
    case "held":
      void load_held(app);
      return;
    case "price_check": {
      const code = field_value("#scan");
      if (code.length === 0) {
        store.went_wrong(app, i18n.t(app.lang, "scan_hint"));
        repaint(app);
        return;
      }
      browser.clear_field("#scan");
      void do_price_check(app, code);
      return;
    }
    case "void_sale":
      store.show(app, { tag: "Confirm", purpose: "void_sale", message: i18n.t(app.lang, "reason") });
      repaint(app);
      return;
    case "discount": {
      const line = app.basket.lines.at(-1);
      if (line === undefined) {
        return;
      }
      store.show(app, {
        tag: "Keypad",
        purpose: "discount",
        line_id: line.id,
        title: `${i18n.t(app.lang, "discount")} · ${line.name}`,
      });
      repaint(app);
      return;
    }
    case "customer":
      store.show(app, { tag: "Customers" });
      repaint(app);
      browser.focus("#who");
      void load_customers(app, "");
      return;
    case "return":
      store.show(app, { tag: "Receipts", purpose: "return" });
      repaint(app);
      browser.focus("#receipt");
      void load_receipts(app, "");
      return;
    case "receipt":
      store.show(app, { tag: "Receipts", purpose: "print" });
      repaint(app);
      browser.focus("#receipt");
      void load_receipts(app, "");
      return;
    case "no_sale":
      // Manager-only and logged to the shift: the drawer coming open outside
      // a transaction is the single most useful line in an audit trail.
      store.show(app, { tag: "Confirm", purpose: "no_sale", message: i18n.t(app.lang, "why") });
      repaint(app);
      return;
    case "close_lane":
      store.show(app, { tag: "Keypad", purpose: "close_lane", line_id: "", title: i18n.t(app.lang, "counted") });
      repaint(app);
      return;
    // A command the matrix names but this build does not handle yet does
    // nothing.
    default:
      return;
  }
}

// ---- customers, returns, the drawer ----------------------------------------

async function load_customers(app: App, q: string): Promise<void> {
  const [who, err] = await attempt(api.customers_at_till(store.token_of(app), q));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  store.took_customers(app, who);
  repaint(app);
}

async function do_attach_customer(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.set_customer(store.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  settle(app, answer);
}

/**
 * Money off a tab, taken at the counter.
 *
 * A plain function in front of the async one, like `finish`: the busy flag has
 * to be set here, before anything is awaited, or a double tap sends two
 * settlements.
 */
function settle_tab(app: App, customer_id: string): void {
  if (app.busy) {
    return;
  }
  const typed = money.from_keys(app.entry, store.currency_of(app));
  if (typed === null) {
    return;
  }
  if (typed <= 0) {
    return;
  }
  store.working(app, true);
  repaint(app);
  void do_settle_tab(app, customer_id, typed);
}

async function do_settle_tab(app: App, customer_id: string, value: number): Promise<void> {
  // The key is kept on `App` against this customer, not made here and not
  // held in the dialog — see `store.settle_key_of`. A key of its own, too,
  // not the basket's: `pay_key` belongs to a sale and is reset when the
  // basket changes, and borrowing it would let a retried settlement be
  // answered with a sale.
  const [answer, err] = await attempt(
    api.pay_tab(store.token_of(app), customer_id, value, "Cash", store.settle_key_of(app, customer_id, token())),
  );
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  store.reachable(app, true);
  store.settled_tab(app);
  store.dismiss(app);
  // What was taken, and what is left — the two things the cashier reads back
  // over the counter.
  store.say(
    app,
    `${i18n.t(app.lang, "tab_paid")} ${money.show(answer.total, store.currency_of(app))} · ${i18n.t(app.lang, "owes")} ${money.show(answer.owed, store.currency_of(app))}`,
  );
  store.working(app, false);
  // **Drawn here, before the refresh.** Without this the dialog sat there for
  // a whole round trip after the money had been taken, and if that basket
  // read then failed on the same bad link, the first paint after a
  // *successful* settlement was the red offline bar with the confirmation
  // never shown at all.
  repaint(app);
  // The basket is refreshed because the customer on it may be the one who
  // just settled, and the tender screen reads their remaining room off it.
  void refresh(app);
}

async function do_new_customer(app: App, name: string, phone: string): Promise<void> {
  const [answer, err] = await attempt(api.new_customer(store.token_of(app), name, phone));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  void do_attach_customer(app, answer.id);
}

async function load_slip(app: App, id: string): Promise<void> {
  const [slip, err] = await attempt(api.slip(store.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  store.took_slip(app, slip);
  repaint(app);
}

async function load_receipts(app: App, q: string): Promise<void> {
  const [found, err] = await attempt(api.receipts(store.token_of(app), q));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  store.took_receipts(app, found);
  repaint(app);
}

async function load_receipt(app: App, id: string): Promise<void> {
  const [answer, err] = await attempt(api.receipt(store.token_of(app), id));
  if (err !== null) {
    failed(app, err.message);
    return;
  }
  store.took_return_lines(app, answer.lines);
  store.show(app, { tag: "Returning", sale_id: id, number: answer.number });
  repaint(app);
}

function step_return(app: App, id: string, by: number): void {
  const line = app.returning.find((l) => l.id === id);
  if (line === undefined) {
    return;
  }
  store.set_return_qty(app, id, line.taking + by);
  repaint(app);
}

async function do_return(app: App, sale_id: string, reason: string, manager_pin: string): Promise<void> {
  const [answer, err] = await attempt(
    api.take_return(store.token_of(app), sale_id, app.returning, reason, manager_pin),
  );
  if (err !== null) {
    store.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  store.dismiss(app);
  // **What leaves the drawer, not what the goods were worth.**
  //
  // A refund has two legs: anything the customer still owes on the sale comes
  // off their tab first, and only the remainder is counted out of the till.
  // Saying the total here told the cashier to hand over money the shop was
  // never going to book — a K900 line on a basket half paid on account reads
  // "Return K900" while the drawer only expects K400 to leave, so the lane
  // closes short by the difference and the customer is up by it. Both figures
  // are on the answer; both are said.
  const back = doc.int_of(answer, "total", 0);
  const tab = doc.int_of(answer, "on_account", 0);
  const money_back = back - tab;
  let said = `${i18n.t(app.lang, "return")} ${money.show(money_back, store.currency_of(app))}`;
  if (tab > 0) {
    said = `${said} · ${i18n.t(app.lang, "on_account")} ${money.show(tab, store.currency_of(app))}`;
  }
  store.say(app, said);
  repaint(app);
  void refresh(app);
}

async function do_no_sale(app: App, reason: string, manager_pin: string): Promise<void> {
  const [, err] = await attempt(api.no_sale(store.token_of(app), reason, manager_pin));
  if (err !== null) {
    store.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  store.dismiss(app);
  store.say(app, i18n.t(app.lang, "no_sale"));
  repaint(app);
}

async function do_close_lane(app: App, counted: number, manager_pin: string): Promise<void> {
  const [answer, err] = await attempt(api.close_lane(store.token_of(app), counted, manager_pin));
  if (err !== null) {
    store.went_wrong(app, err.message);
    repaint(app);
    return;
  }
  // The lane's sessions are gone, so this device is signed out — which is
  // what closing a drawer means.
  const variance = answer.variance;
  browser.drop_kept("kite-pos.token");
  store.signed_out(app);
  store.say(app, `${i18n.t(app.lang, "close_lane")} · ${money.show(variance, store.currency_of(app))}`);
  repaint(app);
}

/**
 * A press on anything that carries a `data-action`.
 *
 * The element the handler is attached to is the one whose action counts, and
 * the press stops there: a button inside a row that has its own action — Pay
 * tab inside a customer's row — does what the button says and not what the
 * row says as well.
 */
function clicked(app: App, e: MouseEvent<HTMLElement>): void {
  const acted = e.currentTarget;
  e.stopPropagation();
  const name = acted.getAttribute("data-action");
  if (name === null) {
    return;
  }
  const id = acted.getAttribute("data-id") ?? "";
  const purpose = acted.getAttribute("data-purpose") ?? "";
  e.preventDefault();

  if (name === "pin-key") {
    press_pin(app, id);
    return;
  }
  if (name === "pin-go") {
    submit_pin(app);
    return;
  }
  if (name === "lang-en") {
    store.set_lang(app, "En");
    browser.keep("kite-pos.lang", "en");
    repaint(app);
    return;
  }
  if (name === "lang-my") {
    store.set_lang(app, "My");
    browser.keep("kite-pos.lang", "my");
    repaint(app);
    return;
  }
  if (name === "tab") {
    store.set_tab(app, id);
    repaint(app);
    return;
  }
  if (name === "tile") {
    tap_tile(app, id);
    return;
  }
  if (name === "line") {
    const line = store.line_of(app, id);
    if (line === null) {
      return;
    }
    store.show(app, {
      tag: "Keypad",
      purpose: "qty",
      line_id: id,
      title: `${i18n.t(app.lang, "quantity")} · ${line.name}`,
    });
    repaint(app);
    return;
  }
  if (name === "command") {
    command(app, id);
    return;
  }
  if (name === "dismiss") {
    // Not while something is in flight. Closing a dialog whose request has
    // not answered yet is how a cashier ends up sending the same money
    // twice — they are shown "the lane is offline", close the dialog
    // *because* of it, and open a fresh one. The key on `App` makes the
    // retry safe either way; this makes the dialog stop lying about being
    // idle.
    if (app.busy) {
      return;
    }
    store.dismiss(app);
    repaint(app);
    return;
  }
  if (name === "pay") {
    if (app.basket.lines.length === 0) {
      return;
    }
    store.go_to_mode(app, "Tender");
    repaint(app);
    return;
  }
  if (name === "back-to-sale") {
    store.clear_payments(app);
    store.go_to_mode(app, "Sale");
    repaint(app);
    return;
  }
  if (name === "tender") {
    // **The repaint stays outside.** For an id none of these names it runs
    // alone, which redraws the screen as it stands.
    switch (id) {
      case "cash":
        store.choose_tender(app, "Cash");
        break;
      case "card":
        store.choose_tender(app, "Card");
        break;
      case "wallet":
        store.choose_tender(app, "Wallet");
        break;
      case "store_credit":
        store.choose_tender(app, "StoreCredit");
        break;
      case "on_account":
        store.choose_tender(app, "OnAccount");
        break;
    }
    repaint(app);
    return;
  }
  if (name === "key") {
    store.press_key(app, id);
    repaint(app);
    return;
  }
  if (name === "quick") {
    store.set_entry(app, id);
    repaint(app);
    return;
  }
  if (name === "add-tender") {
    add_tender(app);
    return;
  }
  if (name === "finish") {
    finish(app);
    return;
  }
  if (name === "age-ok") {
    const product_id = acted.getAttribute("data-pid") ?? "";
    store.dismiss(app);
    repaint(app);
    void do_scan(app, id, product_id, 0.0, true, 0, false);
    return;
  }
  if (name === "price-ok") {
    const typed = money.from_keys(app.entry, store.currency_of(app));
    if (typed === null) {
      return;
    }
    store.dismiss(app);
    repaint(app);
    void do_scan(app, "", id, 1.0, false, typed, true);
    return;
  }
  if (name === "keypad-ok") {
    const typed = money.from_keys(app.entry, store.currency_of(app));
    if (typed === null) {
      return;
    }
    // Note `close_lane` passes no line id — it is a drawer count, not a line
    // amount.
    switch (purpose) {
      case "qty":
        store.dismiss(app);
        repaint(app);
        void do_qty(app, id, typed);
        return;
      case "discount":
        // A discount is the "PIN" row of the command matrix: a cashier may
        // take one with a manager's PIN entered at the lane, and a manager
        // needs nobody. The till asks either way and the server decides.
        store.show(app, { tag: "ManagerPin", purpose: "discount", line_id: id, amount: typed });
        repaint(app);
        return;
      case "override":
        store.show(app, { tag: "ManagerPin", purpose: "override", line_id: id, amount: typed });
        repaint(app);
        return;
      case "close_lane":
        store.show(app, { tag: "ManagerPin", purpose: "close_lane", line_id: "", amount: typed });
        repaint(app);
        return;
    }
    return;
  }
  if (name === "manager-ok") {
    const pin = app.entry;
    const value = parse_int(acted.getAttribute("data-amount") ?? "0") ?? 0;
    store.dismiss(app);
    repaint(app);
    // **The default is not a no-op.** Everything this does not name — today
    // "discount" and "override" — goes to `do_adjust` with `purpose` as the
    // kind, so the default forwards the purpose rather than falling silent.
    // Spelling those two out instead would drop any adjust kind the server
    // grows later.
    switch (purpose) {
      case "void_sale":
        void do_void_sale(app, "voided at the lane", pin);
        return;
      case "return":
        // The reason was parked in `notice` when the operator confirmed the
        // lines; it is the only thing that has to survive the PIN dialog.
        void do_return(app, id, app.notice, pin);
        return;
      case "no_sale":
        void do_no_sale(app, app.notice, pin);
        return;
      case "close_lane":
        void do_close_lane(app, value, pin);
        return;
      default:
        void do_adjust(app, id, purpose, value, pin);
        return;
    }
  }
  if (name === "confirm-ok") {
    const typed = field_value("#reason");
    if (typed.length === 0) {
      return;
    }
    store.dismiss(app);
    repaint(app);
    if (purpose === "hold") {
      void do_hold(app, typed);
      return;
    }
    if (purpose === "void_sale") {
      void do_void_sale(app, typed, "");
      return;
    }
    if (purpose === "no_sale") {
      store.say(app, typed);
      store.show(app, { tag: "ManagerPin", purpose: "no_sale", line_id: "", amount: 0 });
      repaint(app);
      return;
    }
    return;
  }
  if (name === "customer-pick") {
    store.dismiss(app);
    repaint(app);
    void do_attach_customer(app, id);
    return;
  }
  if (name === "pay-tab") {
    const who = app.customers.find((cu) => cu.id === id);
    if (who === undefined) {
      return;
    }
    store.show(app, { tag: "PayTab", customer_id: id, name: who.name, owed: who.owed });
    repaint(app);
    return;
  }
  if (name === "tab-ok") {
    settle_tab(app, id);
    return;
  }
  if (name === "customer-new") {
    const typed_name = field_value("#who");
    if (typed_name.length === 0) {
      return;
    }
    store.dismiss(app);
    repaint(app);
    void do_new_customer(app, typed_name, "");
    return;
  }
  if (name === "receipt-pick") {
    // The same list serves two commands, so the tap follows the reason it
    // was opened rather than assuming a return.
    if (app.overlay.tag === "Receipts") {
      if (app.overlay.purpose === "print") {
        void load_slip(app, id);
      } else {
        void load_receipt(app, id);
      }
    }
    return;
  }
  if (name === "slip-print") {
    browser.print_page();
    return;
  }
  if (name === "return-less") {
    step_return(app, id, -1.0);
    return;
  }
  if (name === "return-more") {
    step_return(app, id, 1.0);
    return;
  }
  if (name === "return-go") {
    const why = field_value("#reason");
    if (why.length === 0) {
      store.went_wrong(app, i18n.t(app.lang, "reason"));
      repaint(app);
      return;
    }
    // A return is the "PIN" row of the command matrix, so a manager proves
    // it at the lane before anything is paid out.
    store.show(app, { tag: "ManagerPin", purpose: "return", line_id: id, amount: 0 });
    store.say(app, why);
    repaint(app);
    return;
  }
  if (name === "recall") {
    store.dismiss(app);
    repaint(app);
    void do_recall(app, id);
    return;
  }
  if (name === "search") {
    store.show(app, { tag: "Search" });
    repaint(app);
    browser.focus("#find");
    return;
  }
  if (name === "keypad") {
    const line = app.basket.lines.at(-1);
    if (line === undefined) {
      return;
    }
    store.show(app, {
      tag: "Keypad",
      purpose: "qty",
      line_id: line.id,
      title: `${i18n.t(app.lang, "quantity")} · ${line.name}`,
    });
    repaint(app);
    return;
  }
  if (name === "sign-out") {
    sign_off(app);
    return;
  }
}

/**
 * Whether a bare keystroke belongs in the scan box.
 *
 * Only on the sale screen, only with no dialog in front of it, only when
 * somebody is signed in — and never when the caret is already in the box,
 * where the browser is doing the typing itself and a second copy of every
 * character would land.
 */
function routable(app: App, field: string): boolean {
  if (app.session === null) {
    return false;
  }
  if (app.mode !== "Sale") {
    return false;
  }
  if (app.overlay.tag !== "None") {
    return false;
  }
  return field !== "scan";
}

/**
 * Whether a keyboard shortcut may stand in for a press of the command bar.
 *
 * The bar is only drawn when somebody is signed in, on the sale screen, with
 * no dialog over it — and a press is refused while a request is in flight.
 * A function key answers to all four.
 */
function commandable(app: App): boolean {
  if (app.session === null) {
    return false;
  }
  if (app.busy) {
    return false;
  }
  if (app.overlay.tag !== "None") {
    return false;
  }
  return app.mode === "Sale";
}

/**
 * Every key the page sees, wherever the focus happens to be.
 *
 * This listener is on the **document**, because a keystroke with nothing
 * focused — the ordinary state of the screen after a tap — goes to `<body>`,
 * which sits above the rendered tree rather than inside it.
 */
function typed(app: App, e: KeyboardEvent): void {
  const key = e.key ?? "";
  const hit = e.target;
  // A target that is not an element is the document or `<body>` — which is
  // exactly the case this listener is here to catch, so it is a blank field
  // rather than a reason to return.
  let field = "";
  if (hit instanceof Element) {
    field = hit.getAttribute("id") ?? "";
  }

  // `preventDefault` is called per case and deliberately not everywhere:
  // Escape and every unnamed key are left to the browser, and so is Enter
  // inside the reason box — which is why "reason" is its own empty case
  // rather than folded into the default.
  switch (key) {
    case "Enter":
      switch (field) {
        case "scan":
          e.preventDefault();
          scan_typed(app);
          return;
        case "find":
          e.preventDefault();
          void do_search(app, field_value("#find"));
          return;
        case "reason":
          return;
        // Enter with the focus anywhere else — or nowhere at all.
        //
        // A scanner ends its burst with one, and by then its characters are
        // already in the box because the default case at the bottom put them
        // there. So a box with something in it is what says "that was a
        // scanner"; an empty one leaves Enter to the button under the
        // operator's finger, where it belongs.
        default:
          if (!routable(app, field)) {
            return;
          }
          if (field_value("#scan").length === 0) {
            return;
          }
          e.preventDefault();
          scan_typed(app);
          return;
      }
    case "Escape":
      if (app.busy) {
        return;
      }
      store.dismiss(app);
      repaint(app);
      return;
    // Xstore maps every menu button to a function key, and a counter with a
    // keyboard is faster for it. F2 is the commit, which is the one worth
    // having under a finger.
    //
    // **Each one is gated exactly as the button beside it is.** A modal
    // focuses no input, so a stray F3 while a manager was typing their PIN
    // would replace the authorisation dialog with the held list and take the
    // reason it was carrying with it. A key must not reach a command a finger
    // could not.
    case "F2":
      e.preventDefault();
      if (!commandable(app)) {
        return;
      }
      if (app.basket.lines.length > 0 && app.mode === "Sale") {
        store.go_to_mode(app, "Tender");
        repaint(app);
      }
      return;
    case "F3":
      e.preventDefault();
      if (!commandable(app)) {
        return;
      }
      command(app, "hold");
      return;
    case "F4":
      e.preventDefault();
      if (!commandable(app)) {
        return;
      }
      command(app, "held");
      return;
    // **The scanner, typing into a box it has not got the caret in.**
    //
    // One bare character. The operator has tapped a tile, so the focus is on
    // a button; the scanner fires anyway, because it is a keyboard and it
    // does not know that. Each character is written into the scan box
    // instead of going wherever the focus is, and the Enter that ends the
    // burst rings it up.
    //
    // Space is excluded: a space on a focused button is that button being
    // pressed, and no barcode this shop scans contains one.
    default:
      if (str_len(key) !== 1 || key === " ") {
        return;
      }
      if (!browser.plain_key(e)) {
        return;
      }
      if (routable(app, field)) {
        e.preventDefault();
        browser.append_value("#scan", key);
        return;
      }
      // **A scan that cannot be rung is said out loud.**
      //
      // The dialogs a scan itself raises — an age check, a price to ask for —
      // carry no input of their own, so nothing has the focus while one is
      // up. A cashier looking at a customer's ID scans the next two items out
      // of habit, the characters reach a till that is not in a state to ring
      // them, and without this they go nowhere at all: no red band, no line
      // on the basket, and the scanner beeped both times. Those items leave
      // the shop unpaid.
      //
      // Only when nothing is focused. A character typed into a dialog's own
      // box — a manager's PIN, a reason — is the operator answering the
      // dialog, and belongs to it.
      if (field.length === 0 && app.session !== null && app.overlay.tag !== "None") {
        store.went_wrong(app, i18n.t(app.lang, "finish_this_first"));
        repaint(app);
      }
      return;
  }
}

// ---- starting up -----------------------------------------------------------

function main(): void {
  const root = document.querySelector("#app");
  if (root === null) {
    console.error("till: there is no #app to mount into");
    return;
  }
  view = createRoot(root);

  const lang = i18n.of_code(browser.kept("kite-pos.lang") ?? "en");
  const app = store.holding(lang);

  // Read before the first paint rather than after it: a kept token means
  // somebody is signed in until the Worker says otherwise, and a paint that
  // ignored it would put a PIN pad in front of a cashier who already was. The
  // ask itself still happens last, once the listeners are on.
  const kept_token = browser.kept("kite-pos.token");
  if (kept_token !== null) {
    store.restoring(app, true);
  }
  repaint(app);

  // On the document rather than the root: a scanner types wherever the focus
  // happens to be, and a keystroke that lands outside the rendered tree still
  // has to reach the scan box.
  document.addEventListener("keydown", (e) => typed(app, e));

  browser.register_worker("/sw.js");

  if (kept_token !== null) {
    void resume(app, kept_token);
  }
}

main();
