#!/usr/bin/env python3
"""Gate-1: test whether frozen DVOL stress scores improve H01 HOLD/CUT choices.

The evaluator never changes entries and never fits a classifier on H01 trades.
It reuses the frozen Gate-0 downside-volatility models, creates at most one
causal losing-position decision per accepted S13/S14 trade, and evaluates a
fixed high-risk CUT policy on untouched post-2023-07-01 episodes.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import subprocess
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
from scipy.stats import rankdata

from dvol_gate0 import (
    ALL_FEATURES,
    BASE_FEATURES,
    FOUR_HOURS_MS,
    OOS_START_MS,
    aggregate_binance_4h,
    build_feature_frame,
    fit_frozen_ols,
)


HOUR_MS = 60 * 60 * 1000
FIVE_MINUTES_MS = 5 * 60 * 1000
CHECKPOINT_HOURS = (4, 8)
RISK_QUANTILE = 0.75
BOOTSTRAP_ITERATIONS = 5_000
BOOTSTRAP_SEED = 20_260_712

SETUP_QUANTITY = {"S12": 0.005, "S13": 0.003, "S14": 0.005}
SETUP_COOLDOWN_MS = {
    "S12": 12 * HOUR_MS,
    "S13": 4 * HOUR_MS,
    "S14": 12 * HOUR_MS,
}
TREND_LONG_CAP = 0.02

EXPECTED_PARENT_ROWS_SHA256 = (
    "aee16f898cf5d9eb9f0a51642f6cf003b0125b6281e9d6170ddf816687cb0a31"
)
EXPECTED_PARENT_WORKTREE_COMMIT = "ecec7cc953563cd87477c7104b20f9480a95c51f"
EXPECTED_SERVER_MODULE_HASH = (
    "2956e5c85f25175c09fcc66f364b267c7066dfd72670ec64efb0e10f11bece4e"
)
EXPECTED_SOURCE_ROWS = 114
EXPECTED_ACCEPTED_BASELINE = 96

MIN_OOS_EPISODES = 30
MIN_CLASS_COUNT = 10
MIN_AUGMENTED_AUC = 0.60
MIN_AUC_GAIN = 0.05

CHILD_FIELDS = (
    "fillTime",
    "rawFillPrice",
    "fillPrice",
    "exitTime",
    "exitPrice",
    "grossPnl",
    "fundingPnl",
    "fees",
    "netPnl",
    "grossEntryNotional",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_iso(timestamp_ms: int) -> str:
    return dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc).isoformat()


def _compact_child(value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("H01 source child is missing")
    compact = {}
    for field in CHILD_FIELDS:
        item = value.get(field)
        if not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise ValueError(f"H01 source child has invalid {field}")
        compact[field] = item
    if compact["exitTime"] < compact["fillTime"]:
        raise ValueError("H01 source child exits before entry")
    return compact


def extract_compact_source(parent_rows_path: Path) -> dict:
    base_rows = None
    with parent_rows_path.open() as handle:
        for line in handle:
            record = json.loads(line)
            if record.get("variant") == "base":
                if base_rows is not None:
                    raise ValueError("parent contains duplicate base row sets")
                base_rows = record.get("rows")
    if not isinstance(base_rows, list):
        raise ValueError("parent base row set is missing")

    episodes = []
    seen = set()
    for row in base_rows:
        setup = row.get("setup")
        signal_time = row.get("signalTime")
        split = row.get("split")
        atr = row.get("atr")
        if (
            setup not in SETUP_QUANTITY
            or not isinstance(signal_time, int)
            or split not in {"discovery", "validation"}
            or not isinstance(atr, (int, float))
            or not math.isfinite(float(atr))
            or atr <= 0
        ):
            raise ValueError("parent H01 row is invalid")
        key = f"{setup}|{signal_time}"
        if key in seen:
            raise ValueError(f"duplicate H01 source {key}")
        seen.add(key)
        scenarios = row.get("scenarios", {})
        primary = scenarios.get("primaryLowHigh", {}).get("methods", {}).get("A", {})
        stress = scenarios.get("stressLowHigh", {}).get("methods", {}).get("A", {})
        episodes.append(
            {
                "setup": setup,
                "signalTime": signal_time,
                "split": split,
                "atr": float(atr),
                "primary": _compact_child(primary.get("initialChild")),
                "stress": _compact_child(stress.get("initialChild")),
            }
        )
    episodes.sort(key=lambda row: (row["signalTime"], row["setup"]))
    return {
        "schemaVersion": 1,
        "kind": "H01_BASELINE_A_COMPACT_SOURCE",
        "parentPath": str(parent_rows_path.resolve()),
        "parentRowsSha256": sha256_file(parent_rows_path),
        "parentWorktreeCommit": EXPECTED_PARENT_WORKTREE_COMMIT,
        "serverHedge01ModuleSha256": EXPECTED_SERVER_MODULE_HASH,
        "rowCount": len(episodes),
        "episodes": episodes,
    }


def _source_key(episode: dict) -> str:
    return f"{episode['setup']}|{episode['signalTime']}"


def project_baseline_acceptance(episodes: list[dict]) -> dict:
    events = []
    for item in episodes:
        setup = item["setup"]
        if setup not in SETUP_QUANTITY:
            raise ValueError(f"unknown setup {setup}")
        child = item["primary"]
        key = _source_key(item)
        events.append((int(item["signalTime"]), 1, setup, key, "ENTRY", item))
        events.append((int(child["exitTime"]), 0, setup, key, "CLOSE", item))
    events.sort(key=lambda event: (event[0], event[1], event[2], event[3]))

    accepted = set()
    blocked = []
    last_accepted = {}
    open_quantity = 0.0
    max_open_quantity = 0.0
    for timestamp, _, setup, key, kind, item in events:
        quantity = SETUP_QUANTITY[setup]
        if kind == "CLOSE":
            if key in accepted:
                open_quantity -= quantity
                if abs(open_quantity) < 1e-12:
                    open_quantity = 0.0
                if open_quantity < -1e-12:
                    raise ValueError("portfolio quantity became negative")
            continue

        prior = last_accepted.get(setup)
        reason = None
        if prior is not None and timestamp - prior < SETUP_COOLDOWN_MS[setup]:
            reason = "SETUP_COOLDOWN"
        elif open_quantity + quantity > TREND_LONG_CAP + 1e-12:
            reason = "TREND_CAP"
        if reason:
            blocked.append({"key": key, "time": timestamp, "reason": reason})
            continue
        accepted.add(key)
        last_accepted[setup] = timestamp
        open_quantity += quantity
        max_open_quantity = max(max_open_quantity, open_quantity)

    return {
        "acceptedKeys": sorted(accepted),
        "blocked": blocked,
        "maxOpenQuantity": max_open_quantity,
        "endingOpenQuantity": open_quantity,
    }


def first_losing_checkpoint(episode: dict, hourly_by_open: dict[int, dict]) -> int | None:
    child = episode["primary"]
    fill_time = int(child["fillTime"])
    fill_price = float(child["fillPrice"])
    exit_time = int(child["exitTime"])
    for hours in CHECKPOINT_HOURS:
        boundary = fill_time + hours * HOUR_MS
        if exit_time <= boundary:
            return None
        closed_hour = hourly_by_open.get(boundary - HOUR_MS)
        if closed_hour is None:
            raise ValueError(f"missing closed 1h bar at {boundary - HOUR_MS}")
        close = float(closed_hour["close"])
        if not math.isfinite(close) or close <= 0:
            raise ValueError("invalid closed 1h price")
        if close < fill_price:
            return boundary
    return None


def simulate_long_cut(
    *,
    raw_entry_price: float,
    raw_exit_price: float,
    fill_time: int,
    exit_time: int,
    funding: list[dict],
    funding_price_by_time: dict[int, float],
    fee_bps: float,
    slippage_bps: float,
) -> dict:
    if exit_time < fill_time:
        raise ValueError("cut exits before entry")
    fee_rate = fee_bps / 10_000
    slippage_rate = slippage_bps / 10_000
    fill_price = raw_entry_price * (1 + slippage_rate)
    exit_price = raw_exit_price * (1 - slippage_rate)
    funding_pnl = 0.0
    proxy_count = 0
    previous_time = -1
    for record in funding:
        timestamp = int(record["time"])
        if timestamp <= previous_time:
            raise ValueError("funding timestamps must be strictly increasing")
        previous_time = timestamp
        if timestamp < fill_time or timestamp > exit_time:
            continue
        mark = record.get("mark")
        if not isinstance(mark, (int, float)) or not math.isfinite(float(mark)) or mark <= 0:
            proxy_time = timestamp // FIVE_MINUTES_MS * FIVE_MINUTES_MS
            mark = funding_price_by_time.get(proxy_time)
            if mark is None:
                raise ValueError(f"missing funding mark proxy at {proxy_time}")
            proxy_count += 1
        funding_pnl -= float(mark) * float(record["rate"])
    gross_pnl = exit_price - fill_price
    fees = (fill_price + exit_price) * fee_rate
    return {
        "fillPrice": fill_price,
        "exitPrice": exit_price,
        "grossPnl": gross_pnl,
        "fundingPnl": funding_pnl,
        "fundingProxyCount": proxy_count,
        "fees": fees,
        "netPnl": gross_pnl + funding_pnl - fees,
    }


def binary_auc(labels: Iterable[int], scores: Iterable[float]) -> float:
    y = np.asarray(list(labels), dtype=int)
    values = np.asarray(list(scores), dtype=float)
    if len(y) != len(values) or not len(y):
        raise ValueError("AUC inputs must be non-empty and equal length")
    positives = y == 1
    positive_count = int(np.sum(positives))
    negative_count = len(y) - positive_count
    if positive_count == 0 or negative_count == 0:
        raise ValueError("AUC requires both classes")
    ranks = rankdata(values, method="average")
    rank_sum = float(np.sum(ranks[positives]))
    return (rank_sum - positive_count * (positive_count + 1) / 2) / (
        positive_count * negative_count
    )


def required_setups_present(rows: Iterable[dict]) -> bool:
    return {"S13", "S14"}.issubset({row.get("setup") for row in rows})


def _month_groups(times: pd.DatetimeIndex) -> tuple[np.ndarray, list[np.ndarray]]:
    labels = np.asarray(times.strftime("%Y-%m"))
    months = np.unique(labels)
    return months, [np.flatnonzero(labels == month) for month in months]


def month_block_bootstrap(
    times: Iterable,
    values: Iterable[float],
    *,
    iterations: int = BOOTSTRAP_ITERATIONS,
    seed: int = BOOTSTRAP_SEED,
) -> dict:
    timestamps = pd.DatetimeIndex(times)
    array = np.asarray(list(values), dtype=float)
    if len(timestamps) != len(array) or not len(array):
        raise ValueError("bootstrap inputs must be non-empty and equal length")
    months, groups = _month_groups(timestamps)
    sums = np.asarray([np.sum(array[group]) for group in groups])
    counts = np.asarray([len(group) for group in groups])
    rng = np.random.default_rng(seed)
    choices = rng.integers(0, len(months), size=(iterations, len(months)))
    means = sums[choices].sum(axis=1) / counts[choices].sum(axis=1)
    return {
        "months": int(len(months)),
        "iterations": int(iterations),
        "mean": float(np.mean(array)),
        "ci90Low": float(np.quantile(means, 0.05)),
        "ci90High": float(np.quantile(means, 0.95)),
        "pOneSided": float((np.sum(means <= 0) + 1) / (iterations + 1)),
    }


def auc_gain_month_bootstrap(
    times: pd.DatetimeIndex,
    labels: np.ndarray,
    baseline_scores: np.ndarray,
    augmented_scores: np.ndarray,
    *,
    iterations: int = BOOTSTRAP_ITERATIONS,
    seed: int = BOOTSTRAP_SEED,
) -> dict:
    months, groups = _month_groups(times)
    rng = np.random.default_rng(seed)
    gains = []
    for _ in range(iterations):
        chosen = rng.integers(0, len(months), size=len(months))
        indices = np.concatenate([groups[index] for index in chosen])
        sampled_labels = labels[indices]
        if len(np.unique(sampled_labels)) != 2:
            continue
        gains.append(
            binary_auc(sampled_labels, augmented_scores[indices])
            - binary_auc(sampled_labels, baseline_scores[indices])
        )
    if len(gains) < iterations * 0.8:
        raise ValueError("too many AUC bootstrap samples lacked both classes")
    values = np.asarray(gains)
    return {
        "months": int(len(months)),
        "validIterations": int(len(values)),
        "ci90Low": float(np.quantile(values, 0.05)),
        "ci90High": float(np.quantile(values, 0.95)),
        "pOneSided": float((np.sum(values <= 0) + 1) / (len(values) + 1)),
    }


def fit_frozen_gate0_oracles(spot_5m_path: Path, dvol_cache_path: Path) -> dict:
    price = aggregate_binance_4h(spot_5m_path)
    dvol_payload = json.loads(dvol_cache_path.read_text())
    frame = build_feature_frame(price, dvol_payload["data"])
    target_name = "downside_semivol_3d"
    horizon_bars = 18
    required = ALL_FEATURES + [target_name]
    valid = np.isfinite(frame[required].to_numpy(dtype=float)).all(axis=1)
    times = frame.index.to_numpy(dtype=np.int64)
    train = valid & (times + horizon_bars * FOUR_HOURS_MS <= OOS_START_MS)
    if np.sum(train) < 1_000:
        raise ValueError("Gate-0 IS population is unexpectedly small")
    target = frame.loc[train, target_name].to_numpy(dtype=float)
    baseline_x = frame.loc[train, BASE_FEATURES].to_numpy(dtype=float)
    augmented_x = frame.loc[train, ALL_FEATURES].to_numpy(dtype=float)
    baseline_model = fit_frozen_ols(baseline_x, target)
    augmented_model = fit_frozen_ols(augmented_x, target)
    baseline_train_scores = baseline_model.predict(baseline_x)
    augmented_train_scores = augmented_model.predict(augmented_x)

    complete_features = np.isfinite(frame[ALL_FEATURES].to_numpy(dtype=float)).all(axis=1)
    complete = frame.loc[complete_features]
    baseline_scores = baseline_model.predict(complete[BASE_FEATURES].to_numpy(dtype=float))
    augmented_scores = augmented_model.predict(complete[ALL_FEATURES].to_numpy(dtype=float))
    score_by_time = {
        int(timestamp): {
            "baseline": float(baseline),
            "augmented": float(augmented),
        }
        for timestamp, baseline, augmented in zip(
            complete.index.to_numpy(dtype=np.int64), baseline_scores, augmented_scores
        )
    }
    return {
        "scoreByTime": score_by_time,
        "baselineQ75": float(np.quantile(baseline_train_scores, RISK_QUANTILE)),
        "augmentedQ75": float(np.quantile(augmented_train_scores, RISK_QUANTILE)),
        "isRows": int(np.sum(train)),
        "isLastDecision": int(times[train][-1]),
        "baselineConditionNumber": baseline_model.condition_number,
        "augmentedConditionNumber": augmented_model.condition_number,
    }


def _load_hourly(path: Path) -> tuple[list[dict], dict[int, dict]]:
    rows = json.loads(path.read_text())
    by_open = {}
    prior = -1
    for row in rows:
        timestamp = int(row["time"])
        if timestamp <= prior:
            raise ValueError("hourly timestamps must be strictly increasing")
        prior = timestamp
        by_open[timestamp] = row
    return rows, by_open


def _needed_five_minute_opens(path: Path, needed_times: set[int]) -> dict[int, float]:
    rows = json.loads(path.read_text())
    found = {
        int(row["time"]): float(row["open"])
        for row in rows
        if int(row["time"]) in needed_times
    }
    missing = sorted(needed_times - set(found))
    if missing:
        raise ValueError(f"missing required 5m opens: {missing[:5]}")
    return found


def _selected_value(row: dict, policy: str, cost: str) -> float:
    if policy == "HOLD":
        return row[f"hold_{cost}_dollars"]
    if policy == "PRICE_Q75":
        action = row["priceAction"]
    elif policy == "DVOL_Q75":
        action = row["dvolAction"]
    else:
        raise ValueError(f"unknown policy {policy}")
    return row[f"cut_{cost}_dollars"] if action == "CUT" else row[f"hold_{cost}_dollars"]


def _policy_summary(rows: list[dict], policy: str) -> dict:
    primary = [_selected_value(row, policy, "primary") for row in rows]
    stress = [_selected_value(row, policy, "stress") for row in rows]
    actions = [
        "HOLD" if policy == "HOLD" else row["priceAction" if policy == "PRICE_Q75" else "dvolAction"]
        for row in rows
    ]
    return {
        "policy": policy,
        "episodes": len(rows),
        "cuts": int(sum(action == "CUT" for action in actions)),
        "holds": int(sum(action == "HOLD" for action in actions)),
        "primaryNetDollars": float(np.sum(primary)),
        "stressNetDollars": float(np.sum(stress)),
        "primaryWinRate": float(np.mean(np.asarray(primary) > 0)),
    }


def _delta_analysis(rows: list[dict], left: str, right: str, cost: str) -> dict:
    values = np.asarray(
        [_selected_value(row, left, cost) - _selected_value(row, right, cost) for row in rows]
    )
    times = pd.to_datetime([row["decisionTime"] for row in rows], unit="ms", utc=True)
    bootstrap = month_block_bootstrap(times, values)
    return {
        "left": left,
        "right": right,
        "cost": cost,
        "totalDollars": float(np.sum(values)),
        "meanDollars": float(np.mean(values)),
        "positiveEpisodes": int(np.sum(values > 0)),
        "negativeEpisodes": int(np.sum(values < 0)),
        "bootstrap": bootstrap,
        "perEpisode": values,
    }


def _robustness(rows: list[dict], deltas: np.ndarray) -> dict:
    best_episode = int(np.argmax(deltas))
    months = np.asarray(
        pd.to_datetime([row["decisionTime"] for row in rows], unit="ms", utc=True).strftime("%Y-%m")
    )
    month_values = {month: float(np.sum(deltas[months == month])) for month in np.unique(months)}
    best_month = max(month_values, key=month_values.get)
    by_setup = {
        setup: float(np.sum([delta for row, delta in zip(rows, deltas) if row["setup"] == setup]))
        for setup in ("S13", "S14")
    }
    by_year = {}
    for row, delta in zip(rows, deltas):
        year = utc_iso(row["decisionTime"])[:4]
        by_year[year] = by_year.get(year, 0.0) + float(delta)
    return {
        "dropBestEpisodeDollars": float(np.sum(np.delete(deltas, best_episode))),
        "bestEpisodeKey": rows[best_episode]["sourceKey"],
        "removeBestMonthDollars": float(np.sum(deltas) - month_values[best_month]),
        "bestMonth": best_month,
        "bySetupDollars": by_setup,
        "byYearDollars": by_year,
    }


def evaluate_gate1(
    *,
    source_path: Path,
    spot_5m_path: Path,
    dvol_cache_path: Path,
    futures_1h_path: Path,
    futures_5m_path: Path,
    funding_path: Path,
) -> dict:
    source = json.loads(source_path.read_text())
    if (
        source.get("rowCount") != EXPECTED_SOURCE_ROWS
        or source.get("parentRowsSha256") != EXPECTED_PARENT_ROWS_SHA256
        or source.get("serverHedge01ModuleSha256") != EXPECTED_SERVER_MODULE_HASH
    ):
        raise ValueError("compact H01 source provenance mismatch")
    episodes = source["episodes"]
    portfolio = project_baseline_acceptance(episodes)
    if len(portfolio["acceptedKeys"]) != EXPECTED_ACCEPTED_BASELINE:
        raise ValueError("baseline portfolio acceptance drift")
    accepted = set(portfolio["acceptedKeys"])

    _, hourly = _load_hourly(futures_1h_path)
    candidates = []
    for item in episodes:
        if item["setup"] not in {"S13", "S14"} or _source_key(item) not in accepted:
            continue
        decision = first_losing_checkpoint(item, hourly)
        if decision is None or decision < OOS_START_MS or item["signalTime"] < OOS_START_MS:
            continue
        candidates.append((item, decision))
    candidates.sort(key=lambda pair: (pair[1], pair[0]["setup"], pair[0]["signalTime"]))
    candidate_setup_counts = {
        setup: int(sum(item["setup"] == setup for item, _ in candidates))
        for setup in ("S13", "S14")
    }
    setup_population_present = required_setups_present(
        [item for item, _ in candidates]
    )

    funding = json.loads(funding_path.read_text())
    needed_times = {decision for _, decision in candidates}
    for record in funding:
        mark = record.get("mark")
        if not isinstance(mark, (int, float)) or not math.isfinite(float(mark)) or mark <= 0:
            needed_times.add(int(record["time"]) // FIVE_MINUTES_MS * FIVE_MINUTES_MS)
    five_minute_opens = _needed_five_minute_opens(futures_5m_path, needed_times)
    oracle = fit_frozen_gate0_oracles(spot_5m_path, dvol_cache_path)

    rows = []
    for item, decision in candidates:
        scores = oracle["scoreByTime"].get(decision)
        if scores is None:
            raise ValueError(f"missing Gate-0 score at {decision}")
        raw_exit = five_minute_opens[decision]
        primary_cut = simulate_long_cut(
            raw_entry_price=float(item["primary"]["rawFillPrice"]),
            raw_exit_price=raw_exit,
            fill_time=int(item["primary"]["fillTime"]),
            exit_time=decision,
            funding=funding,
            funding_price_by_time=five_minute_opens,
            fee_bps=4,
            slippage_bps=2,
        )
        stress_cut = simulate_long_cut(
            raw_entry_price=float(item["stress"]["rawFillPrice"]),
            raw_exit_price=raw_exit,
            fill_time=int(item["stress"]["fillTime"]),
            exit_time=decision,
            funding=funding,
            funding_price_by_time=five_minute_opens,
            fee_bps=6,
            slippage_bps=5,
        )
        quantity = SETUP_QUANTITY[item["setup"]]
        hold_primary = float(item["primary"]["netPnl"]) * quantity
        hold_stress = float(item["stress"]["netPnl"]) * quantity
        cut_primary = primary_cut["netPnl"] * quantity
        cut_stress = stress_cut["netPnl"] * quantity
        rows.append(
            {
                "sourceKey": _source_key(item),
                "setup": item["setup"],
                "signalTime": item["signalTime"],
                "decisionTime": decision,
                "checkpointHours": int((decision - item["primary"]["fillTime"]) / HOUR_MS),
                "quantityBtc": quantity,
                "baselineRiskScore": scores["baseline"],
                "dvolRiskScore": scores["augmented"],
                "priceAction": "CUT" if scores["baseline"] >= oracle["baselineQ75"] else "HOLD",
                "dvolAction": "CUT" if scores["augmented"] >= oracle["augmentedQ75"] else "HOLD",
                "cutBetter": cut_primary > hold_primary,
                "cutAdvantagePrimaryDollars": cut_primary - hold_primary,
                "hold_primary_dollars": hold_primary,
                "cut_primary_dollars": cut_primary,
                "hold_stress_dollars": hold_stress,
                "cut_stress_dollars": cut_stress,
                "cutPrimary": primary_cut,
                "cutStress": stress_cut,
            }
        )

    labels = np.asarray([int(row["cutBetter"]) for row in rows])
    class_counts = {"cutBetter": int(np.sum(labels == 1)), "holdBetter": int(np.sum(labels == 0))}
    sufficient = (
        len(rows) >= MIN_OOS_EPISODES
        and min(class_counts.values(), default=0) >= MIN_CLASS_COUNT
        and setup_population_present
    )
    if sufficient:
        baseline_scores = np.asarray([row["baselineRiskScore"] for row in rows])
        augmented_scores = np.asarray([row["dvolRiskScore"] for row in rows])
        baseline_auc = binary_auc(labels, baseline_scores)
        augmented_auc = binary_auc(labels, augmented_scores)
        decision_times = pd.to_datetime(
            [row["decisionTime"] for row in rows], unit="ms", utc=True
        )
        auc_bootstrap = auc_gain_month_bootstrap(
            decision_times, labels, baseline_scores, augmented_scores
        )
    else:
        baseline_auc = None
        augmented_auc = None
        auc_bootstrap = None

    policies = {
        policy: _policy_summary(rows, policy) for policy in ("HOLD", "PRICE_Q75", "DVOL_Q75")
    }
    dvol_vs_hold = _delta_analysis(rows, "DVOL_Q75", "HOLD", "primary")
    dvol_vs_price = _delta_analysis(rows, "DVOL_Q75", "PRICE_Q75", "primary")
    dvol_vs_hold_stress = _delta_analysis(rows, "DVOL_Q75", "HOLD", "stress")
    dvol_vs_price_stress = _delta_analysis(rows, "DVOL_Q75", "PRICE_Q75", "stress")
    robustness = _robustness(rows, dvol_vs_hold["perEpisode"])

    gates = {
        "sample": sufficient,
        "augmentedAucAtLeast060": bool(sufficient and augmented_auc >= MIN_AUGMENTED_AUC),
        "aucGainAtLeast005": bool(
            sufficient and augmented_auc - baseline_auc >= MIN_AUC_GAIN
        ),
        "aucGainCi90AboveZero": bool(
            sufficient and auc_bootstrap["ci90Low"] > 0
        ),
        "primaryDeltaVsHoldCi90AboveZero": dvol_vs_hold["bootstrap"]["ci90Low"] > 0,
        "primaryDeltaVsPriceCi90AboveZero": dvol_vs_price["bootstrap"]["ci90Low"] > 0,
        "stressDeltaVsHoldPositive": dvol_vs_hold_stress["totalDollars"] > 0,
        "stressDeltaVsPricePositive": dvol_vs_price_stress["totalDollars"] > 0,
        "dropBestEpisodePositive": robustness["dropBestEpisodeDollars"] > 0,
        "removeBestMonthPositive": robustness["removeBestMonthDollars"] > 0,
        "bothSetupsNonNegative": all(
            value >= 0 for value in robustness["bySetupDollars"].values()
        ) and setup_population_present,
        "bothSetupsPresent": setup_population_present,
        "entryPopulationUnchanged": len(portfolio["acceptedKeys"]) == EXPECTED_ACCEPTED_BASELINE,
    }
    if not sufficient:
        verdict = "INSUFFICIENT_SAMPLE"
    elif all(gates.values()):
        verdict = "PASS_TO_H05_GATE2"
    else:
        verdict = "KILL_NO_H05_HOLD_CUT_EDGE"

    def clean_delta(value: dict) -> dict:
        return {key: item for key, item in value.items() if key != "perEpisode"}

    repo = Path(__file__).resolve().parents[1]
    git_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    dirty = bool(
        subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    )
    return {
        "study": "BTC H05 DVOL HOLD/CUT Gate-1",
        "generatedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "verdict": verdict,
        "contract": {
            "asset": "BTCUSDT perpetual futures",
            "setups": ["S13", "S14"],
            "entryPolicy": "unchanged faithful H01 baseline A portfolio acceptance",
            "decision": "first losing closed-4h checkpoint at +4h or +8h; maximum one per trade",
            "oosStartUtc": utc_iso(OOS_START_MS),
            "riskModel": "Gate-0 downside_semivol_3d OLS; fit/scaling frozen on purged IS",
            "policy": "CUT when model score >= its own Gate-0 IS 75th percentile; otherwise HOLD",
            "episodeClassifierFit": False,
            "parameterSearch": False,
            "dcaReverseEvaluated": False,
            "gateCriteria": {
                "minEpisodes": MIN_OOS_EPISODES,
                "minEachClass": MIN_CLASS_COUNT,
                "minAugmentedAuc": MIN_AUGMENTED_AUC,
                "minAucGain": MIN_AUC_GAIN,
                "aucGainCi90Low": ">0",
                "primaryDeltasVsHoldAndPriceCi90Low": ">0",
                "stressDeltasVsHoldAndPrice": ">0",
                "dropBestEpisodeAndRemoveBestMonth": ">0",
                "bothSetups": ">=0",
                "bothSetupsPresent": True,
            },
        },
        "population": {
            "sourceSignals": len(episodes),
            "acceptedBaselineEntries": len(portfolio["acceptedKeys"]),
            "blockedBaselineEntries": len(portfolio["blocked"]),
            "maxOpenQuantity": portfolio["maxOpenQuantity"],
            "oosLosingEpisodes": len(rows),
            "classCounts": class_counts,
            "setupCounts": candidate_setup_counts,
            "checkpoints": {
                str(hours): int(sum(row["checkpointHours"] == hours for row in rows))
                for hours in CHECKPOINT_HOURS
            },
        },
        "riskOracle": {
            "isRows": oracle["isRows"],
            "isLastDecisionUtc": utc_iso(oracle["isLastDecision"]),
            "riskQuantile": RISK_QUANTILE,
            "baselineQ75": oracle["baselineQ75"],
            "augmentedQ75": oracle["augmentedQ75"],
            "baselineConditionNumber": oracle["baselineConditionNumber"],
            "augmentedConditionNumber": oracle["augmentedConditionNumber"],
            "baselineAuc": baseline_auc,
            "augmentedAuc": augmented_auc,
            "aucGain": None if not sufficient else augmented_auc - baseline_auc,
            "aucGainBootstrap": auc_bootstrap,
        },
        "policies": policies,
        "deltas": {
            "dvolVsHoldPrimary": clean_delta(dvol_vs_hold),
            "dvolVsPricePrimary": clean_delta(dvol_vs_price),
            "dvolVsHoldStress": clean_delta(dvol_vs_hold_stress),
            "dvolVsPriceStress": clean_delta(dvol_vs_price_stress),
        },
        "robustness": robustness,
        "gates": gates,
        "episodes": rows,
        "provenance": {
            "gitCommit": git_commit,
            "dirty": dirty,
            "sourcePath": str(source_path.resolve()),
            "sourceSha256": sha256_file(source_path),
            "sourceParentRowsSha256": source["parentRowsSha256"],
            "sourceParentWorktreeCommit": source["parentWorktreeCommit"],
            "serverHedge01ModuleSha256": source["serverHedge01ModuleSha256"],
            "spot5mSha256": sha256_file(spot_5m_path),
            "dvolSha256": sha256_file(dvol_cache_path),
            "futures1hSha256": sha256_file(futures_1h_path),
            "futures5mSha256": sha256_file(futures_5m_path),
            "fundingSha256": sha256_file(funding_path),
            "evaluatorSha256": sha256_file(Path(__file__).resolve()),
            "gate0DependencySha256": sha256_file(Path(__file__).with_name("dvol_gate0.py")),
            "bootstrapIterations": BOOTSTRAP_ITERATIONS,
            "bootstrapSeed": BOOTSTRAP_SEED,
        },
    }


def render_markdown(result: dict) -> str:
    risk = result["riskOracle"]
    lines = [
        "# BTC H05 DVOL HOLD/CUT Gate-1",
        "",
        f"- Verdict: **{result['verdict']}**",
        f"- Generated: `{result['generatedAtUtc']}`",
        "- Scope: research only; entries unchanged; no DCA, reverse, live arming, or deploy.",
        f"- OOS losing episodes: `{result['population']['oosLosingEpisodes']}`; classes: `{result['population']['classCounts']}`.",
        "",
        "## Risk Ranking",
        "",
        f"- Price-only AUC: `{risk['baselineAuc']}`",
        f"- Price + DVOL AUC: `{risk['augmentedAuc']}`",
        f"- Incremental AUC: `{risk['aucGain']}`",
        f"- AUC gain bootstrap: `{risk['aucGainBootstrap']}`",
        "",
        "## Policy Economics",
        "",
        "| Policy | CUT | HOLD | Primary net $ | Stress net $ | Win rate |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for policy in ("HOLD", "PRICE_Q75", "DVOL_Q75"):
        item = result["policies"][policy]
        lines.append(
            f"| `{policy}` | {item['cuts']} | {item['holds']} | "
            f"{item['primaryNetDollars']:.2f} | {item['stressNetDollars']:.2f} | "
            f"{item['primaryWinRate']:.2%} |"
        )
    lines.extend(["", "## Deltas", ""])
    for name, item in result["deltas"].items():
        lines.append(
            f"- `{name}`: total `${item['totalDollars']:.2f}`, "
            f"CI90 mean `[{item['bootstrap']['ci90Low']:.4f}, {item['bootstrap']['ci90High']:.4f}]`, "
            f"p=`{item['bootstrap']['pOneSided']:.4f}`."
        )
    lines.extend(["", "## Gates", ""])
    for name, passed in result["gates"].items():
        lines.append(f"- `{name}`: **{'PASS' if passed else 'FAIL'}**")
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "Only `PASS_TO_H05_GATE2` permits designing a bounded live-compatible HOLD/CUT state machine. Any other verdict forbids using DVOL for H05 actions. Gate-1 never authorizes DCA or reversal.",
            "",
            "## Provenance",
            "",
            f"- Git commit: `{result['provenance']['gitCommit']}`; dirty=`{str(result['provenance']['dirty']).lower()}`.",
            f"- Source SHA-256: `{result['provenance']['sourceSha256']}`",
            f"- Evaluator SHA-256: `{result['provenance']['evaluatorSha256']}`",
            f"- Gate-0 dependency SHA-256: `{result['provenance']['gate0DependencySha256']}`",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-source-from", type=Path)
    parser.add_argument(
        "--source",
        type=Path,
        default=repo / "docs" / "research" / "dvol-h05-gate1-source-2026-07-12.json",
    )
    parser.add_argument("--spot-5m", type=Path, default=repo / ".cache" / "binance-5m-7y.json")
    parser.add_argument(
        "--dvol-cache", type=Path, default=repo / ".cache" / "deribit-btc-dvol-1h.json"
    )
    parser.add_argument(
        "--futures-1h",
        type=Path,
        default=repo / ".cache" / "binance-futures-btcusdt-1h-7y.json",
    )
    parser.add_argument(
        "--futures-5m",
        type=Path,
        default=repo / ".cache" / "binance-futures-btcusdt-5m-run3.json",
    )
    parser.add_argument(
        "--funding",
        type=Path,
        default=repo / ".cache" / "binance-futures-btcusdt-funding-7y.json",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        default=repo / "docs" / "research" / "dvol-h05-gate1-2026-07-12.json",
    )
    parser.add_argument(
        "--markdown-output",
        type=Path,
        default=repo / "docs" / "dvol-h05-gate1-2026-07-12.md",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.prepare_source_from:
        compact = extract_compact_source(args.prepare_source_from)
        if compact["parentRowsSha256"] != EXPECTED_PARENT_ROWS_SHA256:
            raise ValueError("parent policy row-set hash mismatch")
        if compact["rowCount"] != EXPECTED_SOURCE_ROWS:
            raise ValueError("parent source row count mismatch")
        args.source.parent.mkdir(parents=True, exist_ok=True)
        args.source.write_text(json.dumps(compact, indent=2, sort_keys=True) + "\n")
        print(json.dumps({"source": str(args.source), "rows": compact["rowCount"]}, indent=2))
        return

    result = evaluate_gate1(
        source_path=args.source,
        spot_5m_path=args.spot_5m,
        dvol_cache_path=args.dvol_cache,
        futures_1h_path=args.futures_1h,
        futures_5m_path=args.futures_5m,
        funding_path=args.funding,
    )
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    args.markdown_output.write_text(render_markdown(result))
    print(
        json.dumps(
            {
                "verdict": result["verdict"],
                "population": result["population"],
                "riskOracle": result["riskOracle"],
                "policies": result["policies"],
                "deltas": result["deltas"],
                "gates": result["gates"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
