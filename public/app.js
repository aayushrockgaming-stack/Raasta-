/* NER-AI v10: fully free OpenStreetMap + OSRM + Nominatim stack. */
(() => {
"use strict";

const CONFIG = {
  routingProvider: "OSRM",
  maxAlternatives: 3,
  geocoderProvider: "Nominatim",
  mapProvider: "OpenStreetMap"
};

// Phase 1: third-party APIs are no longer called directly from the browser.
// Everything now goes through our own backend, which proxies, caches, rate-
// limits, and parallelizes the upstream calls. See /server/server.js.
const API = {
  geocode: "/api/geocode",
  route: "/api/route",
  context: "/api/context", // weather + hazards, fetched together server-side
  score: "/api/score", // Phase 2: risk scoring moved server-side (riskEngine.js)
  history: "/api/weather/history", // Phase 4: past-N-days rainfall at a point
  routeForecast: "/api/route-forecast", // Phase 4: 48h risk-score trend for a scored route
  reports: "/api/reports", // Phase 6: field reports
  aiBrief: "/api/ai/logistics-brief",
  missions: "/api/missions"
};

// Phase 2: tier names coming back from the backend ("Safest"/"Moderate"/
// "Higher-risk") map to the same CSS hooks the UI already had for
// best/average/worst, so nothing downstream of this needs to change.
// Phase 7 (bug #19 fix): each tier now also carries a shape/icon prefix so
// the risk badge is never color-only — colorblind users get a second,
// non-color signal (✓ / ! / ✕) alongside the badge's text label.
const TIER_META = {
  Safest: { cls: "best", badge: "safe", icon: "✓" },
  Moderate: { cls: "average", badge: "caution", icon: "!" },
  "Higher-risk": { cls: "worst", badge: "risk", icon: "✕" }
};
const tierMeta = t => TIER_META[t] || TIER_META.Moderate;

// Human labels for the breakdown keys riskEngine.js returns.
const FACTOR_LABELS = {
  rainfall: "Rainfall", landslideRisk: "Landslide", roadAccess: "Road access",
  blockage: "Blockage", routeCost: "Route cost"
};

const LOC = {
  Guwahati:{state:"Assam",lat:26.1445,lon:91.7362,terrain:"plain"},
  Shillong:{state:"Meghalaya",lat:25.5788,lon:91.8933,terrain:"plateau"},
  Ziro:{state:"Arunachal Pradesh",lat:27.5833,lon:93.8333,terrain:"mountain"},
  Itanagar:{state:"Arunachal Pradesh",lat:27.0844,lon:93.6053,terrain:"mountain"},
  Tawang:{state:"Arunachal Pradesh",lat:27.5859,lon:91.8594,terrain:"mountain"},
  Dibrugarh:{state:"Assam",lat:27.4728,lon:94.912,terrain:"plain"},
  Tezpur:{state:"Assam",lat:26.6528,lon:92.8,terrain:"plain"},
  Jorhat:{state:"Assam",lat:26.7509,lon:94.2037,terrain:"plain"},
  Silchar:{state:"Assam",lat:24.8333,lon:92.7789,terrain:"plain"},
  Cherrapunji:{state:"Meghalaya",lat:25.2702,lon:91.7323,terrain:"plateau"},
  Tura:{state:"Meghalaya",lat:25.5148,lon:90.2201,terrain:"plateau"},
  Imphal:{state:"Manipur",lat:24.817,lon:93.9368,terrain:"mountain"},
  Aizawl:{state:"Mizoram",lat:23.7271,lon:92.7176,terrain:"mountain"},
  Kohima:{state:"Nagaland",lat:25.6751,lon:94.1086,terrain:"mountain"},
  Dimapur:{state:"Nagaland",lat:25.9091,lon:93.728,terrain:"plain"},
  Agartala:{state:"Tripura",lat:23.8315,lon:91.2868,terrain:"plain"},
  Gangtok:{state:"Sikkim",lat:27.3389,lon:88.6065,terrain:"mountain"}
};

// Routeable representatives for state-level searches. A state name is not a road node,
// so we resolve it to a major road-connected city instead of routing to a polygon centroid.
const STATE_ALIASES = {
  "arunachal pradesh":"Itanagar", "assam":"Guwahati", "meghalaya":"Shillong",
  "manipur":"Imphal", "mizoram":"Aizawl", "nagaland":"Kohima",
  "tripura":"Agartala", "sikkim":"Gangtok"
};

const ALIASES = {
  "ziro valley":"Ziro", "hapoli":"Ziro", "itanagar city":"Itanagar",
  "guwahati city":"Guwahati", "shillong city":"Shillong", "aizawl city":"Aizawl"
};

const S = {
  stops:["Guwahati","Ziro"], routes:[], active:null, weather:null, places:[],
  incidents:[], hazards:[], services:[], layers:{incidents:true,hazards:true,pace:false,services:false,reports:true},
  vehicle:"car", priority:"balanced", demo:false, nav:null,
  sessionId:null, rainHistory:null, forecastCache:{}, // Phase 4
  usingCached:false // Phase 6: last /api/context response came from the SW's offline cache
};

let map, mapTiles, satTiles, routeLayer, markerLayer, incidentLayer, hazardLayer, serviceLayer, liveIncidentLayer, trackLayer, reportLayer, userLocationLayer, userLocationMarker, userLocationAccuracy, userLocationWatchId=null;
let navTimer=null, navIndex=0, navPath=[], traveledLine=null, navMarker=null, followNav=true, navDeviceId=null;

// Phase 3: live GPS tracking state — one entry per phone broadcasting from
// tracker.html. Replaces the old fake sine-wave nav marker with real
// devices relayed over WebSocket (bug #13).
const TRACK = { devices: new Map(), ws: null }; // deviceId -> {marker, trail:[LatLng], lastSeen}

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const km = m => (m/1000).toFixed(m/1000<10?1:0);
const minsText = sec => { let m=Math.round(sec/60); return m<60?`${m} min`:`${Math.floor(m/60)} hr ${m%60} min`; };
const toast = msg => { $("toast").textContent=msg; $("toast").hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>$("toast").hidden=true,3200); };
const T = (key,vars) => (window.I18N ? window.I18N.t(key,vars) : key);

function init(){
  map=L.map("map",{zoomControl:false,preferCanvas:true,worldCopyJump:false,maxBounds:[[-60,-180],[85,180]]}).setView([26.2,92.5],7);
  mapTiles=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:20,detectRetina:true,attribution:"© OpenStreetMap contributors"}).addTo(map);
  satTiles=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Tiles © Esri"});
  routeLayer=L.layerGroup().addTo(map); markerLayer=L.layerGroup().addTo(map);
  incidentLayer=L.layerGroup().addTo(map); hazardLayer=L.layerGroup().addTo(map); serviceLayer=L.layerGroup().addTo(map);
  // Phase 5: separate layer for live-pushed incidents (pulsing), distinct
  // from the static incidentLayer built from the last route-analysis snapshot.
  liveIncidentLayer=L.layerGroup().addTo(map);
  // Phase 6: field reports get their own persistent layer — unlike
  // incidentLayer/hazardLayer, it is NOT cleared on every route redraw,
  // since reports aren't tied to a specific route analysis.
  reportLayer=L.layerGroup().addTo(map);
  trackLayer=L.layerGroup().addTo(map);
  userLocationLayer=L.layerGroup().addTo(map);
  bind();
  map.on("mousemove",showCoordinates);
  renderStops();
  showInitialMap();
  connectTrackingSocket();
  loadReports();
  registerServiceWorker();
  updateNetStatus();
  syncPendingReports();
  window.addEventListener("online",()=>{updateNetStatus();syncPendingReports();});
  window.addEventListener("offline",updateNetStatus);
  document.addEventListener("nerai-lang-changed",refreshDynamicText);
}

/* ---------------------------------------------------------------------
   PHASE 3 — live GPS tracking (dashboard side)
   Connects as a "dashboard" client on the same /ws/track relay tracker.html
   uses. Each incoming position creates/updates a marker + extends a trail
   polyline, keyed by deviceId. History is backfilled once via
   /api/positions/:deviceId so a dashboard opened mid-trip isn't blank.
   --------------------------------------------------------------------- */
function connectTrackingSocket(){
  const proto = location.protocol==="https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/track`);
  TRACK.ws = ws;
  ws.addEventListener("open",()=>ws.send(JSON.stringify({type:"join",role:"dashboard"})));
  ws.addEventListener("message",(ev)=>{
    let msg; try{ msg=JSON.parse(ev.data); }catch{ return; }
    if(msg.type==="devices"){
      msg.devices.forEach(d=>upsertTrackedDevice(d.deviceId,d.lat,d.lon,d.ts,true));
    } else if(msg.type==="position"){
      upsertTrackedDevice(msg.deviceId,msg.lat,msg.lon,msg.ts,false);
    } else if(msg.type==="incident"){
      handleIncident(msg.lat,msg.lon,msg.message);
    }
  });
  ws.addEventListener("close",()=>setTimeout(connectTrackingSocket,3000));
  ws.addEventListener("error",()=>{});
}

// Phase 5, item 2+4: a NEW Overpass hazard/construction tag (or a Phase 6
// field report) arrives as a live push. Distinct from the static
// incidentLayer (built once per route analysis) — this is "just happened",
// so it gets its own pulsing marker + a toast, and lives in liveIncidentLayer.
const INCIDENT_MARKER_TTL_MS = 10*60*1000;
function handleIncident(lat,lon,message){
  toast(`⚠ ${message}`);
  const icon=L.divIcon({className:"",html:'<div class="incident-pulse-icon"></div>',iconSize:[16,16]});
  const marker=L.marker([lat,lon],{icon}).addTo(liveIncidentLayer).bindPopup(`<div class="popup-title popup-risk">Live incident</div>${esc(message)}`);
  setTimeout(()=>{ if(liveIncidentLayer.hasLayer(marker)) liveIncidentLayer.removeLayer(marker); }, INCIDENT_MARKER_TTL_MS);
}

// Phase 5, item 2: tell the backend which route path(s) are currently on
// screen, downsampled, so incident broadcasts can be scoped to "near an
// active route" (see incidents.js) instead of fanned out to every dashboard.
function sendWatchPaths(){
  if(!TRACK.ws || TRACK.ws.readyState!==WebSocket.OPEN) return;
  const paths=(S.routes||[]).map(r=>r.path.filter((_,i)=>i%6===0));
  TRACK.ws.send(JSON.stringify({type:"watch",paths}));
}

async function upsertTrackedDevice(deviceId, lat, lon, ts, isInitialSnapshot){
  let dev = TRACK.devices.get(deviceId);
  if(!dev){
    dev = {
      deviceId,
      marker: L.marker([lat,lon],{icon:L.divIcon({className:"vehicle-marker-wrap",html:'<div class="vehicle-marker" aria-label="Tracked vehicle">🚚</div>',iconSize:[30,30],iconAnchor:[15,15]})}).addTo(trackLayer),
      trail: L.polyline([],{color:"#9334e6",weight:3,opacity:.65}).addTo(trackLayer),
      times: [], // Phase 5: parallel to trail's latlngs, needed to compute live pace
      lastSeen: ts
    };
    dev.marker.bindTooltip(deviceId,{direction:"top",offset:[0,-8]});
    TRACK.devices.set(deviceId,dev);
    // backfill trail history for a device we're seeing for the first time
    try{
      const hist = await fetch(`/api/positions/${encodeURIComponent(deviceId)}`).then(r=>r.json());
      hist.forEach(p=>{dev.trail.addLatLng([p.lat,p.lon]); dev.times.push(p.ts);});
    }catch{ /* backfill is best-effort — live points still work without it */ }
  }
  dev.marker.setLatLng([lat,lon]);
  dev.marker.getElement()?.classList.add("vehicle-marker-moving");
  clearTimeout(dev.moveTimer);
  dev.moveTimer=setTimeout(()=>dev.marker.getElement()?.classList.remove("vehicle-marker-moving"),900);
  dev.trail.addLatLng([lat,lon]);
  dev.times.push(ts);
  if(dev.times.length>500) dev.times.shift();
  dev.lastSeen = ts;
  if(S.nav && !S.demo && (!navDeviceId || navDeviceId===deviceId)){
    navDeviceId=deviceId;
    if(navMarker) navMarker.setLatLng([lat,lon]);
    if(traveledLine) traveledLine.addLatLng([lat,lon]);
    if(followNav) map.panTo([lat,lon],{animate:false});
    $("navSpeed").textContent=realDeviceSpeedKmh(dev) ?? "--";
    $("navRem").textContent="Live GPS position";
  }
  if(!isInitialSnapshot) { renderTrackedDevicesPanel(); if(S.layers.pace) renderDetail(); }
}

// Phase 5, item 3: real crowd-sourced pace instead of the old fabricated
// traffic-proxy overlay. Looks at each tracked device's last TWO points; if
// they're recent (<10 min old) and near the given route, their speed
// (distance/time between those points) counts toward the average.
const PACE_STALE_MS = 10*60*1000, PACE_NEAR_M = 5000, PACE_MAX_KMH = 200;
function computeLivePace(route){
  if(!route) return null;
  const now=Date.now(); const speeds=[];
  for(const dev of TRACK.devices.values()){
    if(now-dev.lastSeen>PACE_STALE_MS) continue;
    const latlngs=dev.trail.getLatLngs(), times=dev.times;
    if(latlngs.length<2 || times.length<2) continue;
    const b=latlngs[latlngs.length-1], a=latlngs[latlngs.length-2];
    const tb=times[times.length-1], ta=times[times.length-2];
    const nearRoute=route.path.some(([lat,lon])=>L.latLng(lat,lon).distanceTo(b)<PACE_NEAR_M);
    if(!nearRoute) continue;
    const dtHrs=(tb-ta)/3600000; if(dtHrs<=0) continue;
    const kmh=(a.distanceTo(b)/1000)/dtHrs;
    if(kmh>0 && kmh<PACE_MAX_KMH) speeds.push(kmh);
  }
  if(!speeds.length) return null;
  return { kmh: Math.round(speeds.reduce((s,v)=>s+v,0)/speeds.length), count: speeds.length };
}


function renderTrackedDevicesPanel(){
  const el = $("trackedDevices");
  if(!el) return;
  const rows = [...TRACK.devices.entries()].sort((a,b)=>b[1].lastSeen-a[1].lastSeen);
  if(!rows.length){ el.innerHTML = `<div class="empty">${T("tracked_empty")}</div>`; return; }
  el.innerHTML = rows.map(([id,dev])=>{
    const ago = Math.max(0,Math.round((Date.now()-dev.lastSeen)/1000));
    const agoText = ago<60?`${ago}s ago`:`${Math.round(ago/60)}m ago`;
    return `<div class="tracked-row"><span class="dot mid" style="width:10px;height:10px"></span><span class="td-id">${esc(id)}</span><span class="td-ago">${agoText}</span></div>`;
  }).join("");
}
setInterval(renderTrackedDevicesPanel, 15000); // keep "Xs ago" fresh without new data
setInterval(updateNetStatus, 15000); // Phase 6: keep the pending-report count fresh

function bind(){
  $("addStopBtn").onclick=()=>{S.stops.splice(-1,0,"");renderStops();};
  $("routeBtn").onclick=runAnalysis;
  $("demoBtn").onclick=()=>{S.demo=!S.demo;$("demoBtn").textContent=S.demo?T("btn_live"):T("btn_demo");$("demoBtn").classList.toggle("demo-active",S.demo);toast(S.demo?T("demo_on"):T("demo_off"));};
  $("vehicleSelect").onchange=e=>S.vehicle=e.target.value;
  $("prioritySelect").onchange=e=>S.priority=e.target.value;
  bindThemes();
  bindLanguage();
  $("zoomIn").onclick=()=>map.zoomIn(); $("zoomOut").onclick=()=>map.zoomOut();
  $("locateBtn").onclick=locateMe;
  $("mtMap").onclick=()=>setMapType("map"); $("mtSat").onclick=()=>setMapType("sat");
  $("chipIncidents").onclick=()=>toggleLayer("incidents"); $("chipLandslide").onclick=()=>toggleLayer("hazards");
  $("chipTraffic").onclick=()=>toggleLayer("pace"); $("chipServices").onclick=()=>toggleLayer("services");
  $("chipReports").onclick=()=>toggleLayer("reports");
  $("exitNav").onclick=endNav; $("endNav").onclick=endNav; $("recenterBtn").onclick=recenterNav;
  bindLogisticsUI();
  map.on("dragstart",()=>{if(S.nav){followNav=false;$("recenterBtn").hidden=false;}});
  bindReportUI();
}

function bindLogisticsUI(){
  const toggle=$("logisticsToggle"), panel=$("logisticsPanel");
  if(!toggle||!panel)return;
  toggle.onclick=()=>{panel.hidden=!panel.hidden;if(!panel.hidden)loadMissions();};
  $("missionRefresh").onclick=loadMissions;
  $("missionCreate").onclick=createMission;
}
async function loadMissions(){
  const list=$("missionList"), status=$("missionStatus"); if(!list||!status)return;
  status.textContent="Loading missions…";
  try{
    const response=await fetch(`${API.missions}?limit=20`); const data=await response.json();
    if(!response.ok)throw new Error(data.error||"Mission storage unavailable.");
    list.innerHTML=(Array.isArray(data)&&data.length)?data.map(({mission,stops})=>`<div class="mission-card"><div><b>${esc(mission.cargo_type)}</b><span>${esc(mission.status.replaceAll("_"," "))}</span></div><small>${esc(mission.origin)} → ${esc(mission.destination)}${mission.cargo_quantity?` · ${esc(mission.cargo_quantity)}`:""}</small>${stops?.length?`<small>${stops.length} delivery stop${stops.length===1?"":"s"}</small>`:""}</div>`).join(""):"<div class=\"mission-empty\">No missions yet.</div>";
    status.textContent=Array.isArray(data)&&data.some(item=>item.mission?.storage==="local-fallback")?"Showing local missions — run the Supabase schema to sync cloud storage.":"";
  }catch(e){status.textContent=e.message||"Could not load missions.";}
}
async function createMission(){
  const status=$("missionStatus");
  const cargo=$("missionCargo").value.trim(), quantity=$("missionQuantity").value.trim(), vehicleId=$("missionVehicle").value.trim();
  const origin=S.stops[0]?.trim(), destination=S.stops.at(-1)?.trim();
  if(!cargo||!origin||!destination){status.textContent="Enter a cargo type and route origin/destination first.";return;}
  status.textContent="Creating mission…";
  try{
    const response=await fetch(API.missions,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cargoType:cargo,cargoQuantity:quantity,vehicleId,origin,destination,priority:S.priority==="logistics"?"high":S.priority,stops:[]})});
    const data=await response.json(); if(!response.ok)throw new Error(data.error||"Could not create mission.");
    $("missionCargo").value="";$("missionQuantity").value="";$("missionVehicle").value="";status.textContent=data.warning||((data.storage==="local-fallback")?"Mission saved locally. Run the Supabase schema for cloud storage.":"Mission saved to Supabase.");loadMissions();
  }catch(e){status.textContent=e.message||"Could not create mission.";}
}

function bindLanguage(){
  const btn=$("langBtn"), menu=$("langMenu");
  if(!btn || !menu) return;
  btn.onclick=()=>{menu.hidden=!menu.hidden;};
  menu.querySelectorAll("button[data-lang]").forEach(b=>b.onclick=()=>{
    window.I18N.setLang(b.dataset.lang); menu.hidden=true; toast(b.textContent.trim());
  });
  document.addEventListener("click",e=>{if(!menu.contains(e.target)&&e.target!==btn)menu.hidden=true;});
}

// Re-renders every piece of UI whose text is set from JS (not just
// data-i18n markup) after a language switch — see i18n.js's
// "nerai-lang-changed" event.
function refreshDynamicText(){
  updateNetStatus();
  renderWeather();
  renderRoutes();
  renderDetail();
  renderTrackedDevicesPanel();
  updateRouteCount();
}
function updateRouteCount(){
  if(!S.routes.length) return; // the data-i18n default ("No routes yet") already covers this case
  const statusKey = S.demoFallbackActive ? "status_demo_fallback" : S.demo ? "status_demo" : (S.usingCached ? "status_cached" : "status_live");
  $("routeCount").textContent = `${S.routes.length} routes found · ${T(statusKey)}`;
}

function renderStops(){
  const el=$("stops");
  el.innerHTML=S.stops.map((v,i)=>{
    const first=i===0,last=i===S.stops.length-1;
    const marker=first?'<span class="dot origin"></span>':last?'<span class="dot dest"></span>':'<span class="dot mid"></span>';
      const remove=!first&&!last?`<button class="remove-stop" type="button" data-remove-stop="${i}" aria-label="Remove stop">×</button>`:"";
    return `<div class="stop-row"><span class="stop-marker">${marker}</span><div class="search-row"><input value="${esc(v)}" placeholder="${first?"Starting location":last?"Destination":"Add stop"}" data-i="${i}"></div>${remove}</div>`;
  }).join("");
  el.querySelectorAll(".search-row input").forEach(inp=>inp.onchange=e=>S.stops[+e.target.dataset.i]=e.target.value.trim());
  el.querySelectorAll("[data-remove-stop]").forEach(button=>button.onclick=()=>window.removeStop(Number(button.dataset.removeStop)));
}
window.removeStop=i=>{S.stops.splice(i,1);renderStops();};

function formatCoord(v){return Number(v).toFixed(6);}
function showCoordinates(e){
  const el=$("mapCoordinates");
  if(el) el.textContent=`${formatCoord(e.latlng.lat)}°, ${formatCoord(e.latlng.lng)}°`;
}

function showInitialMap(){
  const a=LOC.Guwahati,b=LOC.Ziro;
  L.marker([a.lat,a.lon]).addTo(markerLayer).bindPopup("<b>Guwahati</b><br>Origin");
  L.marker([b.lat,b.lon]).addTo(markerLayer).bindPopup("<b>Ziro</b><br>Destination");
  map.fitBounds([[a.lat,a.lon],[b.lat,b.lon]],{padding:[80,80]});
}

// Phase 6: the service worker tags a cache-fallback GET /api/... response
// with X-Raasta-Cache so the UI can label it clearly instead of pretending
// it's live (see service-worker.js header comment + brief requirement).
async function fetchJSON(url, opts={}, timeout=15000){
  const c=new AbortController(), t=setTimeout(()=>c.abort(),timeout);
  try{
    const r=await fetch(url,{...opts,signal:c.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const text=await r.text();
    let data;
    try{ data=JSON.parse(text); }
    catch{ throw new Error(`Expected JSON from ${url}, received ${text.slice(0,80)}`); }
    if(r.headers.get("X-Raasta-Cache")==="hit" && data && typeof data==="object" && !Array.isArray(data)){
      data.__cached=true;
    }
    return data;
  }
  finally{clearTimeout(t);}
}
async function geocode(q){
  const raw=String(q||"").trim();
  if(!raw) throw new Error("Enter a location.");
  const normalized=raw.toLowerCase().replace(/\s+/g," ");
  const alias=ALIASES[normalized] || STATE_ALIASES[normalized] || raw;
  const key=Object.keys(LOC).find(k=>k.toLowerCase()===alias.toLowerCase());
  if(key) return {...LOC[key],name:raw,matchedName:key,queryName:raw}; // known city: zero network calls

  // Anything else goes to the backend, which handles Nominatim + fallback,
  // rate-limiting, and permanent caching.
  const d=await fetchJSON(`${API.geocode}?q=${encodeURIComponent(raw)}`);
  if(d.error) throw new Error(d.error);
  return d;
}

async function getRoutes(points){
  if(!Array.isArray(points) || points.length<2) throw new Error("At least an origin and destination are required.");
  const q=points.map(p=>`${p.lat},${p.lon}`).join(";");
  const d=await fetchJSON(`${API.route}?points=${encodeURIComponent(q)}`,{},30000);
  if(d.error) throw new Error(d.error);
  return d;
}

function weatherCode(c){
  if(c===0)return["☀","Clear"]; if([1,2,3].includes(c))return["☁","Cloudy"]; if([45,48].includes(c))return["🌫","Fog"];
  if([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(c))return["🌧","Rain"]; if([95,96,99].includes(c))return["⛈","Storm"]; return["☁","Variable"];
}
// Weather + hazards are now fetched together from ONE backend endpoint,
// which fires them in parallel server-side (was a sequential await chain).
async function getContext(points){
  const q=points.map(p=>`${p.lat},${p.lon}`).join(";");
  const d=await fetchJSON(`${API.context}?points=${encodeURIComponent(q)}`,{},20000);
  if(d.error) throw new Error(d.error);
  if(d.hazards?.degraded) toast("Hazard data is temporarily unavailable — showing route/weather only.");
  return d; // {weather, hazards:{elements,degraded}, __cached?}
}
// Phase 2: risk scoring (weights, factors, tiering, ML blend) now lives
// server-side in server/riskEngine.js. This just posts the raw routes +
// context and gets back each route enriched with riskScore/tier/tags/
// breakdown. See README-phase2.md for why this replaced the old client-side
// riskFor()/tierRoutes()/routeTags().
// Phase 7 (bug #3 fix): `vehicle` is now actually forwarded to the backend,
// which applies it as an accessibility-penalty input to roadAccess scoring
// (see riskEngine.js). Public OSRM only ships driving/walking/cycling
// profiles, so the vehicle selector never changed the physical path — it
// now transparently only affects the safety score, and the UI says so.
async function scoreRoutes(routes, weather, hazards, origin, vehicle, priority){
  const d=await fetchJSON(API.score,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({routes,weather,hazards,origin,vehicle,priority})},20000);
  if(d.error) throw new Error(d.error);
  return d; // {sessionId, routes:[...]} — routes already sorted best→worst, each with riskScore/tier/tags/breakdown
}

// Phase 4: past-30-days rainfall at the corridor midpoint, for the weather
// card's history strip. Best-effort — a failure here shouldn't block the
// rest of the analysis, so callers should swallow errors from this.
async function getRainHistory(lat, lon, days=30){
  const d=await fetchJSON(`${API.history}?lat=${lat}&lon=${lon}&days=${days}`,{},15000);
  if(d.error) throw new Error(d.error);
  return d; // {days:[{date,rainfallMm}...], totalMm}
}

// Phase 4: 48h risk-score trend for one already-scored route. Cached per
// route id for the lifetime of the current session so switching back and
// forth between route cards in the detail sheet doesn't refetch each time.
async function getRouteForecast(routeId){
  if(S.forecastCache[routeId]) return S.forecastCache[routeId];
  if(!S.sessionId) throw new Error("No active scoring session.");
  const d=await fetchJSON(`${API.routeForecast}?sessionId=${encodeURIComponent(S.sessionId)}&routeId=${encodeURIComponent(routeId)}`,{},15000);
  if(d.error) throw new Error(d.error);
  S.forecastCache[routeId]=d;
  return d; // {routeId, trend:[{hoursAhead,score}...], summary}
}

// Phase 7 (bug #2 fix): previously, if OSRM AND the weather/hazards context
// call both failed for the same request, runAnalysis() just threw and the
// user saw a dead-end error toast with nothing on screen. Now: each stage
// is attempted live first; only if BOTH the route call and the context
// (weather+hazards) call fail do we fall back to demo data for THIS run,
// with a clearly-labeled toast — never silently, never mislabeled as live.
async function runAnalysis(){
  const values=[...document.querySelectorAll(".search-row input")].map(x=>x.value.trim());
  S.stops=values; if(S.stops.length<2||!S.stops[0]||!S.stops.at(-1)){toast("Enter both origin and destination.");return;}
  showAnalysis();
  try{
    await analysisStep(0,"Resolving route locations");
    const points=[]; for(const v of S.stops)points.push(await geocode(v));

    await analysisStep(1,"Querying live road network");
    let routes=null, routeError=null;
    if(S.demo){ routes=demoRoutes(points); }
    else{
      try{ routes=await getRoutes(points); }
      catch(e){ routeError=e; }
    }

    await analysisStep(2,"Reading corridor weather");
    let ctx=null, ctxError=null;
    if(S.demo){ /* skip live context entirely in explicit demo mode */ }
    else{
      try{ ctx=await getContext(points); }
      catch(e){ ctxError=e; }
    }

    // Total-failure fallback: only trips when BOTH route AND context calls
    // failed (i.e. /api/route, /api/weather and /api/hazards all failed for
    // this request, since /api/context fans out to weather+hazards).
    let usedFallback=false;
    if(!S.demo && routeError && ctxError){
      usedFallback=true;
      routes=demoRoutes(points);
      toast(T("live_all_down_fallback"));
    }else if(routeError){
      throw routeError; // route failed but context succeeded — a real, specific error is more useful than a silent demo swap
    }else if(ctxError){
      throw ctxError;
    }
    if(!routes || !routes.length) throw new Error("No actual road route was returned for this corridor.");

    const isDemo = S.demo || usedFallback;
    S.usingCached = !isDemo && Boolean(ctx?.__cached); // Phase 6: never label cached data as live
    if(S.usingCached) toast(T("offline_cached_note"));
    const w=isDemo?null:ctx.weather; S.weather=w;

    await analysisStep(3,"Checking mapped road signals");
    const hazardsForScore=isDemo?{elements:[],degraded:false}:ctx.hazards;
    const places=isDemo?[]:ctx.hazards.elements;

    await analysisStep(4,"Scoring safety and accessibility");
    const origin={state:points[0].state,terrain:points[0].terrain};
    const scored=await scoreRoutes(routes,w,hazardsForScore,origin,S.vehicle,S.priority);
    S.sessionId=scored.sessionId; S.forecastCache={};
    S.routes=scored.routes.map(r=>({...r,etaText:minsText(r.duration),title:`Route ${r.id}`}));
    S.active=S.routes[0].id; S.places=places;
    S.demoFallbackActive=usedFallback; // drives the route-count status label
    // best route's rainfall factor drives the weather-panel flag text — single
    // source of truth (backend), no separate client-side weather-risk calc.
    S.weatherRiskDisplay=100-(S.routes[0]?.breakdown?.rainfall?.factorScore ?? 50);
    S.hazardsDegraded=Boolean(ctx?.hazards?.degraded);
    const hazardTypes=new Set(["hazard","landslide","flood","construction","bridge","rainfall_warning"]);
    S.incidents=places.filter(p=>hazardTypes.has(p.signalType)||p.tags.hazard||p.tags.highway==="construction");
    S.hazards=places.filter(p=>hazardTypes.has(p.signalType)||p.tags.hazard);
    S.services=places.filter(p=>p.tags.amenity==="hospital"||p.tags.amenity==="fuel");
    // Phase 4: corridor midpoint's past-30-days rainfall, best-effort
    S.rainHistory=null;
    if(!isDemo){
      const midIdx=Math.floor((routes[0].path?.length||1)/2);
      const [midLat,midLon]=routes[0].path?.[midIdx]||[points[0].lat,points[0].lon];
      getRainHistory(midLat,midLon,30).then(h=>{S.rainHistory=h;renderWeather();}).catch(e=>console.warn("Rain history unavailable:",e.message));
    }
    await analysisStep(5,"Building explainable recommendation");
    renderAll(points[0],points.at(-1)); await analysisStep(6,"Ready");
  }catch(e){console.error(e);toast(e.name==="AbortError"?"Request timed out. Try again.":e.message||"Analysis failed.");}
  finally{setTimeout(hideAnalysis,450);}
}
function showAnalysis(){
  $("analysisOverlay").hidden=false;
  $("analysisSteps").innerHTML=["Resolving route locations","Querying live road network","Reading corridor weather","Checking mapped road signals","Scoring safety and accessibility","Building explainable recommendation","Ready"].map(x=>`<li>${x}</li>`).join("");
}
function analysisStep(i,text){
  return new Promise(resolve=>setTimeout(()=>{const lis=[...document.querySelectorAll(".analysis-steps li")];lis.forEach((x,n)=>{x.classList.toggle("done",n<i);x.classList.toggle("active",n===i)});resolve();},280));
}
function hideAnalysis(){$("analysisOverlay").hidden=true}
// Phase 7 (bug #4 fix): the old version only ever interpolated between
// points[0] and points.at(-1), silently dropping any intermediate stops
// in demo mode. This now walks through EVERY provided stop in order and
// stitches a short interpolated segment between each consecutive pair, so
// a 4-stop demo route actually visits all 4 stops instead of drawing a
// straight line that skips the middle ones.
function demoRoutes(points){
  const pts = (points||[]).filter(p=>p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if(pts.length<2) return [];
  // Build one dense path per alternative (0,1,2) that passes through every
  // stop, offsetting the in-between control points slightly so the 3
  // alternatives are visually distinct rather than overlapping lines.
  const SEGMENTS_PER_LEG = 6;
  const totalDistanceKm = pts.reduce((sum,p,i)=>{
    if(i===0) return 0;
    const prev=pts[i-1];
    const dLat=(p.lat-prev.lat)*111, dLon=(p.lon-prev.lon)*111*Math.cos(prev.lat*Math.PI/180);
    return sum+Math.sqrt(dLat*dLat+dLon*dLon);
  },0) || 1;
  return [0,1,2].map(alt=>{
    const offset=(alt-1)*.12; // -0.12 / 0 / +0.12 lateral bow per alternative
    const path=[];
    for(let leg=0; leg<pts.length-1; leg++){
      const a=pts[leg], b=pts[leg+1];
      for(let s=0; s<SEGMENTS_PER_LEG; s++){
        const t=s/SEGMENTS_PER_LEG;
        const bow=Math.sin(t*Math.PI)*offset; // bulge outward mid-leg, back to 0 at each real stop
        path.push([a.lat+(b.lat-a.lat)*t+bow, a.lon+(b.lon-a.lon)*t+bow*0.6]);
      }
    }
    path.push([pts.at(-1).lat,pts.at(-1).lon]);
    const distance=totalDistanceKm*(1+alt*0.09);
    const duration=(distance/38)*3600; // ~38 km/h average incl. hill sections
    const steps=[{text:"Head toward the first stop",distance:0}];
    for(let leg=0; leg<pts.length-1; leg++){
      steps.push({text:`Continue along the mapped highway toward stop ${leg+2}`,distance:Math.round((distance*1000)/(pts.length-1))});
    }
    steps.push({text:"Follow the final approach to the destination",distance:0});
    return {id:String.fromCharCode(65+alt),path,distance,duration,steps};
  });
}

function renderAll(a,b){
  renderWeather(); renderRoutes(); drawMap(a,b); renderDetail();
  sendWatchPaths(); // Phase 5: keep the backend's incident-proximity filter current
  updateRouteCount();
  $("lastUpdated").textContent=new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
}
function renderWeather(){
  const w=S.weather; if(!w){$("wCond").textContent=T("weather_waiting");return}
  const c=w.current||{}, code=c.weather_code, wi=weatherCode(code); $("wIconMain").textContent=wi[0]; $("wTemp").textContent=`${Math.round(c.temperature_2m)}°`; $("wCond").textContent=wi[1];
  $("wWind").textContent=`${Math.round(c.wind_speed_10m||0)} km/h`; $("wHumidity").textContent=`${Math.round(c.relative_humidity_2m||0)}%`; $("wRain").textContent=`${Number(c.precipitation||0).toFixed(1)} mm`;
  $("wLoc").innerHTML=`Route corridor<br>${w.timezone||"local time"}`;
  const d=w.daily||{};$("weatherStrip").innerHTML=(d.time||[]).slice(0,6).map((day,i)=>{const wi2=weatherCode(d.weather_code[i]);return `<div class="wday ${i===0?"today":""}"><div class="lbl">${i===0?"Today":new Date(day).toLocaleDateString([], {weekday:"short"})}</div><div class="ic">${wi2[0]}</div><div class="mm">${Math.round(d.precipitation_sum?.[i]||0)}mm</div></div>`}).join("");
  renderRainHistory();
  const risk=S.weatherRiskDisplay ?? 50; $("weatherFlag").textContent=risk>65?T("weather_flag_high"):T("weather_flag_moderate");
}
// Phase 4: past-30-days rainfall strip, reusing the .weather-strip / .wday
// CSS pattern the 6-day forecast strip already uses rather than inventing
// new styles. Renders a sparse set of days (every ~5th) so 30 entries don't
// overflow the same width the 6-day strip uses.
function renderRainHistory(){
  const el=$("rainHistoryStrip"); if(!el) return;
  const h=S.rainHistory;
  if(!h){ el.innerHTML=`<div class="empty" style="padding:8px 0">${T("rain_history_loading")}</div>`; return; }
  const days=h.days||[];
  const step=Math.max(1,Math.ceil(days.length/6));
  const sampled=days.filter((_,i)=>i%step===0).slice(-6);
  el.innerHTML=sampled.map(d=>{
    const dt=new Date(d.date);
    return `<div class="wday"><div class="lbl">${dt.toLocaleDateString([], {day:"2-digit",month:"short"})}</div><div class="ic">🌧</div><div class="mm">${Math.round(d.rainfallMm)}mm</div></div>`;
  }).join("");
  el.querySelectorAll("[data-remove-stop]").forEach(button=>button.onclick=()=>removeStop(Number(button.dataset.removeStop)));
}
function renderRoutes(){
  $("routeList").innerHTML=S.routes.map(r=>{
    const tm=tierMeta(r.tier);
    const barColor=tm.cls==="best"?"#1e8e3e":tm.cls==="average"?"#b06000":"#c5221f";
    return `<div class="route-card ${r.id===S.active?"active":""}" onclick="selectRoute('${r.id}')">
    <div class="route-card-main"><div class="route-bar" style="background:${barColor}"></div><div class="route-body">
      <div class="route-top"><span class="route-time">${r.etaText}</span><span class="badge ${tm.badge}"><span class="badge-icon" aria-hidden="true">${tm.icon}</span> ${esc(r.tier)}</span></div>
      <div class="route-sub">${r.title} · ${r.distance.toFixed(1)} km · safety ${Math.round(r.riskScore)}/100</div>
      <div class="route-tags">${r.tags.map(t=>`<span class="tag ${tagClass(t)}">● ${esc(t)}</span>`).join("")}</div>
    </div></div>
    <div class="steps-toggle" onclick="event.stopPropagation();toggleSteps('${r.id}')">${r.open?"Hide directions":"Show directions"}⌄</div>
    <div class="steps-list ${r.open?"open":""}">${r.steps.map(s=>`<div class="step"><span>↗</span><span class="txt">${esc(s.text)}</span><span class="dist">${km(s.distance)} km</span></div>`).join("")}</div>
  </div>`;
  }).join("");
}
// riskEngine.js tags are plain strings ("Elevated landslide risk", "2 active
// blockage(s)", "Mostly NH"...) — classify by content for the tag pill color.
function tagClass(t){
  if(/risk|blockage/i.test(t))return"warn";
  if(/NH/.test(t))return"ok";
  return"mid";
}
window.toggleSteps=id=>{const r=S.routes.find(x=>x.id===id);r.open=!r.open;renderRoutes()};
window.selectRoute=id=>{S.active=id;renderRoutes();drawMap();renderDetail()};
window.closeDetail=()=>{const detail=$("detail");if(detail)detail.hidden=true;};
function drawMap(a,b){
  routeLayer.clearLayers();markerLayer.clearLayers();
  incidentLayer.clearLayers();hazardLayer.clearLayers();serviceLayer.clearLayers();
  const bounds=[];
  S.routes.forEach(r=>{
    const active=r.id===S.active;
    const cls=tierMeta(r.tier).cls;
    const c=cls==="best"?"#1e8e3e":cls==="average"?"#b06000":"#c5221f";
    const line=L.polyline(r.path,{color:c,weight:active?7:4,opacity:active?1:.5,dashArray:cls==="worst"?"7 7":null}).addTo(routeLayer);
    line.on("click",()=>window.selectRoute(r.id)); bounds.push(...r.path);
  });
  const src=a||{lat:S.routes[0]?.path[0]?.[0],lon:S.routes[0]?.path[0]?.[1]},dst=b||{lat:S.routes[0]?.path.at(-1)?.[0],lon:S.routes[0]?.path.at(-1)?.[1]};
  if(src.lat) L.marker([src.lat,src.lon]).addTo(markerLayer).bindPopup(`<b>Origin</b><br>${esc(S.stops[0])}<br><small>${formatCoord(src.lat)}°, ${formatCoord(src.lon)}°</small>`);
  if(dst.lat) L.marker([dst.lat,dst.lon]).addTo(markerLayer).bindPopup(`<b>Destination</b><br>${esc(S.stops.at(-1))}<br><small>${formatCoord(dst.lat)}°, ${formatCoord(dst.lon)}°</small>`);
  S.incidents.forEach(p=>{
    const signal=p.signalType||"hazard";
    const colors={landslide:["#8e24aa","#ce93d8"],flood:["#1565c0","#64b5f6"],construction:["#c5221f","#f28b82"],bridge:["#6d4c41","#bcaaa4"],hazard:["#b06000","#f9ab00"]};
    const [color,fillColor]=colors[signal]||colors.hazard;
    L.circleMarker([p.lat,p.lon],{radius:8,color,fillColor,fillOpacity:.9,weight:2}).addTo(incidentLayer).bindPopup(`<div class="popup-title popup-risk">${esc(signal.toUpperCase())} signal · severity ${p.severity||"?"}/5</div>${esc(p.tags.name||p.tags.description||p.tags.highway||p.tags.hazard||"Mapped feature")}<br><small>Source: ${esc(p.source||"mapped data")}</small>`);
  });
  S.hazards.forEach(p=>{
    if(S.incidents.includes(p)) return;
    const signal=p.signalType||"hazard";
    const color=signal==="flood"?"#1565c0":signal==="landslide"?"#8e24aa":"#b06000";
    L.circleMarker([p.lat,p.lon],{radius:7,color,fillColor:color,fillOpacity:.75}).addTo(hazardLayer).bindPopup(`<div class="popup-title">${esc(signal.toUpperCase())} signal</div>${esc(p.tags.name||p.tags.description||"Mapped hazard")}<br><small>Confidence ${Math.round((p.confidence||0)*100)}%</small>`);
  });
  S.services.forEach(p=>L.circleMarker([p.lat,p.lon],{radius:6,color:"#1a73e8",fillColor:"#1a73e8",fillOpacity:.85}).addTo(serviceLayer).bindPopup(`<b>${esc(p.tags.name||p.tags.amenity)}</b><br>${esc(p.tags.amenity)}`));
  if(bounds.length)map.fitBounds(bounds,{padding:[70,70]});
  if(S.layers.incidents)incidentLayer.addTo(map); if(S.layers.hazards)hazardLayer.addTo(map); if(S.layers.services)serviceLayer.addTo(map);
}
function renderDetail(){
  const r=S.routes.find(x=>x.id===S.active); if(!r){$("detail").hidden=true;return}
  $("detail").hidden=false;
  // breakdown[k].factorScore is 0-100, higher = safer, and the contributions
  // literally sum to riskScore (riskEngine.js bug #5 fix) — same bar look
  // as before, just fed from the server-computed breakdown now.
  const rows=Object.entries(r.breakdown).map(([k,v])=>{const fs=v.factorScore;return `<div class="factor-row"><span class="fname">${FACTOR_LABELS[k]||k}</span><div class="factor-bar"><div class="factor-fill" style="width:${fs}%;background:${fs>65?"#1e8e3e":fs>35?"#b06000":"#c5221f"}"></div></div></div>`;}).join("");
  const gaugeColor=tierMeta(r.tier).cls==="best"?"#188038":tierMeta(r.tier).cls==="average"?"#b06000":"#c5221f";
  $("detail").innerHTML=`<button class="close-sheet" type="button" onclick="closeDetail()" aria-label="Close route details">×</button><div><h2>${r.title} · ${r.etaText}</h2><div class="sub">${r.distance.toFixed(1)} km · vehicle ${esc(S.vehicle)} · priority ${esc(S.priority)}</div><div class="forecast-block" id="forecastBlock"><div class="empty" style="padding:4px 0;text-align:left">Loading 48h trend…</div></div>${paceLine(r)}</div><div><div class="gauge" style="color:${gaugeColor}">${Math.round(r.riskScore)}</div><div class="sub">Safety score</div></div><div class="factors"><div class="factor-label">What's driving this score</div>${rows}</div><div class="detail-actions"><button class="ai-brief-btn" type="button" onclick="requestAiBrief('${esc(r.id)}')">AI logistics brief</button><button class="start-btn" type="button" onclick="startNav()">${T("start_btn")}</button></div><div class="ai-brief" id="aiBrief" hidden></div>`;
  renderRouteForecast(r.id);
}
window.requestAiBrief=async routeId=>{
  const block=$("aiBrief"); const route=S.routes.find(x=>x.id===routeId); if(!block||!route)return;
  block.hidden=false; block.innerHTML=`<div class="ai-brief-loading">Preparing operational guidance…</div>`;
  try{
    const response=await fetch(API.aiBrief,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      origin:S.stops[0],destination:S.stops.at(-1),vehicle:S.vehicle,priority:S.priority,
      route,alternatives:S.routes,weather:S.weather,hazards:S.hazards,hazardsDegraded:Boolean(S.hazardsDegraded),demoData:Boolean(S.demo||S.demoFallbackActive)
    })});
    const brief=await response.json(); if(!response.ok||brief.error)throw new Error(brief.error||"AI brief unavailable");
    block.innerHTML=`<div class="ai-brief-head"><span>AI logistics brief</span><b>${esc(brief.decision.replaceAll("_"," "))}</b></div><div class="ai-brief-source">${brief.source==="openai"?"OpenAI advisory · evidence from route engine":"Rule-based fallback · AI unavailable"}</div><div class="ai-brief-columns"><div><strong>Why</strong>${(brief.reasons||[]).map(x=>`<div>• ${esc(x)}</div>`).join("")}</div><div><strong>Next actions</strong>${(brief.actions||[]).map(x=>`<div>• ${esc(x)}</div>`).join("")}</div></div>${brief.alert?`<div class="ai-brief-alert">${esc(brief.alert)}</div>`:""}`;
  }catch(e){ block.innerHTML=`<div class="ai-brief-alert">${esc(e.message||"AI brief unavailable")}</div>`; }
};
// Phase 5, item 3: shown only when the "Live pace" chip is on. Real
// crowd-sourced signal from tracked vehicles — never fabricated when there
// isn't any (see computeLivePace()).
function paceLine(r){
  if(!S.layers.pace) return "";
  const pace=computeLivePace(r);
  return pace
    ? `<div class="live-pace">${T("live_pace_label")} <b>${pace.kmh} km/h</b> (from ${pace.count} tracked vehicle${pace.count===1?"":"s"})</div>`
    : `<div class="live-pace">${T("live_pace_none")}</div>`;
}
// Phase 4: 48h risk-score trend sparkline for the currently-open route.
// Plain inline SVG — 5 points, no charting library needed for this.
async function renderRouteForecast(routeId){
  const block=$("forecastBlock"); if(!block) return;
  let fc;
  try{ fc=await getRouteForecast(routeId); }
  catch(e){ if($("forecastBlock")) block.innerHTML=`<div class="empty" style="padding:4px 0;text-align:left">48h trend unavailable.</div>`; return; }
  if(S.active!==routeId || !$("forecastBlock")) return; // user switched routes while this was in flight
  const trend=fc.trend||[]; if(!trend.length) return;
  const scores=trend.map(t=>t.score);
  const min=Math.min(...scores), max=Math.max(...scores);
  const range=Math.max(1,max-min);
  const W=180,H=34,PAD=3;
  const pts=trend.map((t,i)=>{
    const x=PAD+(i/(trend.length-1))*(W-PAD*2);
    const y=PAD+(1-(t.score-min)/range)*(H-PAD*2);
    return [x,y];
  });
  const lineColor=trend[trend.length-1].score>=trend[0].score?"#188038":"#c5221f";
  const path=pts.map((p,i)=>`${i===0?"M":"L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const dots=pts.map(p=>`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.2" fill="${lineColor}"/>`).join("");
  block.innerHTML=`<div class="forecast-sub">48h risk trend</div>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="sparkline"><path d="${path}" fill="none" stroke="${lineColor}" stroke-width="2"/>${dots}</svg>
    <div class="forecast-summary">${esc(fc.summary)}</div>`;
}
// Phase 7 (nav-speed fix): the old fake sine-wave speed presented itself as
// live telemetry during a simulated preview. Now: if a real device from
// tracker.html is currently tracked NEAR this route, its actual speed
// (computed from real position deltas, same logic as computeLivePace()) is
// shown and the header is not shown as "Preview" — this is real GPS data.
// Otherwise the nav clearly labels itself "Preview simulation" rather than
// implying it's live.
function findRealDeviceNearRoute(route){
  const now=Date.now();
  for(const dev of TRACK.devices.values()){
    if(now-dev.lastSeen>PACE_STALE_MS) continue;
    const latlngs=dev.trail.getLatLngs();
    if(!latlngs.length) continue;
    const last=latlngs[latlngs.length-1];
    const near=route.path.some(([lat,lon])=>L.latLng(lat,lon).distanceTo(last)<PACE_NEAR_M);
    if(near) return dev;
  }
  return null;
}
function realDeviceSpeedKmh(dev){
  const latlngs=dev.trail.getLatLngs(), times=dev.times;
  if(latlngs.length<2||times.length<2) return null;
  const b=latlngs[latlngs.length-1], a=latlngs[latlngs.length-2];
  const tb=times[times.length-1], ta=times[times.length-2];
  const dtHrs=(tb-ta)/3600000; if(dtHrs<=0) return null;
  const kmh=(a.distanceTo(b)/1000)/dtHrs;
  return (kmh>0&&kmh<PACE_MAX_KMH) ? Math.round(kmh) : null;
}
window.startNav=()=>{
  const r=S.routes.find(x=>x.id===S.active); if(!r)return;
  S.nav=r; navPath=densify(r.path,4);navIndex=0;followNav=true;
  $("panel").classList.add("hidden");document.querySelector(".map-toolbar").style.display="none";document.querySelector(".map-controls").style.display="none";document.querySelector(".maptype-toggle").style.display="none";$("detail").hidden=true;$("navTop").hidden=false;$("navBottom").hidden=false;
  $("navEta").textContent=r.etaText;$("navRem").textContent=`${r.distance.toFixed(0)} km remaining`;$("navAlert").hidden=r.riskScore>=70;
  const realDev=S.demo?null:findRealDeviceNearRoute(r);
  navDeviceId=realDev?.deviceId || null;
  $("navInstr").classList.toggle("preview-sim",!realDev);
  if(S.demo){
    let badge=$("navPreviewBadge");
    if(!badge){ badge=document.createElement("div"); badge.id="navPreviewBadge"; badge.className="nav-preview-badge"; $("navTop").appendChild(badge); }
    badge.textContent=T("nav_preview_label"); badge.hidden=false;
  }else if($("navPreviewBadge")){ $("navPreviewBadge").hidden=true; }
  if(navMarker)map.removeLayer(navMarker);if(traveledLine)map.removeLayer(traveledLine);
  const startPoint=realDev?realDev.marker.getLatLng():navPath[0];
  navMarker=L.marker(startPoint,{icon:L.divIcon({className:"nav-vehicle-wrap",html:'<div class="nav-vehicle">🚚</div>',iconSize:[34,34],iconAnchor:[17,17]})}).addTo(map);
  traveledLine=L.polyline([startPoint],{color:"#5f6368",weight:6,opacity:.55}).addTo(map);map.setView(startPoint,15);updateNavInstruction();
  if(S.demo) navTimer=setInterval(advanceNav,350);
  else if(!realDev) toast("Waiting for a live tracker near this route.");
};
function densify(path,n){const out=[];for(let i=0;i<path.length-1;i++)for(let j=0;j<n;j++){const t=j/n;out.push([path[i][0]+(path[i+1][0]-path[i][0])*t,path[i][1]+(path[i+1][1]-path[i][1])*t])}out.push(path.at(-1));return out}
function advanceNav(){
  if(navIndex>=navPath.length-1){endNav();toast("Navigation reached the destination.");return}
  const p=navPath[navIndex++];navMarker.setLatLng(p);traveledLine.addLatLng(p);if(followNav)map.panTo(p,{animate:false});
  const realDev=findRealDeviceNearRoute(S.nav);
  const realSpeed=realDev?realDeviceSpeedKmh(realDev):null;
  $("navSpeed").textContent = realSpeed!=null ? realSpeed : "--";
  const badge=$("navPreviewBadge");
  if(badge) badge.hidden = realSpeed!=null;
  $("navRem").textContent=`${Math.max(0,Math.round(S.nav.distance*(1-navIndex/navPath.length)))} km remaining`;
  if(navIndex%Math.max(1,Math.floor(navPath.length/8))===0)updateNavInstruction();
}
function updateNavInstruction(){const r=S.nav;const i=Math.min(r.steps.length-1,Math.floor(navIndex/Math.max(1,navPath.length/r.steps.length)));const st=r.steps[i]||{};$("navDist").textContent=st.distance?`${km(st.distance)} km`:"Continue";$("navInstr").innerHTML=`${esc(st.text||"Continue")}${r.steps[i+1]?`<small>Then, ${esc(r.steps[i+1].text||"continue").toLowerCase()}</small>`:""}`;}
window.endNav=()=>{clearInterval(navTimer);navTimer=null;navDeviceId=null;S.nav=null;$("panel").classList.remove("hidden");document.querySelector(".map-toolbar").style.display="flex";document.querySelector(".map-controls").style.display="flex";document.querySelector(".maptype-toggle").style.display="flex";$("navTop").hidden=true;$("navBottom").hidden=true;$("recenterBtn").hidden=true;if($("navPreviewBadge"))$("navPreviewBadge").hidden=true;if(navMarker){map.removeLayer(navMarker);navMarker=null}if(traveledLine){map.removeLayer(traveledLine);traveledLine=null}renderDetail()};
function recenterNav(){followNav=true;$("recenterBtn").hidden=true;if(navMarker)map.setView(navMarker.getLatLng(),15)}
function updateUserLocation(pos){
  const lat=pos.coords.latitude, lon=pos.coords.longitude, accuracy=Number(pos.coords.accuracy)||0;
  if(!userLocationMarker){
    userLocationMarker=L.marker([lat,lon],{icon:L.divIcon({className:"user-location-wrap",html:'<div class="user-location-dot" aria-label="Your live location"></div>',iconSize:[22,22],iconAnchor:[11,11]})}).addTo(userLocationLayer).bindTooltip("Your live location",{direction:"top"});
    userLocationAccuracy=L.circle([lat,lon],{radius:accuracy,color:"#1a73e8",fillColor:"#1a73e8",fillOpacity:.1,weight:1}).addTo(userLocationLayer);
  }else{
    userLocationMarker.setLatLng([lat,lon]);
    userLocationAccuracy.setLatLng([lat,lon]).setRadius(accuracy);
  }
  map.setView([lat,lon],Math.max(map.getZoom(),14),{animate:true});
}
function stopLiveLocation(){
  if(userLocationWatchId!==null) navigator.geolocation.clearWatch(userLocationWatchId);
  userLocationWatchId=null;
  $("locateBtn").textContent="◎";
  $("locateBtn").setAttribute("aria-label","Start live location");
  toast("Live location stopped.");
}
function locateMe(){
  if(userLocationWatchId!==null){stopLiveLocation();return;}
  if(!navigator.geolocation){toast("Geolocation is not available in this browser.");return;}
  if(!window.isSecureContext){toast("Live location needs HTTPS, or localhost.");return;}
  $("locateBtn").textContent="■";
  $("locateBtn").setAttribute("aria-label","Stop live location");
  userLocationWatchId=navigator.geolocation.watchPosition(updateUserLocation,()=>{stopLiveLocation();toast("Location permission was not granted.");},{enableHighAccuracy:true,maximumAge:5000,timeout:10000});
  toast("Fetching live location…");
}
function toggleLayer(which){
  S.layers[which]=!S.layers[which];const id={incidents:"chipIncidents",hazards:"chipLandslide",pace:"chipTraffic",services:"chipServices",reports:"chipReports"}[which];$(id).classList.toggle("on",S.layers[which]);
  if(which==="pace"){renderDetail();return} // Phase 5: "traffic" chip now toggles the live-pace line in the detail sheet, not a fabricated overlay
  const layer={incidents:incidentLayer,hazards:hazardLayer,services:serviceLayer,reports:reportLayer}[which];if(S.layers[which])layer.addTo(map);else map.removeLayer(layer);
}
function setMapType(type){
  $("mtMap").classList.toggle("active",type==="map");$("mtSat").classList.toggle("active",type==="sat");
  if(type==="sat"){map.removeLayer(mapTiles);satTiles.addTo(map)}else{map.removeLayer(satTiles);mapTiles.addTo(map)}
}
function bindThemes(){
  const btn=$("themeBtn"),menu=$("themeMenu");
  const saved=localStorage.getItem("nerai-theme")||"system";
  applyTheme(saved);
  btn.onclick=()=>{menu.hidden=!menu.hidden;};
  menu.querySelectorAll("button[data-theme]").forEach(b=>b.onclick=()=>{applyTheme(b.dataset.theme);menu.hidden=true;toast(`Theme: ${b.textContent.trim()}`);});
  document.addEventListener("click",e=>{if(!menu.contains(e.target)&&e.target!==btn)menu.hidden=true;});
}
function applyTheme(theme){
  if(theme==="system") document.documentElement.setAttribute("data-theme","system");
  else document.documentElement.setAttribute("data-theme",theme);
  localStorage.setItem("nerai-theme",theme);
  $("themeBtn")?.setAttribute("title",`Theme: ${theme}`);
}

/* =========================================================================
   PHASE 6 — field reports: submit, persist, sync, offline queue, PWA
   ========================================================================= */

// A stable per-browser id, separate from tracker.html's GPS deviceId — this
// one just tags which browser filed a report, for future moderation/edit
// use, not for live location tracking.
function getReportDeviceId(){
  let id = localStorage.getItem("nerai-report-device");
  if(!id){ id = "rep-"+Math.random().toString(36).slice(2,10); localStorage.setItem("nerai-report-device", id); }
  return id;
}
function newClientId(){
  return (crypto.randomUUID ? crypto.randomUUID() : "c-"+Date.now().toString(36)+Math.random().toString(36).slice(2,10));
}

// ---- IndexedDB offline queue -------------------------------------------
const IDB_NAME="raasta-offline", IDB_VERSION=1, IDB_STORE="pendingReports";
function idbOpen(){
  return new Promise((resolve,reject)=>{
    if(!("indexedDB" in window)) return reject(new Error("IndexedDB unavailable"));
    const req=indexedDB.open(IDB_NAME,IDB_VERSION);
    req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE,{keyPath:"clientId"}); };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function idbPut(report){
  const db=await idbOpen();
  return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,"readwrite"); tx.objectStore(IDB_STORE).put(report); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });
}
async function idbDelete(clientId){
  const db=await idbOpen();
  return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,"readwrite"); tx.objectStore(IDB_STORE).delete(clientId); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); });
}
async function idbAll(){
  const db=await idbOpen();
  return new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,"readonly"); const req=tx.objectStore(IDB_STORE).getAll(); req.onsuccess=()=>res(req.result||[]); req.onerror=()=>rej(req.error); });
}

// ---- Online/offline/syncing/pending status pill -------------------------
const NET = { syncing:false };
async function updateNetStatus(){
  const dot=$("netDot"), label=$("netStatus");
  if(!dot||!label) return;
  let pending=[];
  try{ pending=await idbAll(); }catch{ /* IndexedDB unavailable — treat as zero pending */ }
  if(!navigator.onLine){ dot.className="net-dot off"; label.textContent=T("net_offline"); return; }
  if(NET.syncing){ dot.className="net-dot syncing"; label.textContent=T("net_syncing"); return; }
  if(pending.length){
    dot.className="net-dot pending";
    label.textContent = pending.length===1 ? T("net_pending_one") : T("net_pending_many",{n:pending.length});
    return;
  }
  dot.className="net-dot on"; label.textContent=T("net_online");
}

async function syncPendingReports(){
  if(!navigator.onLine) return;
  let pending=[];
  try{ pending=await idbAll(); }catch{ return; }
  if(!pending.length) return;
  NET.syncing=true; updateNetStatus();
  let anyFail=false;
  for(const rep of pending){
    try{
      const r=await fetch(API.reports,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(rep)});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      const d=await r.json();
      await idbDelete(rep.clientId);
      addReportMarker(d.report);
    }catch{ anyFail=true; }
  }
  NET.syncing=false; updateNetStatus();
  if(anyFail) toast(T("report_sync_failed")); else toast(T("report_sync_done"));
}

function reportCategoryLabel(cat){ return T(`cat_${cat}`); }
function addReportMarker(report){
  if(!report || !Number.isFinite(report.lat) || !Number.isFinite(report.lon)) return;
  const icon=L.divIcon({className:"",html:'<div class="report-pin">📍</div>',iconSize:[22,22],iconAnchor:[11,20]});
  const label=reportCategoryLabel(report.category);
  L.marker([report.lat,report.lon],{icon}).addTo(reportLayer)
    .bindPopup(`<div class="popup-title">${esc(label)}</div>${report.note?esc(report.note):""}`);
}
async function loadReports(){
  try{
    const list=await fetchJSON(`${API.reports}?limit=200`);
    (Array.isArray(list)?list:[]).forEach(addReportMarker);
  }catch{ /* best-effort — offline first load just shows nothing until sync */ }
}

// ---- Report composer -----------------------------------------------------
let pendingReportLatLng=null;
function openReportSheet(latlng){
  pendingReportLatLng=latlng;
  $("reportLocText").textContent=`${formatCoord(latlng.lat)}°, ${formatCoord(latlng.lng)}°`;
  $("reportNote").value=""; $("reportPhoto").value=""; $("reportCategory").value="road_damage";
  $("reportSheet").hidden=false;
}
function closeReportSheet(){ $("reportSheet").hidden=true; pendingReportLatLng=null; }
function fileToDataUrl(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(file); });
}
async function submitReport(payload){
  try{
    if(!navigator.onLine) throw new Error("offline");
    const r=await fetch(API.reports,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(!r.ok){ const d=await r.json().catch(()=>({})); throw new Error(d.error||`HTTP ${r.status}`); }
    const d=await r.json();
    addReportMarker(d.report);
    toast(T("report_sent"));
  }catch(e){
    try{ await idbPut(payload); toast(T("report_queued")); }
    catch{ toast(e.message || "Report could not be saved."); }
  }
  updateNetStatus();
}
async function handleReportSubmit(){
  if(!pendingReportLatLng){ toast(T("report_tap_hint")); return; }
  const category=$("reportCategory").value;
  const note=$("reportNote").value.trim();
  const file=$("reportPhoto").files[0];
  let photoBase64=null;
  if(file){ try{ photoBase64=await fileToDataUrl(file); }catch{ /* best-effort — submit without the photo rather than block the report */ } }
  const payload={ clientId:newClientId(), lat:pendingReportLatLng.lat, lon:pendingReportLatLng.lng, category, note, photoBase64, deviceId:getReportDeviceId() };
  closeReportSheet();
  await submitReport(payload);
}
function bindReportUI(){
  $("btnNewReport").onclick=()=>{ toast(T("report_tap_hint")); map.once("click", e=>openReportSheet(e.latlng)); };
  $("reportCancel").onclick=closeReportSheet;
  $("reportClose").onclick=closeReportSheet;
  $("reportSubmit").onclick=handleReportSubmit;
}

// ---- PWA registration ------------------------------------------------------
function registerServiceWorker(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("/service-worker.js").catch(()=>{ /* offline support degrades gracefully without SW */ });
  }
}

window.onload=init;
})();
