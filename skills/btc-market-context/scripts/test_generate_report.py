#!/usr/bin/env python3
"""Regression tests for the embedded-chart report handoff."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_report as report


def fail_run():
    raise AssertionError("analysis must not rerun when chart_b64 is present")


original_run = report.run_analysis
original_result_path = report.RESULT_PATH
original_subprocess_run = report.subprocess.run
original_tf = report.TF
try:
    report.run_analysis = fail_run
    result, chart = report.ensure_chart_b64({"chart_b64": "embedded"})
    assert result["chart_b64"] == "embedded"
    assert chart == "embedded"

    with tempfile.TemporaryDirectory() as tmp:
        report.RESULT_PATH = os.path.join(tmp, "result.json")

        def write_embedded_result():
            with open(report.RESULT_PATH, "w", encoding="utf-8") as handle:
                json.dump({"chart_b64": "after-rerun"}, handle)

        report.run_analysis = write_embedded_result
        result, chart = report.ensure_chart_b64({})
        assert result["chart_b64"] == "after-rerun"
        assert chart == "after-rerun"

    captured = []
    report.subprocess.run = lambda command, check: captured.append((command, check))
    report.TF = "4h"
    report.run_analysis = original_run
    report.run_analysis()
    assert captured == [(["python3", os.path.join(os.path.dirname(report.__file__), "fetch_and_analyze.py"), "--tf", "4h"], True)]
finally:
    report.run_analysis = original_run
    report.RESULT_PATH = original_result_path
    report.subprocess.run = original_subprocess_run
    report.TF = original_tf

print("PASS - report consumes embedded chart_b64 and preserves requested timeframe")
