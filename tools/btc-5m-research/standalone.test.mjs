import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STANDALONE_CONFIGS,
  buildBiasSeries,
  compressionExpansionSignal,
  impulsePullbackSignal,
  liquiditySweepSignal,
  resampleCompleteBars,
  runStandaloneConfig,
  simulateStandaloneTrade,
} from "./standalone.mjs";

const M5 = 5 * 60_000;

function bar(index, values = {}) {
  const close = values.close ?? 100;
  return {
    time: index * M5,
    open: values.open ?? close,
    high: values.high ?? Math.max(values.open ?? close, close) + 1,
    low: values.low ?? Math.min(values.open ?? close, close) - 1,
    close,
    volume: values.volume ?? 10,
  };
}

test("resampler emits only complete closed buckets", () => {
  const bars = Array.from({ length: 25 }, (_, index) => bar(index));
  const hourly = resampleCompleteBars(bars, 60 * 60_000);
  assert.equal(hourly.length, 2);
  assert.equal(hourly[0].time, 0);
  assert.equal(hourly[1].time, 60 * 60_000);
  assert.equal(hourly[1].closeTime, 2 * 60 * 60_000);
});

test("liquidity sweep reclaim is directional and causal", () => {
  const bars = [
    bar(0, { low: 99 }),
    bar(1, { low: 98 }),
    bar(2, { low: 97 }),
    bar(3, { open: 100, low: 96, high: 101, close: 98 }),
  ];
  assert.equal(liquiditySweepSignal(bars, 3, 3, "LONG"), "LONG");
  assert.equal(liquiditySweepSignal(bars, 3, 3, "SHORT"), null);
});

test("standalone simulator resolves same-bar stop before target in adverse path", () => {
  const bars = [
    bar(0, { open: 100, high: 100, low: 100, close: 100 }),
    bar(1, { open: 100, high: 103, low: 98, close: 102 }),
  ];
  const result = simulateStandaloneTrade({
    bars,
    entryIndex: 1,
    side: "LONG",
    atr: 2,
    tpAtr: 1,
    slAtr: 1,
    maxHoldBars: 1,
    feeBps: 0,
    slippageBps: 0,
    intrabarOrder: "ADVERSE_FIRST",
    funding: [],
  });
  assert.equal(result.exitReason, "SL");
  assert.equal(result.exitPrice, 98);
  assert.ok(Math.abs(result.netReturn + 0.02) < 1e-12);
});

test("compression expansion requires prior compression and current breakout", () => {
  const bars = [
    bar(0, { high: 101, low: 99, close: 100 }),
    bar(1, { high: 101, low: 99, close: 100 }),
    bar(2, { high: 101, low: 99, close: 100 }),
    bar(3, { high: 103, low: 100, close: 102 }),
  ];
  assert.equal(compressionExpansionSignal(bars, 3, 3, true, "LONG"), "LONG");
  assert.equal(compressionExpansionSignal(bars, 3, 3, false, "LONG"), null);
});

test("impulse continuation protects midpoint then breaks pullback high", () => {
  const bars = [
    bar(0, { open: 100, close: 104, high: 104, low: 100 }),
    bar(1, { open: 104, close: 103.5, high: 104, low: 102.5 }),
    bar(2, { open: 103.5, close: 104, high: 104.5, low: 103 }),
    bar(3, { open: 104, close: 105, high: 105, low: 103 }),
  ];
  assert.equal(
    impulsePullbackSignal(bars, 3, 3, 1.5, [2, 2, 2, 2], "LONG"),
    "LONG",
  );
});

test("higher-timeframe bias uses only fully closed 1h and 4h bars", () => {
  const bars = Array.from({ length: 12 * 240 }, (_, index) => {
    const price = 100 + index * 0.01;
    return bar(index, { open: price, high: price + 0.1, low: price - 0.1, close: price });
  });
  const bias = buildBiasSeries(bars);
  assert.equal(bias[12 * 199], null);
  assert.equal(bias.at(-1), "LONG");

  const cutoff = 12 * 220;
  const before = bias[cutoff];
  for (let index = cutoff + 1; index < bars.length; index += 1) {
    bars[index] = bar(index, { open: 1, high: 2, low: 0.5, close: 1 });
  }
  assert.equal(buildBiasSeries(bars)[cutoff], before);
});

test("standalone grid is exactly the twelve preregistered neighbors", () => {
  assert.equal(STANDALONE_CONFIGS.length, 12);
  assert.equal(STANDALONE_CONFIGS.filter((item) => item.family === "LIQUIDITY_SWEEP_RECLAIM").length, 4);
  assert.equal(STANDALONE_CONFIGS.filter((item) => item.family === "COMPRESSION_EXPANSION").length, 4);
  assert.equal(STANDALONE_CONFIGS.filter((item) => item.family === "IMPULSE_PULLBACK_CONTINUATION").length, 4);
});

test("chronological scanner enforces one-position capacity", () => {
  const bars = [
    bar(0, { low: 100 }),
    bar(1, { low: 99 }),
    bar(2, { low: 98 }),
    bar(3, { open: 100, high: 101, low: 97, close: 99 }),
    bar(4, { open: 99, high: 100, low: 98, close: 99 }),
    bar(5, { open: 99, high: 100, low: 96, close: 98 }),
    bar(6, { open: 98, high: 99, low: 97, close: 98 }),
    bar(7, { open: 98, high: 99, low: 97, close: 98 }),
  ];
  const trades = runStandaloneConfig({
    bars,
    funding: [],
    config: {
      id: "fixture",
      family: "LIQUIDITY_SWEEP_RECLAIM",
      lookbackBars: 3,
      tpAtr: 1.5,
      slAtr: 1,
      maxHoldBars: 2,
    },
    scenario: { feeBps: 0, slippageBps: 0, intrabarOrder: "ADVERSE_FIRST" },
    biasByIndex: Array(bars.length).fill("LONG"),
    atrByIndex: Array(bars.length).fill(1),
  });
  assert.equal(trades.length, 2);
  assert.ok(trades[0].exitTime <= trades[1].entryTime);
});
