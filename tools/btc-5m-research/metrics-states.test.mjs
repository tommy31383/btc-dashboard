import assert from "node:assert/strict";
import test from "node:test";

import { classifyMetricsStates, computeMetricsFeatures } from "./metrics-states.mjs";

const FIVE_MINUTES = 300_000;
const DAY = 86_400_000;

function metric(time, overrides = {}) {
  return {
    time,
    openInterest: 100 + time / DAY,
    openInterestValue: 1_000,
    topAccountRatio: 1.1,
    topPositionRatio: 1 + time / (100 * DAY),
    accountRatio: 1 + time / (80 * DAY),
    takerRatio: 1.1,
    ...overrides,
  };
}

test("state classifier implements the three frozen mechanisms", () => {
  assert.deepEqual(classifyMetricsStates({
    priceChange1h: 0.01,
    oiChange1h: -0.01,
    takerRatio1h: 1.2,
    accountRank7d: 0.8,
    topPositionRank7d: 0.9,
  }), {
    SHORT_COVERING_RALLY: true,
    BUY_ABSORPTION: false,
    CROWDED_LONG: false,
  });
  assert.equal(classifyMetricsStates({
    priceChange1h: -0.001,
    oiChange1h: 0.01,
    takerRatio1h: 1.2,
    accountRank7d: 0.8,
    topPositionRank7d: 0.9,
  }).BUY_ABSORPTION, true);
  assert.equal(classifyMetricsStates({
    priceChange1h: 0.001,
    oiChange1h: 0.01,
    takerRatio1h: 0.9,
    accountRank7d: 0.8,
    topPositionRank7d: 0.9,
  }).CROWDED_LONG, true);
});

test("metrics features use only snapshots and price bars available before the cutoff", () => {
  const signalTime = 8 * DAY;
  const metrics = [];
  for (let time = 0; time <= signalTime - FIVE_MINUTES; time += FIVE_MINUTES) {
    metrics.push(metric(time));
  }
  const bars5m = Array.from({ length: signalTime / FIVE_MINUTES + 2 }, (_, index) => ({
    time: index * FIVE_MINUTES,
    close: 100 + index / 100,
  }));
  const signalIndex = signalTime / FIVE_MINUTES;
  const before = computeMetricsFeatures({ metrics, bars5m, signalIndex });
  const polluted = [
    ...metrics,
    metric(signalTime, {
      openInterest: 1,
      accountRatio: 100,
      topPositionRatio: 100,
      takerRatio: 100,
    }),
  ];
  const after = computeMetricsFeatures({ metrics: polluted, bars5m, signalIndex });
  assert.deepEqual(after, before);
  assert.equal(before.available, true);
  assert.equal(before.metricCutoff, signalTime - FIVE_MINUTES);
  assert.ok(before.accountRank7d >= 0.99);
  assert.ok(before.topPositionRank7d >= 0.99);
});
