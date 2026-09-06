/* =========================================================================
   RAASTA / NER Route Intelligence — server.js (Phase 1: backend foundation)
   One file per the "only split when >~80 lines of DB setup" rule — there is
   no DB yet (in-memory cache only), so everything lives here.
   ========================================================================= */
"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const http = require("http");
const { tierRoutes, scoreRoute, terrainForState } = require("./riskEngine");
const mlClient = require("./mlClient");
const incidents = require("./incidents"); // Phase 5: hazard-diff pub/sub
const reportsStore = require("./reportsStore"); // Phase 6: field reports
const supabaseStore = require("./supabaseStore");
const openaiClient = require("./openaiClient");
const missionsStore = require("./missionsStore");

/* -------------------------------------------------------------------------
   1. CONFIG
   ------------------------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
const UPSTREAM = {
  route: "https://router.project-osrm.org/route/v1/driving",
  routeFallback: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  geocode: "https://nominatim.openstreetmap.org/search",
  geocodeFallback: "https://geocoding-api.open-meteo.com/v1/search",
  weather: "https://api.open-meteo.com/v1/forecast",
  weatherHistory: "https://archive-api.open-meteo.com/v1/archive",
  overpass: "https://overpass-api.de/api/interpreter",
  overpassFallback: "https://overpass.kumi.systems/api/interpreter",
  overpassFallback2: "https://overpass.private.coffee/api/interpreter"
};
const GEOCODE_TTL = Infinity;      // place names don't change
const DATA_TTL_MS = 10 * 60 * 1000; // routes/weather/hazards: 10 min
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // Phase 4: past-day rainfall never changes, cache hard

/* -------------------------------------------------------------------------
   2. TINY UTILITIES (fetch w/ timeout, HTML-escape, coord rounding)
   ------------------------------------------------------------------------- */
async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Bug #18 fix lives here: any third-party text that could reach innerHTML
// on the frontend gets escaped before it ever leaves the server.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

function escapeDeep(val) {
  if (typeof val === "string") return esc(val);
  if (Array.isArray(val)) return val.map(escapeDeep);
  if (val && typeof val === "object") {
    const out = {};
    for (const k of Object.keys(val)) out[k] = escapeDeep(val[k]);
    return out;
  }
  return val;
}

const roundCoord = (n) => Math.round(Number(n) * 500) / 500; // ~0.002° buckets
const pointsKey = (points) =>
  points.map((p) => `${roundCoord(p.lat)},${roundCoord(p.lon)}`).join(";");

/* -------------------------------------------------------------------------
   3. IN-MEMORY TTL CACHE (Map-based; swap for Redis later if ever needed)
   ------------------------------------------------------------------------- */
class TTLCache {
  constructor() { this.store = new Map(); }
  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires !== Infinity && hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value, ttlMs) {
    this.store.set(key, { value, expires: ttlMs === Infinity ? Infinity : Date.now() + ttlMs });
  }
  // periodic sweep so the Map doesn't grow unbounded with expired entries
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.store) if (v.expires !== Infinity && v.expires < now) this.store.delete(k);
  }
}
const geocodeCache = new TTLCache();
const dataCache = new TTLCache(); // routes, weather, hazards
setInterval(() => dataCache.sweep(), 60_000).unref();

/* -------------------------------------------------------------------------
   4. TOKEN-BUCKET RATE LIMITER for Nominatim (free tier: ~1 req/sec cap)
   Concurrent callers get queued instead of hammering Nominatim / risking
   an IP block (bug #1).
   ------------------------------------------------------------------------- */
function makeLimiter(minIntervalMs) {
  let queue = Promise.resolve();
  let last = 0;
  return (fn) => {
    queue = queue.then(async () => {
      const wait = Math.max(0, last + minIntervalMs - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    return queue;
  };
}
const nominatimLimiter = makeLimiter(1000); // 1 outbound call/sec, rest queue

/* -------------------------------------------------------------------------
   5. UPSTREAM WRAPPERS — logic ported ~verbatim from the old client app.js
   ------------------------------------------------------------------------- */
const NER_BOUNDS = /Arunachal Pradesh|Assam|Meghalaya|Manipur|Mizoram|Nagaland|Tripura|Sikkim/i;

async function geocodeUpstream(raw) {
  try {
    const viewbox = "88,30,98,21"; // NER-focused search window
    const d = await nominatimLimiter(() =>
      fetchJSON(`${UPSTREAM.geocode}?q=${encodeURIComponent(raw + ", India")}&format=jsonv2&limit=10&addressdetails=1&countrycodes=in&viewbox=${viewbox}&bounded=0&accept-language=en`,
        { headers: { "User-Agent": "RAASTA-NER-Route-Intelligence/1.0" } })
    );
    const results = (d || []).filter((r) => r.lat && r.lon);
    const inNER = (r) => Number(r.lat) >= 21 && Number(r.lat) <= 30.5 && Number(r.lon) >= 88 && Number(r.lon) <= 98;
    const preferred =
      results.find((r) => inNER(r) && NER_BOUNDS.test(`${r.address?.state || ""} ${r.display_name || ""}`)) ||
      results.find(inNER) || results[0];
    if (preferred) {
      const state = preferred.address?.state || preferred.address?.region || "";
      return {
        name: raw, matchedName: preferred.name, state,
        lat: Number(preferred.lat), lon: Number(preferred.lon),
        terrain: /Arunachal|Meghalaya|Mizoram|Nagaland|Manipur|Sikkim/i.test(state) ? "mountain" : "plain",
        displayName: preferred.display_name
      };
    }
  } catch (e) { console.warn("Nominatim geocoding failed:", e.message); }

  const d = await fetchJSON(`${UPSTREAM.geocodeFallback}?name=${encodeURIComponent(raw)}&count=10&language=en&format=json`);
  const x = d.results?.find((r) => NER_BOUNDS.test(`${r.admin1 || ""} ${r.country || ""}`)) || d.results?.[0];
  if (!x) { const err = new Error(`Location not found: ${raw}`); err.status = 404; throw err; }
  return { name: raw, state: x.admin1 || "", lat: Number(x.latitude), lon: Number(x.longitude), terrain: "unknown" };
}

// Phase 7 (bug #20 fix): the old flat `.slice(0, 12)` truncated turn-by-turn
// detail across the WHOLE multi-stop trip, so a route with 4+ stops lost
// most of its later legs' steps entirely. Steps are now parsed and kept
// PER LEG (with a generous per-leg cap, not a global one), then flattened —
// so a 5-leg trip keeps detail for every leg instead of spending its whole
// budget on leg 1.
const MAX_STEPS_PER_LEG = 40; // generous — this is a safety net against a
// single freak leg with hundreds of tiny OSRM maneuver steps, not a real cap
// for normal NER city-to-city legs (typically well under this).
function parseStepsForLeg(steps) {
  return (steps || []).slice(0, MAX_STEPS_PER_LEG).map((s) => ({
    text: s.maneuver?.instruction || s.name || "Continue",
    distance: s.distance || 0, type: s.maneuver?.type
  }));
}
function parseLegs(legs) {
  // Returns { steps: [...flattened, tagged with legIndex], legBoundaries }
  // so the frontend can paginate turn-by-turn detail per leg if it wants to,
  // while still getting one flat list for the existing simple renderer.
  const steps = [];
  (legs || []).forEach((leg, legIndex) => {
    parseStepsForLeg(leg.steps).forEach((s) => steps.push({ ...s, legIndex }));
  });
  return steps;
}

async function routeUpstream(points) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const params = "?alternatives=3&steps=true&overview=full&geometries=geojson&continue_straight=false&annotations=true";
  const endpoints = [`${UPSTREAM.route}/${coords}${params}`, `${UPSTREAM.routeFallback}/${coords}${params}`];
  let lastError = null;
  for (const url of endpoints) {
    try {
      const d = await fetchJSON(url, {}, 30000);
      if (d.code !== "Ok" || !d.routes?.length) throw new Error(d.message || "No drivable road route returned.");
      const routes = d.routes.map((r, i) => ({
        id: String.fromCharCode(65 + i),
        path: (r.geometry?.coordinates || []).map((p) => [Number(p[1]), Number(p[0])]),
        distance: Number(r.distance) / 1000, duration: Number(r.duration),
        steps: parseLegs(r.legs || []),
        legCount: (r.legs || []).length,
        source: url.includes("routing.openstreetmap.de") ? "OSRM / OpenStreetMap DE" : "OSRM Project road network"
      })).filter((r) => r.path.length > 1 && r.distance > 0);
      if (routes.length) return routes;
    } catch (e) { lastError = e; console.warn("OSRM endpoint failed:", url, e.message); }
  }
  throw lastError || new Error("No drivable road route returned.");
}

async function weatherUpstream(lat, lon) {
  const u = `${UPSTREAM.weather}?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,visibility&hourly=precipitation,weather_code&daily=weather_code,precipitation_sum,temperature_2m_max,temperature_2m_min&forecast_days=6&timezone=auto`;
  const w = await fetchJSON(u);
  return escapeDeep(w); // timezone string etc. — bug #18
}

// ---- Phase 4: historical rainfall (past N days) at a corridor point -------
// Open-Meteo's archive API has no key and returns actuals, so once a past
// date's number is fetched it is fixed forever — hence the 24h TTL rather
// than the 10min TTL used for live/forecast data.
function isoDate(d) { return d.toISOString().slice(0, 10); }
async function weatherHistoryUpstream(lat, lon, days) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1); // archive API lags ~1 day behind "today"
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const u = `${UPSTREAM.weatherHistory}?latitude=${lat}&longitude=${lon}&start_date=${isoDate(start)}&end_date=${isoDate(end)}&daily=precipitation_sum&timezone=auto`;
  const d = await fetchJSON(u, {}, 20000);
  const dates = d.daily?.time || [];
  const values = d.daily?.precipitation_sum || [];
  const days_ = dates.map((date, i) => ({ date, rainfallMm: Number(values[i]) || 0 }));
  return escapeDeep({ days: days_, totalMm: Math.round(days_.reduce((s, x) => s + x.rainfallMm, 0) * 10) / 10 });
}

async function hazardsUpstream(lat, lon) {
  // Query a tighter corridor around the route context point, but include more
  // useful OSM signal classes than construction/hazard alone. Weather and ML
  // remain separate signals; these are mapped physical evidence.
  const q = `[out:json][timeout:8];(node(around:12000,${lat},${lon})[amenity=hospital];node(around:12000,${lat},${lon})[amenity=fuel];node(around:12000,${lat},${lon})[highway=construction];way(around:12000,${lat},${lon})[highway=construction];node(around:12000,${lat},${lon})[hazard];way(around:12000,${lat},${lon})[hazard];node(around:12000,${lat},${lon})[natural=landslide];way(around:12000,${lat},${lon})[natural=landslide];node(around:12000,${lat},${lon})[flood_prone];way(around:12000,${lat},${lon})[flood_prone];way(around:12000,${lat},${lon})[bridge];way(around:12000,${lat},${lon})[waterway=river];);out center tags;`;
  const endpoints = [UPSTREAM.overpass, UPSTREAM.overpassFallback, UPSTREAM.overpassFallback2];
  for (const url of endpoints) {
    try {
      const d = await fetchJSON(url, { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json", "User-Agent": "RAASTA-NER-Route-Intelligence/1.0 (hazard-monitor)" }, body: q }, 5000);
      const elements = (d.elements || [])
        .map((e) => {
          const tags = e.tags || {};
          const text = `${tags.hazard || ""} ${tags.natural || ""} ${tags.flood_prone || ""} ${tags.highway || ""} ${tags.bridge || ""}`.toLowerCase();
          const signalType = /landslide|mudslide|rockfall/.test(text) ? "landslide"
            : /flood|waterway|stream|river/.test(text) ? "flood"
            : tags.highway === "construction" ? "construction"
            : tags.bridge ? "bridge"
            : tags.amenity === "hospital" || tags.amenity === "fuel" ? "service"
            : tags.hazard ? "hazard"
            : "mapped_feature";
          const severity = signalType === "landslide" || signalType === "flood" ? 5
            : signalType === "hazard" ? 4
            : signalType === "construction" || signalType === "bridge" ? 3
            : 1;
          return {
            lat: e.lat ?? e.center?.lat,
            lon: e.lon ?? e.center?.lon,
            tags,
            signalType,
            severity,
            confidence: signalType === "mapped_feature" || signalType === "service" ? 0.45 : 0.7,
            source: "OpenStreetMap/Overpass",
            observedAt: Date.now()
          };
        })
        .filter((x) => x.lat && x.lon);
      // Phase 5: diff this fetch against the last one for this corridor
      // point and push anything NEW (hazard/construction tags only) to
      // dashboards watching a nearby route. Runs on every real upstream
      // fetch, i.e. roughly once per DATA_TTL_MS per point — see incidents.js.
      incidents.diffAndBroadcast(lat, lon, elements);
      return { elements: escapeDeep(elements), degraded: false };
    } catch (e) { console.warn("Overpass endpoint failed:", url, e.message); }
  }
  // Both endpoints failed — tell the frontend explicitly (bug fix: don't
  // silently pretend zero hazards were found).
  return { elements: [], degraded: true };
}

/* -------------------------------------------------------------------------
   6. EXPRESS APP + ROUTES
   ------------------------------------------------------------------------- */
const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---- GET /api/geocode?q=... --------------------------------------------
app.get("/api/geocode", async (req, res) => {
  const raw = String(req.query.q || "").trim();
  if (!raw) return res.status(400).json({ error: "Enter a location." });
  const key = `geo:${raw.toLowerCase()}`;
  const cached = geocodeCache.get(key);
  if (cached) return res.json(cached);
  try {
    const result = await geocodeUpstream(raw);
    geocodeCache.set(key, result, GEOCODE_TTL);
    res.json(result);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "Geocoding failed." });
  }
});

// ---- GET /api/route?points=lat,lon;lat,lon;... --------------------------
app.get("/api/route", async (req, res) => {
  const points = parsePoints(req.query.points);
  if (!points || points.length < 2) return res.status(400).json({ error: "At least an origin and destination are required." });
  const key = `route:${pointsKey(points)}`;
  const cached = dataCache.get(key);
  if (cached) return res.json(cached);
  try {
    const routes = await routeUpstream(points);
    dataCache.set(key, routes, DATA_TTL_MS);
    res.json(routes);
  } catch (e) {
    res.status(502).json({ error: e.message || "Routing failed." });
  }
});

// ---- GET /api/weather?lat=&lon= ------------------------------------------
app.get("/api/weather", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "lat/lon required." });
  const key = `weather:${roundCoord(lat)},${roundCoord(lon)}`;
  const cached = dataCache.get(key);
  if (cached) return res.json(cached);
  try {
    const w = await weatherUpstream(lat, lon);
    dataCache.set(key, w, DATA_TTL_MS);
    res.json(w);
  } catch (e) {
    res.status(502).json({ error: e.message || "Weather lookup failed." });
  }
});

// ---- GET /api/weather/history?lat=&lon=&days=30 --------------------------
// Phase 4: past-N-days rainfall at a corridor point, for the "past 30 days"
// strip in the weather card. Cached 24h (see HISTORY_TTL_MS) since a past
// date's actual rainfall is immutable.
app.get("/api/weather/history", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "lat/lon required." });
  const key = `wxhistory:${roundCoord(lat)},${roundCoord(lon)}:${days}`;
  const cached = dataCache.get(key);
  if (cached) return res.json(cached);
  try {
    const h = await weatherHistoryUpstream(lat, lon, days);
    dataCache.set(key, h, HISTORY_TTL_MS);
    res.json(h);
  } catch (e) {
    res.status(502).json({ error: e.message || "Historical weather lookup failed." });
  }
});

// ---- GET /api/hazards?lat=&lon= -------------------------------------------
app.get("/api/hazards", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "lat/lon required." });
  const key = `hazards:${roundCoord(lat)},${roundCoord(lon)}`;
  const cached = dataCache.get(key);
  if (cached) return res.json(cached);
  const result = await hazardsUpstream(lat, lon);
  if (!result.degraded) dataCache.set(key, result, DATA_TTL_MS); // don't cache degraded misses
  res.json(result);
});

// ---- GET /api/context?points=lat,lon;lat,lon;... ---------------------------
// Combines weather + hazards for a route corridor in ONE round trip, fired
// in parallel server-side via Promise.all (fixes sequential-await bug #15).
app.get("/api/context", async (req, res) => {
  const points = parsePoints(req.query.points);
  if (!points || points.length < 2) return res.status(400).json({ error: "At least an origin and destination are required." });
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  const key = `context:${roundCoord(lat)},${roundCoord(lon)}`;
  const cached = dataCache.get(key);
  if (cached) return res.json(cached);
  try {
    const corridorPoints = [points[0], points[Math.floor(points.length / 2)], points.at(-1)]
      .filter((point, index, arr) => point && arr.findIndex((p) => roundCoord(p.lat) === roundCoord(point.lat) && roundCoord(p.lon) === roundCoord(point.lon)) === index);
    const [weather, hazardResults] = await Promise.all([
      weatherUpstream(lat, lon),
      Promise.all(corridorPoints.map((point) => hazardsUpstream(point.lat, point.lon)))
    ]);
    const seen = new Set();
    const elements = hazardResults.flatMap((result) => result.elements || []).filter((element) => {
      const key = `${element.lat},${element.lon}:${element.signalType}:${element.tags?.name || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const degraded = hazardResults.every((result) => result.degraded);
    const rainfallNow = Number(weather.current?.precipitation) || 0;
    const forecastRain = (weather.daily?.precipitation_sum || []).slice(0, 2).reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (degraded && (rainfallNow >= 5 || forecastRain >= 30)) {
      elements.push({ lat, lon, tags: { name: "Weather-derived disruption warning" }, signalType: "rainfall_warning", severity: rainfallNow >= 15 || forecastRain >= 60 ? 5 : 3, confidence: 0.6, source: "Open-Meteo", observedAt: Date.now() });
    }
    const hazards = { elements: escapeDeep(elements), degraded };
    const payload = { weather, hazards };
    if (!hazards.degraded) dataCache.set(key, payload, DATA_TTL_MS);
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: e.message || "Context lookup failed." });
  }
});

// ---- POST /api/score  { routes, weather, hazards, origin, vehicle, priority } ----
// New in Phase 2: risk scoring moved server-side (was client-side riskFor()/
// tierRoutes() in app.js — see riskEngine.js header comment on why this is a
// fresh implementation rather than a verified port). Frontend now calls this
// after /api/route + /api/context instead of scoring locally.
//
// Phase 4: also stashes the scoring context (routes/weather/hazards/origin)
// in-memory under a short-lived sessionId, so /api/route-forecast can re-run
// scoreRoute() against forecast weather slices without the frontend having
// to re-POST the whole payload for every route it wants a trend for.
const SCORE_SESSION_TTL_MS = 15 * 60 * 1000; // long enough to view a detail sheet, not a DB
const scoreSessions = new TTLCache();
setInterval(() => scoreSessions.sweep(), 60_000).unref();
function randomId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

const KNOWN_VEHICLES = new Set(["car", "truck", "bus", "ambulance", "twoWheeler"]);
const KNOWN_PRIORITIES = new Set(["balanced", "safest", "fastest", "accessible", "logistics"]);
app.post("/api/score", express.json({limit: "10mb"}), async (req, res) => {
  const { routes, weather, hazards, origin, vehicle: rawVehicle, priority: rawPriority } = req.body || {};
  if (!Array.isArray(routes) || !routes.length) {
    return res.status(400).json({ error: "routes[] required (from /api/route)." });
  }
  // Phase 7: vehicle now feeds into roadAccess scoring (see riskEngine.js's
  // VEHICLE_ACCESS_PENALTY). Unknown/missing values fall back to "car" so a
  // stale frontend build never crashes scoring.
  const vehicle = KNOWN_VEHICLES.has(rawVehicle) ? rawVehicle : "car";
  const priority = KNOWN_PRIORITIES.has(rawPriority) ? rawPriority : "balanced";
  try {
    const originTerrain = (origin && origin.terrain) || terrainForState(origin && origin.state);
    const tiered = await tierRoutes(routes, { weather, hazards, originTerrain, mlClient, vehicle, priority });

    const sessionId = randomId();
    scoreSessions.set(sessionId, { routes, weather, hazards, originTerrain, vehicle, priority }, SCORE_SESSION_TTL_MS);

    res.json({ sessionId, routes: tiered });
  } catch (e) {
    console.error("Scoring failed:", e);
    res.status(500).json({ error: e.message || "Scoring failed." });
  }
});

// ---- GET /api/route-forecast?sessionId=&routeId= ---------------------------
// Phase 4: projects a route's risk SCORE (not raw weather) forward across
// the next 48h in 12h steps. Open-Meteo's own 6-day hourly/daily forecast
// (already fetched into `weather` at /api/context time) IS the predictor —
// this endpoint does not invent a new numerical weather model, it just
// re-runs riskEngine.scoreRoute() with the corridor's forecast precipitation
// swapped in for each future slice, so the SAME weighted-factor model the
// user sees for "now" also drives the 48h trend line.
function precipAtHoursAhead(weather, hoursAhead) {
  // Build a synthetic `weather` snapshot for scoreRoute()/weatherRisk() to
  // consume, using Open-Meteo's own hourly precipitation series plus the
  // existing 3-day-forward daily precipitation_sum for the longer-range part
  // of weatherRisk()'s exposure calc.
  const hourly = weather?.hourly || {};
  const times = hourly.time || [];
  const precip = hourly.precipitation || [];
  const now = Date.now();
  let idx = 0, bestDiff = Infinity;
  const targetMs = now + hoursAhead * 3600 * 1000;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]).getTime();
    const diff = Math.abs(t - targetMs);
    if (diff < bestDiff) { bestDiff = diff; idx = i; }
  }
  const precipNow = precip[idx] ?? 0;
  return {
    ...weather,
    current: { ...(weather?.current || {}), precipitation: precipNow },
    // daily.precipitation_sum stays as-is: weatherRisk() only uses the next
    // 3 entries as a forward-looking buffer regardless of hoursAhead, which
    // is an acceptable simplification for a 48h window inside a 6-day series
  };
}

app.get("/api/route-forecast", async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const routeId = String(req.query.routeId || "");
  const session = scoreSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session expired or not found — re-run route scoring first." });
  const route = (session.routes || []).find((r) => r.id === routeId);
  if (!route) return res.status(404).json({ error: `Route ${routeId} not found in this session.` });

  try {
    const steps = [0, 12, 24, 36, 48];
    const trend = await Promise.all(steps.map(async (hoursAhead) => {
      const projectedWeather = precipAtHoursAhead(session.weather, hoursAhead);
      const scored = await scoreRoute(route, {
        weather: projectedWeather,
        hazards: session.hazards,
        originTerrain: session.originTerrain,
        vehicle: session.vehicle,
        priority: session.priority,
        mlClient, // Phase 4 item 2 (30-day rainfall -> ML feature) is ON HOLD
                  // pending confirmation of the real model's feature contract
                  // (see conversation) — mlClient's existing interface is used
                  // unmodified here, same as every other scoring call.
      });
      return { hoursAhead, score: scored.riskScore };
    }));

    const first = trend[0].score, last = trend[trend.length - 1].score;
    const delta = Math.round((last - first) * 10) / 10;
    const summary =
      Math.abs(delta) < 3
        ? "Risk expected to stay roughly steady over the next 48h."
        : delta < 0
        ? `Risk expected to rise over the next 48h based on incoming rainfall (score ${first} → ${last}).`
        : `Risk expected to ease over the next 48h based on incoming rainfall (score ${first} → ${last}).`;

    res.json({ routeId, trend, summary });
  } catch (e) {
    console.error("Route forecast failed:", e);
    res.status(500).json({ error: e.message || "Route forecast failed." });
  }
});

// ---- POST /api/ai/logistics-brief -----------------------------------------
// OpenAI interprets already-computed route intelligence; it is not used as
// the source of truth for coordinates, risk scores, weather, or closures.
function fallbackLogisticsBrief(input) {
  const route = input.route || {};
  const risk = Number(route.riskScore);
  const hazards = Array.isArray(input.hazards) ? input.hazards : [];
  const degraded = Boolean(input.hazardsDegraded);
  const reasons = [];
  if (Number.isFinite(risk)) reasons.push(`Safety score is ${Math.round(risk)}/100.`);
  if (hazards.length) reasons.push(`${hazards.length} mapped hazard or disruption signal(s) are near the corridor.`);
  if (degraded) reasons.push("Live hazard data is unavailable, so the recommendation is conservative.");
  const decision = risk < 45 || hazards.length >= 3 ? "HOLD_AND_VERIFY" : risk < 65 || degraded ? "PROCEED_WITH_CAUTION" : "PROCEED";
  return {
    decision,
    confidence: degraded ? 0.45 : 0.7,
    reasons: reasons.slice(0, 3),
    actions: ["Confirm the latest field status before dispatch.", "Carry an alternate route plan and maintain driver check-ins."],
    alert: decision === "HOLD_AND_VERIFY" ? "Verify corridor accessibility before sending essential goods." : null,
    source: "rule-based-fallback"
  };
}

app.post("/api/ai/logistics-brief", express.json({ limit: "160kb" }), async (req, res) => {
  const body = req.body || {};
  if (!body.route || typeof body.route !== "object") return res.status(400).json({ error: "route intelligence is required." });
  const input = {
    mission: String(body.mission || "essential-goods transport").slice(0, 80),
    origin: String(body.origin || "").slice(0, 120),
    destination: String(body.destination || "").slice(0, 120),
    vehicle: String(body.vehicle || "car").slice(0, 30),
    priority: String(body.priority || "balanced").slice(0, 30),
    route: {
      id: String(body.route.id || "").slice(0, 10),
      distanceKm: Number(body.route.distance) || 0,
      durationSeconds: Number(body.route.duration) || 0,
      riskScore: Number(body.route.riskScore),
      tier: String(body.route.tier || "").slice(0, 30),
      tags: Array.isArray(body.route.tags) ? body.route.tags.slice(0, 8).map(String) : [],
      breakdown: body.route.breakdown && typeof body.route.breakdown === "object" ? body.route.breakdown : {}
    },
    alternatives: Array.isArray(body.alternatives) ? body.alternatives.slice(0, 3).map((route) => ({
      id: String(route.id || "").slice(0, 10),
      distanceKm: Number(route.distance) || 0,
      riskScore: Number(route.riskScore),
      tier: String(route.tier || "").slice(0, 30),
      tags: Array.isArray(route.tags) ? route.tags.slice(0, 6).map(String) : []
    })) : [],
    weather: body.weather && typeof body.weather === "object" ? {
      current: body.weather.current || {},
      daily: body.weather.daily || {}
    } : null,
    hazards: Array.isArray(body.hazards) ? body.hazards.slice(0, 25).map((hazard) => ({
      lat: Number(hazard.lat), lon: Number(hazard.lon), tags: hazard.tags || {}
    })) : [],
    hazardsDegraded: Boolean(body.hazardsDegraded),
    demoData: Boolean(body.demoData)
  };

  if (!openaiClient.configured()) return res.json(fallbackLogisticsBrief(input));
  try {
    const brief = await openaiClient.createLogisticsBrief(input);
    res.json({ ...brief, source: "openai" });
  } catch (e) {
    console.warn("OpenAI logistics brief unavailable:", e.message);
    res.json({ ...fallbackLogisticsBrief(input), source: "rule-based-fallback", degraded: true });
  }
});

// ---- Logistics missions and delivery stops -------------------------------
// Inspired by the fleet/session model in vehicle-tracking repositories, but
// kept in RAASTA's existing Express + Supabase architecture.
function cleanText(value, max = 160) {
  return String(value || "").trim().slice(0, max);
}
function supabaseTableMissing(error) {
  return /PGRST205|Could not find the table/i.test(String(error?.message || error));
}

app.post("/api/missions", express.json({ limit: "100kb" }), async (req, res) => {
  if (!supabaseStore.configured) return res.status(503).json({ error: "Supabase is required for mission persistence. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
  const body = req.body || {};
  const cargoType = cleanText(body.cargoType, 80);
  const origin = cleanText(body.origin, 120);
  const destination = cleanText(body.destination, 120);
  const priority = ["emergency", "high", "standard"].includes(body.priority) ? body.priority : "standard";
  if (!cargoType || !origin || !destination) return res.status(400).json({ error: "cargoType, origin, and destination are required." });

  const now = Date.now();
  const missionId = `m${Math.random().toString(36).slice(2, 10)}${now.toString(36).slice(-5)}`;
  const rawStops = Array.isArray(body.stops) ? body.stops.slice(0, 30) : [];
  const validatedStops = [];
  for (let i = 0; i < rawStops.length; i++) {
    const stop = rawStops[i] || {};
    const lat = Number(stop.lat), lon = Number(stop.lon);
    if (!cleanText(stop.name, 120) || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: `Invalid delivery stop at index ${i}.` });
    }
    validatedStops.push({
      name: cleanText(stop.name, 120),
      lat, lon,
      eta: Number.isFinite(Number(stop.eta)) ? Number(stop.eta) : null
    });
  }
  const mission = {
    id: missionId,
    cargo_type: cargoType,
    cargo_quantity: cleanText(body.cargoQuantity, 80) || null,
    priority,
    origin,
    destination,
    vehicle_id: cleanText(body.vehicleId, 64) || null,
    status: "planned",
    planned_eta: Number.isFinite(Number(body.plannedEta)) ? Number(body.plannedEta) : null,
    created_at: now,
    updated_at: now
  };
  try {
    const saved = await supabaseStore.createMission(mission);
    const stops = [];
    for (let i = 0; i < validatedStops.length; i++) {
      const stop = validatedStops[i];
      stops.push(await supabaseStore.createStop({
        id: `${missionId}-s${i + 1}`,
        mission_id: missionId,
        sequence: i + 1,
        name: stop.name,
        lat: stop.lat, lon: stop.lon,
        status: "pending",
        eta: stop.eta,
        arrived_at: null
      }));
    }
    res.status(201).json({ mission: saved, stops });
  } catch (e) {
    if (!supabaseTableMissing(e)) {
      console.error("Mission creation failed:", e);
      return res.status(503).json({ error: "Mission storage is temporarily unavailable." });
    }
    const localStops = validatedStops.map((stop, i) => ({ id: `${missionId}-s${i + 1}`, mission_id: missionId, sequence: i + 1, ...stop, status: "pending", arrived_at: null }));
    const saved = missionsStore.createMission(mission, localStops);
    res.status(201).json({ ...saved, storage: "local-fallback", warning: "Run supabase/schema.sql to persist missions in Supabase." });
  }
});

app.get("/api/missions", async (req, res) => {
  if (!supabaseStore.configured) return res.status(503).json({ error: "Supabase is required for mission persistence." });
  try {
    const missions = await supabaseStore.listMissions(Math.min(100, Math.max(1, Number(req.query.limit) || 50)));
    const withStops = await Promise.all(missions.map(async (mission) => ({ mission, stops: await supabaseStore.listStops(mission.id) })));
    res.json(withStops);
  } catch (e) {
    if (!supabaseTableMissing(e)) {
      console.error("Mission listing failed:", e);
      return res.status(503).json({ error: "Mission storage is temporarily unavailable." });
    }
    res.json(missionsStore.listMissions(Math.min(100, Math.max(1, Number(req.query.limit) || 50))).map((item) => ({ ...item, mission: { ...item.mission, storage: "local-fallback" } })));
  }
});

app.patch("/api/missions/:id", express.json({ limit: "20kb" }), async (req, res) => {
  if (!supabaseStore.configured) return res.status(503).json({ error: "Supabase is required for mission persistence." });
  const status = String(req.body?.status || "");
  if (!["planned", "in_transit", "delayed", "delivered", "cancelled"].includes(status)) return res.status(400).json({ error: "Invalid mission status." });
  try {
    const mission = await supabaseStore.updateMission(cleanText(req.params.id, 80), { status, updated_at: Date.now() });
    if (!mission) return res.status(404).json({ error: "Mission not found." });
    res.json(mission);
  } catch (e) {
    if (!supabaseTableMissing(e)) {
      console.error("Mission update failed:", e);
      return res.status(503).json({ error: "Mission storage is temporarily unavailable." });
    }
    const mission = missionsStore.updateMission(cleanText(req.params.id, 80), { status, updated_at: Date.now() });
    if (!mission) return res.status(404).json({ error: "Mission not found." });
    res.json({ ...mission, storage: "local-fallback" });
  }
});

app.patch("/api/delivery-stops/:id", express.json({ limit: "20kb" }), async (req, res) => {
  if (!supabaseStore.configured) return res.status(503).json({ error: "Supabase is required for delivery tracking." });
  const status = String(req.body?.status || "");
  if (!["pending", "arrived", "completed", "skipped"].includes(status)) return res.status(400).json({ error: "Invalid stop status." });
  try {
    const stop = await supabaseStore.updateStop(cleanText(req.params.id, 100), { status, arrived_at: status === "arrived" ? Date.now() : null });
    if (!stop) return res.status(404).json({ error: "Delivery stop not found." });
    res.json(stop);
  } catch (e) {
    if (!supabaseTableMissing(e)) {
      console.error("Delivery stop update failed:", e);
      return res.status(503).json({ error: "Delivery storage is temporarily unavailable." });
    }
    const stop = missionsStore.updateStop(cleanText(req.params.id, 100), { status, arrived_at: status === "arrived" ? Date.now() : null });
    if (!stop) return res.status(404).json({ error: "Delivery stop not found." });
    res.json({ ...stop, storage: "local-fallback" });
  }
});

function parsePoints(raw) {
  if (!raw) return null;
  try {
    return String(raw).split(";").map((pair) => {
      const [lat, lon] = pair.split(",").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("bad point");
      return { lat, lon };
    });
  } catch { return null; }
}

/* -------------------------------------------------------------------------
   6b. FIELD REPORTS — Phase 6
   -------------------------------------------------------------------------
   Phase 5's incidents.js was built with this exact hook in mind (see its
   header comment): a human field report reaches dashboards through the
   SAME broadcastIncident() path an Overpass hazard-diff uses, so the map
   doesn't need two separate "something happened here" mechanisms.

   Persistence is reportsStore.js (JSON-file, see server/SCHEMA.md for why
   that instead of better-sqlite3). Idempotency is handled there via
   clientId, which matters here specifically because public/app.js queues
   a report in IndexedDB when offline and retries it after reconnect —
   without a stable clientId, a flaky connection could double-post and
   double-broadcast the same report.
   ------------------------------------------------------------------------- */
const REPORT_LABELS = {
  road_damage: "Road damage reported",
  landslide: "Landslide reported",
  flood: "Flooding reported",
  bridge_damage: "Bridge damage reported",
  blockage: "Road blockage reported",
  traffic: "Traffic disruption reported",
  other: "Field report received"
};

app.post("/api/reports", express.json({ limit: "3mb" }), async (req, res) => {
  const parsed = reportsStore.validate(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  // esc() the note before it's ever stored/broadcast — it can end up in
  // innerHTML on the map popup, same reasoning as escapeDeep() above.
  const safeNote = esc(parsed.note);
  try {
    const { report, isNew } = await reportsStore.insert({ ...parsed, note: safeNote });

    if (isNew) {
      const label = REPORT_LABELS[report.category] || REPORT_LABELS.other;
      const message = report.note ? `${label}: ${report.note}` : `${label}.`;
      incidents.broadcastIncident(report.lat, report.lon, message);
    }

    res.status(isNew ? 201 : 200).json({ report, deduped: !isNew });
  } catch (e) {
    console.error("Report persistence failed:", e);
    res.status(503).json({ error: "Report storage is temporarily unavailable." });
  }
});

// ---- GET /api/reports?limit=&since= ---------------------------------------
// Backfill for a freshly-loaded map (Phase 3's positions endpoints follow
// the same pattern) and for a reconnecting client checking "did my queued
// report actually land" without re-POSTing.
app.get("/api/reports", async (req, res) => {
  const limit = Number(req.query.limit) || 200;
  const since = Number(req.query.since) || 0;
  try {
    res.json(await reportsStore.list({ limit, since }));
  } catch (e) {
    console.error("Report listing failed:", e);
    res.status(503).json({ error: "Report storage is temporarily unavailable." });
  }
});

/* -------------------------------------------------------------------------
   7. POSITION STORE — Phase 3
   -------------------------------------------------------------------------
   Brief asks for a SQLite `positions(deviceId, lat, lon, ts)` table. Real
   SQLite (via better-sqlite3) needs a native build step that regularly
   fails on free-tier hosts (Render/Railway/Fly build images don't always
   ship build-essential, and cold "npm install" there can time out compiling
   it). Since Phase 0 pins free tiers only and Phase 1 already established
   "SQLite if Postgres isn't available", we go one notch further here: a
   tiny append-only JSON-file store with the exact same shape as that table
   (one row per position, capped at 500/device) and a synchronous API. Swap
   this module for real `better-sqlite3` or Postgres later without touching
   any caller — the function signatures are the contract.
   ------------------------------------------------------------------------- */
const POSITIONS_FILE = path.join(__dirname, "positions.json");
const MAX_POINTS_PER_DEVICE = 500;

class PositionStore {
  constructor(file) {
    this.file = file;
    this.byDevice = new Map(); // deviceId -> [{lat, lon, ts}, ...] oldest→newest
    this._load();
  }
  _load() {
    try {
      const raw = JSON.parse(require("fs").readFileSync(this.file, "utf8"));
      for (const [deviceId, points] of Object.entries(raw)) this.byDevice.set(deviceId, points);
    } catch {
      // no file yet, or corrupt — start fresh rather than crash the server
    }
  }
  _persist() {
    // fire-and-forget async write; positions are a nice-to-have trail, not
    // transactional data, so we don't block the WS message loop on disk IO
    const obj = Object.fromEntries(this.byDevice);
    require("fs").writeFile(this.file, JSON.stringify(obj), (e) => {
      if (e) console.warn("PositionStore: write failed:", e.message);
    });
  }
  insert(deviceId, lat, lon, ts) {
    if (supabaseStore.configured) return supabaseStore.insertPosition(deviceId, lat, lon, ts);
    if (!this.byDevice.has(deviceId)) this.byDevice.set(deviceId, []);
    const arr = this.byDevice.get(deviceId);
    arr.push({ lat, lon, ts });
    if (arr.length > MAX_POINTS_PER_DEVICE) arr.splice(0, arr.length - MAX_POINTS_PER_DEVICE);
    this._persist();
  }
  history(deviceId) {
    if (supabaseStore.configured) return supabaseStore.history(deviceId);
    return this.byDevice.get(deviceId) || [];
  }
  lastSeen() {
    if (supabaseStore.configured) return supabaseStore.lastSeen();
    // one row per known device: {deviceId, lat, lon, ts} of its latest point
    const out = [];
    for (const [deviceId, arr] of this.byDevice) {
      if (arr.length) out.push({ deviceId, ...arr[arr.length - 1] });
    }
    return out.sort((a, b) => b.ts - a.ts);
  }
}
const positionStore = new PositionStore(POSITIONS_FILE);

// ---- GET /api/positions/:deviceId  — backfill a device's trail on connect --
app.get("/api/positions/:deviceId", async (req, res) => {
  try {
    res.json(await positionStore.history(String(req.params.deviceId)));
  } catch (e) {
    console.error("Position history failed:", e);
    res.status(503).json({ error: "Position storage is temporarily unavailable." });
  }
});

// ---- GET /api/devices  — currently-known devices + last-seen point --------
app.get("/api/devices", async (_req, res) => {
  try {
    res.json(await positionStore.lastSeen());
  } catch (e) {
    console.error("Device listing failed:", e);
    res.status(503).json({ error: "Position storage is temporarily unavailable." });
  }
});

/* -------------------------------------------------------------------------
   8. WEBSOCKET RELAY — Phase 3 (fixes bug #13: fake sine-wave nav → real GPS)
   -------------------------------------------------------------------------
   Two roles connect to the same /ws/track endpoint:
     - "tracker"   a phone running tracker.html, broadcasting its own
                   {deviceId, lat, lon, ts} every 5-10s.
     - "dashboard" the main map (app.js), which only listens.
   Relay rule: any tracker position is (a) appended to that device's rolling
   history via PositionStore, and (b) broadcast verbatim to every currently
   connected dashboard socket. Trackers never need to hear from each other,
   and dashboards never need to hear from each other, so this stays a plain
   fan-out — no rooms/topics beyond the two role sets.

   Phase 5 adds a second broadcast path on the SAME sockets: incidents.js
   pushes {type:"incident", lat, lon, message} to dashboard sockets whose
   watched route path(s) pass near a newly-detected hazard (see the "watch"
   message handling below and hazardsUpstream()'s diffAndBroadcast call).
   Phase 6 field reports (POST /api/reports, above) reuse this exact same
   broadcastIncident() path — no changes needed here.
   ------------------------------------------------------------------------- */
const server = http.createServer(app);
let wss = null;
try {
  const { WebSocketServer } = require("ws");
  wss = new WebSocketServer({ server, path: "/ws/track" });

  const dashboards = new Set();

  function isFiniteNum(n) { return typeof n === "number" && Number.isFinite(n); }

  wss.on("connection", (socket) => {
    socket.role = null; // set on first "join" message
    socket.send(JSON.stringify({ type: "hello" }));

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === "join") {
        if (msg.role === "dashboard") {
          socket.role = "dashboard";
          dashboards.add(socket);
          incidents.registerDashboard(socket); // Phase 5
          // greet with everyone we currently know about so a freshly-opened
          // dashboard doesn't have to wait for the next tracker tick
          positionStore.lastSeen()
            .then((devices) => {
              if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "devices", devices }));
            })
            .catch((e) => console.warn("Could not backfill devices:", e.message));
        } else if (msg.role === "tracker") {
          socket.role = "tracker";
          socket.deviceId = String(msg.deviceId || "").slice(0, 64) || null;
        }
        return;
      }

      // Phase 5: dashboard tells us which route path(s) it's currently
      // showing, so incident broadcasts can be scoped to "near an active
      // route" instead of fanned out to every connected dashboard.
      if (msg.type === "watch" && socket.role === "dashboard") {
        incidents.setWatchPaths(socket, msg.paths);
        return;
      }


      if (msg.type === "position" && socket.role === "tracker") {
        const deviceId = String(msg.deviceId || socket.deviceId || "").slice(0, 64);
        const lat = Number(msg.lat), lon = Number(msg.lon);
        const ts = Number(msg.ts) || Date.now();
        if (!deviceId || !isFiniteNum(lat) || !isFiniteNum(lon)) return;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;

        Promise.resolve(positionStore.insert(deviceId, lat, lon, ts))
          .catch((e) => console.warn("Could not persist position:", e.message));

        const payload = JSON.stringify({ type: "position", deviceId, lat, lon, ts });
        for (const dash of dashboards) {
          if (dash.readyState === dash.OPEN) dash.send(payload);
        }
      }
    });

    socket.on("close", () => { dashboards.delete(socket); incidents.unregisterDashboard(socket); });
  });
} catch {
  console.warn('"ws" package not installed — WebSocket relay disabled. Run `npm install`.');
}

/* -------------------------------------------------------------------------
   8. START
   ------------------------------------------------------------------------- */
server.listen(PORT, () => console.log(`RAASTA backend listening on http://localhost:${PORT}`));

module.exports = { app, server };
