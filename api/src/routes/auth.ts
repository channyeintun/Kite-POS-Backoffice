import { Hono } from "hono";
import type { Ctx, Role } from "../env.js";
import { now } from "../env.js";
import { all, one, run, settingInt, readSettings } from "../lib/db.js";
import { hashSecret, newId, newToken, verifySecret } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, optStr, str, unauthorized } from "../lib/http.js";
import { authenticate } from "../lib/auth.js";

export const auth = new Hono<Ctx>();

const LOCKOUT_AFTER = 5;
const LOCKOUT_SECONDS = 120;

/**
 * The lockout, read and enforced.
 *
 * Scoped to the lane rather than to a person, because a PIN sign-in does not
 * yet know who is asking — that is the thing it is trying to work out. A lane
 * that has failed five times in a row stops accepting PINs for two minutes,
 * which is what turns an exhaustive search of ten thousand possibilities from
 * twenty minutes of tapping into something nobody finishes standing at a
 * counter.
 */
async function guardAttempts(db: D1Database, scope: string): Promise<void> {
  const row = await one<{ locked_until: number }>(
    db,
    "SELECT locked_until FROM sign_in_attempts WHERE scope = ?1",
    scope,
  );
  if (row && row.locked_until > now()) {
    const wait = row.locked_until - now();
    throw new Response(
      JSON.stringify({
        error: { code: "locked_out", message: `too many attempts — wait ${wait}s` },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }
}

async function recordFailure(db: D1Database, scope: string): Promise<void> {
  await run(
    db,
    `INSERT INTO sign_in_attempts (scope, failures, locked_until, last_at)
     VALUES (?1, 1, 0, ?2)
     ON CONFLICT (scope) DO UPDATE SET
       failures = failures + 1,
       last_at = ?2,
       locked_until = CASE WHEN failures + 1 >= ?3 THEN ?2 + ?4 ELSE 0 END`,
    scope,
    now(),
    LOCKOUT_AFTER,
    LOCKOUT_SECONDS,
  );
}

const clearFailures = (db: D1Database, scope: string) =>
  run(db, "DELETE FROM sign_in_attempts WHERE scope = ?1", scope);

async function issue(
  db: D1Database,
  userId: string,
  registerId: string | null,
  hours: number,
): Promise<{ token: string; expiresAt: number }> {
  const token = newToken();
  const at = now();
  const expiresAt = at + hours * 3600;
  await db
    .batch([
      db
        .prepare(
          `INSERT INTO sessions (token, user_id, register_id, issued_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(token, userId, registerId, at, expiresAt),
      db.prepare("UPDATE users SET last_seen_at = ?2 WHERE id = ?1").bind(userId, at),
      // Housekeeping on the one request a day that is not time-critical.
      db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(at),
    ]);
  return { token, expiresAt };
}

const sessionHours = (env: { SESSION_HOURS: string }): number => {
  const value = Number(env.SESSION_HOURS);
  return Number.isFinite(value) && value > 0 ? value : 14;
};

/**
 * First run: the owner account.
 *
 * Refuses once any user exists, so this cannot be used to add a second owner to
 * a live shop. That check and the insert are one statement — a conditional
 * INSERT ... SELECT — because two people running setup against a fresh database
 * at the same moment is exactly the race a read-then-write loses.
 */
auth.post("/setup", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = str(body, "name");
  const username = str(body, "username");
  const password = str(body, "password");
  if (password.length < 8) throw badRequest("weak_password", "use at least 8 characters");

  const id = newId("usr");
  const hash = await hashSecret(password, "password");
  const result = await run(
    c.env.DB,
    `INSERT INTO users (id, name, role, username, password_hash, active, created_at)
     SELECT ?1, ?2, 'owner', ?3, ?4, 1, ?5
      WHERE NOT EXISTS (SELECT 1 FROM users)`,
    id,
    name,
    username,
    hash,
    now(),
  );
  if (result.meta.changes === 0) {
    throw conflict("already_set_up", "this shop already has staff — sign in instead");
  }
  return c.json({ ok: true, user: { id, name, role: "owner" as Role } });
});

/** Whether setup has been done, so the sign-in page knows which form to show. */
auth.get("/setup", async (c) => {
  const row = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM users");
  const settings = await readSettings(c.env.DB);
  return c.json({
    needs_setup: (row?.n ?? 0) === 0,
    shop_name: settings["shop.name"] ?? "",
    locale: settings["locale.default"] ?? "en",
  });
});

/**
 * A cashier's PIN, at a lane.
 *
 * There is no username: the pad is built for a touchscreen and a queue, and
 * asking who you are before asking for four digits doubles the taps at the
 * busiest moment of the day. So the PIN is checked against every active member
 * of sale staff, which is why `crypto.ts` uses a lower iteration count for PINs
 * and puts the real defence in the lockout above.
 *
 * A manager may also sign in at a lane with their PIN, to authorise or to take
 * a lane over — but a PIN never opens the back office, which needs a password.
 */
auth.post("/pin", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pin = str(body, "pin");
  const registerId = optStr(body, "register_id", "reg_1");
  const scope = `pin:${registerId}`;

  await guardAttempts(c.env.DB, scope);

  const register = await one<{ id: string; active: number }>(
    c.env.DB,
    "SELECT id, active FROM registers WHERE id = ?1",
    registerId,
  );
  if (!register || register.active !== 1) throw badRequest("no_register", "that lane is not set up");

  const candidates = await all<{ id: string; name: string; role: Role; pin_hash: string }>(
    c.env.DB,
    "SELECT id, name, role, pin_hash FROM users WHERE active = 1 AND pin_hash IS NOT NULL",
  );

  for (const user of candidates) {
    if (await verifySecret(pin, user.pin_hash)) {
      await clearFailures(c.env.DB, scope);
      const { token, expiresAt } = await issue(
        c.env.DB,
        user.id,
        registerId,
        sessionHours(c.env),
      );
      await run(c.env.DB, "UPDATE registers SET last_seen_at = ?2 WHERE id = ?1", registerId, now());
      return c.json({
        token,
        expires_at: expiresAt,
        user: { id: user.id, name: user.name, role: user.role },
        register_id: registerId,
        app: "pos",
      });
    }
  }

  await recordFailure(c.env.DB, scope);
  throw unauthorized("that PIN was not recognised");
});

/**
 * A manager's password, for the back office.
 *
 * Sale staff are refused here even with the right password, because the role is
 * what decides which app a sign-in opens and there is no navigation between
 * them. A cashier who guesses a manager's password still cannot open the books
 * from a lane — they would have to sign in here, which is the same door.
 */
auth.post("/password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = str(body, "username");
  const password = str(body, "password");
  const scope = `pw:${username.toLowerCase()}`;

  await guardAttempts(c.env.DB, scope);

  const user = await one<{
    id: string;
    name: string;
    role: Role;
    password_hash: string | null;
    active: number;
  }>(
    c.env.DB,
    "SELECT id, name, role, password_hash, active FROM users WHERE username = ?1",
    username,
  );

  // The hash is verified even when there is no such user, against a throwaway
  // digest, so "no such username" and "wrong password" take the same time. A
  // fast refusal is a user enumeration oracle.
  const stored =
    user?.password_hash ??
    "password$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = await verifySecret(password, stored);

  if (!user || !ok || user.active !== 1) {
    await recordFailure(c.env.DB, scope);
    throw unauthorized("that username and password do not match");
  }
  if (user.role === "sale_staff") {
    await recordFailure(c.env.DB, scope);
    throw forbidden("sale staff sign in with a PIN at the lane");
  }

  await clearFailures(c.env.DB, scope);
  const { token, expiresAt } = await issue(c.env.DB, user.id, null, sessionHours(c.env));
  return c.json({
    token,
    expires_at: expiresAt,
    user: { id: user.id, name: user.name, role: user.role },
    register_id: null,
    app: "office",
  });
});

auth.post("/sign-out", authenticate, async (c) => {
  await run(c.env.DB, "DELETE FROM sessions WHERE token = ?1", c.get("actor").token);
  return c.json({ ok: true });
});

/** Who this token belongs to — what a reloaded page asks before drawing. */
auth.get("/me", authenticate, async (c) => {
  const actor = c.get("actor");
  const settings = await readSettings(c.env.DB);
  const openShift = actor.registerId
    ? await one<{ id: string; opening_float: number; opened_at: number }>(
        c.env.DB,
        "SELECT id, opening_float, opened_at FROM shifts WHERE register_id = ?1 AND closed_at IS NULL",
        actor.registerId,
      )
    : null;
  return c.json({
    user: { id: actor.userId, name: actor.name, role: actor.role },
    register_id: actor.registerId,
    app: actor.role === "sale_staff" ? "pos" : "office",
    shift: openShift,
    shop: {
      name: settings["shop.name"] ?? "",
      currency: settings["currency.code"] ?? "MMK",
      symbol: settings["currency.symbol"] ?? "K",
      minor_units: settingInt(settings, "currency.minor_units", 0),
      symbol_first: (settings["currency.symbol_first"] ?? "1") === "1",
      locale: settings["locale.default"] ?? "en",
    },
  });
});
