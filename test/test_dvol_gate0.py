import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

from dvol_gate0 import (  # noqa: E402
    align_last_closed_dvol,
    build_tls_context,
    build_feature_frame,
    calendar_month_bootstrap,
    download_dvol_candles,
    split_purged_is_oos,
)


HOUR_MS = 60 * 60 * 1000
FOUR_HOURS_MS = 4 * HOUR_MS


class DvolDownloadTests(unittest.TestCase):
    def test_tls_context_loads_a_real_ca_bundle(self):
        context = build_tls_context()

        self.assertGreater(len(context.get_ca_certs()), 0)

    def test_pagination_uses_continuation_and_returns_sorted_unique_candles(self):
        calls = []

        def fetch_page(start_ms, end_ms):
            calls.append((start_ms, end_ms))
            if len(calls) == 1:
                return {
                    "data": [[300, 30, 31, 29, 30], [400, 40, 41, 39, 40]],
                    "continuation": 250,
                }
            return {
                "data": [[100, 10, 11, 9, 10], [300, 99, 99, 99, 99]],
                "continuation": None,
            }

        rows = download_dvol_candles(50, 500, fetch_page=fetch_page)

        self.assertEqual(calls, [(50, 500), (50, 250)])
        self.assertEqual([row[0] for row in rows], [100, 300, 400])
        self.assertEqual(rows[1][4], 30, "newer page wins when a boundary repeats")


class DvolCausalityTests(unittest.TestCase):
    def test_alignment_includes_only_dvol_candles_closed_by_decision_time(self):
        decisions = np.array([HOUR_MS, 2 * HOUR_MS], dtype=np.int64)
        candles = [
            [0, 10, 10, 10, 10],
            [HOUR_MS, 20, 20, 20, 20],
            [2 * HOUR_MS, 999, 999, 999, 999],
        ]

        aligned = align_last_closed_dvol(decisions, candles, HOUR_MS)

        np.testing.assert_allclose(aligned["dvol_level"], [10, 20])
        np.testing.assert_allclose(aligned["dvol_age_hours"], [0, 0])

    def test_future_price_and_dvol_mutations_do_not_change_past_features(self):
        n = 260
        times = np.arange(1, n + 1, dtype=np.int64) * FOUR_HOURS_MS
        close = 20_000 * np.exp(np.arange(n) * 0.001)
        price = pd.DataFrame(
            {
                "open": close * 0.999,
                "high": close * 1.01,
                "low": close * 0.99,
                "close": close,
                "volume": np.full(n, 100.0),
            },
            index=pd.Index(times, name="time"),
        )
        dvol = []
        for hour in range(n * 4):
            value = 50 + hour * 0.01
            dvol.append([hour * HOUR_MS, value, value, value, value])

        cutoff = times[230]
        original = build_feature_frame(price, dvol)

        complete = original.dropna(subset=["dvol_level", "rv_30d", "vrp_proxy"])
        expected_vrp = (complete["dvol_level"] / 100) ** 2 - (
            complete["rv_30d"] / 100
        ) ** 2
        np.testing.assert_allclose(complete["vrp_proxy"], expected_vrp)

        mutated_price = price.copy()
        mutated_price.loc[mutated_price.index > cutoff, ["open", "high", "low", "close"]] *= 3
        mutated_dvol = [row.copy() for row in dvol]
        for row in mutated_dvol:
            if row[0] + HOUR_MS > cutoff:
                row[1:] = [999, 999, 999, 999]
        mutated = build_feature_frame(mutated_price, mutated_dvol)

        columns = [
            "atr_pct14",
            "rv_1d",
            "rv_7d",
            "rv_30d",
            "dvol_level",
            "dvol_chg_24h",
            "dvol_vov_5d",
            "vrp_proxy",
        ]
        pd.testing.assert_frame_equal(
            original.loc[original.index <= cutoff, columns],
            mutated.loc[mutated.index <= cutoff, columns],
        )

    def test_split_purges_training_labels_that_cross_oos_boundary(self):
        cutoff = pd.Timestamp("2023-07-01T00:00:00Z").value // 1_000_000
        times = np.arange(cutoff - 10 * FOUR_HOURS_MS, cutoff + 10 * FOUR_HOURS_MS, FOUR_HOURS_MS)
        valid = np.ones(len(times), dtype=bool)

        is_mask, oos_mask = split_purged_is_oos(times, valid, cutoff, horizon_bars=6)

        self.assertTrue(np.all(times[is_mask] + 6 * FOUR_HOURS_MS <= cutoff))
        self.assertTrue(np.all(times[oos_mask] >= cutoff))
        self.assertFalse(np.any(is_mask & oos_mask))


class DvolStatisticsTests(unittest.TestCase):
    def test_calendar_month_bootstrap_is_deterministic_and_detects_improvement(self):
        times = pd.date_range("2024-01-01", periods=180, freq="D", tz="UTC")
        improvement = np.full(len(times), 2.0)

        first = calendar_month_bootstrap(times, improvement, iterations=1_000, seed=20260712)
        second = calendar_month_bootstrap(times, improvement, iterations=1_000, seed=20260712)

        self.assertEqual(first, second)
        self.assertGreater(first["mean"], 0)
        self.assertLessEqual(first["p_one_sided"], 0.002)
        self.assertGreater(first["ci95_low"], 0)


if __name__ == "__main__":
    unittest.main()
