//! What the back office is holding.
//!
//! The counterpart to `store.ts`, and separate from it for the reason the two
//! apps are separate: a role decides which one a sign-in opens and there is no
//! navigation between them. A cashier's session cannot reach any of this, and
//! the Worker refuses it as well — this is not the only gate.
//!
//! ## A screen is a list of blocks
//!
//! The design gives the back office five ways of showing something: a row of
//! stat cards with a tone bar, a ranked list with a meter under each name, a
//! table, a grid of lane cards, and the pair of role cards on Staff & access.
//! So a screen here is `Block[]`, and adding one is a function that returns a
//! list — `office_view.tsx` already knows how to draw every shape.
//!
//! Same discipline as the till: no React element in here, no document, and
//! every field a handler changes written by a small function at the bottom.

import type { Doc } from "./doc.ts";
import * as doc from "./doc.ts";
import type { Lang } from "./i18n.ts";
import type * as model from "./model.ts";
import * as money from "./money.ts";
import * as words from "./words.ts";
import { clamp, div, round_to, str_len, str_slice, upper, words as words_of } from "./lang.ts";

/**
 * Which screen the rail is showing.
 *
 * **Tills is how a manager reaches a lane.** The register itself is not in
 * this navigation, because a manager cannot ring a sale from a desk — they
 * walk to the lane and authorise there, or take it over from here.
 */
export type Screen =
  | { tag: "Overview" }
  | { tag: "Tills" }
  | { tag: "Sales" }
  | { tag: "Shifts" }
  | { tag: "Products" }
  | { tag: "Inventory" }
  | { tag: "Movements" }
  | { tag: "Purchasing" }
  | { tag: "Suppliers" }
  | { tag: "Customers" }
  | { tag: "Promotions" }
  | { tag: "Reports" }
  | { tag: "Accounting" }
  | { tag: "Expenses" }
  | { tag: "Staff" }
  | { tag: "Settings" }
  /**
   * Drill-downs. Not in the rail — they are reached by touching a row, and
   * they carry the thing they are about in the address, so a manager can
   * send somebody a link to one receipt.
   */
  | { tag: "Product"; id: string }
  | { tag: "Sale"; id: string }
  | { tag: "Shift"; id: string }
  | { tag: "Order"; id: string };

type Plain = Exclude<Screen["tag"], "Product" | "Sale" | "Shift" | "Order">;

/** A screen with nothing in it but its name. */
export function screen(tag: Plain): Screen {
  return { tag };
}

/** Whether two screens are the same screen — about the same thing, too. */
export function same_screen(a: Screen, b: Screen): boolean {
  if (a.tag !== b.tag) {
    return false;
  }
  return !("id" in a) || !("id" in b) || a.id === b.id;
}

/** Every screen the rail lists, in order. Drill-downs are not among them. */
export function all_screens(): Screen[] {
  const tags: Plain[] = [
    "Overview",
    "Tills",
    "Sales",
    "Shifts",
    "Products",
    "Inventory",
    "Movements",
    "Purchasing",
    "Suppliers",
    "Customers",
    "Promotions",
    "Reports",
    "Accounting",
    "Expenses",
    "Staff",
    "Settings",
  ];
  return tags.map((tag) => screen(tag));
}

export function slug_of(s: Screen): string {
  switch (s.tag) {
    case "Overview":
      return "";
    case "Tills":
      return "tills";
    case "Sales":
      return "sales";
    case "Shifts":
      return "shifts";
    case "Products":
      return "products";
    case "Inventory":
      return "inventory";
    case "Movements":
      return "movements";
    case "Purchasing":
      return "purchasing";
    case "Suppliers":
      return "suppliers";
    case "Customers":
      return "customers";
    case "Promotions":
      return "promotions";
    case "Reports":
      return "reports";
    case "Accounting":
      return "accounting";
    case "Expenses":
      return "expenses";
    case "Staff":
      return "staff";
    case "Settings":
      return "settings";
    case "Product":
      return `products/${s.id}`;
    case "Sale":
      return `sales/${s.id}`;
    case "Shift":
      return `shifts/${s.id}`;
    case "Order":
      return `purchasing/${s.id}`;
  }
}

export function screen_of(hash: string): Screen {
  let body = hash;
  if (body.startsWith("#")) {
    body = body.slice(1);
  }
  if (body.startsWith("/")) {
    body = body.slice(1);
  }
  for (const s of all_screens()) {
    if (slug_of(s) === body) {
      return s;
    }
  }
  // `products/prd_x` is the product screen with a thing on it. Split rather
  // than matched, so one more drill-down is one more line here and nothing
  // else in the application.
  const parts = body.split("/");
  if (parts.length === 2 && parts[1].length > 0) {
    switch (parts[0]) {
      case "products":
        return { tag: "Product", id: parts[1] };
      case "sales":
        return { tag: "Sale", id: parts[1] };
      case "shifts":
        return { tag: "Shift", id: parts[1] };
      case "purchasing":
        return { tag: "Order", id: parts[1] };
      // Anything else falls through to Overview below, which is what an
      // address nobody wrote should land on.
    }
  }
  return screen("Overview");
}

export function href_of(s: Screen): string {
  return `#/${slug_of(s)}`;
}

export function title_of(s: Screen, l: Lang): string {
  return words.t(l, key_of(s));
}

/**
 * The phrase a screen is named by. Separate from [`title_of`] so the rail,
 * the page header and a document title all name a screen the same way.
 */
function key_of(s: Screen): string {
  switch (s.tag) {
    case "Overview":
      return "nav.overview";
    case "Tills":
      return "nav.tills";
    case "Sales":
      return "common.sales";
    case "Shifts":
      return "shifts.shifts";
    case "Products":
      return "common.products";
    case "Inventory":
      return "common.inventory";
    case "Movements":
      return "common.stock_movements";
    case "Purchasing":
      return "common.purchasing";
    case "Suppliers":
      return "common.suppliers";
    case "Customers":
      return "customers.customers";
    case "Promotions":
      return "promotions.promotions";
    case "Reports":
      return "common.reports";
    case "Accounting":
      return "common.accounting";
    case "Expenses":
      return "common.expenses";
    case "Staff":
      return "nav.staff_access";
    case "Settings":
      return "common.settings";
    case "Product":
      return "common.product";
    case "Sale":
      return "common.receipt";
    case "Shift":
      return "nav.shift";
    case "Order":
      return "nav.purchase_order";
  }
}

/** The rail item a drill-down belongs under, so it stays highlighted. */
export function rail_screen_of(s: Screen): Screen {
  switch (s.tag) {
    case "Product":
      return screen("Products");
    case "Sale":
      return screen("Sales");
    case "Shift":
      return screen("Shifts");
    case "Order":
      return screen("Purchasing");
    default:
      return s;
  }
}

/**
 * Which of the rail's three groups a screen belongs to.
 *
 * "" is the ungrouped set at the top — the day-to-day running of the shop.
 */
export function group_of(s: Screen): string {
  switch (s.tag) {
    case "Overview":
    case "Tills":
    case "Sales":
    case "Shifts":
    case "Sale":
    case "Shift":
      return "";
    case "Products":
    case "Inventory":
    case "Movements":
    case "Purchasing":
    case "Suppliers":
    case "Customers":
    case "Promotions":
    case "Product":
    case "Order":
      return "nav.store";
    case "Reports":
    case "Accounting":
    case "Expenses":
    case "Staff":
    case "Settings":
      return "layout.insight";
  }
}

// ---- the shapes a screen is made of ----------------------------------------

/**
 * A figure worth putting at the top of a screen.
 *
 * `tone` is machine state and only machine state — "" is neutral, and the
 * others paint the 4 px bar across the top of the card.
 */
export interface Stat {
  label: string;
  value: string;
  meta: string;
  tone: string;
}

/**
 * A ranked row with a meter under the name.
 *
 * `width` is a percentage of the largest in the set, computed where the data
 * is rather than in the view — the view has no idea what the maximum is and
 * should not have to hold the whole list to find out.
 */
export interface Meter {
  key: string;
  rank: string;
  name: string;
  value: string;
  sub: string;
  width: number;
}

export interface Row {
  key: string;
  cells: string[];
  /** "", "ok", "warn", "stop" — machine state, never decoration. */
  tone: string;
  action: string;
  id: string;
}

export interface Table {
  heading: string;
  note: string;
  columns: string[];
  rows: Row[];
}

/** One lane, as a card on Tills. */
export interface LaneCard {
  id: string;
  name: string;
  state: string;
  tone: string;
  initials: string;
  operator: string;
  since: string;
  drawer: string;
  sales: string;
  held: string;
  note: string;
  close_label: string;
  closeable: boolean;
}

/** One of the two role explainers on Staff & access. */
export interface RoleCard {
  role: string;
  opens: string;
  body: string;
  chips: string[];
}

/** A button that does something, at the top of a screen or on a card. */
export interface Action {
  label: string;
  /** What `office.tsx` should do — the same vocabulary a form id uses. */
  action: string;
  id: string;
  /** "filled", "soft", "quiet", "danger". */
  tone: string;
}

export function action(label: string, what: string, id: string, tone: string): Action {
  return { label, action: what, id, tone };
}

/**
 * One line of a delivery being booked into stock.
 *
 * **Held here, not on the server.** A shopkeeper adds lines one at a time
 * while the driver waits, and every one of those would otherwise be a request
 * that can fail on its own and leave half a delivery behind. Nothing is
 * written until the single press at the end, which carries the lot — and the
 * key that makes repeating that press free.
 */
export interface GoodsInLine {
  product_id: string;
  name: string;
  qty: number;
  unit_cost: number;
  /**
   * The shelf price this delivery goes out at, or null to leave the price
   * alone — which is nearly every delivery. The Worker keeps the old price
   * for what is already on the shelf and switches once that has sold.
   */
  new_price: number | null;
  /**
   * Whether the new price is for the stock already on the shelf too, at
   * once, rather than waiting for it to sell. Nothing without a price.
   */
  price_now: boolean;
}

/** A pair of label and value, for a detail header. */
export interface Fact {
  label: string;
  value: string;
  tone: string;
}

// ---- forms -----------------------------------------------------------------

/**
 * What kind of input a field wants.
 *
 * Deliberately few. A back office for a corner shop asks for text, a whole
 * number of minor units, a quantity, a choice from a list, and a yes or no —
 * and anything that does not fit one of those is a screen rather than a field.
 */
export type FieldKind =
  /** One line of text. */
  | { tag: "OneLine" }
  /** Multi-line, for a note or an address. */
  | { tag: "Lines" }
  /** An amount, entered the way a person writes one and parsed as digits. */
  | { tag: "Money" }
  /** A whole number that is not money — a lead time, a priority, basis points. */
  | { tag: "Whole" }
  /** The one legitimately fractional input. */
  | { tag: "Quantity" }
  | { tag: "Choice"; options: string[]; labels: string[] }
  | { tag: "Toggle" }
  | { tag: "Password" }
  /**
   * A product picture: a preview, and the two ways to replace it. The
   * field's value is the R2 key, or "" for a product with no picture.
   */
  | { tag: "Photo" }
  /** Shown, never edited — context the operator needs while filling the rest. */
  | { tag: "Readonly" };

export interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  value: string;
  hint: string;
  required: boolean;
}

export function field(name: string, label: string, kind: FieldKind, value: string): Field {
  return { name, label, kind, value, hint: "", required: false };
}

export function required(f: Field): Field {
  return { ...f, required: true };
}

export function hinted(f: Field, hint: string): Field {
  return { ...f, hint };
}

/**
 * A dialog that writes something.
 *
 * One shape for every write in the application: `office.tsx` matches on `id`
 * to decide which call to make, and `subject` carries the thing being changed.
 * Twenty forms are twenty entries in one `submit` function rather than twenty
 * screens.
 */
export interface Form {
  id: string;
  title: string;
  lede: string;
  fields: Field[];
  submit: string;
  subject: string;
  /**
   * The idempotency key this dialog's write carries, minted when it opened.
   *
   * Separate from `subject`, which is the thing being changed and is often
   * already spoken for — an invoice's subject is the invoice being paid, and
   * a key cannot be the invoice or every payment against it would be the
   * first one. `busy` stops a second press while the first is in flight;
   * this is for the press after an answer was lost, which no client-side
   * flag can catch.
   */
  key: string;
  /** Shown in red under the title when the server refused. */
  trouble: string;
  busy: boolean;
}

export function form(id: string, title: string, submit: string, fields: Field[]): Form {
  return { id, title, lede: "", fields, submit, subject: "", key: "", trouble: "", busy: false };
}

/** The key a form's write carries. See [`Form.key`]. */
export function keyed(f: Form, key: string): Form {
  return { ...f, key };
}

export function about(f: Form, subject: string): Form {
  return { ...f, subject };
}

export function explained(f: Form, lede: string): Form {
  return { ...f, lede };
}

/** What a screen is made of. */
export type Block =
  | { tag: "Stats"; items: Stat[] }
  | { tag: "Meters"; heading: string; note: string; rows: Meter[] }
  | { tag: "Grid"; table: Table }
  | { tag: "Lanes"; cards: LaneCard[] }
  | { tag: "Roles"; cards: RoleCard[] }
  /** A sentence where a screen needs to say something rather than show it. */
  | { tag: "Note"; heading: string; body: string }
  /** A row of buttons — "Add product", "Raise an order". */
  | { tag: "Buttons"; items: Action[] }
  /** The header of a drill-down: a title, some facts, and what can be done. */
  | { tag: "Detail"; title: string; subtitle: string; facts: Fact[]; actions: Action[] }
  /** A receipt, laid out to be printed. */
  | { tag: "Receipt"; lines: string[]; head: string[]; foot: string[] };

export interface App {
  session: model.Session | null;
  screen: Screen;
  /**
   * Which language the chrome is in. The same shape the till uses — see
   * `store.App` — so the back office follows the pattern rather than
   * inventing a second one.
   */
  lang: Lang;
  blocks: Block[];
  /**
   * Each screen as it was last drawn, keyed by slug.
   *
   * **So going back to a screen is instant.** Every visit used to start from
   * an empty page reading "Loading…" until the Worker answered, and with the
   * Worker a continent away that is most of a second on every tap of the
   * rail. Now a screen seen before is drawn at once from here while its fresh
   * copy is fetched, and the page's buttons stay inert until the fresh copy
   * lands — see `.page.working` in `office.css` — so nothing is written from a
   * figure that has since moved. A screen never seen draws nothing but the
   * progress bar, because there is nothing honest to show instead.
   */
  seen: Map<string, Block[]>;

  /** What the header says about the lanes, from the last Tills read. */
  lanes_open: number;
  lanes_offline: number;
  drawer_expected: string;

  /** Counts beside a rail item, keyed by slug. Only a few carry one. */
  badges: Map<string, string>;

  /** The dialog in front of everything, if any. One at a time, on purpose. */
  form: Form | null;

  /**
   * Lists a form's dropdowns are built from. The same values the screens
   * draw, held as [`model`] types rather than as documents: `api` decoded
   * them once on the way in, and a dropdown reading `s.name` cannot ask for
   * a key that is not there.
   */
  ref_categories: model.CatalogCategory[];
  ref_suppliers: model.Supplier[];
  ref_products: model.CatalogProduct[];
  ref_registers: model.Lane[];
  /**
   * The expense accounts a running cost may be booked to. Fetched rather
   * than hard-coded, because the chart is data and a shop may extend it.
   */
  ref_expense_accounts: model.AccountOption[];
  /** The whole chart, for the journal filter's account picker. */
  ref_accounts: model.Account[];
  /** Open supplier invoices, for the cancel picker. */
  ref_invoices: model.Invoice[];
  /**
   * The customer list the Customers screen is showing.
   *
   * Two dialogs read it: the edit form, so a Save does not write blanks over
   * somebody's name and — worse — over the credit limit a manager set, and
   * the settle picker, so taking money off a tab does not need a round trip
   * to find out who owes anything.
   */
  ref_customers: model.CustomerAccount[];
  /**
   * The shop's own settings, and the one thing here still held as a
   * document — see [`api.settings`] for why a key→value map of setting
   * names has no type.
   */
  ref_settings: Doc;

  /**
   * What a drill-down is about.
   *
   * Separate fields rather than one, because they are separate things: a
   * product on the catalogue's detail page, an order on a purchase order's,
   * and a sale's lines behind the refund dialog. Every read of them says
   * which it meant.
   */
  subject_product: model.CatalogProduct | null;
  subject_order: model.OrderHead | null;
  subject_order_lines: model.OrderLine[];
  subject_sale_lines: model.SaleLine[];

  /** What a screen is filtering by, kept so a reload of the screen keeps it. */
  query: string;

  /**
   * Which sheet the books are showing, and over what window.
   *
   * **State rather than a literal.** One of these two decides what every
   * accounting call asks for, and the same window carries across the sheets:
   * switching from a profit and loss to a trial balance should not silently
   * change the period underneath it.
   */
  books_view: string;
  books_window: string;
  /**
   * Which account the general ledger is open at, reached by touching a row
   * of the trial balance.
   */
  books_account: string;
  /**
   * What the journal is narrowed to. Kept beside the window for the same
   * reason: a filter that resets every time you look at another sheet is a
   * filter nobody uses twice.
   */
  journal_cause: string;
  journal_account: string;
  journal_query: string;

  /**
   * The delivery being booked on Purchasing, before it is written.
   *
   * `goods_in_key` is minted when the first line is added and thrown away
   * when the delivery lands or is abandoned, so every press of "Book it into
   * stock" for *this* delivery carries the same key and only the first one
   * writes anything.
   */
  goods_in: GoodsInLine[];
  goods_in_supplier: string;
  goods_in_settlement: string;
  goods_in_key: string;

  /**
   * What Purchasing was last drawn from.
   *
   * Kept so that adding a line to a delivery can redraw the screen without
   * asking the Worker for the worksheet, the orders and the payables again.
   * A shopkeeper enters a delivery note line by line; three requests per
   * line, on the connection this shop actually has, is the thing that made
   * them tap buttons twice in the first place.
   */
  purchasing_sheet: model.WorksheetLine[];
  purchasing_orders: model.PurchaseOrder[];
  purchasing_payables: model.Payables | null;

  trouble: string;
  /** What just happened. Kept, and not drawn anywhere in the back office. */
  notice: string;
  busy: boolean;
  signing_in: boolean;

  /**
   * Whether a kept token is still being checked with the Worker.
   *
   * The same field as the till's, for the same reason — see
   * [`store.App.restoring`]. A reload holds a token and has no session yet,
   * and `session === null` cannot tell that apart from being signed out, so
   * the desk drew its sign-in card over a session that was about to arrive.
   */
  restoring: boolean;

  /** Whether the rail is showing on a narrow screen. */
  rail_open: boolean;
}

export function holding(): App {
  return {
    session: null,
    screen: screen("Overview"),
    lang: "En",
    blocks: [],
    seen: new Map(),
    lanes_open: 0,
    lanes_offline: 0,
    drawer_expected: "",
    badges: new Map(),
    form: null,
    ref_categories: [],
    ref_suppliers: [],
    ref_products: [],
    ref_registers: [],
    ref_expense_accounts: [],
    ref_accounts: [],
    ref_invoices: [],
    ref_customers: [],
    ref_settings: doc.nothing(),
    subject_product: null,
    subject_order: null,
    subject_order_lines: [],
    subject_sale_lines: [],
    query: "",
    books_view: "summary",
    books_window: "30",
    books_account: "",
    journal_cause: "",
    journal_account: "",
    journal_query: "",
    goods_in: [],
    goods_in_supplier: "",
    goods_in_settlement: "cash",
    goods_in_key: "",
    purchasing_sheet: [],
    purchasing_orders: [],
    purchasing_payables: null,
    trouble: "",
    notice: "",
    busy: false,
    signing_in: false,
    restoring: false,
    rail_open: false,
  };
}

export function set_lang(app: App, l: Lang): void {
  app.lang = l;
  // Every kept screen is in the language it was drawn in.
  app.seen = new Map();
}

export function lang_of(app: App): Lang {
  return app.lang;
}

export function token_of(app: App): string {
  const session = app.session;
  if (session === null) {
    return "";
  }
  return session.token;
}

export function currency_of(app: App): money.Currency {
  const session = app.session;
  if (session === null) {
    return money.kyat();
  }
  return session.currency;
}

export function shop_of(app: App): string {
  const session = app.session;
  if (session === null) {
    return "";
  }
  return session.shop_name;
}

export function who_of(app: App): string {
  const session = app.session;
  if (session === null) {
    return "";
  }
  return session.name;
}

/** Two letters standing for a name, for the avatar chips. */
export function initials_of(name: string): string {
  const parts = words_of(name);
  if (parts.length === 0) {
    return "—";
  }
  if (parts.length === 1) {
    return upper(str_slice(parts[0], 0, Math.min(2, str_len(parts[0]))));
  }
  return upper(str_slice(parts[0], 0, 1) + str_slice(parts[1], 0, 1));
}

/**
 * A meter width, as a percentage of the largest value in the set.
 *
 * Relative to the biggest rather than to a total, because the question a
 * ranked list answers is "how does this compare with the best", and shares of
 * a total are unreadable once there are more than a handful of rows.
 */
export function width_of(value: number, largest: number): number {
  if (largest <= 0) {
    return 0;
  }
  return clamp(div(value * 100, largest), 2, 100);
}

export function badge_of(app: App, s: Screen): string {
  return app.badges.get(slug_of(s)) ?? "";
}

// ---- the writes ------------------------------------------------------------

export function signed_in(app: App, session: model.Session): void {
  app.session = session;
  app.signing_in = false;
  app.trouble = "";
  app.restoring = false;
}

export function signed_out(app: App): void {
  app.session = null;
  app.blocks = [];
  // The next person to sign in at this desk must not be shown the last
  // one's screens, even for the moment before theirs arrive.
  app.seen = new Map();
  app.badges = new Map();
}

export function go(app: App, to: Screen): void {
  app.screen = to;
  app.blocks = app.seen.get(slug_of(to)) ?? [];
  app.trouble = "";
  app.rail_open = false;
  // The drill-down subjects belong to the screen that loaded them.
  //
  // Left in place, `subject_order` outlived its own screen, and *Record an
  // invoice* from the Purchasing list — which passes no order id —
  // pre-filled a supplier and a **total** from whatever order had been
  // opened earlier in the session. A stale figure on a form that creates a
  // payable. Cleared here, where the screen changes.
  app.subject_product = null;
  app.subject_order = null;
  app.subject_order_lines = [];
  app.subject_sale_lines = [];
}

export function took(app: App, blocks: Block[]): void {
  took_for(app, app.screen, blocks);
}

/**
 * A screen's answer, kept for the screen that asked and drawn only if that
 * screen is still the one on show — see `done_for` in `office.tsx`.
 */
export function took_for(app: App, asked: Screen, blocks: Block[]): void {
  const next = new Map(app.seen);
  next.set(slug_of(asked), blocks);
  app.seen = next;
  if (slug_of(asked) !== slug_of(app.screen)) {
    return;
  }
  app.blocks = blocks;
  app.busy = false;
  app.trouble = "";
}

export function lanes_are(app: App, open: number, offline: number, expected: string): void {
  app.lanes_open = open;
  app.lanes_offline = offline;
  app.drawer_expected = expected;
}

export function badge(app: App, slug: string, value: string): void {
  const next = new Map(app.badges);
  next.set(slug, value);
  app.badges = next;
}

/**
 * Take a screen's badge off the rail.
 *
 * Needed because every caller writes a badge under a condition — an open lane,
 * a low item — and a condition that stops holding has to take the number down.
 * Without this the count a screen last had stays on the rail for the rest of
 * the session: close the last lane and the rail still says one.
 */
export function unbadge(app: App, slug: string): void {
  const next = new Map(app.badges);
  next.delete(slug);
  app.badges = next;
}

export function went_wrong(app: App, trouble: string): void {
  app.trouble = trouble;
  app.busy = false;
}

export function say(app: App, notice: string): void {
  app.notice = notice;
}

export function working(app: App, busy: boolean): void {
  app.busy = busy;
}

// ---- the delivery being booked ---------------------------------------------

/**
 * Add a line, or fold it into the one already there for that product.
 *
 * Folding rather than appending, for the same reason the till merges a rescan
 * into "×3": two cases of the same cola off one van is one line on one
 * delivery note, and two rows that have to be added up by eye is how a
 * shopkeeper loses track of what actually arrived. The later cost wins,
 * because it is the one the operator has just read off the note.
 */
export function goods_in_add(app: App, minted: string, line: GoodsInLine): void {
  if (app.goods_in.length === 0 && app.goods_in_key.length === 0) {
    app.goods_in_key = minted;
  }
  const out: GoodsInLine[] = [];
  let folded = false;
  for (const held of app.goods_in) {
    if (held.product_id === line.product_id) {
      out.push({
        product_id: held.product_id,
        name: held.name,
        qty: held.qty + line.qty,
        unit_cost: line.unit_cost,
        // A second case with no price typed keeps the one the first was
        // given; a price typed on it is the newer word.
        new_price: line.new_price !== null ? line.new_price : held.new_price,
        price_now: line.new_price !== null ? line.price_now : held.price_now,
      });
      folded = true;
    } else {
      out.push(held);
    }
  }
  if (!folded) {
    out.push(line);
  }
  app.goods_in = out;
}

export function goods_in_drop(app: App, product_id: string): void {
  const out = app.goods_in.filter((held) => held.product_id !== product_id);
  app.goods_in = out;
  if (out.length === 0) {
    app.goods_in_key = "";
  }
}

/**
 * Take off exactly the lines a request carried, and nothing else.
 *
 * Not `goods_in_clear`. A line added while the booking was in flight was
 * never sent, and wiping the whole delivery on success would throw away
 * something the shopkeeper has just typed with nothing on screen to say it is
 * gone. What was sent goes; what arrived after it stays, and the key is
 * released only when the list is actually empty.
 */
export function goods_in_took(app: App, sent: GoodsInLine[]): void {
  const out: GoodsInLine[] = [];
  for (const held of app.goods_in) {
    let left = held.qty;
    for (const gone of sent) {
      if (gone.product_id === held.product_id) {
        left = left - gone.qty;
      }
    }
    // Subtracted rather than matched, because a second case of the same cola
    // added while the request was in flight is folded into the line that went
    // — see `goods_in_add`. What is left is what arrived late. The floor is a
    // tolerance and not zero: `qty` is a float, and a delivery of 0.35 kg
    // does not subtract to exactly nothing.
    if (left > 0.000001) {
      out.push({
        product_id: held.product_id,
        name: held.name,
        qty: left,
        unit_cost: held.unit_cost,
        new_price: held.new_price,
        price_now: held.price_now,
      });
    }
  }
  app.goods_in = out;
  if (out.length === 0) {
    app.goods_in_key = "";
    app.goods_in_supplier = "";
    app.goods_in_settlement = "cash";
  }
}

/**
 * Forget the delivery — after it lands, or when the operator abandons it.
 *
 * The key goes with it. Keeping it would mean the *next* delivery repeated
 * the last one's answer, which is the failure an idempotency key is supposed
 * to prevent rather than cause.
 */
export function goods_in_clear(app: App): void {
  app.goods_in = [];
  app.goods_in_key = "";
  app.goods_in_supplier = "";
  app.goods_in_settlement = "cash";
}

export function took_purchasing(
  app: App,
  sheet: model.WorksheetLine[],
  orders: model.PurchaseOrder[],
  payables: model.Payables | null,
): void {
  app.purchasing_sheet = sheet;
  app.purchasing_orders = orders;
  app.purchasing_payables = payables;
}

export function goods_in_about(app: App, supplier_id: string, settlement: string): void {
  app.goods_in_supplier = supplier_id;
  app.goods_in_settlement = settlement;
}

/**
 * What one line of a delivery comes to.
 *
 * The arithmetic is here rather than in `money.ts`, which is a formatter and
 * says so — "the server owns every total". It still does: this figure is shown
 * to the operator before they commit, and the Worker computes the one that is
 * written from the same quantities and costs. If the two ever disagreed, the
 * Worker's is the delivery.
 */
function line_value(qty: number, unit_cost: number): number {
  return round_to(qty * unit_cost);
}

/** What the delivery is worth, at the costs entered against it. */
export function goods_in_total(app: App): number {
  let total = 0;
  for (const line of app.goods_in) {
    total = total + line_value(line.qty, line.unit_cost);
  }
  return total;
}

/** The same figure, for one line, so a table can show it beside the quantity. */
export function goods_in_line_value(line: GoodsInLine): number {
  return line_value(line.qty, line.unit_cost);
}

export function signing_in(app: App, on: boolean): void {
  app.signing_in = on;
}

/** Set before the first paint when there is a kept token to check. */
export function restoring(app: App, on: boolean): void {
  app.restoring = on;
}

export function toggle_rail(app: App): void {
  app.rail_open = !app.rail_open;
}

export function open_form(app: App, f: Form): void {
  app.form = f;
  app.trouble = "";
}

export function close_form(app: App): void {
  app.form = null;
}

/** A form that was refused, with the reason on it. */
export function form_refused(app: App, why: string): void {
  const open = app.form;
  if (open === null) {
    app.trouble = why;
    return;
  }
  app.form = { ...open, trouble: why, busy: false };
}

/**
 * Rewrite one field on the open form.
 *
 * For a value the document cannot hold: a photo is a key, not an input, so
 * there is nowhere in the DOM to read it back from at submit time.
 */
export function set_field(app: App, name: string, value: string): void {
  const open = app.form;
  if (open === null) {
    return;
  }
  const fields = open.fields.map((f) => (f.name === name ? { ...f, value } : f));
  app.form = { ...open, fields, busy: false };
}

export function form_working(app: App): void {
  const open = app.form;
  if (open === null) {
    return;
  }
  app.form = { ...open, trouble: "", busy: true };
}

export function set_query(app: App, q: string): void {
  app.query = q;
}

export function took_refs(
  app: App,
  categories: model.CatalogCategory[],
  suppliers: model.Supplier[],
  products: model.CatalogProduct[],
  registers: model.Lane[],
): void {
  app.ref_categories = categories;
  app.ref_suppliers = suppliers;
  app.ref_products = products;
  app.ref_registers = registers;
}

export function took_expense_accounts(app: App, accounts: model.AccountOption[]): void {
  app.ref_expense_accounts = accounts;
}

export function took_accounts(app: App, accounts: model.Account[]): void {
  app.ref_accounts = accounts;
}

export function took_invoices(app: App, invoices: model.Invoice[]): void {
  app.ref_invoices = invoices;
}

export function took_customers(app: App, people: model.CustomerAccount[]): void {
  app.ref_customers = people;
}

export function took_settings(app: App, settings: Doc): void {
  app.ref_settings = settings;
}

/** What a drill-down is about, kept so a form opened from it can read it. */
export function took_product(app: App, product: model.CatalogProduct): void {
  app.subject_product = product;
}

export function took_order(app: App, order: model.OrderHead, lines: model.OrderLine[]): void {
  app.subject_order = order;
  app.subject_order_lines = lines;
}

export function took_sale_lines(app: App, lines: model.SaleLine[]): void {
  app.subject_sale_lines = lines;
}

// ---- the books -------------------------------------------------------------

/**
 * The window a books sheet is asked over, as `[from, to]`.
 *
 * **The upper bound is always zero, and zero means "up to now" — the
 * *Worker's* now.** It used to be this device's, and that is a different
 * number: a tablet whose clock runs a minute behind asked for everything up to
 * a moment that had already passed on the server, so the last minute of
 * trading fell outside its own window and today's figures came back short by
 * however far the clock was out. The lower bound stays a device figure, which
 * is harmless — it is a rounding of a week or a month, not a boundary a fresh
 * row is sitting on.
 *
 * `"month"` is thirty days back, like the default, and `"all"` starts at the
 * epoch, which is before any shop in this system opened.
 */
export function window_seconds(name: string, now: number): number[] {
  switch (name) {
    case "today":
      return [now - (now % 86400), 0];
    case "7":
      return [now - 7 * 86400, 0];
    case "month":
      return [now - 30 * 86400, 0];
    case "all":
      return [0, 0];
    // An unrecognised name gets thirty days — the same window `window_label`
    // names it, so the figures and the label agree.
    default:
      return [now - 30 * 86400, 0];
  }
}

export function window_label(name: string): string {
  switch (name) {
    case "today":
      return "today";
    case "7":
      return "seven days";
    case "month":
      return "this month";
    case "all":
      return "all time";
    default:
      return "thirty days";
  }
}

export function show_books(app: App, view: string): void {
  app.books_view = view;
}

export function set_books_window(app: App, name: string): void {
  app.books_window = name;
}

export function filter_journal(app: App, cause: string, code: string, q: string): void {
  app.journal_cause = cause;
  app.journal_account = code;
  app.journal_query = q;
}

export function open_account(app: App, code: string): void {
  app.books_account = code;
  app.books_view = "ledger";
}
