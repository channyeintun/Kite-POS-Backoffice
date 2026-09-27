//! Every dialog in the back office, in one file.
//!
//! A form is a value — see `desk.Form` — so this is a list of constructors and
//! nothing else: no document, no requests, no state. `office.tsx` opens one of
//! these when a button is pressed and matches on the same `id` when it is
//! submitted, so what a form *asks for* and what it *does* sit one function
//! apart and cannot drift.
//!
//! Money fields are pre-filled and read back as the shop writes amounts, which
//! for a zero-decimal currency means "18500" and for one with cents "185.00".
//! `money.from_text` is the one place that conversion happens.
//!
//! Every constructor takes the language among the things it is told, because a
//! label, a hint and a dropdown's options are all chrome. What a field is
//! *called* switches; what it holds — a supplier's name, an account code, a
//! barcode — does not.

import * as desk from "./desk.ts";
import * as doc from "./doc.ts";
import type { Doc } from "./doc.ts";
import type { Lang } from "./i18n.ts";
import type * as model from "./model.ts";
import * as money from "./money.ts";
import type { Currency } from "./money.ts";
import * as screens from "./screens.ts";
import * as words from "./words.ts";
import { parse_int } from "./lang.ts";

function text_field(name: string, label: string, value: string): desk.Field {
  return desk.field(name, label, { tag: "OneLine" }, value);
}

function money_field(name: string, label: string, value: number, c: Currency): desk.Field {
  return desk.field(name, label, { tag: "Money" }, money.plain(value, c));
}

function whole_field(name: string, label: string, value: number): desk.Field {
  return desk.field(name, label, { tag: "Whole" }, `${value}`);
}

function qty_field(name: string, label: string, value: number): desk.Field {
  return desk.field(name, label, { tag: "Quantity" }, money.quantity(value));
}

function toggle_field(name: string, label: string, on: boolean, hint: string): desk.Field {
  return desk.hinted(desk.field(name, label, { tag: "Toggle" }, on ? "1" : "0"), hint);
}

function choice_field(name: string, label: string, options: string[], labels: string[], value: string): desk.Field {
  return desk.field(name, label, { tag: "Choice", options, labels }, value);
}

function photo_field(name: string, label: string, key: string): desk.Field {
  return desk.field(name, label, { tag: "Photo" }, key);
}

function readonly_field(name: string, label: string, value: string): desk.Field {
  return desk.field(name, label, { tag: "Readonly" }, value);
}

/**
 * The empty option at the top of a dropdown that may be left unanswered.
 *
 * A phrase rather than a blank line, because a select whose first option is
 * empty looks broken rather than optional.
 */
function none_option(l: Lang): string {
  return words.t(l, "common.none_dash");
}

// ---- what a form is filled with when there is nothing to fill it from -------
//
// An add and an edit are the same form — see [`product`] — so the add is the
// edit of a row that does not exist yet. These are that row. They are here
// rather than in [`model`] because none of them is a shape the server ever
// sends: the values are what a *blank form* should show, and a couple of them
// are deliberately not the column default. A new product is `active`, because
// nobody adds one they are not going to sell; a new offer is a percentage off
// one product, because that is what almost every offer is.

function blank_product(): model.CatalogProduct {
  return {
    id: "",
    sku: "",
    name: "",
    name_my: "",
    category_id: "",
    supplier_id: "",
    cost: 0,
    price: 0,
    tax_bp: 0,
    min_age: 0,
    unit: "each",
    ask_price: false,
    stock: 0.0,
    reorder_point: 0.0,
    reorder_qty: 0.0,
    quick_key: 0,
    photo_key: "",
    active: true,
    created_at: 0,
    updated_at: 0,
    category_name: "",
    supplier_name: "",
  };
}

function blank_category(): model.CatalogCategory {
  return { id: "", name: "", name_my: "", sort: 0, products: 0 };
}

function blank_supplier(): model.Supplier {
  return {
    id: "",
    name: "",
    phone: "",
    email: "",
    address: "",
    // Three days, which is what the server writes when a supplier is created
    // without one — so the form offers what the server would.
    lead_days: 3,
    active: true,
    products: 0,
    owed: 0,
  };
}

function blank_promotion(): model.Promotion {
  return {
    id: "",
    name: "",
    name_my: "",
    kind: "percent_off",
    value: 0,
    n: 0,
    scope: "product",
    product_id: "",
    category_id: "",
    starts_at: 0,
    ends_at: 0,
    priority: 0,
    active: true,
    created_at: 0,
    product_name: "",
    category_name: "",
  };
}

function blank_customer(): model.CustomerAccount {
  return {
    id: "",
    name: "",
    phone: "",
    points: 0,
    credit: 0,
    credit_limit: 0,
    owed: 0,
    note: "",
    created_at: 0,
    visits: 0,
    spent: 0,
    last_seen: 0,
  };
}

function blank_staff(): model.Staff {
  return {
    id: "",
    name: "",
    role: "sale_staff",
    username: "",
    active: true,
    created_at: 0,
    last_seen_at: 0,
    has_pin: false,
    at_lane: "",
    app: "",
    signs_in_with: "",
  };
}

// ---- the catalogue ---------------------------------------------------------

/**
 * Add or edit a product.
 *
 * The same form both ways: an empty `id` means a new one, and the values are
 * whatever the product already had. Two forms would drift the day a column is
 * added, which is the sort of drift a shop notices as "the edit screen has
 * forgotten about age restrictions".
 */
export function product(
  existing: model.CatalogProduct | null,
  id: string,
  categories: model.CatalogCategory[],
  suppliers: model.Supplier[],
  l: Lang,
  c: Currency,
): desk.Form {
  const p = existing ?? blank_product();
  const category_ids: string[] = [""];
  const category_names: string[] = [none_option(l)];
  for (const cat of categories) {
    category_ids.push(cat.id);
    category_names.push(cat.name);
  }
  const supplier_ids: string[] = [""];
  const supplier_names: string[] = [none_option(l)];
  for (const s of suppliers) {
    supplier_ids.push(s.id);
    supplier_names.push(s.name);
  }

  const fields: desk.Field[] = [
    desk.required(text_field("sku", words.t(l, "products.sku"), p.sku)),
    desk.required(text_field("name", words.t(l, "common.name"), p.name)),
    desk.hinted(text_field("name_my", words.t(l, "products.name_my"), p.name_my), words.t(l, "products.name_my_hint")),
    choice_field("category_id", words.t(l, "common.category"), category_ids, category_names, p.category_id),
    choice_field("supplier_id", words.t(l, "common.supplier"), supplier_ids, supplier_names, p.supplier_id),
    desk.hinted(photo_field("photo_key", words.t(l, "products.photo"), p.photo_key), words.t(l, "products.photo_hint")),
    money_field("price", words.t(l, "products.shelf_price"), p.price, c),
    money_field("cost", words.t(l, "common.cost"), p.cost, c),
    desk.hinted(whole_field("tax_bp", words.t(l, "products.tax_bp"), p.tax_bp), words.t(l, "products.tax_bp_hint")),
    desk.hinted(
      whole_field("min_age", words.t(l, "products.minimum_age"), p.min_age),
      words.t(l, "products.min_age_hint"),
    ),
    choice_field(
      "unit",
      words.t(l, "products.sold_by"),
      ["each", "kg", "litre", "pack"],
      [
        words.t(l, "products.unit_each"),
        words.t(l, "products.unit_kilo"),
        words.t(l, "products.unit_litre"),
        words.t(l, "products.unit_pack"),
      ],
      p.unit,
    ),
    toggle_field(
      "ask_price",
      words.t(l, "products.price_at_till"),
      p.ask_price,
      words.t(l, "products.ask_for_a_price_at_the_till"),
    ),
    qty_field("reorder_point", words.t(l, "products.reorder_level"), p.reorder_point),
    qty_field("reorder_qty", words.t(l, "products.reorder_quantity"), p.reorder_qty),
    desk.hinted(
      whole_field("quick_key", words.t(l, "products.favourites_position"), p.quick_key),
      words.t(l, "products.quick_key_hint"),
    ),
    toggle_field("active", words.t(l, "products.for_sale"), p.active, words.t(l, "products.for_sale_hint")),
  ];
  return desk.about(
    desk.form(
      "product",
      id.length > 0 ? words.t(l, "products.edit_product") : words.t(l, "products.add_a_product"),
      words.t(l, "common.save"),
      fields,
    ),
    id,
  );
}

export function barcode(product_id: string, product_name: string, l: Lang): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("barcode", words.t(l, "products.add_a_barcode"), words.t(l, "common.add"), [
        readonly_field("product", words.t(l, "common.product"), product_name),
        desk.required(text_field("barcode", words.t(l, "common.barcode"), "")),
        desk.hinted(qty_field("pack_size", words.t(l, "products.units_per_scan"), 1.0), words.t(l, "products.pack_size_hint")),
        text_field("label", words.t(l, "common.label"), ""),
      ]),
      words.t(l, "products.barcode_lede"),
    ),
    product_id,
  );
}

export function category(existing: model.CatalogCategory | null, id: string, l: Lang): desk.Form {
  const cat = existing ?? blank_category();
  return desk.about(
    desk.form(
      "category",
      id.length > 0 ? words.t(l, "categories.edit_category") : words.t(l, "categories.add_a_category"),
      words.t(l, "common.save"),
      [
        desk.required(text_field("name", words.t(l, "common.name"), cat.name)),
        text_field("name_my", words.t(l, "products.name_my"), cat.name_my),
        whole_field("sort", words.t(l, "categories.position"), cat.sort),
      ],
    ),
    id,
  );
}

export function supplier(existing: model.Supplier | null, id: string, l: Lang): desk.Form {
  const s = existing ?? blank_supplier();
  return desk.about(
    desk.form(
      "supplier",
      id.length > 0 ? words.t(l, "suppliers.edit_supplier") : words.t(l, "suppliers.add_a_supplier"),
      words.t(l, "common.save"),
      [
        desk.required(text_field("name", words.t(l, "common.name"), s.name)),
        text_field("phone", words.t(l, "common.phone"), s.phone),
        text_field("email", words.t(l, "common.email"), s.email),
        desk.field("address", words.t(l, "common.address"), { tag: "Lines" }, s.address),
        desk.hinted(
          whole_field("lead_days", words.t(l, "suppliers.lead_time_days"), s.lead_days),
          words.t(l, "suppliers.lead_days_hint"),
        ),
        toggle_field("active", words.t(l, "suppliers.still_buying_from_them"), s.active, words.t(l, "common.active")),
      ],
    ),
    id,
  );
}

// ---- offers ----------------------------------------------------------------

export function promotion(
  existing: model.Promotion | null,
  id: string,
  products: model.CatalogProduct[],
  categories: model.CatalogCategory[],
  l: Lang,
  c: Currency,
): desk.Form {
  const offer = existing ?? blank_promotion();
  const product_ids: string[] = [""];
  const product_names: string[] = [none_option(l)];
  for (const p of products) {
    product_ids.push(p.id);
    product_names.push(p.name);
  }
  const category_ids: string[] = [""];
  const category_names: string[] = [none_option(l)];
  for (const cat of categories) {
    category_ids.push(cat.id);
    category_names.push(cat.name);
  }

  return desk.about(
    desk.explained(
      desk.form(
        "promotion",
        id.length > 0 ? words.t(l, "promotions.edit_offer") : words.t(l, "promotions.add_an_offer"),
        words.t(l, "common.save"),
        [
          desk.required(text_field("name", words.t(l, "promotions.name_on_the_receipt"), offer.name)),
          text_field("name_my", words.t(l, "products.name_my"), offer.name_my),
          choice_field(
            "kind",
            words.t(l, "common.kind"),
            ["percent_off", "amount_off", "fixed_price", "n_for_x"],
            [
              words.t(l, "promotions.percentage_off"),
              words.t(l, "promotions.amount_off_each"),
              words.t(l, "promotions.fixed_price_each"),
              words.t(l, "promotions.multibuy"),
            ],
            offer.kind,
          ),
          desk.hinted(whole_field("value", words.t(l, "common.value"), offer.value), words.fill(l, "promotions.value_hint", c.code)),
          desk.hinted(whole_field("n", words.t(l, "promotions.buy_how_many"), offer.n), words.t(l, "promotions.n_hint")),
          choice_field(
            "scope",
            words.t(l, "promotions.applies_to"),
            ["product", "category", "all"],
            [
              words.t(l, "promotions.one_product"),
              words.t(l, "promotions.a_whole_category"),
              words.t(l, "promotions.everything"),
            ],
            offer.scope,
          ),
          choice_field("product_id", words.t(l, "common.product"), product_ids, product_names, offer.product_id),
          choice_field("category_id", words.t(l, "common.category"), category_ids, category_names, offer.category_id),
          desk.hinted(
            whole_field("priority", words.t(l, "promotions.priority"), offer.priority),
            words.t(l, "promotions.only_breaks_a_tie_between_equal_offers"),
          ),
          toggle_field("active", words.t(l, "promotions.live"), offer.active, words.t(l, "promotions.running")),
        ],
      ),
      words.t(l, "promotions.offers_do_not_stack"),
    ),
    id,
  );
}

// ---- people ----------------------------------------------------------------

/**
 * A customer, and how far the shop trusts them.
 *
 * `existing` is not optional in practice and the caller must pass it for an
 * edit. Opening the edit dialog blank would write the blanks back on Save —
 * survivable for a name and a phone number somebody could retype, and not for
 * the credit limit: a Save that silently zeroed it would revoke somebody's tab
 * with nobody able to say what changed, and the customer finds out at the
 * counter.
 */
export function customer(existing: model.CustomerAccount | null, id: string, l: Lang, c: Currency): desk.Form {
  const who = existing ?? blank_customer();
  return desk.about(
    desk.form(
      "customer",
      id.length > 0 ? words.t(l, "customers.edit_customer") : words.t(l, "customers.add_a_customer"),
      words.t(l, "common.save"),
      [
        desk.required(text_field("name", words.t(l, "common.name"), who.name)),
        text_field("phone", words.t(l, "common.phone"), who.phone),
        desk.hinted(
          money_field("credit_limit", words.t(l, "receivables.credit_limit"), who.credit_limit, c),
          words.t(l, "receivables.credit_limit_hint"),
        ),
        desk.field("note", words.t(l, "common.note"), { tag: "Lines" }, who.note),
      ],
    ),
    id,
  );
}

/**
 * Money off a tab, taken in the back office.
 *
 * A picker rather than a row action, for the reason [`cancel_invoice`] gives:
 * a `desk.Row` carries one action, and on the customers table that action is
 * *edit*, which is what a shopkeeper reaches for on nearly every row. Only
 * people who actually owe something are offered, because they are the only
 * ones the server will take money for.
 *
 * `key` becomes the form's subject and is sent as the idempotency key. A
 * settlement sent twice takes the money twice, halves the balance, and leaves
 * two rows that both look legitimate. It is minted where the dialog is opened,
 * so pressing Save again after a lost answer sends the key the server already
 * has.
 */
export function settle_tab(l: Lang, people: model.CustomerAccount[], key: string, c: Currency): desk.Form {
  let ids: string[] = [];
  let names: string[] = [];
  for (const cu of people) {
    if (cu.owed > 0) {
      ids.push(cu.id);
      names.push(`${cu.name} · ${money.show(cu.owed, c)}`);
    }
  }
  if (ids.length === 0) {
    ids = [""];
    names = [words.t(l, "receivables.nobody_owes_anything")];
  }
  return desk.about(
    desk.explained(
      desk.form("settle-tab", words.t(l, "receivables.take_a_payment"), words.t(l, "common.save"), [
        desk.required(choice_field("customer_id", words.t(l, "common.customer"), ids, names, ids[0])),
        desk.required(money_field("amount", words.t(l, "receivables.paying"), 0, c)),
        choice_field(
          "method",
          words.t(l, "common.how"),
          ["cash", "card", "wallet"],
          [words.t(l, "common.cash"), words.t(l, "common.card"), words.t(l, "common.wallet")],
          "cash",
        ),
        text_field("note", words.t(l, "common.note"), ""),
      ]),
      words.t(l, "receivables.settlement_lede"),
    ),
    key,
  );
}

export function staff(l: Lang): desk.Form {
  return desk.explained(
    desk.form("staff", words.t(l, "staff.add_staff"), words.t(l, "common.add"), [
      desk.required(text_field("name", words.t(l, "common.name"), "")),
      choice_field(
        "role",
        words.t(l, "staff.role"),
        ["sale_staff", "manager", "owner"],
        [words.t(l, "staff.role_sale_staff_option"), words.t(l, "staff.role_manager_option"), words.t(l, "staff.owner")],
        "sale_staff",
      ),
      desk.hinted(text_field("pin", words.t(l, "staff.pin"), ""), words.t(l, "staff.pin_hint")),
      desk.hinted(text_field("username", words.t(l, "common.username"), ""), words.t(l, "staff.username_hint")),
      desk.field("password", words.t(l, "common.password"), { tag: "Password" }, ""),
    ]),
    words.t(l, "staff.a_role_decides_which_app"),
  );
}

export function staff_pin(id: string, name: string, l: Lang): desk.Form {
  return desk.about(
    desk.form("staff-pin", words.t(l, "staff.set_a_pin"), words.t(l, "register.set"), [
      readonly_field("who", words.t(l, "common.staff"), name),
      desk.required(text_field("pin", words.t(l, "staff.new_pin"), "")),
    ]),
    id,
  );
}

export function staff_password(id: string, name: string, l: Lang): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("staff-password", words.t(l, "staff.set_a_password"), words.t(l, "register.set"), [
        readonly_field("who", words.t(l, "common.staff"), name),
        desk.required(desk.field("password", words.t(l, "staff.new_password"), { tag: "Password" }, "")),
      ]),
      words.t(l, "staff.password_lede"),
    ),
    id,
  );
}

export function staff_edit(existing: model.Staff | null, id: string, l: Lang): desk.Form {
  const who = existing ?? blank_staff();
  return desk.about(
    desk.form("staff-edit", words.t(l, "staff.edit_staff"), words.t(l, "common.save"), [
      desk.required(text_field("name", words.t(l, "common.name"), who.name)),
      toggle_field("active", words.t(l, "common.active"), who.active, words.t(l, "staff.deactivating_hint")),
    ]),
    id,
  );
}

// ---- stock and buying ------------------------------------------------------

export function adjust(product_id: string, name: string, stock: number, l: Lang): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("adjust", words.t(l, "inventory.adjust_stock"), words.t(l, "register.apply"), [
        readonly_field("product", words.t(l, "common.product"), name),
        readonly_field("was", words.t(l, "inventory.the_computer_thinks"), money.quantity(stock)),
        desk.required(qty_field("counted", words.t(l, "common.counted"), stock)),
        choice_field(
          "reason",
          words.t(l, "common.because"),
          ["count", "waste", "adjust"],
          [
            words.t(l, "inventory.a_stock_count"),
            words.t(l, "inventory.waste_or_breakage"),
            words.t(l, "inventory.a_correction"),
          ],
          "count",
        ),
        text_field("note", words.t(l, "common.note"), ""),
      ]),
      words.t(l, "inventory.adjust_lede"),
    ),
    product_id,
  );
}

export function receive(
  item_id: string,
  name: string,
  outstanding: number,
  unit_cost: number,
  l: Lang,
  c: Currency,
): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("receive", words.t(l, "purchase_order.receive"), words.t(l, "purchase_order.receive"), [
        readonly_field("product", words.t(l, "common.product"), name),
        readonly_field("outstanding", words.t(l, "purchase_order.still_expected"), money.quantity(outstanding)),
        desk.required(qty_field("qty", words.t(l, "purchase_order.arrived"), outstanding)),
        money_field("unit_cost", words.t(l, "purchase_order.cost_each"), unit_cost, c),
      ]),
      words.t(l, "purchase_order.receive_lede"),
    ),
    item_id,
  );
}

export function invoice(
  supplier_ids: string[],
  supplier_names: string[],
  po_id: string,
  supplier_id: string,
  total: number,
  key: string,
  l: Lang,
  c: Currency,
): desk.Form {
  return desk.keyed(
    desk.about(
      desk.explained(
        desk.form("invoice", words.t(l, "payables.record_an_invoice"), words.t(l, "shifts.record"), [
          choice_field("supplier_id", words.t(l, "common.supplier"), supplier_ids, supplier_names, supplier_id),
          text_field("reference", words.t(l, "payables.their_reference"), ""),
          money_field("total", words.t(l, "common.total"), total, c),
          desk.hinted(whole_field("due_days", words.t(l, "payables.due_in_days"), 30), words.t(l, "payables.due_days_hint")),
        ]),
        words.t(l, "payables.invoice_lede"),
      ),
      po_id,
    ),
    key,
  );
}

export function pay_invoice(
  id: string,
  supplier_name: string,
  outstanding: number,
  key: string,
  l: Lang,
  c: Currency,
): desk.Form {
  return desk.keyed(
    desk.about(
      desk.form("pay-invoice", words.t(l, "payables.pay_supplier"), words.t(l, "common.pay"), [
        readonly_field("supplier", words.t(l, "common.supplier"), supplier_name),
        readonly_field("outstanding", words.t(l, "common.outstanding"), money.show(outstanding, c)),
        desk.required(money_field("amount", words.t(l, "payables.paying"), outstanding, c)),
        choice_field(
          "method",
          words.t(l, "common.how"),
          ["cash", "card", "wallet"],
          [words.t(l, "common.cash"), words.t(l, "common.card"), words.t(l, "common.wallet")],
          "cash",
        ),
      ]),
      id,
    ),
    key,
  );
}

export function expense(accounts: model.AccountOption[], l: Lang, c: Currency): desk.Form {
  let codes: string[] = [];
  let names: string[] = [];
  for (const a of accounts) {
    codes.push(a.code);
    names.push(`${a.code} ${a.name}`);
  }
  // An account's code and name come from the chart of accounts, which is the
  // shop's own data — so the fallback is the account the ledger ships with
  // rather than a phrase, and it reads the same in both languages.
  if (codes.length === 0) {
    codes = ["6000"];
    names = ["6000 Operating expenses"];
  }
  return desk.explained(
    desk.form("expense", words.t(l, "expenses.record_an_expense"), words.t(l, "shifts.record"), [
      desk.hinted(
        choice_field("account_code", words.t(l, "expenses.what_kind_of_cost"), codes, names, "6000"),
        words.t(l, "expenses.account_hint"),
      ),
      desk.required(text_field("category", words.t(l, "expenses.what_for"), "")),
      text_field("payee", words.t(l, "expenses.paid_to"), ""),
      text_field("reference", words.t(l, "common.reference"), ""),
      desk.required(money_field("amount", words.t(l, "common.amount"), 0, c)),
      desk.hinted(money_field("tax", words.t(l, "common.tax_included"), 0, c), words.t(l, "expenses.tax_hint")),
      choice_field(
        "method",
        words.t(l, "common.how"),
        ["cash", "card", "wallet", "on_account"],
        [
          words.t(l, "expenses.cash_from_the_safe"),
          words.t(l, "common.card"),
          words.t(l, "common.wallet"),
          words.t(l, "expenses.on_account_the_shop_owes_it"),
        ],
        "cash",
      ),
      text_field("note", words.t(l, "common.note"), ""),
    ]),
    words.t(l, "expenses.expense_lede"),
  );
}

// ---- lanes and drawers -----------------------------------------------------

export function open_shift(register_ids: string[], register_names: string[], l: Lang, c: Currency): desk.Form {
  return desk.form("open-shift", words.t(l, "shifts.open_a_drawer"), words.t(l, "common.open"), [
    choice_field("register_id", words.t(l, "common.lane"), register_ids, register_names, register_ids[0] ?? ""),
    desk.required(money_field("opening_float", words.t(l, "shifts.counted_float"), 0, c)),
  ]);
}

export function close_shift(id: string, lane: string, expected: number, l: Lang, c: Currency): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("close-shift", words.t(l, "shifts.count_and_close"), words.t(l, "common.close"), [
        readonly_field("lane", words.t(l, "common.lane"), lane),
        readonly_field("expected", words.t(l, "shifts.the_books_expect"), money.show(expected, c)),
        desk.required(money_field("counted_total", words.t(l, "common.counted"), expected, c)),
        text_field("note", words.t(l, "common.note"), ""),
      ]),
      words.t(l, "shifts.close_lede"),
    ),
    id,
  );
}

export function movement(shift_id: string, l: Lang, c: Currency): desk.Form {
  return desk.about(
    desk.form("movement", words.t(l, "shifts.cash_in_or_out"), words.t(l, "shifts.record"), [
      choice_field(
        "kind",
        words.t(l, "inventory.what_happened"),
        ["paid_in", "paid_out", "safe_drop"],
        [words.t(l, "shifts.paid_in_option"), words.t(l, "shifts.paid_out_option"), words.t(l, "shifts.safe_drop_option")],
        "paid_in",
      ),
      desk.required(money_field("amount", words.t(l, "common.amount"), 0, c)),
      desk.required(text_field("reason", words.t(l, "common.why"), "")),
    ]),
    shift_id,
  );
}

export function register(l: Lang): desk.Form {
  return desk.form("register", words.t(l, "tills.add_a_lane"), words.t(l, "common.add"), [
    desk.required(text_field("name", words.t(l, "common.name"), "")),
    choice_field(
      "kind",
      words.t(l, "common.kind"),
      ["counter", "handheld"],
      [words.t(l, "tills.counter_tablet"), words.t(l, "tills.handheld")],
      "counter",
    ),
  ]);
}

// ---- selling ---------------------------------------------------------------

export function refund(sale_id: string, number: number, lines: model.SaleLine[], l: Lang, c: Currency): desk.Form {
  const fields: desk.Field[] = [readonly_field("receipt", words.t(l, "common.receipt"), `#${number}`)];
  for (const line of lines) {
    const left = line.qty - line.refunded_qty;
    if (left <= 0.0) {
      continue;
    }
    fields.push(
      desk.hinted(
        desk.field(`line:${line.id}`, line.name, { tag: "Quantity" }, "0"),
        `${words.fill(l, "sales.up_to_n", money.quantity(left))} · ${money.show(line.total, c)}`,
      ),
    );
  }
  fields.push(desk.required(text_field("reason", words.t(l, "common.why"), "")));
  fields.push(
    choice_field(
      "method",
      words.t(l, "sales.refund_to"),
      ["cash", "card", "wallet", "store_credit"],
      [words.t(l, "common.cash"), words.t(l, "common.card"), words.t(l, "common.wallet"), words.t(l, "common.store_credit")],
      "cash",
    ),
  );
  fields.push(toggle_field("restock", words.t(l, "sales.put_the_items_back_into_stock"), true, words.t(l, "sales.restock")));
  return desk.about(
    desk.explained(desk.form("refund", words.t(l, "sales.refund"), words.t(l, "sales.refund"), fields), words.t(l, "sales.refund_lede")),
    sale_id,
  );
}

// ---- the shop ---------------------------------------------------------------

export function settings(current: Doc, l: Lang): desk.Form {
  return desk.explained(
    desk.form("settings", words.t(l, "common.settings"), words.t(l, "common.save"), [
      text_field("shop.name", words.t(l, "settings.shop_name"), doc.text(current, "shop.name", "")),
      text_field("shop.name_my", words.t(l, "settings.shop_name_my"), doc.text(current, "shop.name_my", "")),
      desk.field("shop.address", words.t(l, "common.address"), { tag: "Lines" }, doc.text(current, "shop.address", "")),
      text_field("shop.phone", words.t(l, "common.phone"), doc.text(current, "shop.phone", "")),
      text_field("shop.tax_id", words.t(l, "common.tax_id"), doc.text(current, "shop.tax_id", "")),
      text_field("shop.receipt_footer", words.t(l, "settings.receipt_footer"), doc.text(current, "shop.receipt_footer", "")),
      text_field("currency.code", words.t(l, "settings.currency"), doc.text(current, "currency.code", "MMK")),
      text_field("currency.symbol", words.t(l, "settings.symbol"), doc.text(current, "currency.symbol", "K")),
      desk.hinted(
        text_field("currency.minor_units", words.t(l, "settings.decimal_places"), doc.text(current, "currency.minor_units", "0")),
        words.t(l, "settings.minor_units_hint"),
      ),
      choice_field(
        "currency.symbol_first",
        words.t(l, "settings.symbol_goes"),
        ["1", "0"],
        [words.t(l, "settings.before_the_number"), words.t(l, "settings.after_the_number")],
        doc.text(current, "currency.symbol_first", "1"),
      ),
      choice_field(
        "tax.inclusive",
        words.t(l, "settings.shelf_prices"),
        ["1", "0"],
        [words.t(l, "settings.include_tax"), words.t(l, "settings.exclude_tax")],
        doc.text(current, "tax.inclusive", "1"),
      ),
      whole_field(
        "tax.default_bp",
        words.t(l, "settings.default_tax_bp"),
        parse_int(doc.text(current, "tax.default_bp", "0")) ?? 0,
      ),
      // The two language names stay in their own scripts, the way a language
      // picker anywhere does: somebody who cannot read the current one still
      // has to be able to find the other.
      choice_field(
        "locale.default",
        words.t(l, "settings.language"),
        ["en", "my"],
        ["English", "မြန်မာ"],
        doc.text(current, "locale.default", "en"),
      ),
      text_field(
        "loyalty.points_per_unit",
        words.t(l, "settings.loyalty_points_per_unit"),
        doc.text(current, "loyalty.points_per_unit", "0"),
      ),
      choice_field(
        "accounting.enabled",
        words.t(l, "common.accounting"),
        ["0", "1"],
        [words.t(l, "settings.off"), words.t(l, "settings.on_post_every_sale")],
        doc.text(current, "accounting.enabled", "0"),
      ),
    ]),
    words.t(l, "settings.settings_lede"),
  );
}

/**
 * Cancel an invoice that should never have been raised.
 *
 * A picker rather than a row action: a `desk.Row` carries one action, and on
 * the payables table that action is *pay* — which is what a shopkeeper wants
 * on nearly every row. Swapping it for cancel would put the destructive one
 * under the finger that reaches for the common one.
 *
 * Only invoices with nothing paid against them are offered, because that is
 * the only case the server will accept: once money has moved, unwinding it is
 * a credit note rather than a cancellation.
 */
export function cancel_invoice(l: Lang, invoices: model.Invoice[], c: Currency): desk.Form {
  let ids: string[] = [];
  let names: string[] = [];
  for (const i of invoices) {
    if (i.paid === 0 && i.outstanding > 0) {
      ids.push(i.id);
      names.push(`${i.supplier_name} · ${i.reference.length > 0 ? i.reference : "—"} · ${money.show(i.total, c)}`);
    }
  }
  if (ids.length === 0) {
    ids = [""];
    names = [words.t(l, "payables.nothing_outstanding")];
  }
  return desk.explained(
    desk.form("cancel-invoice", words.t(l, "payables.cancel_invoice"), words.t(l, "common.cancel"), [
      desk.required(choice_field("invoice_id", words.t(l, "payables.invoice"), ids, names, ids[0])),
      desk.required(text_field("reason", words.t(l, "common.why"), "")),
    ]),
    words.t(l, "payables.cancelling_reverses_the_accrual"),
  );
}

/**
 * Remove a category.
 *
 * A picker, and only of the empty ones — for the same reason the invoice
 * cancel is a picker: a `desk.Row` carries one action, and on the categories
 * table that action is *edit*, which is what a shopkeeper reaches for far more
 * often than remove.
 */
export function remove_category(l: Lang, categories: model.CatalogCategory[]): desk.Form {
  let ids: string[] = [];
  let names: string[] = [];
  for (const cat of categories) {
    if (cat.products === 0) {
      ids.push(cat.id);
      names.push(cat.name);
    }
  }
  if (ids.length === 0) {
    ids = [""];
    names = [words.t(l, "categories.nothing_empty")];
  }
  return desk.explained(
    desk.form("remove-category", words.t(l, "categories.remove_a_category"), words.t(l, "common.remove"), [
      desk.required(choice_field("category_id", words.t(l, "common.category"), ids, names, ids[0])),
    ]),
    words.t(l, "categories.only_empty_can_go"),
  );
}

/**
 * Switching the books on in a shop that has already been trading.
 *
 * Stock is not asked for: it is what the catalogue already says is on the
 * shelf, at what each product cost. Asking again would invite a figure that
 * disagrees with the stock the till is about to sell from. Only the cash is
 * typed, because nothing in the system knows it.
 */
export function opening_balances(l: Lang, c: Currency): desk.Form {
  return desk.explained(
    desk.form("opening-balances", words.t(l, "accounting.opening_balances"), words.t(l, "accounting.post_the_opening"), [
      money_field("cash_in_safe", words.t(l, "accounting.cash_in_the_safe"), 0, c),
      money_field("cash_in_drawer", words.t(l, "accounting.cash_in_the_drawer"), 0, c),
    ]),
    words.t(l, "accounting.stock_is_taken_from_the_catalogue"),
  );
}

/** Narrowing the journal. */
export function journal_filter(l: Lang, ref_type: string, code: string, q: string, accounts: model.Account[]): desk.Form {
  const codes: string[] = [""];
  const names: string[] = [words.t(l, "accounting.any_account")];
  for (const a of accounts) {
    codes.push(a.code);
    names.push(`${a.code} ${a.name}`);
  }
  // The same list the journal renders, named the same way — one mapper, so a
  // filter can never offer a word the table does not use.
  const kinds: string[] = [
    "",
    "sale",
    "refund",
    "shift",
    "cash_movement",
    "expense",
    "stock_movement",
    "supplier_invoice",
    "supplier_payment",
    "purchase_order",
    "opening",
  ];
  const kind_names: string[] = kinds.map((k) =>
    k.length === 0 ? words.t(l, "accounting.caused_by_anything") : screens.caused_by_of(l, k),
  );
  return desk.explained(
    desk.form("journal-filter", words.t(l, "accounting.filter_the_journal"), words.t(l, "register.apply"), [
      choice_field("ref_type", words.t(l, "accounting.caused_by"), kinds, kind_names, ref_type),
      choice_field("account_code", words.t(l, "common.account"), codes, names, code),
      text_field("q", words.t(l, "accounting.search_memo_or_number"), q),
    ]),
    words.t(l, "accounting.every_figure_is_summed_from_the_journal"),
  );
}

export function close_period(l: Lang): desk.Form {
  return desk.explained(
    desk.form("close-period", words.t(l, "accounting.close_a_month"), words.t(l, "common.close"), [
      desk.required(text_field("month", words.t(l, "common.month"), "")),
    ]),
    words.t(l, "accounting.close_period_lede"),
  );
}

/**
 * Undo a posting, by posting its opposite.
 *
 * Not an edit — there is no edit. The reversal is a second entry linked to
 * the first, dated today, and both stay in the journal, so a reader sees what
 * happened *and* that it was undone. The reason is required because a
 * correction with no explanation is the thing an auditor asks about.
 */
export function reverse_entry(id: string, l: Lang): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("reverse-entry", words.t(l, "accounting.correct_this_entry"), words.t(l, "accounting.post_the_correction"), [
        desk.required(text_field("reason", words.t(l, "common.why"), "")),
      ]),
      words.t(l, "accounting.reverse_entry_lede"),
    ),
    id,
  );
}

// ---- goods in --------------------------------------------------------------
//
// A delivery booked straight into stock. Three forms rather than one, because
// a delivery has a variable number of lines and a `desk.Form` has a fixed list
// of fields: lines are added one at a time into `desk.App.goods_in`, which
// costs no request, and the last form is the one press that writes the lot.

/**
 * One line of a delivery: what arrived, how many, and what it cost.
 *
 * The cost is pre-filled from the product's current cost price, because most
 * deliveries are at the price the last one was — and the one that is not is
 * the one a shopkeeper wants to type, not read.
 */
export function goods_in_line(products: model.CatalogProduct[], l: Lang, c: Currency): desk.Form {
  let ids: string[] = [];
  let names: string[] = [];
  let cost = 0;
  for (const p of products) {
    if (p.active) {
      ids.push(p.id);
      names.push(`${p.name} · ${p.sku}`);
    }
  }
  if (ids.length === 0) {
    ids = [""];
    names = [words.t(l, "products.no_products_match")];
  } else {
    // The cost of the product the list opens on — and it follows the chooser
    // from there: `changed` in `office.tsx` rewrites this field whenever the
    // product does. Pre-filled once and left, an operator who picked the
    // second row would see the first row's cost sitting under it, and that
    // number is written onto `products.cost`.
    for (const p of products) {
      if (p.id === ids[0]) {
        cost = p.cost;
      }
    }
  }
  return desk.explained(
    desk.form("goods-in-line", words.t(l, "purchasing.add_a_line"), words.t(l, "common.add"), [
      desk.required(choice_field("product_id", words.t(l, "purchasing.which_product"), ids, names, ids[0])),
      desk.required(qty_field("qty", words.t(l, "purchasing.qty_arrived"), 1.0)),
      desk.required(
        desk.hinted(money_field("unit_cost", words.t(l, "purchasing.cost_each"), cost, c), words.t(l, "purchasing.cost_each_hint")),
      ),
      // Empty, and meant to be left empty for nearly every delivery. Not
      // pre-filled with the current price: a figure sitting in the box would
      // be sent, and would queue a "new" price that is the old one.
      desk.hinted(
        desk.blank_allowed(desk.field("new_price", words.t(l, "purchasing.new_sell_price"), { tag: "Money" }, "")),
        words.t(l, "purchasing.new_sell_price_hint"),
      ),
      // Off by default: the shelf sells out at the price it was bought to
      // sell at, and the operator has to say otherwise.
      toggle_field("price_now", words.t(l, "purchasing.price_now"), false, words.t(l, "purchasing.price_now_hint")),
    ]),
    words.t(l, "purchasing.goods_in_lede"),
  );
}

/**
 * The press that writes the delivery.
 *
 * `subject` carries the key minted when the first line was added, so tapping
 * this four times on a bad line books one delivery — see `desk.goods_in_add`
 * and the `client_id` the Worker reads.
 */
export function goods_in_book(
  suppliers: model.Supplier[],
  key: string,
  supplier_id: string,
  settlement: string,
  total: number,
  l: Lang,
  c: Currency,
): desk.Form {
  // **The shop itself comes first.**
  //
  // Most of what a corner shop buys is not ordered from anybody: the owner
  // walks to the market with notes in their pocket and carries the cases
  // back. `sup_cash` is the supplier the shop is given for exactly that, so
  // that run is add the lines, say cash, book it — and nobody has to invent a
  // wholesaler to record their own shopping. Hoisted by id rather than by
  // name, because the name is the shopkeeper's to change.
  let ids: string[] = [];
  let names: string[] = [];
  for (const s of suppliers) {
    if (s.active && s.id === "sup_cash") {
      ids.push(s.id);
      names.push(s.name);
    }
  }
  for (const s of suppliers) {
    if (s.active && s.id !== "sup_cash") {
      ids.push(s.id);
      names.push(s.name);
    }
  }
  if (ids.length === 0) {
    ids = [""];
    names = [words.t(l, "common.none_dash")];
  }
  let chosen = supplier_id;
  if (chosen.length === 0) {
    chosen = ids[0];
  }
  return desk.about(
    desk.explained(
      desk.form("goods-in-book", words.t(l, "purchasing.book_a_delivery"), words.t(l, "purchasing.book_it_into_stock"), [
        readonly_field("value", words.t(l, "common.total"), money.show(total, c)),
        desk.required(choice_field("supplier_id", words.t(l, "common.supplier"), ids, names, chosen)),
        desk.hinted(
          choice_field(
            "settlement",
            words.t(l, "purchasing.how_it_is_paid"),
            ["cash", "card", "wallet", "on_account"],
            [
              words.t(l, "purchasing.paid_cash"),
              words.t(l, "purchasing.paid_card"),
              words.t(l, "purchasing.paid_wallet"),
              words.t(l, "purchasing.paid_on_account"),
            ],
            settlement,
          ),
          words.t(l, "purchasing.settlement_hint"),
        ),
        text_field("reference", words.t(l, "purchasing.delivery_note"), ""),
        text_field("note", words.t(l, "purchasing.anything_the_supplier_should_know"), ""),
      ]),
      words.t(l, "purchasing.goods_in_lede"),
    ),
    key,
  );
}

/**
 * A draft nobody wants, removed.
 *
 * A confirmation rather than a bare press, and not only so it can be thought
 * about: a form carries the in-flight guard that a plain press does not.
 */
export function delete_order(id: string, number: number, l: Lang): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("delete-order", words.t(l, "purchasing.delete_draft"), words.t(l, "purchasing.delete_draft_confirm"), [
        readonly_field("order", words.t(l, "nav.purchase_order"), words.fill(l, "purchase_order.order_n", `${number}`)),
      ]),
      words.t(l, "purchasing.delete_draft_lede"),
    ),
    id,
  );
}

/** An order the supplier was told about, withdrawn — with the reason on it. */
export function cancel_order(id: string, number: number, l: Lang): desk.Form {
  return desk.about(
    desk.explained(
      desk.form("cancel-order", words.t(l, "purchasing.cancel_this_order"), words.t(l, "purchase_order.cancel_order"), [
        readonly_field("order", words.t(l, "nav.purchase_order"), words.fill(l, "purchase_order.order_n", `${number}`)),
        desk.required(text_field("reason", words.t(l, "purchasing.why_cancelled"), "")),
      ]),
      words.t(l, "purchasing.cancel_order_lede"),
    ),
    id,
  );
}
