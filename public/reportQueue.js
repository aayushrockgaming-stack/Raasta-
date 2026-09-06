/* =========================================================================
   reportQueue.js — Phase 6 offline report queue for tracker.html
   -------------------------------------------------------------------------
   tracker.html is a deliberately tiny, dependency-free page (per the Phase 3
   "one inline <script>, no separate JS file for something this small" rule),
   but the field-report form added in Phase 6 needs the same offline-queue
   behaviour as the dashboard's report composer in app.js. Rather than
   duplicate that logic inline, it lives here in one small shared file.

   Uses the SAME IndexedDB database/store name and record shape as app.js's
   inline queue (raasta-offline / pendingReports, keyed by clientId), so a
   report queued from a phone on tracker.html and a report queued from the
   dashboard are interchangeable — either page's sync loop can flush either
   page's queued reports, since IndexedDB is shared per-origin.

   Public API: ReportQueue.submit(payload) -> Promise<{queued: bool, report?}>
   - Tries POST /api/reports first.
   - On any failure (offline, network error, non-2xx), queues the report in
     IndexedDB and returns {queued: true} so the caller can show the right
     status message, then flushes automatically once the browser fires the
     'online' event (mirrors app.js's syncPendingReports()).
   ------------------------------------------------------------------------- */
"use strict";

const ReportQueue = (() => {
  const REPORTS_URL = "/api/reports";
  const IDB_NAME = "raasta-offline", IDB_VERSION = 1, IDB_STORE = "pendingReports";

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB unavailable"));
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE, { keyPath: "clientId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPut(report) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(report);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function idbDelete(clientId) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(clientId);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function idbAll() {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  function newClientId() {
    return crypto.randomUUID ? crypto.randomUUID() : "c-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function getReportDeviceId() {
    let id = localStorage.getItem("nerai-report-device");
    if (!id) { id = "rep-" + Math.random().toString(36).slice(2, 10); localStorage.setItem("nerai-report-device", id); }
    return id;
  }

  async function submit(fields) {
    const payload = {
      clientId: newClientId(),
      deviceId: getReportDeviceId(),
      lat: fields.lat, lon: fields.lon,
      category: fields.category, note: fields.note || "",
      photoBase64: fields.photoBase64 || null,
    };
    try {
      if (!navigator.onLine) throw new Error("offline");
      const r = await fetch(REPORTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return { queued: false, report: data.report };
    } catch {
      await idbPut(payload); // if this also throws, let it propagate — caller shows reportFailed
      return { queued: true };
    }
  }

  async function flush() {
    if (!navigator.onLine) return;
    let pending = [];
    try { pending = await idbAll(); } catch { return; }
    for (const rep of pending) {
      try {
        const r = await fetch(REPORTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rep),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await idbDelete(rep.clientId);
      } catch {
        // leave it queued, try again next 'online' event
      }
    }
  }

  window.addEventListener("online", flush);
  flush(); // best-effort catch-up if the page loads already online with a stale queue

  return { submit, flush };
})();
