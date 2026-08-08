import type { MiddlewareHandler } from "hono";
import type { Ctx, Role, Actor } from "../env.js";
import { now } from "../env.js";
import { one, run } from "./db.js";
import { forbidden, unauthorized } from "./http.js";
import { verifySecret } from "./crypto.js";

/**
 * Who is asking.
 *
 * The token arrives in `Authorization: Bearer`, never in a cookie. The till and
 * the back office are on different origins from this Worker, and a cookie that
 * works cross-origin has to be `SameSite=None`, which is the setting CSRF
 * exists inside. A bearer token is not sent by the browser on its own, so there
 * is no cross-site request to forge.
 */
export const authenticate: MiddlewareHandler<Ctx> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length === 0) throw unauthorized("no session");

  const row = await one<{
    token: string;
    user_id: string;
    register_id: string | null;
    expires_at: number;
    name: string;
    role: Role;
    active: number;
  }>(
    c.env.DB,
    `SELECT s.token, s.user_id, s.register_id, s.expires_at, u.name, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?1`,
    token,
  );

  if (!row) throw unauthorized("that session is not known");
  if (row.expires_at <= now()) {
    await run(c.env.DB, "DELETE FROM sessions WHERE token = ?1", token);
    throw unauthorized("that session has expired");
  }
  // Deactivating somebody has to take effect at the lane they are standing at,
  // not at their next sign-in.
  if (row.active !== 1) throw unauthorized("that account is no longer active");

  const actor: Actor = {
    token: row.token,
    userId: row.user_id,
    name: row.name,
    role: row.role,
    registerId: row.register_id,
  };
  c.set("actor", actor);
  await next();
};

const RANK: Record<Role, number> = { sale_staff: 0, manager: 1, owner: 2 };

/** A gate on the whole route: the back office, or one of its corners. */
export const requireRole =
  (least: Role): MiddlewareHandler<Ctx> =>
  async (c, next) => {
    const actor = c.get("actor");
    if (RANK[actor.role] < RANK[least]) throw forbidden();
    await next();
  };

export const isManager = (role: Role): boolean => RANK[role] >= RANK.manager;

/**
 * A command a PIN cannot lend.
 *
 * The command matrix has three columns for a reason: `always` anybody may do,
 * `manager_pin` a cashier may do with a manager's PIN entered at the lane, and
 * `manager_only` is marked ✗ for sale staff — voiding a whole sale, opening the
 * drawer outside a transaction, and closing a lane. Those need a manager
 * *signed in*, and this is the check that says so.
 *
 * It replaced `actor.role === "sale_staff" && approvedBy === actor.userId`,
 * which could never be true: `approvalFor` either throws for a cashier or
 * returns the approving manager's id, never the caller's own. The guard read
 * like a gate and was dead code, so a cashier holding any manager's PIN could
 * do all three.
 */
export function requireManagerSession(actor: Actor, what: string): void {
  if (!isManager(actor.role)) {
    throw forbidden(`${what} needs a manager signed in — a PIN cannot lend it`);
  }
}

/**
 * A manager standing at the lane, proving it.
 *
 * This is the "PIN" column of the command matrix: a cashier may take a line
 * discount, override a price, or return an item, but only with a manager's PIN
 * entered on the spot. The approval is returned rather than merely checked, so
 * the caller can write it into `audit_log` — an authorisation nobody can name
 * afterwards is not an authorisation.
 *
 * A manager doing it themselves needs no second person, so their own session is
 * the approval and no PIN is asked for.
 */
export async function approvalFor(
  db: D1Database,
  actor: Actor,
  managerPin: string | undefined,
): Promise<string> {
  if (isManager(actor.role)) return actor.userId;
  if (!managerPin) throw forbidden("a manager has to approve that");

  const candidates = await db
    .prepare(
      `SELECT id, pin_hash FROM users
        WHERE active = 1 AND role IN ('manager', 'owner') AND pin_hash IS NOT NULL`,
    )
    .all<{ id: string; pin_hash: string }>();

  for (const row of candidates.results ?? []) {
    if (await verifySecret(managerPin, row.pin_hash)) return row.id;
  }
  throw forbidden("that manager PIN was not recognised");
}
