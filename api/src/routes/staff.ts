import { Hono } from "hono";
import type { Ctx, Role } from "../env.js";
import { now } from "../env.js";
import { all, one, run } from "../lib/db.js";
import { hashSecret, newId, verifySecret } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, bool, oneOf, optStr, str } from "../lib/http.js";
import { COMMANDS } from "../lib/commands.js";

export const staff = new Hono<Ctx>();

staff.get("/", async (c) => {
  const rows = await all<{
    id: string;
    name: string;
    role: Role;
    username: string | null;
    active: number;
    created_at: number;
    last_seen_at: number | null;
    has_pin: number;
    at_lane: string | null;
  }>(
    c.env.DB,
    `SELECT u.id, u.name, u.role, u.username, u.active, u.created_at, u.last_seen_at,
            (u.pin_hash IS NOT NULL) AS has_pin,
            (SELECT r.name FROM sessions s JOIN registers r ON r.id = s.register_id
              WHERE s.user_id = u.id AND s.expires_at > ?1
              ORDER BY s.issued_at DESC LIMIT 1) AS at_lane
       FROM users u ORDER BY u.role DESC, u.name`,
    now(),
  );
  return c.json({
    staff: rows.map((u) => ({
      ...u,
      // What a role means, said once here rather than in two front ends.
      app: u.role === "sale_staff" ? "pos" : "office",
      signs_in_with: u.role === "sale_staff" ? "pin" : "password",
    })),
    // The command matrix the till builds its bar from, so the back office can
    // show the same table without a second copy of it.
    matrix: COMMANDS.map((cmd) => ({
      command: cmd.label,
      sale_staff: cmd.gate === "always" ? "yes" : cmd.gate === "manager_pin" ? "pin" : "no",
      manager: "yes",
      confirm: cmd.confirm,
    })),
  });
});

/**
 * A PIN has to be unique among the people who can use one.
 *
 * The lane asks for four digits and nothing else, so two people sharing a PIN
 * would make "who rang this sale" unanswerable — and the first match wins,
 * silently. Checking at the point a PIN is set is the only place this can be
 * enforced, because the sign-in path cannot tell a collision from a match.
 */
async function pinIsFree(db: D1Database, pin: string, exceptUserId: string | null): Promise<boolean> {
  const rows = await all<{ id: string; pin_hash: string }>(
    db,
    "SELECT id, pin_hash FROM users WHERE pin_hash IS NOT NULL AND active = 1",
  );
  for (const row of rows) {
    if (row.id === exceptUserId) continue;
    if (await verifySecret(pin, row.pin_hash)) return false;
  }
  return true;
}

const validPin = (pin: string) => /^\d{4,8}$/.test(pin);

staff.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const role = oneOf(body, "role", ["sale_staff", "manager", "owner"] as const);
  if (role === "owner" && actor.role !== "owner") {
    throw forbidden("only an owner can appoint another owner");
  }

  const name = str(body, "name");
  const pin = optStr(body, "pin");
  const username = optStr(body, "username");
  const password = optStr(body, "password");

  if (role === "sale_staff" && pin.length === 0) {
    throw badRequest("need_pin", "sale staff sign in with a PIN — set one");
  }
  if (role !== "sale_staff" && (username.length === 0 || password.length === 0)) {
    throw badRequest("need_password", "a manager signs in with a username and password");
  }
  if (pin.length > 0) {
    if (!validPin(pin)) throw badRequest("bad_pin", "a PIN is 4 to 8 digits");
    if (!(await pinIsFree(c.env.DB, pin, null))) {
      throw conflict("pin_taken", "somebody already uses that PIN — pick another");
    }
  }
  if (password.length > 0 && password.length < 8) {
    throw badRequest("weak_password", "use at least 8 characters");
  }
  if (username.length > 0) {
    const taken = await one(c.env.DB, "SELECT id FROM users WHERE username = ?1", username);
    if (taken) throw conflict("username_taken", "that username is already in use");
  }

  const id = newId("usr");
  await run(
    c.env.DB,
    `INSERT INTO users (id, name, role, pin_hash, username, password_hash, active, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    id,
    name,
    role,
    pin.length > 0 ? await hashSecret(pin, "pin") : null,
    username.length > 0 ? username : null,
    password.length > 0 ? await hashSecret(password, "password") : null,
    bool(body, "active", true) ? 1 : 0,
    now(),
  );
  return c.json({ id }, 201);
});

staff.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const id = c.req.param("id");

  const target = await one<{ id: string; role: Role }>(
    c.env.DB,
    "SELECT id, role FROM users WHERE id = ?1",
    id,
  );
  if (!target) throw badRequest("no_such_user", "that person is not on the staff list");
  if (target.role === "owner" && actor.role !== "owner") {
    throw forbidden("only an owner can change an owner");
  }

  const active = bool(body, "active", true);
  // The last active owner cannot be locked out; there would be no way back in.
  if (!active && target.role === "owner") {
    const owners = await one<{ n: number }>(
      c.env.DB,
      "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1 AND id <> ?1",
      id,
    );
    if ((owners?.n ?? 0) === 0) {
      throw conflict("last_owner", "that is the last active owner — appoint another first");
    }
  }

  await run(
    c.env.DB,
    "UPDATE users SET name = ?2, active = ?3 WHERE id = ?1",
    id,
    str(body, "name"),
    active ? 1 : 0,
  );
  // Deactivating somebody ends their sessions now, not at their next sign-in.
  if (!active) await run(c.env.DB, "DELETE FROM sessions WHERE user_id = ?1", id);
  return c.json({ ok: true });
});

staff.post("/:id/pin", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = c.req.param("id");
  const pin = str(body, "pin");
  if (!validPin(pin)) throw badRequest("bad_pin", "a PIN is 4 to 8 digits");
  if (!(await pinIsFree(c.env.DB, pin, id))) {
    throw conflict("pin_taken", "somebody already uses that PIN — pick another");
  }
  await run(c.env.DB, "UPDATE users SET pin_hash = ?2 WHERE id = ?1", id, await hashSecret(pin, "pin"));
  return c.json({ ok: true });
});

staff.post("/:id/password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actor = c.get("actor");
  const id = c.req.param("id");
  const password = str(body, "password");
  if (password.length < 8) throw badRequest("weak_password", "use at least 8 characters");

  const target = await one<{ role: Role }>(c.env.DB, "SELECT role FROM users WHERE id = ?1", id);
  if (!target) throw badRequest("no_such_user", "that person is not on the staff list");
  if (target.role === "owner" && actor.role !== "owner" && actor.userId !== id) {
    throw forbidden("only an owner can change an owner's password");
  }

  await run(
    c.env.DB,
    "UPDATE users SET password_hash = ?2 WHERE id = ?1",
    id,
    await hashSecret(password, "password"),
  );
  // Changing a password signs the other devices out, which is the point of
  // changing one after it has been seen.
  await run(c.env.DB, "DELETE FROM sessions WHERE user_id = ?1 AND token <> ?2", id, actor.token);
  return c.json({ ok: true });
});
