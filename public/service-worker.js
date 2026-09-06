/* =========================================================================
   RAASTA service worker — Phase 6
   -------------------------------------------------------------------------
   Scope, deliberately: the app shell (this app's own HTML/CSS/JS) is
   precached so the UI itself loads offline. Live data (routes, weather,
   hazards, reports) is network-first with a cache fallback, so a
   previously-seen answer can still be shown offline — but every fallback
   response is tagged X-Raasta-Cache: hit so the frontend can (and must,
   per the brief: "cached data must never be labeled live") show it as
   cached rather than live.

   NOT cached, and not claimed: Leaflet's own tiles/JS from the CDN, and
   OSM tile imagery. Those are cross-origin and caching them well enough to
   render an offline map is a materially bigger feature (a proper tile
   cache) than this phase's brief — claiming offline maps here would be
   exactly the kind of "fake capability" Rule D warns against. Offline mode
   here means: the app shell loads, your last-seen route/weather/hazard
   data is visible and clearly marked cached, and field reports queue and
   sync — not a fully offline basemap.
   ========================================================================= */
"use strict";

const SHELL_CACHE = "raasta-shell-v9";
const DATA_CACHE = "raasta-data-v9";

const SHELL_FILES = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/i18n.js",
  "/manifest.json",
  "/icon.svg",
  "/tracker.html",
  "/reportQueue.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  return url.origin === self.location.origin && SHELL_FILES.includes(url.pathname);
}
function isApiGet(request, url) {
  return request.method === "GET" && url.origin === self.location.origin && url.pathname.startsWith("/api/");
}

// Stale-while-revalidate for the app shell: instant load from cache, quiet
// background refresh so the next launch has anything that changed.
async function shellStrategy(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); return res; }).catch(() => null);
  return cached || (await network) || new Response("Offline.", { status: 503 });
}

// Network-first for API GETs, with a tagged cache fallback so the frontend
// can distinguish "live" from "cached" (see header comment).
async function dataStrategy(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-Raasta-Cache", "hit");
      const body = await cached.blob();
      return new Response(body, { status: cached.status || 200, statusText: cached.statusText, headers });
    }
    return new Response(JSON.stringify({ error: "Offline and no cached data available.", offline: true }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept non-GET (POST /api/reports etc.) — let it fail
  // naturally so app.js's IndexedDB queue handles the retry.
  if (event.request.method !== "GET") return;

  if (isShellRequest(url) || (event.request.mode === "navigate" && url.origin === self.location.origin)) {
    // Preserve the requested document. Previously every navigation, including
    // /tracker.html, was rewritten to /index.html.
    event.respondWith(shellStrategy(event.request));
    return;
  }
  if (isApiGet(event.request, url)) {
    event.respondWith(dataStrategy(event.request));
    return;
  }
  // Cross-origin (Leaflet CDN, OSM/Esri tiles, Nominatim etc.) — pass
  // through untouched. See header comment for why tiles aren't cached.
});
