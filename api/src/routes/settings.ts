import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { batch, readSettings, stmt } from "../lib/db.js";
import { badRequest, forbidden } from "../lib/http.js";

export const settings = new Hono<Ctx>();

/**
 * What a shop may configure.
 *
 * An allow list rather than a free-form key-value store, because settings are
 * read by name all over this application and a typo that creates
 * `curency.code` would be a silent fallback to the default rather than an
 * error. A key not on this list is refused.
 */
const WRITABLE = new Set([
  "shop.name",
  "shop.name_my",
  "shop.address",
  "shop.phone",
  "shop.tax_id",
  "shop.receipt_footer",
  "currency.code",
  "currency.symbol",
  "currency.minor_units",
  "currency.symbol_first",
  "tax.inclusive",
  "tax.default_bp",
  "locale.default",
  "loyalty.points_per_unit",
  "accounting.enabled",
  "accounting.started_at",
]);

settings.get("/", async (c) => {
  return c.json({ settings: await readSettings(c.env.DB) });
});

settings.patch("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const actor = c.get("actor");

  const statements = [];
  for (const [key, value] of Object.entries(body)) {
    if (!WRITABLE.has(key)) throw badRequest("unknown_setting", `${key} is not a setting`);
    if (typeof value !== "string") {
      throw badRequest("bad_value", `${key} has to be sent as a string`);
    }
    // Changing the currency's minor units reinterprets every integer already in
    // the database — 31700 kyat would become 317.00 of something. It is an
    // owner's decision and a migration, not a setting to flip on a Tuesday.
    if (key === "currency.minor_units" && actor.role !== "owner") {
      throw forbidden("only an owner can change the currency");
    }
    if (key === "currency.minor_units" && !/^[0-3]$/.test(value)) {
      throw badRequest("bad_value", "minor units are 0 to 3");
    }
    statements.push(
      stmt(
        c.env.DB,
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
        key,
        value,
        now(),
      ),
    );
  }
  if (statements.length === 0) throw badRequest("nothing_to_do", "no settings were sent");
  await batch(c.env.DB, statements);
  return c.json({ settings: await readSettings(c.env.DB) });
});
