// A delivery at a new shelf price, end to end, against `wrangler dev`.
//
// The old tins sold for 1000 and these are going out at 1500. The tins already
// on the shelf keep their 1000 and the till switches once that many more have
// been sold — but only when Goods In was told a new price. A delivery without
// one must leave the price exactly where it was.
//
//     npm run dev:api          # in one terminal
//     node api/test/reprice.mjs
//
// It writes to the local D1 and is safe to run repeatedly; every product it
// makes carries a random name.
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

let owner, till;

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
  owner = res.json.token;
  if (!owner) throw new Error("could not sign in: " + JSON.stringify(res.json));

  await call("POST", "/api/staff", { token: owner, body: { name: "Thida M.", role: "sale_staff", pin: "4471" } });
  const pin = await call("POST", "/api/auth/pin", { body: { pin: "4471", register_id: "reg_1" } });
  till = pin.json.token;
  if (!till) throw new Error("could not open the lane: " + JSON.stringify(pin.json));
  await call("POST", "/api/shifts/open", {
    token: owner,
    body: { register_id: "reg_1", opening_float: 50000, user_id: pin.json.user.id },
  });
  const basket = await call("GET", "/api/till/basket", { token: till });
  for (const line of basket.json.lines ?? []) {
    await call("DELETE", `/api/till/line/${line.id}`, { token: till });
  }
}

async function product(price) {
  const r = await call("POST", "/api/catalog/products", {
    token: owner,
    body: { name: "Tins " + rand(), sku: "SKU" + rand(), price, cost: 700, unit: "each" },
  });
  if (!r.json.id) throw new Error("product: " + JSON.stringify(r.json));
  return r.json.id;
}

const goodsIn = (lines) =>
  call("POST", "/api/purchasing/goods-in", {
    token: owner,
    body: { client_id: "gi_" + rand(), supplier_id: "sup_cash", settlement: "cash", lines },
  });

const look = async (id) => (await call("GET", `/api/catalog/products/${id}`, { token: owner })).json;
const scan = (id) => call("POST", "/api/till/scan", { token: till, body: { product_id: id, qty: 1 } });
const pay = (total) =>
  call("POST", "/api/till/pay", {
    token: till,
    body: { payments: [{ method: "cash", amount: total, tendered: total }] },
  });

async function main() {
  await signIn();

  say("a delivery without a new price leaves the price alone");
  const plain = await product(1000);
  await goodsIn([{ product_id: plain, qty: 5, unit_cost: 800 }]);
  let p = await look(plain);
  ok("still 1000", p.product.price === 1000, JSON.stringify(p.product.price));
  ok("nothing waiting", p.waiting.length === 0, JSON.stringify(p.waiting));

  say("the old stock sells out at the old price first");
  const tins = await product(1000);
  await goodsIn([{ product_id: tins, qty: 3, unit_cost: 700 }]);
  const gi = await goodsIn([{ product_id: tins, qty: 2, unit_cost: 1100, new_price: 1500 }]);
  ok("the delivery is booked", gi.status === 201, JSON.stringify(gi.json));
  p = await look(tins);
  ok("the shelf price is still 1000", p.product.price === 1000, JSON.stringify(p.product.price));
  ok("stock is all five", p.product.stock === 5, JSON.stringify(p.product.stock));
  ok(
    "3 left at 1000, then 1500",
    JSON.stringify(p.waiting) === JSON.stringify([{ price: 1000, left: 3 }, { price: 1500, left: null }]),
    JSON.stringify(p.waiting),
  );

  let sale;
  for (let i = 0; i < 4; i++) sale = await scan(tins);
  const lines = sale.json.lines ?? [];
  ok("the basket splits at the switch", lines.length === 2, JSON.stringify(lines.map((l) => [l.qty, l.unit_price])));
  ok("three at 1000", lines.some((l) => l.qty === 3 && l.unit_price === 1000));
  ok("the fourth at 1500", lines.some((l) => l.qty === 1 && l.unit_price === 1500));
  ok("total 4500", sale.json.sale?.total === 4500, JSON.stringify(sale.json.sale?.total));
  const paid = await pay(4500);
  ok("paid", paid.status === 200, JSON.stringify(paid.json));
  p = await look(tins);
  ok("the price is 1500 now", p.product.price === 1500, JSON.stringify(p.product.price));
  ok("and nothing is waiting any more", p.waiting.length === 0, JSON.stringify(p.waiting));

  say("a later plain delivery keeps the new price");
  await goodsIn([{ product_id: tins, qty: 10, unit_cost: 1100 }]);
  p = await look(tins);
  ok("still 1500", p.product.price === 1500, JSON.stringify(p.product.price));

  say("a new price onto an empty shelf is in force at once");
  const empty = await product(1000);
  await goodsIn([{ product_id: empty, qty: 4, unit_cost: 900, new_price: 1200 }]);
  p = await look(empty);
  ok("1200 straight away", p.product.price === 1200, JSON.stringify(p.product.price));
  ok("nothing waiting", p.waiting.length === 0, JSON.stringify(p.waiting));

  say("two new prices queue behind each other");
  const two = await product(1000);
  await goodsIn([{ product_id: two, qty: 2, unit_cost: 700 }]);
  await goodsIn([{ product_id: two, qty: 2, unit_cost: 1100, new_price: 1500 }]);
  await goodsIn([{ product_id: two, qty: 2, unit_cost: 1400, new_price: 2000 }]);
  p = await look(two);
  ok(
    "2 at 1000, 2 at 1500, then 2000",
    JSON.stringify(p.waiting) ===
      JSON.stringify([{ price: 1000, left: 2 }, { price: 1500, left: 2 }, { price: 2000, left: null }]),
    JSON.stringify(p.waiting),
  );

  say("a price typed in by hand cancels what was waiting");
  const edit = await call("PATCH", `/api/catalog/products/${two}`, {
    token: owner,
    body: { ...p.product, price: 1800 },
  });
  ok("saved", edit.status === 200, JSON.stringify(edit.json));
  p = await look(two);
  ok("1800", p.product.price === 1800, JSON.stringify(p.product.price));
  ok("nothing waiting", p.waiting.length === 0, JSON.stringify(p.waiting));

  say("a save that leaves the price alone keeps the queue");
  const keep = await product(1000);
  await goodsIn([{ product_id: keep, qty: 2, unit_cost: 700 }]);
  await goodsIn([{ product_id: keep, qty: 2, unit_cost: 1100, new_price: 1500 }]);
  p = await look(keep);
  await call("PATCH", `/api/catalog/products/${keep}`, { token: owner, body: { ...p.product, name: p.product.name + "!" } });
  p = await look(keep);
  ok("still waiting", p.waiting.length === 2, JSON.stringify(p.waiting));

  say("a negative new price is refused");
  const neg = await goodsIn([{ product_id: keep, qty: 1, unit_cost: 700, new_price: -5 }]);
  ok("400 bad_price", neg.json.error?.code === "bad_price", JSON.stringify(neg.json));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
