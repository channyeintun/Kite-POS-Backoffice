import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import type { Ctx } from "./env.js";
import { authenticate, requireRole } from "./lib/auth.js";
import { Unbalanced } from "./lib/ledger.js";
import { auth } from "./routes/auth.js";
import { till } from "./routes/till.js";
import { catalog } from "./routes/catalog.js";
import { shifts } from "./routes/shifts.js";
import { sales } from "./routes/sales.js";
import { inventory } from "./routes/inventory.js";
import { purchasing } from "./routes/purchasing.js";
import { promotions } from "./routes/promotions.js";
import { customers } from "./routes/customers.js";
import { reports } from "./routes/reports.js";
import { accounting } from "./routes/accounting.js";
import { staff } from "./routes/staff.js";
import { settings } from "./routes/settings.js";
import { tills } from "./routes/tills.js";
import { photos } from "./routes/photos.js";

const app = new Hono<Ctx>();

/**
 * Cross-origin, with an allow list and no wildcard.
 *
 * The till and the back office are Pages deployments on their own origins, so
 * every request here is cross-origin. `*` is not an option: these requests
 * carry an `Authorization` header, and a wildcard with credentials is refused
 * by the browser anyway — so the list is real, comes from `ALLOWED_ORIGINS`,
 * and an origin that is not on it gets no CORS headers rather than a permissive
 * default.
 */
app.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    allowHeaders: ["content-type", "authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
    credentials: false,
  })(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

// Open: setting the shop up, and getting in.
app.route("/api/auth", auth);

// The till. Every route needs a session; `till.ts` itself refuses a session
// that is not signed in at a lane.
app.use("/api/till/*", authenticate);

/**
 * The lane's heartbeat.
 *
 * Every request from a till stamps its register, and that stamp is the only
 * honest source for the connection state the back office reports: a lane that
 * has not spoken to this Worker in two minutes is offline whatever its own
 * screen says. Without this the till was marked offline the moment it finished
 * signing in, which is the one thing that indicator must not do.
 *
 * `waitUntil` so a sale never waits on a bookkeeping write.
 */
app.use("/api/till/*", async (c, next) => {
  const registerId = c.get("actor").registerId;
  if (registerId) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE registers SET last_seen_at = ?2 WHERE id = ?1")
        .bind(registerId, Math.floor(Date.now() / 1000))
        .run(),
    );
  }
  await next();
});

app.route("/api/till", till);

// **Reading a picture is not authenticated, and it cannot be.** An `<img src>`
// sends no Authorization header — there is no way to give it one — so a
// middleware over the whole path meant every product photo in the till's grid
// came back 401 and drew as a broken tile. The URL is the capability instead:
// the key is a random 20-character id, unguessable and never listed, and what
// it protects is a photograph of a bottle on a shelf.
//
// Writing is a different matter and stays behind both gates: `photos.ts`
// refuses PUT and DELETE to anything but a manager.
//
// Gated by *method*, not by path: `/api/photos/*` covers the key and
// `/api/photos` does not, so scoping by path alone left DELETE outside the
// middleware and it threw on a missing actor instead of refusing.
const photoGate: MiddlewareHandler<Ctx> = async (c, next) => {
  if (c.req.method === "GET") return next();
  return authenticate(c, next);
};
app.use("/api/photos", photoGate);
app.use("/api/photos/*", photoGate);
app.route("/api/photos", photos);

// The back office. A cashier's session cannot open any of it, which is the
// app-routing rule enforced where it counts rather than in the navigation.
const office = new Hono<Ctx>();
office.use("*", authenticate, requireRole("manager"));
office.route("/catalog", catalog);
office.route("/shifts", shifts);
office.route("/sales", sales);
office.route("/inventory", inventory);
office.route("/purchasing", purchasing);
office.route("/promotions", promotions);
office.route("/customers", customers);
office.route("/reports", reports);
office.route("/accounting", accounting);
office.route("/staff", staff);
office.route("/settings", settings);
office.route("/tills", tills);
app.route("/api", office);

/**
 * One place where a failure becomes a response.
 *
 * A `Refused` already carries the response it wants. An `Unbalanced` is a bug
 * in this application rather than in the request, but it is the one bug worth
 * naming precisely in the body — it means a posting was rejected before it
 * could mint money, which is the ledger working.
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof Unbalanced) {
    console.error("ledger refused an entry", err.message);
    return c.json({ error: { code: "unbalanced", message: err.message } }, 500);
  }
  // A Response thrown directly, as the lockout does.
  if (err instanceof Response) return err;
  console.error("unhandled", err);
  return c.json({ error: { code: "internal", message: "something went wrong here" } }, 500);
});

app.notFound((c) => c.json({ error: { code: "not_found", message: "no such endpoint" } }, 404));

export default app;
