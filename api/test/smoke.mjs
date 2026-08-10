// An end-to-end pass over the money path, against `wrangler dev`.
// Set the shop up, put a cashier on a lane, ring a basket with an offer and an
// age-restricted line, take a split payment, and check the arithmetic.

const BASE = "http://127.0.0.1:8787";
let failures = 0;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** A download, headers and all — `call` throws JSON away and a CSV is not JSON. */
async function fetchRaw(path, token) {
  const res = await fetch(BASE + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    disposition: res.headers.get("content-disposition") ?? "",
    // Bytes, because `res.text()` strips a leading byte-order mark while
    // decoding — so reading the text can never tell you whether the file the
    // shopkeeper saves actually has one.
    bytes: new Uint8Array(await res.clone().arrayBuffer()),
    body: await res.text(),
  };
}

function check(what, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}${ok ? "" : `\n         got ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`}`);
}

function note(what, value) {
  console.log(`  ..    ${what}: ${JSON.stringify(value)}`);
}

const run = async () => {
  console.log("\n— setup —");
  const setup = await call("POST", "/api/auth/setup", {
    body: { name: "Owner", username: "owner", password: "correct horse" },
  });
  check("owner created (or already there)", [200, 409].includes(setup.status), true);

  const signIn = await call("POST", "/api/auth/password", {
    body: { username: "owner", password: "correct horse" },
  });
  check("owner signs in", signIn.status, 200);
  const owner = signIn.json.token;
  check("password opens the back office", signIn.json.app, "office");

  console.log("\n— staff —");
  const cashier = await call("POST", "/api/staff", {
    token: owner,
    body: { name: "Thida M.", role: "sale_staff", pin: "4471" },
  });
  check("cashier created (or already there)", [201, 409].includes(cashier.status), true);

  const dupe = await call("POST", "/api/staff", {
    token: owner,
    body: { name: "Somebody Else", role: "sale_staff", pin: "4471" },
  });
  check("a second person cannot share that PIN", dupe.json.error?.code, "pin_taken");

  const managerPin = await call("POST", `/api/staff/${signIn.json.user?.id ?? ""}/pin`, {
    token: owner,
    body: { pin: "9000" },
  });
  note("owner given an approval PIN", managerPin.status);

  console.log("\n— catalogue —");

  // Run twice against the same shop and the second run must still work. The
  // API refuses a duplicate SKU, which is right — so this looks the product up
  // when it is already there rather than carrying an undefined id into every
  // step after it, which is how a re-run used to fail forty lines later with a
  // TypeError that said nothing about the cause.
  const ensureProduct = async (body) => {
    const made = await call("POST", "/api/catalog/products", { token: owner, body });
    if (made.status === 201) return made.json.id;
    if (made.json.error?.code !== "sku_taken") {
      throw new Error(`could not make ${body.sku}: ${JSON.stringify(made.json)}`);
    }
    const found = await call("GET", `/api/catalog/products?q=${encodeURIComponent(body.sku)}`, {
      token: owner,
    });
    const hit = (found.json.products ?? []).find((p) => p.sku === body.sku);
    if (!hit) throw new Error(`${body.sku} is taken but not findable`);
    return hit.id;
  };

  // Reuse the category rather than making another one every run. Left
  // unchecked this filled the till's tab strip with seven "Drinks" — visible
  // proof that a test which is not idempotent is a test that lies about the
  // state it leaves behind.
  const existingCats = await call("GET", "/api/catalog/categories", { token: owner });
  const found = (existingCats.json.categories ?? []).find((x) => x.name === "Drinks");
  const cat = found
    ? { json: { id: found.id } }
    : await call("POST", "/api/catalog/categories", { token: owner, body: { name: "Drinks" } });
  const colaId = await ensureProduct({
    sku: "COLA330", name: "Star Cola 330 ml", price: 900, cost: 600, category_id: cat.json.id,
  });
  const beerId = await ensureProduct({
    sku: "BEER640", name: "Myanmar Beer 640 ml", price: 3200, cost: 2400, min_age: 18,
  });
  check("products are in the catalogue", [typeof colaId, typeof beerId], ["string", "string"]);

  // A supplier, because the purchasing and payables checks below need one — and
  // without it they were guarded by `if (supplier)` and quietly skipped every
  // run, which is a test that reports success for work it never did.
  const knownSuppliers = await call("GET", "/api/catalog/suppliers", { token: owner });
  const existingSupplier = (knownSuppliers.json.suppliers ?? []).find((x) => x.name === "Shwe Trading");
  const supplier = existingSupplier
    ? existingSupplier
    : (await call("POST", "/api/catalog/suppliers", {
        token: owner, body: { name: "Shwe Trading", phone: "09-555-0180", lead_days: 3 },
      })).json;
  check("there is a supplier to buy from", typeof supplier.id, "string");

  // Barcodes and offers are idempotent in the same way: already-there is fine.
  const bar = await call("POST", `/api/catalog/products/${colaId}/barcodes`, {
    token: owner,
    body: { barcode: "8850001", pack_size: 1 },
  });
  check("the barcode is registered", [201, 409].includes(bar.status), true);

  // 3 for 2,500 on the cola — the offer from the design.
  const live = await call("GET", "/api/promotions", { token: owner });
  const already = (live.json.promotions ?? []).some((p) => p.name === "3 FOR 2,500" && p.active === 1);
  const promo = already
    ? { status: 201 }
    : await call("POST", "/api/promotions", {
        token: owner,
        body: {
          name: "3 FOR 2,500",
          kind: "n_for_x",
          value: 2500,
          n: 3,
          scope: "product",
          product_id: colaId,
        },
      });
  check("the offer is live", promo.status, 201);

  // **Turn the books on.** Accounting is off in a fresh shop, and without this
  // every check below that touches the ledger silently skipped — which meant
  // the whole accounting half of this suite only ran against a database that
  // happened to have had it enabled by hand. A clone of this repo is the only
  // state a new contributor ever sees, and there it tested nothing.
  const books = await call("PATCH", "/api/settings", {
    token: owner, body: { "accounting.enabled": "1" },
  });
  check("the books are on", [200, 204].includes(books.status), true);

  console.log("\n— the lane —");
  const pin = await call("POST", "/api/auth/pin", { body: { pin: "4471", register_id: "reg_1" } });
  check("cashier signs in with a PIN", pin.status, 200);
  check("a PIN opens the till", pin.json.app, "pos");
  const till = pin.json.token;

  const blocked = await call("GET", "/api/reports/overview", { token: till });
  check("a cashier cannot open the back office", blocked.status, 403);

  const shift = await call("POST", "/api/shifts/open", {
    token: owner,
    body: { register_id: "reg_1", opening_float: 50000, user_id: pin.json.user.id },
  });
  check("drawer opened (or already open)", [201, 409].includes(shift.status), true);

  console.log("\n— ringing —");

  // Start from an empty basket. A basket is a database row that outlives the
  // browser — which is the feature — so a previous run's shopping is still on
  // the lane, and every total below would be measured against it.
  const opening = await call("GET", "/api/till/basket", { token: till });
  for (const line of opening.json.lines ?? []) {
    await call("DELETE", `/api/till/line/${line.id}`, { token: till });
  }
  const empty = await call("GET", "/api/till/basket", { token: till });
  check("the lane starts empty", empty.json.lines?.length, 0);

  // Stock is measured as a delta, not an absolute: this runs against a shop
  // that may have traded before, and "how much moved" is the claim anyway.
  const before = await call("GET", `/api/catalog/products/${colaId}`, { token: owner });
  const stockBefore = before.json.product?.stock ?? 0;

  const scan1 = await call("POST", "/api/till/scan", { token: till, body: { code: "8850001", qty: 3 } });
  check("3 colas priced by the offer", scan1.json.sale?.total, 2500);
  check("the offer is named on the line", scan1.json.lines?.[0]?.promo_name, "3 FOR 2,500");
  check("and says what it saved", scan1.json.lines?.[0]?.promo_saved, 200);

  const beerScan = await call("POST", "/api/till/scan", {
    token: till,
    body: { product_id: beerId, qty: 1 },
  });
  check("an age-restricted line stops the sale", beerScan.status, 422);
  check("and says what to check", beerScan.json.needs, "age_check");
  check("with the minimum age", beerScan.json.min_age, 18);

  const beerOk = await call("POST", "/api/till/scan", {
    token: till,
    body: { product_id: beerId, qty: 1, age_checked: true },
  });
  check("after ID, it goes on", beerOk.json.sale?.total, 5700);

  const rescan = await call("POST", "/api/till/scan", { token: till, body: { code: "8850001", qty: 3 } });
  check("a rescan merges into the line rather than stacking", rescan.json.lines?.length, 2);
  check("6 colas = two groups of three", rescan.json.sale?.total, 8200);

  console.log("\n— gates —");
  const noPin = await call("POST", `/api/till/line/${rescan.json.lines[0].id}/adjust`, {
    token: till,
    body: { kind: "discount", amount: 300 },
  });
  check("a cashier cannot discount without a manager", noPin.status, 403);

  const withPin = await call("POST", `/api/till/line/${rescan.json.lines[0].id}/adjust`, {
    token: till,
    body: { kind: "discount", amount: 300, manager_pin: "9000" },
  });
  check("with a manager's PIN, it lands", withPin.json.sale?.total, 7900);

  console.log("\n— tender —");
  const short = await call("POST", "/api/till/pay", {
    token: till,
    body: { payments: [{ method: "cash", amount: 5000 }] },
  });
  check("a short payment is refused", short.json.error?.code, "short");

  const cardChange = await call("POST", "/api/till/pay", {
    token: till,
    body: { payments: [{ method: "card", amount: 10000 }] },
  });
  check("a card cannot be charged more than the total", cardChange.json.error?.code, "no_change_from_card");

  const paid = await call("POST", "/api/till/pay", {
    token: till,
    body: {
      payments: [
        { method: "card", amount: 5000 },
        { method: "cash", amount: 4000, tendered: 4000 },
      ],
    },
  });
  check("a split payment completes", paid.status, 200);
  check("change comes off the cash", paid.json.change, 1100);
  check("the sale is numbered", typeof paid.json.number, "number");

  console.log("\n— after —");
  const fresh = await call("GET", "/api/till/basket", { token: till });
  check("the lane has a fresh basket", fresh.json.lines?.length, 0);

  const drawer = await call("GET", `/api/shifts`, { token: owner });
  note("shift takings", drawer.json.shifts?.[0]?.takings);

  const receipt = await call("GET", `/api/sales/${paid.json.sale_id}`, { token: owner });
  check("the receipt reads back", receipt.json.sale?.total, 7900);
  check("with the offer named on the line", receipt.json.lines?.[0]?.promo_name, "3 FOR 2,500");

  const stock = await call("GET", `/api/catalog/products/${colaId}`, { token: owner });
  check("stock moved by what was sold", (stock.json.product?.stock ?? 0) - stockBefore, -6);

  const refund = await call("POST", `/api/sales/${paid.json.sale_id}/refund`, {
    token: owner,
    body: {
      reason: "Customer changed their mind",
      method: "cash",
      lines: [{ sale_item_id: receipt.json.lines[1].id, qty: 1 }],
    },
  });
  check("a line refunds", refund.status, 201);
  check("at what was charged", refund.json.total, 3200);

  const twice = await call("POST", `/api/sales/${paid.json.sale_id}/refund`, {
    token: owner,
    body: {
      reason: "again",
      method: "cash",
      lines: [{ sale_item_id: receipt.json.lines[1].id, qty: 1 }],
    },
  });
  check("the same unit cannot be refunded twice", twice.json.error?.code, "over_refund");

  console.log("\n— the rest of the command bar —");

  const knownCustomers = await call("GET", "/api/till/customers?q=Ma%20Hla%20Hla", { token: till });
  const knownCustomer = (knownCustomers.json.customers ?? []).find((x) => x.name === "Ma Hla Hla");
  const who = knownCustomer
    ? { status: 201, json: { id: knownCustomer.id } }
    : await call("POST", "/api/till/customers", {
        token: till,
        body: { name: "Ma Hla Hla", phone: "09-555-0134" },
      });
  check("a customer can be signed up at the counter", who.status, 201);

  const lookup = await call("GET", "/api/till/customers?q=Hla", { token: till });
  check("and found again", (lookup.json.customers ?? []).length > 0, true);

  const attached = await call("POST", "/api/till/customer", {
    token: till,
    body: { customer_id: who.json.id },
  });
  check("and attached to the basket", attached.json.sale?.customer?.name, "Ma Hla Hla");
  await call("POST", "/api/till/customer", { token: till, body: { customer_id: "" } });

  const noSaleStaff = await call("POST", "/api/till/no-sale", {
    token: till,
    body: { reason: "change for the float" },
  });
  check("a cashier cannot open the drawer", noSaleStaff.status, 403);

  // A manager-only command needs a manager *at the lane*. That is what the
  // owner's PIN is for: they walk over, sign in on the till, and the session
  // they get is scoped to that register.
  const managerAtLane = await call("POST", "/api/auth/pin", {
    body: { pin: "9000", register_id: "reg_1" },
  });
  check("a manager can sign in at a lane with their PIN", managerAtLane.status, 200);
  const boss = managerAtLane.json.token;

  const noSale = await call("POST", "/api/till/no-sale", {
    token: boss,
    body: { reason: "change for the float" },
  });
  check("and open the drawer", noSale.json.opened, true);

  const receipts = await call("GET", "/api/till/receipts", { token: till });
  check("the lane can find a receipt to return against", (receipts.json.receipts ?? []).length > 0, true);

  // Pick a receipt that still has something on it. On a re-run the most recent
  // sale may be one an earlier pass refunded to the last unit.
  let target = null;
  let returnable = null;
  for (const candidate of receipts.json.receipts ?? []) {
    const detail = await call("GET", `/api/till/receipts/${candidate.id}`, { token: till });
    const line = (detail.json.lines ?? []).find((l) => l.returnable > 0);
    if (line) {
      target = candidate;
      returnable = line;
      break;
    }
  }
  check("with something still returnable on it", returnable !== null, true);

  const noPinReturn = await call("POST", "/api/till/return", {
    token: till,
    body: {
      sale_id: target.id,
      reason: "wrong size",
      lines: [{ sale_item_id: returnable.id, qty: 1 }],
    },
  });
  check("a cashier cannot take a return alone", noPinReturn.status, 403);

  const returned = await call("POST", "/api/till/return", {
    token: till,
    body: {
      sale_id: target.id,
      reason: "wrong size",
      manager_pin: "9000",
      lines: [{ sale_item_id: returnable.id, qty: 1 }],
    },
  });
  check("with a manager's PIN it goes through", returned.status, 201);
  check("and pays back what was charged", returned.json.total > 0, true);

  const audit = await call("GET", "/api/sales/audit/log", { token: owner });
  const actions = (audit.json.entries ?? []).map((e) => e.action);
  check("the drawer opening is in the audit trail", actions.includes("no_sale"), true);
  check("and so is the return", actions.includes("return"), true);

  console.log("\n— what the audit found —");

  // Every check in this section is a regression: each one failed before the
  // fix beside it, and each was confirmed by an adversarial reviewer first.

  // A price typed at the till must be a whole number of minor units. Read with
  // a bare `typeof === "number"`, 1500.5 propagated into sale_items, sales,
  // payments and journal_lines — the last of which is immutable.
  const askId = await ensureProduct({
    sku: "LOOSE1", name: "Loose goods", price: 0, cost: 0, ask_price: true,
  });
  const fractional = await call("POST", "/api/till/scan", {
    token: till,
    body: { product_id: askId, qty: 1, price: 1500.5 },
  });
  check("a fractional price is refused", fractional.json.error?.code, "bad_price");

  // manager_only commands are marked X for sale staff in the command matrix:
  // a PIN cannot lend them. The old guard could never fire.
  const noSaleWithPin = await call("POST", "/api/till/no-sale", {
    token: till,
    body: { reason: "change", manager_pin: "9000" },
  });
  check("a manager's PIN cannot lend a manager-only command", noSaleWithPin.status, 403);

  // Store credit has to exist before it is spent, and come off when it is.
  const creditCustomer = await call("POST", "/api/till/customers", {
    token: till,
    body: { name: "Credit Tester", phone: "" },
  });
  await call("POST", "/api/till/customer", { token: till, body: { customer_id: creditCustomer.json.id } });
  await call("POST", "/api/till/scan", { token: till, body: { code: "8850001", qty: 1 } });
  const noCredit = await call("POST", "/api/till/pay", {
    token: till,
    body: { payments: [{ method: "store_credit", amount: 900 }] },
  });
  check("store credit nobody has is refused", noCredit.json.error?.code, "not_enough_credit");
  const cleared = await call("GET", "/api/till/basket", { token: till });
  for (const line of cleared.json.lines ?? []) {
    await call("DELETE", `/api/till/line/${line.id}`, { token: till });
  }
  await call("POST", "/api/till/customer", { token: till, body: { customer_id: "" } });

  // Partial refunds must sum to exactly what the line was charged. Six
  // one-unit refunds of a 6-unit line charged 1,000 used to pay 1,002.
  const splitScan = await call("POST", "/api/till/scan", { token: till, body: { code: "8850001", qty: 6 } });
  await call("POST", "/api/till/discount", {
    token: till,
    body: { amount: 1, manager_pin: "9000" },
  });
  const splitPaid = await call("POST", "/api/till/pay", {
    token: till,
    body: { payments: [{ method: "cash", amount: 100000 }] },
  });
  check("the split-refund sale completed", splitPaid.status, 200);
  const splitSale = await call("GET", `/api/sales/${splitPaid.json.sale_id}`, { token: owner });
  const splitLine = splitSale.json.lines[0];
  let refundedTotal = 0;
  for (let i = 0; i < 6; i++) {
    const one = await call("POST", `/api/sales/${splitPaid.json.sale_id}/refund`, {
      token: owner,
      body: { reason: "one at a time", method: "cash", restock: false,
        lines: [{ sale_item_id: splitLine.id, qty: 1 }] },
    });
    if (one.status === 201) refundedTotal += one.json.total;
  }
  check("six one-unit refunds sum to exactly what the line was charged",
    refundedTotal, splitLine.total);

  const seventh = await call("POST", `/api/sales/${splitPaid.json.sale_id}/refund`, {
    token: owner,
    body: { reason: "again", method: "cash", lines: [{ sale_item_id: splitLine.id, qty: 1 }] },
  });
  check("a seventh is refused", seventh.json.error?.code, "over_refund");

  // One request naming the same line twice used to pass the guard twice,
  // because neither read had been written when the other was checked.
  const dblScan = await call("POST", "/api/till/scan", { token: till, body: { code: "8850001", qty: 1 } });
  const dblPaid = await call("POST", "/api/till/pay", {
    token: till, body: { payments: [{ method: "cash", amount: 5000 }] },
  });
  const dblSale = await call("GET", `/api/sales/${dblPaid.json.sale_id}`, { token: owner });
  const dblLine = dblSale.json.lines[0];
  const doubled = await call("POST", `/api/sales/${dblPaid.json.sale_id}/refund`, {
    token: owner,
    body: { reason: "twice in one request", method: "cash", restock: false,
      lines: [{ sale_item_id: dblLine.id, qty: 1 }, { sale_item_id: dblLine.id, qty: 1 }] },
  });
  check("naming a line twice in one request is refused", doubled.json.error?.code, "over_refund");
  const afterDouble = await call("GET", `/api/sales/${dblPaid.json.sale_id}`, { token: owner });
  check("and nothing was written", (afterDouble.json.refunds ?? []).length, 0);

  console.log("\n— what the fintech review found —");

  // Five reviewers read the corrected code against the fintech-engineering
  // discipline — money types, ledger discipline, idempotency, balance
  // integrity, tax and reporting. Same rule as above: every check here failed
  // before the fix beside it.

  // A split return has to reverse exactly the tax the sale collected. The tax
  // was re-derived as a proportion on every call with nowhere for the residual
  // to go: a 3-unit line carrying 100 of VAT reversed 99, and a 4-unit line
  // carrying 10 reversed 11. Both entries balance, so only the VAT return knew.
  const taxedId = await ensureProduct({
    sku: "TAXED3", name: "Taxed goods", price: 700, cost: 400, tax_bp: 500,
  });
  await call("POST", "/api/till/scan", { token: till, body: { product_id: taxedId, qty: 3 } });
  const taxedPaid = await call("POST", "/api/till/pay", {
    token: till, body: { payments: [{ method: "cash", amount: 3000 }] },
  });
  check("the taxed sale completed", taxedPaid.status, 200);
  const taxedSale = await call("GET", `/api/sales/${taxedPaid.json.sale_id}`, { token: owner });
  const taxedLine = taxedSale.json.lines[0];

  // The same shift, before and after — a back-office refund must not move it.
  const liveBefore = (await call("GET", "/api/shifts", { token: owner })).json.shifts
    .find((x) => !x.closed_at);
  const expectedBefore = liveBefore
    ? (await call("GET", `/api/shifts/${liveBefore.id}`, { token: owner })).json.drawer.expected
    : null;

  let taxBack = 0;
  let cashBack = 0;
  for (let i = 0; i < 3; i++) {
    const one = await call("POST", `/api/sales/${taxedPaid.json.sale_id}/refund`, {
      token: owner,
      body: { reason: "one unit at a time", method: "cash", restock: false,
        lines: [{ sale_item_id: taxedLine.id, qty: 1 }] },
    });
    if (one.status === 201) {
      taxBack += one.json.tax;
      cashBack += one.json.total;
    }
  }
  check("three one-unit returns reverse exactly the tax collected", taxBack, taxedLine.tax);
  check("and exactly what the line was charged", cashBack, taxedLine.total);

  // A refund from the back office comes out of the safe. Charged to the sale's
  // own shift it came out of a drawer count that never saw the money leave —
  // and when the sale was rung on an older shift, out of a count that had
  // closed days before.
  if (liveBefore) {
    const expectedAfter =
      (await call("GET", `/api/shifts/${liveBefore.id}`, { token: owner })).json.drawer.expected;
    check("a back-office refund does not change what the drawer should hold",
      expectedAfter, expectedBefore);
  }

  // Store credit needs somebody to hold it. A walk-in refunded to store credit
  // credited the liability account and no customer: the shop kept the cash and
  // booked an obligation nobody could ever draw down.
  const orphanCredit = await call("POST", `/api/sales/${dblPaid.json.sale_id}/refund`, {
    token: owner,
    body: { reason: "to nobody", method: "store_credit", restock: false,
      lines: [{ sale_item_id: dblLine.id, qty: 1 }] },
  });
  check("store credit cannot be refunded to a sale with no customer",
    orphanCredit.json.error?.code, "no_customer");

  // The idempotency key has to be read, not just written. A lane that lost the
  // answer and asked again used to be told there was nothing to pay for — so
  // the cashier rang the basket a second time.
  const key = `smoke-${Math.random().toString(36).slice(2)}`;
  await call("POST", "/api/till/scan", { token: till, body: { code: "8850001", qty: 1 } });
  const firstPay = await call("POST", "/api/till/pay", {
    token: till,
    body: { client_id: key, payments: [{ method: "cash", amount: 5000 }] },
  });
  check("a keyed sale completes", firstPay.status, 200);
  const replayPay = await call("POST", "/api/till/pay", {
    token: till,
    body: { client_id: key, payments: [{ method: "cash", amount: 5000 }] },
  });
  check("replaying the key lands on the same sale", replayPay.json.sale_id, firstPay.json.sale_id);
  check("with the same receipt number", replayPay.json.number, firstPay.json.number);
  check("and the same change", replayPay.json.change, firstPay.json.change);
  check("named as a replay", replayPay.json.replayed, true);

  // A stock count that loses the race must write nothing. The conditional
  // UPDATE used to sit at the head of a batch with the movement row and the
  // stock-loss posting — and a statement matching no rows is a success, so
  // both committed and the operator was told nothing had happened.
  //
  // **This does not reproduce the race, and cannot.** `wrangler dev` runs one
  // request at a time: fired together, the second count reads the first one's
  // result and both legitimately succeed. What is checked instead is the
  // invariant the fix establishes — *a movement exists only for a count that
  // was accepted* — which holds whether or not the requests overlap, and which
  // the old code broke the moment they did. The fix itself is the shape
  // `shifts.ts` and `purchasing.ts` already use: claim, check, then write.
  const countedProduct = await ensureProduct({
    sku: "COUNT1", name: "Counted goods", price: 500, cost: 300,
  });
  const movesBefore = await call(
    "GET", `/api/inventory/movements?product_id=${countedProduct}&from=0`, { token: owner });
  const race = await Promise.all([
    call("POST", "/api/inventory/adjust", {
      token: owner, body: { product_id: countedProduct, counted: 40, reason: "count" },
    }),
    call("POST", "/api/inventory/adjust", {
      token: owner, body: { product_id: countedProduct, counted: 41, reason: "count" },
    }),
  ]);
  const landed = race.filter((r) => r.status === 200 && r.json.unchanged !== true).length;
  check("a count that is refused says the level moved",
    race.every((r) => r.status === 200 || r.json.error?.code === "moved"), true);
  const movesAfter = await call(
    "GET", `/api/inventory/movements?product_id=${countedProduct}&from=0`, { token: owner });
  check("a stock movement exists only for a count that was accepted",
    movesAfter.json.movements.length - movesBefore.json.movements.length, landed);

  // An invoice for nothing is what a form sends when the amount could not be
  // read — and it wrote a supplier invoice with no payable behind it, because
  // a zero-valued posting is dropped and the entry disappears entirely.
  const zeroInvoice = await call("POST", "/api/purchasing/invoices", {
    token: owner,
    body: { supplier_id: supplier.id, reference: "ZERO-1", total: 0 },
  });
  check("an invoice for nothing is refused", zeroInvoice.json.error?.code, "bad_total");

  // Two managers closing one lane at the same moment. The loser's UPDATE
  // matched no rows — a success — so its variance and sweep committed anyway,
  // leaving the drawer negative by the whole shift's takings and the safe
  // overstated by the same amount, while the manager was shown a 409.
  //
  // Same caveat as the stock count above: serialised locally, the second call
  // arrives after the first has closed the lane and signed its sessions out,
  // so it is refused with a 401 rather than a 409. Either way it is refused,
  // and the assertion that matters is the one after it — **one close, one set
  // of postings** — which is what the old code could not promise.
  //
  // On its own lane, so the drawer everything above is still selling into is
  // left alone.
  const lanes = await call("GET", "/api/tills", { token: owner });
  const spare = (lanes.json.lanes ?? []).find((r) => r.name === "Test lane");
  const spareId = spare
    ? spare.id
    : (await call("POST", "/api/tills", {
        token: owner, body: { name: "Test lane", kind: "counter" },
      })).json.id;
  const spareOpen = await call("POST", "/api/shifts/open", {
    token: owner, body: { register_id: spareId, opening_float: 20000 },
  });
  if ([201, 409].includes(spareOpen.status)) {
    const spareBoss = await call("POST", "/api/auth/pin", {
      body: { pin: "9000", register_id: spareId },
    });
    const [closeA, closeB] = await Promise.all([
      call("POST", "/api/till/close-lane", {
        token: spareBoss.json.token, body: { counted_total: 20000 },
      }),
      call("POST", "/api/till/close-lane", {
        token: spareBoss.json.token, body: { counted_total: 20000 },
      }),
    ]);
    const closes = [closeA, closeB];
    check("two managers closing one lane: exactly one closes it",
      closes.filter((r) => r.status === 200).length, 1);
    check("and the other is refused",
      closes.filter((r) => r.status >= 400).length, 1);
    const acctOn = await call("GET", "/api/accounting/summary", { token: owner });
    if (acctOn.json.enabled) {
      const closedShift = (await call("GET", "/api/shifts", { token: owner })).json.shifts
        .find((x) => x.register_id === spareId && x.closed_at);
      const book = await call(
        "GET", `/api/accounting/journal?from=0&to=${Math.floor(Date.now() / 1000) + 60}`,
        { token: owner });
      const forShift = (book.json.entries ?? [])
        .filter((e) => e.ref_type === "shift" && e.ref_id === closedShift?.id);
      // The float going in, and the sweep coming back out. A variance of zero
      // posts nothing, and the refused close must post nothing at all.
      check("the refused close posted nothing", forShift.length <= 2, true);
    }
  }

  // A replayed close must not re-post the variance and the sweep. Kept last:
  // it closes the drawer everything above is selling into.
  const openShifts = await call("GET", "/api/shifts", { token: owner });
  const liveShift = (openShifts.json.shifts ?? []).find((x) => !x.closed_at);
  if (liveShift) {
    const detail = await call("GET", `/api/shifts/${liveShift.id}`, { token: owner });
    const expected = detail.json.drawer.expected;
    const first = await call("POST", `/api/shifts/${liveShift.id}/close`, {
      token: owner, body: { counted_total: expected },
    });
    check("the drawer closes", first.status, 200);
    const replay = await call("POST", `/api/shifts/${liveShift.id}/close`, {
      token: owner, body: { counted_total: expected },
    });
    check("a replayed close is refused", replay.json.error?.code, "already_closed");
  }

  // The accounting window must actually window.
  const acct = await call("GET", "/api/accounting/summary", { token: owner });
  if (acct.json.enabled) {
    const future = Math.floor(Date.now() / 1000) + 400 * 86400;
    const empty = await call(
      "GET", `/api/accounting/trial-balance?from=${future}&to=${future + 86400}`, { token: owner });
    check("a window with no postings in it is empty", empty.json.total_debit, 0);
    const lifetime = await call(
      "GET", `/api/accounting/trial-balance?from=0&to=${future}`, { token: owner });
    check("while the lifetime window is not", lifetime.json.total_debit > 0, true);
  }

  console.log("\n— exports —");

  // An export is the one artefact whose reader is not us. These check the
  // three ways one silently stops being useful: it is not a download, the
  // numbers are not numbers, or it disagrees with the screen it came from.
  const ACCOUNTING_VIEWS = ["trial", "pl", "balance", "journal", "accounts"];
  for (const view of ACCOUNTING_VIEWS) {
    const sheet = await fetchRaw(`/api/accounting/export?view=${view}&from=0`, owner);
    check(`the ${view} sheet exports`, sheet.status, 200);
    check(`  as a csv download`, sheet.type.startsWith("text/csv"), true);
    check(`  named after the sheet`, sheet.disposition.includes(`filename="${view}-`), true);
  }

  const trial = await fetchRaw("/api/accounting/export?view=trial&from=0", owner);
  // Excel on Windows reads a UTF-8 file without a BOM as the system code page,
  // which turns every Burmese character into mojibake. This shop ships Burmese.
  check("a sheet opens with a byte-order mark",
    Array.from(trial.bytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  const trialRows = trial.body.replace(/^﻿/, "").split("\r\n");
  check("and states what it is and what window it covers",
    trialRows[0].startsWith("Report,trial,From,"), true);
  const amounts = trialRows.slice(3).map((r) => r.split(",")[4]).filter((v) => v && v.length > 0);
  // The whole point of a machine-readable amount: a column of "K1,234" is a
  // column of text, and a column of text does not add up.
  check("amounts carry no symbol and no separators",
    amounts.every((v) => /^-?\d+(\.\d+)?$/.test(v)), true);

  // The file and the screen are two renderings of one query. If they can
  // disagree, the export is not evidence of anything.
  const tbJson = await call("GET", `/api/accounting/trial-balance?from=0&to=${Math.floor(Date.now() / 1000)}`, {
    token: owner,
  });
  const totalsRow = trialRows.find((r) => r.startsWith(",Totals,"));
  check("the exported totals match the screen's",
    totalsRow?.split(",").slice(4, 6).map(Number),
    [tbJson.json.total_debit, tbJson.json.total_credit]);

  const badView = await call("GET", "/api/accounting/export?view=nonsense", { token: owner });
  check("an unknown sheet is refused, not silently substituted",
    badView.json.error?.code, "bad_view");

  const REPORTS = ["products", "categories", "sales", "tenders", "staff",
    "shrinkage", "tax", "inventory", "shifts", "expenses"];
  let reportsOk = 0;
  for (const report of REPORTS) {
    const sheet = await fetchRaw(`/api/reports/export?report=${report}&from=0`, owner);
    if (sheet.status === 200 && sheet.type.startsWith("text/csv")) reportsOk++;
  }
  check("all ten operational reports export", reportsOk, REPORTS.length);
  const badReport = await call("GET", "/api/reports/export?report=bogus", { token: owner });
  check("an unknown report is refused", badReport.json.error?.code, "bad_report");

  // The tax report is the only VAT output there is, and it groups by the rate
  // as it was on the line — not as the product carries it today.
  const tax = await call("GET", "/api/reports/tax?from=0", { token: owner });
  check("the tax report bands by rate", (tax.json.rates ?? []).length > 0, true);
  check("and its bands sum to its total",
    tax.json.rates.reduce((a, r) => a + r.tax, 0), tax.json.tax);

  // A general ledger without an opening balance is a running total of an
  // arbitrary slice.
  const ledger = await call("GET", "/api/accounting/ledger?account_code=1000&from=0", { token: owner });
  check("an account opens its own ledger", ledger.status, 200);
  check("with an opening balance", typeof ledger.json.opening, "number");
  if ((ledger.json.lines ?? []).length > 0) {
    const last = ledger.json.lines[ledger.json.lines.length - 1];
    check("and a running balance that ends where the account does",
      last.balance, ledger.json.closing);
  }
  const noAccount = await call("GET", "/api/accounting/ledger?from=0", { token: owner });
  check("a ledger with no account named is refused", noAccount.json.error?.code, "no_account");

  console.log("\n— the rest of the books —");

  // The sweep that re-checks the invariants on every page open. Structure
  // stops most mistakes; this is what catches one that already shipped.
  const health = await call("GET", "/api/accounting/health", { token: owner });
  check("the books re-check themselves", health.status, 200);
  check("debits equal credits", health.json.sides_agree, true);
  check("no entry is unbalanced", (health.json.unbalanced ?? []).length, 0);
  check("no line has lost its entry", health.json.orphan_lines, 0);
  check("the accounting equation holds", health.json.equation_holds, true);
  // `products.stock` is a running cache of the movements, and nothing had ever
  // checked that the cache still agreed with what it caches.
  check("stock agrees with its movements", (health.json.stock_drift ?? []).length, 0);
  note("stock at cost vs in the ledger", [health.json.stock_at_cost, health.json.stock_in_ledger]);

  // A running cost belongs to an account, so a profit and loss can say more
  // than "Operating expenses" and one number.
  const expenseAccounts = await call("GET", "/api/accounting/expense-accounts", { token: owner });
  check("there is a chart to book a cost against",
    (expenseAccounts.json.accounts ?? []).length >= 8, true);
  check("and it withholds the accounts the machinery already posts to",
    (expenseAccounts.json.accounts ?? []).some((a) => a.code.startsWith("5")), false);

  const utilities = await call("POST", "/api/accounting/expenses", {
    token: owner,
    body: { category: "Electricity", account_code: "6200", amount: 12000, tax: 600,
      method: "cash", payee: "YESC", reference: "SM-2026-08" },
  });
  check("an expense books to the account it names", utilities.status, 201);
  const toCogs = await call("POST", "/api/accounting/expenses", {
    token: owner,
    body: { category: "sneaky", account_code: "5000", amount: 100, method: "cash" },
  });
  check("but not to cost of goods sold", toCogs.json.error?.code, "bad_account");
  const overTaxed = await call("POST", "/api/accounting/expenses", {
    token: owner,
    body: { category: "x", amount: 100, tax: 200, method: "cash" },
  });
  check("and the tax inside it cannot exceed it", overTaxed.json.error?.code, "bad_tax");

  // Nothing can be edited or deleted — the triggers say to post a correction
  // instead, and this is what makes that instruction followable.
  const forReversal = await call("GET", "/api/accounting/journal?from=0&ref_type=expense", {
    token: owner,
  });
  const anEntry = (forReversal.json.entries ?? [])[0];
  let reversedAnEntry = false;
  if (anEntry) {
    reversedAnEntry = true;
    check("an entry carries a quotable number", /^J-\d{6}$/.test(anEntry.number), true);
    const reversed = await call("POST", `/api/accounting/entries/${anEntry.id}/reverse`, {
      token: owner, body: { reason: "billed twice" },
    });
    check("an entry can be corrected by reversal", reversed.status, 201);
    const twice = await call("POST", `/api/accounting/entries/${anEntry.id}/reverse`, {
      token: owner, body: { reason: "again" },
    });
    check("but only once", twice.json.error?.code, "already_reversed");
  }

  // The unfiltered journal, which is the common case and the one that broke:
  // fetching each entry's lines by binding the returned ids is `IN (?1 … ?200)`
  // and D1 allows 100 bind variables, so this failed with a SQLITE_ERROR while
  // a filtered journal returning fewer than a hundred entries worked fine.
  const wholeJournal = await call("GET", "/api/accounting/journal?from=0", { token: owner });
  check("the whole journal loads", wholeJournal.status, 200);
  // The defect was a 500, not a row count: asserting "more than a hundred
  // entries" only meant anything on a shop that had already traded a lot, and
  // read as a failure on a fresh one. What is actually true of every shop is
  // that the page returned is the whole window, up to the limit.
  check("returning the whole page, however many that is",
    (wholeJournal.json.entries ?? []).length,
    Math.min(wholeJournal.json.total ?? 0, 200));
  check("and every entry it shows has its lines",
    (wholeJournal.json.entries ?? []).every((e) =>
      (wholeJournal.json.lines ?? []).some((l) => l.entry_id === e.id)), true);

  // The journal shows an entry with all of its legs, however it was filtered.
  const filtered = await call("GET", "/api/accounting/journal?from=0&ref_type=sale", { token: owner });
  check("the journal filters by what caused an entry",
    (filtered.json.entries ?? []).every((e) => e.ref_type === "sale"), true);
  check("and says how many the window really holds",
    filtered.json.total >= filtered.json.shown, true);
  const byAccount = await call("GET", "/api/accounting/journal?from=0&account_code=4000", {
    token: owner,
  });
  const shownIds = new Set((byAccount.json.entries ?? []).map((e) => e.id));
  const strays = (byAccount.json.lines ?? []).filter((l) => !shownIds.has(l.entry_id));
  check("an account filter still returns whole entries, not single legs", strays.length, 0);

  // Aging is what tells a shopkeeper who to pay first, and it is summed by the
  // database over every outstanding invoice rather than over one page of them.
  const payables = await call("GET", "/api/purchasing/payables", { token: owner });
  check("payables are aged into buckets", typeof payables.json.aging?.totals?.d30, "number");
  const aged = payables.json.aging.totals;
  check("and the buckets sum to what is outstanding",
    aged.current + aged.d30 + aged.d60 + aged.d90 + aged.d90up, aged.total);

  // A window that is not a pair of times used to become NaN, and every
  // comparison against NaN is false — so the report came back empty and
  // correct-looking rather than refused.
  const nonsenseWindow = await call("GET", "/api/accounting/trial-balance?from=yesterday", {
    token: owner,
  });
  check("a window that is not a pair of times is refused",
    nonsenseWindow.json.error?.code, "bad_window");
  const backwards = await call("GET", "/api/reports/sales?from=2000000000&to=1000000000", {
    token: owner,
  });
  check("and so is one that ends before it starts", backwards.json.error?.code, "bad_window");

  // Money leaving the shop is logged whoever authorised it.
  const trail = await call("GET", "/api/sales/audit/log?from=0", { token: owner });
  const logged = (trail.json.entries ?? []).map((e) => e.action);
  check("recording an expense leaves a trail", logged.includes("expense"), true);
  // Only if there was an entry to correct — on a shop whose books were just
  // switched on there may not be one yet, and this asserted unconditionally.
  if (reversedAnEntry) {
    check("and so does correcting an entry", logged.includes("reverse_entry"), true);
  }

  // The three endpoints that existed with no way to reach them, and the two
  // reports that had no screen.
  const dead = await call("GET", "/api/reports/dead-stock?days=60", { token: owner });
  check("dead stock is reported", dead.status, 200);
  check("and only counts what is on the shelf",
    (dead.json.products ?? []).every((p) => p.stock > 0), true);

  const inv = await call("GET", "/api/reports/inventory", { token: owner });
  check("stock is valued at cost and at retail", inv.status, 200);

  // Cancelling an invoice: not a delete, refused once money has moved, and the
  // accrual it raised comes back off the books.
  {
    const supplier2 = supplier;
    const raised = await call("POST", "/api/purchasing/invoices", {
      token: owner,
      body: { supplier_id: supplier2.id, reference: `CANCEL-${Math.random().toString(36).slice(2, 7)}`,
        total: 45000 },
    });
    check("an invoice is raised", raised.status, 201);
    const owedBefore = (await call("GET", "/api/purchasing/payables", { token: owner }))
      .json.totals.outstanding;
    // Absent is `bad_field` from `str()`; blank — the field left empty, which is
    // what actually happens — is the one this guard is for.
    const noField = await call("POST", `/api/purchasing/invoices/${raised.json.id}/cancel`, {
      token: owner, body: {},
    });
    check("cancelling without a reason field is refused", noField.json.error?.code, "bad_field");
    const blankReason = await call("POST", `/api/purchasing/invoices/${raised.json.id}/cancel`, {
      token: owner, body: { reason: "   " },
    });
    check("and so is a blank one", blankReason.json.error?.code, "bad_reason");
    const cancelled = await call("POST", `/api/purchasing/invoices/${raised.json.id}/cancel`, {
      token: owner, body: { reason: "entered twice" },
    });
    check("an unpaid invoice can be cancelled", cancelled.status, 200);
    const owedAfter = (await call("GET", "/api/purchasing/payables", { token: owner }))
      .json.totals.outstanding;
    check("and stops counting toward what is owed", owedBefore - owedAfter, 45000);
    const twice2 = await call("POST", `/api/purchasing/invoices/${raised.json.id}/cancel`, {
      token: owner, body: { reason: "again" },
    });
    check("but only once", twice2.json.error?.code, "not_open");

    // One that has been paid against is a real obligation with real money
    // already moved — that is a credit note, not a cancellation.
    const paidInv = await call("POST", "/api/purchasing/invoices", {
      token: owner,
      body: { supplier_id: supplier2.id, reference: `PAID-${Math.random().toString(36).slice(2, 7)}`,
        total: 10000 },
    });
    await call("POST", `/api/purchasing/invoices/${paidInv.json.id}/pay`, {
      token: owner, body: { amount: 4000, method: "cash" },
    });
    const refused = await call("POST", `/api/purchasing/invoices/${paidInv.json.id}/cancel`, {
      token: owner, body: { reason: "changed my mind" },
    });
    check("a part-paid invoice cannot be cancelled", refused.json.error?.code, "already_paid");
  }

  // Product pictures. The permission matrix is the part that matters: an
  // `<img src>` cannot send an Authorization header, so reading has to be open
  // or the till's grid is a wall of broken tiles — while writing must stay shut.
  const shot = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const put = await fetch(`${BASE}/api/photos?product_id=${colaId}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${owner}`, "content-type": "image/png" },
    body: shot,
  });
  const putBody = await put.json();
  check("a manager can save a picture", put.status, 201);
  check("and gets a key back", /^products\/img_[0-9a-f]+\.png$/.test(putBody.key ?? ""), true);

  const anon = await fetch(`${BASE}/api/photos/${putBody.key}`);
  check("anyone may read it — an <img> cannot authenticate", anon.status, 200);
  check("and it is served immutable",
    (anon.headers.get("cache-control") ?? "").includes("immutable"), true);

  const anonWrite = await fetch(`${BASE}/api/photos`, {
    method: "PUT", headers: { "content-type": "image/png" }, body: shot,
  });
  check("but nobody may write one unauthenticated", anonWrite.status, 401);
  const anonDelete = await fetch(`${BASE}/api/photos/${putBody.key}`, { method: "DELETE" });
  check("nor delete one — the sub-path is gated too", anonDelete.status, 401);
  const tillWrite = await fetch(`${BASE}/api/photos`, {
    method: "PUT",
    headers: { authorization: `Bearer ${till}`, "content-type": "image/png" },
    body: shot,
  });
  check("and a cashier is refused", tillWrite.status, 403);

  const wrongType = await fetch(`${BASE}/api/photos`, {
    method: "PUT",
    headers: { authorization: `Bearer ${owner}`, "content-type": "application/pdf" },
    body: shot,
  });
  check("only images are accepted", (await wrongType.json()).error?.code, "bad_type");

  const withPhoto = await call("GET", `/api/catalog/products/${colaId}`, { token: owner });
  check("the upload attached it to the product", withPhoto.json.product?.photo_key, putBody.key);
  const gone = await fetch(`${BASE}/api/photos/${putBody.key}`, {
    method: "DELETE", headers: { authorization: `Bearer ${owner}` },
  });
  check("a manager can take it off again", gone.status, 200);
  const unlinked = await call("GET", `/api/catalog/products/${colaId}`, { token: owner });
  check("and the product no longer points at it", unlinked.json.product?.photo_key, null);

  // A category is an organising label with no history hanging off it, so it
  // deletes rather than retires — but only when it is empty, because the
  // alternative is orphaning the products filed under it.
  const spareShelf = await call("POST", "/api/catalog/categories", {
    token: owner, body: { name: `Spare ${Math.random().toString(36).slice(2, 7)}`, sort: 9 },
  });
  check("a category can be added", spareShelf.status, 201);
  const emptied = await call("DELETE", `/api/catalog/categories/${spareShelf.json.id}`, { token: owner });
  check("and removed once nothing is in it", emptied.status, 200);
  const busy = await call("DELETE", `/api/catalog/categories/${cat.json.id}`, { token: owner });
  check("one with products in it is refused", busy.json.error?.code, "not_empty");
  check("and says how many there are to move", busy.json.error?.products > 0, true);
  const ghostCat = await call("DELETE", "/api/catalog/categories/cat_nope", { token: owner });
  check("removing one that is not there is a 404", ghostCat.status, 404);

  console.log("\n— the books —");

  // The check that earns its keep. Posting a sale used to credit the *gross*
  // cash tendered rather than what stayed in the drawer after change, and to
  // debit discounts without raising the sales credit to match — so every entry
  // was out by the change plus the discount. `post` refused all of them, which
  // is the ledger working, but nothing here was asking the question.
  const enabled = await call("GET", "/api/accounting/summary", { token: owner });
  if (enabled.json.enabled) {
    const tb = await call("GET", `/api/accounting/trial-balance?from=0&to=${Math.floor(Date.now() / 1000)}`, {
      token: owner,
    });
    check("the ledger balances", tb.json.total_debit, tb.json.total_credit);
    note("posted", `${enabled.json.entries} entries`);

    const bs = await call("GET", `/api/accounting/balance-sheet?as_at=${Math.floor(Date.now() / 1000)}`, {
      token: owner,
    });
    check("the balance sheet balances", bs.json.out_by, 0);
  } else {
    note("accounting is off", "turn it on to check the postings");
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
