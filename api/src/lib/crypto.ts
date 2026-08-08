/**
 * Secrets, hashed and compared.
 *
 * WebCrypto only — there is no dependency here and nothing to keep patched.
 * Two kinds of credential live in this shop and they are not worth the same
 * amount of work:
 *
 *   * A **password** opens the back office: the books, the staff list, the
 *     ability to close a lane. It gets 210,000 PBKDF2 iterations, which is
 *     OWASP's 2023 figure for PBKDF2-HMAC-SHA256.
 *   * A **PIN** opens a till and is four digits, so the entire keyspace is ten
 *     thousand. No iteration count makes that expensive to search offline, and
 *     pretending otherwise would only make the *online* path slow — the till
 *     scans active staff to find whose PIN was typed, so the cost is paid per
 *     member of staff on every sign-in. What actually protects a PIN is the
 *     lockout in `sign_in_attempts`, so the count here is set to keep a lane
 *     responsive and the defence is put where it works.
 *
 * Both are salted per user. An unsalted digest of a 4-digit PIN is a lookup
 * table with ten thousand rows in it.
 */

const PASSWORD_ITERATIONS = 210_000;
const PIN_ITERATIONS = 25_000;

export type Kind = "password" | "pin";

const iterationsFor = (kind: Kind) =>
  kind === "password" ? PASSWORD_ITERATIONS : PIN_ITERATIONS;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function derive(
  secret: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * A stored credential: `kind$iterations$salt$digest`.
 *
 * The iteration count travels with the hash so it can be raised later without
 * invalidating every credential written before the change — a verify reads the
 * count that was used, and a rehash on the next successful sign-in moves it up.
 */
export async function hashSecret(secret: string, kind: Kind): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = iterationsFor(kind);
  const digest = await derive(secret, salt, iterations);
  return `${kind}$${iterations}$${toBase64(salt)}$${toBase64(digest)}`;
}

/** Constant time, so a comparison cannot be timed to recover a prefix. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const [, iterationsText, saltText, digestText] = parts;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > 1_000_000) return false;
  let expected: Uint8Array;
  let salt: Uint8Array;
  try {
    salt = fromBase64(saltText!);
    expected = fromBase64(digestText!);
  } catch {
    return false;
  }
  const actual = await derive(secret, salt, iterations);
  return sameBytes(actual, expected);
}

/** A session token: 256 bits, URL-safe, never derived from anything. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An identifier, prefixed so a stray id in a log says what it belongs to. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
