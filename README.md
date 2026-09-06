# RAASTA / NER Route Intelligence

AI-assisted route safety platform for India's North Eastern Region (NER) —
Assam, Arunachal Pradesh, Meghalaya, Manipur, Mizoram, Nagaland, Tripura,
Sikkim. Built for Smart India Hackathon.

Live road routing + weather + explainable, ML-blended hazard scoring, real
GPS tracking of field vehicles, crowd-sourced incident reports, multilingual
UI, and offline-first PWA support — targeting free-tier hosting only.

The selected route detail view also provides an on-demand AI logistics brief.
OpenAI interprets the server-computed risk, weather, hazard, vehicle, priority,
and alternate-route evidence into an operational decision (`PROCEED`,
`PROCEED_WITH_CAUTION`, `USE_ALTERNATE`, or `HOLD_AND_VERIFY`) with reasons,
actions, and alerts. OpenAI does not invent route or sensor data; a bounded
rule-based fallback is returned when the key, quota, or network is unavailable.

The logistics layer now includes Supabase-backed missions and delivery stops:
`POST /api/missions` creates an essential-goods movement with optional stops,
`GET /api/missions` returns the operational queue, and the mission/stop PATCH
endpoints record planned, in-transit, delayed, arrived, completed, and delivered
states. These patterns were adapted from the fleet/session ideas in
[vehicle-tracking](https://github.com/salildz/vehicle-tracking), while the
offline incident workflow already present in this app covers the useful parts
of CrisisMap and Nodus. Their applications were not copied wholesale because
they use different stacks; CrisisMap is MIT-licensed, while the other projects
must be reviewed at the file level before any code reuse.

This file replaces and merges the earlier `README-backend.md` and
`LIMITATIONS.md`.

---

## 1. Architecture

```
                                ┌─────────────────────────────┐
                                │        Browser (PWA)         │
                                │  index.html + app.js + i18n  │
                                │  Leaflet map · service-worker│
                                └──────────────┬────────────────┘
                                               │ HTTPS / WSS
                                               ▼
                        ┌──────────────────────────────────────────┐
                        │              server.js (Express)          │
                        │  ┌────────────┐  ┌───────────────────┐   │
                        │  │ TTL caches │  │ Nominatim limiter  │   │
                        │  └────────────┘  └───────────────────┘   │
                        │  /api/geocode  /api/route  /api/context   │
                        │  /api/score    /api/route-forecast        │
                        │  /api/reports  /api/positions  /ws/track   │
                        └───────┬───────────────┬───────────┬───────┘
                                │               │           │
                    ┌───────────┘        ┌──────┘     ┌─────┘
                    ▼                    ▼            ▼
            riskEngine.js          reportsStore.js   incidents.js
        (scoring, tiering,       (append-only JSON   (Overpass diff →
         road-class grid,         field-report log)   live WS push)
         vehicle penalty)               │
                    │                    │
                    ▼                    ▼
              mlClient.js          reports.json
        (Random Forest landslide  (file-based store;
         model, degrades to        swappable for a
         heuristic on failure)     real DB later)

  Upstream (all free-tier, no keys):
    OSRM (+ OSM DE fallback) · Nominatim (+ Open-Meteo geocoding fallback)
    Open-Meteo forecast + archive · Overpass (+ kumi.systems fallback)
```

Frontend stays a single Leaflet-based page (`index.html` / `app.js` /
`style.css`) plus a lightweight `tracker.html` for phones to broadcast GPS.
A manifest + service worker make the whole thing installable and
partially usable offline. All third-party calls are proxied, cached, and
rate-limited through one `server.js`, which stays a single file per the
project's "only split when a section exceeds ~400 lines" rule — `riskEngine.js`,
`reportsStore.js`, `incidents.js`, and `mlClient.js` are the exceptions,
each a cohesive, independently-testable concern.

## 2. Setup / run

```bash
# backend
cd server
npm install
npm start            # serves the API and the /public frontend on $PORT (default 3000)
```

### Supabase persistence (optional for local fallback)

Run `supabase/schema.sql` in the Supabase SQL editor, then configure the Node
server with environment variables from `.env.example`:

```powershell
$env:SUPABASE_URL="https://your-project-ref.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-server-only-service-role-key"
npm start
```

When both variables are present, reports and GPS positions are stored in
Supabase. Without them, the existing JSON stores are used for local
development. Do not use the publishable/anon key as the server persistence
key, and never expose a service-role or OpenAI key to `public/` code.

Open `http://localhost:3000` for the main app, and
`http://localhost:3000/tracker.html` on a phone (over **HTTPS**, e.g. via
`ngrok http 3000`, or your deployed URL — `navigator.geolocation` requires a
secure context) to broadcast that phone's live location to the dashboard.

No API keys are required anywhere — every upstream (OSRM, Nominatim,
Open-Meteo, Overpass) is used as a free, unauthenticated public endpoint,
each with a documented fallback.

**Deployment target:** free tiers only — Render/Railway/Fly.io for the
Node process, a SQLite/JSON file (or Postgres free tier, if available) for
persistence. No paid APIs anywhere in the stack.

## 3. What each phase added

| Phase | Focus | Highlights |
|---|---|---|
| 0 | Context primer | Problem statement, known-bug list, target architecture — pasted at the start of every phase prompt. |
| 1 | Backend foundation | Single `server.js` proxying every third-party API; TTL caching; Nominatim token-bucket rate limiter (bug #1); dual-endpoint OSRM/Overpass fallback (bugs #2 partial, #16); server-side HTML-escaping (bug #18); parallelized weather+hazards via `/api/context` (bug #15). |
| 2 | Risk engine | Moved all scoring server-side into `riskEngine.js`; fixed the double-counted `safety` composite so the breakdown sums exactly to the score (bug #5); one shared terrain lookup (bug #6); recalibrated distance/duration scoring so realistic 500–900km NER trips no longer floor at zero (bug #8); NH/SH/rural road-class grid wired into scoring (bug #9). |
| 3 | Live GPS | `/ws/track` WebSocket relay; `tracker.html` for phones to broadcast real position; dashboard-side device markers + trails, replacing the old fake sine-wave nav marker with real telemetry when available (bug #13 — see Phase 7 for full removal of the fake speed number). |
| 4 | Forecasting + history | Past-30-days rainfall strip (`/api/weather/history`); 48h risk-score trend per route (`/api/route-forecast`), re-running the same scoring model against forecast precipitation slices instead of inventing a second model. |
| 5 | Live incidents + pace | Overpass diff → push new hazard/construction tags to watching dashboards over WebSocket; real crowd-sourced live-pace estimate from tracked devices' position deltas, replacing a fabricated traffic overlay. |
| 6 | Field reports + offline PWA | `POST/GET /api/reports` with idempotent client-id retries; append-only JSON store (`reportsStore.js`); IndexedDB offline queue + auto-sync; manifest + service worker (app-shell precache, network-first data with a clearly-tagged cache fallback — never mislabeled as live). |
| **7** | **Polish pass** | See below. |

### Phase 7 — polish pass

- **Bug #2 (total-failure fallback):** if `/api/route` **and** `/api/context`
  (weather+hazards) both fail for the same request, the app now
  automatically falls back to demo data for that run and shows *"Live data
  unavailable — showing demo route"* instead of a dead-end error. A
  single-endpoint failure still surfaces its real, specific error — the
  fallback only triggers when everything live is actually down, and the
  result is never mislabeled as live (`status_demo_fallback` badge).
- **Bug #4 (demo multi-stop):** `demoRoutes()` now interpolates through
  **every** provided stop in order, not just the first and last.
- **Bug #3 (vehicle selector):** public OSRM only ships
  driving/walking/cycling profiles, so it cannot physically route a truck
  differently from a car. Rather than ship a control that silently does
  nothing, the vehicle type now feeds a real accessibility penalty into
  `riskEngine.js`'s road-access factor (rural-heavy corridors score lower
  for trucks/buses, better for two-wheelers) and the UI explicitly labels
  it *"affects safety scoring only"*.
- **Bug #19 (accessibility):** `aria-label`s added to every icon-only
  control (zoom, locate, recenter, theme, language, nav exit), translated
  through the same i18n dictionary; each risk badge now also carries a
  shape/icon prefix (✓ / ! / ✕) so color is never the only signal.
- **Bug #20 (multi-leg steps):** `parseSteps` no longer applies one global
  12-step cap across an entire multi-stop trip. Steps are parsed and capped
  **per leg** (`MAX_STEPS_PER_LEG = 40`, a safety net rather than a real
  limit), so later legs of a multi-stop route keep their turn-by-turn
  detail instead of losing it to an earlier leg.
- **Fake nav speed removed:** `advanceNav()` no longer synthesizes a
  sine-wave speed. If a real tracked device (from `tracker.html`) is
  currently near the active route, its actual speed — computed from real
  GPS position deltas, the same logic used for the live-pace feature — is
  shown. Otherwise the nav view is explicitly labeled *"Preview
  simulation"* rather than presented as live telemetry.
- **Codebase sweep:** confirmed terrain inference is unified in one place
  (`riskEngine.js`'s `STATE_TERRAIN` table, consumed by both scoring and
  geocoding — bug #6 stayed fixed); confirmed all third-party text that
  reaches the frontend is escaped server-side via `escapeDeep()` (bug #18);
  no dead client-side scoring/geocoding logic remains from before Phases
  1–2 moved it server-side.

## 3a. Integration notes (merging phases 1–7 into this repo)

The seven phase deliverables were built as incremental patches on top of one
another, each phase's zip only shipping the files it touched. Assembling them
into this single repo, two small gaps between phases needed closing (neither
was a scoring/architecture change — both are wiring that phase 6/7 assumed
but never shipped a file for):

- **`server/mlClient.js`, `server/ml/`, `server/roads_grid.json`** — introduced
  in Phase 2 and required by every later `server.js`, but not re-included in
  the Phase 6/7 zips. Pulled forward unchanged from Phase 2.
- **`server/incidents.js`** — introduced in Phase 5, required by Phase 6/7's
  `server.js`. Pulled forward unchanged from Phase 5.
- **`public/reportQueue.js`** — `tracker.html` (Phase 6/7) calls
  `ReportQueue.submit(...)`, but no phase actually shipped this file; the
  dashboard's own offline queue was always inline in `app.js` instead. Added
  here as a small standalone module using the *same* IndexedDB store
  (`raasta-offline` / `pendingReports`) as `app.js`'s queue, so reports
  queued from a phone and from the dashboard sync interchangeably.
- **i18n keys for `tracker.html`** — the tracker page's Phase 7 rewrite used
  a different (camelCase) key-naming convention than `i18n.js`'s dictionary
  (snake_case, e.g. `report_sent`). Added the missing `trackerTitle`,
  `startSharing`, `reportQueued`, etc. keys in all three languages so the
  tracker page is actually translated rather than silently falling back to
  raw key names.
- **Service worker shell list** — added `tracker.html` and `reportQueue.js`
  to the precached app-shell files so the field-tracker page also loads
  offline, matching the intent of Phase 6's PWA work.

Everything else — scoring math, ML blend, WebSocket relay, PWA manifest,
i18n dictionary, field reports — is each phase's code taken as-is.

## 4. Known limitations

- **Background GPS throttling.** `tracker.html` relies on
  `navigator.geolocation.watchPosition`, which mobile browsers throttle or
  suspend when the tab is backgrounded or the screen locks. The phone tab
  must stay open and the screen on for continuous tracking — this is a
  browser-platform constraint, not something fixable without a native app
  or a background-sync API most mobile browsers don't expose to web pages.
- **Free-API rate limits.** Nominatim (~1 req/sec, token-bucket limited
  server-side), Overpass (shared public instances, can be slow or
  temporarily unavailable under load), and OSRM's public demo server (no
  official SLA) are all free, keyless, shared infrastructure. The app
  caches aggressively and has fallback endpoints for each, but under heavy
  concurrent use or an upstream outage, expect slower responses or (as of
  Phase 7) an automatic drop to demo mode if everything is down at once.
- **Single-region ML model scope.** The landslide-risk ML model is trained
  on ~707 historical NER events and IMD rainfall data specific to this
  region; it is not a general-purpose landslide predictor and should not be
  applied to routes outside the eight NER states. If the ML service is
  unreachable, scoring degrades to a terrain+rainfall heuristic rather than
  failing outright — this is by design, but it does mean the "ML-backed"
  claim on the score only holds when `landslide.source` says so in a
  route's detail breakdown.
- **No offline basemap.** Offline mode covers the app shell (UI loads),
  last-seen route/weather/hazard data (clearly marked cached, never live),
  and field-report queuing/sync. It does **not** cover offline map tiles —
  Leaflet's CDN assets and OSM/Esri tile imagery are cross-origin and
  deliberately not cached, since a proper offline tile cache is a
  materially bigger feature than this project's PWA scope claims.
- **Vehicle type is a scoring input, not a routing input** (see Phase 7
  notes above) — this is a genuine constraint of using free public OSRM
  rather than a self-hosted multi-profile OSRM instance.

## 5. End-to-end verification checklist

- [ ] Geocode a real NER corridor (e.g. Guwahati → Ziro) and get scored,
      tiered routes with an explainable factor breakdown.
- [ ] Open a route's detail sheet and view its 48h risk forecast trend.
- [ ] Open `tracker.html` on a second device/tab (over HTTPS) and watch it
      appear live on the dashboard map.
- [ ] Submit a field report from the map.
- [ ] Toggle the network offline (devtools) and confirm a report queues,
      then syncs once back online.
- [ ] Switch language and theme; confirm every icon-only control still has
      a working, translated `aria-label`.
- [ ] Confirm no console errors anywhere in the above flow.
