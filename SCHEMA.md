# RAASTA persistence — conceptual schema (Phase 6)

The brief asks for "SQLite/lightweight persistence." Phase 3 already made
and documented this call for `positions`; Phase 6 follows the same
precedent for `reports` rather than introducing a native-build dependency
(`better-sqlite3`) that has previously failed cold installs on free-tier
hosts. Both stores are append-only JSON files on disk
(`server/positions.json`, `server/reports.json`) with a synchronous
in-memory index and the exact same shape these tables would have — so
swapping in real SQLite/Postgres later is a drop-in module replacement,
not a caller-side rewrite.

## `positions` (Phase 3, unchanged)

| column     | type    | notes                                  |
|------------|---------|-----------------------------------------|
| deviceId   | text    | tracker.html-generated id, PK-ish       |
| lat        | real    |                                          |
| lon        | real    |                                          |
| ts         | integer | epoch ms                                |

Capped at 500 rows/device (rolling trail, not a full history).

## `reports` (Phase 6, new)

| column         | type    | notes                                                |
|----------------|---------|-------------------------------------------------------|
| id             | text    | server-generated, PK                                  |
| clientId       | text    | client-generated, nullable, unique when present — used for idempotent offline-queue retries |
| lat            | real    |                                                         |
| lon            | real    |                                                         |
| category       | text    | one of: road_damage, landslide, flood, bridge_damage, blockage, traffic, other |
| note           | text    | free text, capped at 500 chars, HTML-escaped before storage |
| photoBase64    | text    | nullable; a data: URL string (not raw base64 despite the field name — kept as-is to match the brief's payload shape), capped ~1.5MB decoded |
| deviceId       | text    | nullable, client-generated, capped 64 chars            |
| ts             | integer | epoch ms, server-assigned on insert                    |

Capped at 5000 rows total (oldest dropped first).

## `incidents`

There is no separate incidents table. An "incident" is not persisted as its
own record — it is a live pub/sub event (`incidents.broadcastIncident`,
Phase 5) fired at the moment a report or hazard-diff is created. The
`reports` table above is the durable record; incidents are its real-time
notification, not a second copy of the data.

## `missions` and `delivery_stops`

The Supabase schema also supports the logistics workflow from the problem
statement. A `missions` row represents one movement of essential goods, with
cargo, priority, origin, destination, vehicle, ETA, and lifecycle status.
`delivery_stops` stores ordered geotagged stops and their pending, arrived, or
completed status. The API is exposed through `/api/missions` and
`/api/delivery-stops/:id`; route safety and GPS telemetry remain separate
sources that can update mission status.
