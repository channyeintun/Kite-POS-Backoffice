//! Talking to the Worker.
//!
//! Every call either answers or throws, and what it throws is an `Error` whose
//! message is a sentence an operator can act on. What is *not* collapsed into
//! that error is a refusal the till has to act on: a 422 asking for ID or for a
//! price is a normal step in ringing a sale, not a failure, so it comes back as
//! an [`Answer`] — a union whose variants *are* the branches, rather than a
//! document the caller has to fish a `needs` string out of.
//!
//! There is no client object. A [`model.Session`] carries the token and is
//! passed in; a signed-out call takes nothing, because there is no session yet
//! by definition.
//!
//! ## What a call answers
//!
//! Every endpoint that answers something [`model`] has a name for returns the
//! named thing. The conversion happens **once, here** — a screen is handed a
//! value with fields, not a document it has to know the key names of, and the
//! decision about which of those fields may arrive null was taken in
//! [`model`] against the schema rather than guessed at a call site.
//!
//! The till's two-answer family — `scan`, `set_qty`, `void_line`,
//! `adjust_line`, `hold`, `recall`, `void_sale` and `set_customer` — each
//! answers *either* a basket *or* a 422 `needs` document, so all eight answer
//! [`Answer`], and the deciding is done once, in `answer_of`. (`basket` has no
//! 422 at all, so it stays a plain [`model.Basket`].)
//!
//! Three kinds of answer still stay a document, and each for its own reason:
//!
//!   * **The transport itself.** `send`, `get`, `post`, `patch` and `remove`
//!     cannot know what shape a body is, exactly as `JSON.parse` cannot.
//!   * **`/settings`.** A key→value map of setting names, every value optional
//!     with a per-key default. A type would encode the Worker's allow list a
//!     second time and no field of it could derive.
//!   * **Writes whose answer nobody reads**, and the two whose answer has no
//!     shape in [`model`] — a refund's `{ id, total, tax }`, and the
//!     `{ ok: true }` that every edit and every delete replies with. A `PATCH`
//!     and a `POST` to the same `save_*` do not even answer alike: the one
//!     sends `{ ok: true }` and the other `{ id }`, so a decoder strict enough
//!     to be worth having would refuse half its own call sites.

import * as doc from "./doc.ts";
import type { Doc } from "./doc.ts";
import * as model from "./model.ts";
import { wrap } from "./model.ts";
import * as browser from "./browser.ts";

/** A request body: a JSON object, built by the caller from its own fields. */
export type Body = Record<string, unknown>;

/**
 * Where the API lives.
 *
 * Read from a `<meta name="api-base">` in the page, defaulting to a
 * same-origin `/api`. In development Vite proxies that to the Worker on 8787;
 * in production the meta names the deployed Worker, because the till is on
 * Pages and the API is not. Putting it in the HTML means the same build
 * artefacts deploy to a test shop and a real one.
 */
export function base(): string {
  const kept = browser.meta("api-base");
  if (kept.length > 0) {
    return kept;
  }
  return "/api";
}

function headers_for(token: string, body: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body.length > 0) {
    headers["content-type"] = "application/json";
  }
  if (token.length > 0) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

interface Response {
  status: number;
  body: string;
}

/**
 * One exchange with the network. A request that never got an answer throws,
 * naming the method and the address; one that did get an answer — any answer
 * — is handed back whole for the caller to judge.
 */
async function transport(method: string, url: string, body: string, headers: Record<string, string>): Promise<Response> {
  const init: RequestInit = { method, headers, credentials: "same-origin", redirect: "follow" };
  if (body !== "") {
    init.body = body;
  }
  try {
    const response = await fetch(url, init);
    return { status: response.status, body: await response.text() };
  } catch (e) {
    const detail = e instanceof Error && e.message ? e.message : String(e);
    throw new Error(`http ${method} ${url}: ${detail}`);
  }
}

function succeeded(r: Response): boolean {
  return r.status >= 200 && r.status < 300;
}

/**
 * What a status means, in words an operator can act on.
 *
 * The number is not the cashier's business, and the difference between a 401
 * and a 429 is the difference between "sign in again" and "wait a moment".
 */
function refused(status: number, body: string): Error {
  const parsed = parse_message(body);
  // The server's own sentence beats every one of these: it is a precedence
  // rule, not a row.
  if (parsed.length > 0) {
    return new Error(parsed);
  }
  if (status === 401) {
    return new Error("that session has ended — sign in again");
  }
  if (status === 403) {
    return new Error("that needs a manager");
  }
  if (status === 404) {
    return new Error("that is not here");
  }
  if (status === 429) {
    return new Error("too many tries — wait a moment");
  }
  if (status >= 500) {
    return new Error(`the shop's server is having trouble (${status})`);
  }
  return new Error(`that did not go through (${status})`);
}

/** The sentence the server put in the body, if it put one there. */
function parse_message(body: string): string {
  let parsed: Doc;
  try {
    parsed = doc.parse(body);
  } catch {
    return "";
  }
  return doc.text(doc.field(parsed, "error"), "message", "");
}

/** The machine-readable half of a refusal, for the cases the till branches on. */
export function code_of(body: Doc): string {
  return doc.text(doc.field(body, "error"), "code", "");
}

/**
 * A body with nothing in it.
 *
 * For the POSTs that are a verb and no arguments — recall, sign-out, reopen —
 * and for the document a 204 stands in for.
 */
export function empty(): Body {
  return {};
}

/**
 * A whole answer, ready for a strict decoder. An answer that was not there at
 * all becomes an empty object rather than an error invented here: the decoder
 * then names the field it wanted, which is a better sentence than anything
 * this line could write.
 */
function body_of(d: Doc): unknown {
  return d === undefined ? empty() : d;
}

/** The `{ "id": … }` every create answers with. */
function made_of(answer: Doc, said: string): model.Created {
  return model.decode_whole(model.decode_created, body_of(answer), said);
}

/**
 * The four figures a counted drawer answers with — the same shape from all
 * three doors that close one.
 */
function counted_of(answer: Doc): model.DrawerCount {
  return model.decode_whole(
    model.decode_drawer_count,
    body_of(answer),
    "that drawer was closed but the count would not read",
  );
}

function parsed(body: string): Doc {
  try {
    return doc.parse(body);
  } catch (e) {
    throw wrap(e, "that answer was not JSON");
  }
}

/**
 * One request.
 *
 * A 422 is answered as an **ordinary answer rather than an error**, because
 * the two 422s this API sends — "this needs ID" and "this product has no shelf
 * price" — are steps in a sale rather than failures of one. It stays a
 * document at this level: `send` is the transport and does not know which
 * endpoint it is carrying. Naming the two is [`answer_of`]'s job, one layer
 * up. Everything else that is not a 2xx becomes an error carrying the server's
 * own sentence.
 */
export async function send(token: string, method: string, path: string, body: string): Promise<Doc> {
  let response: Response;
  try {
    response = await transport(method, `${base()}${path}`, body, headers_for(token, body));
  } catch (e) {
    throw wrap(e, "the lane is offline");
  }
  if (response.status === 422) {
    return parsed(response.body);
  }
  if (!succeeded(response)) {
    throw refused(response.status, response.body);
  }
  // A 204 has no body and nothing to read; every other success does.
  if (response.body.length === 0) {
    return empty();
  }
  return parsed(response.body);
}

export async function get(token: string, path: string): Promise<Doc> {
  return await send(token, "GET", path, "");
}

export async function post(token: string, path: string, body: Body): Promise<Doc> {
  return await send(token, "POST", path, JSON.stringify(body));
}

export async function patch(token: string, path: string, body: Body): Promise<Doc> {
  return await send(token, "PATCH", path, JSON.stringify(body));
}

export async function remove(token: string, path: string): Promise<Doc> {
  return await send(token, "DELETE", path, "");
}

// ---- signing in ------------------------------------------------------------

export async function sign_in_with_pin(pin: string, register_id: string): Promise<model.Session> {
  const answer = await post("", "/auth/pin", { pin, register_id });
  const token = doc.text(answer, "token", "");
  if (token.length === 0) {
    throw new Error("that PIN was not recognised");
  }
  return model.session_of(answer, token);
}

export async function sign_in_with_password(username: string, password: string): Promise<model.Session> {
  const answer = await post("", "/auth/password", { username, password });
  const token = doc.text(answer, "token", "");
  if (token.length === 0) {
    throw new Error("that username and password do not match");
  }
  return model.session_of(answer, token);
}

/** Who this token belongs to — what a reloaded page asks before drawing. */
export async function whoami(token: string): Promise<model.Session> {
  const answer = await get(token, "/auth/me");
  return model.session_of(answer, token);
}

// ---- the till --------------------------------------------------------------

/**
 * What a basket-changing call answers: the basket, or the question that has to
 * be answered before there can be one.
 *
 * Eight endpoints — `scan`, `set_qty`, `void_line`, `adjust_line`, `hold`,
 * `recall`, `void_sale` and `set_customer` — reply *either* with the whole
 * basket *or*, with a 422, with a step in the sale rather than a failure of
 * one. So the branch is taken on a **variant** rather than on a string pulled
 * out of a document, and a caller that forgets a case is a type error instead
 * of a basket silently read as empty.
 *
 * The two questions are `POST /till/scan`'s alone today — see the two `422`
 * branches in `api/src/routes/till.ts`. The other seven are typed as answering
 * an `Answer` anyway, because which of them may ask is the Worker's to change
 * and this file should not have to be re-shaped when it does.
 */
export type Answer =
  /** The ordinary answer, and the only one the other seven send today. */
  | { tag: "Basket"; basket: model.Basket }
  /**
   * `needs: "age_check"` — an age-restricted item stopped the sale.
   *
   * `born_before` is a Unix timestamp the **Worker** computed from the
   * product's `min_age`, so nobody is doing date arithmetic at the counter
   * with a queue waiting. `min_age` and `born_on_or_before` sit at the top
   * level of that 422 while `id` and `name` are nested under `product`,
   * which is exactly why this is worth converting once, here.
   */
  | { tag: "NeedsAgeCheck"; name: string; min_age: number; born_before: number; product_id: string }
  /**
   * `needs: "price"` — the shelf price is not in the system, so the operator
   * is asked for it.
   *
   * The tag on the wire is `"price"`, not `"ask_price"` — `ask_price` is the
   * column on the product that causes it, and the two are easy to confuse.
   *
   * `unit` is on the wire (`product: { id, name, unit }`) and is carried here
   * even though today's dialog does not draw it. What the Worker sends is this
   * type's business; a field dropped at the boundary is a field no screen can
   * later put back.
   */
  | { tag: "NeedsPrice"; name: string; product_id: string; unit: string };

/**
 * One 422, or one basket.
 *
 * **An answer with no `needs` on it is an ordinary basket** — that is the
 * common path, every reply from the other seven endpoints and every successful
 * scan. So is an answer carrying a `needs` tag this build does not recognise:
 * that is what the till has always done, preserved deliberately rather than by
 * omission. It is not obviously the right answer — an unknown tag converts to
 * a basket with no lines and a zero total, which on a till reads as "the sale
 * is empty" — but changing it is a behaviour change on the money path and
 * belongs in its own commit.
 */
function answer_of(d: Doc): Answer {
  // Both 422s nest the product; neither of the two top-level age fields is
  // under it.
  const product = doc.field(d, "product");
  switch (doc.text(d, "needs", "")) {
    case "age_check":
      return {
        tag: "NeedsAgeCheck",
        name: doc.text(product, "name", ""),
        min_age: doc.int_of(d, "min_age", 18),
        born_before: doc.int_of(d, "born_on_or_before", 0),
        product_id: doc.text(product, "id", ""),
      };
    case "price":
      return {
        tag: "NeedsPrice",
        name: doc.text(product, "name", ""),
        product_id: doc.text(product, "id", ""),
        unit: doc.text(product, "unit", ""),
      };
  }
  return { tag: "Basket", basket: model.basket_of(d) };
}

/**
 * What is on the lane right now.
 *
 * The one basket-shaped endpoint with no 422 in it — there is no item being
 * added, so there is nothing to be asked for — which is why this one answers a
 * [`model.Basket`] flat rather than an [`Answer`] the caller has to match.
 */
export async function basket(token: string): Promise<model.Basket> {
  const answer = await get(token, "/till/basket");
  return model.basket_of(answer);
}

/**
 * Ring an item. **The only endpoint that sends a 422 today**, and so the only
 * one whose [`Answer`] is ever `NeedsAgeCheck` or `NeedsPrice`.
 */
export async function scan(
  token: string,
  code: string,
  product_id: string,
  qty: number,
  age_checked: boolean,
  price: number,
  ask_price: boolean,
): Promise<Answer> {
  const body: Body = {};
  if (code.length > 0) {
    body["code"] = code;
  }
  if (product_id.length > 0) {
    body["product_id"] = product_id;
  }
  if (qty > 0.0) {
    body["qty"] = qty;
  }
  if (age_checked) {
    body["age_checked"] = true;
  }
  if (ask_price) {
    body["price"] = price;
  }
  const answer = await post(token, "/till/scan", body);
  return answer_of(answer);
}

export async function set_qty(token: string, line_id: string, qty: number): Promise<Answer> {
  const answer = await patch(token, `/till/line/${line_id}`, { qty });
  return answer_of(answer);
}

export async function void_line(token: string, line_id: string): Promise<Answer> {
  const answer = await remove(token, `/till/line/${line_id}`);
  return answer_of(answer);
}

export async function adjust_line(
  token: string,
  line_id: string,
  kind: string,
  amount: number,
  manager_pin: string,
): Promise<Answer> {
  const body: Body = { kind };
  if (kind === "discount") {
    body["amount"] = amount;
  }
  if (kind === "override") {
    body["price"] = amount;
  }
  if (manager_pin.length > 0) {
    body["manager_pin"] = manager_pin;
  }
  const answer = await post(token, `/till/line/${line_id}/adjust`, body);
  return answer_of(answer);
}

export async function hold(token: string, label: string): Promise<Answer> {
  const answer = await post(token, "/till/hold", { label });
  return answer_of(answer);
}

export async function held(token: string): Promise<model.Held[]> {
  const answer = await get(token, "/till/held");
  return doc.items(doc.field(answer, "held")).map(model.held_of);
}

export async function recall(token: string, id: string): Promise<Answer> {
  const answer = await post(token, `/till/held/${id}/recall`, empty());
  return answer_of(answer);
}

export async function void_sale(token: string, reason: string, manager_pin: string): Promise<Answer> {
  const body: Body = { reason };
  if (manager_pin.length > 0) {
    body["manager_pin"] = manager_pin;
  }
  const answer = await post(token, "/till/void", body);
  return answer_of(answer);
}

/**
 * Finish the sale.
 *
 * `client_id` is an idempotency key the server dedupes on, and it is made once
 * per basket rather than per attempt — which is the whole point: a lane that
 * loses the answer and asks again lands on the same sale instead of ringing a
 * second one.
 */
export async function pay(token: string, payments: model.Payment[], client_id: string): Promise<model.Paid> {
  const list = payments.map((p) => {
    const entry: Body = {
      method: model.tender_code(p.tender),
      amount: p.amount,
      tendered: p.amount,
    };
    if (p.reference.length > 0) {
      entry["reference"] = p.reference;
    }
    return entry;
  });
  const answer = await post(token, "/till/pay", { client_id, payments: list });
  return model.paid_of(answer);
}

/**
 * Everything the till holds: the products, and the headings they file under.
 *
 * Two lists in one answer because they come from one request — the
 * `promotions` the same response carries are applied by the server when a line
 * is priced and are never read at this end.
 *
 * The categories **decode strictly** where the products convert, which is the
 * one place in this file the difference shows: a category the server sends
 * malformed is an error here rather than a blank heading on the grid.
 */
export async function grid(token: string): Promise<[model.Product[], model.Category[]]> {
  const answer = await get(token, "/till/grid");
  const categories = model.decode_list(
    answer,
    "categories",
    model.decode_category,
    "the catalogue has a heading we could not read",
  );
  const products = doc.items(doc.field(answer, "products")).map(model.product_of);
  return [products, categories];
}

export async function search(token: string, q: string): Promise<model.Product[]> {
  const answer = await get(token, `/till/search?q=${browser.escaped(q)}`);
  return doc.items(doc.field(answer, "products")).map(model.product_of);
}

export async function price_check(token: string, code: string): Promise<model.PriceCheck> {
  const answer = await get(token, `/till/price/${browser.escaped(code)}`);
  return model.price_check_of(answer);
}

// ---- the rest of the till's command bar ------------------------------------

export async function customers_at_till(token: string, q: string): Promise<model.Customer[]> {
  const answer = await get(token, `/till/customers?q=${browser.escaped(q)}`);
  return model.decode_list(
    answer,
    "customers",
    model.decode_customer,
    "that customer list has a row we could not read",
  );
}

export async function set_customer(token: string, customer_id: string): Promise<Answer> {
  const answer = await post(token, "/till/customer", { customer_id });
  return answer_of(answer);
}

/**
 * Money off a tab, taken at the counter.
 *
 * `client_id` is the idempotency key and is not optional. This is money over a
 * counter on a connection that drops: a settlement that completes and loses
 * its answer must find itself on the retry rather than be taken a second time.
 * It is minted per settlement — never the basket's `pay_key`, which belongs to
 * a sale and is reset when the basket changes.
 */
export async function pay_tab(
  token: string,
  customer_id: string,
  amount: number,
  tender: model.Tender,
  client_id: string,
): Promise<model.Settled> {
  const answer = await post(token, "/till/account-payment", {
    client_id,
    customer_id,
    amount,
    method: model.tender_code(tender),
  });
  return model.settled_of(answer);
}

export async function new_customer(token: string, name: string, phone: string): Promise<model.Created> {
  const answer = await post(token, "/till/customers", { name, phone });
  return made_of(answer, "that customer was added but came back without an id");
}

export async function receipts(token: string, q: string): Promise<model.Receipt[]> {
  const answer = await get(token, `/till/receipts?q=${browser.escaped(q)}`);
  return doc.items(doc.field(answer, "receipts")).map(model.receipt_of);
}

/**
 * One sale as a printable receipt — the shop's details, the lines as they were
 * rung, the tax inside the price, and how it was paid.
 */
export async function slip(token: string, id: string): Promise<model.Slip> {
  const answer = await get(token, `/till/receipts/${id}/slip`);
  return model.slip_of(answer);
}

export async function receipt(token: string, id: string): Promise<model.ReceiptDetail> {
  const answer = await get(token, `/till/receipts/${id}`);
  return model.receipt_detail_of(answer);
}

export async function take_return(
  token: string,
  sale_id: string,
  lines: model.ReturnLine[],
  reason: string,
  manager_pin: string,
): Promise<Doc> {
  const body: Body = { sale_id, reason };
  if (manager_pin.length > 0) {
    body["manager_pin"] = manager_pin;
  }
  const list: Body[] = [];
  for (const l of lines) {
    if (l.taking > 0.0) {
      list.push({ sale_item_id: l.id, qty: l.taking });
    }
  }
  body["lines"] = list;
  return await post(token, "/till/return", body);
}

export async function no_sale(token: string, reason: string, manager_pin: string): Promise<Doc> {
  const body: Body = { reason };
  if (manager_pin.length > 0) {
    body["manager_pin"] = manager_pin;
  }
  return await post(token, "/till/no-sale", body);
}

export async function close_lane(token: string, counted: number, manager_pin: string): Promise<model.DrawerCount> {
  const body: Body = { counted_total: counted };
  if (manager_pin.length > 0) {
    body["manager_pin"] = manager_pin;
  }
  const answer = await post(token, "/till/close-lane", body);
  return counted_of(answer);
}

export async function sign_out(token: string): Promise<Doc> {
  return await post(token, "/auth/sign-out", empty());
}

// ---- the back office -------------------------------------------------------

export async function overview(token: string): Promise<model.Overview> {
  const answer = await get(token, "/reports/overview");
  return model.overview_of(answer);
}

/**
 * Every lane, and what its drawer is doing.
 *
 * The `stale_after` the same answer carries is the number of seconds after
 * which the Worker calls a lane offline. It is not returned: the `state` it
 * decides is already on every lane, and nothing at this end recomputes it.
 */
export async function lanes(token: string): Promise<model.Lane[]> {
  const answer = await get(token, "/tills");
  return doc.items(doc.field(answer, "lanes")).map(model.lane_of);
}

export async function products(token: string, q: string): Promise<model.CatalogProduct[]> {
  const answer = await get(token, `/catalog/products?q=${browser.escaped(q)}`);
  return doc.items(doc.field(answer, "products")).map(model.catalog_product_of);
}

export async function inventory(token: string): Promise<model.Inventory> {
  const answer = await get(token, "/inventory");
  return model.inventory_of(answer);
}

/**
 * Receipts since `from`, and **no upper bound at all**.
 *
 * It used to send one, taken from this device's clock — and `completed_at` is
 * stamped by the Worker. A back office whose tablet ran a minute behind asked
 * for sales up to a moment that had already passed on the server, so a sale
 * rung in that minute was excluded by the upper bound of its own window. The
 * window a list means by "the last seven days" ends now, and only the Worker
 * knows when now is.
 */
export async function sales_history(token: string, from: number): Promise<model.SaleRow[]> {
  const answer = await get(token, `/sales?from=${from}`);
  return doc.items(doc.field(answer, "sales")).map(model.sale_row_of);
}

export async function shifts(token: string): Promise<model.ShiftRow[]> {
  const answer = await get(token, "/shifts");
  return doc.items(doc.field(answer, "shifts")).map(model.shift_row_of);
}

/**
 * The staff list, and the command table the till builds its bar from.
 *
 * The rules **decode strictly** where the people do not — a rule is four
 * strings the Worker builds from its own table, with no column behind any of
 * them, while `users.username` and `last_seen_at` are nullable.
 */
export async function staff(token: string): Promise<[model.Staff[], model.CommandRule[]]> {
  const answer = await get(token, "/staff");
  const matrix = model.decode_list(
    answer,
    "matrix",
    model.decode_command_rule,
    "the command table has a row we could not read",
  );
  const people = doc.items(doc.field(answer, "staff")).map(model.staff_of);
  return [people, matrix];
}

export async function audit(token: string, from: number): Promise<model.AuditEntry[]> {
  const answer = await get(token, `/sales/audit/log?from=${from}`);
  return doc.items(doc.field(answer, "entries")).map(model.audit_entry_of);
}

export async function product_report(token: string, from: number, to: number): Promise<model.ProductReport> {
  const answer = await get(token, `/reports/products?from=${from}&to=${to}`);
  return model.product_report_of(answer);
}

export async function sales_report(token: string, from: number, to: number): Promise<model.SalesReport> {
  const answer = await get(token, `/reports/sales?from=${from}&to=${to}`);
  return model.decode_whole(model.decode_sales_report, body_of(answer), "the sales report would not read");
}

/**
 * What to reorder, over a window.
 *
 * The `days` the answer echoes back is the window the Worker resolved, and it
 * is not returned: the caller passed it in and nothing draws it.
 */
export async function worksheet(token: string, days: number): Promise<model.WorksheetLine[]> {
  const answer = await get(token, `/purchasing/worksheet?days=${days}`);
  return doc.items(doc.field(answer, "lines")).map(model.worksheet_line_of);
}

export async function purchase_orders(token: string): Promise<model.PurchaseOrder[]> {
  const answer = await get(token, "/purchasing/orders");
  return doc.items(doc.field(answer, "orders")).map(model.purchase_order_of);
}

export async function suppliers(token: string): Promise<model.Supplier[]> {
  const answer = await get(token, "/catalog/suppliers");
  return doc.items(doc.field(answer, "suppliers")).map(model.supplier_of);
}

export async function categories(token: string): Promise<model.CatalogCategory[]> {
  const answer = await get(token, "/catalog/categories");
  return model.decode_list(
    answer,
    "categories",
    model.decode_catalog_category,
    "the catalogue has a heading we could not read",
  );
}

export async function customers(token: string): Promise<model.CustomerAccount[]> {
  const answer = await get(token, "/customers");
  return doc.items(doc.field(answer, "customers")).map(model.customer_account_of);
}

/** Who owes the shop, how much, and how long they have owed it. */
export async function receivables(token: string): Promise<model.Receivables> {
  const answer = await get(token, "/customers/receivables");
  return model.receivables_of(answer);
}

/** Money off a tab, taken in the back office — out of the safe, not a drawer. */
export async function settle_tab(token: string, id: string, body: Body): Promise<model.Created> {
  const answer = await post(token, `/customers/${id}/payments`, body);
  return made_of(answer, "that payment was recorded but came back without an id");
}

/**
 * Every offer, and the moment the server judged them at.
 *
 * `now` comes back with the list because whether an offer is *running* is a
 * comparison against the clock, and the clock that matters is the one pricing
 * a line. A back office in another time zone — or on a laptop whose clock has
 * drifted — must not draw an offer as live that the till will not apply.
 */
export async function promotions(token: string): Promise<[model.Promotion[], number]> {
  const answer = await get(token, "/promotions");
  const offers = doc.items(doc.field(answer, "promotions")).map(model.promotion_of);
  // This lane's own clock only if the server sent none — which it always
  // does. A zero here would read as 1970 and draw every scheduled offer as
  // not yet started.
  return [offers, doc.int_of(answer, "now", browser.now())];
}

export async function promotion_performance(token: string, from: number): Promise<model.PromotionResult[]> {
  const answer = await get(token, `/promotions/performance?from=${from}`);
  return model.decode_list(
    answer,
    "performance",
    model.decode_promotion_result,
    "an offer's figures would not read",
  );
}

export async function accounting_summary(token: string): Promise<model.BooksSummary> {
  const answer = await get(token, "/accounting/summary");
  return model.books_summary_of(answer);
}

export async function profit_and_loss(token: string, from: number, to: number): Promise<model.ProfitAndLoss> {
  const answer = await get(token, `/accounting/profit-and-loss?from=${from}&to=${to}`);
  return model.decode_whole(model.decode_profit_and_loss, body_of(answer), "the profit and loss would not read");
}

export async function balance_sheet(token: string, as_at: number): Promise<model.BalanceSheet> {
  const answer = await get(token, `/accounting/balance-sheet?as_at=${as_at}`);
  return model.decode_whole(model.decode_balance_sheet, body_of(answer), "the balance sheet would not read");
}

export async function trial_balance(token: string, from: number, to: number): Promise<model.TrialBalance> {
  const answer = await get(token, `/accounting/trial-balance?from=${from}&to=${to}`);
  return model.decode_whole(model.decode_trial_balance, body_of(answer), "the trial balance would not read");
}

export async function journal(token: string, from: number, to: number): Promise<model.Journal> {
  const answer = await get(token, `/accounting/journal?from=${from}&to=${to}`);
  return model.journal_of(answer);
}

export async function expenses(token: string, from: number, to: number): Promise<model.ExpenseReport> {
  const answer = await get(token, `/accounting/expenses?from=${from}&to=${to}`);
  return model.expense_report_of(answer);
}

/**
 * The shop's own settings, and the one read that stays a document.
 *
 * A key→value map of setting names, every value optional and every one with a
 * per-key default at the other end. A type here would be the Worker's allow
 * list written down a second time, and not one field of it could derive.
 */
export async function settings(token: string): Promise<Doc> {
  return await get(token, "/settings");
}

export async function shrinkage(token: string, from: number, to: number): Promise<model.ShrinkageReport> {
  const answer = await get(token, `/reports/shrinkage?from=${from}&to=${to}`);
  return model.decode_whole(model.decode_shrinkage_report, body_of(answer), "the shrinkage report would not read");
}

// ---- the back office's writes ----------------------------------------------
//
// One function per endpoint, each taking a body the caller built from the
// form's own fields. The form system in `desk.ts` decides *what* is asked for;
// these decide only where it is sent.

export async function save_product(token: string, id: string, body: Body): Promise<Doc> {
  if (id.length > 0) {
    return await patch(token, `/catalog/products/${id}`, body);
  }
  return await post(token, "/catalog/products", body);
}

export async function retire_product(token: string, id: string): Promise<Doc> {
  return await remove(token, `/catalog/products/${id}`);
}

export async function product(token: string, id: string): Promise<model.ProductPage> {
  const answer = await get(token, `/catalog/products/${id}`);
  return model.product_page_of(answer);
}

export async function add_barcode(token: string, product_id: string, body: Body): Promise<Doc> {
  return await post(token, `/catalog/products/${product_id}/barcodes`, body);
}

export async function drop_barcode(token: string, barcode: string): Promise<Doc> {
  return await remove(token, `/catalog/barcodes/${browser.escaped(barcode)}`);
}

export async function save_category(token: string, id: string, body: Body): Promise<Doc> {
  if (id.length > 0) {
    return await patch(token, `/catalog/categories/${id}`, body);
  }
  return await post(token, "/catalog/categories", body);
}

export async function save_supplier(token: string, id: string, body: Body): Promise<Doc> {
  if (id.length > 0) {
    return await patch(token, `/catalog/suppliers/${id}`, body);
  }
  return await post(token, "/catalog/suppliers", body);
}

export async function set_quick_keys(token: string, ids: string[]): Promise<Doc> {
  return await post(token, "/catalog/quick-keys", { product_ids: [...ids] });
}

export async function save_promotion(token: string, id: string, body: Body): Promise<Doc> {
  if (id.length > 0) {
    return await patch(token, `/promotions/${id}`, body);
  }
  return await post(token, "/promotions", body);
}

export async function end_promotion(token: string, id: string): Promise<Doc> {
  return await remove(token, `/promotions/${id}`);
}

export async function save_customer(token: string, id: string, body: Body): Promise<Doc> {
  if (id.length > 0) {
    return await patch(token, `/customers/${id}`, body);
  }
  return await post(token, "/customers", body);
}

/**
 * Answers **whether that order already existed**, for the same reason
 * [`goods_in`] does: the worksheet button is keyed by supplier and day, so a
 * second press raises nothing, and a count that includes the ones it did not
 * raise is a sentence that is not true.
 */
export async function raise_order(token: string, body: Body): Promise<boolean> {
  const answer = await post(token, "/purchasing/orders", body);
  return doc.bool_of(answer, "replayed", false);
}

export async function order(token: string, id: string): Promise<model.OrderPage> {
  const answer = await get(token, `/purchasing/orders/${id}`);
  return model.order_page_of(answer);
}

export async function send_order(token: string, id: string): Promise<Doc> {
  return await post(token, `/purchasing/orders/${id}/send`, empty());
}

export async function receive_order(token: string, id: string, body: Body): Promise<Doc> {
  return await post(token, `/purchasing/orders/${id}/receive`, body);
}

/**
 * A delivery booked straight into stock: one request, one transaction.
 *
 * Stock, the movement, the bill and — when it is paid on the spot — the
 * payment, all written together by the Worker or not at all. The client has no
 * business doing that as four calls: on a slow line each of them can be lost
 * on its own, which is how the shop ended up with orders it never meant to
 * raise.
 *
 * Answers **whether the Worker had already booked this delivery**. The id is
 * not what the caller needs — the key is. A press whose answer was lost and is
 * pressed again gets the first delivery back rather than a second one, which
 * is the whole purpose of the key; but the operator may have edited the lines
 * in between, and saying "booked into stock" while quietly discarding what
 * they just typed is worse than saying nothing. `true` here is the back
 * office's cue to say it was already booked.
 */
export async function goods_in(token: string, body: Body): Promise<boolean> {
  const answer = await post(token, "/purchasing/goods-in", body);
  return doc.bool_of(answer, "replayed", false);
}

/** A draft nobody wants. Deleted, because nothing happened to it. */
export async function delete_order(token: string, id: string): Promise<Doc> {
  return await remove(token, `/purchasing/orders/${id}`);
}

/** An order the supplier was told about, withdrawn with a reason on it. */
export async function cancel_order(token: string, id: string, reason: string): Promise<Doc> {
  return await post(token, `/purchasing/orders/${id}/cancel`, { reason });
}

export async function add_invoice(token: string, body: Body): Promise<model.Created> {
  const answer = await post(token, "/purchasing/invoices", body);
  return made_of(answer, "that invoice was recorded but came back without an id");
}

export async function pay_invoice(token: string, id: string, body: Body): Promise<model.Created> {
  const answer = await post(token, `/purchasing/invoices/${id}/pay`, body);
  return made_of(answer, "that payment was recorded but came back without an id");
}

export async function add_expense(token: string, body: Body): Promise<model.Created> {
  const answer = await post(token, "/accounting/expenses", body);
  return made_of(answer, "that expense was recorded but came back without an id");
}

export async function close_period(token: string, body: Body): Promise<model.Created> {
  const answer = await post(token, "/accounting/periods/close", body);
  return made_of(answer, "that month was closed but came back without an id");
}

export async function save_staff(token: string, id: string, body: Body): Promise<Doc> {
  if (id.length > 0) {
    return await patch(token, `/staff/${id}`, body);
  }
  return await post(token, "/staff", body);
}

export async function set_staff_pin(token: string, id: string, pin: string): Promise<Doc> {
  return await post(token, `/staff/${id}/pin`, { pin });
}

export async function set_staff_password(token: string, id: string, password: string): Promise<Doc> {
  return await post(token, `/staff/${id}/password`, { password });
}

export async function save_settings(token: string, body: Body): Promise<Doc> {
  return await patch(token, "/settings", body);
}

export async function adjust_stock(token: string, body: Body): Promise<Doc> {
  return await post(token, "/inventory/adjust", body);
}

export async function movements(token: string, from: number, product_id: string): Promise<model.StockMovement[]> {
  const answer = await get(token, `/inventory/movements?from=${from}&product_id=${browser.escaped(product_id)}`);
  return doc.items(doc.field(answer, "movements")).map(model.stock_movement_of);
}

export async function shift(token: string, id: string): Promise<model.ShiftPage> {
  const answer = await get(token, `/shifts/${id}`);
  return model.shift_page_of(answer);
}

export async function shift_movement(token: string, id: string, body: Body): Promise<Doc> {
  return await post(token, `/shifts/${id}/movement`, body);
}

export async function close_shift(token: string, id: string, counted: number, note: string): Promise<model.DrawerCount> {
  const answer = await post(token, `/shifts/${id}/close`, { counted_total: counted, note });
  return counted_of(answer);
}

export async function sale(token: string, id: string): Promise<model.SalePage> {
  const answer = await get(token, `/sales/${id}`);
  return model.sale_page_of(answer);
}

export async function refund_sale(token: string, id: string, body: Body): Promise<Doc> {
  return await post(token, `/sales/${id}/refund`, body);
}

export async function add_register(token: string, body: Body): Promise<model.Created> {
  const answer = await post(token, "/tills", body);
  return made_of(answer, "that lane was added but came back without an id");
}

export async function retire_register(token: string, id: string): Promise<Doc> {
  return await remove(token, `/tills/${id}`);
}

export async function open_shift(token: string, register_id: string, float_amount: number): Promise<model.Created> {
  const answer = await post(token, "/shifts/open", { register_id, opening_float: float_amount });
  return made_of(answer, "that drawer was opened but came back without an id");
}

/** Close a lane from the back office, which needs the lane named. */
export async function force_close_lane(token: string, register_id: string, counted: number): Promise<model.DrawerCount> {
  const answer = await post(token, `/tills/${register_id}/close`, { counted_total: counted });
  return counted_of(answer);
}

/**
 * A response read as text rather than as a document.
 *
 * For the exports, which answer with a CSV. Everything else in this file
 * parses JSON and would refuse a comma-separated file as malformed.
 */
export async function fetch_text(token: string, path: string): Promise<string> {
  let response: Response;
  try {
    response = await transport("GET", `${base()}${path}`, "", headers_for(token, ""));
  } catch (e) {
    throw wrap(e, "the lane is offline");
  }
  if (!succeeded(response)) {
    throw refused(response.status, response.body);
  }
  return response.body;
}

// ---- the books -------------------------------------------------------------

export async function books_health(token: string): Promise<model.Health> {
  const answer = await get(token, "/accounting/health");
  return model.decode_whole(model.decode_health, body_of(answer), "the ledger health check would not read");
}

export async function accounts(token: string): Promise<model.Account[]> {
  const answer = await get(token, "/accounting/accounts");
  return model.decode_list(answer, "accounts", model.decode_account, "the chart has an account we could not read");
}

/**
 * The accounts a running cost may be booked to.
 *
 * Two fields, not four: this endpoint selects only the code and the name, so
 * it cannot be read as an [`model.Account`], which wants a `kind` that is not
 * on the wire here.
 */
export async function expense_accounts(token: string): Promise<model.AccountOption[]> {
  const answer = await get(token, "/accounting/expense-accounts");
  return model.decode_list(
    answer,
    "accounts",
    model.decode_account_option,
    "the expense accounts have a row we could not read",
  );
}

export async function general_ledger(token: string, code: string, from: number, to: number): Promise<model.Ledger> {
  const answer = await get(token, `/accounting/ledger?account_code=${code}&from=${from}&to=${to}`);
  return model.ledger_of(answer);
}

export async function journal_filtered(
  token: string,
  from: number,
  to: number,
  ref_type: string,
  code: string,
  q: string,
): Promise<model.Journal> {
  const answer = await get(
    token,
    `/accounting/journal?from=${from}&to=${to}&ref_type=${ref_type}&account_code=${code}&q=${q}`,
  );
  return model.journal_of(answer);
}

export async function remove_category(token: string, id: string): Promise<Doc> {
  return await send(token, "DELETE", `/catalog/categories/${id}`, "");
}

export async function cancel_invoice(token: string, id: string, body: Body): Promise<Doc> {
  return await post(token, `/purchasing/invoices/${id}/cancel`, body);
}

export async function remove_photo(token: string, key: string): Promise<Doc> {
  return await send(token, "DELETE", `/photos/${key}`, "");
}

export async function post_opening_balances(token: string, body: Body): Promise<Doc> {
  return await post(token, "/accounting/opening-balances", body);
}

export async function reverse_entry(token: string, id: string, body: Body): Promise<Doc> {
  return await post(token, `/accounting/entries/${id}/reverse`, body);
}

export async function reopen_period(token: string, id: string): Promise<Doc> {
  return await post(token, `/accounting/periods/${id}/reopen`, empty());
}

export async function dead_stock(token: string, days: number): Promise<model.DeadStockReport> {
  const answer = await get(token, `/reports/dead-stock?days=${days}`);
  return model.dead_stock_report_of(answer);
}

export async function tax_report(token: string, from: number, to: number): Promise<model.TaxReport> {
  const answer = await get(token, `/reports/tax?from=${from}&to=${to}`);
  return model.decode_whole(model.decode_tax_report, body_of(answer), "the tax report would not read");
}

export async function payables(token: string): Promise<model.Payables> {
  const answer = await get(token, "/purchasing/payables");
  return model.payables_of(answer);
}
