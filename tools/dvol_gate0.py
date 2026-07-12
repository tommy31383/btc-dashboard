#!/usr/bin/env python3
"""Frozen Gate-0 screen for incremental information in Deribit BTC DVOL.

This is a research evaluator, not a trading strategy. It compares a price-only
ATR/HAR-style OLS baseline with the same model plus four preregistered DVOL
features. Models fit once on the purged in-sample period and never refit on OOS.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import ssl
import subprocess
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import numpy as np
import pandas as pd
from scipy.stats import norm


HOUR_MS = 60 * 60 * 1000
FOUR_HOURS_MS = 4 * HOUR_MS
DAY_MS = 24 * HOUR_MS
PERIODS_PER_YEAR_4H = 6 * 365
DVOL_START_MS = int(pd.Timestamp("2021-03-01T00:00:00Z").timestamp() * 1000)
OOS_START_MS = int(pd.Timestamp("2023-07-01T00:00:00Z").timestamp() * 1000)

DERIBIT_ENDPOINT = "https://www.deribit.com/api/v2/public/get_volatility_index_data"
BASE_FEATURES = ["atr_pct14", "rv_1d", "rv_7d", "rv_30d"]
DVOL_FEATURES = ["dvol_level", "dvol_chg_24h", "dvol_vov_5d", "vrp_proxy"]
ALL_FEATURES = BASE_FEATURES + DVOL_FEATURES

TARGETS = {
    "downside_semivol_3d": {"horizon_bars": 18, "primary": True},
    "mae_long_5d_pct": {"horizon_bars": 30, "primary": False},
    "rv_fwd_1d": {"horizon_bars": 6, "primary": False},
    "rv_fwd_3d": {"horizon_bars": 18, "primary": False},
}

INCREMENTAL_R2_MIN = 0.02
SIGNIFICANCE_MAX_P = 0.10
MIN_OOS_UNIQUE_DAYS = 300
MAX_AUGMENTED_CONDITION_NUMBER = 1e8


def build_tls_context() -> ssl.SSLContext:
    """Use Python's packaged CA bundle when the framework CA path is empty."""
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def utc_iso(timestamp_ms: int) -> str:
    return dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_dvol_page(start_ms: int, end_ms: int) -> dict:
    params = urllib.parse.urlencode(
        {
            "currency": "BTC",
            "start_timestamp": int(start_ms),
            "end_timestamp": int(end_ms),
            "resolution": "3600",
        }
    )
    request = urllib.request.Request(
        f"{DERIBIT_ENDPOINT}?{params}",
        headers={"User-Agent": "btc-dashboard-dvol-gate0/1.0"},
    )
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(
                request, timeout=30, context=build_tls_context()
            ) as response:
                payload = json.load(response)
            if payload.get("error"):
                raise RuntimeError(f"Deribit error: {payload['error']}")
            result = payload.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                raise RuntimeError("Deribit returned an invalid volatility-index payload")
            return result
        except Exception as exc:  # network retry is bounded and deterministic
            last_error = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"Deribit DVOL request failed after 3 attempts: {last_error}")


def download_dvol_candles(
    start_ms: int,
    end_ms: int,
    *,
    fetch_page: Callable[[int, int], dict] = fetch_dvol_page,
) -> list[list[float]]:
    """Page backward through Deribit and return sorted, de-duplicated candles."""
    if end_ms <= start_ms:
        raise ValueError("end_ms must be greater than start_ms")

    cursor_end = int(end_ms)
    rows_by_time: dict[int, list[float]] = {}
    while True:
        page = fetch_page(int(start_ms), cursor_end)
        for raw_row in page.get("data", []):
            if not isinstance(raw_row, list) or len(raw_row) != 5:
                raise RuntimeError(f"Invalid Deribit candle: {raw_row!r}")
            timestamp = int(raw_row[0])
            if start_ms <= timestamp <= end_ms:
                # Requests start with the newest page. Keep that copy if a
                # continuation boundary repeats on the older page.
                rows_by_time.setdefault(timestamp, [timestamp, *map(float, raw_row[1:])])

        continuation = page.get("continuation")
        if continuation is None or int(continuation) <= start_ms:
            break
        continuation = int(continuation)
        if continuation >= cursor_end:
            raise RuntimeError(
                f"Non-decreasing Deribit continuation {continuation} >= {cursor_end}"
            )
        cursor_end = continuation

    return [rows_by_time[key] for key in sorted(rows_by_time)]


def load_or_download_dvol(cache_path: Path, start_ms: int, end_ms: int) -> list[list[float]]:
    if cache_path.exists():
        payload = json.loads(cache_path.read_text())
        if (
            payload.get("source") == DERIBIT_ENDPOINT
            and int(payload.get("request_start_ms", end_ms)) <= start_ms
            and int(payload.get("request_end_ms", start_ms)) >= end_ms
            and isinstance(payload.get("data"), list)
        ):
            return payload["data"]

    rows = download_dvol_candles(start_ms, end_ms)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": DERIBIT_ENDPOINT,
        "currency": "BTC",
        "resolution": "3600",
        "request_start_ms": int(start_ms),
        "request_end_ms": int(end_ms),
        "downloaded_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "data": rows,
    }
    cache_path.write_text(json.dumps(payload, separators=(",", ":")))
    return rows


def aggregate_binance_4h(path: Path) -> pd.DataFrame:
    raw = json.loads(path.read_text())
    if not isinstance(raw, list) or not raw:
        raise ValueError("BTC source must be a non-empty JSON array")

    buckets: dict[int, dict[str, float]] = {}
    previous_time = -1
    for row in raw:
        timestamp = int(row["time"])
        if timestamp <= previous_time:
            raise ValueError("BTC source timestamps must be strictly increasing")
        previous_time = timestamp
        bucket_start = timestamp // FOUR_HOURS_MS * FOUR_HOURS_MS
        values = buckets.get(bucket_start)
        if values is None:
            buckets[bucket_start] = {
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row.get("volume", 0)),
            }
        else:
            values["high"] = max(values["high"], float(row["high"]))
            values["low"] = min(values["low"], float(row["low"]))
            values["close"] = float(row["close"])
            values["volume"] += float(row.get("volume", 0))

    # A source timestamp is a 5m candle open. Only retain 4h buckets whose end
    # is known to be present in the source; this excludes the trailing partial.
    source_covered_until = previous_time + 5 * 60 * 1000
    records = []
    for bucket_start in sorted(buckets):
        close_time = bucket_start + FOUR_HOURS_MS
        if close_time <= source_covered_until:
            records.append({"time": close_time, **buckets[bucket_start]})

    frame = pd.DataFrame.from_records(records).set_index("time")
    frame.index = frame.index.astype(np.int64)
    return frame


def align_last_closed_dvol(
    decision_times_ms: Iterable[int],
    candles: list[list[float]],
    resolution_ms: int = HOUR_MS,
) -> dict[str, np.ndarray]:
    decisions = np.asarray(list(decision_times_ms), dtype=np.int64)
    if not candles:
        return {
            "dvol_level": np.full(len(decisions), np.nan),
            "dvol_age_hours": np.full(len(decisions), np.nan),
        }

    ordered = sorted(candles, key=lambda row: int(row[0]))
    candle_close_times = np.asarray(
        [int(row[0]) + int(resolution_ms) for row in ordered], dtype=np.int64
    )
    levels = np.asarray([float(row[4]) for row in ordered], dtype=float)
    positions = np.searchsorted(candle_close_times, decisions, side="right") - 1
    valid = positions >= 0

    aligned = np.full(len(decisions), np.nan)
    ages = np.full(len(decisions), np.nan)
    aligned[valid] = levels[positions[valid]]
    ages[valid] = (decisions[valid] - candle_close_times[positions[valid]]) / HOUR_MS
    return {"dvol_level": aligned, "dvol_age_hours": ages}


def _rolling_realized_vol(log_returns: pd.Series, window: int) -> pd.Series:
    return (
        log_returns.pow(2).rolling(window=window, min_periods=window).mean()
        * PERIODS_PER_YEAR_4H
    ).pow(0.5) * 100


def _forward_mean(values: np.ndarray, horizon: int) -> np.ndarray:
    result = np.full(len(values), np.nan)
    if len(values) <= horizon:
        return result
    clean = np.nan_to_num(values, nan=0.0)
    cumulative = np.concatenate(([0.0], np.cumsum(clean)))
    valid = np.isfinite(values).astype(np.int64)
    valid_cumulative = np.concatenate(([0], np.cumsum(valid)))
    for index in range(len(values) - horizon):
        start = index + 1
        end = index + horizon + 1
        if valid_cumulative[end] - valid_cumulative[start] == horizon:
            result[index] = (cumulative[end] - cumulative[start]) / horizon
    return result


def _forward_realized_vol(log_returns: pd.Series, horizon: int) -> np.ndarray:
    mean_squared = _forward_mean(log_returns.to_numpy(dtype=float) ** 2, horizon)
    return np.sqrt(mean_squared * PERIODS_PER_YEAR_4H) * 100


def _forward_downside_semivol(log_returns: pd.Series, horizon: int) -> np.ndarray:
    downside_squared = np.minimum(log_returns.to_numpy(dtype=float), 0.0) ** 2
    mean_squared = _forward_mean(downside_squared, horizon)
    return np.sqrt(mean_squared * PERIODS_PER_YEAR_4H) * 100


def _forward_long_mae(close: pd.Series, low: pd.Series, horizon: int) -> np.ndarray:
    close_values = close.to_numpy(dtype=float)
    low_values = low.to_numpy(dtype=float)
    result = np.full(len(close_values), np.nan)
    for index in range(len(close_values) - horizon):
        future_min = np.min(low_values[index + 1 : index + horizon + 1])
        result[index] = max(0.0, (close_values[index] - future_min) / close_values[index] * 100)
    return result


def build_feature_frame(price_4h: pd.DataFrame, dvol_candles: list[list[float]]) -> pd.DataFrame:
    frame = price_4h.sort_index().copy()
    close = frame["close"].astype(float)
    previous_close = close.shift(1)
    true_range = pd.concat(
        [
            frame["high"] - frame["low"],
            (frame["high"] - previous_close).abs(),
            (frame["low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    frame["atr_pct14"] = true_range.rolling(14, min_periods=14).mean() / close * 100

    log_returns = np.log(close / previous_close)
    frame["rv_1d"] = _rolling_realized_vol(log_returns, 6)
    frame["rv_7d"] = _rolling_realized_vol(log_returns, 42)
    frame["rv_30d"] = _rolling_realized_vol(log_returns, 180)

    aligned = align_last_closed_dvol(frame.index.to_numpy(), dvol_candles, HOUR_MS)
    frame["dvol_level"] = aligned["dvol_level"]
    frame["dvol_age_hours"] = aligned["dvol_age_hours"]
    stale = frame["dvol_age_hours"] > 2.0
    frame.loc[stale, "dvol_level"] = np.nan
    frame["dvol_chg_24h"] = frame["dvol_level"] - frame["dvol_level"].shift(6)
    frame["dvol_vov_5d"] = frame["dvol_chg_24h"].rolling(30, min_periods=30).std(ddof=0)
    # Variance risk premium is IV^2 - RV^2. Using a volatility-level
    # difference here would be an exact linear combination of two existing
    # model columns (DVOL and rv_30d), making the OLS design singular.
    frame["vrp_proxy"] = (frame["dvol_level"] / 100) ** 2 - (
        frame["rv_30d"] / 100
    ) ** 2

    frame["rv_fwd_1d"] = _forward_realized_vol(log_returns, 6)
    frame["rv_fwd_3d"] = _forward_realized_vol(log_returns, 18)
    frame["downside_semivol_3d"] = _forward_downside_semivol(log_returns, 18)
    frame["mae_long_5d_pct"] = _forward_long_mae(close, frame["low"], 30)
    return frame


def split_purged_is_oos(
    times_ms: Iterable[int],
    valid_mask: Iterable[bool],
    oos_start_ms: int,
    horizon_bars: int,
) -> tuple[np.ndarray, np.ndarray]:
    times = np.asarray(list(times_ms), dtype=np.int64)
    valid = np.asarray(list(valid_mask), dtype=bool)
    target_end = times + int(horizon_bars) * FOUR_HOURS_MS
    is_mask = valid & (target_end <= int(oos_start_ms))
    oos_mask = valid & (times >= int(oos_start_ms))
    return is_mask, oos_mask


@dataclass(frozen=True)
class FrozenOLS:
    mean: np.ndarray
    scale: np.ndarray
    coefficients: np.ndarray
    condition_number: float

    def predict(self, features: np.ndarray) -> np.ndarray:
        standardized = (features - self.mean) / self.scale
        design = np.column_stack([np.ones(len(standardized)), standardized])
        return np.maximum(0.0, design @ self.coefficients)


def fit_frozen_ols(features: np.ndarray, target: np.ndarray) -> FrozenOLS:
    mean = np.mean(features, axis=0)
    scale = np.std(features, axis=0)
    scale = np.where(scale > 1e-12, scale, 1.0)
    standardized = (features - mean) / scale
    design = np.column_stack([np.ones(len(standardized)), standardized])
    coefficients, _, _, _ = np.linalg.lstsq(design, target, rcond=None)
    return FrozenOLS(
        mean=mean,
        scale=scale,
        coefficients=coefficients,
        condition_number=float(np.linalg.cond(design)),
    )


def _regression_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    errors = actual - predicted
    sse = float(np.sum(errors**2))
    centered = actual - np.mean(actual)
    sst = float(np.sum(centered**2))
    return {
        "r2": float(1 - sse / sst) if sst > 0 else 0.0,
        "mse": float(np.mean(errors**2)),
        "mae": float(np.mean(np.abs(errors))),
    }


def newey_west_dm(loss_improvement: np.ndarray, max_lag: int) -> dict[str, float]:
    values = np.asarray(loss_improvement, dtype=float)
    values = values[np.isfinite(values)]
    if len(values) < 3:
        return {"stat": 0.0, "p_one_sided": 1.0, "mean_loss_improvement": 0.0}
    centered = values - np.mean(values)
    gamma_zero = float(np.dot(centered, centered) / len(values))
    long_run_variance = gamma_zero
    usable_lag = min(int(max_lag), len(values) - 1)
    for lag in range(1, usable_lag + 1):
        covariance = float(np.dot(centered[lag:], centered[:-lag]) / len(values))
        weight = 1 - lag / (usable_lag + 1)
        long_run_variance += 2 * weight * covariance
    variance_of_mean = max(long_run_variance / len(values), 0.0)
    mean = float(np.mean(values))
    if variance_of_mean <= 1e-30:
        statistic = math.inf if mean > 0 else (-math.inf if mean < 0 else 0.0)
    else:
        statistic = mean / math.sqrt(variance_of_mean)
    return {
        "stat": float(statistic),
        "p_one_sided": float(norm.sf(statistic)),
        "mean_loss_improvement": mean,
    }


def calendar_month_bootstrap(
    times: Iterable,
    loss_improvement: Iterable[float],
    *,
    iterations: int = 5_000,
    seed: int = 20_260_712,
) -> dict[str, float | int]:
    timestamps = pd.DatetimeIndex(times)
    values = np.asarray(list(loss_improvement), dtype=float)
    if len(timestamps) != len(values):
        raise ValueError("times and loss_improvement must have the same length")
    valid = np.isfinite(values)
    timestamps = timestamps[valid]
    values = values[valid]
    if not len(values):
        raise ValueError("bootstrap requires at least one finite observation")

    month_labels = timestamps.strftime("%Y-%m")
    unique_months = np.unique(month_labels)
    sums = np.asarray([values[month_labels == month].sum() for month in unique_months])
    counts = np.asarray([np.sum(month_labels == month) for month in unique_months])
    rng = np.random.default_rng(seed)
    sampled = rng.integers(0, len(unique_months), size=(iterations, len(unique_months)))
    replicate_means = sums[sampled].sum(axis=1) / counts[sampled].sum(axis=1)
    return {
        "months": int(len(unique_months)),
        "iterations": int(iterations),
        "mean": float(np.mean(values)),
        "ci95_low": float(np.quantile(replicate_means, 0.025)),
        "ci95_high": float(np.quantile(replicate_means, 0.975)),
        "p_one_sided": float((np.sum(replicate_means <= 0) + 1) / (iterations + 1)),
    }


def _year_slices(
    times: pd.DatetimeIndex,
    actual: np.ndarray,
    baseline: np.ndarray,
    augmented: np.ndarray,
) -> dict[str, dict[str, float | int]]:
    result = {}
    for year in sorted(np.unique(times.year)):
        mask = times.year == year
        if np.sum(mask) < 20:
            continue
        baseline_mse = float(np.mean((actual[mask] - baseline[mask]) ** 2))
        augmented_mse = float(np.mean((actual[mask] - augmented[mask]) ** 2))
        result[str(year)] = {
            "n": int(np.sum(mask)),
            "incremental_r2_vs_baseline": (
                float(1 - augmented_mse / baseline_mse) if baseline_mse > 0 else 0.0
            ),
        }
    return result


def evaluate_target(
    frame: pd.DataFrame,
    target_name: str,
    horizon_bars: int,
    *,
    bootstrap_iterations: int,
) -> dict:
    required = ALL_FEATURES + [target_name]
    valid = np.isfinite(frame[required].to_numpy(dtype=float)).all(axis=1)
    is_mask, oos_mask = split_purged_is_oos(
        frame.index.to_numpy(), valid, OOS_START_MS, horizon_bars
    )
    if np.sum(is_mask) <= len(ALL_FEATURES) + 1:
        raise RuntimeError(f"Not enough IS rows for {target_name}")
    if not np.any(oos_mask):
        raise RuntimeError(f"No OOS rows for {target_name}")

    y_is = frame.loc[is_mask, target_name].to_numpy(dtype=float)
    y_oos = frame.loc[oos_mask, target_name].to_numpy(dtype=float)
    base_is = frame.loc[is_mask, BASE_FEATURES].to_numpy(dtype=float)
    base_oos = frame.loc[oos_mask, BASE_FEATURES].to_numpy(dtype=float)
    all_is = frame.loc[is_mask, ALL_FEATURES].to_numpy(dtype=float)
    all_oos = frame.loc[oos_mask, ALL_FEATURES].to_numpy(dtype=float)

    baseline_model = fit_frozen_ols(base_is, y_is)
    augmented_model = fit_frozen_ols(all_is, y_is)
    baseline_is_prediction = baseline_model.predict(base_is)
    augmented_is_prediction = augmented_model.predict(all_is)
    baseline_prediction = baseline_model.predict(base_oos)
    augmented_prediction = augmented_model.predict(all_oos)

    baseline_oos = _regression_metrics(y_oos, baseline_prediction)
    augmented_oos = _regression_metrics(y_oos, augmented_prediction)
    baseline_is = _regression_metrics(y_is, baseline_is_prediction)
    augmented_is = _regression_metrics(y_is, augmented_is_prediction)

    incremental_r2 = (
        1 - augmented_oos["mse"] / baseline_oos["mse"] if baseline_oos["mse"] > 0 else 0.0
    )
    mae_improvement = (
        1 - augmented_oos["mae"] / baseline_oos["mae"] if baseline_oos["mae"] > 0 else 0.0
    )
    loss_improvement = (y_oos - baseline_prediction) ** 2 - (
        y_oos - augmented_prediction
    ) ** 2
    oos_times = pd.to_datetime(frame.index.to_numpy()[oos_mask], unit="ms", utc=True)
    dm = newey_west_dm(loss_improvement, max_lag=horizon_bars - 1)
    bootstrap = calendar_month_bootstrap(
        oos_times,
        loss_improvement,
        iterations=bootstrap_iterations,
        seed=20_260_712,
    )
    unique_days = int(len(np.unique(oos_times.strftime("%Y-%m-%d"))))
    passes = bool(
        unique_days >= MIN_OOS_UNIQUE_DAYS
        and incremental_r2 >= INCREMENTAL_R2_MIN
        and mae_improvement > 0
        and dm["p_one_sided"] <= SIGNIFICANCE_MAX_P
        and bootstrap["p_one_sided"] <= SIGNIFICANCE_MAX_P
        and augmented_model.condition_number <= MAX_AUGMENTED_CONDITION_NUMBER
    )

    return {
        "horizon_bars_4h": int(horizon_bars),
        "is_rows": int(np.sum(is_mask)),
        "oos_rows": int(np.sum(oos_mask)),
        "oos_unique_days": unique_days,
        "is_last_decision_utc": utc_iso(int(frame.index.to_numpy()[is_mask][-1])),
        "is_last_target_end_utc": utc_iso(
            int(frame.index.to_numpy()[is_mask][-1] + horizon_bars * FOUR_HOURS_MS)
        ),
        "oos_first_decision_utc": utc_iso(int(frame.index.to_numpy()[oos_mask][0])),
        "baseline_is": baseline_is,
        "augmented_is": augmented_is,
        "baseline_oos": baseline_oos,
        "augmented_oos": augmented_oos,
        "incremental_r2_vs_baseline": float(incremental_r2),
        "mae_improvement_fraction": float(mae_improvement),
        "newey_west_dm": dm,
        "calendar_month_bootstrap": bootstrap,
        "baseline_condition_number": baseline_model.condition_number,
        "augmented_condition_number": augmented_model.condition_number,
        "standardized_dvol_coefficients": {
            feature: float(coefficient)
            for feature, coefficient in zip(
                DVOL_FEATURES,
                augmented_model.coefficients[1 + len(BASE_FEATURES) :],
            )
        },
        "year_slices": _year_slices(
            oos_times, y_oos, baseline_prediction, augmented_prediction
        ),
        "target_pass": passes,
    }


def _git_provenance(repo: Path) -> dict[str, str | bool]:
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return {"commit": head, "dirty": bool(status.strip())}


def run_gate0(
    btc_path: Path,
    dvol_cache_path: Path,
    *,
    bootstrap_iterations: int,
) -> dict:
    price = aggregate_binance_4h(btc_path)
    dvol = load_or_download_dvol(
        dvol_cache_path,
        DVOL_START_MS,
        int(price.index[-1]),
    )
    frame = build_feature_frame(price, dvol)
    results = {
        name: evaluate_target(
            frame,
            name,
            int(config["horizon_bars"]),
            bootstrap_iterations=bootstrap_iterations,
        )
        for name, config in TARGETS.items()
    }
    primary_name = next(name for name, config in TARGETS.items() if config["primary"])
    secondary_passes = [
        name
        for name, config in TARGETS.items()
        if not config["primary"] and results[name]["target_pass"]
    ]
    gate_pass = bool(results[primary_name]["target_pass"] and secondary_passes)

    repo = Path(__file__).resolve().parents[1]
    complete_features = np.isfinite(frame[ALL_FEATURES].to_numpy(dtype=float)).all(axis=1)
    result = {
        "study": "BTC DVOL incremental-information Gate-0",
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "verdict": "PASS_TO_H05_GATE1" if gate_pass else "KILL_NO_INCREMENTAL_DVOL_EDGE",
        "gate_pass": gate_pass,
        "primary_target": primary_name,
        "secondary_targets_passing": secondary_passes,
        "contract": {
            "oos_start_utc": utc_iso(OOS_START_MS),
            "fit_policy": "single IS fit; coefficients and IS scaling frozen for OOS",
            "baseline_features": BASE_FEATURES,
            "added_features": DVOL_FEATURES,
            "feature_definitions": {
                "dvol_level": "last closed Deribit BTC DVOL 1h close",
                "dvol_chg_24h": "DVOL level minus its value 24h earlier",
                "dvol_vov_5d": "5d rolling population std of 24h DVOL changes",
                "vrp_proxy": "(DVOL/100)^2 - (realized_vol_30d/100)^2",
            },
            "target_pass_requires": {
                "incremental_oos_r2_min": INCREMENTAL_R2_MIN,
                "mae_improvement_gt": 0,
                "newey_west_one_sided_p_max": SIGNIFICANCE_MAX_P,
                "calendar_month_bootstrap_one_sided_p_max": SIGNIFICANCE_MAX_P,
                "oos_unique_days_min": MIN_OOS_UNIQUE_DAYS,
                "augmented_condition_number_max": MAX_AUGMENTED_CONDITION_NUMBER,
            },
            "gate_pass_requires": "primary target plus at least one secondary target",
            "parameter_search": False,
            "pnl_evaluated": False,
        },
        "data": {
            "btc_source": str(btc_path.resolve()),
            "btc_sha256": sha256_file(btc_path),
            "btc_4h_bars": int(len(price)),
            "btc_first_closed_bar_utc": utc_iso(int(price.index[0])),
            "btc_last_closed_bar_utc": utc_iso(int(price.index[-1])),
            "dvol_source": DERIBIT_ENDPOINT,
            "dvol_cache": str(dvol_cache_path.resolve()),
            "dvol_cache_sha256": sha256_file(dvol_cache_path),
            "dvol_1h_candles": int(len(dvol)),
            "dvol_first_open_utc": utc_iso(int(dvol[0][0])),
            "dvol_first_close_utc": utc_iso(int(dvol[0][0]) + HOUR_MS),
            "dvol_last_close_utc": utc_iso(int(dvol[-1][0]) + HOUR_MS),
            "complete_feature_rows": int(np.sum(complete_features)),
            "max_dvol_age_hours_complete_rows": float(
                frame.loc[complete_features, "dvol_age_hours"].max()
            ),
        },
        "provenance": {
            **_git_provenance(repo),
            "evaluator": str(Path(__file__).resolve()),
            "evaluator_sha256": sha256_file(Path(__file__).resolve()),
            "python": subprocess.run(
                ["python3", "--version"], check=True, capture_output=True, text=True
            ).stdout.strip(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scipy": __import__("scipy").__version__,
            "bootstrap_iterations": int(bootstrap_iterations),
            "bootstrap_seed": 20_260_712,
        },
        "targets": results,
    }
    return result


def render_markdown(result: dict) -> str:
    lines = [
        "# BTC DVOL Incremental-Information Gate-0",
        "",
        f"- Verdict: **{result['verdict']}**",
        f"- Generated: `{result['generated_at_utc']}`",
        f"- Split: IS labels purged before `{result['contract']['oos_start_utc']}`; OOS starts there.",
        "- Models: price-only ATR/HAR OLS versus the same frozen model plus DVOL.",
        "- Scope: information test only; no strategy PnL and no live-rule change.",
        "",
        "## Frozen Contract",
        "",
        f"- Baseline: `{', '.join(result['contract']['baseline_features'])}`",
        f"- Added: `{', '.join(result['contract']['added_features'])}`",
        "- Target PASS: incremental OOS R2 >= 2%, MAE improves, both HAC DM and month-block p <= 0.10, condition number <= 1e8.",
        "- Gate PASS: primary downside-semivol target plus at least one secondary target.",
        "",
        "## Results",
        "",
        "| Target | IS n | OOS n | Inc. R2 | MAE improvement | DM p | Block p | Cond. | PASS |",
        "|---|---:|---:|---:|---:|---:|---:|---:|:---:|",
    ]
    for name, metrics in result["targets"].items():
        lines.append(
            f"| `{name}` | {metrics['is_rows']} | {metrics['oos_rows']} | "
            f"{metrics['incremental_r2_vs_baseline']:.4f} | "
            f"{metrics['mae_improvement_fraction']:.4f} | "
            f"{metrics['newey_west_dm']['p_one_sided']:.4f} | "
            f"{metrics['calendar_month_bootstrap']['p_one_sided']:.4f} | "
            f"{metrics['augmented_condition_number']:.2f} | "
            f"{'YES' if metrics['target_pass'] else 'NO'} |"
        )
    lines.extend(["", "## OOS Year Stability", ""])
    for name, metrics in result["targets"].items():
        slices = ", ".join(
            f"{year}: {values['incremental_r2_vs_baseline']:+.2%}"
            for year, values in metrics["year_slices"].items()
        )
        lines.append(f"- `{name}`: {slices}")
    lines.extend(
        [
            "",
            "## Data And Provenance",
            "",
            f"- BTC 4h closed bars: `{result['data']['btc_4h_bars']}` through `{result['data']['btc_last_closed_bar_utc']}`.",
            f"- DVOL 1h candles: `{result['data']['dvol_1h_candles']}` from `{result['data']['dvol_first_open_utc']}`.",
            f"- BTC SHA-256: `{result['data']['btc_sha256']}`",
            f"- DVOL SHA-256: `{result['data']['dvol_cache_sha256']}`",
            f"- Evaluator SHA-256: `{result['provenance']['evaluator_sha256']}`",
            f"- Git commit at run: `{result['provenance']['commit']}`; dirty=`{str(result['provenance']['dirty']).lower()}`.",
            "",
            "## Interpretation Rule",
            "",
            "A PASS only authorizes a separate H05 losing-position replay. It does not authorize entry changes, sizing changes, DCA, reversal, deployment, or live arming.",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--btc",
        type=Path,
        default=repo / ".cache" / "binance-5m-7y.json",
        help="BTC Binance 5m JSON source",
    )
    parser.add_argument(
        "--dvol-cache",
        type=Path,
        default=repo / ".cache" / "deribit-btc-dvol-1h.json",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        default=repo / "docs" / "research" / "dvol-gate0-2026-07-12.json",
    )
    parser.add_argument(
        "--markdown-output",
        type=Path,
        default=repo / "docs" / "dvol-gate0-2026-07-12.md",
    )
    parser.add_argument("--bootstrap-iterations", type=int, default=5_000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.bootstrap_iterations < 100:
        raise ValueError("bootstrap iterations must be at least 100")
    result = run_gate0(
        args.btc,
        args.dvol_cache,
        bootstrap_iterations=args.bootstrap_iterations,
    )
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    args.markdown_output.write_text(render_markdown(result))
    print(json.dumps({"verdict": result["verdict"], "targets": result["targets"]}, indent=2))


if __name__ == "__main__":
    main()
