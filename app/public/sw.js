/* The service worker.
 *
 * This is the one piece of JavaScript in the front end, and it is here because
 * a service worker *is* JavaScript — the browser will not run WebAssembly in
 * this slot. Everything the operator touches is Kite.
 *
 * What it does is deliberately narrow. It is a **shell cache**, not an offline
 * database:
 *
 *   * The app shell — HTML, CSS, the compiled module — is cached on install and
 *     served cache-first, so a till that loses its connection mid-shift still
 *     starts, and a cold start on a slow line is instant.
 *   * API requests are **never cached**. A price, a stock level or a basket
 *     read from a stale cache is worse than an error: the cashier would charge
 *     yesterday's price and never know. Those go to the network and fail
 *     honestly, and the till shows its connection dot red.
 *
 * Ringing sales while genuinely offline is a larger feature than a cache — it
 * needs a client-side basket, an outbox, and replay against the idempotency key
 * the API already accepts. The server side of that is built (`client_id` is
 * unique on `sales`); this worker deliberately does not pretend to do it.
 */

// v3 purges a cache that had `/index.html` and `/office.html` in it. Pages
// serves those two with a 308 to `/` and `/office`, so what landed under those
// keys was a *redirected* response — and a service worker may not answer a
// navigation with one of those. The till opened on its first visit and then
// failed with ERR_FAILED on every launch after, which is the worst shape a bug
// of this kind can take.
const VERSION = "kite-pos-v3";

// The URLs the host serves, not the files in `public/`. `/office` 404s under
// the Vite dev server, which is why each entry is still added on its own below.
const SHELL = [
  "/",
  "/office",
  "/manifest-till.webmanifest",
  "/manifest-office.webmanifest",
  "/icon-till-192.png",
  "/icon-office-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      // `addAll` rejects the whole install if any one URL 404s, which on a
      // hashed-asset build is a promise this list cannot keep. Each is added on
      // its own so a missing icon does not cost the shell its cache.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never the API. A stale price is a wrong charge.
  if (url.pathname.startsWith("/api/")) return;

  // Never anything the dev server is making up as it goes.
  //
  // Vite serves modules from `/src/…` and `/@vite/…` and rewrites them on every
  // edit; a cache-first worker in front of that pins the first version it saw
  // and the page silently stops matching its source. It cost an afternoon once
  // — the page went blank with no error, because the cached module imported a
  // hashed asset that the next build had already replaced. Production assets
  // are hashed and live under `/assets/`, so this costs nothing there.
  if (
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/@vite") ||
    url.pathname.startsWith("/@id/") ||
    url.pathname.startsWith("/node_modules/") ||
    url.search.length > 0
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          // A response that arrived through a redirect cannot be handed to a
          // navigation — the browser rejects it outright — and caching one puts
          // a page in the cache that can never be served again. So it is passed
          // through as a redirect the browser follows itself, and never stored.
          if (response.redirected) {
            return request.mode === "navigate"
              ? Response.redirect(response.url, 302)
              : response;
          }
          // Only cache what came back whole and from here. An opaque or partial
          // response cached now is a broken page after the next reload.
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // A navigation with no network gets the shell, so the till opens and
          // can say what is wrong. Anything else simply fails.
          if (request.mode === "navigate") return caches.match("/");
          throw new Error("offline");
        });
    }),
  );
});
