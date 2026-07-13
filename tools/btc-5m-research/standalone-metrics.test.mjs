import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMetricFeaturesByBar,
  METRIC_STANDALONE_CONFIGS,
  positioningSignal,
  selectMetricStandalone,
} from "./standalone-metrics.mjs";

const FIVE_MINUTES = 300_000;

test("standalone positioning grid is exactly eight frozen configs", () => {
  assert.equal(METRIC_STANDALONE_CONFIGS.length, 8);
  assert.deepEqual(new Set(METRIC_STANDALONE_CONFIGS.map((config) => config.family)), new Set([
    "POSITION_BACKED_CONTINUATION",
    "LONG_LIQUIDATION_RECLAIM",
  ]));
});

test("metric alignment does not use an off-second snapshot after the decision cutoff", () => {
  const bars = Array.from({ length: 30 }, (_, index) => ({
    time: index * FIVE_MINUTES,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
  }));
  const metrics = Array.from({ length: 30 }, (_, index) => ({
    time: index * FIVE_MINUTES,
    openInterest: 100 + index,
    takerRatio: 1.1,
  }));
  metrics.push({ time: 20 * FIVE_MINUTES + 1_000, openInterest: 1_000, takerRatio: 10 });
  metrics.sort((left, right) => left.time - right.time);
  const features = buildMetricFeaturesByBar(bars, metrics);
  assert.equal(features[20].latestMetricTime, 20 * FIVE_MINUTES);
  assert.notEqual(features[20].openInterest, 1_000);
});

test("positioning signals implement continuation and long liquidation reclaim", () => {
  const bars = Array.from({ length: 20 }, (_, index) => ({
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
  }));
  const continuation = positioningSignal({
    bars,
    index: 15,
    bias: "LONG",
    atr: 5,
    feature: { available: true, oiChange1h: 0.006, takerRatio1h: 1.2 },
    config: METRIC_STANDALONE_CONFIGS.find((config) =>
      config.family === "POSITION_BACKED_CONTINUATION" && config.oiThreshold === 0.005),
  });
  assert.equal(continuation, "LONG");

  bars[15] = { open: 90, high: 96, low: 89, close: 95 };
  bars[14] = { open: 96, high: 94, low: 92, close: 93 };
  bars[3] = { open: 104, high: 106, low: 103, close: 105 };
  const reclaim = positioningSignal({
    bars,
    index: 15,
    bias: "LONG",
    atr: 5,
    feature: { available: true, oiChange1h: -0.006, takerRatio1h: 0.8 },
    config: METRIC_STANDALONE_CONFIGS.find((config) =>
      config.family === "LONG_LIQUIDATION_RECLAIM" && config.oiThreshold === 0.005),
  });
  assert.equal(reclaim, "LONG");
});

test("standalone metrics selector rejects a peak and accepts a three-of-four family plateau", () => {
  const stats = Object.fromEntries(METRIC_STANDALONE_CONFIGS.map((config, index) => [
    config.id,
    {
      count: 40,
      netReturn: config.family === "POSITION_BACKED_CONTINUATION" && index < 3 ? 1 + index : -1,
      profitFactor: config.family === "POSITION_BACKED_CONTINUATION" && index < 3 ? 1.2 : 0.8,
      dropTop20NetReturn: config.family === "POSITION_BACKED_CONTINUATION" && index < 3 ? 0.1 : -0.1,
    },
  ]));
  const selection = selectMetricStandalone(stats);
  assert.equal(selection.family, "POSITION_BACKED_CONTINUATION");
  assert.ok(selection.method);
});
