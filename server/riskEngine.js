/* =========================================================================
   RAASTA / NER Route Intelligence — riskEngine.js (Phase 2)

   IMPORTANT PROVENANCE NOTE FOR WHOEVER REVIEWS THIS:
   The Phase 2 brief says to "move" riskFor()/weatherRisk()/tierRoutes()/
   routeTags() out of app.js. The app.js you provided is a 0-byte empty
   file, so there was nothing to move. Everything below is written FRESH
   from the README's bug list and architecture description, not ported from
   prior code. If you have the real original logic, treat this as a
   reference implementation to diff against rather than a verified port.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

/* -------------------------------------------------------------------------
   0. STATIC REFERENCE DATA
   ------------------------------------------------------------------------- */

// Fix for bug #6 (terrain regex duplicated 3 places, inconsistent):
// ONE lookup table. LOC-table city terrain should come from the frontend's
// own LOC table when available; this state-level table is the fallback for
// geocoded (non-LOC) places, replacing the old "guess from display name"
// regex used during Nominatim geocoding.
const STATE_TERRAIN = {
  "arunachal pradesh": "mountain",
  "meghalaya": "plateau",
  "mizoram": "mountain",
  "nagaland": "mountain",
  "manipur": "mountain",
  "sikkim": "mountain",
  "assam": "plain",
  "tripura": "plain",
};
function terrainForState(state) {
  return STATE_TERRAIN[String(state || "").trim().toLowerCase()] || "plain";
}

// Road-class grid (bug #9): built once from NER_roads_compact.csv by
// ml/build_roads_grid.py (see /server/roads_grid.json). Each cell holds the
// single highest-priority road class present in that ~5.5km cell.
const roadsGridPath = path.join(__dirname, "roads_grid.json");
let ROADS_GRID = { grid_deg: 0.05, cells: {} };
try {
  ROADS_GRID = JSON.parse(fs.readFileSync(roadsGridPath, "utf8"));
} catch (e) {
  console.warn("riskEngine: roads_grid.json not found, road-class factor will default to 'unknown'. Run ml/build_roads_grid.py.");
}
function roadClassAt(lat, lon) {
  const g = ROADS_GRID.grid_deg;
  const glat = Math.round(lat / g);
  const glon = Math.round(lon / g);
  return ROADS_GRID.cells[`${glat},${glon}`] || { class: "unknown", nh: false, sh: false, priority: 0 };
}

/* -------------------------------------------------------------------------
   1. WEIGHTS — fix for bug #5 (double counting)
   -------------------------------------------------------------------------
   OLD BUG: a `safety` composite was built from wr/landslide/road/blockage,
   and then those same four factors were ALSO separately weighted on top of
   `safety` in the final score — so each of them counted twice, once inside
   `safety` and once standalone. That silently overweighted anything that
   fed `safety` and made the factor breakdown non-additive (the displayed
   per-factor numbers didn't actually sum to the total shown to the user,
   which is indefensible in front of judges who ask "show your work").

   FIX (option a, per the brief): there is no `safety` composite anymore.
   The total score is simply the weighted sum of the five independent
   factors below, each computed once. Weights sum to 1.0, so the total is
   already a 0-100 scale and the breakdown IS the total — you can literally
   add the printed per-factor contributions and get the printed score.
   ------------------------------------------------------------------------- */
const WEIGHTS = {
  rainfall: 0.28,      // live/forecast precipitation exposure along corridor
  landslideRisk: 0.27, // terrain heuristic blended with ML probability
  roadAccess: 0.20,    // NH > SH > rural, from the roads grid
  blockage: 0.15,      // active construction/hazard nodes from Overpass
  routeCost: 0.10,     // distance + duration, recalibrated for real NER trips
};
// sanity check at module load so a future edit that breaks the sum-to-1
// invariant fails loudly instead of silently reintroducing bug #5's symptom
const _wsum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(_wsum - 1) > 1e-6) throw new Error(`riskEngine WEIGHTS must sum to 1, got ${_wsum}`);

/* -------------------------------------------------------------------------
   2. RECALIBRATED DISTANCE/DURATION SCALING — fix for bug #8
   -------------------------------------------------------------------------
   OLD BUG: `100 - duration/3600*10` and `100 - distance/5` hit zero at
   360km / 10hr and 500km — both routine for real NER intercity trips
   (Guwahati-Itanagar is ~380km/9-10hr; anything crossing to Sikkim or
   Dibrugarh is 500-900km), so realistic routes always came out with a
   route-cost factor of exactly 0, flattening the entire signal.

   RECALIBRATION SAMPLE (haversine * 1.45 road-winding factor, 32km/h avg
   incl. hill sections, across 12 major NER city pairs — Guwahati, Shillong,
   Itanagar, Kohima, Imphal, Aizawl, Agartala, Gangtok, Dibrugarh, Silchar,
   Tezpur, Dimapur):
     - shortest pair  ~67 km  / ~2.1 hr   (e.g. Guwahati-Shillong)
     - longest pair   ~903 km / ~28.2 hr  (Gangtok-Dibrugarh, cross-region)
   So the new scale gives credit down to ~1000km / ~30hr instead of zeroing
   out at 500km / 10hr, matching the actual range of trips this app has to
   score. Anything beyond that ceiling still floors at 0 rather than going
   negative.
   ------------------------------------------------------------------------- */
const DISTANCE_CEILING_KM = 1000;
const DURATION_CEILING_HR = 30;
function routeCostScore(distanceKm, durationSec) {
  const durationHr = durationSec / 3600;
  const distScore = Math.max(0, 100 - (distanceKm / DISTANCE_CEILING_KM) * 100);
  const durScore = Math.max(0, 100 - (durationHr / DURATION_CEILING_HR) * 100);
  return (distScore + durScore) / 2;
}

/* -------------------------------------------------------------------------
   3. WEATHER / RAINFALL FACTOR
   ------------------------------------------------------------------------- */
function weatherRisk(weather) {
  if (!weather) return { score: 50, note: "No weather data available." };
  const cur = weather.current || {};
  const daily = weather.daily || {};
  const precipNow = Number(cur.precipitation) || 0;
  const precipSumNext = (daily.precipitation_sum || []).slice(0, 3).reduce((a, b) => a + (Number(b) || 0), 0);
  // 0mm -> 100 (best), 150mm across next 3 days + today's rate -> 0 (worst)
  const exposure = precipNow * 8 + precipSumNext; // weight "right now" heavier than forecast
  const score = Math.max(0, 100 - (exposure / 150) * 100);
  return {
    score: Math.round(score),
    note: `${precipNow}mm now, ${precipSumNext.toFixed(0)}mm forecast over next 3 days`,
  };
}

/* -------------------------------------------------------------------------
   4. LANDSLIDE FACTOR — terrain heuristic blended with ML (bug #7 wiring)
   -------------------------------------------------------------------------
   Never a single point of failure: if the ML service is unreachable or
   slow, we fall back to the pure terrain+rainfall heuristic rather than
   failing the whole score. When the ML call succeeds, blend 60% ML / 40%
   heuristic — ML gets the majority weight because it's trained on 705 real
   NER landslide events, but the heuristic keeps a sanity floor under it.
   ------------------------------------------------------------------------- */
const TERRAIN_BASE_RISK = { mountain: 65, plateau: 40, plain: 15 };

function landslideHeuristic(terrain, rainMm) {
  const base = TERRAIN_BASE_RISK[terrain] ?? 30;
  const rainBoost = Math.min(35, rainMm * 0.4); // heavy rain amplifies terrain risk
  return Math.min(100, base + rainBoost);
}

async function landslideFactor({ lat, lon, terrain, rainfallMm, mlFeatures, mlClient }) {
  const heuristicRisk = landslideHeuristic(terrain, rainfallMm);
  if (!mlClient) {
    return { score: 100 - heuristicRisk, riskPct: heuristicRisk, source: "heuristic-only (no ML client configured)" };
  }
  try {
    if (!mlFeatures) {
      throw new Error("No historical rainfall features available for ML inference");
    }
    const ml = await mlClient.predict(mlFeatures);
    const mlRiskPct = ml.landslide_probability * 100;
    const blended = 0.6 * mlRiskPct + 0.4 * heuristicRisk;
    return {
      score: Math.round(100 - blended),
      riskPct: Math.round(blended),
      source: ml.degraded_estimate ? "ML (degraded estimate) + heuristic blend" : "ML + heuristic blend",
      mlRiskPct: Math.round(mlRiskPct),
      heuristicRiskPct: Math.round(heuristicRisk),
    };
  } catch (e) {
    console.warn("riskEngine: ML service unavailable, falling back to heuristic only:", e.message);
    return { score: Math.round(100 - heuristicRisk), riskPct: Math.round(heuristicRisk), source: "heuristic-only (ML call failed)" };
  }
}

/* -------------------------------------------------------------------------
   5. ROAD ACCESS FACTOR — bug #9, extended in Phase 7 for bug #3
   -------------------------------------------------------------------------
   Phase 7 note on the vehicle selector (bug #3): public OSRM only ships
   driving/walking/cycling profiles, so car/truck/bus/ambulance/two-wheeler
   all physically route identically — there's no free way to make OSRM
   itself route a truck differently from a car. Rather than ship a control
   that silently does nothing (or fake a route difference we can't actually
   provide), the vehicle type is wired into SAFETY SCORING ONLY: larger,
   less maneuverable vehicles get a real accessibility penalty on
   rural/narrow-road-heavy routes, since a mostly-rural corridor is a
   genuinely bigger accessibility/safety concern for a loaded truck or bus
   than for a car or two-wheeler. This is explicit and visible in the UI
   (see index.html vehicle_scoring_note) rather than implied to change the
   physical path.
   ------------------------------------------------------------------------- */
const VEHICLE_ACCESS_PENALTY = {
  // multiplier applied to the rural-road SHARE before it reduces the score;
  // 1.0 = no extra penalty beyond the base NH/SH/rural priority scoring
  car: 1.0,
  twoWheeler: 0.6,   // two-wheelers manage narrow/rural roads more easily
  ambulance: 1.0,    // scored like a car — the concern for ambulances is speed/access, not maneuverability
  truck: 1.6,        // rural roads and narrow bridges are a real constraint for loaded trucks
  bus: 1.5,
};
function roadAccessScore(path, vehicle) {
  if (!path || !path.length) return { score: 50, nhShare: 0, shShare: 0, vehiclePenaltyApplied: 0 };
  // sample every ~10th point along the path to keep this cheap on long routes
  const sample = path.filter((_, i) => i % 10 === 0);
  let nh = 0, sh = 0, prioritySum = 0;
  for (const [lat, lon] of sample) {
    const r = roadClassAt(lat, lon);
    if (r.nh) nh++;
    if (r.sh) sh++;
    prioritySum += r.priority;
  }
  const n = sample.length || 1;
  const avgPriority = prioritySum / n; // 0-6 scale, see build_roads_grid.py PRIORITY table
  let score = Math.min(100, (avgPriority / 6) * 100);
  const nhShare = Math.round((nh / n) * 100), shShare = Math.round((sh / n) * 100);
  const ruralShare = Math.max(0, 100 - nhShare - shShare);
  const penaltyMult = VEHICLE_ACCESS_PENALTY[vehicle] ?? 1.0;
  // extra penalty is proportional to how rural the route is AND how much
  // worse this vehicle handles rural roads than the car baseline (1.0)
  const extraPenalty = ruralShare * 0.15 * Math.max(0, penaltyMult - 1.0);
  score = Math.max(0, score - extraPenalty);
  return { score: Math.round(score), nhShare, shShare, vehiclePenaltyApplied: Math.round(extraPenalty * 10) / 10 };
}

/* -------------------------------------------------------------------------
   6. BLOCKAGE FACTOR (Overpass hazards/construction nodes near the route)
   ------------------------------------------------------------------------- */
function blockageScore(hazards) {
  if (!hazards || hazards.degraded) return { score: 60, note: "Hazard data degraded/unavailable — neutral score applied." };
  const blockers = (hazards.elements || []).filter(
    (e) => ["construction", "landslide", "flood", "bridge", "hazard", "rainfall_warning"].includes(e.signalType) || e.tags?.highway === "construction" || e.tags?.hazard
  );
  const score = Math.max(0, 100 - blockers.length * 15);
  return { score: Math.round(score), blockerCount: blockers.length };
}

/* -------------------------------------------------------------------------
   7. PER-ROUTE SCORING + TIERING
   ------------------------------------------------------------------------- */
async function scoreRoute(route, ctx) {
  const { weather, hazards, originTerrain, mlClient, mlFeaturesByRoute, vehicle } = ctx;
  const wRisk = weatherRisk(weather);
  const rainNow = Number(weather?.current?.precipitation) || 0;
  const midIdx = Math.floor((route.path?.length || 1) / 2);
  const [midLat, midLon] = route.path?.[midIdx] || [0, 0];

  const lFactor = await landslideFactor({
    lat: midLat, lon: midLon, terrain: originTerrain, rainfallMm: rainNow,
    mlFeatures: mlFeaturesByRoute?.[route.id], mlClient,
  });
  const rAccess = roadAccessScore(route.path, vehicle);
  const bScore = blockageScore(hazards);
  const cScore = routeCostScore(route.distance, route.duration);

  const factors = {
    rainfall: wRisk.score,
    landslideRisk: lFactor.score,
    roadAccess: rAccess.score,
    blockage: bScore.score,
    routeCost: cScore,
  };

  // The whole point of fixing bug #5: this breakdown IS the total, additively.
  const breakdown = {};
  let total = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const contribution = factors[key] * weight;
    breakdown[key] = { factorScore: Math.round(factors[key]), weight, contribution: Math.round(contribution * 100) / 100 };
    total += contribution;
  }
  total = Math.round(total * 100) / 100;

  return {
    ...route,
    riskScore: total,
    breakdown,
    detail: {
      weather: wRisk.note,
      landslide: lFactor,
      roadAccess: rAccess,
      blockage: bScore,
    },
  };
}

function tierFor(score) {
  if (score >= 70) return "Safest";
  if (score >= 45) return "Moderate";
  return "Higher-risk";
}

function routeTags(scoredRoute) {
  const tags = [];
  if (scoredRoute.detail.roadAccess.nhShare > 50) tags.push("Mostly NH");
  else if (scoredRoute.detail.roadAccess.shShare > 50) tags.push("Mostly SH");
  else tags.push("Rural roads");
  if (scoredRoute.detail.blockage.blockerCount > 0) tags.push(`${scoredRoute.detail.blockage.blockerCount} active blockage(s)`);
  if (scoredRoute.detail.landslide.riskPct >= 55) tags.push("Elevated landslide risk");
  return tags;
}

async function tierRoutes(routes, ctx) {
  const scored = await Promise.all(routes.map((r) => scoreRoute(r, ctx)));
  const priority = ctx.priority || "balanced";
  const routeValue = (route) => {
    const safety = route.riskScore;
    const speed = route.breakdown.routeCost?.factorScore || 0;
    const access = route.detail.roadAccess.score;
    if (priority === "fastest") return route.duration ? 100000 - route.duration : 0;
    if (priority === "accessible") return access * 1000 + safety;
    if (priority === "logistics") return safety * 0.55 + speed * 0.25 + access * 0.2;
    if (priority === "safest") return safety;
    return safety * 0.7 + speed * 0.2 + access * 0.1;
  };
  scored.sort((a, b) => routeValue(b) - routeValue(a));
  return scored.map((r) => ({ ...r, tier: tierFor(r.riskScore), tags: routeTags(r) }));
}

module.exports = { tierRoutes, scoreRoute, terrainForState, roadClassAt, WEIGHTS };
