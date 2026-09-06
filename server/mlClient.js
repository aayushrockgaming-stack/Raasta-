/* -------------------------------------------------------------------------
   mlClient.js — talks to ml_service.py (FastAPI) over HTTP.
   Kept deliberately tiny + timeout-guarded: riskEngine.js treats any
   failure here as "fall back to heuristic", per the Phase 2 requirement
   that the ML service is never a single point of failure for scoring.
   ------------------------------------------------------------------------- */
"use strict";

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:8000";

async function predict({ lat, lon, rainfall_mm, month, recent_rainfall_mm }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500); // fail fast, don't stall route scoring
  try {
    const r = await fetch(`${ML_SERVICE_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, rainfall_mm, month, recent_rainfall_mm }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`ML service HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

module.exports = { predict };
