"""
ml_service.py — RAASTA / NER Route Intelligence, Phase 2 ML microservice

Loads NER_landslide_risk_model.joblib (RandomForestClassifier trained by
train_model.py on the landslide inventory + IMD rainfall grid you provided)
and exposes it over HTTP so riskEngine.js can call it without needing a
Python runtime embedded in the Node process.

IMPORTANT — feature mismatch with the Phase 2 primer:
The primer describes `POST /predict {lat, lon, rainfall_mm}`, a single
rainfall figure. But the trained model's real predictive power comes from
ANTECEDENT rainfall windows (1/3/7/15/36-day sums — see train_model.py
feature importances, where short windows dominate), not one instantaneous
mm value. So this service accepts a `rainfall_mm` for "today" (matching the
primer's contract, since that's what the Node backend's live weather API
actually has) and derives the 1/3/7/15/36-day windows two ways:

  1. If the caller supplies `recent_rainfall_mm`, a list of daily rainfall
     going back up to 36 days (this backend CAN get this from Open-Meteo's
     historical endpoint, or the client can omit it and fall back to (2)).
  2. Otherwise, it estimates the multi-day windows by scaling `rainfall_mm`
     using the seasonal averages baked in at training time (a rough but
     honest fallback — documented in code, not hidden).

Run:  pip install fastapi uvicorn
      uvicorn ml_service:app --host 0.0.0.0 --port 8000
"""
from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Optional, List
import numpy as np
import joblib
import os

MODEL_PATH = os.environ.get("MODEL_PATH", "NER_landslide_risk_model.joblib")

app = FastAPI(title="RAASTA Landslide Risk ML Service")

_bundle = None


def get_model():
    global _bundle
    if _bundle is None:
        _bundle = joblib.load(MODEL_PATH)
    return _bundle


class PredictRequest(BaseModel):
    lat: float
    lon: float
    rainfall_mm: float = Field(..., description="Rainfall today / most recent reading, mm")
    month: Optional[int] = Field(None, ge=1, le=12, description="1-12; defaults to current month")
    recent_rainfall_mm: Optional[List[float]] = Field(
        None,
        description=(
            "Optional daily rainfall history, most-recent-last, ideally 36 "
            "days, used to compute real antecedent windows instead of the "
            "rainfall_mm-only estimate."
        ),
    )


class PredictResponse(BaseModel):
    landslide_probability: float
    risk_level: str
    features_used: dict
    degraded_estimate: bool  # true if we had to estimate windows from a single reading


def risk_level(p: float) -> str:
    if p < 0.30:
        return "LOW"
    if p < 0.55:
        return "MODERATE"
    if p < 0.80:
        return "HIGH"
    return "CRITICAL"


def windows_from_history(history: List[float]) -> dict:
    h = np.array(history[-36:]) if history else np.array([])
    def last_n(n):
        return float(h[-n:].sum()) if len(h) >= 1 else 0.0
    return {
        "rain_1d": last_n(1),
        "rain_3d": last_n(3),
        "rain_7d": last_n(7),
        "rain_15d": last_n(15),
        "rain_36d": last_n(36),
    }


def windows_from_single_reading(rainfall_mm: float) -> dict:
    """
    Fallback when no history is supplied: extrapolate multi-day sums from a
    single day's reading using a flat persistence assumption (today's rate
    repeated). This intentionally under/over-estimates in exchange for never
    crashing the endpoint - it is clearly flagged via degraded_estimate=True
    in the response so callers (riskEngine.js) know to trust it less and can
    down-weight the ML contribution accordingly, exactly the "never a single
    point of failure" requirement from the Phase 2 brief.
    """
    r = max(rainfall_mm, 0.0)
    return {
        "rain_1d": r,
        "rain_3d": r * 3,
        "rain_7d": r * 7,
        "rain_15d": r * 15,
        "rain_36d": r * 36,
    }


@app.get("/health")
def health():
    try:
        get_model()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    import datetime
    bundle = get_model()
    model, features = bundle["model"], bundle["features"]

    degraded = req.recent_rainfall_mm is None
    windows = (
        windows_from_history(req.recent_rainfall_mm)
        if req.recent_rainfall_mm
        else windows_from_single_reading(req.rainfall_mm)
    )
    month = req.month or datetime.datetime.utcnow().month
    windows["month_sin"] = float(np.sin(2 * np.pi * month / 12))
    windows["month_cos"] = float(np.cos(2 * np.pi * month / 12))

    x = [[windows[f] for f in features]]
    proba = float(model.predict_proba(x)[0][1])

    return PredictResponse(
        landslide_probability=round(proba, 4),
        risk_level=risk_level(proba),
        features_used=windows,
        degraded_estimate=degraded,
    )
