"use strict";

// Uses Supabase REST directly so the backend needs no extra runtime package.
// Keep the service-role key server-side; never send it to public/ code.
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const configured = Boolean(supabaseUrl && serviceKey);

async function request(path, options = {}) {
  if (!configured) throw new Error("Supabase is not configured");
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.status === 204 ? null : response.json();
}

function fromReportRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    lat: Number(row.lat),
    lon: Number(row.lon),
    category: row.category,
    note: row.note || "",
    photoBase64: row.photo_base64 || null,
    deviceId: row.device_id || null,
    ts: Number(row.ts)
  };
}

async function findReportByClientId(clientId) {
  if (!clientId) return null;
  const params = new URLSearchParams({ select: "*", client_id: `eq.${clientId}`, limit: "1" });
  const rows = await request(`reports?${params}`);
  return rows[0] || null;
}

async function insertReport(report) {
  const rows = await request("reports", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      id: report.id,
      client_id: report.clientId,
      lat: report.lat,
      lon: report.lon,
      category: report.category,
      note: report.note,
      photo_base64: report.photoBase64,
      device_id: report.deviceId,
      ts: report.ts
    })
  });
  return rows[0];
}

async function listReports({ limit, since }) {
  const params = new URLSearchParams({
    select: "id,client_id,lat,lon,category,note,photo_base64,device_id,ts",
    order: "ts.desc",
    limit: String(limit)
  });
  if (since > 0) params.set("ts", `gt.${since}`);
  const rows = await request(`reports?${params}`);
  return rows.map(fromReportRow);
}

async function insertPosition(deviceId, lat, lon, ts) {
  await request("positions", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId, lat, lon, ts })
  });
}

async function history(deviceId) {
  const params = new URLSearchParams({
    select: "lat,lon,ts",
    device_id: `eq.${deviceId}`,
    order: "ts.asc",
    limit: "500"
  });
  const rows = await request(`positions?${params}`);
  return rows.map((row) => ({ lat: Number(row.lat), lon: Number(row.lon), ts: Number(row.ts) }));
}

async function lastSeen() {
  const params = new URLSearchParams({ select: "device_id,lat,lon,ts", order: "ts.desc", limit: "5000" });
  const rows = await request(`positions?${params}`);
  const latest = new Map();
  for (const row of rows) if (!latest.has(row.device_id)) {
    latest.set(row.device_id, { deviceId: row.device_id, lat: Number(row.lat), lon: Number(row.lon), ts: Number(row.ts) });
  }
  return [...latest.values()];
}

async function createMission(mission) {
  const rows = await request("missions", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(mission)
  });
  return rows[0];
}

async function listMissions(limit = 100) {
  const params = new URLSearchParams({ select: "*", order: "updated_at.desc", limit: String(limit) });
  return request(`missions?${params}`);
}

async function updateMission(id, patch) {
  const params = new URLSearchParams({ id: `eq.${id}` });
  const rows = await request(`missions?${params}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  return rows[0] || null;
}

async function createStop(stop) {
  const rows = await request("delivery_stops", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(stop)
  });
  return rows[0];
}

async function listStops(missionId) {
  const params = new URLSearchParams({ mission_id: `eq.${missionId}`, order: "sequence.asc" });
  return request(`delivery_stops?${params}`);
}

async function updateStop(id, patch) {
  const params = new URLSearchParams({ id: `eq.${id}` });
  const rows = await request(`delivery_stops?${params}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  return rows[0] || null;
}

module.exports = { configured, findReportByClientId, insertReport, listReports, insertPosition, history, lastSeen, createMission, listMissions, updateMission, createStop, listStops, updateStop, fromReportRow };
