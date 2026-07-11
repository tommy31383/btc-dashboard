#!/usr/bin/env python3
"""Regression test: labels ending in _1d must be backed by real daily candles."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_and_analyze as analyzer


def fake_fetch(interval, limit):
    calls.append((interval, limit))
    base = {"1d": 100_000, "4h": 40_000, "3d": 30_000, "1w": 10_000, "1M": 1_000}.get(interval, 5_000)
    return [[i, base, base + 2, base - 2, base + 1, 10] for i in range(limit)]


calls = []
old_cfg = analyzer.CFG
try:
    analyzer.CFG = analyzer.TF_CONFIG["4h"]
    series = analyzer.fetch_live_series(fake_fetch)
finally:
    analyzer.CFG = old_cfg

assert ("4h", analyzer.TF_CONFIG["4h"]["live_limit"]) in calls
assert any(interval == "1d" and limit >= 250 for interval, limit in calls)
assert any(interval == "4h" and limit >= 250 for interval, limit in calls)
assert series["selected"][-1][4] == 40_001
assert series["1d"][-1][4] == 100_001
assert series["selected"] is not series["1d"]

print("PASS - 4h analysis uses independent 1d candles and >=250-bar EMA warmup")
