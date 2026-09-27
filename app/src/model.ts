//! The values: what the server says, and who is at the lane.
//!
//! Every type here is built from JSON in this file and nowhere else, so there
//! is exactly one place that knows what the API's field names are. Nothing above
//! this reads a JSON document.
//!
//! There are no optionals for things the server always sends. A missing field
//! becomes its empty value rather than an optional every call site has to
//! unwrap — the API is ours and its shape is a contract, not a guess.
//!
//! ## Which of these are decoded strictly, and which cannot be
//!
//! A **strict decoder** (`decoder(...)` below) reads each field under **its own
//! name**, gives it **no default**, and fails the moment one is missing,
//! `null`, or the wrong type — naming the type and the field: `Customer.owed:
//! expected a whole number`. That is the right decoder for a payload whose
//! columns are all `NOT NULL` and whose names already match, and it is used
//! here wherever that is true of every field.
//!
//! Every other type is doing work a strict decoder cannot do, and the
//! hand-written converter earns its place. The reason is written above each one;
//! they come down to four kinds:
//!
//!   * a **renamed** field (`labelMy`, `promoSaved`, `hold_label`),
//!   * a **flattened** one ([`Basket`] reads three levels of `sale` into a flat
//!     type),
//!   * a **coded** one (`tone == "danger"`, `ask_price == 1`), and
//!   * a **nullable** one, where the server's column permits null and the screen
//!     wants the empty value rather than a failed load.
//!
//! The last is much the commonest, and the rule it follows is worth stating
//! once: **a decoder that rejects a row the server is entitled to send is worse
//! than one that fills in a blank.** A product with no supplier, an order with
//! no delivery date and a shift that is still open are all ordinary, and each
//! one arrives as an explicit `null` that a strict decoder refuses.
//!
//! ## A strict row inside a lenient answer
//!
//! Several answers are a mixture: `/catalog/products/:id` sends a `product`
//! that cannot be decoded strictly beside `barcodes` that can. Those wrappers
//! read the lenient parts with `doc.*` and decode the strict ones, **throwing**
//! when a strict part will not read — which is exactly what [`api.grid`]
//! already does with the till's categories. A malformed row of a clean shape is
//! a fault at the other end and says so; a null in a nullable column is not.
//!
//! There is one more difference, and it is quiet: a strict decoder reads a
//! whole number by **truncating** it, while [`doc.int_of`] rounds. Today the
//! Worker rounds every amount of money to whole minor units before it is
//! serialised, so the two agree on every field either one reads. They stop
//! agreeing the day something fractional crosses.

import * as doc from "./doc.ts";
import { trunc_to } from "./lang.ts";
import type { Doc } from "./doc.ts";
import type { Currency } from "./money.ts";
import type { Lang } from "./i18n.ts";

// ---- the strict decoder ----------------------------------------------------

type FieldReader = (struct: string, name: string, present: boolean, value: unknown) => unknown;

/** A text field. Missing, `null` and a number all say the same thing. */
const str: FieldReader = (struct, name, _present, value) => {
  if (typeof value !== "string") {
    throw new Error(`${struct}.${name}: expected a string`);
  }
  return value;
};

/** A whole number, truncated if the wire sent a fraction. */
const int: FieldReader = (struct, name, _present, value) => {
  if (typeof value !== "number") {
    throw new Error(`${struct}.${name}: expected a whole number`);
  }
  return trunc_to(value);
};

/** A quantity — the one legitimately fractional field. */
const float: FieldReader = (struct, name, _present, value) => {
  if (typeof value !== "number") {
    throw new Error(`${struct}.${name}: expected a number`);
  }
  return value;
};

const bool: FieldReader = (struct, name, _present, value) => {
  if (typeof value !== "boolean") {
    throw new Error(`${struct}.${name}: expected a boolean`);
  }
  return value;
};

/**
 * A list of another decoded type. Absent is refused; present but not a list
 * reads as empty, and so does `null`. A bad row speaks for itself, naming its
 * own type.
 */
function list<T>(decode: (v: unknown) => T): FieldReader {
  return (struct, name, present, value) => {
    if (!present) {
      throw new Error(`${struct}.${name}: missing`);
    }
    return doc.items(value).map(decode);
  };
}

/** Another decoded type, nested. Absent is refused; anything present is read. */
function nested<T>(decode: (v: unknown) => T): FieldReader {
  return (struct, name, present, value) => {
    if (!present) {
      throw new Error(`${struct}.${name}: missing`);
    }
    return decode(value);
  };
}

/**
 * A strict decoder for a type named `struct`, reading `fields` in the order
 * they are written and failing at the first one that will not read.
 */
function decoder<T>(struct: string, fields: Record<string, FieldReader>): (v: unknown) => T {
  return (value: unknown) => {
    const out: Record<string, unknown> = {};
    for (const [name, read] of Object.entries(fields)) {
      const present = doc.is_object(value) && Object.hasOwn(value, name);
      out[name] = read(struct, name, present, present ? (value as Record<string, unknown>)[name] : undefined);
    }
    return out as T;
  };
}

/** `err` with context in front of it. */
export function wrap(err: unknown, context: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${context}: ${message}`);
}

/** Decode, or throw with the context a reader of the message needs. */
function decode_or<T>(decode: (v: unknown) => T, value: unknown, context: string): T {
  try {
    return decode(value);
  } catch (e) {
    throw wrap(e, context);
  }
}

/** Every item of the array under `name`, decoded, or a failure in context. */
function decode_items<T>(d: Doc, name: string, decode: (v: unknown) => T, context: string): T[] {
  return doc.items(doc.field(d, name)).map((item) => decode_or(decode, item, context));
}

/**
 * The object under `name`, ready for a strict decoder.
 *
 * An absent key becomes an empty object rather than an error invented here:
 * the decoder then says which field it wanted, which is a better sentence than
 * anything this line could write.
 */
function object_at(d: Doc, name: string): unknown {
  const v = doc.field(d, name);
  return v === undefined ? {} : v;
}

// ---- who is signed in ------------------------------------------------------

export type Role = "SaleStaff" | "Manager" | "Owner";

export function role_of(code: string): Role {
  switch (code) {
    case "owner":
      return "Owner";
    case "manager":
      return "Manager";
    // The least privilege is the default, so an unknown role can only ever
    // lose a command rather than gain one.
    default:
      return "SaleStaff";
  }
}

export function is_manager(r: Role): boolean {
  return r === "Manager" || r === "Owner";
}

export interface Session {
  token: string;
  user_id: string;
  name: string;
  role: Role;
  register_id: string;
  /**
   * What the lane is called, for the status bar; the id when the Worker
   * predates the field.
   */
  register_name: string;
  shop_name: string;
  currency: Currency;
}

/**
 * Not decoded strictly, and it never could be: the token is not in the
 * document. It came back in the same answer but is passed in separately. The
 * rest is flattening `user` and `shop` and mapping a role code to a role.
 */
export function session_of(d: Doc, token: string): Session {
  const user = doc.field(d, "user");
  const shop = doc.field(d, "shop");
  return {
    token,
    user_id: doc.text(user, "id", ""),
    name: doc.text(user, "name", ""),
    role: role_of(doc.text(user, "role", "sale_staff")),
    register_id: doc.text(d, "register_id", ""),
    register_name: doc.text(d, "register_name", doc.text(d, "register_id", "")),
    shop_name: doc.text(shop, "name", ""),
    currency: {
      code: doc.text(shop, "currency", "MMK"),
      symbol: doc.text(shop, "symbol", "K"),
      minor_units: doc.int_of(shop, "minor_units", 0),
      symbol_first: doc.bool_of(shop, "symbol_first", true),
    },
  };
}

// ---- the basket ------------------------------------------------------------

export interface Line {
  id: string;
  product_id: string;
  /** What the receipt records — the snapshot taken when it was rung. */
  name: string;
  /**
   * What the *screen* shows in မြန်မာ, joined live from the product. Not the
   * same field on purpose: a receipt reprinted years later has to read as it
   * did on the day, and the shelf name can change under it.
   */
  name_my: string;
  sku: string;
  qty: number;
  unit_price: number;
  list_price: number;
  line_discount: number;
  promo_name: string;
  promo_saved: number;
  price_override: boolean;
  total: number;
  min_age: number;
  age_checked: boolean;
}

/**
 * Not strict: `sale_items.product_id` is a nullable reference, and a line
 * whose product has been removed still has to draw. A strict decoder would
 * fail the whole basket over it.
 */
export function line_of(d: Doc): Line {
  return {
    id: doc.text(d, "id", ""),
    product_id: doc.text(d, "product_id", ""),
    name: doc.text(d, "name", ""),
    name_my: doc.text(d, "name_my", ""),
    sku: doc.text(d, "sku", ""),
    qty: doc.num_of(d, "qty", 0.0),
    unit_price: doc.int_of(d, "unit_price", 0),
    list_price: doc.int_of(d, "list_price", 0),
    line_discount: doc.int_of(d, "line_discount", 0),
    promo_name: doc.text(d, "promo_name", ""),
    promo_saved: doc.int_of(d, "promo_saved", 0),
    price_override: doc.bool_of(d, "price_override", false),
    total: doc.int_of(d, "total", 0),
    min_age: doc.int_of(d, "min_age", 0),
    age_checked: doc.bool_of(d, "age_checked", false),
  };
}

export interface Totals {
  subtotal: number;
  promo_saved: number;
  discount: number;
  tax: number;
  total: number;
  item_count: number;
}

export interface Basket {
  sale_id: string;
  lines: Line[];
  totals: Totals;
  customer_name: string;
  customer_points: number;
  /**
   * What the attached customer may still put on the tab, and what they
   * already owe. Both zero on a walk-in, which is also what "no tab" looks
   * like — a customer with no limit and a customer with nobody attached are
   * refused by the same test.
   */
  customer_limit: number;
  customer_owed: number;
  held_count: number;
  shift_open: boolean;
  commands: Command[];
}

export function empty_basket(): Basket {
  return {
    sale_id: "",
    lines: [],
    totals: { subtotal: 0, promo_saved: 0, discount: 0, tax: 0, total: 0, item_count: 0.0 },
    customer_name: "",
    customer_points: 0,
    customer_limit: 0,
    customer_owed: 0,
    held_count: 0,
    shift_open: false,
    commands: [],
  };
}

/**
 * Not strict, and the furthest from it: this reads `sale.id`,
 * `sale.customer.name` and six of `sale`'s own totals into one flat type, and
 * `promoSaved` arrives camel-cased.
 */
export function basket_of(d: Doc): Basket {
  const sale = doc.field(d, "sale");
  const customer = doc.field(sale, "customer");
  return {
    sale_id: doc.text(sale, "id", ""),
    lines: doc.items(doc.field(d, "lines")).map(line_of),
    totals: {
      subtotal: doc.int_of(sale, "subtotal", 0),
      promo_saved: doc.int_of(sale, "promoSaved", 0),
      discount: doc.int_of(sale, "discount", 0),
      tax: doc.int_of(sale, "tax", 0),
      total: doc.int_of(sale, "total", 0),
      item_count: doc.num_of(sale, "item_count", 0.0),
    },
    customer_name: doc.text(customer, "name", ""),
    customer_points: doc.int_of(customer, "points", 0),
    customer_limit: doc.int_of(customer, "credit_limit", 0),
    customer_owed: doc.int_of(customer, "owed", 0),
    held_count: doc.int_of(d, "held_count", 0),
    shift_open: doc.bool_of(d, "shift_open", false),
    commands: doc.items(doc.field(d, "commands")).map(command_of),
  };
}

// ---- the command bar -------------------------------------------------------

/**
 * One button, as the server describes it.
 *
 * **A command the operator cannot use still arrives**, with `allowed` false —
 * the till draws it locked rather than hiding it, which is how a cashier
 * learns to call a manager instead of learning the button does not exist.
 */
export interface Command {
  id: string;
  label: string;
  label_my: string;
  fkey: number;
  allowed: boolean;
  needs_approval: boolean;
  danger: boolean;
  confirm: string;
}

/**
 * Not strict: `labelMy` and `needsApproval` are camel-cased on the wire,
 * `danger` is read off a `tone` string, and `allowed` defaults to **true** — a
 * command that arrives without the flag is one the operator may use, which is
 * the opposite of what a zero value would say.
 */
export function command_of(d: Doc): Command {
  return {
    id: doc.text(d, "id", ""),
    label: doc.text(d, "label", ""),
    label_my: doc.text(d, "labelMy", ""),
    fkey: doc.int_of(d, "fkey", 0),
    allowed: doc.bool_of(d, "allowed", true),
    needs_approval: doc.bool_of(d, "needsApproval", false),
    danger: doc.text(d, "tone", "normal") === "danger",
    confirm: doc.text(d, "confirm", "none"),
  };
}

export function label_of(c: Command, l: Lang): string {
  if (l === "En") {
    return c.label;
  }
  return c.label_my.length > 0 ? c.label_my : c.label;
}

// ---- the catalogue ---------------------------------------------------------

export interface Product {
  id: string;
  sku: string;
  name: string;
  name_my: string;
  category_id: string;
  price: number;
  stock: number;
  min_age: number;
  unit: string;
  ask_price: boolean;
  quick_key: number;
  photo_key: string;
}

/**
 * Not strict: `ask_price` is an `INTEGER` column read as a bool, and
 * `category_id` is a nullable reference — an uncategorised product is legal and
 * has to appear in the grid rather than fail the catalogue.
 */
export function product_of(d: Doc): Product {
  return {
    id: doc.text(d, "id", ""),
    sku: doc.text(d, "sku", ""),
    name: doc.text(d, "name", ""),
    name_my: doc.text(d, "name_my", ""),
    category_id: doc.text(d, "category_id", ""),
    price: doc.int_of(d, "price", 0),
    stock: doc.num_of(d, "stock", 0.0),
    min_age: doc.int_of(d, "min_age", 0),
    unit: doc.text(d, "unit", "each"),
    ask_price: doc.int_of(d, "ask_price", 0) === 1,
    quick_key: doc.int_of(d, "quick_key", 0),
    photo_key: doc.text(d, "photo_key", ""),
  };
}

/**
 * A shelf heading, exactly as the `categories` table holds it.
 *
 * Three columns, all `NOT NULL`, all named what the field is named, so it is
 * decoded strictly — the extra `sort` the query also selects is simply
 * ignored, which is how the same type reads a row meant for a bigger one.
 * [`CatalogCategory`] is that bigger one, for the back office's own list.
 */
export interface Category {
  id: string;
  name: string;
  name_my: string;
}

export const decode_category = decoder<Category>("Category", { id: str, name: str, name_my: str });

/**
 * The name a *line* shows. Falls back to the receipt's snapshot, which is what
 * a product with no Burmese name has.
 */
export function line_label(line: Line, l: Lang): string {
  if (l === "En") {
    return line.name;
  }
  return line.name_my.length > 0 ? line.name_my : line.name;
}

export function category_label(c: Category, l: Lang): string {
  if (l === "En") {
    return c.name;
  }
  return c.name_my.length > 0 ? c.name_my : c.name;
}

// ---- parked baskets --------------------------------------------------------

export interface Held {
  id: string;
  label: string;
  total: number;
  items: number;
  customer: string;
  created_at: number;
}

/**
 * Not strict: `label` is the `hold_label` column, and renaming a field is the
 * one thing a strict decoder has no way to express.
 */
export function held_of(d: Doc): Held {
  return {
    id: doc.text(d, "id", ""),
    label: doc.text(d, "hold_label", ""),
    total: doc.int_of(d, "total", 0),
    items: doc.int_of(d, "items", 0),
    customer: doc.text(d, "customer", ""),
    created_at: doc.int_of(d, "created_at", 0),
  };
}

// ---- taking payment --------------------------------------------------------

/**
 * How a basket is settled.
 *
 * `OnAccount` is the odd one and is worth saying out loud: it is a tender that
 * moves no money. The goods leave, the customer owes the shop, and the basket
 * is fully tendered — which is the whole reason a tab is modelled as a tender
 * rather than as a sale that does not add up. Paying half now is then nothing
 * new: it is a split between cash and the tab, the same arithmetic as a split
 * between cash and a card.
 *
 * It is also not [`Customer.credit`], which runs the other way. That is store
 * credit the **shop owes the customer**, and spending it is `StoreCredit`.
 */
export type Tender = "Cash" | "Card" | "Wallet" | "StoreCredit" | "OnAccount";

export function tender_code(t: Tender): string {
  switch (t) {
    case "Cash":
      return "cash";
    case "Card":
      return "card";
    case "Wallet":
      return "wallet";
    case "StoreCredit":
      return "store_credit";
    case "OnAccount":
      return "on_account";
  }
}

export function tender_key(t: Tender): string {
  return tender_code(t);
}

/**
 * Only cash can produce change, which is the rule the tender screen enforces
 * before the server has to.
 *
 * A tab emphatically cannot. Handing a customer money out of the drawer
 * against a balance they have not paid is the shop lending them the change as
 * well as the shopping.
 */
export function returns_change(t: Tender): boolean {
  return t === "Cash";
}

/**
 * Whether this tender has to know whose it is.
 *
 * Both of the two are a balance on a person: store credit is one the shop
 * owes, a tab is one the shop is owed, and neither can be settled against
 * nobody. The till refuses these before the request leaves the lane, so a
 * cashier finds out while the customer is still standing there rather than
 * after pressing Pay.
 */
export function needs_customer(t: Tender): boolean {
  return t === "StoreCredit" || t === "OnAccount";
}

export interface Payment {
  tender: Tender;
  amount: number;
  reference: string;
}

// ---- returns and customers -------------------------------------------------

/**
 * Somebody with an account, as the customer search returns them.
 *
 * Strict for the same reason as [`Category`]: `/till/customers` selects these
 * seven columns and no others, and every one of them is `NOT NULL` — `phone`,
 * `points`, `credit`, `credit_limit` and `owed` all carry a default in the
 * schema rather than a null.
 *
 * **`credit` and `owed` point in opposite directions and are never added.**
 * `credit` is store credit the shop owes this person; `owed` is shopping this
 * person owes the shop. `credit_limit` is how much of the second they are
 * allowed to run up, and a limit of zero — the default for everybody — means
 * no tab. The lane needs all three in the row it already fetches, because
 * "can this basket go on the tab" is a question asked with a queue waiting.
 */
export interface Customer {
  id: string;
  name: string;
  phone: string;
  points: number;
  credit: number;
  credit_limit: number;
  owed: number;
}

export const decode_customer = decoder<Customer>("Customer", {
  id: str,
  name: str,
  phone: str,
  points: int,
  credit: int,
  credit_limit: int,
  owed: int,
});

export interface Receipt {
  id: string;
  number: number;
  total: number;
  items: number;
  cashier: string;
  completed_at: number;
}

/**
 * Not strict, and it is the close call on this page. The names all match, but
 * `sales.number` and `sales.completed_at` are both **nullable** columns: the
 * query filters to completed sales, which today always have them, and nothing
 * in the schema says so. Looking up a receipt is how a customer gets a refund,
 * and the search failing outright over a null is worse than a receipt listed as
 * `#0`.
 */
export function receipt_of(d: Doc): Receipt {
  return {
    id: doc.text(d, "id", ""),
    number: doc.int_of(d, "number", 0),
    total: doc.int_of(d, "total", 0),
    items: doc.int_of(d, "items", 0),
    cashier: doc.text(d, "cashier", ""),
    completed_at: doc.int_of(d, "completed_at", 0),
  };
}

/** One line of a receipt, and how much of it the operator is taking back. */
export interface ReturnLine {
  id: string;
  name: string;
  qty: number;
  total: number;
  returnable: number;
  taking: number;
}

/**
 * Not strict: `taking` is not in the document at all. It is how much of the
 * line the operator has dialled up so far, and it starts at nothing.
 */
export function return_line_of(d: Doc): ReturnLine {
  return {
    id: doc.text(d, "id", ""),
    name: doc.text(d, "name", ""),
    qty: doc.num_of(d, "qty", 0.0),
    total: doc.int_of(d, "total", 0),
    returnable: doc.num_of(d, "returnable", 0.0),
    taking: 0.0,
  };
}

// ---- a receipt, to be printed ----------------------------------------------

/**
 * One line of a printed receipt.
 *
 * Not strict: `promo_name` is empty on a line no offer touched, and every
 * figure is the snapshot the sale was rung at rather than what the product
 * costs today. A receipt reprinted next week says what the customer paid.
 */
export interface SlipLine {
  name: string;
  sku: string;
  qty: number;
  unit_price: number;
  total: number;
  tax: number;
  promo_name: string;
  promo_saved: number;
}

export function slip_line_of(d: Doc): SlipLine {
  return {
    name: doc.text(d, "name", ""),
    sku: doc.text(d, "sku", ""),
    qty: doc.num_of(d, "qty", 0.0),
    unit_price: doc.int_of(d, "unit_price", 0),
    total: doc.int_of(d, "total", 0),
    tax: doc.int_of(d, "tax", 0),
    promo_name: doc.text(d, "promo_name", ""),
    promo_saved: doc.int_of(d, "promo_saved", 0),
  };
}

/** How one part of a receipt was paid. */
export interface SlipPayment {
  method: string;
  amount: number;
  change: number;
  reference: string;
}

export function slip_payment_of(d: Doc): SlipPayment {
  return {
    method: doc.text(d, "method", "cash"),
    amount: doc.int_of(d, "amount", 0),
    change: doc.int_of(d, "change", 0),
    reference: doc.text(d, "reference", ""),
  };
}

/** The shop, as it appears at the head of its own receipt. */
export interface SlipShop {
  name: string;
  name_my: string;
  address: string;
  phone: string;
  tax_id: string;
  footer: string;
  tax_inclusive: boolean;
}

/**
 * A sale as a printed receipt — `GET /till/receipts/:id/slip`.
 *
 * Not strict at any level: `register_name` and `customer` are LEFT JOINs and
 * arrive null for a sale rung with neither, and the shop's own details are
 * settings a shopkeeper may not have filled in.
 */
export interface Slip {
  shop: SlipShop;
  id: string;
  number: number;
  subtotal: number;
  promo_saved: number;
  discount: number;
  tax: number;
  total: number;
  completed_at: number;
  cashier: string;
  register_name: string;
  customer: string;
  lines: SlipLine[];
  payments: SlipPayment[];
}

export function slip_of(d: Doc): Slip {
  const shop = doc.field(d, "shop");
  const sale = doc.field(d, "sale");
  return {
    shop: {
      name: doc.text(shop, "name", ""),
      name_my: doc.text(shop, "name_my", ""),
      address: doc.text(shop, "address", ""),
      phone: doc.text(shop, "phone", ""),
      tax_id: doc.text(shop, "tax_id", ""),
      footer: doc.text(shop, "footer", ""),
      tax_inclusive: doc.bool_of(shop, "tax_inclusive", true),
    },
    id: doc.text(sale, "id", ""),
    number: doc.int_of(sale, "number", 0),
    subtotal: doc.int_of(sale, "subtotal", 0),
    promo_saved: doc.int_of(sale, "promo_saved", 0),
    discount: doc.int_of(sale, "discount", 0),
    tax: doc.int_of(sale, "tax", 0),
    total: doc.int_of(sale, "total", 0),
    completed_at: doc.int_of(sale, "completed_at", 0),
    cashier: doc.text(sale, "cashier", ""),
    register_name: doc.text(sale, "register_name", ""),
    customer: doc.text(sale, "customer", ""),
    lines: doc.items(doc.field(d, "lines")).map(slip_line_of),
    payments: doc.items(doc.field(d, "payments")).map(slip_payment_of),
  };
}

/**
 * A receipt as the returns screen opens it — `GET /till/receipts/:id`.
 *
 * Not strict: the sale's five fields sit under `sale` and the lines beside it,
 * and this is the flat pair the screen wants. A narrow projection, so there is
 * no tax and no promotion here: what a return needs is the number to quote and
 * how much of each line is still returnable.
 */
export interface ReceiptDetail {
  id: string;
  number: number;
  total: number;
  completed_at: number;
  cashier: string;
  lines: ReturnLine[];
}

export function receipt_detail_of(d: Doc): ReceiptDetail {
  const sale = doc.field(d, "sale");
  return {
    id: doc.text(sale, "id", ""),
    number: doc.int_of(sale, "number", 0),
    total: doc.int_of(sale, "total", 0),
    completed_at: doc.int_of(sale, "completed_at", 0),
    cashier: doc.text(sale, "cashier", ""),
    lines: doc.items(doc.field(d, "lines")).map(return_line_of),
  };
}

// ---- what the till is told mid-sale ----------------------------------------

/**
 * What a price check answers — `GET /till/price/:code`.
 *
 * Not strict: `product` is a nested object and the price beside it is at the
 * top level, so this is a flattening. `qty` is the barcode's pack size and is
 * **not 1** for a tray or a case; `total` is what that whole pack costs under
 * the best live offer.
 */
export interface PriceCheck {
  product_id: string;
  name: string;
  name_my: string;
  sku: string;
  unit: string;
  stock: number;
  min_age: number;
  qty: number;
  list_price: number;
  promo_name: string;
  promo_saved: number;
  total: number;
}

export function price_check_of(d: Doc): PriceCheck {
  const product = doc.field(d, "product");
  return {
    product_id: doc.text(product, "id", ""),
    name: doc.text(product, "name", ""),
    name_my: doc.text(product, "name_my", ""),
    sku: doc.text(product, "sku", ""),
    unit: doc.text(product, "unit", "each"),
    stock: doc.num_of(product, "stock", 0.0),
    min_age: doc.int_of(product, "min_age", 0),
    qty: doc.num_of(d, "qty", 1.0),
    list_price: doc.int_of(d, "list_price", 0),
    promo_name: doc.text(d, "promo_name", ""),
    promo_saved: doc.int_of(d, "promo_saved", 0),
    total: doc.int_of(d, "total", 0),
  };
}

/**
 * A finished sale — `POST /till/pay`.
 *
 * Not strict: **`replayed` is absent** on the first successful call and
 * present as `true` only when the idempotency key had already been used, so a
 * strict decoder would reject every ordinary sale.
 */
export interface Paid {
  sale_id: string;
  number: number;
  total: number;
  change: number;
  /**
   * How much of this sale went on the customer's tab, so the screen can say
   * "K3,000 to pay" rather than leaving somebody to work it out. Read back
   * from the rows by the Worker, which is why it is the same figure on a
   * replay as on the call that was lost.
   */
  on_account: number;
  completed_at: number;
  replayed: boolean;
}

export function paid_of(d: Doc): Paid {
  return {
    sale_id: doc.text(d, "sale_id", ""),
    number: doc.int_of(d, "number", 0),
    total: doc.int_of(d, "total", 0),
    change: doc.int_of(d, "change", 0),
    on_account: doc.int_of(d, "on_account", 0),
    completed_at: doc.int_of(d, "completed_at", 0),
    replayed: doc.bool_of(d, "replayed", false),
  };
}

/**
 * A tab, after money came off it.
 *
 * `owed` is what the customer still owes **across every tab**, not just the
 * ones this settlement touched, because that is the figure the cashier reads
 * back to them over the counter.
 */
export interface Settled {
  id: string;
  total: number;
  owed: number;
  replayed: boolean;
}

export function settled_of(d: Doc): Settled {
  return {
    id: doc.text(d, "id", ""),
    total: doc.int_of(d, "total", 0),
    owed: doc.int_of(d, "owed", 0),
    replayed: doc.bool_of(d, "replayed", false),
  };
}

/**
 * A counted drawer.
 *
 * One type for three doors that answer identically: `/till/close-lane`,
 * `/tills/:id/close` (by lane) and `/shifts/:id/close` (by shift). `variance`
 * is `counted - expected` and is **signed** — negative is short.
 *
 * Strict: four fields, all computed, none of them nullable.
 */
export interface DrawerCount {
  ok: boolean;
  expected: number;
  counted: number;
  variance: number;
}

export const decode_drawer_count = decoder<DrawerCount>("DrawerCount", {
  ok: bool,
  expected: int,
  counted: int,
  variance: int,
});

/**
 * What a create answers.
 *
 * Every POST in this API that makes a row answers `{ "id": … }` and nothing
 * else — not the row it made. Strict: one field, `NOT NULL`, and named `id`.
 */
export interface Created {
  id: string;
}

export const decode_created = decoder<Created>("Created", { id: str });

// ---- the catalogue, as the back office reads it -----------------------------

/**
 * A product, whole.
 *
 * One type for two endpoints: `GET /catalog/products` sends `p.*` plus the
 * two joined names, and `GET /catalog/products/:id` sends **exactly the same
 * twenty-two fields** under `product`. Every column ships, including ones no
 * screen draws, because the edit form has to send back what it did not change.
 *
 * Not strict, for five explicit nulls and two coded booleans:
 * `products.category_id`, `supplier_id` and `photo_key` are nullable columns,
 * and `category_name`/`supplier_name` come off LEFT JOINs and are null exactly
 * when their id is. An uncategorised product is legal and has to list. On top
 * of that `ask_price` and `active` are `INTEGER 0/1`, not JSON booleans.
 *
 * `active` falls back to **true**: a row that arrived without the column is one
 * the catalogue is selling, which is the opposite of what a zero would say.
 */
export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  name_my: string;
  category_id: string;
  supplier_id: string;
  cost: number;
  price: number;
  tax_bp: number;
  min_age: number;
  unit: string;
  ask_price: boolean;
  stock: number;
  reorder_point: number;
  reorder_qty: number;
  quick_key: number;
  photo_key: string;
  active: boolean;
  created_at: number;
  updated_at: number;
  category_name: string;
  supplier_name: string;
}

export function catalog_product_of(d: Doc): CatalogProduct {
  return {
    id: doc.text(d, "id", ""),
    sku: doc.text(d, "sku", ""),
    name: doc.text(d, "name", ""),
    name_my: doc.text(d, "name_my", ""),
    category_id: doc.text(d, "category_id", ""),
    supplier_id: doc.text(d, "supplier_id", ""),
    cost: doc.int_of(d, "cost", 0),
    price: doc.int_of(d, "price", 0),
    tax_bp: doc.int_of(d, "tax_bp", 0),
    min_age: doc.int_of(d, "min_age", 0),
    unit: doc.text(d, "unit", "each"),
    ask_price: doc.int_of(d, "ask_price", 0) === 1,
    stock: doc.num_of(d, "stock", 0.0),
    reorder_point: doc.num_of(d, "reorder_point", 0.0),
    reorder_qty: doc.num_of(d, "reorder_qty", 0.0),
    quick_key: doc.int_of(d, "quick_key", 0),
    photo_key: doc.text(d, "photo_key", ""),
    active: doc.int_of(d, "active", 1) === 1,
    created_at: doc.int_of(d, "created_at", 0),
    updated_at: doc.int_of(d, "updated_at", 0),
    category_name: doc.text(d, "category_name", ""),
    supplier_name: doc.text(d, "supplier_name", ""),
  };
}

/**
 * One of the codes that finds a product.
 *
 * Strict: `barcodes` names its three columns and all three are
 * `NOT NULL DEFAULT` — `pack_size` is a REAL and a fraction of a unit is a
 * legitimate value.
 */
export interface Barcode {
  barcode: string;
  pack_size: number;
  label: string;
}

const decode_barcode = decoder<Barcode>("Barcode", { barcode: str, pack_size: float, label: str });

/**
 * A movement of stock, as a product's own page lists it.
 *
 * Strict, and it is the one movement shape that can be: this query **names its
 * columns** and deliberately leaves out the nullable `user_id`. Everything it
 * does select is `NOT NULL`, and `ref_type`/`ref_id` are the empty string
 * rather than null for an adjustment with no document behind it.
 *
 * Not the same shape as [`StockMovement`], which is `m.*` and carries both the
 * product and the person.
 */
export interface ProductMovement {
  id: string;
  qty_delta: number;
  reason: string;
  ref_type: string;
  ref_id: string;
  unit_cost: number;
  note: string;
  created_at: number;
}

const decode_product_movement = decoder<ProductMovement>("ProductMovement", {
  id: str,
  qty_delta: float,
  reason: str,
  ref_type: str,
  ref_id: str,
  unit_cost: int,
  note: str,
  created_at: int,
});

/**
 * What one product sold on one day.
 *
 * Strict: a `DATE()` over a non-null `completed_at` and two SUMs over non-empty
 * groups. A day with no sales is simply **absent** from the list rather than
 * present as a zero.
 */
export interface SoldDay {
  day: string;
  qty: number;
  revenue: number;
}

const decode_sold_day = decoder<SoldDay>("SoldDay", { day: str, qty: float, revenue: int });

/**
 * One price in a product's queue. `left` is how many more sell at it before
 * the next one starts; the last has no end and reads `-1`, because the Worker
 * sends `null` there and a count cannot be negative.
 */
export interface PendingPrice {
  price: number;
  left: number;
}

/**
 * A product's own page — `GET /catalog/products/:id`.
 *
 * The `product` is read leniently because five of its columns may be null,
 * while the three lists beside it are clean shapes that decode strictly. A
 * malformed barcode is a fault at the other end and is reported; a product
 * with no supplier is Tuesday.
 */
export interface ProductPage {
  product: CatalogProduct;
  barcodes: Barcode[];
  movements: ProductMovement[];
  sold: SoldDay[];
  /**
   * A delivery's new price waiting for the old stock to sell, oldest first.
   * Empty when nothing is waiting — nearly always.
   */
  waiting: PendingPrice[];
}

export function product_page_of(d: Doc): ProductPage {
  const barcodes = decode_items(d, "barcodes", decode_barcode, "that product has a barcode we could not read");
  const movements = decode_items(
    d,
    "movements",
    decode_product_movement,
    "that product has a movement we could not read",
  );
  const sold = decode_items(d, "sold", decode_sold_day, "that product's sales history would not read");
  const waiting: PendingPrice[] = doc.items(doc.field(d, "waiting")).map((item) => ({
    price: doc.int_of(item, "price", 0),
    left: doc.num_of(item, "left", -1.0),
  }));
  return {
    product: catalog_product_of(doc.field(d, "product")),
    barcodes,
    movements,
    sold,
    waiting,
  };
}

/**
 * A shelf heading with its count, as the back office lists them.
 *
 * Strict: `categories.id` and `name` are `NOT NULL`, `name_my` and `sort` are
 * `NOT NULL DEFAULT`, and `products` is a COUNT. Not the same type as
 * [`Category`], which is the till's three-field subset of the same row.
 *
 * `products` counts **active** products only, so a category holding nothing
 * but retired lines reads 0 here and still refuses to be deleted.
 */
export interface CatalogCategory {
  id: string;
  name: string;
  name_my: string;
  sort: number;
  products: number;
}

export const decode_catalog_category = decoder<CatalogCategory>("CatalogCategory", {
  id: str,
  name: str,
  name_my: str,
  sort: int,
  products: int,
});

/**
 * Somebody the shop buys from.
 *
 * Not strict for one reason only: `suppliers.active` is an `INTEGER 0/1` and
 * not a JSON boolean. Every column here is `NOT NULL DEFAULT` and both computed
 * figures are aggregates, so nothing else in it can arrive null.
 *
 * `owed` is every invoice's total less every payment against it and **can be
 * negative** when a supplier has been overpaid. It also does not filter to open
 * invoices, so a cancelled one still counts here after it has dropped out of
 * the payables list — the two figures disagree by exactly that amount.
 */
export interface Supplier {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  lead_days: number;
  active: boolean;
  products: number;
  owed: number;
}

export function supplier_of(d: Doc): Supplier {
  return {
    id: doc.text(d, "id", ""),
    name: doc.text(d, "name", ""),
    phone: doc.text(d, "phone", ""),
    email: doc.text(d, "email", ""),
    address: doc.text(d, "address", ""),
    // Three days, which is what the server writes when a supplier is
    // created without one.
    lead_days: doc.int_of(d, "lead_days", 3),
    active: doc.int_of(d, "active", 1) === 1,
    products: doc.int_of(d, "products", 0),
    owed: doc.int_of(d, "owed", 0),
  };
}

// ---- what is on the shelf ---------------------------------------------------

/**
 * The shop's stock in one line.
 *
 * Not strict, and this one is insurance rather than a null: every figure is
 * COALESCE'd and a bare aggregate always returns a row, so the object is
 * always there and always whole. But it is typed `T|null` at the other end, and
 * an empty shop showing zeros beats an empty shop showing an error.
 *
 * `units` is a SUM over a REAL column: 12.5 kg is a legitimate total.
 */
export interface InventoryTotals {
  skus: number;
  units: number;
  at_cost: number;
  at_retail: number;
  low: number;
  out: number;
}

export function inventory_totals_of(d: Doc): InventoryTotals {
  return {
    skus: doc.int_of(d, "skus", 0),
    units: doc.num_of(d, "units", 0.0),
    at_cost: doc.int_of(d, "at_cost", 0),
    at_retail: doc.int_of(d, "at_retail", 0),
    low: doc.int_of(d, "low", 0),
    out: doc.int_of(d, "out", 0),
  };
}

/**
 * What one heading's stock is worth.
 *
 * Strict: `category` is `COALESCE(c.name, 'Uncategorised')` and so is never
 * null — which does mean a shop with a real category named "Uncategorised"
 * merges with the bucket for products that have none.
 */
export interface CategoryValue {
  category: string;
  skus: number;
  at_cost: number;
}

const decode_category_value = decoder<CategoryValue>("CategoryValue", { category: str, skus: int, at_cost: int });

/**
 * A product that is low or out.
 *
 * Not strict: `supplier_name` is a LEFT JOIN and is null for anything with no
 * supplier — which is the single null in the whole `/inventory` answer and the
 * only reason this row is hand-written.
 */
export interface LowStock {
  id: string;
  sku: string;
  name: string;
  stock: number;
  reorder_point: number;
  reorder_qty: number;
  cost: number;
  price: number;
  unit: string;
  supplier_name: string;
}

export function low_stock_of(d: Doc): LowStock {
  return {
    id: doc.text(d, "id", ""),
    sku: doc.text(d, "sku", ""),
    name: doc.text(d, "name", ""),
    stock: doc.num_of(d, "stock", 0.0),
    reorder_point: doc.num_of(d, "reorder_point", 0.0),
    reorder_qty: doc.num_of(d, "reorder_qty", 0.0),
    cost: doc.int_of(d, "cost", 0),
    price: doc.int_of(d, "price", 0),
    unit: doc.text(d, "unit", "each"),
    supplier_name: doc.text(d, "supplier_name", ""),
  };
}

/**
 * The stock screen — `GET /inventory`.
 *
 * The by-category breakdown decodes strictly; the totals and the attention
 * list are read leniently for the reasons written above each. `attention` is
 * empty on a healthy shop, which is the point of it.
 */
export interface Inventory {
  totals: InventoryTotals;
  by_category: CategoryValue[];
  attention: LowStock[];
}

export function inventory_of(d: Doc): Inventory {
  const by_category = decode_items(
    d,
    "by_category",
    decode_category_value,
    "the stock summary has a heading we could not read",
  );
  return {
    totals: inventory_totals_of(doc.field(d, "totals")),
    by_category,
    attention: doc.items(doc.field(d, "attention")).map(low_stock_of),
  };
}

/**
 * A movement of stock, as the movements log lists it.
 *
 * Not strict: this is `m.*` rather than a named projection, so it carries
 * `stock_movements.user_id` — a **nullable** column, because a movement can be
 * written with no signed-in actor behind it — and `user_name` from a LEFT JOIN
 * that is null both when the id is and when that person has since been removed.
 * `product_name` and `sku` come from an INNER JOIN and are sound.
 */
export interface StockMovement {
  id: string;
  product_id: string;
  qty_delta: number;
  reason: string;
  ref_type: string;
  ref_id: string;
  unit_cost: number;
  note: string;
  user_id: string;
  created_at: number;
  product_name: string;
  sku: string;
  user_name: string;
}

export function stock_movement_of(d: Doc): StockMovement {
  return {
    id: doc.text(d, "id", ""),
    product_id: doc.text(d, "product_id", ""),
    qty_delta: doc.num_of(d, "qty_delta", 0.0),
    reason: doc.text(d, "reason", ""),
    ref_type: doc.text(d, "ref_type", ""),
    ref_id: doc.text(d, "ref_id", ""),
    unit_cost: doc.int_of(d, "unit_cost", 0),
    note: doc.text(d, "note", ""),
    user_id: doc.text(d, "user_id", ""),
    created_at: doc.int_of(d, "created_at", 0),
    product_name: doc.text(d, "product_name", ""),
    sku: doc.text(d, "sku", ""),
    user_name: doc.text(d, "user_name", ""),
  };
}

// ---- buying -----------------------------------------------------------------

/**
 * A line of the reordering worksheet.
 *
 * Not strict, and `days_left` is the field that decides it: the server sets it
 * to **null** for anything that sold nothing in the window, because dividing
 * what is on the shelf by a rate of nothing has no answer. On a quiet shop most
 * lines carry that null. It is read here as **-1**, which the screen already
 * treats as "not running out", rather than as a zero that would read as "out
 * today". `supplier_id` and `supplier_name` are the usual nullable pair.
 *
 * `sold`, `on_order` and `per_day` are floats over REAL quantity columns.
 * `suggested` is a whole number at the other end — a `ceil` floored at zero —
 * but it is read as a quantity here: the screen shows it with the same
 * formatter as every other quantity, and raising an order sends it back as
 * `qty`, which is REAL.
 */
export interface WorksheetLine {
  id: string;
  sku: string;
  name: string;
  stock: number;
  reorder_point: number;
  reorder_qty: number;
  cost: number;
  unit: string;
  supplier_id: string;
  supplier_name: string;
  lead_days: number;
  sold: number;
  on_order: number;
  per_day: number;
  days_left: number;
  suggested: number;
  value: number;
}

export function worksheet_line_of(d: Doc): WorksheetLine {
  return {
    id: doc.text(d, "id", ""),
    sku: doc.text(d, "sku", ""),
    name: doc.text(d, "name", ""),
    stock: doc.num_of(d, "stock", 0.0),
    reorder_point: doc.num_of(d, "reorder_point", 0.0),
    reorder_qty: doc.num_of(d, "reorder_qty", 0.0),
    cost: doc.int_of(d, "cost", 0),
    unit: doc.text(d, "unit", "each"),
    supplier_id: doc.text(d, "supplier_id", ""),
    supplier_name: doc.text(d, "supplier_name", ""),
    // COALESCE(s.lead_days, 3) at the other end: never null, even with no
    // supplier on the product.
    lead_days: doc.int_of(d, "lead_days", 3),
    sold: doc.num_of(d, "sold", 0.0),
    on_order: doc.num_of(d, "on_order", 0.0),
    per_day: doc.num_of(d, "per_day", 0.0),
    days_left: doc.num_of(d, "days_left", -1.0),
    suggested: doc.num_of(d, "suggested", 0.0),
    value: doc.int_of(d, "value", 0),
  };
}

/**
 * A purchase order, as the list shows it.
 *
 * Not strict: five nullable fields, and the two that matter are ordinary
 * rather than rare. `expected_at` is null for an order raised without a date,
 * and `received_at` stays null until the order is **fully** received — so a
 * draft, a sent order and a part-received one all send null there.
 * `created_by`, `created_by_name` and even `number` are nullable columns too.
 *
 * Not the same shape as [`OrderHead`]: this one carries the raiser's name and a
 * count of lines, and that one carries the supplier's telephone number instead.
 */
export interface PurchaseOrder {
  id: string;
  number: number;
  supplier_id: string;
  status: string;
  expected_at: number;
  total: number;
  note: string;
  created_by: string;
  created_at: number;
  received_at: number;
  supplier_name: string;
  created_by_name: string;
  lines: number;
  /**
   * Written by Goods In rather than raised as an order. Nothing branches on
   * it; the list says which is which so a shopkeeper reading it can tell a
   * van that turned up from an order placed with a wholesaler.
   */
  direct: boolean;
}

export function purchase_order_of(d: Doc): PurchaseOrder {
  return {
    id: doc.text(d, "id", ""),
    number: doc.int_of(d, "number", 0),
    supplier_id: doc.text(d, "supplier_id", ""),
    status: doc.text(d, "status", "draft"),
    expected_at: doc.int_of(d, "expected_at", 0),
    total: doc.int_of(d, "total", 0),
    note: doc.text(d, "note", ""),
    created_by: doc.text(d, "created_by", ""),
    created_at: doc.int_of(d, "created_at", 0),
    received_at: doc.int_of(d, "received_at", 0),
    supplier_name: doc.text(d, "supplier_name", ""),
    created_by_name: doc.text(d, "created_by_name", ""),
    lines: doc.int_of(d, "lines", 0),
    direct: doc.int_of(d, "direct", 0) === 1,
  };
}

/**
 * A purchase order, as its own page opens it.
 *
 * Not strict, for the same nullable dates as [`PurchaseOrder`].
 * `supplier_phone` is `NOT NULL DEFAULT ''` — an empty string, never null — and
 * is here rather than in the list because this is the page somebody rings the
 * supplier from.
 */
export interface OrderHead {
  id: string;
  number: number;
  supplier_id: string;
  status: string;
  expected_at: number;
  total: number;
  note: string;
  created_by: string;
  created_at: number;
  received_at: number;
  supplier_name: string;
  supplier_phone: string;
  cancel_reason: string;
  direct: boolean;
}

export function order_head_of(d: Doc): OrderHead {
  return {
    id: doc.text(d, "id", ""),
    number: doc.int_of(d, "number", 0),
    supplier_id: doc.text(d, "supplier_id", ""),
    status: doc.text(d, "status", "draft"),
    expected_at: doc.int_of(d, "expected_at", 0),
    total: doc.int_of(d, "total", 0),
    note: doc.text(d, "note", ""),
    created_by: doc.text(d, "created_by", ""),
    created_at: doc.int_of(d, "created_at", 0),
    received_at: doc.int_of(d, "received_at", 0),
    supplier_name: doc.text(d, "supplier_name", ""),
    supplier_phone: doc.text(d, "supplier_phone", ""),
    cancel_reason: doc.text(d, "cancel_reason", ""),
    direct: doc.int_of(d, "direct", 0) === 1,
  };
}

/**
 * One line of a purchase order.
 *
 * Strict: every `purchase_order_items` column is `NOT NULL`, and
 * `product_name`, `sku` and `unit` come from an INNER JOIN on a product the
 * line cannot exist without. `qty` and `qty_received` are REALs — a
 * part-received line reads 6 and 2.5.
 */
export interface OrderLine {
  id: string;
  po_id: string;
  product_id: string;
  qty: number;
  qty_received: number;
  unit_cost: number;
  product_name: string;
  sku: string;
  unit: string;
}

const decode_order_line = decoder<OrderLine>("OrderLine", {
  id: str,
  po_id: str,
  product_id: str,
  qty: float,
  qty_received: float,
  unit_cost: int,
  product_name: str,
  sku: str,
  unit: str,
});

/**
 * An order's own page — `GET /purchasing/orders/:id`.
 *
 * The head is read leniently for its nullable dates, the lines decode strictly.
 */
export interface OrderPage {
  order: OrderHead;
  lines: OrderLine[];
}

export function order_page_of(d: Doc): OrderPage {
  const lines = decode_items(d, "lines", decode_order_line, "that order has a line we could not read");
  return { order: order_head_of(doc.field(d, "order")), lines };
}

/**
 * A supplier's invoice, as the payables list shows it.
 *
 * Not strict: `due_at` is nullable and an invoice with no agreed date is
 * expected rather than rare — the list is *ordered* around that case. `po_id`
 * is null for anything keyed in by hand rather than raised off a delivery, and
 * `cancelled_at` is always null here because the list filters to open ones.
 *
 * `outstanding` is what is left to pay and can be 0 on an invoice that is fully
 * paid and still open.
 */
export interface Invoice {
  id: string;
  supplier_id: string;
  po_id: string;
  reference: string;
  issued_at: number;
  due_at: number;
  total: number;
  created_at: number;
  status: string;
  cancelled_at: number;
  cancel_reason: string;
  supplier_name: string;
  paid: number;
  outstanding: number;
}

export function invoice_of(d: Doc): Invoice {
  return {
    id: doc.text(d, "id", ""),
    supplier_id: doc.text(d, "supplier_id", ""),
    po_id: doc.text(d, "po_id", ""),
    reference: doc.text(d, "reference", ""),
    issued_at: doc.int_of(d, "issued_at", 0),
    due_at: doc.int_of(d, "due_at", 0),
    total: doc.int_of(d, "total", 0),
    created_at: doc.int_of(d, "created_at", 0),
    status: doc.text(d, "status", "open"),
    cancelled_at: doc.int_of(d, "cancelled_at", 0),
    cancel_reason: doc.text(d, "cancel_reason", ""),
    supplier_name: doc.text(d, "supplier_name", ""),
    paid: doc.int_of(d, "paid", 0),
    outstanding: doc.int_of(d, "outstanding", 0),
  };
}

/**
 * What the shop owes, in four figures.
 *
 * Strict: computed in the Worker with `Number(… ?? 0)`, so an empty book
 * answers zeros rather than nulls. `overdue` is everything past its date;
 * `late_over_30` is the part of that more than thirty days past it — not "over
 * thirty in value".
 */
export interface PayablesTotals {
  outstanding: number;
  overdue: number;
  current: number;
  late_over_30: number;
}

const decode_payables_totals = decoder<PayablesTotals>("PayablesTotals", {
  outstanding: int,
  overdue: int,
  current: int,
  late_over_30: int,
});

/**
 * One supplier's debt, banded by how late it is.
 *
 * Strict: every column is a SUM over a non-empty group or a `NOT NULL`
 * supplier column. Note the rename the Worker does and this keeps: the aging
 * table calls the supplier's name **`supplier`** while the invoice list beside
 * it calls the same value `supplier_name`.
 */
export interface AgingRow {
  supplier_id: string;
  supplier: string;
  current: number;
  d30: number;
  d60: number;
  d90: number;
  d90up: number;
  total: number;
}

const decode_aging_row = decoder<AgingRow>("AgingRow", {
  supplier_id: str,
  supplier: str,
  current: int,
  d30: int,
  d60: int,
  d90: int,
  d90up: int,
  total: int,
});

/** The aging table's foot. */
export interface AgingTotals {
  current: number;
  d30: number;
  d60: number;
  d90: number;
  d90up: number;
  total: number;
}

const decode_aging_totals = decoder<AgingTotals>("AgingTotals", {
  current: int,
  d30: int,
  d60: int,
  d90: int,
  d90up: int,
  total: int,
});

/**
 * Everything owed, banded — the aging half of `/purchasing/payables`.
 *
 * Strict whole, rows and foot together.
 */
export interface Aging {
  rows: AgingRow[];
  totals: AgingTotals;
}

const decode_aging = decoder<Aging>("Aging", { rows: list(decode_aging_row), totals: nested(decode_aging_totals) });

/**
 * What the shop owes — `GET /purchasing/payables`.
 *
 * The invoices are read leniently for their nullable dates while the totals and
 * the aging table decode strictly.
 *
 * The two halves do **not** have the same scope. `invoices` is the first 200 by
 * due date; `aging` is summed by the database over every open invoice with no
 * limit and drops anything already settled. `totals.outstanding` will not equal
 * the sum of the listed invoices once there are more than 200 of them.
 */
export interface Payables {
  invoices: Invoice[];
  totals: PayablesTotals;
  aging: Aging;
}

export function payables_of(d: Doc): Payables {
  const totals = decode_or(decode_payables_totals, object_at(d, "totals"), "the payables summary would not read");
  const aging = decode_or(decode_aging, object_at(d, "aging"), "the aging table would not read");
  return {
    invoices: doc.items(doc.field(d, "invoices")).map(invoice_of),
    totals,
    aging,
  };
}

// ---- sales, as the office reads them ----------------------------------------

/**
 * A sale in the day's list — `GET /sales`.
 *
 * Not strict: `sales.number` and `completed_at` are only written when a sale
 * is **paid for**, so a held or voided row sends null for both and the `status`
 * query makes those rows reachable. `customer` is null on a walk-in and
 * `register_name` is null when the sale was not rung on a lane.
 *
 * `refunded` is what has been given back against it, and a row with anything
 * there is the one a manager is looking for.
 */
export interface SaleRow {
  id: string;
  number: number;
  total: number;
  tax: number;
  discount: number;
  promo_saved: number;
  status: string;
  completed_at: number;
  created_at: number;
  void_reason: string;
  cashier: string;
  customer: string;
  register_name: string;
  items: number;
  refunded: number;
}

export function sale_row_of(d: Doc): SaleRow {
  return {
    id: doc.text(d, "id", ""),
    number: doc.int_of(d, "number", 0),
    total: doc.int_of(d, "total", 0),
    tax: doc.int_of(d, "tax", 0),
    discount: doc.int_of(d, "discount", 0),
    promo_saved: doc.int_of(d, "promo_saved", 0),
    status: doc.text(d, "status", ""),
    completed_at: doc.int_of(d, "completed_at", 0),
    created_at: doc.int_of(d, "created_at", 0),
    void_reason: doc.text(d, "void_reason", ""),
    cashier: doc.text(d, "cashier", ""),
    customer: doc.text(d, "customer", ""),
    register_name: doc.text(d, "register_name", ""),
    items: doc.int_of(d, "items", 0),
    refunded: doc.int_of(d, "refunded", 0),
  };
}

/**
 * One sale, whole — the `sale` of `GET /sales/:id`.
 *
 * Not strict: this is `SELECT s.*` and seven of its columns are nullable.
 * `client_id` is written only when a till sent an idempotency key; `number` and
 * `completed_at` are null until it is paid for; `register_id`, `shift_id` and
 * `customer_id` are all nullable references. `customer` and `customer_phone`
 * come from the same LEFT JOIN and go null **together** on a walk-in — the
 * telephone column is `NOT NULL DEFAULT ''` in its own table, and the outer
 * join produces null anyway.
 */
export interface SaleHead {
  id: string;
  client_id: string;
  number: number;
  register_id: string;
  shift_id: string;
  user_id: string;
  customer_id: string;
  status: string;
  hold_label: string;
  basket_discount: number;
  subtotal: number;
  promo_saved: number;
  discount: number;
  tax: number;
  total: number;
  void_reason: string;
  created_at: number;
  completed_at: number;
  cashier: string;
  customer: string;
  customer_phone: string;
  register_name: string;
}

export function sale_head_of(d: Doc): SaleHead {
  return {
    id: doc.text(d, "id", ""),
    client_id: doc.text(d, "client_id", ""),
    number: doc.int_of(d, "number", 0),
    register_id: doc.text(d, "register_id", ""),
    shift_id: doc.text(d, "shift_id", ""),
    user_id: doc.text(d, "user_id", ""),
    customer_id: doc.text(d, "customer_id", ""),
    status: doc.text(d, "status", ""),
    hold_label: doc.text(d, "hold_label", ""),
    basket_discount: doc.int_of(d, "basket_discount", 0),
    subtotal: doc.int_of(d, "subtotal", 0),
    promo_saved: doc.int_of(d, "promo_saved", 0),
    discount: doc.int_of(d, "discount", 0),
    tax: doc.int_of(d, "tax", 0),
    total: doc.int_of(d, "total", 0),
    void_reason: doc.text(d, "void_reason", ""),
    created_at: doc.int_of(d, "created_at", 0),
    completed_at: doc.int_of(d, "completed_at", 0),
    cashier: doc.text(d, "cashier", ""),
    customer: doc.text(d, "customer", ""),
    customer_phone: doc.text(d, "customer_phone", ""),
    register_name: doc.text(d, "register_name", ""),
  };
}

/**
 * A line of a sale as the receipt holds it.
 *
 * Not [`Line`], which is what the till's basket sends: this is `SELECT i.*`
 * with **no products join**, so there is no `name_my` — a reprinted receipt
 * reads as it did on the day and the shelf name is not joined into it.
 *
 * Not strict: `product_id` is nullable, because a line whose product has been
 * deleted still has to print, and `promo_id` is null wherever no offer applied.
 * `price_override` and `age_checked` are `INTEGER 0/1` here, where the till's
 * own basket endpoint converts the same two to real booleans.
 */
export interface SaleLine {
  id: string;
  sale_id: string;
  product_id: string;
  name: string;
  sku: string;
  qty: number;
  unit_price: number;
  list_price: number;
  line_discount: number;
  promo_id: string;
  promo_name: string;
  promo_saved: number;
  price_override: boolean;
  tax_bp: number;
  tax: number;
  total: number;
  cost: number;
  min_age: number;
  age_checked: boolean;
  sort: number;
  refunded_qty: number;
}

export function sale_line_of(d: Doc): SaleLine {
  return {
    id: doc.text(d, "id", ""),
    sale_id: doc.text(d, "sale_id", ""),
    product_id: doc.text(d, "product_id", ""),
    name: doc.text(d, "name", ""),
    sku: doc.text(d, "sku", ""),
    qty: doc.num_of(d, "qty", 0.0),
    unit_price: doc.int_of(d, "unit_price", 0),
    list_price: doc.int_of(d, "list_price", 0),
    line_discount: doc.int_of(d, "line_discount", 0),
    promo_id: doc.text(d, "promo_id", ""),
    promo_name: doc.text(d, "promo_name", ""),
    promo_saved: doc.int_of(d, "promo_saved", 0),
    price_override: doc.int_of(d, "price_override", 0) === 1,
    tax_bp: doc.int_of(d, "tax_bp", 0),
    tax: doc.int_of(d, "tax", 0),
    total: doc.int_of(d, "total", 0),
    cost: doc.int_of(d, "cost", 0),
    min_age: doc.int_of(d, "min_age", 0),
    age_checked: doc.int_of(d, "age_checked", 0) === 1,
    sort: doc.int_of(d, "sort", 0),
    refunded_qty: doc.num_of(d, "refunded_qty", 0.0),
  };
}

/**
 * How one sale was paid for.
 *
 * Strict: every `payments` column is `NOT NULL`, three of them by default.
 * `tendered` is what the customer handed over and `change` what came back, so
 * the amount that reconciles a drawer is `amount`, not `tendered`.
 */
export interface SalePayment {
  id: string;
  sale_id: string;
  method: string;
  amount: number;
  tendered: number;
  change: number;
  reference: string;
  created_at: number;
}

const decode_sale_payment = decoder<SalePayment>("SalePayment", {
  id: str,
  sale_id: str,
  method: str,
  amount: int,
  tendered: int,
  change: int,
  reference: str,
  created_at: int,
});

/**
 * A refund taken against a sale.
 *
 * Not strict: `client_id`, `approved_by` and `shift_id` are all nullable, and
 * the last is **deliberately** null for a refund taken in the back office — the
 * cash comes from the safe rather than from a drawer. `restock` is an
 * `INTEGER 0/1`.
 */
export interface SaleRefund {
  id: string;
  client_id: string;
  sale_id: string;
  user_id: string;
  approved_by: string;
  shift_id: string;
  reason: string;
  method: string;
  total: number;
  /**
   * How much of it came off the customer's tab rather than out of a till.
   * `total - on_account` is what actually left by `method`, and it is that
   * figure a drawer expects to be missing.
   */
  on_account: number;
  restock: boolean;
  created_at: number;
  by_name: string;
}

export function sale_refund_of(d: Doc): SaleRefund {
  return {
    id: doc.text(d, "id", ""),
    client_id: doc.text(d, "client_id", ""),
    sale_id: doc.text(d, "sale_id", ""),
    user_id: doc.text(d, "user_id", ""),
    approved_by: doc.text(d, "approved_by", ""),
    shift_id: doc.text(d, "shift_id", ""),
    reason: doc.text(d, "reason", ""),
    method: doc.text(d, "method", "cash"),
    total: doc.int_of(d, "total", 0),
    on_account: doc.int_of(d, "on_account", 0),
    // The server restocks unless the body said otherwise, so a missing flag
    // means the goods went back on the shelf.
    restock: doc.int_of(d, "restock", 1) === 1,
    created_at: doc.int_of(d, "created_at", 0),
    by_name: doc.text(d, "by_name", ""),
  };
}

/**
 * The shop, as it prints at the head of a receipt.
 *
 * Strict: every value falls back to `""` at the other end, so all five keys
 * are always present. `footer` is renamed from the `shop.receipt_footer`
 * setting **by the Worker** — by the time it reaches here it is already
 * `footer`, so there is nothing left for a converter to rename.
 */
export interface Shop {
  name: string;
  address: string;
  phone: string;
  tax_id: string;
  footer: string;
}

const decode_shop = decoder<Shop>("Shop", { name: str, address: str, phone: str, tax_id: str, footer: str });

/**
 * A currency as this one endpoint spells it.
 *
 * Not strict, and it cannot be shared with [`session_of`]: `/sales/:id` is the
 * **only** camelCase object on the wire — `minorUnits`, `symbolFirst` — while
 * `/auth/me` sends the same four values as `minor_units` and `symbol_first`.
 * One shape, two spellings, so there are two readers.
 */
export function wire_currency_of(d: Doc): Currency {
  return {
    code: doc.text(d, "code", "MMK"),
    symbol: doc.text(d, "symbol", "K"),
    minor_units: doc.int_of(d, "minorUnits", 0),
    symbol_first: doc.bool_of(d, "symbolFirst", true),
  };
}

/**
 * One sale's own page — `GET /sales/:id`.
 *
 * The sale, its lines and its refunds are read leniently for the nullable
 * columns named above, while the payments and the shop's own details decode
 * strictly.
 */
export interface SalePage {
  sale: SaleHead;
  lines: SaleLine[];
  payments: SalePayment[];
  refunds: SaleRefund[];
  currency: Currency;
  shop: Shop;
}

export function sale_page_of(d: Doc): SalePage {
  const payments = decode_items(d, "payments", decode_sale_payment, "that sale has a payment we could not read");
  const shop = decode_or(decode_shop, object_at(d, "shop"), "the shop's own details would not read");
  return {
    sale: sale_head_of(doc.field(d, "sale")),
    lines: doc.items(doc.field(d, "lines")).map(sale_line_of),
    payments,
    refunds: doc.items(doc.field(d, "refunds")).map(sale_refund_of),
    currency: wire_currency_of(doc.field(d, "currency")),
    shop,
  };
}

/**
 * One thing somebody had to be authorised for.
 *
 * Not strict, and `amount` alone would settle it: the column has no default
 * and the rows written for a voided sale and for a no-sale simply **omit** it,
 * so null is routine rather than exceptional. `user_id`, `approved_by` and
 * `register_id` are nullable too, and each of the three joined names is null
 * when its id is or when that person or lane has since gone.
 */
export interface AuditEntry {
  id: string;
  at: number;
  user_id: string;
  approved_by: string;
  register_id: string;
  action: string;
  ref_type: string;
  ref_id: string;
  amount: number;
  detail: string;
  asked_by_name: string;
  approved_by_name: string;
  register_name: string;
}

export function audit_entry_of(d: Doc): AuditEntry {
  return {
    id: doc.text(d, "id", ""),
    at: doc.int_of(d, "at", 0),
    user_id: doc.text(d, "user_id", ""),
    approved_by: doc.text(d, "approved_by", ""),
    register_id: doc.text(d, "register_id", ""),
    action: doc.text(d, "action", ""),
    ref_type: doc.text(d, "ref_type", ""),
    ref_id: doc.text(d, "ref_id", ""),
    amount: doc.int_of(d, "amount", 0),
    detail: doc.text(d, "detail", ""),
    asked_by_name: doc.text(d, "asked_by_name", ""),
    approved_by_name: doc.text(d, "approved_by_name", ""),
    register_name: doc.text(d, "register_name", ""),
  };
}

// ---- lanes, drawers and shifts ----------------------------------------------

/**
 * A lane, as the back office watches it.
 *
 * Not strict: six of nineteen fields are nullable and every one of them is
 * null on the ordinary case of a lane nobody has opened yet. `shift_id`,
 * `opened_at`, `opening_float`, `operator` and `operator_id` go null together
 * with the drawer; `last_close` and `last_variance` are null until it has been
 * closed once; `last_seen_at` is null until it has called the Worker at all.
 *
 * And one that is easy to miss: **`active_total` has no COALESCE** where the
 * three figures beside it do, so a lane with no basket on it sends null there
 * while `sales`, `takings` and `active_items` send 0.
 */
export interface Lane {
  id: string;
  name: string;
  kind: string;
  last_seen_at: number;
  shift_id: string;
  opened_at: number;
  opening_float: number;
  operator: string;
  operator_id: string;
  sales: number;
  takings: number;
  active_items: number;
  active_total: number;
  last_close: number;
  last_variance: number;
  state: string;
  online: boolean;
  held: number;
  drawer_expected: number;
}

export function lane_of(d: Doc): Lane {
  return {
    id: doc.text(d, "id", ""),
    name: doc.text(d, "name", ""),
    kind: doc.text(d, "kind", "counter"),
    last_seen_at: doc.int_of(d, "last_seen_at", 0),
    shift_id: doc.text(d, "shift_id", ""),
    opened_at: doc.int_of(d, "opened_at", 0),
    opening_float: doc.int_of(d, "opening_float", 0),
    operator: doc.text(d, "operator", ""),
    operator_id: doc.text(d, "operator_id", ""),
    sales: doc.int_of(d, "sales", 0),
    takings: doc.int_of(d, "takings", 0),
    active_items: doc.int_of(d, "active_items", 0),
    active_total: doc.int_of(d, "active_total", 0),
    last_close: doc.int_of(d, "last_close", 0),
    last_variance: doc.int_of(d, "last_variance", 0),
    state: doc.text(d, "state", "closed"),
    online: doc.bool_of(d, "online", false),
    held: doc.int_of(d, "held", 0),
    drawer_expected: doc.int_of(d, "drawer_expected", 0),
  };
}

/**
 * A shift in the list — `GET /shifts`.
 *
 * Not strict: the five columns a close writes are all null while the drawer is
 * **open**, and the list is ordered newest first, so the open shifts are the
 * first rows a screen draws. `note` is null on an open shift and `''` on one
 * closed without a note, and `closed_by_name` is a LEFT JOIN on a nullable id.
 */
export interface ShiftRow {
  id: string;
  register_id: string;
  user_id: string;
  opened_at: number;
  opening_float: number;
  closed_at: number;
  closed_by: string;
  counted_total: number;
  expected_total: number;
  variance: number;
  note: string;
  register_name: string;
  user_name: string;
  closed_by_name: string;
  sales: number;
  takings: number;
}

export function shift_row_of(d: Doc): ShiftRow {
  return {
    id: doc.text(d, "id", ""),
    register_id: doc.text(d, "register_id", ""),
    user_id: doc.text(d, "user_id", ""),
    opened_at: doc.int_of(d, "opened_at", 0),
    opening_float: doc.int_of(d, "opening_float", 0),
    closed_at: doc.int_of(d, "closed_at", 0),
    closed_by: doc.text(d, "closed_by", ""),
    counted_total: doc.int_of(d, "counted_total", 0),
    expected_total: doc.int_of(d, "expected_total", 0),
    variance: doc.int_of(d, "variance", 0),
    note: doc.text(d, "note", ""),
    register_name: doc.text(d, "register_name", ""),
    user_name: doc.text(d, "user_name", ""),
    closed_by_name: doc.text(d, "closed_by_name", ""),
    sales: doc.int_of(d, "sales", 0),
    takings: doc.int_of(d, "takings", 0),
  };
}

/**
 * A shift, as its own page opens it.
 *
 * The same six nullable columns as [`ShiftRow`], and one difference worth
 * knowing: this endpoint does **not** join `closed_by_name`. The list does. A
 * screen that reads that name off the detail gets nothing, which is why the
 * field is not on this type at all rather than always empty.
 */
export interface ShiftHead {
  id: string;
  register_id: string;
  user_id: string;
  opened_at: number;
  opening_float: number;
  closed_at: number;
  closed_by: string;
  counted_total: number;
  expected_total: number;
  variance: number;
  note: string;
  register_name: string;
  user_name: string;
}

export function shift_head_of(d: Doc): ShiftHead {
  return {
    id: doc.text(d, "id", ""),
    register_id: doc.text(d, "register_id", ""),
    user_id: doc.text(d, "user_id", ""),
    opened_at: doc.int_of(d, "opened_at", 0),
    opening_float: doc.int_of(d, "opening_float", 0),
    closed_at: doc.int_of(d, "closed_at", 0),
    closed_by: doc.text(d, "closed_by", ""),
    counted_total: doc.int_of(d, "counted_total", 0),
    expected_total: doc.int_of(d, "expected_total", 0),
    variance: doc.int_of(d, "variance", 0),
    note: doc.text(d, "note", ""),
    register_name: doc.text(d, "register_name", ""),
    user_name: doc.text(d, "user_name", ""),
  };
}

/**
 * What should be in the drawer, and how it got there.
 *
 * Strict: not one of these is read from a column — the whole object is
 * computed, every term COALESCE'd to 0, so all of them are whole numbers even
 * on a shift that has taken nothing. `cash_taken` is gross cash **in**, with
 * `change_given` subtracted back out to reach `expected`.
 */
export interface Drawer {
  opening_float: number;
  cash_taken: number;
  change_given: number;
  cash_in: number;
  /**
   * Cash a customer put on the counter to pay off a tab, at this lane.
   *
   * Its own term rather than a paid-in cash movement, because the two are
   * not the same event: a paid-in is the shopkeeper putting money in, and is
   * booked against owner capital. This is a debt being settled, and it has
   * to be in the count either way — the notes are physically in the drawer.
   */
  tabs_settled: number;
  cash_out: number;
  cash_refunds: number;
  expected: number;
}

const decode_drawer = decoder<Drawer>("Drawer", {
  opening_float: int,
  cash_taken: int,
  change_given: int,
  cash_in: int,
  tabs_settled: int,
  cash_out: int,
  cash_refunds: int,
  expected: int,
});

/**
 * Cash into or out of a drawer other than by selling.
 *
 * Strict: every `cash_movements` column is `NOT NULL` — including `user_id`,
 * unlike the stock movements — and `user_name` comes from an INNER JOIN on it.
 * A `safe_drop` counts as cash out of the drawer, the same as a `paid_out`.
 */
export interface CashMovement {
  id: string;
  shift_id: string;
  kind: string;
  amount: number;
  reason: string;
  user_id: string;
  created_at: number;
  user_name: string;
}

const decode_cash_movement = decoder<CashMovement>("CashMovement", {
  id: str,
  shift_id: str,
  kind: str,
  amount: int,
  reason: str,
  user_id: str,
  created_at: int,
  user_name: str,
});

/**
 * What was taken by one tender.
 *
 * One type for two endpoints: the tenders of a shift's page and the tenders of
 * `/reports/sales` are the same three columns from the same GROUP BY.
 *
 * Strict: `amount` is a SUM over a non-empty group, so an empty result is an
 * empty **list** rather than a row of nulls.
 */
export interface TenderTotal {
  method: string;
  count: number;
  amount: number;
}

const decode_tender_total = decoder<TenderTotal>("TenderTotal", { method: str, count: int, amount: int });

/**
 * A sale in the list under a shift.
 *
 * Strict: the query is completed-only, and the statement that completes a sale
 * writes `number` and `completed_at` in the same breath as the status.
 */
export interface ShiftSale {
  id: string;
  number: number;
  total: number;
  completed_at: number;
}

const decode_shift_sale = decoder<ShiftSale>("ShiftSale", { id: str, number: int, total: int, completed_at: int });

/**
 * A shift's own page — `GET /shifts/:id`.
 *
 * The head is read leniently for the columns a close writes, and the drawer,
 * the movements, the tenders and the sales all decode strictly.
 */
export interface ShiftPage {
  shift: ShiftHead;
  drawer: Drawer;
  movements: CashMovement[];
  tenders: TenderTotal[];
  sales: ShiftSale[];
}

export function shift_page_of(d: Doc): ShiftPage {
  const drawer = decode_or(decode_drawer, object_at(d, "drawer"), "that drawer would not add up");
  const movements = decode_items(
    d,
    "movements",
    decode_cash_movement,
    "that shift has a cash movement we could not read",
  );
  const tenders = decode_items(d, "tenders", decode_tender_total, "that shift's tenders would not read");
  const sales = decode_items(d, "sales", decode_shift_sale, "that shift has a sale we could not read");
  return {
    shift: shift_head_of(doc.field(d, "shift")),
    drawer,
    movements,
    tenders,
    sales,
  };
}

// ---- the day, and the reports behind it -------------------------------------

/**
 * Today's trading.
 *
 * Strict: four COALESCE'd aggregates with no GROUP BY, so the row is always
 * there and always whole. `given_away` is the offers plus the discounts.
 */
export interface TodayTotals {
  sales: number;
  takings: number;
  tax: number;
  given_away: number;
}

const decode_today_totals = decoder<TodayTotals>("TodayTotals", {
  sales: int,
  takings: int,
  tax: int,
  given_away: int,
});

/** What today's sales earned, and what the goods cost. */
export interface MarginTotals {
  net: number;
  cost: number;
}

const decode_margin_totals = decoder<MarginTotals>("MarginTotals", { net: int, cost: int });

/** What is on the shelf, in three figures. */
export interface StockTotals {
  at_cost: number;
  skus: number;
  low: number;
}

const decode_stock_totals = decoder<StockTotals>("StockTotals", { at_cost: int, skus: int, low: int });

/**
 * A lane on the dashboard.
 *
 * Not strict, and not the same shape as [`Lane`]: this is the shorter one the
 * overview draws. `shift_id`, `opening_float`, `opened_at` and `operator` all
 * come off the LEFT JOIN to an open shift and are null together — which is
 * **every lane in a closed shop**. `takings` and `sales` beside them are
 * COALESCE'd subqueries and are 0 rather than null.
 */
export interface OverviewLane {
  id: string;
  name: string;
  kind: string;
  shift_id: string;
  opening_float: number;
  opened_at: number;
  operator: string;
  takings: number;
  sales: number;
}

export function overview_lane_of(d: Doc): OverviewLane {
  return {
    id: doc.text(d, "id", ""),
    name: doc.text(d, "name", ""),
    kind: doc.text(d, "kind", "counter"),
    shift_id: doc.text(d, "shift_id", ""),
    opening_float: doc.int_of(d, "opening_float", 0),
    opened_at: doc.int_of(d, "opened_at", 0),
    operator: doc.text(d, "operator", ""),
    takings: doc.int_of(d, "takings", 0),
    sales: doc.int_of(d, "sales", 0),
  };
}

/**
 * A product that sold well this week.
 *
 * Not strict: `sale_items.product_id` is nullable, so a line whose product has
 * been removed groups under a null and comes back as one. The name is the
 * receipt's snapshot and is always there. `sold` is a SUM over a REAL column —
 * 3.5 kg of something is a legitimate figure.
 */
export interface TopSeller {
  product_id: string;
  name: string;
  sold: number;
  revenue: number;
}

export function top_seller_of(d: Doc): TopSeller {
  return {
    product_id: doc.text(d, "product_id", ""),
    name: doc.text(d, "name", ""),
    sold: doc.num_of(d, "sold", 0.0),
    revenue: doc.int_of(d, "revenue", 0),
  };
}

/**
 * One day of the fortnight strip.
 *
 * Strict. A day with no sales is **absent** rather than zero, because the
 * grouping only sees days that traded.
 */
export interface DayTakings {
  day: string;
  sales: number;
  takings: number;
}

const decode_day_takings = decoder<DayTakings>("DayTakings", { day: str, sales: int, takings: int });

/**
 * The dashboard — `GET /reports/overview`.
 *
 * The three summary objects and the fortnight strip decode strictly, while the
 * lanes and the top sellers are read leniently for the nulls named above.
 *
 * Every window here is fixed at the other end: today is UTC midnight, the top
 * sellers are seven days and the strip is fourteen. There is no `from` to echo.
 */
export interface Overview {
  today: TodayTotals;
  margin: MarginTotals;
  stock: StockTotals;
  lanes: OverviewLane[];
  top_sellers: TopSeller[];
  fortnight: DayTakings[];
}

export function overview_of(d: Doc): Overview {
  const today = decode_or(decode_today_totals, object_at(d, "today"), "today's takings would not read");
  const margin = decode_or(decode_margin_totals, object_at(d, "margin"), "today's margin would not read");
  const stock = decode_or(decode_stock_totals, object_at(d, "stock"), "the stock summary would not read");
  const fortnight = decode_items(d, "fortnight", decode_day_takings, "the fortnight has a day we could not read");
  return {
    today,
    margin,
    stock,
    lanes: doc.items(doc.field(d, "lanes")).map(overview_lane_of),
    top_sellers: doc.items(doc.field(d, "top_sellers")).map(top_seller_of),
    fortnight,
  };
}

/**
 * One day of trading, in full.
 *
 * Strict. Not [`DayTakings`], which is the dashboard's shorter strip: this one
 * carries the tax and what was given away as well.
 */
export interface DailySales {
  day: string;
  sales: number;
  takings: number;
  tax: number;
  given_away: number;
}

const decode_daily_sales = decoder<DailySales>("DailySales", {
  day: str,
  sales: int,
  takings: int,
  tax: int,
  given_away: int,
});

/**
 * One hour of the trading day.
 *
 * Strict. `hour` is 0..23 **in UTC** — `STRFTIME('%H', …)` — and not in the
 * shop's own time, which matters to a shop that is not on UTC.
 */
export interface HourlySales {
  hour: number;
  sales: number;
  takings: number;
}

const decode_hourly_sales = decoder<HourlySales>("HourlySales", { hour: int, sales: int, takings: int });

/** What one person rang up. */
export interface StaffSales {
  name: string;
  sales: number;
  takings: number;
}

const decode_staff_sales = decoder<StaffSales>("StaffSales", { name: str, sales: int, takings: int });

/**
 * Takings by day, hour, tender and person — `GET /reports/sales`.
 *
 * Strict **whole**, the only multi-part answer in this file that is: every
 * column is `NOT NULL` or COALESCE'd, and every group has at least one row. Any
 * of the four lists can be empty, which is not the same as a null.
 *
 * `from` and `to` come back as the Worker resolved them — the defaults are the
 * last thirty days — so a screen can label the window it actually got rather
 * than the one it asked for.
 */
export interface SalesReport {
  from: number;
  to: number;
  daily: DailySales[];
  hourly: HourlySales[];
  tenders: TenderTotal[];
  staff: StaffSales[];
}

export const decode_sales_report = decoder<SalesReport>("SalesReport", {
  from: int,
  to: int,
  daily: list(decode_daily_sales),
  hourly: list(decode_hourly_sales),
  tenders: list(decode_tender_total),
  staff: list(decode_staff_sales),
});

/**
 * A product's sales over a window.
 *
 * Not strict: `product_id` is nullable for the usual reason — a line whose
 * product is gone still sold. `sku` beside it is `NOT NULL DEFAULT ''` and an
 * unknown one is the empty string.
 *
 * `margin` is what the line actually earned: charged, less the tax that was
 * never the shop's, less what the goods cost. It can be negative.
 */
export interface ProductSales {
  product_id: string;
  name: string;
  sku: string;
  sold: number;
  revenue: number;
  tax: number;
  cost: number;
  margin: number;
  promo_saved: number;
}

export function product_sales_of(d: Doc): ProductSales {
  return {
    product_id: doc.text(d, "product_id", ""),
    name: doc.text(d, "name", ""),
    sku: doc.text(d, "sku", ""),
    sold: doc.num_of(d, "sold", 0.0),
    revenue: doc.int_of(d, "revenue", 0),
    tax: doc.int_of(d, "tax", 0),
    cost: doc.int_of(d, "cost", 0),
    margin: doc.int_of(d, "margin", 0),
    promo_saved: doc.int_of(d, "promo_saved", 0),
  };
}

/**
 * A heading's sales over a window.
 *
 * Strict: `category` is COALESCE'd to 'Uncategorised' and is never null.
 */
export interface CategorySales {
  category: string;
  sold: number;
  revenue: number;
  margin: number;
}

const decode_category_sales = decoder<CategorySales>("CategorySales", {
  category: str,
  sold: float,
  revenue: int,
  margin: int,
});

/**
 * What sold, ranked — `GET /reports/products`.
 *
 * The categories decode strictly and the products do not, for the one nullable
 * id. The product list is capped at 200 rows with **no flag in the JSON** to
 * say so; only the CSV export admits when it capped.
 */
export interface ProductReport {
  from: number;
  to: number;
  products: ProductSales[];
  categories: CategorySales[];
}

export function product_report_of(d: Doc): ProductReport {
  const categories = decode_items(
    d,
    "categories",
    decode_category_sales,
    "that report has a heading we could not read",
  );
  return {
    from: doc.int_of(d, "from", 0),
    to: doc.int_of(d, "to", 0),
    products: doc.items(doc.field(d, "products")).map(product_sales_of),
    categories,
  };
}

/**
 * Stock lost, by why it was lost.
 *
 * Strict. `units` is a SUM over a signed REAL column and is **negative** for
 * waste — the sign is what makes it shrinkage rather than a delivery.
 */
export interface ShrinkageReason {
  reason: string;
  movements: number;
  units: number;
  value: number;
}

const decode_shrinkage_reason = decoder<ShrinkageReason>("ShrinkageReason", {
  reason: str,
  movements: int,
  units: float,
  value: int,
});

/** The products the shop lost most on. */
export interface ShrinkageWorst {
  name: string;
  sku: string;
  units: number;
  value: number;
}

const decode_shrinkage_worst = decoder<ShrinkageWorst>("ShrinkageWorst", {
  name: str,
  sku: str,
  units: float,
  value: int,
});

/**
 * Where the shrinkage went — `GET /reports/shrinkage`.
 *
 * Strict whole: two GROUP BYs over `NOT NULL` columns, and a window echoed
 * back as the Worker resolved it.
 */
export interface ShrinkageReport {
  from: number;
  to: number;
  by_reason: ShrinkageReason[];
  worst: ShrinkageWorst[];
}

export const decode_shrinkage_report = decoder<ShrinkageReport>("ShrinkageReport", {
  from: int,
  to: int,
  by_reason: list(decode_shrinkage_reason),
  worst: list(decode_shrinkage_worst),
});

/**
 * Tax collected at one rate.
 *
 * Strict. The grouping is by the rate **as it stood on the line** rather than
 * as the product carries it today, so a rate change cannot re-band a sale that
 * was rung under the old one.
 */
export interface TaxRate {
  tax_bp: number;
  net: number;
  tax: number;
  gross: number;
  sales: number;
}

const decode_tax_rate = decoder<TaxRate>("TaxRate", { tax_bp: int, net: int, tax: int, gross: int, sales: int });

/**
 * What is owed to the revenue office — `GET /reports/tax`.
 *
 * Strict whole. `net` is what the shop earned, `tax` what it is holding, and
 * `gross` what the customer paid; only the middle one is owed, which is why
 * they are three fields rather than one.
 */
export interface TaxReport {
  from: number;
  to: number;
  rates: TaxRate[];
  net: number;
  tax: number;
  gross: number;
}

export const decode_tax_report = decoder<TaxReport>("TaxReport", {
  from: int,
  to: int,
  rates: list(decode_tax_rate),
  net: int,
  tax: int,
  gross: int,
});

/**
 * Something sitting on the shelf not selling.
 *
 * Not strict: `last_sold` is a MAX over a product's completed sales and is
 * **null for anything that has never sold** — which is the most interesting row
 * in the list, so failing on it would be exactly backwards. Read as 0, which
 * the screen already draws as "never".
 */
export interface DeadStockLine {
  id: string;
  sku: string;
  name: string;
  stock: number;
  cost: number;
  at_cost: number;
  last_sold: number;
}

export function dead_stock_line_of(d: Doc): DeadStockLine {
  return {
    id: doc.text(d, "id", ""),
    sku: doc.text(d, "sku", ""),
    name: doc.text(d, "name", ""),
    stock: doc.num_of(d, "stock", 0.0),
    cost: doc.int_of(d, "cost", 0),
    at_cost: doc.int_of(d, "at_cost", 0),
    last_sold: doc.int_of(d, "last_sold", 0),
  };
}

/**
 * What is not moving — `GET /reports/dead-stock`.
 *
 * Not strict, because its lines are not: ranked by what it is worth rather
 * than by how long it has sat, since the decision it feeds is what to discount
 * or send back.
 */
export interface DeadStockReport {
  days: number;
  products: DeadStockLine[];
  at_cost: number;
}

export function dead_stock_report_of(d: Doc): DeadStockReport {
  return {
    days: doc.int_of(d, "days", 60),
    products: doc.items(doc.field(d, "products")).map(dead_stock_line_of),
    at_cost: doc.int_of(d, "at_cost", 0),
  };
}

// ---- the books --------------------------------------------------------------
//
// Nothing in the ledger stores a balance: every figure below is a SUM over
// `journal_lines` for a window, which is why the sheets here cannot disagree
// with one another. They are groupings of one set of rows rather than tallies
// kept in step.

/**
 * One account's balance on a sheet.
 *
 * One type for five lists: the income and expense sides of the profit and
 * loss, and the assets, liabilities and equity of the balance sheet. All five
 * are the same row with the same two figures.
 *
 * Strict: `accounts` has no nullable column, and the LEFT JOIN that finds the
 * activity is wrapped in a COALESCE so an account with none is listed at zero
 * rather than left out.
 *
 * **`balance` and `amount` are not the same number.** `balance` is the raw
 * signed sum — debit positive, credit negative — and is what a group is totted
 * up from. `amount` is the same balance as its own account would state it,
 * positive when normal, and is for showing one line. Adding a column of
 * `amount` up is how a contra-revenue account gets added to income instead of
 * taken off it.
 */
export interface AccountBalance {
  code: string;
  name: string;
  kind: string;
  normal: string;
  balance: number;
  amount: number;
}

const decode_account_balance = decoder<AccountBalance>("AccountBalance", {
  code: str,
  name: str,
  kind: str,
  normal: str,
  balance: int,
  amount: int,
});

/**
 * Profit and loss for a window — `GET /accounting/profit-and-loss`.
 *
 * Strict whole. Revenue is already net of tax when it is posted, because the
 * tax inside a tax-inclusive price was never the shop's money — so gross profit
 * here needs no further adjustment.
 */
export interface ProfitAndLoss {
  from: number;
  to: number;
  income: AccountBalance[];
  expenses: AccountBalance[];
  revenue: number;
  cost_of_sales: number;
  gross_profit: number;
  operating_expenses: number;
  net_profit: number;
}

export const decode_profit_and_loss = decoder<ProfitAndLoss>("ProfitAndLoss", {
  from: int,
  to: int,
  income: list(decode_account_balance),
  expenses: list(decode_account_balance),
  revenue: int,
  cost_of_sales: int,
  gross_profit: int,
  operating_expenses: int,
  net_profit: int,
});

/**
 * The balance sheet as at a date — `GET /accounting/balance-sheet`.
 *
 * Strict whole. Assets and liabilities are cumulative from the beginning of
 * the records whatever window is asked for: a balance sheet is a photograph,
 * not a period. `retained_earnings` is computed rather than posted, which is
 * what lets the sheet balance without a year-end journal nobody has run.
 *
 * `out_by` is zero when the books are sound, and it is on the response rather
 * than hidden because a sheet that does not balance is the most important thing
 * on the page.
 */
export interface BalanceSheet {
  as_at: number;
  assets: AccountBalance[];
  liabilities: AccountBalance[];
  equity: AccountBalance[];
  retained_earnings: number;
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
  out_by: number;
}

export const decode_balance_sheet = decoder<BalanceSheet>("BalanceSheet", {
  as_at: int,
  assets: list(decode_account_balance),
  liabilities: list(decode_account_balance),
  equity: list(decode_account_balance),
  retained_earnings: int,
  total_assets: int,
  total_liabilities: int,
  total_equity: int,
  out_by: int,
});

/**
 * One line of a trial balance.
 *
 * Strict: built in the Worker from a balance that is never null, split into
 * the side it falls on — one of `debit` and `credit` is always 0.
 */
export interface TrialLine {
  code: string;
  name: string;
  kind: string;
  debit: number;
  credit: number;
}

const decode_trial_line = decoder<TrialLine>("TrialLine", { code: str, name: str, kind: str, debit: int, credit: int });

/**
 * The trial balance — `GET /accounting/trial-balance`.
 *
 * Strict whole. Accounts with a zero balance are left out, so an empty window
 * is an empty list rather than a page of noughts.
 */
export interface TrialBalance {
  from: number;
  to: number;
  lines: TrialLine[];
  total_debit: number;
  total_credit: number;
}

export const decode_trial_balance = decoder<TrialBalance>("TrialBalance", {
  from: int,
  to: int,
  lines: list(decode_trial_line),
  total_debit: int,
  total_credit: int,
});

/**
 * An account in the chart.
 *
 * One type for two shapes: `/accounting/accounts` sends `SELECT *` and the
 * ledger's own `account` object sends these four columns only. `sort` is
 * deliberately **not** a field — a strict decoder ignores keys it was not
 * asked for, and leaving it out is what lets one type read both.
 *
 * Strict: every `accounts` column is `NOT NULL`.
 */
export interface Account {
  code: string;
  name: string;
  kind: string;
  normal: string;
}

export const decode_account = decoder<Account>("Account", { code: str, name: str, kind: str, normal: str });

/**
 * An account a running cost may be booked to.
 *
 * Two fields, because that is all `/accounting/expense-accounts` selects — it
 * cannot be read as an [`Account`], which would want a `kind` this endpoint
 * does not send. The 5000-series is withheld at the other end on purpose: those
 * are posted by the machinery, and offering them would double-count.
 */
export interface AccountOption {
  code: string;
  name: string;
}

export const decode_account_option = decoder<AccountOption>("AccountOption", { code: str, name: str });

/**
 * A journal entry's head.
 *
 * Not strict: `corrects_id` and `user_id` are both nullable columns —
 * `corrects_id` is set only on a reversal, which is the *minority* of entries —
 * and `user_name` is a LEFT JOIN on the second of them.
 *
 * `number` is not a column. It is `printf('J-%06d', rowid)`, which is sound
 * only because the table refuses both UPDATE and DELETE, so a row's rowid can
 * never move or be reused.
 */
export interface JournalEntry {
  id: string;
  number: string;
  value_at: number;
  booked_at: number;
  memo: string;
  ref_type: string;
  ref_id: string;
  corrects_id: string;
  user_id: string;
  user_name: string;
}

export function journal_entry_of(d: Doc): JournalEntry {
  return {
    id: doc.text(d, "id", ""),
    number: doc.text(d, "number", ""),
    value_at: doc.int_of(d, "value_at", 0),
    booked_at: doc.int_of(d, "booked_at", 0),
    memo: doc.text(d, "memo", ""),
    ref_type: doc.text(d, "ref_type", ""),
    ref_id: doc.text(d, "ref_id", ""),
    corrects_id: doc.text(d, "corrects_id", ""),
    user_id: doc.text(d, "user_id", ""),
    user_name: doc.text(d, "user_name", ""),
  };
}

/**
 * One leg of a journal entry.
 *
 * Strict: every `journal_lines` column is `NOT NULL` and `account_name` comes
 * from an INNER JOIN on a chart the line cannot reference without.
 *
 * One signed `amount` rather than two columns: debit is positive, credit is
 * negative, and "this entry balances" is `SUM(amount) = 0`.
 */
export interface JournalLine {
  id: string;
  entry_id: string;
  account_code: string;
  account_name: string;
  amount: number;
  memo: string;
}

const decode_journal_line = decoder<JournalLine>("JournalLine", {
  id: str,
  entry_id: str,
  account_code: str,
  account_name: str,
  amount: int,
  memo: str,
});

/**
 * The journal — `GET /accounting/journal`.
 *
 * The entries are read leniently for their two nullable ids, the lines decode
 * strictly.
 *
 * The lines are for **exactly** the entries returned, so an entry is never
 * shown with its legs missing. `total` is what the window holds before the cap
 * and `shown` is what came back, which is how a screen says "200 / 1,842"
 * rather than implying the window held exactly what fitted.
 */
export interface Journal {
  from: number;
  to: number;
  entries: JournalEntry[];
  lines: JournalLine[];
  total: number;
  shown: number;
}

export function journal_of(d: Doc): Journal {
  const lines = decode_items(d, "lines", decode_journal_line, "the journal has a line we could not read");
  return {
    from: doc.int_of(d, "from", 0),
    to: doc.int_of(d, "to", 0),
    entries: doc.items(doc.field(d, "entries")).map(journal_entry_of),
    lines,
    total: doc.int_of(d, "total", 0),
    shown: doc.int_of(d, "shown", 0),
  };
}

/**
 * One movement on an account, with the balance after it.
 *
 * Not strict: `user_name` is a LEFT JOIN on a nullable `user_id`, so anything
 * the machinery posted rather than a person carries null there.
 *
 * `line_memo` is the leg's own note and `memo` is the entry's; the screen shows
 * the first and falls back to the second. `balance` is computed in the Worker
 * as it walks the rows, so it depends on the ordering and is not a column.
 */
export interface LedgerLine {
  entry_id: string;
  number: string;
  value_at: number;
  booked_at: number;
  memo: string;
  line_memo: string;
  ref_type: string;
  ref_id: string;
  user_name: string;
  amount: number;
  balance: number;
}

export function ledger_line_of(d: Doc): LedgerLine {
  return {
    entry_id: doc.text(d, "entry_id", ""),
    number: doc.text(d, "number", ""),
    value_at: doc.int_of(d, "value_at", 0),
    booked_at: doc.int_of(d, "booked_at", 0),
    memo: doc.text(d, "memo", ""),
    line_memo: doc.text(d, "line_memo", ""),
    ref_type: doc.text(d, "ref_type", ""),
    ref_id: doc.text(d, "ref_id", ""),
    user_name: doc.text(d, "user_name", ""),
    amount: doc.int_of(d, "amount", 0),
    balance: doc.int_of(d, "balance", 0),
  };
}

/**
 * One account, movement by movement — `GET /accounting/ledger`.
 *
 * The account decodes strictly and the lines do not.
 *
 * `opening` is everything before the window, summed. Without it a running
 * balance is a running total of an arbitrary slice and means nothing.
 */
export interface Ledger {
  from: number;
  to: number;
  account: Account;
  opening: number;
  lines: LedgerLine[];
  closing: number;
}

export function ledger_of(d: Doc): Ledger {
  const account = decode_or(decode_account, object_at(d, "account"), "that account would not read");
  return {
    from: doc.int_of(d, "from", 0),
    to: doc.int_of(d, "to", 0),
    account,
    opening: doc.int_of(d, "opening", 0),
    lines: doc.items(doc.field(d, "lines")).map(ledger_line_of),
    closing: doc.int_of(d, "closing", 0),
  };
}

/**
 * An entry whose legs do not sum to zero.
 *
 * Strict. `post()` refuses to build one, so anything in this list is asking
 * whether something ever got past `post()`.
 */
export interface Unbalanced {
  id: string;
  memo: string;
  out_by: number;
}

const decode_unbalanced = decoder<Unbalanced>("Unbalanced", { id: str, memo: str, out_by: int });

/**
 * A product whose stock figure has drifted from its own movements.
 *
 * Strict: `products.stock` is a running cache of `stock_movements`, and this
 * is the only thing that has ever checked the cache against what it caches.
 */
export interface StockDrift {
  sku: string;
  name: string;
  stock: number;
  moved: number;
}

const decode_stock_drift = decoder<StockDrift>("StockDrift", { sku: str, name: str, stock: float, moved: float });

/** A sale that completed without being paid for. */
export interface UntenderedSale {
  id: string;
  number: number;
  total: number;
  at: number;
}

const decode_untendered_sale = decoder<UntenderedSale>("UntenderedSale", {
  id: str,
  number: int,
  total: int,
  at: int,
});

/**
 * A customer whose balance has drifted from the rows that should explain it.
 *
 * Strict, and the same idea as [`StockDrift`] one table along:
 * `customers.owed` is a running cache of the tab rows, and this is what checks
 * the cache against what it caches. Unlike the stock pair it is never
 * legitimate — a debt has only one valuation — so any row here is a bug.
 */
export interface TabDrift {
  id: string;
  name: string;
  owed: number;
  derived: number;
}

const decode_tab_drift = decoder<TabDrift>("TabDrift", { id: str, name: str, owed: int, derived: int });

/**
 * Is any of this still true — `GET /accounting/health`.
 *
 * Strict whole, including every nested list: every figure is computed with a
 * COALESCE or a `?? 0` behind it, and the three verdicts are real JSON
 * booleans rather than the 0/1 integers the tables use elsewhere.
 *
 * `stock_gap` is the one line here that is **not** a failure: the shelves are
 * valued at what each product costs today while account 1200 carries what that
 * stock cost when it was bought, and a supplier raising a price must not
 * rewrite history.
 */
export interface Health {
  total_debit: number;
  total_credit: number;
  sides_agree: boolean;
  entries: number;
  unbalanced: Unbalanced[];
  orphan_lines: number;
  equation_holds: boolean;
  out_by: number;
  stock_drift: StockDrift[];
  stock_at_cost: number;
  stock_in_ledger: number;
  stock_gap: number;
  tab_drift: TabDrift[];
  /**
   * Sales marked completed whose payments do not add up to their total.
   *
   * A sale is claimed before the batch that writes what it means, so an
   * aborted batch can leave the row completed with nothing behind it — a
   * basket in every takings figure that the ledger has never heard of. It is
   * always empty; a row here is a bug.
   */
  untendered_sales: UntenderedSale[];
  /**
   * What every customer owes, and what account 1100 says the shop is owed.
   *
   * Shown side by side rather than compared, because the two are allowed to
   * differ for one reason: a shop that gave credit before switching the
   * books on has debts the ledger never saw. `tab_drift` is the check that
   * is not allowed to have rows in it.
   */
  owed_by_customers: number;
  receivable_in_ledger: number;
  healthy: boolean;
}

export const decode_health = decoder<Health>("Health", {
  total_debit: int,
  total_credit: int,
  sides_agree: bool,
  entries: int,
  unbalanced: list(decode_unbalanced),
  orphan_lines: int,
  equation_holds: bool,
  out_by: int,
  stock_drift: list(decode_stock_drift),
  stock_at_cost: int,
  stock_in_ledger: int,
  stock_gap: int,
  tab_drift: list(decode_tab_drift),
  untendered_sales: list(decode_untendered_sale),
  owed_by_customers: int,
  receivable_in_ledger: int,
  healthy: bool,
});

/**
 * A month, open or closed.
 *
 * Not strict: `closed_at` is null for **every open period**, which is what the
 * list is mostly made of, and `closed_by` is a nullable reference beside it.
 * `note` is `NOT NULL DEFAULT ''`.
 */
export interface FiscalPeriod {
  id: string;
  starts_at: number;
  ends_at: number;
  closed_at: number;
  closed_by: string;
  note: string;
}

export function fiscal_period_of(d: Doc): FiscalPeriod {
  return {
    id: doc.text(d, "id", ""),
    starts_at: doc.int_of(d, "starts_at", 0),
    ends_at: doc.int_of(d, "ends_at", 0),
    closed_at: doc.int_of(d, "closed_at", 0),
    closed_by: doc.text(d, "closed_by", ""),
    note: doc.text(d, "note", ""),
  };
}

/**
 * Whether the books are on, and what has been closed — `/accounting/summary`.
 *
 * Not strict, because its periods are not. `enabled` is a real boolean the
 * Worker computes from the `accounting.enabled` setting; until it is true
 * nothing is posted at all, which is what the books screen leads with.
 */
export interface BooksSummary {
  enabled: boolean;
  entries: number;
  periods: FiscalPeriod[];
}

export function books_summary_of(d: Doc): BooksSummary {
  return {
    enabled: doc.bool_of(d, "enabled", false),
    entries: doc.int_of(d, "entries", 0),
    periods: doc.items(doc.field(d, "periods")).map(fiscal_period_of),
  };
}

/**
 * A running cost.
 *
 * Not strict: three LEFT JOINs and a nullable column. `user_id` is nullable,
 * `supplier_id` is nullable, and `user_name`, `account_name` and
 * `supplier_name` are each null when their id is or when the row it pointed at
 * has gone.
 *
 * `tax` is the tax **inside** the amount, not on top of it, so it can never
 * exceed it — the Worker refuses an expense where it does.
 */
export interface Expense {
  id: string;
  category: string;
  payee: string;
  amount: number;
  tax: number;
  method: string;
  account_code: string;
  supplier_id: string;
  reference: string;
  note: string;
  spent_at: number;
  user_id: string;
  created_at: number;
  user_name: string;
  account_name: string;
  supplier_name: string;
}

export function expense_of(d: Doc): Expense {
  return {
    id: doc.text(d, "id", ""),
    category: doc.text(d, "category", ""),
    payee: doc.text(d, "payee", ""),
    amount: doc.int_of(d, "amount", 0),
    tax: doc.int_of(d, "tax", 0),
    method: doc.text(d, "method", "cash"),
    // 6000 Operating expenses is the column's own default and the fallback
    // the Worker writes when a body names no account.
    account_code: doc.text(d, "account_code", "6000"),
    supplier_id: doc.text(d, "supplier_id", ""),
    reference: doc.text(d, "reference", ""),
    note: doc.text(d, "note", ""),
    spent_at: doc.int_of(d, "spent_at", 0),
    user_id: doc.text(d, "user_id", ""),
    created_at: doc.int_of(d, "created_at", 0),
    user_name: doc.text(d, "user_name", ""),
    account_name: doc.text(d, "account_name", ""),
    supplier_name: doc.text(d, "supplier_name", ""),
  };
}

/** What was spent under one of the shopkeeper's own words for it. */
export interface ExpenseCategory {
  category: string;
  count: number;
  amount: number;
}

const decode_expense_category = decoder<ExpenseCategory>("ExpenseCategory", {
  category: str,
  count: int,
  amount: int,
});

/**
 * What was spent against one account.
 *
 * Strict: `account_name` is `COALESCE(a.name, e.account_code)` here — the code
 * stands in for a name that is missing, so it is never null. The profit and
 * loss is built from the account; the category beside it is the shopkeeper's
 * own wording.
 */
export interface ExpenseAccount {
  account_code: string;
  account_name: string;
  count: number;
  amount: number;
  tax: number;
}

const decode_expense_account = decoder<ExpenseAccount>("ExpenseAccount", {
  account_code: str,
  account_name: str,
  count: int,
  amount: int,
  tax: int,
});

/**
 * What was spent in a window, in three figures.
 *
 * Strict: the Worker substitutes a zero-filled object when the aggregate is
 * missing, so this is always whole.
 */
export interface ExpenseTotals {
  amount: number;
  tax: number;
  count: number;
}

const decode_expense_totals = decoder<ExpenseTotals>("ExpenseTotals", { amount: int, tax: int, count: int });

/**
 * Running costs — `GET /accounting/expenses`.
 *
 * The two breakdowns and the totals decode strictly, and the expenses
 * themselves are read leniently for their three joined names.
 */
export interface ExpenseReport {
  from: number;
  to: number;
  expenses: Expense[];
  by_category: ExpenseCategory[];
  by_account: ExpenseAccount[];
  totals: ExpenseTotals;
}

export function expense_report_of(d: Doc): ExpenseReport {
  const by_category = decode_items(
    d,
    "by_category",
    decode_expense_category,
    "the expense categories would not read",
  );
  const by_account = decode_items(d, "by_account", decode_expense_account, "the expense accounts would not read");
  const totals = decode_or(decode_expense_totals, object_at(d, "totals"), "the expense totals would not read");
  return {
    from: doc.int_of(d, "from", 0),
    to: doc.int_of(d, "to", 0),
    expenses: doc.items(doc.field(d, "expenses")).map(expense_of),
    by_category,
    by_account,
    totals,
  };
}

// ---- people, and what is on offer -------------------------------------------

/**
 * Somebody on the staff list.
 *
 * Not strict: `username` is null for sale staff, who sign in with a PIN;
 * `last_seen_at` is null until they have; and `at_lane` is a subquery for a
 * live session and is null whenever they are not signed in anywhere. `active`
 * and `has_pin` are `INTEGER 0/1`, the second of them a
 * `pin_hash IS NOT NULL` test rather than a column.
 *
 * `app` and `signs_in_with` are not columns either — the Worker derives them
 * from the role so that two front ends do not each decide what a role means.
 */
export interface Staff {
  id: string;
  name: string;
  role: string;
  username: string;
  active: boolean;
  created_at: number;
  last_seen_at: number;
  has_pin: boolean;
  at_lane: string;
  app: string;
  signs_in_with: string;
}

export function staff_of(d: Doc): Staff {
  return {
    id: doc.text(d, "id", ""),
    name: doc.text(d, "name", ""),
    role: doc.text(d, "role", "sale_staff"),
    username: doc.text(d, "username", ""),
    active: doc.int_of(d, "active", 1) === 1,
    created_at: doc.int_of(d, "created_at", 0),
    last_seen_at: doc.int_of(d, "last_seen_at", 0),
    has_pin: doc.int_of(d, "has_pin", 0) === 1,
    at_lane: doc.text(d, "at_lane", ""),
    app: doc.text(d, "app", ""),
    signs_in_with: doc.text(d, "signs_in_with", ""),
  };
}

/**
 * What one command costs each role.
 *
 * Strict: four strings the Worker builds from its own command table, so there
 * is no column behind any of them and nothing that can arrive null. This is the
 * same table the till builds its bar from, which is the point of sending it —
 * the back office shows the rules rather than a second copy of them.
 */
export interface CommandRule {
  command: string;
  sale_staff: string;
  manager: string;
  confirm: string;
}

export const decode_command_rule = decoder<CommandRule>("CommandRule", {
  command: str,
  sale_staff: str,
  manager: str,
  confirm: str,
});

/**
 * A customer with their history — `GET /customers`.
 *
 * Not [`Customer`], which is the columns the till's lookup sends. This is
 * `c.*` plus three subqueries.
 *
 * Not strict: `last_seen` is a MAX over completed sales and is **null for
 * somebody who has never bought anything** — which is exactly the row a shop
 * wants to see. `visits` and `spent` beside it are COUNT and COALESCE'd SUM and
 * are never null.
 */
export interface CustomerAccount {
  id: string;
  name: string;
  phone: string;
  points: number;
  /** Store credit the shop owes **them**. The opposite of `owed`. */
  credit: number;
  /** How much they may run up on a tab. Zero, the default, means no tab. */
  credit_limit: number;
  /** Shopping they owe **the shop**. The opposite of `credit`. */
  owed: number;
  note: string;
  created_at: number;
  visits: number;
  spent: number;
  last_seen: number;
}

export function customer_account_of(d: Doc): CustomerAccount {
  return {
    id: doc.text(d, "id", ""),
    name: doc.text(d, "name", ""),
    phone: doc.text(d, "phone", ""),
    points: doc.int_of(d, "points", 0),
    credit: doc.int_of(d, "credit", 0),
    credit_limit: doc.int_of(d, "credit_limit", 0),
    owed: doc.int_of(d, "owed", 0),
    note: doc.text(d, "note", ""),
    created_at: doc.int_of(d, "created_at", 0),
    visits: doc.int_of(d, "visits", 0),
    spent: doc.int_of(d, "spent", 0),
    last_seen: doc.int_of(d, "last_seen", 0),
  };
}

// ---- what customers owe ----------------------------------------------------

/**
 * One customer's debt, banded by how old it is — `GET /customers/receivables`.
 *
 * Strict: every column is a `SUM` over a non-empty group or a `NOT NULL`
 * customer column, and the Worker renames the name to **`customer`** exactly as
 * the supplier aging beside it does.
 *
 * Four bands, not the payables report's five, and the missing one is
 * "current". A supplier invoice has a due date to be inside of; a shop tab has
 * none — somebody said "put it on my account" and the clock started — so every
 * figure here is money the shop is already waiting for and the only question
 * is how long. `d30` is measured from the day the goods left, not from a date
 * anybody agreed.
 */
export interface DebtRow {
  customer_id: string;
  customer: string;
  d30: number;
  d60: number;
  d90: number;
  d90up: number;
  total: number;
}

const decode_debt_row = decoder<DebtRow>("DebtRow", {
  customer_id: str,
  customer: str,
  d30: int,
  d60: int,
  d90: int,
  d90up: int,
  total: int,
});

/** The aging table's foot, and the count of people in it. */
export interface DebtTotals {
  owed: number;
  d30: number;
  d60: number;
  d90: number;
  d90up: number;
  debtors: number;
}

const decode_debt_totals = decoder<DebtTotals>("DebtTotals", {
  owed: int,
  d30: int,
  d60: int,
  d90: int,
  d90up: int,
  debtors: int,
});

/**
 * Everything owed to the shop, banded — the aging half of
 * `GET /customers/receivables`. Strict whole, rows and foot together.
 */
export interface DebtAging {
  rows: DebtRow[];
  totals: DebtTotals;
}

const decode_debt_aging = decoder<DebtAging>("DebtAging", {
  rows: list(decode_debt_row),
  totals: nested(decode_debt_totals),
});

/**
 * Money taken off a tab, as the back office lists it.
 *
 * Not strict: `reference` and `note` are empty rather than null, but
 * `customer` is only joined on the shop-wide list and is absent from the one
 * hanging off a single customer.
 */
export interface TabPayment {
  id: string;
  customer_id: string;
  customer: string;
  method: string;
  total: number;
  note: string;
  taken_by: string;
  created_at: number;
}

export function tab_payment_of(d: Doc): TabPayment {
  return {
    id: doc.text(d, "id", ""),
    customer_id: doc.text(d, "customer_id", ""),
    customer: doc.text(d, "customer", ""),
    method: doc.text(d, "method", "cash"),
    total: doc.int_of(d, "total", 0),
    note: doc.text(d, "note", ""),
    taken_by: doc.text(d, "taken_by", ""),
    created_at: doc.int_of(d, "created_at", 0),
  };
}

/**
 * What the shop is owed — `GET /customers/receivables`.
 *
 * Like [`payables_of`], and for the same reason: the settlements are read
 * leniently while the aging table decodes strictly.
 *
 * The two halves do **not** have the same scope, again as with payables. The
 * aging is summed by the database over every unsettled receipt with no limit.
 */
export interface Receivables {
  aging: DebtAging;
  payments: TabPayment[];
}

export function receivables_of(d: Doc): Receivables {
  const aging = decode_or(decode_debt_aging, object_at(d, "aging"), "the table of what is owed would not read");
  return {
    aging,
    payments: doc.items(doc.field(d, "payments")).map(tab_payment_of),
  };
}

/**
 * An offer.
 *
 * Not strict: four nullable columns and a coded boolean. `product_id` and
 * `category_id` are the scope's target and **exactly one is set** — an offer
 * scoped to everything has both null. `starts_at` and `ends_at` are null on an
 * open-ended offer, one or both. `product_name` and `category_name` are LEFT
 * JOINs on the two ids and go null with them. `active` is an `INTEGER 0/1`.
 *
 * `value` is read against `kind`: basis points for a percentage, minor units
 * for an amount off or a fixed price, and the price of `n` units for a
 * multibuy.
 */
export interface Promotion {
  id: string;
  name: string;
  name_my: string;
  kind: string;
  value: number;
  n: number;
  scope: string;
  product_id: string;
  category_id: string;
  starts_at: number;
  ends_at: number;
  priority: number;
  active: boolean;
  created_at: number;
  product_name: string;
  category_name: string;
}

export function promotion_of(d: Doc): Promotion {
  return {
    id: doc.text(d, "id", ""),
    name: doc.text(d, "name", ""),
    name_my: doc.text(d, "name_my", ""),
    kind: doc.text(d, "kind", ""),
    value: doc.int_of(d, "value", 0),
    n: doc.int_of(d, "n", 0),
    scope: doc.text(d, "scope", "all"),
    product_id: doc.text(d, "product_id", ""),
    category_id: doc.text(d, "category_id", ""),
    starts_at: doc.int_of(d, "starts_at", 0),
    ends_at: doc.int_of(d, "ends_at", 0),
    priority: doc.int_of(d, "priority", 0),
    // Absent means NOT live. `promotions.active` is NOT NULL DEFAULT 1 so
    // this never fires today, but an offer drawn as Running because a
    // field went missing is the harmful direction to guess in.
    active: doc.int_of(d, "active", 0) === 1,
    created_at: doc.int_of(d, "created_at", 0),
    product_name: doc.text(d, "product_name", ""),
    category_name: doc.text(d, "category_name", ""),
  };
}

/**
 * What an offer actually did — `GET /promotions/performance`.
 *
 * Strict: the query filters to lines that carry a promotion, so `promo_id`
 * cannot be null here even though the column is nullable, and `promo_name` is
 * `NOT NULL DEFAULT ''`. `units` is a SUM over a REAL quantity.
 */
export interface PromotionResult {
  promo_id: string;
  promo_name: string;
  lines: number;
  units: number;
  saved: number;
  revenue: number;
}

export const decode_promotion_result = decoder<PromotionResult>("PromotionResult", {
  promo_id: str,
  promo_name: str,
  lines: int,
  units: float,
  saved: int,
  revenue: int,
});

/** Every item of the array under `name` in `d`, decoded strictly. */
export function decode_list<T>(d: Doc, name: string, decode: (v: unknown) => T, context: string): T[] {
  return decode_items(d, name, decode, context);
}

/** One value decoded strictly, with the context a failure needs. */
export function decode_whole<T>(decode: (v: unknown) => T, value: unknown, context: string): T {
  return decode_or(decode, value, context);
}
