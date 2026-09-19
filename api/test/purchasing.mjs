// Buying, end to end, against `wrangler dev`.
//
// The companion to `smoke.mjs`, and it exists because every check in here is a
// bug that reached a shop: one press of a button that wrote twelve draft
// orders with no way to delete them, a delivery received twice at once that
// put the stock up twice, a refused line that left the quantity marked
// received and the goods nowhere, and a cost box left blank that set a
// product's cost price to nothing and reported 100% margin on it afterwards.
//
//     npm run dev:api          # in one terminal
//     node api/test/purchasing.mjs
//
// It writes to the local D1 and is safe to run repeatedly; every row it makes
// carries a random name.
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
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const ok = (what, cond, note) => {
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.log(`  FAIL ${what}${note ? ` — ${note}` : ""}`); }
};
const say = (t) => console.log(`\n— ${t} —`);

const rand = () => Math.random().toString(36).slice(2, 12);

let token, supplierId, productA, productB;

async function signIn() {
  const setup = await call("GET", "/api/auth/setup");
  if (setup.json.needs_setup) {
    await call("POST", "/api/auth/setup", {
      body: { name: "Owner", username: "owner", password: "correct horse" },
    });
  }
  const res = await call("POST", "/api/auth/password", {
    body: { username: "owner", password: "correct horse" },
  });
  token = res.json.token;
  if (!token) throw new Error("could not sign in: " + JSON.stringify(res.json));
}

async function refs() {
  const sup = await call("POST", "/api/catalog/suppliers", {
    token,
    body: { name: "Van Man " + rand(), lead_days: 2 },
  });
  supplierId = sup.json.id;
  const mk = async (name, sku) => {
    const r = await call("POST", "/api/catalog/products", {
      token,
      body: { name, sku, price: 1500, cost: 900, stock: 0, unit: "each", supplier_id: supplierId },
    });
    if (!r.json.id) throw new Error("product: " + JSON.stringify(r.json));
    return r.json.id;
  };
  productA = await mk("Cola " + rand(), "SKU" + rand());
  productB = await mk("Crisps " + rand(), "SKU" + rand());
}

const stockOf = async (id) => {
  const r = await call("GET", `/api/catalog/products/${id}`, { token });
  return r.json.product?.stock ?? r.json.stock;
};

async function main() {
  await signIn();
  await refs();

  say("an order tapped four times is one order");
  const key = "poc_" + rand();
  const bodies = {
    client_id: key,
    supplier_id: supplierId,
    lines: [{ product_id: productA, qty: 6, unit_cost: 900 }],
  };
  const first = await call("POST", "/api/purchasing/orders", { token, body: bodies });
  const again = await Promise.all(
    [0, 1, 2].map(() => call("POST", "/api/purchasing/orders", { token, body: bodies })),
  );
  ok("the first press makes an order", first.status === 201 && !!first.json.id);
  ok(
    "and the next three answer with the same one",
    again.every((r) => r.json.id === first.json.id),
    JSON.stringify(again.map((r) => [r.status, r.json.id])),
  );
  const list = await call("GET", "/api/purchasing/orders", { token });
  ok(
    "so the list holds one row, not four",
    list.json.orders.filter((o) => o.id === first.json.id).length === 1,
  );

  say("a draft can be deleted");
  const del = await call("DELETE", `/api/purchasing/orders/${first.json.id}`, { token });
  ok("deleting a draft works", del.status === 200, JSON.stringify(del.json));
  const after = await call("GET", "/api/purchasing/orders", { token });
  ok("and it leaves the list", !after.json.orders.some((o) => o.id === first.json.id));
  const twice = await call("DELETE", `/api/purchasing/orders/${first.json.id}`, { token });
  ok("deleting it again is a 404", twice.status === 404, JSON.stringify(twice.json));

  say("a sent order is cancelled, not deleted");
  const sent = await call("POST", "/api/purchasing/orders", {
    token,
    body: { client_id: "poc_" + rand(), supplier_id: supplierId, lines: [{ product_id: productA, qty: 3, unit_cost: 900 }] },
  });
  await call("POST", `/api/purchasing/orders/${sent.json.id}/send`, { token });
  const noDelete = await call("DELETE", `/api/purchasing/orders/${sent.json.id}`, { token });
  ok("a sent order refuses deletion", noDelete.status === 409, JSON.stringify(noDelete.json));
  const noReason = await call("POST", `/api/purchasing/orders/${sent.json.id}/cancel`, {
    token, body: { reason: "  " },
  });
  ok("cancelling without a reason is refused", noReason.status === 400);
  const cancelled = await call("POST", `/api/purchasing/orders/${sent.json.id}/cancel`, {
    token, body: { reason: "supplier cannot supply" },
  });
  ok("with one it is cancelled", cancelled.status === 200, JSON.stringify(cancelled.json));
  const page = await call("GET", `/api/purchasing/orders/${sent.json.id}`, { token });
  ok("the row says so, with the reason", page.json.order.status === "cancelled" && page.json.order.cancel_reason === "supplier cannot supply");
  const twiceCancel = await call("POST", `/api/purchasing/orders/${sent.json.id}/cancel`, {
    token, body: { reason: "again" },
  });
  ok("and it cannot be cancelled twice", twiceCancel.status === 409);
  const receiveCancelled = await call("POST", `/api/purchasing/orders/${sent.json.id}/receive`, {
    token, body: { lines: [{ item_id: "nope", qty: 1 }] },
  });
  ok("nor received against", receiveCancelled.status === 409);

  say("a delivery received twice at once lands once");
  const race = await call("POST", "/api/purchasing/orders", {
    token,
    body: { client_id: "poc_" + rand(), supplier_id: supplierId, lines: [{ product_id: productB, qty: 10, unit_cost: 800 }] },
  });
  await call("POST", `/api/purchasing/orders/${race.json.id}/send`, { token });
  const racePage = await call("GET", `/api/purchasing/orders/${race.json.id}`, { token });
  const raceItem = racePage.json.lines[0].id;
  const before = await stockOf(productB);
  const both = await Promise.all(
    [0, 1].map(() =>
      call("POST", `/api/purchasing/orders/${race.json.id}/receive`, {
        token, body: { lines: [{ item_id: raceItem, qty: 10, unit_cost: 800 }] },
      }),
    ),
  );
  const landed = both.filter((r) => r.status === 200).length;
  const refused = both.filter((r) => r.status === 409).length;
  const now = await stockOf(productB);
  ok("one of the two is refused", landed === 1 && refused === 1, JSON.stringify(both.map((b) => b.status)));
  ok("and the shelf went up by ten, not twenty", now - before === 10, `${before} -> ${now}`);
  const moves = await call("GET", `/api/inventory/movements?product_id=${productB}`, { token });
  ok(
    "with one movement for it",
    moves.json.movements.filter((m) => m.ref_id === race.json.id).length === 1,
  );

  say("goods in: one press, paid in cash");
  const beforeA = await stockOf(productA);
  const gkey = "gi_" + rand();
  const gBody = {
    client_id: gkey,
    supplier_id: supplierId,
    settlement: "cash",
    reference: "note 42",
    lines: [
      { product_id: productA, qty: 24, unit_cost: 900 },
      { product_id: productB, qty: 6, unit_cost: 800 },
    ],
  };
  const gi = await call("POST", "/api/purchasing/goods-in", { token, body: gBody });
  ok("it answers with an order", gi.status === 201 && !!gi.json.id, JSON.stringify(gi.json));
  ok("totalled from the lines", gi.json.total === 24 * 900 + 6 * 800, String(gi.json.total));
  const afterA = await stockOf(productA);
  ok("stock went up", afterA - beforeA === 24, `${beforeA} -> ${afterA}`);
  const gpage = await call("GET", `/api/purchasing/orders/${gi.json.id}`, { token });
  ok("the order is already received", gpage.json.order.status === "received");
  ok("with nothing outstanding", gpage.json.lines.every((l) => l.qty === l.qty_received));
  ok("and it is flagged direct", gpage.json.order.direct === 1);
  const gmoves = await call("GET", `/api/inventory/movements?product_id=${productA}`, { token });
  ok("a movement records it", gmoves.json.movements.some((m) => m.ref_id === gi.json.id));

  const repeat = await Promise.all(
    [0, 1, 2].map(() => call("POST", "/api/purchasing/goods-in", { token, body: gBody })),
  );
  ok("tapping it again changes nothing", repeat.every((r) => r.json.id === gi.json.id));
  const afterRepeat = await stockOf(productA);
  ok("and the shelf does not move again", afterRepeat === afterA, `${afterA} -> ${afterRepeat}`);

  say("goods in: on account leaves a payable");
  const beforePay = await call("GET", "/api/purchasing/payables", { token });
  const owedBefore = beforePay.json.totals.outstanding;
  const onAcct = await call("POST", "/api/purchasing/goods-in", {
    token,
    body: {
      client_id: "gi_" + rand(),
      supplier_id: supplierId,
      settlement: "on_account",
      lines: [{ product_id: productB, qty: 5, unit_cost: 1000 }],
    },
  });
  ok("it is booked", onAcct.status === 201);
  const afterPay = await call("GET", "/api/purchasing/payables", { token });
  ok(
    "and the shop owes 5,000 more",
    afterPay.json.totals.outstanding - owedBefore === 5000,
    `${owedBefore} -> ${afterPay.json.totals.outstanding}`,
  );
  const cashInvoice = afterPay.json.invoices.find((i) => i.po_id === gi.json.id);
  ok("a cash delivery leaves nothing outstanding", cashInvoice === undefined);

  say("goods in refuses what it should");
  const noSup = await call("POST", "/api/purchasing/goods-in", {
    token, body: { supplier_id: "nope", settlement: "cash", lines: [{ product_id: productA, qty: 1, unit_cost: 1 }] },
  });
  ok("an unknown supplier is a 404", noSup.status === 404, JSON.stringify(noSup.json));
  const noLines = await call("POST", "/api/purchasing/goods-in", {
    token, body: { supplier_id: supplierId, settlement: "cash", lines: [] },
  });
  ok("no lines is refused", noLines.status === 400);
  const zero = await call("POST", "/api/purchasing/goods-in", {
    token, body: { supplier_id: supplierId, settlement: "cash", lines: [{ product_id: productA, qty: 2, unit_cost: 0 }] },
  });
  ok("and so is a delivery worth nothing", zero.status === 400, JSON.stringify(zero.json));
  const badSettle = await call("POST", "/api/purchasing/goods-in", {
    token, body: { supplier_id: supplierId, settlement: "cheque", lines: [{ product_id: productA, qty: 1, unit_cost: 1 }] },
  });
  ok("an unknown settlement is refused", badSettle.status === 400);

  say("the worksheet does not count a delivery as on order");
  const sheet = await call("GET", "/api/purchasing/worksheet?days=28", { token });
  const rowA = sheet.json.lines.find((l) => l.id === productA);
  ok("goods in never shows as on order", !rowA || rowA.on_order === 0, JSON.stringify(rowA?.on_order));

  say("the books still balance");
  const trial = await call("GET", "/api/accounting/trial-balance", { token });
  const tb = trial.json;
  ok("trial balance is square", tb.balanced !== false, JSON.stringify(tb.totals ?? tb).slice(0, 200));

  say("invoices and payments are idempotent too");
  const ikey = "inv_" + rand();
  const ibody = { client_id: ikey, supplier_id: supplierId, total: 7500, reference: "bill" };
  const i1 = await call("POST", "/api/purchasing/invoices", { token, body: ibody });
  const i2 = await call("POST", "/api/purchasing/invoices", { token, body: ibody });
  ok("one invoice from two presses", i1.json.id === i2.json.id);
  const pkey = "pay_" + rand();
  const pbody = { client_id: pkey, amount: 2500, method: "cash" };
  const p1 = await call("POST", `/api/purchasing/invoices/${i1.json.id}/pay`, { token, body: pbody });
  const p2 = await call("POST", `/api/purchasing/invoices/${i1.json.id}/pay`, { token, body: pbody });
  ok("one payment from two presses", p1.json.id === p2.json.id, JSON.stringify([p1.json, p2.json]));

  say("a refused line hands back the ones already claimed");
  const two = await call("POST", "/api/purchasing/orders", {
    token,
    body: { client_id: "poc_" + rand(), supplier_id: supplierId, lines: [
      { product_id: productA, qty: 10, unit_cost: 900 },
      { product_id: productB, qty: 10, unit_cost: 900 },
    ] },
  });
  await call("POST", `/api/purchasing/orders/${two.json.id}/send`, { token });
  const twoPage = await call("GET", `/api/purchasing/orders/${two.json.id}`, { token });
  const lineA = twoPage.json.lines.find((l) => l.product_id === productA);
  const lineB = twoPage.json.lines.find((l) => l.product_id === productB);
  await call("POST", `/api/purchasing/orders/${two.json.id}/receive`, {
    token, body: { lines: [{ item_id: lineB.id, qty: 4 }] },
  });
  const stockA0 = await stockOf(productA);
  const stale = await call("POST", `/api/purchasing/orders/${two.json.id}/receive`, {
    token, body: { lines: [{ item_id: lineA.id, qty: 10 }, { item_id: lineB.id, qty: 10 }] },
  });
  ok("the stale receipt is refused", stale.status === 409, JSON.stringify(stale.json));
  const afterStale = await call("GET", `/api/purchasing/orders/${two.json.id}`, { token });
  const lineANow = afterStale.json.lines.find((l) => l.product_id === productA);
  ok("and the line it had already claimed is handed back", lineANow.qty_received === 0,
     `qty_received = ${lineANow.qty_received}`);
  ok("with no stock moved for it", (await stockOf(productA)) === stockA0);
  const retry = await call("POST", `/api/purchasing/orders/${two.json.id}/receive`, {
    token, body: { lines: [{ item_id: lineA.id, qty: 10 }] },
  });
  ok("so it can still be received", retry.status === 200, JSON.stringify(retry.json));
  ok("and the stock lands this time", (await stockOf(productA)) - stockA0 === 10);

  say("goods in will not book a delivery that says it cost nothing");
  const free = await call("POST", "/api/purchasing/goods-in", {
    token,
    body: { supplier_id: supplierId, settlement: "cash",
      lines: [{ product_id: productA, qty: 5, unit_cost: 900 }, { product_id: productB, qty: 5 }] },
  });
  ok("a line with no cost is refused", free.status === 400, JSON.stringify(free.json));
  ok("and says why", free.json.error?.code === "no_cost", free.json.error?.code);

  say("a repeated press says it was repeated");
  const rkey = "gi_" + rand();
  const rbody = { client_id: rkey, supplier_id: supplierId, settlement: "cash",
    lines: [{ product_id: productA, qty: 2, unit_cost: 700 }] };
  const r1 = await call("POST", "/api/purchasing/goods-in", { token, body: rbody });
  const r2 = await call("POST", "/api/purchasing/goods-in", { token, body: rbody });
  ok("the first press does not claim to be a replay", r1.json.replayed === undefined);
  ok("the second says it is", r2.json.replayed === true, JSON.stringify(r2.json));
  ok("and it is the same order", r1.json.id === r2.json.id);

  say("the walk-in supplier is there out of the box");
  const sups = await call("GET", "/api/catalog/suppliers", { token });
  ok("a shop can book its own shopping without inventing a wholesaler",
     sups.json.suppliers.some((s) => s.id === "sup_cash"),
     JSON.stringify(sups.json.suppliers.map((s) => s.id)));

  say("API answers say not to keep them");
  const res = await fetch(BASE + "/api/purchasing/orders", { headers: { authorization: `Bearer ${token}` } });
  ok("no-store on a list", res.headers.get("cache-control") === "no-store");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
