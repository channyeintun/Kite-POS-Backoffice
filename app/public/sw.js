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
 *     starts, and a cold start on a slow line is instant. **The page itself is
 *     also re-fetched behind that answer** and written back, so a deploy
 *     reaches a counter on its next launch instead of waiting for somebody to
 *     remember to bump a constant in this file.
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

// v3 purged a cache that had `/index.html` and `/office.html` in it. Pages
// serves those two with a 308 to `/` and `/office`, so what landed under those
// keys was a *redirected* response — and a service worker may not answer a
// navigation with one of those. The till opened on its first visit and then
// failed with ERR_FAILED on every launch after, which is the worst shape a bug
// of this kind can take.
//
// v4 purges a cache that could hold a shell from any earlier build. It is the
// last time this number has to be remembered: a navigation is now refreshed in
// the background whatever the cache said — see the fetch handler below.
const VERSION = "kite-pos-v4";

/**
 * **`Vary` is ignored, and that is not a shortcut.**
 *
 * The host answers every asset with `Vary: Origin`, so a cached response is
 * matched only against a request whose `Origin` header agrees. A page's
 * `<script type="module">` and a plain `fetch()` of the same URL do not send
 * the same headers — so an entry precached with `cache.addAll` was found by
 * one and missed by the other, and the miss fell through to a network that was
 * not there. The till served its HTML, failed its only script, and showed a
 * white screen: the exact failure the cache exists to prevent, arrived at by
 * filling the cache more thoroughly.
 *
 * Every URL in here is same-origin and content-addressed — a hashed name is
 * the same bytes for every caller — so there is nothing for `Vary` to vary.
 */
const MATCH = { ignoreVary: true };

// The URLs the host serves, not the files in `public/`.
// The two pages, each of which names a build that has to come with it.
const PAGES = ["/", "/office"];

// Flat files with no dependents of their own.
const SHELL = [
  "/manifest-till.webmanifest",
  "/manifest-office.webmanifest",
  "/icon-till-192.png",
  "/icon-office-192.png",
];

/**
 * The hashed files a page needs, found by reading it.
 *
 * A build's real shell is not the six URLs above — it is those plus
 * `/assets/index-<hash>.js`, its stylesheet, and the WebAssembly module that
 * *the script* asks for, whose name appears nowhere in the HTML. So the scan
 * goes two deep: what the page names, and then what its scripts name. Two text
 * passes at install, against a program that cannot start without any of them.
 *
 * Nothing here knows the hashes, which is the point: they change on every
 * build and this file does not.
 */
function assetsIn(text) {
  const found = new Set();
  const pattern = /\/assets\/[A-Za-z0-9._-]+/g;
  let hit;
  while ((hit = pattern.exec(text)) !== null) found.add(hit[0]);
  return found;
}

async function assetsFor(response) {
  const named = assetsIn(await response.clone().text());
  const all = new Set(named);
  for (const url of named) {
    if (!url.endsWith(".js")) continue;
    try {
      const script = await fetch(url);
      if (!script.ok) continue;
      for (const deeper of assetsIn(await script.text())) all.add(deeper);
    } catch {
      // A script that will not load is a page that will not run, and
      // `cache.addAll` below is about to say so.
    }
  }
  return [...all];
}

/**
 * A page and everything it needs, or neither.
 *
 * **The order is the whole of it.** Writing the page first and its assets
 * afterwards leaves a window — and on this shop's line, a window is a week —
 * where the cache holds HTML pointing at hashed files that are in no cache and
 * on no reachable network. The till then opens to a white screen offline,
 * having opened fine the morning before. `addAll` rejects if any one file
 * fails, so a half-fetched build leaves the last working shell exactly where
 * it was.
 */
async function cacheShell(cache, request, response) {
  const page = response ?? (await fetch(request));
  if (!page.ok || page.redirected || page.type !== "basic") return page;
  await cache.addAll(await assetsFor(page));
  await cache.put(request, page.clone());
  return page;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        // Settled rather than all: `/office` 404s under the Vite dev server,
        // and a till should not lose its cache over the back office's address.
        Promise.allSettled([
          ...PAGES.map((url) => cacheShell(cache, new Request(url))),
          ...SHELL.map((url) => cache.add(url)),
        ]),
      )
      .then(() => self.skipWaiting()),
  );
});

/**
 * Upgrading without emptying the cache.
 *
 * This used to delete every older cache outright. That is safe only if the new
 * one already holds a whole build, and it did not: `install` precached six
 * URLs and none of them was a line of the program — the hashed files were in
 * the old cache, put there one at a time as earlier pages asked for them. So a
 * version bump swapped a till that started offline for one that served the
 * HTML and failed every script, mid-shift, with no message.
 *
 * Now `install` above fetches a whole build, and anything hashed that an older
 * cache still holds is carried across before it goes. A hashed name means the
 * same bytes wherever it came from, so copying one can never be wrong.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      for (const name of await caches.keys()) {
        if (name === VERSION) continue;
        const old = await caches.open(name);
        for (const request of await old.keys()) {
          if (!new URL(request.url).pathname.startsWith("/assets/")) continue;
          if (await cache.match(request, MATCH)) continue;
          const held = await old.match(request);
          if (held) await cache.put(request, held);
        }
        await caches.delete(name);
      }
      await self.clients.claim();
    })(),
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

  // **The shell is served from the cache and refreshed behind it.**
  //
  // `VERSION` is a constant somebody has to remember to bump, and a deploy that
  // changes the compiled module does not change it — so a till that had already
  // installed kept serving the *old* `/` for ever, pointing at an asset hash the
  // new build no longer has, and a fix could be deployed a dozen times without
  // reaching the counter. Nothing said so, which is the worst part.
  //
  // Cache-first is still what the operator sees, because a lane that has lost
  // its connection mid-shift has to start and a cold start on a slow line has
  // to be instant. The difference is that the answer is also re-fetched in the
  // background and written back, so the launch after a deploy is the new build.
  // One launch behind, never more, and never stuck.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.match(request, MATCH).then((hit) => {
        const fresh = fetch(request)
          .then(async (response) => {
            if (response.redirected) return Response.redirect(response.url, 302);
            // The page and its build go in together, or neither does.
            const cache = await caches.open(VERSION);
            await cacheShell(cache, request, response);
            return response;
          })
          // No network and nothing cached for this exact address: the shell is
          // the best answer there is, and a plain failure if even that is
          // missing — `respondWith` must be handed a Response, not `undefined`.
          .catch(() =>
            caches.match("/", MATCH).then((shell) => shell ?? Response.error()),
          );
        if (hit) {
          event.waitUntil(fresh);
          return hit;
        }
        return fresh;
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request, MATCH).then((hit) => {
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
          if (request.mode === "navigate") return caches.match("/", MATCH);
          throw new Error("offline");
        });
    }),
  );
});
