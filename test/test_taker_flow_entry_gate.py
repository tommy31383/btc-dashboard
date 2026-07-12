import datetime as dt
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

from taker_flow_entry_gate import (  # noqa: E402
    FIVE_MINUTES_MS,
    HOUR_MS,
    aggregate_hour,
    build_event_observation,
    build_research_intervals,
    evaluate_association_gate,
    evaluate_data_gate,
    group_market_events,
    midrank_percentile,
    month_block_bootstrap_rho,
    month_range,
    parse_month_zip,
    parse_kline_csv,
    parse_official_checksum,
    spearman_rho,
)


def make_bar(open_time, *, imbalance=0.0, price=100.0, low=None, close=None):
    volume = 100.0
    taker_buy = volume * (imbalance + 1) / 2
    return {
        "time": open_time,
        "open": price,
        "high": price + 1,
        "low": price - 1 if low is None else low,
        "close": price if close is None else close,
        "volume": volume,
        "takerBuyBase": taker_buy,
        "closeTime": open_time + FIVE_MINUTES_MS - 1,
        "trades": 10,
    }


def event_fixture(signal_time=200 * HOUR_MS):
    return {
        "signalTime": signal_time,
        "setups": ["S13", "S14"],
        "episodeCount": 2,
        "rawFillPrice": 100.0,
        "atr": 10.0,
    }


def observation_bars(signal_time=200 * HOUR_MS):
    bars = {}
    first_hour_end = signal_time - 120 * HOUR_MS
    for hour_index in range(121):
        hour_end = first_hour_end + hour_index * HOUR_MS
        imbalance = -0.84 + hour_index * 0.01
        for step in range(12):
            open_time = hour_end - HOUR_MS + step * FIVE_MINUTES_MS
            bars[open_time] = make_bar(open_time, imbalance=imbalance)
    for step in range(48):
        open_time = signal_time + step * FIVE_MINUTES_MS
        price = 90.0 if open_time == signal_time + HOUR_MS else 100.0
        bars[open_time] = make_bar(open_time, imbalance=-0.9, price=price, low=95.0)
    bars[signal_time]["open"] = 100.0
    return bars


class ArchiveTests(unittest.TestCase):
    def test_month_range_is_inclusive_and_crosses_years(self):
        self.assertEqual(
            month_range("2020-11", "2021-02"),
            ["2020-11", "2020-12", "2021-01", "2021-02"],
        )

    def test_parses_official_checksum_for_expected_filename(self):
        checksum = "a" * 64
        text = f"{checksum}  BTCUSDT-5m-2020-01.zip\n"

        self.assertEqual(
            parse_official_checksum(text, "BTCUSDT-5m-2020-01.zip"),
            checksum,
        )
        with self.assertRaisesRegex(ValueError, "filename"):
            parse_official_checksum(text, "BTCUSDT-5m-2020-02.zip")

    def test_parses_exchange_taker_buy_field_not_candle_direction_proxy(self):
        row = (
            "1577836800000,100,110,90,105,1000,1577837099999,"
            "102000,25,200,20500,0\n"
        )

        bars = parse_kline_csv(row)

        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]["volume"], 1000.0)
        self.assertEqual(bars[0]["takerBuyBase"], 200.0)
        self.assertGreater(bars[0]["close"], bars[0]["open"])

    def test_month_zip_keeps_only_rows_intersecting_research_windows(self):
        rows = (
            "1577836800000,100,110,90,105,1000,1577837099999,102000,25,200,20500,0\n"
            "1577837100000,105,111,100,110,500,1577837399999,54000,20,300,32500,0\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "BTCUSDT-5m-2020-01.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("BTCUSDT-5m-2020-01.csv", rows)

            kept, metadata = parse_month_zip(
                path,
                intervals=[(1577836800000, 1577836800000)],
            )

        self.assertEqual([bar["time"] for bar in kept], [1577836800000])
        self.assertEqual(metadata["rowCount"], 2)
        self.assertEqual(metadata["keptRowCount"], 1)


class FeatureTests(unittest.TestCase):
    def test_research_interval_covers_only_required_history_and_four_hour_outcome(self):
        signal_time = 200 * HOUR_MS

        intervals = build_research_intervals(
            [{"signalTime": signal_time}],
            archive_start_ms=0,
        )

        self.assertEqual(
            intervals,
            [
                (
                    signal_time - 121 * HOUR_MS,
                    signal_time + 4 * HOUR_MS - FIVE_MINUTES_MS,
                )
            ],
        )

    def test_aggregates_true_hourly_taker_imbalance(self):
        end_time = HOUR_MS
        bars = [
            make_bar(step * FIVE_MINUTES_MS, imbalance=0.4) for step in range(12)
        ]

        hour = aggregate_hour(bars, end_time=end_time)

        self.assertAlmostEqual(hour["takerImbalance"], 0.4)
        self.assertEqual(hour["barCount"], 12)
        self.assertEqual(hour["endTime"], end_time)

    def test_midrank_percentile_handles_ties_without_looking_forward(self):
        self.assertEqual(midrank_percentile(2.0, [1.0, 2.0, 2.0, 3.0]), 0.5)

    def test_event_feature_uses_only_bars_closed_before_signal(self):
        event = event_fixture()
        bars = observation_bars()

        first = build_event_observation(event, bars)
        bars[event["signalTime"]]["takerBuyBase"] = 100.0
        mutated = build_event_observation(event, bars)

        self.assertEqual(first["flowRank1h"], mutated["flowRank1h"])
        self.assertEqual(first["immediateOpen"], 100.0)
        self.assertEqual(first["delayedOpen"], 90.0)
        self.assertEqual(first["delayAdvantageBps"], 1000.0)
        self.assertEqual(first["featureMaxCloseTime"], event["signalTime"] - 1)


class PopulationTests(unittest.TestCase):
    def test_groups_same_timestamp_without_double_weighting_market_event(self):
        episodes = [
            {
                "setup": "S13",
                "signalTime": 1_000,
                "atr": 10.0,
                "primary": {"rawFillPrice": 100.0},
            },
            {
                "setup": "S14",
                "signalTime": 1_000,
                "atr": 10.0,
                "primary": {"rawFillPrice": 100.0},
            },
            {
                "setup": "S13",
                "signalTime": 2_000,
                "atr": 11.0,
                "primary": {"rawFillPrice": 101.0},
            },
        ]
        accepted = {"S13|1000", "S14|1000", "S13|2000"}

        events = group_market_events(episodes, accepted)

        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["setups"], ["S13", "S14"])
        self.assertEqual(events[0]["episodeCount"], 2)


class StatisticsTests(unittest.TestCase):
    def test_spearman_matches_known_rankings(self):
        self.assertEqual(spearman_rho([1, 2, 3], [10, 20, 30]), 1.0)
        self.assertEqual(spearman_rho([1, 2, 3], [30, 20, 10]), -1.0)

    def test_month_block_bootstrap_is_deterministic(self):
        times = [
            int(dt.datetime(2024, month, day, tzinfo=dt.timezone.utc).timestamp() * 1000)
            for month, day in [(1, 1), (1, 2), (2, 1), (2, 2), (3, 1), (3, 2)]
        ]
        x = [1, 2, 3, 4, 5, 6]
        y = [2, 4, 6, 8, 10, 12]

        first = month_block_bootstrap_rho(times, x, y, iterations=200, seed=7)
        second = month_block_bootstrap_rho(times, x, y, iterations=200, seed=7)

        self.assertEqual(first, second)
        self.assertEqual(first["ci90Low"], 1.0)


class GateTests(unittest.TestCase):
    def test_data_gate_requires_both_episode_and_unique_event_coverage(self):
        passed = evaluate_data_gate(
            total_episodes=95,
            covered_episodes=90,
            total_events=61,
            covered_events=57,
            all_months_verified=True,
            all_windows_complete=True,
            all_entry_prices_match=True,
            no_duplicate_timestamps=True,
        )
        failed = evaluate_data_gate(
            total_episodes=95,
            covered_episodes=90,
            total_events=61,
            covered_events=54,
            all_months_verified=True,
            all_windows_complete=True,
            all_entry_prices_match=True,
            no_duplicate_timestamps=True,
        )

        self.assertEqual(passed["verdict"], "PASS_TAKER_FLOW_DATA_GATE0")
        self.assertEqual(failed["verdict"], "KILL_TAKER_FLOW_DATA_INSUFFICIENT")

    def test_association_gate_passes_only_robust_positive_oos_relationship(self):
        observations = []
        for index in range(36):
            rank = index / 35
            observations.append(
                {
                    "signalTime": int(
                        dt.datetime(
                            2023,
                            index % 12 + 1,
                            index // 12 + 1,
                            tzinfo=dt.timezone.utc,
                        ).timestamp()
                        * 1000
                    ),
                    "setups": ["S13" if index % 2 == 0 else "S14"],
                    "flowRank1h": rank,
                    "delayAdvantageBps": rank * 10 - 2,
                }
            )
        for index in range(21):
            rank = index / 20
            observations.append(
                {
                    "signalTime": int(
                        dt.datetime(
                            2024,
                            index % 7 + 1,
                            index // 7 + 1,
                            tzinfo=dt.timezone.utc,
                        ).timestamp()
                        * 1000
                    ),
                    "setups": ["S13" if index % 2 == 0 else "S14"],
                    "flowRank1h": rank,
                    "delayAdvantageBps": rank * 10 - 2,
                }
            )

        passed = evaluate_association_gate(
            observations, bootstrap_iterations=200, bootstrap_seed=11
        )
        reversed_oos = [dict(item) for item in observations]
        for item in reversed_oos:
            if item["signalTime"] >= int(
                dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc).timestamp() * 1000
            ):
                item["delayAdvantageBps"] *= -1
        failed = evaluate_association_gate(
            reversed_oos, bootstrap_iterations=200, bootstrap_seed=11
        )

        self.assertEqual(passed["verdict"], "PASS_TO_TAKER_FLOW_LIFECYCLE_GATE2")
        self.assertEqual(failed["verdict"], "KILL_NO_TAKER_FLOW_TIMING_EDGE")


if __name__ == "__main__":
    unittest.main()
