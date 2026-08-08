import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * A refusal the client can act on.
 *
 * `code` is for the program and `message` is for the operator, and they are
 * separate because the two audiences want different things: the till branches
 * on `age_check_required` to open a dialog, and the cashier reads the sentence.
 */
export class Refused extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(status, {
      res: Response.json({ error: { code, message, ...(extra ?? {}) } }, { status }),
    });
  }
}

export const badRequest = (code: string, message: string, extra?: Record<string, unknown>) =>
  new Refused(400, code, message, extra);
export const unauthorized = (message = "sign in again") =>
  new Refused(401, "unauthorized", message);
export const forbidden = (message = "that needs a manager") =>
  new Refused(403, "forbidden", message);
export const notFound = (what = "that is not here") => new Refused(404, "not_found", what);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new Refused(409, code, message, extra);

/**
 * A required field, read as a string.
 *
 * Anything absent is refused rather than read as empty, because a missing
 * `product_id` that becomes `""` is a lookup that quietly finds nothing.
 */
export function str(body: unknown, field: string): string {
  const value = (body as Record<string, unknown>)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest("bad_field", `${field} is required`);
  }
  return value;
}

export function optStr(body: unknown, field: string, fallback = ""): string {
  const value = (body as Record<string, unknown>)?.[field];
  return typeof value === "string" ? value : fallback;
}

/**
 * A whole number of minor units.
 *
 * Refuses anything that is not already an integer. A price that arrives as
 * `1.005` is a bug upstream, and rounding it here would hide which side of the
 * boundary the float got in.
 */
export function int(body: unknown, field: string): number {
  const value = (body as Record<string, unknown>)?.[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest("bad_field", `${field} must be a whole number`);
  }
  return value;
}

export function optInt(body: unknown, field: string, fallback: number): number {
  const value = (body as Record<string, unknown>)?.[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest("bad_field", `${field} must be a whole number`);
  }
  return value;
}

/** A quantity. The one place a fraction is legitimate. */
export function num(body: unknown, field: string, fallback?: number): number {
  const value = (body as Record<string, unknown>)?.[field];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest("bad_field", `${field} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest("bad_field", `${field} must be a number`);
  }
  return value;
}

export function bool(body: unknown, field: string, fallback: boolean): boolean {
  const value = (body as Record<string, unknown>)?.[field];
  return typeof value === "boolean" ? value : fallback;
}

/** One of a fixed set, or a refusal naming the set. */
export function oneOf<T extends string>(body: unknown, field: string, allowed: readonly T[]): T {
  const value = str(body, field);
  if (!(allowed as readonly string[]).includes(value)) {
    throw badRequest("bad_field", `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
