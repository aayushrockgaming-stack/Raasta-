/* =========================================================================
   RAASTA incident pub/sub — Phase 5
   Split into its own file (server.js is already past the "split at ~400-500
   lines" guideline; this is a distinct enough concern — pub/sub, not proxy/
   cache logic — to warrant separating rather than growing server.js further).

   Two ways an "incident" gets born:
   1. diffAndBroadcast() — called by server.js's hazardsUpstream() every time
      a FRESH (non-cached) Overpass fetch comes back. Compares the new
      hazard/construction elements against whatever was seen at that
      corridor point last time and broadcasts only what's new.
   2. broadcastIncident() directly — the Phase 6 hook. Once POST /api/reports
      exists, call broadcastIncident(lat, lon, message) there too, so a
      human field report reaches dashboards the same way an Overpass diff
      does. Not wired to anything yet because Phase 6 doesn't exist.

   Delivery: only to dashboard sockets whose currently-displayed route(s)
   pass within ~5km of the incident (see setWatchPaths / nearAnyPath). A
   dashboard that hasn't told us what it's watching yet gets everything —
   better to over-deliver briefly than silently drop a real hazard.
   ========================================================================= */
"use strict";

const INCIDENT_RADIUS_KM = 5;

const dashboards = new Set();           // sockets with role === "dashboard"
const lastHazardsByPoint = new Map();   // "lat,lon" (rounded) -> last-seen elements[]

function roundCoord(n) {
  return Math.round(Number(n) * 500) / 500; // ~0.002° buckets, matches server.js
}

function registerDashboard(socket) {
  dashboards.add(socket);
  if (socket.watchPaths === undefined) socket.watchPaths = null;
}
function unregisterDashboard(socket) {
  dashboards.delete(socket);
}
function setWatchPaths(socket, paths) {
  // paths: array of routes, each an array of [lat, lon] pairs (already
  // downsampled client-side — see app.js's sendWatchPaths()).
  socket.watchPaths = Array.isArray(paths) ? paths : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function nearAnyPath(lat, lon, paths) {
  if (!paths || !paths.length) return true; // unknown viewport — don't silently drop
  for (const path of paths) {
    for (const [plat, plon] of path) {
      if (haversineKm(lat, lon, plat, plon) <= INCIDENT_RADIUS_KM) return true;
    }
  }
  return false;
}

function isIncidentWorthy(e) {
  return Boolean(e.tags?.hazard) || ["landslide", "flood", "construction", "bridge", "rainfall_warning"].includes(e.signalType) || e.tags?.highway === "construction";
}
function fingerprint(e) {
  return `${Number(e.lat).toFixed(4)},${Number(e.lon).toFixed(4)}:${e.tags.hazard || e.tags.highway || ""}`;
}
function messageFor(e) {
  return e.tags.highway === "construction"
    ? "New road construction reported near the corridor."
    : `New hazard signal reported: ${e.tags.hazard || "unspecified"}.`;
}

// Called by server.js's hazardsUpstream(lat, lon, elements) right after a
// fresh Overpass fetch. `lat`/`lon` is the corridor point that fetch was
// for; `elements` is what came back this time.
function diffAndBroadcast(lat, lon, elements) {
  const key = `${roundCoord(lat)},${roundCoord(lon)}`;
  const previous = lastHazardsByPoint.get(key) || [];
  const prevKeys = new Set(previous.filter(isIncidentWorthy).map(fingerprint));
  const fresh = elements.filter(isIncidentWorthy).filter((e) => !prevKeys.has(fingerprint(e)));
  lastHazardsByPoint.set(key, elements);
  fresh.forEach((e) => broadcastIncident(e.lat, e.lon, messageFor(e)));
}

function broadcastIncident(lat, lon, message) {
  const payload = JSON.stringify({ type: "incident", lat, lon, message });
  for (const socket of dashboards) {
    if (socket.readyState !== socket.OPEN) continue;
    if (nearAnyPath(lat, lon, socket.watchPaths)) socket.send(payload);
  }
}

module.exports = { registerDashboard, unregisterDashboard, setWatchPaths, diffAndBroadcast, broadcastIncident };
