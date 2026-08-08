import { Hono } from "hono";
import type { Ctx } from "../env.js";
import { now } from "../env.js";
import { run } from "../lib/db.js";
import { newId } from "../lib/crypto.js";
import { badRequest, forbidden, notFound } from "../lib/http.js";
import { isManager } from "../lib/auth.js";

export const photos = new Hono<Ctx>();

/**
 * Product pictures, in R2.
 *
 * R2's free tier has no egress charge, which is the whole reason the pictures
 * live there rather than as base64 in a D1 column — a till drawing a grid of
 * sixty tiles pulls sixty images on every cold start, and that is exactly the
 * traffic an object store is priced for and a database is not.
 */

const ALLOWED = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

/** Two megabytes. A shelf photo on a till tile is 400 px across. */
const MAX_BYTES = 2 * 1024 * 1024;

photos.get("/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const object = await c.env.PHOTOS.get(key);
  if (!object) throw notFound("no such picture");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Immutable: the key carries a fresh id on every upload, so a changed picture
  // is a changed URL and nothing has to be revalidated.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

photos.put("/", async (c) => {
  if (!isManager(c.get("actor").role)) throw forbidden("only the back office changes pictures");

  const type = c.req.header("content-type") ?? "";
  const extension = ALLOWED.get(type.split(";")[0]!.trim());
  if (!extension) throw badRequest("bad_type", "send a JPEG, a PNG or a WebP");

  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BYTES) throw badRequest("too_big", "keep pictures under 2 MB");

  const body = await c.req.arrayBuffer();
  // Checked again after reading, because `content-length` is the client's word
  // for it and a chunked upload does not send one at all.
  if (body.byteLength > MAX_BYTES) throw badRequest("too_big", "keep pictures under 2 MB");
  if (body.byteLength === 0) throw badRequest("empty", "that picture is empty");

  const key = `products/${newId("img")}.${extension}`;
  await c.env.PHOTOS.put(key, body, { httpMetadata: { contentType: type } });

  const productId = c.req.query("product_id");
  if (productId) {
    await run(
      c.env.DB,
      "UPDATE products SET photo_key = ?2, updated_at = ?3 WHERE id = ?1",
      productId,
      key,
      now(),
    );
  }
  return c.json({ key }, 201);
});

photos.delete("/:key{.+}", async (c) => {
  if (!isManager(c.get("actor").role)) throw forbidden("only the back office changes pictures");
  const key = c.req.param("key");
  await c.env.PHOTOS.delete(key);
  await run(c.env.DB, "UPDATE products SET photo_key = NULL WHERE photo_key = ?1", key);
  return c.json({ ok: true });
});
