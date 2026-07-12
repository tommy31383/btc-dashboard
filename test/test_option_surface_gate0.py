import math
import sys
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

from option_surface_gate0 import (  # noqa: E402
    DAY_MS,
    absolute_black_scholes_delta,
    active_catalog_at,
    build_decision_requests,
    evaluate_gate,
    has_delta_bracket,
    nearest_target_expiry,
    summarize_trade_proxy,
)


def instrument(name, *, creation, expiry, strike=100.0, option_type="call"):
    return {
        "instrument_name": name,
        "creation_timestamp": creation,
        "expiration_timestamp": expiry,
        "strike": strike,
        "option_type": option_type,
        "kind": "option",
        "base_currency": "BTC",
    }


def trade(name, *, timestamp, spot=100.0, iv=50.0):
    return {
        "instrument_name": name,
        "timestamp": timestamp,
        "index_price": spot,
        "iv": iv,
        "mark_price": 0.01,
    }


class DecisionPopulationTests(unittest.TestCase):
    def test_groups_duplicate_setup_episodes_into_one_market_snapshot(self):
        requests = build_decision_requests(
            [
                {"setup": "S13", "decisionTime": 1_000},
                {"setup": "S14", "decisionTime": 1_000},
                {"setup": "S13", "decisionTime": 2_000},
            ]
        )

        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["setups"], ["S13", "S14"])
        self.assertEqual(requests[0]["episodeCount"], 2)
        self.assertEqual(requests[1]["episodeCount"], 1)


class CatalogTests(unittest.TestCase):
    def test_active_catalog_uses_creation_and_expiry_without_future_leakage(self):
        decision = 10_000
        catalog = [
            instrument("ACTIVE", creation=1_000, expiry=20_000),
            instrument("FUTURE", creation=10_001, expiry=20_000),
            instrument("EXPIRED", creation=1_000, expiry=10_000),
        ]

        active = active_catalog_at(catalog, decision)

        self.assertEqual([item["instrument_name"] for item in active], ["ACTIVE"])

    def test_nearest_target_expiry_is_selected_from_active_catalog_only(self):
        decision = 1_000_000
        catalog = [
            instrument("EIGHT_DAY", creation=0, expiry=decision + 8 * DAY_MS),
            instrument("TWELVE_DAY", creation=0, expiry=decision + 12 * DAY_MS),
            instrument("SEVEN_DAY_FUTURE", creation=decision + 1, expiry=decision + 7 * DAY_MS),
        ]

        selected = nearest_target_expiry(catalog, decision, target_days=7)

        self.assertEqual(selected, decision + 8 * DAY_MS)


class SurfaceTests(unittest.TestCase):
    def test_black_scholes_delta_is_deterministic_for_call_and_put(self):
        call = absolute_black_scholes_delta(
            spot=100.0,
            strike=100.0,
            years_to_expiry=1.0,
            iv_percent=20.0,
            option_type="call",
        )
        put = absolute_black_scholes_delta(
            spot=100.0,
            strike=100.0,
            years_to_expiry=1.0,
            iv_percent=20.0,
            option_type="put",
        )

        self.assertAlmostEqual(call, 0.5398278373, places=9)
        self.assertAlmostEqual(put, 0.4601721627, places=9)
        self.assertTrue(math.isclose(call + put, 1.0))

    def test_delta_bracket_requires_distinct_instruments_on_both_sides(self):
        self.assertFalse(has_delta_bracket([{"instrument": "A", "delta": 0.20}]))
        self.assertFalse(
            has_delta_bracket(
                [
                    {"instrument": "A", "delta": 0.20},
                    {"instrument": "B", "delta": 0.24},
                ]
            )
        )
        self.assertFalse(
            has_delta_bracket(
                [
                    {"instrument": "A", "delta": 0.20},
                    {"instrument": "A", "delta": 0.30},
                ]
            )
        )
        self.assertTrue(
            has_delta_bracket(
                [
                    {"instrument": "A", "delta": 0.20},
                    {"instrument": "B", "delta": 0.30},
                ]
            )
        )

    def test_trade_proxy_rejects_future_stale_and_temporally_invalid_prints(self):
        decision = 10_000
        catalog = [
            instrument("VALID", creation=1_000, expiry=20_000),
            instrument("NOT_YET_CREATED", creation=9_800, expiry=20_000),
        ]
        trades = [
            trade("VALID", timestamp=9_500),
            trade("VALID", timestamp=10_001),
            trade("VALID", timestamp=8_999),
            trade("NOT_YET_CREATED", timestamp=9_700),
            trade("UNKNOWN", timestamp=9_600),
        ]

        summary = summarize_trade_proxy(
            decision_time=decision,
            trades=trades,
            catalog=catalog,
            lookback_ms=1_000,
        )

        self.assertEqual(summary["acceptedTradeCount"], 1)
        self.assertEqual(summary["futureTradeCount"], 1)
        self.assertEqual(summary["staleTradeCount"], 1)
        self.assertEqual(summary["catalogTemporalViolationCount"], 1)
        self.assertEqual(summary["unknownInstrumentCount"], 1)
        self.assertFalse(summary["causalWindowClean"])


class GateTests(unittest.TestCase):
    def test_trade_print_proxy_cannot_substitute_for_historical_snapshots(self):
        summaries = [
            {
                "episodeCount": 1,
                "setups": ["S13", "S14"],
                "causalWindowClean": True,
                "proxySurfaceReady": True,
                "snapshotSurfaceReady": False,
            }
            for _ in range(10)
        ]

        result = evaluate_gate(
            summaries,
            catalog_discoverable=True,
            snapshot_endpoint_available=False,
        )

        self.assertEqual(result["proxyCoverageUnique"], 1.0)
        self.assertEqual(result["snapshotCoverageUnique"], 0.0)
        self.assertFalse(result["gates"]["historicalSnapshotEndpoint"])
        self.assertEqual(result["verdict"], "KILL_PUBLIC_HISTORY_INSUFFICIENT")

    def test_pass_requires_90_percent_unique_and_episode_snapshot_coverage(self):
        summaries = []
        for index in range(10):
            ready = index < 9
            summaries.append(
                {
                    "episodeCount": 2 if index == 9 else 1,
                    "setups": ["S13", "S14"],
                    "causalWindowClean": True,
                    "proxySurfaceReady": ready,
                    "snapshotSurfaceReady": ready,
                }
            )

        result = evaluate_gate(
            summaries,
            catalog_discoverable=True,
            snapshot_endpoint_available=True,
        )

        self.assertEqual(result["snapshotCoverageUnique"], 0.9)
        self.assertLess(result["snapshotCoverageEpisodes"], 0.9)
        self.assertFalse(result["gates"]["episodeSnapshotCoverageAtLeast90pct"])
        self.assertEqual(result["verdict"], "KILL_PUBLIC_HISTORY_INSUFFICIENT")


if __name__ == "__main__":
    unittest.main()
