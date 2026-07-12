import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

from dvol_h05_gate1 import (  # noqa: E402
    binary_auc,
    extract_compact_source,
    first_losing_checkpoint,
    month_block_bootstrap,
    project_baseline_acceptance,
    required_setups_present,
    simulate_long_cut,
)


HOUR_MS = 60 * 60 * 1000


def child(fill_time, exit_time, raw_fill=100.0):
    return {
        "fillTime": fill_time,
        "rawFillPrice": raw_fill,
        "fillPrice": raw_fill * 1.0002,
        "exitTime": exit_time,
        "exitPrice": raw_fill * 1.01,
        "grossPnl": 1.0,
        "fundingPnl": 0.0,
        "fees": 0.08,
        "netPnl": 0.92,
        "grossEntryNotional": raw_fill * 1.0002,
    }


def episode(setup, signal_time, exit_time):
    primary = child(signal_time, exit_time)
    stress = child(signal_time, exit_time)
    return {
        "setup": setup,
        "signalTime": signal_time,
        "split": "discovery",
        "atr": 10.0,
        "primary": primary,
        "stress": stress,
    }


class SourceTests(unittest.TestCase):
    def test_extracts_only_base_a_children_into_compact_source(self):
        row = {
            "setup": "S13",
            "signalTime": 123,
            "split": "validation",
            "atr": 42.0,
            "scenarios": {
                "primaryLowHigh": {"methods": {"A": {"initialChild": child(123, 456)}}},
                "stressLowHigh": {"methods": {"A": {"initialChild": child(123, 456)}}},
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rows.jsonl"
            source.write_text(
                json.dumps({"recordType": "x", "variant": "diagnostic", "rows": []})
                + "\n"
                + json.dumps({"recordType": "x", "variant": "base", "rows": [row]})
                + "\n"
            )

            compact = extract_compact_source(source)

        self.assertEqual(compact["rowCount"], 1)
        self.assertEqual(compact["episodes"][0]["setup"], "S13")
        self.assertEqual(compact["episodes"][0]["primary"]["fillTime"], 123)
        self.assertNotIn("scenarios", compact["episodes"][0])


class PortfolioTests(unittest.TestCase):
    def test_close_is_processed_before_same_time_entry_for_capacity(self):
        episodes = []
        for index in range(6):
            exit_time = 24 * HOUR_MS if index == 0 else 100 * HOUR_MS
            episodes.append(episode("S13", index * 4 * HOUR_MS, exit_time))
        episodes.append(episode("S13", 24 * HOUR_MS, 100 * HOUR_MS))

        projection = project_baseline_acceptance(episodes)

        self.assertEqual(len(projection["acceptedKeys"]), 7)
        self.assertEqual(projection["blocked"], [])
        self.assertLessEqual(projection["maxOpenQuantity"], 0.02)


class DecisionTests(unittest.TestCase):
    def test_uses_first_losing_closed_4h_checkpoint_and_ignores_future(self):
        trade = episode("S13", 0, 20 * HOUR_MS)
        hours = {
            3 * HOUR_MS: {"time": 3 * HOUR_MS, "close": 99.0},
            7 * HOUR_MS: {"time": 7 * HOUR_MS, "close": 50.0},
        }

        decision = first_losing_checkpoint(trade, hours)
        hours[7 * HOUR_MS]["close"] = 500.0
        mutated = first_losing_checkpoint(trade, hours)

        self.assertEqual(decision, 4 * HOUR_MS)
        self.assertEqual(mutated, decision)

    def test_falls_through_to_8h_and_never_decides_after_exit(self):
        trade = episode("S14", 0, 20 * HOUR_MS)
        hours = {
            3 * HOUR_MS: {"time": 3 * HOUR_MS, "close": 101.0},
            7 * HOUR_MS: {"time": 7 * HOUR_MS, "close": 99.0},
        }
        self.assertEqual(first_losing_checkpoint(trade, hours), 8 * HOUR_MS)

        trade["primary"]["exitTime"] = 8 * HOUR_MS
        self.assertIsNone(first_losing_checkpoint(trade, hours))


class AccountingTests(unittest.TestCase):
    def test_cut_applies_adverse_slippage_fees_and_long_funding(self):
        result = simulate_long_cut(
            raw_entry_price=100.0,
            raw_exit_price=90.0,
            fill_time=0,
            exit_time=8 * HOUR_MS,
            funding=[{"time": 8 * HOUR_MS, "rate": 0.001, "mark": 95.0}],
            funding_price_by_time={},
            fee_bps=4,
            slippage_bps=2,
        )

        entry = 100.0 * 1.0002
        exit_price = 90.0 * 0.9998
        expected_funding = -95.0 * 0.001
        expected_fees = (entry + exit_price) * 0.0004
        expected_net = exit_price - entry + expected_funding - expected_fees
        self.assertAlmostEqual(result["fillPrice"], entry)
        self.assertAlmostEqual(result["exitPrice"], exit_price)
        self.assertAlmostEqual(result["fundingPnl"], expected_funding)
        self.assertAlmostEqual(result["fees"], expected_fees)
        self.assertAlmostEqual(result["netPnl"], expected_net)


class StatisticsTests(unittest.TestCase):
    def test_both_policy_setups_must_have_real_episodes(self):
        self.assertFalse(required_setups_present([{"setup": "S13"}]))
        self.assertFalse(required_setups_present([{"setup": "S14"}]))
        self.assertTrue(required_setups_present([{"setup": "S13"}, {"setup": "S14"}]))

    def test_binary_auc_matches_known_ranking(self):
        labels = np.array([0, 0, 1, 1])
        perfect = np.array([0.1, 0.2, 0.8, 0.9])
        reversed_scores = perfect[::-1]

        self.assertEqual(binary_auc(labels, perfect), 1.0)
        self.assertEqual(binary_auc(labels, reversed_scores), 0.0)

    def test_month_block_bootstrap_is_deterministic(self):
        times = pd.to_datetime(
            ["2024-01-01", "2024-01-02", "2024-02-01", "2024-02-02"], utc=True
        )
        values = np.array([1.0, 1.0, 2.0, 2.0])

        first = month_block_bootstrap(times, values, iterations=1_000, seed=20260712)
        second = month_block_bootstrap(times, values, iterations=1_000, seed=20260712)

        self.assertEqual(first, second)
        self.assertGreater(first["ci90Low"], 0)
        self.assertLessEqual(first["pOneSided"], 0.002)


if __name__ == "__main__":
    unittest.main()
