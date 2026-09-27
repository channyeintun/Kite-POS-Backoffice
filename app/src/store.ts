//! What the till is holding.
//!
//! One object and the functions that write to it. Every field a handler
//! changes is written by one of the small functions at the bottom, so the
//! complete list of ways this value changes is on one screen. Mutation is
//! spelled out in a function name rather than scattered through the handlers.
//!
//! The store holds no React element and knows nothing about the document. What
//! is on screen is a pure function of this value, computed in `till.tsx`, so
//! two parts of the till cannot disagree about the total — neither of them
//! holds a copy of it.

import * as model from "./model.ts";
import type { Lang } from "./i18n.ts";
import * as money from "./money.ts";
import { sorted } from "./lang.ts";

/**
 * Which surface the work area is showing.
 *
 * Named states rather than a boolean, because the business rules differ:
 * sale mode takes scans and tender mode does not, and the ledger is locked in
 * the second. Emerald documents the same two as named modes for the same
 * reason.
 */
export type Mode = "Sale" | "Tender";

/**
 * What is in front of everything else.
 *
 * One value rather than a flag per dialog, so two cannot be open at once —
 * which on a till is not a cosmetic problem: a scan landing behind an age
 * check is an item nobody checked ID for.
 */
export type Overlay =
  | { tag: "None" }
  /** Scanning tobacco or alcohol stops the sale and asks for ID first. */
  | { tag: "AgeCheck"; name: string; min_age: number; born_before: number; code: string; product_id: string }
  /** The shelf price is not in the system, so the operator is asked for it. */
  | { tag: "AskPrice"; name: string; product_id: string }
  | { tag: "Held" }
  | { tag: "Search" }
  /** The one numeric surface: quantity, a price, a discount, a tender. */
  | { tag: "Keypad"; purpose: string; line_id: string; title: string }
  /** A manager, proving it at the lane. */
  | { tag: "ManagerPin"; purpose: string; line_id: string; amount: number }
  | { tag: "Confirm"; purpose: string; message: string }
  | { tag: "PriceCheck"; name: string; detail: string; price: string }
  /** Attaching somebody to the basket, or signing them up at the counter. */
  | { tag: "Customers" }
  /**
   * Picking a receipt, for one of two reasons.
   *
   * `purpose` is "return" or "print". The same list either way — the last
   * twenty sales, newest first — and the tap on a row goes somewhere
   * different depending on why it was opened. A separate overlay for each
   * would be the same list twice.
   */
  | { tag: "Receipts"; purpose: string }
  /**
   * A receipt on screen, ready for the printer.
   *
   * The slip itself is on [`App`] rather than in the variant: it is a whole
   * document with lines and tenders in it, and the overlay only has to say
   * that it is being shown.
   */
  | { tag: "Slip" }
  | { tag: "Returning"; sale_id: string; number: number }
  /**
   * Somebody settling what they owe, at the counter.
   *
   * Not a sale and not a basket: no goods move, nothing is priced, and it
   * can be done with an empty till. `owed` is carried in the variant because
   * the dialog is opened from a row the search already fetched, and going
   * back for a figure that is on screen is a round trip a queue can feel.
   */
  | { tag: "PayTab"; customer_id: string; name: string; owed: number };

export const NO_OVERLAY: Overlay = { tag: "None" };

export interface App {
  session: model.Session | null;
  lang: Lang;
  mode: Mode;
  overlay: Overlay;

  basket: model.Basket;
  held: model.Held[];
  products: model.Product[];
  categories: model.Category[];
  found: model.Product[];
  /**
   * Customers matching what was typed, and the receipts a return can be
   * taken against. Held as values rather than documents because the till
   * draws them and never fills a form from them.
   */
  customers: model.Customer[];
  receipts: model.Receipt[];
  returning: model.ReturnLine[];
  /** The receipt being looked at, if one is. */
  slip: model.Slip | null;

  /** Which category tab the grid is showing; "" is Favourites. */
  tab: string;

  /** What the operator is typing on the numeric surface, as digits. */
  entry: string;
  /** Tenders taken so far in this transaction. */
  taken: model.Payment[];
  tender: model.Tender;

  /**
   * The idempotency key for the basket being paid, and which basket it is
   * for. Both, because a key that outlives its basket is worse than none:
   * the server would answer the *next* sale with the previous one.
   */
  pay_key: string;
  pay_key_for: string;

  /**
   * The same pair for a tab being settled, and which customer it is for.
   *
   * **On `App` rather than inside the dialog**, which is where it started
   * and where it was not safe. A key that lives in the overlay dies with the
   * overlay, and both ways out destroy it: Cancel and Escape both dismiss.
   * So the sequence that matters — the settlement commits, the answer is
   * lost on the way back, the cashier is shown "the lane is offline",
   * closes the dialog *because* they were told the lane is offline, and
   * reopens it to try again — minted a key the server had never seen and
   * took the money a second time. Anchored to the customer, reopening sends
   * the key the server already has and gets the first answer back.
   */
  settle_key: string;
  settle_key_for: string;

  /** The PIN pad, before anybody is signed in. */
  pin: string;

  /** What just happened, for the status line. Cleared by the next action. */
  notice: string;
  trouble: string;

  /**
   * Whether the last request to the Worker succeeded.
   *
   * `navigator.onLine` says true for a device attached to a router with no
   * internet behind it, so this — did the last call actually work — is what
   * the connection dot reports.
   */
  online: boolean;
  busy: boolean;
  signing_in: boolean;

  /**
   * Whether a kept token is still being checked with the Worker.
   *
   * A reload has a token in hand and no session yet, and those are not the
   * same thing as being signed out — but `session` is null in both, so the
   * page drew the PIN pad and then replaced it a moment later. Against the
   * deployed Worker that moment is a preflight and a request, and a cashier
   * can get two digits into a pad that is about to vanish.
   *
   * So it is set before the first paint of a reload and cleared by whichever
   * answer arrives — a session, or the sign-in screen for a token the Worker
   * would not have.
   */
  restoring: boolean;
}

export function holding(lang: Lang): App {
  return {
    session: null,
    lang,
    mode: "Sale",
    overlay: NO_OVERLAY,
    basket: model.empty_basket(),
    held: [],
    products: [],
    categories: [],
    found: [],
    customers: [],
    receipts: [],
    returning: [],
    slip: null,
    tab: "",
    entry: "",
    taken: [],
    tender: "Cash",
    pay_key: "",
    pay_key_for: "",
    settle_key: "",
    settle_key_for: "",
    pin: "",
    notice: "",
    trouble: "",
    online: true,
    busy: false,
    signing_in: false,
    restoring: false,
  };
}

export function currency_of(app: App): money.Currency {
  const session = app.session;
  if (session === null) {
    return money.kyat();
  }
  return session.currency;
}

export function token_of(app: App): string {
  const session = app.session;
  if (session === null) {
    return "";
  }
  return session.token;
}

/** What is still owed on this transaction. */
export function balance_due(app: App): number {
  let paid = 0;
  for (const p of app.taken) {
    paid = paid + p.amount;
  }
  return app.basket.totals.total - paid;
}

/**
 * What is still allowed to go on this basket's tab.
 *
 * The customer's limit, less what they already owe, less whatever has already
 * been put on the tab in *this* transaction — the last term is the one a
 * server-side check cannot help with, because those tenders have not been sent
 * yet. Zero for a walk-in and zero for a customer nobody has given a limit,
 * which is the same refusal for two reasons and is why they read alike.
 */
export function tab_room(app: App): number {
  let already = 0;
  for (const p of app.taken) {
    if (p.tender === "OnAccount") {
      already = already + p.amount;
    }
  }
  const room = app.basket.customer_limit - app.basket.customer_owed - already;
  if (room < 0) {
    return 0;
  }
  return room;
}

export function change_due(app: App): number {
  const due = balance_due(app);
  if (due < 0) {
    return -due;
  }
  return 0;
}

/** A line the operator is pointing at. */
export function line_of(app: App, id: string): model.Line | null {
  return app.basket.lines.find((l) => l.id === id) ?? null;
}

/**
 * The tiles the grid is showing.
 *
 * Favourites is the pinned set in the order a manager arranged it; a category
 * tab is everything in that category. The whole catalogue is already here, so
 * changing tabs is arithmetic rather than a request.
 */
export function tiles(app: App): model.Product[] {
  if (app.tab.length === 0) {
    const pinned = app.products.filter((p) => p.quick_key > 0);
    return sorted(pinned, (a, b) => a.quick_key < b.quick_key);
  }
  return app.products.filter((p) => p.category_id === app.tab);
}

export function product_of(app: App, id: string): model.Product | null {
  return app.products.find((p) => p.id === id) ?? null;
}

/**
 * A product's name in the interface language.
 *
 * The catalogue does not translate — this is the one field a shop may keep a
 * second name in on purpose, and it falls back to the stored name.
 */
export function product_label(p: model.Product, l: Lang): string {
  if (l === "En") {
    return p.name;
  }
  return p.name_my.length > 0 ? p.name_my : p.name;
}

// ---- the writes ------------------------------------------------------------
//
// Each of these is a line or two long. They are the complete list of ways this
// value changes.

export function signed_in(app: App, session: model.Session): void {
  app.session = session;
  app.pin = "";
  app.signing_in = false;
  app.trouble = "";
  app.restoring = false;
}

export function signed_out(app: App): void {
  app.session = null;
  app.basket = model.empty_basket();
  app.taken = [];
  app.pay_key = "";
  app.pay_key_for = "";
  app.mode = "Sale";
  app.overlay = NO_OVERLAY;
  app.pin = "";
}

export function took_basket(app: App, basket: model.Basket): void {
  app.basket = basket;
  app.online = true;
  app.busy = false;
}

export function took_catalogue(app: App, products: model.Product[], categories: model.Category[]): void {
  app.products = products;
  app.categories = categories;
}

export function took_held(app: App, held: model.Held[]): void {
  app.held = held;
}

export function found_products(app: App, found: model.Product[]): void {
  app.found = found;
}

export function took_customers(app: App, customers: model.Customer[]): void {
  app.customers = customers;
}

export function took_receipts(app: App, receipts: model.Receipt[]): void {
  app.receipts = receipts;
}

export function took_return_lines(app: App, lines: model.ReturnLine[]): void {
  app.returning = lines;
}

/** How much of one line is coming back, as the operator taps it up and down. */
export function set_return_qty(app: App, line_id: string, qty: number): void {
  app.returning = app.returning.map((l) =>
    l.id === line_id ? { ...l, taking: Math.min(Math.max(qty, 0.0), l.returnable) } : l,
  );
}

export function show(app: App, overlay: Overlay): void {
  app.overlay = overlay;
  app.entry = "";
}

export function dismiss(app: App): void {
  app.overlay = NO_OVERLAY;
  app.entry = "";
  app.found = [];
}

/**
 * Sale ⇄ Tender.
 *
 * **The message band is cleared with the mode.** A complaint raised on the
 * sale screen is about the sale screen — "Scan barcode or type SKU…" is the
 * answer to a Price check with an empty box, and the command bar that asks for
 * one is not even drawn in tender. It used to follow the cashier across
 * anyway: nothing cleared `trouble` on the way to Pay, so a stale red band sat
 * under the keypad for the rest of the transaction, taking a strip of height
 * off a screen that had none to spare.
 *
 * Cleared here rather than in the tender handlers: every one of those raises
 * its own message *after* this call, so none of them is swallowed.
 */
export function go_to_mode(app: App, mode: Mode): void {
  app.mode = mode;
  app.overlay = NO_OVERLAY;
  app.entry = "";
  app.trouble = "";
  app.notice = "";
}

export function set_tab(app: App, tab: string): void {
  app.tab = tab;
}

export function set_lang(app: App, lang: Lang): void {
  app.lang = lang;
}

/**
 * One more digit on whichever numeric surface is open.
 *
 * Bounded, because a cashier leaning on the 9 key should not be able to make
 * an amount that overflows the arithmetic behind it.
 */
export function press_key(app: App, key: string): void {
  if (key === "clear") {
    app.entry = "";
    return;
  }
  if (key === "back") {
    if (app.entry.length > 0) {
      app.entry = app.entry.slice(0, app.entry.length - 1);
    }
    return;
  }
  if (app.entry.length >= 9) {
    return;
  }
  if (app.entry.length === 0 && key === "000") {
    return;
  }
  app.entry = app.entry + key;
}

export function press_pin(app: App, key: string): void {
  if (key === "clear") {
    app.pin = "";
    return;
  }
  if (key === "back") {
    if (app.pin.length > 0) {
      app.pin = app.pin.slice(0, app.pin.length - 1);
    }
    return;
  }
  if (app.pin.length >= 8) {
    return;
  }
  app.pin = app.pin + key;
}

export function set_entry(app: App, entry: string): void {
  app.entry = entry;
}

export function choose_tender(app: App, tender: model.Tender): void {
  app.tender = tender;
  app.entry = "";
}

export function add_payment(app: App, payment: model.Payment): void {
  app.taken = [...app.taken, payment];
  app.entry = "";
}

export function clear_payments(app: App): void {
  app.taken = [];
  app.entry = "";
  app.pay_key = "";
  app.pay_key_for = "";
}

/**
 * The idempotency key for the basket on screen, minted once and kept.
 *
 * **A key made fresh on every attempt is not an idempotency key.** The retry
 * after a lost answer would carry a key the server had never seen — and the
 * server, which by then had completed the sale, could not match it to
 * anything. The lane would be told there was nothing to pay for, the cashier
 * would ring the basket again, and the shop would finish the day with two
 * sales for one basket of goods and a drawer short by the difference.
 *
 * `minted` is passed in because this module knows nothing about the browser.
 * It is used only when there is no key yet for this basket; the moment the
 * basket changes, so does the key.
 */
export function pay_key_of(app: App, minted: string): string {
  if (app.pay_key.length === 0 || app.pay_key_for !== app.basket.sale_id) {
    app.pay_key = minted;
    app.pay_key_for = app.basket.sale_id;
  }
  return app.pay_key;
}

/**
 * The idempotency key for the tab being settled, minted once and kept.
 *
 * The mirror of [`pay_key_of`], anchored to the customer rather than to a
 * basket. Cleared by [`settled_tab`] once the server has answered, so the next
 * settlement for the same person is a new one rather than a replay of the last.
 */
export function settle_key_of(app: App, customer_id: string, minted: string): string {
  if (app.settle_key.length === 0 || app.settle_key_for !== customer_id) {
    app.settle_key = minted;
    app.settle_key_for = customer_id;
  }
  return app.settle_key;
}

/** A tab settled, so the key that settled it must not settle the next one. */
export function settled_tab(app: App): void {
  app.settle_key = "";
  app.settle_key_for = "";
}

export function took_slip(app: App, slip: model.Slip): void {
  app.slip = slip;
  app.overlay = { tag: "Slip" };
}

export function say(app: App, notice: string): void {
  app.notice = notice;
  app.trouble = "";
}

export function went_wrong(app: App, trouble: string): void {
  app.trouble = trouble;
  app.busy = false;
}

export function working(app: App, busy: boolean): void {
  app.busy = busy;
}

export function signing_in(app: App, on: boolean): void {
  app.signing_in = on;
}

/** Set before the first paint when there is a kept token to check. */
export function restoring(app: App, on: boolean): void {
  app.restoring = on;
}

/** The connection dot, set by whether the last call actually worked. */
export function reachable(app: App, online: boolean): void {
  app.online = online;
}
