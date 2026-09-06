/* =========================================================================
   RAASTA field reports store — Phase 6
   -------------------------------------------------------------------------
   The brief calls for "SQLite/lightweight persistence already compatible
   with the project." Phase 3's PositionStore already made — and documented
   — the call to avoid `better-sqlite3` here: it needs a native build step
   that regularly fails on free-tier hosts (Render/Railway/Fly build images
   don't always ship build-essential, and a cold `npm install` there can
   time out compiling it). We follow that same precedent rather than
   reintroduce the risk for a second table: an append-only JSON-file store,
   same shape as a `reports(id, client_id, lat, lon, category, note,
   photo_data_url, device_id, ts)` table would have, with a synchronous
   read + fire-and-forget write API. Swap this module for real
   better-sqlite3/Postgres later without touching any caller — the function
   signatures are the contract (see server/SCHEMA.md for the conceptual
   schema this mirrors).

   Idempotency: the offline queue (public/app.js) may retry a POST /api/
   reports call after a flaky connection without knowing whether the first
   attempt actually landed. Every report carries a client-generated
   `clientId`; insert() is a no-op (returns the existing row) if that
   clientId has been seen before, so a retried sync never double-posts a
   report or double-fires an incident broadcast.
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const supabaseStore = require("./supabaseStore");

const REPORTS_FILE = path.join(__dirname, "reports.json");
const MAX_REPORTS = 5000; // append-only trail cap, oldest dropped first
const MAX_PHOTO_CHARS = 2_000_000; // ~1.5MB binary once a data: URL is decoded

const CATEGORIES = new Set([
  "road_damage", "landslide", "flood", "bridge_damage", "blockage", "traffic", "other"
]);

let reports = [];        // oldest -> newest
let byClientId = new Map(); // clientId -> report, for idempotent retries

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(REPORTS_FILE, "utf8"));
    if (Array.isArray(raw)) {
      reports = raw;
      byClientId = new Map(reports.filter((r) => r.clientId).map((r) => [r.clientId, r]));
    }
  } catch {
    // no file yet, or corrupt — start fresh rather than crash the server
  }
}
load();

function persist() {
  // fire-and-forget async write — a field report queue is durable-ish, not
  // transactional, so we don't block the request/WS loop on disk IO
  fs.writeFile(REPORTS_FILE, JSON.stringify(reports), (e) => {
    if (e) console.warn("reportsStore: write failed:", e.message);
  });
}

function randomId() {
  return "r" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-5);
}

// Server-side validation — never trust the client payload shape.
function validate(body) {
  const lat = Number(body.lat), lon = Number(body.lon);
  const category = String(body.category || "").trim();
  const note = String(body.note || "").trim().slice(0, 500);
  const deviceId = body.deviceId ? String(body.deviceId).trim().slice(0, 64) : null;
  const clientId = body.clientId ? String(body.clientId).trim().slice(0, 80) : null;
  const photoDataUrl = body.photoBase64 ? String(body.photoBase64) : null;

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { error: "A valid lat/lon is required." };
  }
  if (!CATEGORIES.has(category)) {
    return { error: `category must be one of: ${[...CATEGORIES].join(", ")}` };
  }
  if (photoDataUrl && photoDataUrl.length > MAX_PHOTO_CHARS) {
    return { error: "Photo is too large." };
  }
  return { lat, lon, category, note, deviceId, clientId, photoDataUrl };
}

function findByClientId(clientId) {
  return clientId ? byClientId.get(clientId) || null : null;
}

// Returns { report, isNew }. If clientId was already seen, returns the
// existing row unchanged (isNew:false) — the caller should skip the
// incident broadcast in that case, since it already fired the first time.
function insertLocal(body) {
  const existing = findByClientId(body.clientId);
  if (existing) return { report: existing, isNew: false };

  const report = {
    id: randomId(),
    clientId: body.clientId || null,
    lat: body.lat,
    lon: body.lon,
    category: body.category,
    note: body.note,
    photoBase64: body.photoDataUrl || null,
    deviceId: body.deviceId || null,
    ts: Date.now()
  };
  reports.push(report);
  if (body.clientId) byClientId.set(body.clientId, report);
  if (reports.length > MAX_REPORTS) {
    const dropped = reports.splice(0, reports.length - MAX_REPORTS);
    for (const d of dropped) if (d.clientId) byClientId.delete(d.clientId);
  }
  persist();
  return { report, isNew: true };
}

async function insert(body) {
  if (!supabaseStore.configured) return insertLocal(body);
  const existing = await supabaseStore.findReportByClientId(body.clientId);
  if (existing) return { report: supabaseStore.fromReportRow(existing), isNew: false };

  const report = {
    id: randomId(),
    clientId: body.clientId || null,
    lat: body.lat,
    lon: body.lon,
    category: body.category,
    note: body.note,
    photoBase64: body.photoDataUrl || null,
    deviceId: body.deviceId || null,
    ts: Date.now()
  };
  const saved = await supabaseStore.insertReport(report);
  return { report: supabaseStore.fromReportRow(saved), isNew: true };
}

// list({limit, since}) — newest first. `since` (ms epoch) lets a dashboard
// or a reconnecting offline client ask for "anything I might have missed."
function listLocal({ limit = 200, since = 0 } = {}) {
  const cap = Math.min(1000, Math.max(1, Number(limit) || 200));
  return reports
    .filter((r) => r.ts > since)
    .slice(-cap)
    .reverse();
}

async function list({ limit = 200, since = 0 } = {}) {
  const cap = Math.min(1000, Math.max(1, Number(limit) || 200));
  if (supabaseStore.configured) return supabaseStore.listReports({ limit: cap, since: Number(since) || 0 });
  return listLocal({ limit: cap, since });
}

module.exports = { CATEGORIES, validate, insert, findByClientId, list };
