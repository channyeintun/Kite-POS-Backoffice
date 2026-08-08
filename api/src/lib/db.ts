import type { Currency } from "./money.js";
import { notFound } from "./http.js";

/** One row, or null. */
export async function one<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  return await db
    .prepare(sql)
    .bind(...binds)
    .first<T>();
}

/** One row, or a 404 naming what was looked for. */
export async function need<T>(
  db: D1Database,
  what: string,
  sql: string,
  ...binds: unknown[]
): Promise<T> {
  const row = await one<T>(db, sql, ...binds);
  if (!row) throw notFound(`${what} is not here`);
  return row;
}

export async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return result.results ?? [];
}

export async function run(db: D1Database, sql: string, ...binds: unknown[]): Promise<D1Result> {
  return await db
    .prepare(sql)
    .bind(...binds)
    .run();
}

/**
 * Several statements as one unit.
 *
 * D1's `batch` runs them in a transaction and rolls the lot back if any fails,
 * which is the guarantee a sale needs: the lines, the totals, the stock
 * movements and the postings either all land or none do. There is no
 * interactive transaction on D1, so anything that has to *read* between writes
 * is structured as a conditional write instead — see `sales.ts`, where "this
 * basket must still be held" is a WHERE clause rather than a SELECT followed by
 * an UPDATE that assumes the answer has not changed.
 */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return await db.batch(statements);
}

export const stmt = (db: D1Database, sql: string, ...binds: unknown[]): D1PreparedStatement =>
  db.prepare(sql).bind(...binds);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type Settings = Record<string, string>;

export async function readSettings(db: D1Database): Promise<Settings> {
  const rows = await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  const out: Settings = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export const settingInt = (s: Settings, key: string, fallback: number): number => {
  const raw = s[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const settingBool = (s: Settings, key: string, fallback: boolean): boolean => {
  const raw = s[key];
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true";
};

export function currencyOf(s: Settings): Currency {
  return {
    code: s["currency.code"] ?? "MMK",
    symbol: s["currency.symbol"] ?? "K",
    minorUnits: settingInt(s, "currency.minor_units", 0),
    symbolFirst: settingBool(s, "currency.symbol_first", true),
  };
}

/**
 * The next value of a counter, allocated atomically.
 *
 * `UPDATE ... RETURNING` is one statement, so two tills asking for a sale
 * number at the same moment get two numbers. Read-then-write would give them
 * the same one, and a receipt number is the thing a customer quotes on the
 * phone a week later.
 */
export async function nextNumber(db: D1Database, name: string): Promise<number> {
  const row = await one<{ value: number }>(
    db,
    "UPDATE counters SET value = value + 1 WHERE name = ?1 RETURNING value",
    name,
  );
  if (!row) throw new Error(`no counter named ${name}`);
  return row.value;
}
