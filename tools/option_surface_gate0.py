#!/usr/bin/env python3
"""Gate-0 feasibility audit for causal BTC option-direction surfaces.

This tool does not test trading outcomes. It checks whether Deribit's public
history can reconstruct a real option surface at the frozen H01 decision times.
Trade-triggered mark/IV fields are measured as a diagnostic proxy but are never
promoted to historical quote or mark snapshots.
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
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable


DAY_MS = 24 * 60 * 60 * 1000
LOOKBACK_MS = 15 * 60 * 1000
HISTORY_API = "https://history.deribit.com/api/v2/public"
MAIN_API = "https://www.deribit.com/api/v2/public"
TARGET_TENORS = (7, 30)
MAX_TENOR_GAP_DAYS = {7: 4.0, 30: 10.0}
MIN_SNAPSHOT_COVERAGE = 0.90
DELTA_TARGET = 0.25
ATM_DELTA_TOLERANCE = 0.15
HTTP_RETRIES = 3
HTTP_TIMEOUT_SECONDS = 90
MAX_WORKERS = 4


def build_ssl_context() -> ssl.SSLContext:
    """Build a verified CA context even when python.org's CA link is absent."""
    try:
        import certifi
    except ImportError as error:
        raise RuntimeError(
            "Python CA roots are unavailable; install certifi rather than disabling TLS"
        ) from error
    return ssl.create_default_context(cafile=certifi.where())


HTTP_SSL_CONTEXT = build_ssl_context()


def utc_iso(timestamp_ms: int) -> str:
    return dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def build_decision_requests(episodes: Iterable[dict]) -> list[dict]:
    grouped: dict[int, dict] = {}
    for episode in episodes:
        decision_time = episode.get("decisionTime")
        setup = episode.get("setup")
        if not isinstance(decision_time, int) or decision_time <= 0:
            raise ValueError("episode has invalid decisionTime")
        if setup not in {"S13", "S14"}:
            raise ValueError(f"episode has unsupported setup {setup}")
        request = grouped.setdefault(
            decision_time,
            {"decisionTime": decision_time, "setups": set(), "episodeCount": 0},
        )
        request["setups"].add(setup)
        request["episodeCount"] += 1

    results = []
    for decision_time in sorted(grouped):
        request = grouped[decision_time]
        results.append(
            {
                "decisionTime": decision_time,
                "decisionTimeUtc": utc_iso(decision_time),
                "setups": sorted(request["setups"]),
                "episodeCount": request["episodeCount"],
            }
        )
    return results


def _is_btc_option(item: dict) -> bool:
    return (
        item.get("kind") == "option"
        and item.get("base_currency") == "BTC"
        and isinstance(item.get("instrument_name"), str)
    )


def active_catalog_at(catalog: Iterable[dict], decision_time: int) -> list[dict]:
    active = []
    for item in catalog:
        if not _is_btc_option(item):
            continue
        creation = item.get("creation_timestamp")
        expiry = item.get("expiration_timestamp")
        if not isinstance(creation, int) or not isinstance(expiry, int):
            continue
        if creation <= decision_time < expiry:
            active.append(item)
    return sorted(active, key=lambda item: item["instrument_name"])


def nearest_target_expiry(
    catalog: Iterable[dict], decision_time: int, *, target_days: int
) -> int | None:
    expiries = {
        int(item["expiration_timestamp"])
        for item in active_catalog_at(catalog, decision_time)
    }
    if not expiries:
        return None
    target = decision_time + target_days * DAY_MS
    return min(expiries, key=lambda expiry: (abs(expiry - target), expiry))


def absolute_black_scholes_delta(
    *,
    spot: float,
    strike: float,
    years_to_expiry: float,
    iv_percent: float,
    option_type: str,
) -> float:
    values = (spot, strike, years_to_expiry, iv_percent)
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
        raise ValueError("delta inputs must be finite")
    if spot <= 0 or strike <= 0 or years_to_expiry <= 0 or iv_percent <= 0:
        raise ValueError("delta inputs must be positive")
    if option_type not in {"call", "put"}:
        raise ValueError(f"unsupported option type {option_type}")

    sigma = iv_percent / 100
    root_time = math.sqrt(years_to_expiry)
    d1 = (math.log(spot / strike) + 0.5 * sigma * sigma * years_to_expiry) / (
        sigma * root_time
    )
    call_delta = 0.5 * (1 + math.erf(d1 / math.sqrt(2)))
    return call_delta if option_type == "call" else 1 - call_delta


def has_delta_bracket(points: Iterable[dict], *, target: float = DELTA_TARGET) -> bool:
    valid = []
    for point in points:
        instrument_name = point.get("instrument")
        delta = point.get("delta")
        if (
            isinstance(instrument_name, str)
            and isinstance(delta, (int, float))
            and math.isfinite(delta)
            and 0 <= delta <= 1
        ):
            valid.append((instrument_name, float(delta)))
    for left_index, (left_name, left_delta) in enumerate(valid):
        for right_name, right_delta in valid[left_index + 1 :]:
            if left_name == right_name:
                continue
            if min(left_delta, right_delta) <= target <= max(left_delta, right_delta):
                return True
    return False


def _partition_trades(
    *, decision_time: int, trades: Iterable[dict], catalog: Iterable[dict], lookback_ms: int
) -> tuple[list[tuple[dict, dict]], dict]:
    catalog_by_name = {
        item["instrument_name"]: item for item in catalog if _is_btc_option(item)
    }
    accepted: list[tuple[dict, dict]] = []
    counts = {
        "futureTradeCount": 0,
        "staleTradeCount": 0,
        "catalogTemporalViolationCount": 0,
        "unknownInstrumentCount": 0,
        "invalidTradeCount": 0,
    }
    for trade in trades:
        timestamp = trade.get("timestamp")
        instrument_name = trade.get("instrument_name")
        if not isinstance(timestamp, int) or not isinstance(instrument_name, str):
            counts["invalidTradeCount"] += 1
            continue
        if timestamp > decision_time:
            counts["futureTradeCount"] += 1
            continue
        if timestamp < decision_time - lookback_ms:
            counts["staleTradeCount"] += 1
            continue
        metadata = catalog_by_name.get(instrument_name)
        if metadata is None:
            counts["unknownInstrumentCount"] += 1
            continue
        creation = metadata.get("creation_timestamp")
        expiry = metadata.get("expiration_timestamp")
        if (
            not isinstance(creation, int)
            or not isinstance(expiry, int)
            or creation > timestamp
            or timestamp >= expiry
            or decision_time >= expiry
        ):
            counts["catalogTemporalViolationCount"] += 1
            continue
        accepted.append((trade, metadata))
    return accepted, counts


def summarize_trade_proxy(
    *, decision_time: int, trades: Iterable[dict], catalog: Iterable[dict], lookback_ms: int
) -> dict:
    trade_list = list(trades)
    catalog_list = list(catalog)
    accepted, counts = _partition_trades(
        decision_time=decision_time,
        trades=trade_list,
        catalog=catalog_list,
        lookback_ms=lookback_ms,
    )
    active = active_catalog_at(catalog_list, decision_time)
    accepted_names = {trade["instrument_name"] for trade, _ in accepted}
    causal_clean = all(count == 0 for count in counts.values())
    return {
        "rawTradeCount": len(trade_list),
        "acceptedTradeCount": len(accepted),
        "acceptedInstrumentCount": len(accepted_names),
        "activeInstrumentCount": len(active),
        "activeInstrumentTradeCoverage": (
            len(accepted_names) / len(active) if active else 0.0
        ),
        **counts,
        "causalWindowClean": causal_clean,
    }


def _latest_points_by_instrument(
    accepted: Iterable[tuple[dict, dict]], decision_time: int
) -> dict[str, dict]:
    latest: dict[str, tuple[dict, dict]] = {}
    for trade, metadata in accepted:
        name = trade["instrument_name"]
        prior = latest.get(name)
        if prior is None or trade["timestamp"] > prior[0]["timestamp"]:
            latest[name] = (trade, metadata)

    points = {}
    for name, (trade, metadata) in latest.items():
        try:
            delta = absolute_black_scholes_delta(
                spot=float(trade["index_price"]),
                strike=float(metadata["strike"]),
                years_to_expiry=(metadata["expiration_timestamp"] - trade["timestamp"])
                / (365.25 * DAY_MS),
                iv_percent=float(trade["iv"]),
                option_type=metadata["option_type"],
            )
        except (KeyError, TypeError, ValueError):
            continue
        points[name] = {
            "instrument": name,
            "timestamp": trade["timestamp"],
            "ageSeconds": (decision_time - trade["timestamp"]) / 1000,
            "expiry": metadata["expiration_timestamp"],
            "strike": metadata["strike"],
            "optionType": metadata["option_type"],
            "iv": trade["iv"],
            "indexPrice": trade["index_price"],
            "delta": delta,
        }
    return points


def _tenor_summary(
    *, target_days: int, decision_time: int, catalog: list[dict], points: dict[str, dict]
) -> dict:
    expiry = nearest_target_expiry(catalog, decision_time, target_days=target_days)
    if expiry is None:
        return {
            "targetDays": target_days,
            "expiry": None,
            "tenorGapDays": None,
            "callCount": 0,
            "putCount": 0,
            "call25Bracket": False,
            "put25Bracket": False,
            "atmReady": False,
            "targetExpiryUsable": False,
        }
    expiry_points = [point for point in points.values() if point["expiry"] == expiry]
    calls = [point for point in expiry_points if point["optionType"] == "call"]
    puts = [point for point in expiry_points if point["optionType"] == "put"]
    tenor_days = (expiry - decision_time) / DAY_MS
    gap = abs(tenor_days - target_days)
    call_atm = min((abs(point["delta"] - 0.5) for point in calls), default=math.inf)
    put_atm = min((abs(point["delta"] - 0.5) for point in puts), default=math.inf)
    return {
        "targetDays": target_days,
        "expiry": expiry,
        "expiryUtc": utc_iso(expiry),
        "actualTenorDays": tenor_days,
        "tenorGapDays": gap,
        "callCount": len(calls),
        "putCount": len(puts),
        "call25Bracket": has_delta_bracket(calls),
        "put25Bracket": has_delta_bracket(puts),
        "nearestCallAtmDeltaDistance": None if math.isinf(call_atm) else call_atm,
        "nearestPutAtmDeltaDistance": None if math.isinf(put_atm) else put_atm,
        "atmReady": call_atm <= ATM_DELTA_TOLERANCE and put_atm <= ATM_DELTA_TOLERANCE,
        "targetExpiryUsable": gap <= MAX_TENOR_GAP_DAYS[target_days],
    }


def analyze_decision(
    *, request: dict, trades: list[dict], catalog: list[dict]
) -> tuple[dict, list[dict]]:
    decision_time = request["decisionTime"]
    base = summarize_trade_proxy(
        decision_time=decision_time,
        trades=trades,
        catalog=catalog,
        lookback_ms=LOOKBACK_MS,
    )
    accepted, _ = _partition_trades(
        decision_time=decision_time,
        trades=trades,
        catalog=catalog,
        lookback_ms=LOOKBACK_MS,
    )
    points = _latest_points_by_instrument(accepted, decision_time)
    tenors = {
        str(target): _tenor_summary(
            target_days=target,
            decision_time=decision_time,
            catalog=catalog,
            points=points,
        )
        for target in TARGET_TENORS
    }
    short = tenors["7"]
    monthly = tenors["30"]
    rr25_ready = (
        monthly["targetExpiryUsable"]
        and monthly["call25Bracket"]
        and monthly["put25Bracket"]
    )
    term_ready = (
        short["targetExpiryUsable"]
        and monthly["targetExpiryUsable"]
        and short["atmReady"]
        and monthly["atmReady"]
    )
    proxy_ready = rr25_ready and term_ready
    summary = {
        **request,
        **base,
        "validDeltaPointCount": len(points),
        "tenors": tenors,
        "rr25ReadyByTradeProxy": rr25_ready,
        "termStructureReadyByTradeProxy": term_ready,
        "proxySurfaceReady": proxy_ready,
        "snapshotSurfaceReady": False,
        "sourceModality": "TRADE_TRIGGERED_MARKS_ONLY",
    }
    compact_trades = []
    for trade, metadata in accepted:
        compact_trades.append(
            {
                "instrumentName": trade["instrument_name"],
                "timestamp": trade["timestamp"],
                "markPrice": trade.get("mark_price"),
                "iv": trade.get("iv"),
                "indexPrice": trade.get("index_price"),
                "price": trade.get("price"),
                "amount": trade.get("amount"),
                "direction": trade.get("direction"),
                "expirationTimestamp": metadata["expiration_timestamp"],
                "creationTimestamp": metadata["creation_timestamp"],
                "strike": metadata["strike"],
                "optionType": metadata["option_type"],
            }
        )
    compact_trades.sort(key=lambda row: (row["timestamp"], row["instrumentName"]))
    return summary, compact_trades


def evaluate_gate(
    summaries: list[dict], *, catalog_discoverable: bool, snapshot_endpoint_available: bool
) -> dict:
    if not summaries:
        raise ValueError("decision summaries are empty")
    total_unique = len(summaries)
    total_episodes = sum(int(item["episodeCount"]) for item in summaries)

    def coverage(field: str) -> tuple[float, float]:
        ready = [item for item in summaries if item.get(field) is True]
        unique_ratio = len(ready) / total_unique
        episode_ratio = sum(int(item["episodeCount"]) for item in ready) / total_episodes
        return unique_ratio, episode_ratio

    proxy_unique, proxy_episodes = coverage("proxySurfaceReady")
    snapshot_unique, snapshot_episodes = coverage("snapshotSurfaceReady")
    covered_setups = {
        setup
        for item in summaries
        if item.get("snapshotSurfaceReady") is True
        for setup in item.get("setups", [])
    }
    gates = {
        "catalogDiscoverable": catalog_discoverable,
        "historicalSnapshotEndpoint": snapshot_endpoint_available,
        "causalWindowsClean": all(item.get("causalWindowClean") is True for item in summaries),
        "uniqueSnapshotCoverageAtLeast90pct": snapshot_unique >= MIN_SNAPSHOT_COVERAGE,
        "episodeSnapshotCoverageAtLeast90pct": snapshot_episodes >= MIN_SNAPSHOT_COVERAGE,
        "bothSetupsSnapshotCovered": {"S13", "S14"}.issubset(covered_setups),
    }
    verdict = (
        "PASS_PUBLIC_SURFACE_FEASIBLE"
        if all(gates.values())
        else "KILL_PUBLIC_HISTORY_INSUFFICIENT"
    )
    return {
        "verdict": verdict,
        "gates": gates,
        "uniqueDecisionCount": total_unique,
        "episodeCount": total_episodes,
        "proxyCoverageUnique": proxy_unique,
        "proxyCoverageEpisodes": proxy_episodes,
        "snapshotCoverageUnique": snapshot_unique,
        "snapshotCoverageEpisodes": snapshot_episodes,
    }


def _request_json(
    base_url: str, method: str, params: dict, *, allow_error: bool = False
) -> dict:
    query = urllib.parse.urlencode(params)
    url = f"{base_url}/{method}?{query}"
    last_error: Exception | None = None
    for attempt in range(HTTP_RETRIES):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "BTC-PC-option-surface-gate0/1.0"},
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=HTTP_TIMEOUT_SECONDS,
                context=HTTP_SSL_CONTEXT,
            ) as response:
                raw = response.read()
                parsed = json.loads(raw)
                if parsed.get("error"):
                    if allow_error:
                        return {
                            "available": False,
                            "status": response.status,
                            "url": url,
                            "error": parsed["error"],
                        }
                    raise RuntimeError(f"Deribit API error: {parsed['error']}")
                return {
                    "available": True,
                    "status": response.status,
                    "url": url,
                    "result": parsed.get("result"),
                    "rawSha256": hashlib.sha256(raw).hexdigest(),
                }
        except urllib.error.HTTPError as error:
            body = error.read().decode(errors="replace")[:500]
            if allow_error:
                return {
                    "available": False,
                    "status": error.code,
                    "url": url,
                    "error": body,
                }
            last_error = RuntimeError(f"HTTP {error.code} from {url}: {body}")
        except (OSError, TimeoutError, json.JSONDecodeError, RuntimeError) as error:
            last_error = error
        if attempt + 1 < HTTP_RETRIES:
            time.sleep(2**attempt)
    raise RuntimeError(f"Deribit request failed after retries: {last_error}")


def fetch_catalog() -> tuple[list[dict], dict]:
    responses = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            pool.submit(
                _request_json,
                HISTORY_API,
                "get_instruments",
                {"currency": "BTC", "kind": "option", "expired": value},
            ): value
            for value in ("true", "false")
        }
        for future in as_completed(futures):
            responses[futures[future]] = future.result()

    merged = {}
    for expired in ("true", "false"):
        result = responses[expired].get("result")
        if not isinstance(result, list):
            raise ValueError("historical catalog response is not a list")
        for item in result:
            if not _is_btc_option(item):
                continue
            name = item["instrument_name"]
            prior = merged.get(name)
            if prior is not None and prior != item:
                raise ValueError(f"conflicting catalog metadata for {name}")
            merged[name] = item
    catalog = [merged[name] for name in sorted(merged)]
    metadata = {
        "expiredCount": len(responses["true"]["result"]),
        "currentCount": len(responses["false"]["result"]),
        "mergedCount": len(catalog),
        "expiredRawSha256": responses["true"]["rawSha256"],
        "currentRawSha256": responses["false"]["rawSha256"],
        "canonicalSha256": canonical_sha256(catalog),
        "endpoints": [responses["true"]["url"], responses["false"]["url"]],
    }
    return catalog, metadata


def fetch_trade_window(decision_time: int) -> tuple[list[dict], dict]:
    cursor = decision_time - LOOKBACK_MS
    end_time = decision_time
    trades = []
    pages = 0
    urls = []
    raw_hashes = []
    while cursor <= end_time:
        response = _request_json(
            HISTORY_API,
            "get_last_trades_by_currency_and_time",
            {
                "currency": "BTC",
                "kind": "option",
                "start_timestamp": cursor,
                "end_timestamp": end_time,
                "count": 1000,
                "sorting": "asc",
            },
        )
        result = response.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("trades"), list):
            raise ValueError("historical trade response has invalid shape")
        page = result["trades"]
        trades.extend(page)
        pages += 1
        urls.append(response["url"])
        raw_hashes.append(response["rawSha256"])
        if not result.get("has_more"):
            break
        if not page:
            raise ValueError("trade history has_more without rows")
        next_cursor = max(int(item["timestamp"]) for item in page) + 1
        if next_cursor <= cursor:
            raise ValueError("trade history pagination did not advance")
        cursor = next_cursor
    trades.sort(key=lambda item: (item.get("timestamp", -1), item.get("trade_id", "")))
    return trades, {
        "pages": pages,
        "rawTradeCount": len(trades),
        "rawPageSha256": raw_hashes,
        "urls": urls,
    }


def probe_snapshot_endpoints(sample_trade: dict, decision_time: int) -> dict:
    instrument_name = sample_trade["instrument_name"]
    params = {
        "instrument_name": instrument_name,
        "start_timestamp": decision_time - LOOKBACK_MS,
        "end_timestamp": decision_time,
    }
    history = _request_json(
        HISTORY_API, "get_mark_price_history", params, allow_error=True
    )
    main = _request_json(MAIN_API, "get_mark_price_history", params, allow_error=True)

    def compact(response: dict) -> dict:
        result = response.get("result")
        usable = response.get("available") is True and isinstance(result, list) and bool(result)
        return {
            "usableHistoricalRows": usable,
            "status": response.get("status"),
            "url": response.get("url"),
            "error": response.get("error"),
            "rowCount": len(result) if isinstance(result, list) else 0,
        }

    return {"historyHost": compact(history), "mainHost": compact(main)}


def _git_provenance(repo: Path) -> dict:
    commit = subprocess.run(
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
    return {"gitCommit": commit, "dirty": dirty}


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def _render_report(result: dict) -> str:
    population = result["population"]
    coverage = result["coverage"]
    lines = [
        "# BTC Option Direction Surface Gate-0",
        "",
        f"- Verdict: **{result['verdict']}**",
        f"- Generated: `{result['generatedAtUtc']}`",
        "- Scope: BTC option data feasibility only; no outcome fit, rule change, live arming, or deploy.",
        f"- Population: `{population['episodes']}` H01 episodes at `{population['uniqueDecisionTimes']}` unique timestamps.",
        "",
        "## Public Data Finding",
        "",
        "- The official historical host exposes the archived instrument catalog and option trades.",
        "- Each trade carries a trade-triggered mark price and IV, but this is not a synchronized chain snapshot.",
        "- Historical mark/quote snapshots were unavailable on both the history and main public endpoints for archived instruments.",
        "- Therefore the public route cannot produce a defensible 25-delta skew, 7d/30d term surface, or downside-demand change at every H01 decision.",
        "",
        "## Coverage",
        "",
        f"- Trade-proxy surface, unique timestamps: `{coverage['proxyUnique']:.2%}`.",
        f"- Trade-proxy surface, episode weighted: `{coverage['proxyEpisodes']:.2%}`.",
        f"- True snapshot surface, unique timestamps: `{coverage['snapshotUnique']:.2%}`.",
        f"- True snapshot surface, episode weighted: `{coverage['snapshotEpisodes']:.2%}`.",
        f"- Median active-chain trade coverage in 15 minutes: `{coverage['medianActiveInstrumentTradeCoverage']:.2%}`.",
        "",
        "## Gates",
        "",
    ]
    for name, passed in result["gates"].items():
        lines.append(f"- `{name}`: **{'PASS' if passed else 'FAIL'}**")
    lines.extend(
        [
            "",
            "## Decision",
            "",
            "`KILL_PUBLIC_HISTORY_INSUFFICIENT` kills only the free/public historical-surface route. It does not claim that option skew has no predictive value. A future test requires a timestamped quote/mark archive, such as the historical options-chain data Deribit documents through its Tardis partnership, followed by a new preregistered Gate-0.",
            "",
            "Trade prints remain tagged `TRADE_TRIGGERED_MARKS_ONLY`; they cannot independently authorize research acceptance or live behavior.",
            "",
            "## Provenance",
            "",
            f"- Git commit: `{result['provenance']['gitCommit']}`; dirty=`{str(result['provenance']['dirty']).lower()}`.",
            f"- Evaluator SHA-256: `{result['provenance']['evaluatorSha256']}`.",
            f"- H01 episode source SHA-256: `{result['provenance']['episodeSourceSha256']}`.",
            f"- Canonical historical catalog SHA-256: `{result['provenance']['catalogCanonicalSha256']}`.",
            f"- Raw trade source SHA-256: `{result['provenance']['tradeSourceSha256']}`.",
            "",
        ]
    )
    return "\n".join(lines)


def run(args: argparse.Namespace) -> dict:
    episode_payload = json.loads(args.episodes.read_text())
    episodes = episode_payload.get("episodes")
    if not isinstance(episodes, list):
        raise ValueError("H01 episode source is missing episodes")
    requests = build_decision_requests(episodes)
    catalog, catalog_metadata = fetch_catalog()

    trades_by_time = {}
    fetch_metadata = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {
            pool.submit(fetch_trade_window, request["decisionTime"]): request["decisionTime"]
            for request in requests
        }
        for future in as_completed(futures):
            decision_time = futures[future]
            trades, metadata = future.result()
            trades_by_time[decision_time] = trades
            fetch_metadata[decision_time] = metadata

    sample_request = next(
        request for request in requests if trades_by_time[request["decisionTime"]]
    )
    sample_trade = trades_by_time[sample_request["decisionTime"]][0]
    probes = probe_snapshot_endpoints(sample_trade, sample_request["decisionTime"])
    snapshot_available = any(
        probe["usableHistoricalRows"] for probe in probes.values()
    )

    summaries = []
    source_decisions = []
    relevant_catalog_names = set()
    for request in requests:
        decision_time = request["decisionTime"]
        summary, compact_trades = analyze_decision(
            request=request,
            trades=trades_by_time[decision_time],
            catalog=catalog,
        )
        summaries.append(summary)
        relevant_catalog_names.update(
            item["instrument_name"] for item in active_catalog_at(catalog, decision_time)
        )
        source_decisions.append(
            {
                **request,
                "fetch": fetch_metadata[decision_time],
                "trades": compact_trades,
            }
        )

    relevant_catalog = [
        item for item in catalog if item["instrument_name"] in relevant_catalog_names
    ]
    trade_source = {
        "schemaVersion": 1,
        "kind": "DERIBIT_PUBLIC_TRADE_TRIGGERED_MARKS",
        "fetchedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "lookbackMs": LOOKBACK_MS,
        "catalog": {
            "metadata": catalog_metadata,
            "relevantInstrumentCount": len(relevant_catalog),
            "relevantCanonicalSha256": canonical_sha256(relevant_catalog),
        },
        "decisions": source_decisions,
        "snapshotEndpointProbes": probes,
    }
    _write_json(args.source_output, trade_source)

    gate = evaluate_gate(
        summaries,
        catalog_discoverable=bool(catalog),
        snapshot_endpoint_available=snapshot_available,
    )
    coverages = sorted(
        item["activeInstrumentTradeCoverage"] for item in summaries
    )
    median_coverage = (
        coverages[len(coverages) // 2]
        if len(coverages) % 2
        else (coverages[len(coverages) // 2 - 1] + coverages[len(coverages) // 2]) / 2
    )
    repo = Path(__file__).resolve().parents[1]
    result = {
        "study": "BTC_OPTION_DIRECTION_SURFACE_GATE0",
        "generatedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "verdict": gate["verdict"],
        "contract": {
            "asset": "BTC options on Deribit",
            "decisionPopulation": "frozen H01 S13/S14 losing checkpoints from DVOL Gate-1",
            "lookbackMinutes": LOOKBACK_MS // 60_000,
            "candidateFeatures": [
                "25-delta risk reversal",
                "7d versus 30d IV term structure",
                "downside insurance demand/change",
            ],
            "requiredDataModality": "timestamped quote or mark snapshot",
            "tradeTriggeredMarksAcceptedAsSnapshot": False,
            "minimumUniqueCoverage": MIN_SNAPSHOT_COVERAGE,
            "minimumEpisodeCoverage": MIN_SNAPSHOT_COVERAGE,
            "outcomesEvaluated": False,
        },
        "population": {
            "episodes": len(episodes),
            "uniqueDecisionTimes": len(requests),
            "setups": sorted({episode["setup"] for episode in episodes}),
            "firstDecisionUtc": requests[0]["decisionTimeUtc"],
            "lastDecisionUtc": requests[-1]["decisionTimeUtc"],
        },
        "endpoints": {
            "historyApi": HISTORY_API,
            "mainApi": MAIN_API,
            "catalog": catalog_metadata,
            "snapshotProbes": probes,
            "sourceModality": "TRADE_TRIGGERED_MARKS_ONLY",
        },
        "coverage": {
            "proxyUnique": gate["proxyCoverageUnique"],
            "proxyEpisodes": gate["proxyCoverageEpisodes"],
            "snapshotUnique": gate["snapshotCoverageUnique"],
            "snapshotEpisodes": gate["snapshotCoverageEpisodes"],
            "medianActiveInstrumentTradeCoverage": median_coverage,
        },
        "gates": gate["gates"],
        "decisionSummaries": summaries,
        "nextRoute": "PAID_TIMESTAMPED_QUOTE_OR_MARK_ARCHIVE_REQUIRED",
        "provenance": {
            **_git_provenance(repo),
            "evaluatorPath": str(Path(__file__).resolve()),
            "evaluatorSha256": sha256_file(Path(__file__)),
            "episodeSourcePath": str(args.episodes.resolve()),
            "episodeSourceSha256": sha256_file(args.episodes),
            "catalogCanonicalSha256": catalog_metadata["canonicalSha256"],
            "tradeSourcePath": str(args.source_output.resolve()),
            "tradeSourceSha256": sha256_file(args.source_output),
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
        "--episodes",
        type=Path,
        default=repo / "docs/research/dvol-h05-gate1-2026-07-12.json",
    )
    parser.add_argument(
        "--source-output",
        type=Path,
        default=repo / "docs/research/option-surface-gate0-source-2026-07-12.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repo / "docs/research/option-surface-gate0-2026-07-12.json",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=repo / "docs/option-surface-gate0-2026-07-12.md",
    )
    return parser.parse_args()


if __name__ == "__main__":
    outcome = run(parse_args())
    print(json.dumps({"verdict": outcome["verdict"], "coverage": outcome["coverage"]}))
