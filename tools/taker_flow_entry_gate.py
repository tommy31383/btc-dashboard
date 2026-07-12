#!/usr/bin/env python3
"""Causal BTC H01 entry-timing gate using real Binance taker-buy volume."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import ssl
import subprocess
import time
import urllib.error
import urllib.request
import zipfile
from bisect import bisect_right
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable

import numpy as np
from scipy.stats import rankdata

from dvol_h05_gate1 import project_baseline_acceptance


FIVE_MINUTES_MS = 5 * 60 * 1000
HOUR_MS = 60 * 60 * 1000
OOS_START_MS = 1_704_067_200_000
HIGH_FLOW_RANK = 0.75
MIN_DATA_COVERAGE = 0.90
BOOTSTRAP_ITERATIONS = 5_000
BOOTSTRAP_SEED = 20_260_712
REFERENCE_HOURS = 120
ARCHIVE_START_MS = 1_577_836_800_000
ARCHIVE_BASE_URL = (
    "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/5m"
)
ARCHIVE_FIRST_MONTH = "2020-01"
ARCHIVE_LAST_MONTH = "2025-10"
EXPECTED_SOURCE_SHA256 = (
    "30e3cd347ba78287240427f08da65fe08b90c29e3d35755d33d5fda90d3c79a0"
)
EXPECTED_EPISODES = 95
EXPECTED_EVENTS = 61
EXPECTED_COVERED_EPISODES = 90
EXPECTED_COVERED_EVENTS = 57
HTTP_RETRIES = 3
HTTP_TIMEOUT_SECONDS = 90
DOWNLOAD_WORKERS = 6


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def build_ssl_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError as error:
        raise RuntimeError(
            "certifi is required; TLS verification must not be disabled"
        ) from error
    return ssl.create_default_context(cafile=certifi.where())


HTTP_SSL_CONTEXT = build_ssl_context()


def month_range(start: str, end: str) -> list[str]:
    try:
        start_date = dt.datetime.strptime(start, "%Y-%m")
        end_date = dt.datetime.strptime(end, "%Y-%m")
    except ValueError as error:
        raise ValueError("months must use YYYY-MM") from error
    if start_date > end_date:
        raise ValueError("start month must not exceed end month")
    months = []
    current = start_date
    while current <= end_date:
        months.append(current.strftime("%Y-%m"))
        current = (
            current.replace(year=current.year + 1, month=1)
            if current.month == 12
            else current.replace(month=current.month + 1)
        )
    return months


def _merged_intervals(intervals: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    merged = []
    for start, end in sorted(intervals):
        if start > end:
            raise ValueError("research interval start exceeds end")
        if merged and start <= merged[-1][1] + FIVE_MINUTES_MS:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def build_research_intervals(
    events: Iterable[dict], *, archive_start_ms: int
) -> list[tuple[int, int]]:
    return _merged_intervals(
        (
            int(event["signalTime"]) - (REFERENCE_HOURS + 1) * HOUR_MS,
            int(event["signalTime"]) + 4 * HOUR_MS - FIVE_MINUTES_MS,
        )
        for event in events
        if int(event["signalTime"]) >= archive_start_ms
    )


def parse_month_zip(
    path: Path, *, intervals: Iterable[tuple[int, int]]
) -> tuple[list[dict], dict]:
    windows = _merged_intervals(intervals)
    starts = [start for start, _ in windows]
    with zipfile.ZipFile(path) as archive:
        members = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if len(members) != 1:
            raise ValueError("monthly archive must contain exactly one CSV")
        with archive.open(members[0]) as handle:
            text = io.TextIOWrapper(handle, encoding="utf-8").read()
    rows = parse_kline_csv(text)
    kept = []
    seen = set()
    duplicates = 0
    for bar in rows:
        timestamp = bar["time"]
        if timestamp in seen:
            duplicates += 1
        seen.add(timestamp)
        index = bisect_right(starts, timestamp) - 1
        if index >= 0 and timestamp <= windows[index][1]:
            kept.append(bar)
    return kept, {
        "rowCount": len(rows),
        "keptRowCount": len(kept),
        "firstOpenTime": rows[0]["time"] if rows else None,
        "lastOpenTime": rows[-1]["time"] if rows else None,
        "duplicateTimestampCount": duplicates,
        "csvMember": members[0],
    }


def parse_official_checksum(text: str, expected_filename: str) -> str:
    parts = text.strip().split()
    if len(parts) != 2 or parts[1].lstrip("*") != expected_filename:
        raise ValueError("official checksum filename mismatch")
    digest = parts[0].lower()
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError("official checksum digest is invalid")
    return digest


def parse_kline_csv(text: str) -> list[dict]:
    bars = []
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        if row[0].strip().lower() in {"open_time", "open time"}:
            continue
        if len(row) < 11:
            raise ValueError("Binance kline row has fewer than 11 columns")
        try:
            bar = {
                "time": int(row[0]),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
                "closeTime": int(row[6]),
                "trades": int(row[8]),
                "takerBuyBase": float(row[9]),
                "takerBuyQuote": float(row[10]),
            }
        except (TypeError, ValueError) as error:
            raise ValueError("Binance kline row has invalid values") from error
        numeric = (
            bar["open"],
            bar["high"],
            bar["low"],
            bar["close"],
            bar["volume"],
            bar["takerBuyBase"],
            bar["takerBuyQuote"],
        )
        if any(not math.isfinite(value) for value in numeric):
            raise ValueError("Binance kline row has non-finite values")
        if (
            bar["time"] < 0
            or bar["closeTime"] < bar["time"]
            or min(bar["open"], bar["high"], bar["low"], bar["close"]) <= 0
            or bar["volume"] < 0
            or bar["takerBuyBase"] < 0
            or bar["takerBuyBase"] > bar["volume"] + 1e-9
        ):
            raise ValueError("Binance kline row violates value bounds")
        bars.append(bar)
    return bars


def aggregate_hour(bars: Iterable[dict], *, end_time: int) -> dict:
    rows = sorted(bars, key=lambda item: item["time"])
    expected_times = [
        end_time - HOUR_MS + step * FIVE_MINUTES_MS for step in range(12)
    ]
    if [row.get("time") for row in rows] != expected_times:
        raise ValueError(f"hour ending {end_time} does not contain 12 exact 5m bars")
    if any(row.get("closeTime") >= end_time for row in rows):
        raise ValueError("hour contains a bar not closed before its boundary")
    volume = sum(float(row["volume"]) for row in rows)
    taker_buy = sum(float(row["takerBuyBase"]) for row in rows)
    trades = sum(int(row["trades"]) for row in rows)
    if volume < 0 or taker_buy < 0 or taker_buy > volume + 1e-9:
        raise ValueError("hour has invalid taker volume")
    zero_volume = volume == 0
    if zero_volume and (taker_buy != 0 or trades != 0):
        raise ValueError("zero-volume hour has non-zero taker activity")
    return {
        "endTime": end_time,
        "barCount": len(rows),
        "trades": trades,
        "volume": volume,
        "takerBuyBase": taker_buy,
        "takerImbalance": 0.0 if zero_volume else (2 * taker_buy - volume) / volume,
        "zeroVolume": zero_volume,
        "open": float(rows[0]["open"]),
        "close": float(rows[-1]["close"]),
        "maxCloseTime": max(int(row["closeTime"]) for row in rows),
    }


def midrank_percentile(current: float, reference: Iterable[float]) -> float:
    values = [float(value) for value in reference]
    if not values or not math.isfinite(current) or any(
        not math.isfinite(value) for value in values
    ):
        raise ValueError("rank inputs must be finite and non-empty")
    less = sum(value < current for value in values)
    equal = sum(value == current for value in values)
    return (less + 0.5 * equal) / len(values)


def group_market_events(episodes: Iterable[dict], accepted_keys: set[str]) -> list[dict]:
    grouped: dict[int, dict] = {}
    for episode in episodes:
        setup = episode.get("setup")
        signal_time = episode.get("signalTime")
        key = f"{setup}|{signal_time}"
        if setup not in {"S13", "S14"} or key not in accepted_keys:
            continue
        primary = episode.get("primary")
        raw_fill = primary.get("rawFillPrice") if isinstance(primary, dict) else None
        atr = episode.get("atr")
        if (
            not isinstance(signal_time, int)
            or not isinstance(raw_fill, (int, float))
            or not isinstance(atr, (int, float))
            or raw_fill <= 0
            or atr <= 0
        ):
            raise ValueError(f"invalid accepted H01 source {key}")
        event = grouped.setdefault(
            signal_time,
            {
                "signalTime": signal_time,
                "setups": set(),
                "episodeCount": 0,
                "rawFillPrice": float(raw_fill),
                "atr": float(atr),
                "sourceKeys": [],
            },
        )
        if not math.isclose(event["rawFillPrice"], float(raw_fill), rel_tol=1e-12):
            raise ValueError("same-time H01 entries disagree on raw fill")
        if not math.isclose(event["atr"], float(atr), rel_tol=1e-12):
            raise ValueError("same-time H01 entries disagree on ATR")
        event["setups"].add(setup)
        event["episodeCount"] += 1
        event["sourceKeys"].append(key)

    results = []
    for signal_time in sorted(grouped):
        event = grouped[signal_time]
        results.append(
            {
                **event,
                "signalTimeUtc": dt.datetime.fromtimestamp(
                    signal_time / 1000, tz=dt.timezone.utc
                ).isoformat(),
                "setups": sorted(event["setups"]),
                "sourceKeys": sorted(event["sourceKeys"]),
            }
        )
    return results


def _hour_from_map(bars_by_open: dict[int, dict], end_time: int) -> dict:
    rows = [
        bars_by_open.get(end_time - HOUR_MS + step * FIVE_MINUTES_MS)
        for step in range(12)
    ]
    if any(row is None for row in rows):
        raise ValueError(f"missing 5m bar for hour ending {end_time}")
    return aggregate_hour(rows, end_time=end_time)


def build_event_observation(event: dict, bars_by_open: dict[int, dict]) -> dict:
    signal_time = int(event["signalTime"])
    current = _hour_from_map(bars_by_open, signal_time)
    if current["zeroVolume"]:
        raise ValueError("current feature hour has zero volume")
    references = [
        _hour_from_map(bars_by_open, signal_time - offset * HOUR_MS)
        for offset in range(1, REFERENCE_HOURS + 1)
    ]
    flow_rank = midrank_percentile(
        current["takerImbalance"],
        [hour["takerImbalance"] for hour in references],
    )
    immediate = bars_by_open.get(signal_time)
    delayed = bars_by_open.get(signal_time + HOUR_MS)
    if immediate is None or delayed is None:
        raise ValueError("missing immediate or one-hour delayed fill bar")
    immediate_open = float(immediate["open"])
    delayed_open = float(delayed["open"])
    if immediate_open <= 0 or delayed_open <= 0:
        raise ValueError("entry prices must be positive")
    future_1h = [
        bars_by_open.get(signal_time + step * FIVE_MINUTES_MS) for step in range(12)
    ]
    future_4h = [
        bars_by_open.get(signal_time + step * FIVE_MINUTES_MS) for step in range(48)
    ]
    if any(row is None for row in future_1h) or any(row is None for row in future_4h):
        raise ValueError("future diagnostic window is incomplete")
    atr = float(event["atr"])
    min_low_1h = min(float(row["low"]) for row in future_1h)
    close_4h = float(future_4h[-1]["close"])
    feature_max_close = max(
        [current["maxCloseTime"]]
        + [hour["maxCloseTime"] for hour in references]
    )
    if feature_max_close >= signal_time:
        raise ValueError("feature window includes a future bar")
    return {
        **event,
        "split": "OOS" if signal_time >= OOS_START_MS else "IS",
        "flowImbalance1h": current["takerImbalance"],
        "flowRank1h": flow_rank,
        "zeroVolumeReferenceHours": sum(hour["zeroVolume"] for hour in references),
        "featureMaxCloseTime": feature_max_close,
        "immediateOpen": immediate_open,
        "delayedOpen": delayed_open,
        "entryPriceMatchesSource": math.isclose(
            immediate_open,
            float(event["rawFillPrice"]),
            rel_tol=1e-8,
            abs_tol=1e-8,
        ),
        "delayAdvantageBps": 10_000
        * (immediate_open - delayed_open)
        / immediate_open,
        "mae1hAtr": max(0.0, (immediate_open - min_low_1h) / atr),
        "forward4hBps": 10_000 * (close_4h - immediate_open) / immediate_open,
    }


def spearman_rho(x: Iterable[float], y: Iterable[float]) -> float:
    left = np.asarray(list(x), dtype=float)
    right = np.asarray(list(y), dtype=float)
    if len(left) != len(right) or len(left) < 2:
        raise ValueError("Spearman inputs must have equal length >=2")
    if not np.isfinite(left).all() or not np.isfinite(right).all():
        raise ValueError("Spearman inputs must be finite")
    left_rank = rankdata(left, method="average")
    right_rank = rankdata(right, method="average")
    if np.std(left_rank) == 0 or np.std(right_rank) == 0:
        raise ValueError("Spearman inputs must not be constant")
    rho = float(np.corrcoef(left_rank, right_rank)[0, 1])
    if abs(rho - 1) < 1e-12:
        return 1.0
    if abs(rho + 1) < 1e-12:
        return -1.0
    return rho


def _month_key(timestamp_ms: int) -> str:
    return dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc).strftime(
        "%Y-%m"
    )


def month_block_bootstrap_rho(
    times: Iterable[int],
    x: Iterable[float],
    y: Iterable[float],
    *,
    iterations: int,
    seed: int,
) -> dict:
    timestamps = list(times)
    left = list(x)
    right = list(y)
    if not (len(timestamps) == len(left) == len(right)) or len(left) < 2:
        raise ValueError("bootstrap inputs have invalid lengths")
    groups: dict[str, list[int]] = defaultdict(list)
    for index, timestamp in enumerate(timestamps):
        groups[_month_key(timestamp)].append(index)
    months = sorted(groups)
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(iterations):
        sampled_months = rng.choice(months, size=len(months), replace=True)
        indices = [index for month in sampled_months for index in groups[str(month)]]
        try:
            values.append(
                spearman_rho(
                    [left[index] for index in indices],
                    [right[index] for index in indices],
                )
            )
        except ValueError:
            continue
    if not values:
        raise ValueError("bootstrap produced no valid correlations")
    array = np.asarray(values)
    return {
        "months": len(months),
        "iterations": iterations,
        "validIterations": len(values),
        "ci90Low": float(np.quantile(array, 0.05)),
        "ci90High": float(np.quantile(array, 0.95)),
        "pOneSided": float((np.sum(array <= 0) + 1) / (len(array) + 1)),
    }


def evaluate_data_gate(
    *,
    total_episodes: int,
    covered_episodes: int,
    total_events: int,
    covered_events: int,
    all_months_verified: bool,
    all_windows_complete: bool,
    all_entry_prices_match: bool,
    no_duplicate_timestamps: bool,
) -> dict:
    episode_coverage = covered_episodes / total_episodes if total_episodes else 0.0
    event_coverage = covered_events / total_events if total_events else 0.0
    gates = {
        "allMonthsChecksumVerified": all_months_verified,
        "episodeCoverageAtLeast90pct": episode_coverage >= MIN_DATA_COVERAGE,
        "eventCoverageAtLeast90pct": event_coverage >= MIN_DATA_COVERAGE,
        "allCoveredWindowsComplete": all_windows_complete,
        "allCoveredEntryPricesMatch": all_entry_prices_match,
        "noDuplicateTimestamps": no_duplicate_timestamps,
    }
    return {
        "verdict": (
            "PASS_TAKER_FLOW_DATA_GATE0"
            if all(gates.values())
            else "KILL_TAKER_FLOW_DATA_INSUFFICIENT"
        ),
        "gates": gates,
        "episodeCoverage": episode_coverage,
        "eventCoverage": event_coverage,
    }


def _mean(values: list[float]) -> float:
    return float(np.mean(values)) if values else math.nan


def evaluate_association_gate(
    observations: list[dict],
    *,
    bootstrap_iterations: int = BOOTSTRAP_ITERATIONS,
    bootstrap_seed: int = BOOTSTRAP_SEED,
) -> dict:
    in_sample = [item for item in observations if item["signalTime"] < OOS_START_MS]
    oos = [item for item in observations if item["signalTime"] >= OOS_START_MS]
    is_rho = spearman_rho(
        [item["flowRank1h"] for item in in_sample],
        [item["delayAdvantageBps"] for item in in_sample],
    )
    oos_rho = spearman_rho(
        [item["flowRank1h"] for item in oos],
        [item["delayAdvantageBps"] for item in oos],
    )
    bootstrap = month_block_bootstrap_rho(
        [item["signalTime"] for item in oos],
        [item["flowRank1h"] for item in oos],
        [item["delayAdvantageBps"] for item in oos],
        iterations=bootstrap_iterations,
        seed=bootstrap_seed,
    )
    high_flow = [item for item in oos if item["flowRank1h"] >= HIGH_FLOW_RANK]
    high_values = [float(item["delayAdvantageBps"]) for item in high_flow]
    high_median = float(np.median(high_values)) if high_values else math.nan
    best_index = max(range(len(high_values)), key=high_values.__getitem__) if high_values else None
    drop_best_values = [
        value for index, value in enumerate(high_values) if index != best_index
    ]
    drop_best_mean = _mean(drop_best_values)
    by_month: dict[str, list[float]] = defaultdict(list)
    for item in high_flow:
        by_month[_month_key(item["signalTime"])].append(
            float(item["delayAdvantageBps"])
        )
    best_month = (
        max(by_month, key=lambda month: sum(by_month[month])) if by_month else None
    )
    remove_month_values = [
        value
        for month, values in by_month.items()
        if month != best_month
        for value in values
    ]
    remove_best_month_mean = _mean(remove_month_values)
    setup_means = {
        setup: _mean(
            [
                float(item["delayAdvantageBps"])
                for item in high_flow
                if setup in item.get("setups", [])
            ]
        )
        for setup in ("S13", "S14")
    }
    gates = {
        "isSampleAtLeast30": len(in_sample) >= 30,
        "oosSampleAtLeast20": len(oos) >= 20,
        "isRhoPositive": is_rho > 0,
        "oosRhoAtLeast020": oos_rho >= 0.20,
        "oosRhoCi90AboveZero": bootstrap["ci90Low"] > 0,
        "oosHighFlowMedianPositive": high_median > 0,
        "dropBestHighFlowEventMeanPositive": drop_best_mean > 0,
        "removeBestHighFlowMonthMeanPositive": remove_best_month_mean > 0,
        "bothSetupsHighFlowNonNegative": all(
            math.isfinite(value) and value >= 0 for value in setup_means.values()
        ),
    }
    return {
        "verdict": (
            "PASS_TO_TAKER_FLOW_LIFECYCLE_GATE2"
            if all(gates.values())
            else "KILL_NO_TAKER_FLOW_TIMING_EDGE"
        ),
        "gates": gates,
        "is": {"n": len(in_sample), "rho": is_rho},
        "oos": {"n": len(oos), "rho": oos_rho, "bootstrap": bootstrap},
        "highFlow": {
            "threshold": HIGH_FLOW_RANK,
            "n": len(high_flow),
            "meanDelayAdvantageBps": _mean(high_values),
            "medianDelayAdvantageBps": high_median,
            "dropBestEventMeanBps": drop_best_mean,
            "bestMonth": best_month,
            "removeBestMonthMeanBps": remove_best_month_mean,
            "setupMeansBps": setup_means,
        },
    }


def _http_get(url: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(HTTP_RETRIES):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "BTC-PC-true-taker-flow-gate/1.0"},
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=HTTP_TIMEOUT_SECONDS,
                context=HTTP_SSL_CONTEXT,
            ) as response:
                return response.read()
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as error:
            last_error = error
        if attempt + 1 < HTTP_RETRIES:
            time.sleep(2**attempt)
    raise RuntimeError(f"download failed for {url}: {last_error}")


def _download_month(month: str, cache_dir: Path) -> dict:
    filename = f"BTCUSDT-5m-{month}.zip"
    url = f"{ARCHIVE_BASE_URL}/{filename}"
    checksum_url = f"{url}.CHECKSUM"
    checksum_text = _http_get(checksum_url).decode("utf-8")
    official_sha = parse_official_checksum(checksum_text, filename)
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive_path = cache_dir / filename
    downloaded = False
    if not archive_path.exists() or sha256_file(archive_path) != official_sha:
        payload = _http_get(url)
        actual = hashlib.sha256(payload).hexdigest()
        if actual != official_sha:
            raise ValueError(f"downloaded checksum mismatch for {filename}")
        temporary = archive_path.with_suffix(".zip.tmp")
        temporary.write_bytes(payload)
        temporary.replace(archive_path)
        downloaded = True
    local_sha = sha256_file(archive_path)
    if local_sha != official_sha:
        raise ValueError(f"cached checksum mismatch for {filename}")
    (cache_dir / f"{filename}.CHECKSUM").write_text(checksum_text)
    return {
        "month": month,
        "filename": filename,
        "url": url,
        "checksumUrl": checksum_url,
        "officialSha256": official_sha,
        "localSha256": local_sha,
        "bytes": archive_path.stat().st_size,
        "downloadedThisRun": downloaded,
        "cachePath": str(archive_path.resolve()),
    }


def download_archives(cache_dir: Path, *, workers: int = DOWNLOAD_WORKERS) -> list[dict]:
    months = month_range(ARCHIVE_FIRST_MONTH, ARCHIVE_LAST_MONTH)
    manifests = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_download_month, month, cache_dir): month for month in months
        }
        for future in as_completed(futures):
            manifests.append(future.result())
    manifests.sort(key=lambda item: item["month"])
    if [item["month"] for item in manifests] != months:
        raise ValueError("monthly archive manifest is incomplete")
    return manifests


def _load_population(source_path: Path) -> tuple[list[dict], dict]:
    source_sha = sha256_file(source_path)
    if source_sha != EXPECTED_SOURCE_SHA256:
        raise ValueError(f"H01 source hash drift: {source_sha}")
    payload = json.loads(source_path.read_text())
    episodes = payload.get("episodes")
    if not isinstance(episodes, list):
        raise ValueError("H01 source episodes are missing")
    projection = project_baseline_acceptance(episodes)
    accepted_keys = set(projection["acceptedKeys"])
    events = group_market_events(episodes, accepted_keys)
    total_episodes = sum(item["episodeCount"] for item in events)
    if total_episodes != EXPECTED_EPISODES or len(events) != EXPECTED_EVENTS:
        raise ValueError(
            f"H01 population drift: episodes={total_episodes} events={len(events)}"
        )
    covered = [item for item in events if item["signalTime"] >= ARCHIVE_START_MS]
    covered_episodes = sum(item["episodeCount"] for item in covered)
    if (
        covered_episodes != EXPECTED_COVERED_EPISODES
        or len(covered) != EXPECTED_COVERED_EVENTS
    ):
        raise ValueError("archive-covered H01 population drift")
    return events, {
        "sourceRows": len(episodes),
        "acceptedPortfolioEntries": len(accepted_keys),
        "eligibleEpisodes": total_episodes,
        "eligibleEvents": len(events),
        "archiveCoveredEpisodes": covered_episodes,
        "archiveCoveredEvents": len(covered),
        "unavailableEpisodes": total_episodes - covered_episodes,
        "unavailableEvents": len(events) - len(covered),
    }


def _load_relevant_bars(
    manifests: list[dict], intervals: list[tuple[int, int]]
) -> tuple[dict[int, dict], list[dict], int]:
    bars_by_open = {}
    enriched = []
    cross_archive_duplicates = 0
    for manifest in manifests:
        bars, metadata = parse_month_zip(Path(manifest["cachePath"]), intervals=intervals)
        for bar in bars:
            timestamp = bar["time"]
            if timestamp in bars_by_open:
                cross_archive_duplicates += 1
            bars_by_open[timestamp] = bar
        enriched.append({**manifest, **metadata})
    return bars_by_open, enriched, cross_archive_duplicates


def _source_git_provenance(repo: Path, ignored_outputs: Iterable[Path]) -> dict:
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    ignored = set()
    for path in ignored_outputs:
        try:
            ignored.add(str(path.resolve().relative_to(repo.resolve())))
        except ValueError:
            continue
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    unexpected = [
        line
        for line in status.splitlines()
        if len(line) < 4 or line[3:] not in ignored
    ]
    return {
        "gitCommit": commit,
        "dirty": bool(unexpected),
        "unexpectedStatus": unexpected,
        "ignoredGeneratedPaths": sorted(ignored),
    }


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def _safe_rho(observations: list[dict], outcome: str) -> float | None:
    try:
        return spearman_rho(
            [item["flowRank1h"] for item in observations],
            [item[outcome] for item in observations],
        )
    except ValueError:
        return None


def _render_report(result: dict) -> str:
    data = result["dataGate"]
    association = result.get("associationGate")
    lines = [
        "# BTC H01 True Taker-Flow Entry Timing Gate",
        "",
        f"- Verdict: **{result['verdict']}**",
        f"- Generated: `{result['generatedAtUtc']}`",
        "- Scope: BTC H01 S13/S14 entry timing only; every entry retained; no live change or deploy.",
        f"- Population: `{result['population']['eligibleEpisodes']}` episodes at `{result['population']['eligibleEvents']}` unique events.",
        "",
        "## Data Gate-0",
        "",
        f"- Verdict: **{data['verdict']}**",
        f"- Episode coverage: `{data['episodeCoverage']:.2%}`.",
        f"- Unique-event coverage: `{data['eventCoverage']:.2%}`.",
    ]
    for name, passed in data["gates"].items():
        lines.append(f"- `{name}`: **{'PASS' if passed else 'FAIL'}**")
    if association is not None:
        lines.extend(
            [
                "",
                "## Association Gate-1",
                "",
                f"- Verdict: **{association['verdict']}**",
                f"- IS: n=`{association['is']['n']}`, rho=`{association['is']['rho']:.4f}`.",
                f"- OOS: n=`{association['oos']['n']}`, rho=`{association['oos']['rho']:.4f}`.",
                f"- OOS rho CI90: `[{association['oos']['bootstrap']['ci90Low']:.4f}, {association['oos']['bootstrap']['ci90High']:.4f}]`.",
                f"- OOS high-flow: n=`{association['highFlow']['n']}`, median delay advantage=`{association['highFlow']['medianDelayAdvantageBps']:.2f}` bps.",
            ]
        )
        for name, passed in association["gates"].items():
            lines.append(f"- `{name}`: **{'PASS' if passed else 'FAIL'}**")
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            result["interpretation"],
            "",
            "## Provenance",
            "",
            f"- Git commit: `{result['provenance']['gitCommit']}`; dirty=`{str(result['provenance']['dirty']).lower()}`.",
            f"- Evaluator SHA-256: `{result['provenance']['evaluatorSha256']}`.",
            f"- Preregistration SHA-256: `{result['provenance']['preregistrationSha256']}`.",
            f"- H01 source SHA-256: `{result['provenance']['h01SourceSha256']}`.",
            f"- Archive manifest SHA-256: `{result['provenance']['archiveManifestCanonicalSha256']}`.",
            f"- Observation SHA-256: `{result['provenance']['observationsCanonicalSha256']}`.",
            "",
        ]
    )
    return "\n".join(lines)


def run(args: argparse.Namespace) -> dict:
    repo = Path(__file__).resolve().parents[1]
    git_provenance = _source_git_provenance(
        repo,
        (args.source_output, args.output, args.report),
    )
    events, population = _load_population(args.h01_source)
    covered_candidates = [
        item for item in events if item["signalTime"] >= ARCHIVE_START_MS
    ]
    intervals = build_research_intervals(events, archive_start_ms=ARCHIVE_START_MS)
    manifests = download_archives(args.cache_dir, workers=args.download_workers)
    bars_by_open, manifests, cross_duplicates = _load_relevant_bars(
        manifests, intervals
    )

    observations = []
    missing = []
    for event in covered_candidates:
        try:
            observations.append(build_event_observation(event, bars_by_open))
        except ValueError as error:
            missing.append(
                {
                    "signalTime": event["signalTime"],
                    "signalTimeUtc": event["signalTimeUtc"],
                    "episodeCount": event["episodeCount"],
                    "error": str(error),
                }
            )
    observations.sort(key=lambda item: item["signalTime"])
    covered_episodes = sum(item["episodeCount"] for item in observations)
    data_gate = evaluate_data_gate(
        total_episodes=population["eligibleEpisodes"],
        covered_episodes=covered_episodes,
        total_events=population["eligibleEvents"],
        covered_events=len(observations),
        all_months_verified=all(
            item["officialSha256"] == item["localSha256"] for item in manifests
        ),
        all_windows_complete=not missing
        and len(observations) == EXPECTED_COVERED_EVENTS,
        all_entry_prices_match=all(
            item["entryPriceMatchesSource"] for item in observations
        ),
        no_duplicate_timestamps=(
            cross_duplicates == 0
            and all(item["duplicateTimestampCount"] == 0 for item in manifests)
        ),
    )
    association = None
    if data_gate["verdict"] == "PASS_TAKER_FLOW_DATA_GATE0":
        association = evaluate_association_gate(observations)
        verdict = association["verdict"]
    else:
        verdict = data_gate["verdict"]

    stable_manifest = [
        {
            key: item[key]
            for key in (
                "month",
                "filename",
                "url",
                "checksumUrl",
                "officialSha256",
                "localSha256",
                "bytes",
                "rowCount",
                "firstOpenTime",
                "lastOpenTime",
                "duplicateTimestampCount",
            )
        }
        for item in manifests
    ]
    archive_manifest_sha = canonical_sha256(stable_manifest)
    observations_sha = canonical_sha256(observations)
    source_record = {
        "schemaVersion": 1,
        "kind": "BINANCE_USDM_TRUE_TAKER_FLOW_H01_EVENTS",
        "generatedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "contract": {
            "asset": "BTCUSDT USD-M perpetual futures",
            "months": [ARCHIVE_FIRST_MONTH, ARCHIVE_LAST_MONTH],
            "referenceHours": REFERENCE_HOURS,
            "delayHours": 1,
            "futureDataInFeature": False,
            "rawBarsCommitted": False,
        },
        "population": population,
        "archiveManifestCanonicalSha256": archive_manifest_sha,
        "observationsCanonicalSha256": observations_sha,
        "archiveManifest": stable_manifest,
        "missingCoveredEvents": missing,
        "observations": observations,
    }
    _write_json(args.source_output, source_record)

    oos = [item for item in observations if item["signalTime"] >= OOS_START_MS]
    diagnostics = {
        "oosFlowRankVsMae1hAtrRho": _safe_rho(oos, "mae1hAtr"),
        "oosFlowRankVsForward4hRho": _safe_rho(oos, "forward4hBps"),
        "diagnosticsCanRescueGate": False,
    }
    interpretation = (
        "The public archive and causal alignment passed, but real taker flow did not pass the frozen OOS timing gate. Do not delay H01 entries from this feature and do not tune another threshold."
        if verdict == "KILL_NO_TAKER_FLOW_TIMING_EDGE"
        else (
            "The frozen association gate passed. This authorizes only a separate faithful lifecycle comparison of immediate versus one-hour-delayed entry; it does not authorize live behavior."
            if verdict == "PASS_TO_TAKER_FLOW_LIFECYCLE_GATE2"
            else "The historical data contract failed, so no association claim is permitted."
        )
    )
    result = {
        "study": "BTC_H01_TRUE_TAKER_FLOW_ENTRY_TIMING",
        "generatedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "verdict": verdict,
        "population": population,
        "dataGate": data_gate,
        "associationGate": association,
        "diagnostics": diagnostics,
        "interpretation": interpretation,
        "review": {
            "claudeStatus": "UNAVAILABLE_DAILY_QUOTA_EXHAUSTED_2026-07-12",
            "claudeApprovalClaimed": False,
            "liveAuthorization": False,
        },
        "provenance": {
            **git_provenance,
            "evaluatorPath": str(Path(__file__).resolve()),
            "evaluatorSha256": sha256_file(Path(__file__)),
            "preregistrationPath": str(args.preregistration.resolve()),
            "preregistrationSha256": sha256_file(args.preregistration),
            "h01SourcePath": str(args.h01_source.resolve()),
            "h01SourceSha256": sha256_file(args.h01_source),
            "sourceOutputPath": str(args.source_output.resolve()),
            "sourceOutputSha256": sha256_file(args.source_output),
            "archiveManifestCanonicalSha256": archive_manifest_sha,
            "observationsCanonicalSha256": observations_sha,
        },
    }
    _write_json(args.output, result)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(_render_report(result))
    return result


def parse_args() -> argparse.Namespace:
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--h01-source",
        type=Path,
        default=repo / "docs/research/dvol-h05-gate1-source-2026-07-12.json",
    )
    parser.add_argument(
        "--preregistration",
        type=Path,
        default=repo / "docs/prereg-taker-flow-entry-gate-2026-07-12.md",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=repo / ".cache/binance-futures-5m-taker",
    )
    parser.add_argument(
        "--source-output",
        type=Path,
        default=repo / "docs/research/taker-flow-entry-gate-source-2026-07-12.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repo / "docs/research/taker-flow-entry-gate-2026-07-12.json",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=repo / "docs/taker-flow-entry-gate-2026-07-12.md",
    )
    parser.add_argument(
        "--download-workers", type=int, default=DOWNLOAD_WORKERS
    )
    return parser.parse_args()


if __name__ == "__main__":
    result = run(parse_args())
    print(
        json.dumps(
            {
                "verdict": result["verdict"],
                "dataGate": result["dataGate"],
                "associationGate": result["associationGate"],
            }
        )
    )
