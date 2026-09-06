"""
build_roads_grid.py — Phase 2, bug #9 (road class never used in scoring)

Converts NER_roads_compact.csv (303,845 OSM road points) into a compact
grid-indexed JSON that riskEngine.js can load without needing pandas/Node
GIS libraries: ~5.5km (0.05 deg) cells, each holding only the single
highest-priority road class present, plus NH/SH flags.

Run once (or whenever the roads CSV is updated):
    python3 build_roads_grid.py /path/to/NER_roads_compact.csv
Output: roads_grid.json (copy into server/ alongside riskEngine.js)
"""
import sys
import json
import pandas as pd

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "NER_roads_compact.csv"
OUT_PATH = "roads_grid.json"
GRID = 0.05  # degrees, ~5.5km — fine enough to classify a route corridor

# Road-hierarchy priority used for the accessibility factor (0=worst, 6=best)
PRIORITY = {
    "motorway": 6, "motorway_link": 6,
    "trunk": 5, "trunk_link": 5,
    "primary": 4, "primary_link": 4,
    "secondary": 3, "secondary_link": 3,
    "tertiary": 2, "tertiary_link": 2,
    "unclassified": 1, "residential": 1, "living_street": 1,
    "service": 0, "track": 0, "path": 0, "footway": 0,
    "pedestrian": 0, "steps": 0, "cycleway": 0, "bridleway": 0, "unknown": 0,
}
for i in range(1, 6):
    PRIORITY[f"track_grade{i}"] = 0


def main():
    r = pd.read_csv(CSV_PATH)
    r["priority"] = r["fclass"].map(PRIORITY).fillna(0).astype(int)
    r["is_nh"] = r["ref"].astype(str).str.match(r"^NH", na=False)
    r["is_sh"] = r["ref"].astype(str).str.match(r"^SH", na=False)

    r["glat"] = (r["latitude"] / GRID).round().astype(int)
    r["glon"] = (r["longitude"] / GRID).round().astype(int)

    # tie-break: priority first, then prefer NH-tagged, then SH-tagged
    r["tie"] = r["priority"] * 10 + r["is_nh"].astype(int) * 2 + r["is_sh"].astype(int)
    best = r.sort_values("tie", ascending=False).drop_duplicates(["glat", "glon"], keep="first")

    cells = {}
    for _, row in best.iterrows():
        key = f"{row['glat']},{row['glon']}"
        cells[key] = {
            "class": row["fclass"],
            "nh": bool(row["is_nh"]),
            "sh": bool(row["is_sh"]),
            "priority": int(row["priority"]),
        }

    with open(OUT_PATH, "w") as f:
        json.dump({"grid_deg": GRID, "cells": cells}, f)

    print(f"Wrote {OUT_PATH}: {len(cells)} grid cells")


if __name__ == "__main__":
    main()
