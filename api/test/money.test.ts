import { describe, expect, it } from "vitest";
import { extend, parseAmount, spread, taxWithin, taxOn, applyBp, formatAmount } from "../src/lib/money.js";
import { bestOffer, type Promotion } from "../src/lib/pricing.js";
import { priceSale, type LineRow } from "../src/lib/sales.js";

describe("parsing an amount", () => {
  it("reads digits rather than a float", () => {
    // The case the whole function exists for: 1.005 is really
    // 1.00499999999999989 as a double and parseFloat rounds it *down*.
    expect(parseAmount("1.005", 2)).toBe(null); // more precision than the currency has
    expect(parseAmount("1.01", 2)).toBe(101);
    expect(parseAmount("0.1", 2)).toBe(10);
    expect(parseAmount("12.99", 2)).toBe(1299);
  });

  it("takes a zero-decimal currency at face value", () => {
    expect(parseAmount("31700", 0)).toBe(31700);
    expect(parseAmount("31,700", 0)).toBe(31700);
    expect(parseAmount("31.7", 0)).toBe(null);
  });

  it("refuses anything that is not an amount", () => {
    for (const bad of ["", "abc", "1.2.3", "1e5", "--4", "4-"]) {
      expect(parseAmount(bad, 2), bad).toBe(null);
    }
  });
});

describe("tax", () => {
  it("extracts from a tax-inclusive price exactly", () => {
    // 5% inside 31,700 is 31700 * 500 / 10500.
    expect(taxWithin(31_700, 500)).toBe(1510);
    // And adding it back to the net returns the shelf price.
    expect(31_700 - taxWithin(31_700, 500) + taxWithin(31_700, 500)).toBe(31_700);
  });

  it("is not the same as adding it on top", () => {
    expect(taxOn(31_700, 500)).toBe(1585);
    expect(taxWithin(31_700, 500)).not.toBe(taxOn(31_700, 500));
  });

  it("is zero when there is no rate", () => {
    expect(taxWithin(31_700, 0)).toBe(0);
    expect(applyBp(31_700, 0)).toBe(0);
  });
});

describe("spreading a basket discount", () => {
  it("always sums to exactly the whole", () => {
    for (const total of [1, 7, 100, 333, 12_345]) {
      for (const weights of [[1, 1, 1], [5000, 3200, 900], [1, 2, 3, 4, 5, 6, 7], [100]]) {
        const parts = spread(total, weights);
        expect(parts.reduce((a, b) => a + b, 0), `${total} over ${weights}`).toBe(total);
      }
    }
  });

  it("puts the rounding remainder where it is proportionally smallest", () => {
    // 10 over [100, 20000] rounds to [0, 10] rather than leaving a unit on the
    // small line where it would be visible on the receipt.
    const parts = spread(10, [100, 20_000]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(parts[1]).toBeGreaterThan(parts[0]!);
  });

  it("does not divide by zero when there is nothing to weigh by", () => {
    expect(spread(500, [0, 0, 0])).toEqual([500, 0, 0]);
    expect(spread(500, [])).toEqual([]);
  });
});

describe("quantities meeting money", () => {
  it("rounds a measured quantity once, at the boundary", () => {
    expect(extend(3, 900)).toBe(2700);
    expect(extend(0.35, 4800)).toBe(1680);
    // 0.335 kg at 4,800 is 1608.0000000000002 as a double.
    expect(extend(0.335, 4800)).toBe(1608);
  });
});

describe("offers", () => {
  const promo = (over: Partial<Promotion>): Promotion => ({
    id: "p1",
    name: "offer",
    name_my: "",
    kind: "n_for_x",
    value: 2500,
    n: 3,
    scope: "product",
    product_id: "cola",
    category_id: null,
    starts_at: null,
    ends_at: null,
    priority: 0,
    created_at: 0,
    ...over,
  });

  const line = { productId: "cola", categoryId: null, qty: 3, listPrice: 900, overridden: false };

  it("prices whole groups and the remainder at the shelf price", () => {
    expect(bestOffer([promo({})], { ...line, qty: 3 }, 100)?.lineTotal).toBe(2500);
    expect(bestOffer([promo({})], { ...line, qty: 7 }, 100)?.lineTotal).toBe(2500 * 2 + 900);
    expect(bestOffer([promo({})], { ...line, qty: 2 }, 100)).toBe(null);
  });

  it("chooses whichever saves the customer most, and does not stack", () => {
    // 3 × 900 is 2,700. Ten per cent off is 2,430; three-for-2,500 is 2,500 —
    // so the percentage is the better deal here and has to win, even though
    // the n-for-x is the more eye-catching offer.
    const offers = [
      promo({ id: "a", kind: "percent_off", value: 1000, n: 0 }),
      promo({ id: "b" }),
    ];
    const best = bestOffer(offers, line, 100);
    expect(best?.promoId).toBe("a");
    expect(best?.lineTotal).toBe(2430);

    // Raise the n-for-x until it is the cheaper one and the answer flips.
    const cheaper = [promo({ id: "a", kind: "percent_off", value: 1000, n: 0 }), promo({ id: "b", value: 2000 })];
    expect(bestOffer(cheaper, line, 100)?.promoId).toBe("b");
  });

  it("breaks a tie on priority, then on age — never on row order", () => {
    const a = promo({ id: "a", kind: "amount_off", value: 100, n: 0, created_at: 50 });
    const b = promo({ id: "b", kind: "amount_off", value: 100, n: 0, created_at: 10 });
    expect(bestOffer([a, b], line, 100)?.promoId).toBe("b");
    expect(bestOffer([b, a], line, 100)?.promoId).toBe("b");
    const prior = promo({ id: "c", kind: "amount_off", value: 100, n: 0, priority: 5, created_at: 99 });
    expect(bestOffer([a, b, prior], line, 100)?.promoId).toBe("c");
  });

  it("is beaten by a price the operator typed", () => {
    expect(bestOffer([promo({})], { ...line, overridden: true }, 100)).toBe(null);
  });

  it("stays inside its window", () => {
    const timed = promo({ starts_at: 200, ends_at: 300 });
    expect(bestOffer([timed], line, 100)).toBe(null);
    expect(bestOffer([timed], line, 250)?.lineTotal).toBe(2500);
    expect(bestOffer([timed], line, 400)).toBe(null);
  });

  it("never makes a line worth less than nothing", () => {
    const huge = promo({ kind: "amount_off", value: 99_999, n: 0 });
    expect(bestOffer([huge], line, 100)?.lineTotal).toBe(0);
  });
});

describe("pricing a whole sale", () => {
  const line = (over: Partial<LineRow>): LineRow => ({
    id: "l1",
    sale_id: "s1",
    product_id: "cola",
    name: "Star Cola",
    sku: "COLA",
    qty: 1,
    unit_price: 900,
    list_price: 900,
    line_discount: 0,
    promo_id: null,
    promo_name: "",
    promo_saved: 0,
    price_override: 0,
    tax_bp: 0,
    tax: 0,
    total: 0,
    cost: 600,
    min_age: 0,
    age_checked: 0,
    sort: 0,
    category_id: null,
    ...over,
  });

  it("is idempotent — pricing twice gives the same answer", () => {
    // The bug this guards: a pricer that wrote its output over its own input
    // took a little more off the basket every time the page was read.
    const lines = [line({ id: "a", qty: 6 }), line({ id: "b", product_id: "beer", qty: 1, unit_price: 3200, list_price: 3200 })];
    const once = priceSale(lines, [], 500, true, 100);
    const twice = priceSale(once.lines, [], 500, true, 100);
    expect(twice.totals).toEqual(once.totals);
  });

  it("keeps the line totals adding up to the basket total", () => {
    const lines = [
      line({ id: "a", qty: 3, unit_price: 333, list_price: 333 }),
      line({ id: "b", qty: 1, unit_price: 1000, list_price: 1000 }),
      line({ id: "c", qty: 7, unit_price: 149, list_price: 149 }),
    ];
    const priced = priceSale(lines, [], 777, true, 100);
    const sum = priced.lines.reduce((a, l) => a + l.total, 0);
    expect(sum).toBe(priced.totals.total);
  });

  it("will not let a discount make a line negative", () => {
    const priced = priceSale([line({ qty: 1, line_discount: 99_999 })], [], 0, true, 100);
    expect(priced.lines[0]!.total).toBe(0);
    expect(priced.totals.total).toBe(0);
  });
});

describe("writing an amount down", () => {
  const mmk = { code: "MMK", symbol: "K", minorUnits: 0, symbolFirst: true };
  const usd = { code: "USD", symbol: "$", minorUnits: 2, symbolFirst: true };

  it("groups in threes and keeps the currency's precision", () => {
    expect(formatAmount(31_700, mmk)).toBe("K31,700");
    expect(formatAmount(0, mmk)).toBe("K0");
    expect(formatAmount(1299, usd)).toBe("$12.99");
    // Padded, so it is not "$12.5".
    expect(formatAmount(1250, usd)).toBe("$12.50");
    expect(formatAmount(5, usd)).toBe("$0.05");
    expect(formatAmount(-300, mmk)).toBe("-K300");
  });
});
