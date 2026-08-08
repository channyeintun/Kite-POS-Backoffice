import type { Hono } from "hono";

/** What the platform hands this Worker. */
export type Bindings = {
  DB: D1Database;
  PHOTOS: R2Bucket;
  ALLOWED_ORIGINS: string;
  SESSION_HOURS: string;
};

export type Role = "sale_staff" | "manager" | "owner";

/** Who is asking, resolved from the session token once per request. */
export type Actor = {
  token: string;
  userId: string;
  name: string;
  role: Role;
  /** The lane this session is signed in at, for a till. Null in the back office. */
  registerId: string | null;
};

export type Variables = {
  actor: Actor;
};

export type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
export type Ctx = { Bindings: Bindings; Variables: Variables };

/** Seconds since the epoch. The one clock this application reads. */
export const now = (): number => Math.floor(Date.now() / 1000);
