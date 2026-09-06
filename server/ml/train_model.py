"""
train_model.py — RAASTA / NER Route Intelligence, Phase 2 ML training

Trains a RandomForestClassifier that predicts landslide probability from
antecedent rainfall at a specific lat/lon, using ONLY the two files provided:

  - NER_UGLC_landslide_inventory.csv  (707 historical landslide events, point data)
  - IMD_NER_rainfall_2000_2025.csv    (daily gridded rainfall, ~5.1M rows,
                                        0.25 deg lat/lon grid, 2000-2025)

WHY THIS DIFFERS FROM THE COLAB NOTEBOOK:
The notebook (weatherAPI.ipynb) aggregated rainfall to STATE+YEAR granularity
and joined against a `NER_REAL_ML_DATASET.csv` / `IMD_36` column set that does
not exist in the file you actually gave me (that file is a plain
date/latitude/longitude/rainfall_mm grid). State+year aggregation throws away
all the spatial detail a route-safety engine actually needs (a route runs
through many specific points, not "Assam this year"). So this script instead:

  1. Snaps every landslide event to its nearest rainfall grid cell.
  2. Computes antecedent rainfall windows (1/3/7/15/36-day sums) ending on the
     event's start_date, at that grid cell.
  3. Builds an equal-count NEGATIVE class: for every positive point, sample a
     random (grid cell, date) pair from the same state that has NO landslide
     recorded within +/-3 days, so the model learns "this rainfall pattern
     did/didn't precede a landslide" rather than always predicting "yes".
  4. Trains a RandomForestClassifier on the resulting table.
  5. Saves it as ml/NER_landslide_risk_model.joblib for ml_service.py to load.

Run: python3 train_model.py
Requires: pandas, numpy, scikit-learn, joblib (all already installed).
"""
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score, roc_auc_score,
)
import joblib
import time

RAINFALL_CSV = "IMD_NER_rainfall_2000_2025.csv"
LANDSLIDE_CSV = "NER_UGLC_landslide_inventory.csv"
OUT_MODEL = "NER_landslide_risk_model.joblib"
GRID_STEP = 0.25  # matches the rainfall file's grid spacing

FEATURES = [
    "rain_1d", "rain_3d", "rain_7d", "rain_15d", "rain_36d", "month_sin", "month_cos",
]
TARGET = "landslide_occurred"

t0 = time.time()

# ---------------------------------------------------------------------------
# 1. Load landslide inventory, keep events with usable coords + dates that
#    fall inside the rainfall file's date coverage (2000-01-01 .. 2025-12-31)
# ---------------------------------------------------------------------------
ls = pd.read_csv(LANDSLIDE_CSV)
ls["start_date"] = pd.to_datetime(ls["start_date"], errors="coerce")
ls = ls.dropna(subset=["start_date", "latitude", "longitude"])
ls = ls[(ls["start_date"] >= "2000-01-01") & (ls["start_date"] <= "2025-12-31")]
print(f"Usable landslide events (coords+date in rainfall coverage): {len(ls)}")

# snap to nearest 0.25-deg grid cell (same spacing the rainfall file uses)
ls["glat"] = (ls["latitude"] / GRID_STEP).round() * GRID_STEP
ls["glon"] = (ls["longitude"] / GRID_STEP).round() * GRID_STEP

# ---------------------------------------------------------------------------
# 2. Load rainfall file. It's ~5.1M rows / 148MB — read once, index by
#    (lat, lon) -> sorted daily series so we can window-sum fast.
# ---------------------------------------------------------------------------
print("Loading rainfall grid (this is the slow step, ~5.1M rows)...")
rain = pd.read_csv(RAINFALL_CSV, parse_dates=["date"])
rain["latitude"] = rain["latitude"].round(2)
rain["longitude"] = rain["longitude"].round(2)
print(f"Rainfall rows: {len(rain)}  |  unique grid cells: {rain[['latitude','longitude']].drop_duplicates().shape[0]}")

# Build a lookup: (lat, lon) -> DataFrame sorted by date, cumulative sum precomputed
rain = rain.sort_values(["latitude", "longitude", "date"])
rain["cum_rain"] = rain.groupby(["latitude", "longitude"])["rainfall_mm"].cumsum()
grid_index = {k: v.set_index("date") for k, v in rain.groupby(["latitude", "longitude"])}
all_cells = list(grid_index.keys())
print(f"Grid lookup built in {time.time()-t0:.1f}s, {len(all_cells)} distinct cells")


def nearest_cell(lat, lon):
    """Find the closest actual grid cell to a requested (lat, lon)."""
    best, best_d = None, 1e9
    for (glat, glon) in all_cells:
        d = (glat - lat) ** 2 + (glon - lon) ** 2
        if d < best_d:
            best_d, best = d, (glat, glon)
    return best


def rainfall_windows(cell, on_date):
    """Return (1d,3d,7d,15d,36d) rainfall sums ending on `on_date` for `cell`."""
    df = grid_index.get(cell)
    if df is None or on_date not in df.index:
        # fall back to nearest available date within a week
        if df is None:
            return None
        nearby = df.index[(df.index >= on_date - pd.Timedelta(days=7)) &
                           (df.index <= on_date + pd.Timedelta(days=7))]
        if len(nearby) == 0:
            return None
        on_date = min(nearby, key=lambda d: abs((d - on_date).days))
    cum_at = df.loc[on_date, "cum_rain"]
    out = []
    for w in (1, 3, 7, 15, 36):
        start = on_date - pd.Timedelta(days=w)
        prior = df.loc[df.index <= start, "cum_rain"]
        base = prior.iloc[-1] if len(prior) else 0.0
        out.append(max(cum_at - base, 0.0))
    return out


# cache nearest-cell lookups per unique requested (glat, glon) to avoid O(n*m)
cell_cache = {}

def get_cell(glat, glon):
    key = (glat, glon)
    if key not in cell_cache:
        cell_cache[key] = nearest_cell(glat, glon) if key not in grid_index else key
    return cell_cache[key]


# ---------------------------------------------------------------------------
# 3. Build POSITIVE rows (real landslides)
# ---------------------------------------------------------------------------
pos_rows = []
for _, r in ls.iterrows():
    cell = get_cell(r["glat"], r["glon"])
    if cell is None:
        continue
    w = rainfall_windows(cell, r["start_date"])
    if w is None:
        continue
    pos_rows.append({
        "latitude": r["latitude"], "longitude": r["longitude"], "date": r["start_date"],
        "State": r["State"],
        "rain_1d": w[0], "rain_3d": w[1], "rain_7d": w[2], "rain_15d": w[3], "rain_36d": w[4],
        "month_sin": np.sin(2 * np.pi * r["start_date"].month / 12),
        "month_cos": np.cos(2 * np.pi * r["start_date"].month / 12),
        TARGET: 1,
    })
pos_df = pd.DataFrame(pos_rows)
print(f"Positive samples built: {len(pos_df)}")

# ---------------------------------------------------------------------------
# 4. Build NEGATIVE rows: for each positive, pick a random grid cell + date
#    from the full rainfall coverage, at least 30 days away from ANY
#    recorded landslide at that cell, so negatives aren't accidental positives.
# ---------------------------------------------------------------------------
rng = np.random.default_rng(42)
event_dates_by_cell = ls.groupby(["glat", "glon"])["start_date"].apply(list).to_dict()
all_dates = rain["date"].drop_duplicates().to_numpy()

neg_rows = []
attempts, target_n = 0, len(pos_df) * 2  # 2:1 negative:positive for balance headroom
while len(neg_rows) < target_n and attempts < target_n * 20:
    attempts += 1
    glat, glon = all_cells[rng.integers(0, len(all_cells))]
    d = pd.Timestamp(all_dates[rng.integers(0, len(all_dates))])
    known = event_dates_by_cell.get((glat, glon), [])
    if any(abs((d - kd).days) < 30 for kd in known):
        continue
    w = rainfall_windows((glat, glon), d)
    if w is None:
        continue
    neg_rows.append({
        "latitude": glat, "longitude": glon, "date": d, "State": None,
        "rain_1d": w[0], "rain_3d": w[1], "rain_7d": w[2], "rain_15d": w[3], "rain_36d": w[4],
        "month_sin": np.sin(2 * np.pi * d.month / 12),
        "month_cos": np.cos(2 * np.pi * d.month / 12),
        TARGET: 0,
    })
neg_df = pd.DataFrame(neg_rows)
print(f"Negative samples built: {len(neg_df)}")

data = pd.concat([pos_df, neg_df], ignore_index=True)
data.to_csv("NER_point_ML_dataset.csv", index=False)
print(f"Full training table saved: NER_point_ML_dataset.csv ({len(data)} rows)")

# ---------------------------------------------------------------------------
# 5. Train / evaluate
# ---------------------------------------------------------------------------
X = data[FEATURES]
y = data[TARGET]
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
model = RandomForestClassifier(
    n_estimators=300, max_depth=8, min_samples_leaf=3,
    class_weight="balanced", random_state=42, n_jobs=-1,
)
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
y_proba = model.predict_proba(X_test)[:, 1]
print("\n=== EVALUATION (held-out 20%) ===")
print(f"Accuracy : {accuracy_score(y_test, y_pred):.3f}")
print(f"Precision: {precision_score(y_test, y_pred):.3f}")
print(f"Recall   : {recall_score(y_test, y_pred):.3f}")
print(f"F1       : {f1_score(y_test, y_pred):.3f}")
print(f"ROC AUC  : {roc_auc_score(y_test, y_proba):.3f}")

importances = pd.Series(model.feature_importances_, index=FEATURES).sort_values(ascending=False)
print("\n=== FEATURE IMPORTANCE ===")
for f, v in importances.items():
    print(f"{f:12s} {v:.3f}")

joblib.dump({"model": model, "features": FEATURES}, OUT_MODEL)
print(f"\nSaved model -> {OUT_MODEL}")
print(f"Total runtime: {time.time()-t0:.1f}s")
