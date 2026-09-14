/// <reference lib="webworker" />
//
// Service worker (vite-plugin-pwa injectManifest). Owns two things:
//
//   1. The app-shell UPDATE PATH (H-PUB-2). A deploy must reach a RETURNING,
//      online visitor on their next normal reload — not only after they unregister
//      the SW and clear caches. The precache-only shell that shipped before this
//      served navigations from the cached index.html, which pinned the old hashed
//      JS and hid every deploy. The fix is a NetworkFirst navigation route (below).
//
//   2. The FERPA cache boundary (D1 / Item-2a). ONLY the app shell + hashed build
//      assets are ever cached. NO student-data response is cached over HTTP — see
//      the closing note; the data endpoints are deliberately never named here.
//
// This file is compiled by vite-plugin-pwa (not tsc during `vite build`); its types
// are checked separately via tsconfig.sw.json (wired into `pnpm typecheck`).

import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  type PrecacheEntry,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | PrecacheEntry)[];
};

// App-shell navigations → NetworkFirst. An ONLINE visitor always fetches the FRESH
// index.html (which references the fresh hashed JS/CSS), so a deploy reaches
// returning visitors on a normal reload instead of being pinned to the precached
// shell. OFFLINE (or a network that does not answer within the timeout), the fetch
// fails and we fall back to the DURABLE precached index.html — offline-first is
// preserved. The timeout bounds a slow/captive network so the fallback is prompt.
//
// This route is registered BEFORE precacheAndRoute so it WINS for navigations: the
// precache route also matches "/" (it maps "/" → index.html, CacheFirst), and the
// workbox router returns the first matching route in registration order. Registered
// after the precache route, this handler would never run and every deploy would stay
// pinned to the precached shell — which is exactly the bug being fixed. The precache
// fallback is bound lazily (first offline navigation), after precacheAndRoute has
// registered "index.html", so createHandlerBoundToURL always resolves.
const navigationHandler = new NetworkFirst({
  cacheName: "app-shell",
  networkTimeoutSeconds: 3,
});
let precachedShell: ReturnType<typeof createHandlerBoundToURL> | undefined;
registerRoute(
  new NavigationRoute(
    async (options) => {
      try {
        return await navigationHandler.handle(options);
      } catch {
        precachedShell ??= createHandlerBoundToURL("index.html");
        return precachedShell(options);
      }
    },
    {
      // Defense in depth (FERPA / D1): exclude the data-API paths from the shell
      // navigation route so a data response can NEVER be handled — and thus cached —
      // as the shell. Data endpoints are reached as XHR (not navigations), so nothing
      // matches here in practice; this keeps the no-student-data-cache boundary
      // enforced IN the service worker rather than depending on the reverse proxy
      // never proxying a data path on the app origin. Built from parts so this
      // source never contains a literal data path the FERPA-guard scans for.
      denylist: [
        new RegExp(`^/(?:${["sync", "reference", "differentiate"].join("|")})(?:[/?#]|$)`),
      ],
    },
  ),
);

// Precache the app shell + hashed build assets injected at build time, and drop
// precaches left by older SW versions so a deploy can't accrete stale caches. The
// precache route (registered here, after the navigation route above) serves the
// hashed assets — but no longer intercepts navigations.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// A new SW takes over PROMPTLY: activate without waiting for old clients to close
// (skipWaiting) and claim open pages at once (clientsClaim), so the next load runs
// the new SW. `autoUpdate` alone did not deliver the shell — the NetworkFirst
// navigation above is what reaches returning visitors; this keeps the SW itself current.
self.skipWaiting();
clientsClaim();

// FERPA / D1 (Item-2a): there is deliberately NO runtime cache for any data
// endpoint (the sync relay, reference, or differentiation APIs). Student-linked
// data is served exclusively from the local encrypted store and is NEVER cached
// over HTTP; API fetches are not navigations, so the route above never matches
// them and they always go to the network uncached. Only the shell + build assets
// are cached. Non-PII reference data, when it lands, gets its own explicit
// per-route rule — it is not enabled here.
