import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dropTopFraction,
  maxRealizedDrawdown,
  selectFilter,
  selectPlateau,
  selectStandalone,
  summarizeFilteredMethod,
  summarizeMethod,
  summarizeStandalone,
} from "./evaluate.mjs";

test("realized drawdown follows exit chronology", () => {
  assert.equal(maxRealizedDrawdown([10, -4, -8, 3]), 12);
  assert.equal(maxRealizedDrawdown([-2, 1, 5]), 2);
});

test("drop-top removes the largest twenty percent of outcomes", () => {
  assert.equal(dropTopFraction([10, 4, 3, -1, -2], 0.2), 4);
  assert.equal(dropTopFraction([1, -2], 0.2), -2);
});

test("method summary applies setup quantity and preserves monthly counts", () => {
  const make = (signalTime, setup, netPnl, exitTime) => ({
    signalTime,
    setup,
    split: "discovery",
    scenarios: {
      primaryLowHigh: {
        A: {
          netPnl,
          grossEntryNotional: 100,
          fillPrice: 100,
          exitTime,
          fees: 1,
          fundingPnl: 0,
          entryImprovementAtr: 0,
          timedOut: false,
          mfe24Atr: 2,
          mae24Atr: 1,
          holdMs: 3_600_000,
        },
      },
    },
  });
  const rows = [
    make(Date.UTC(2023, 0, 1), "S13", 100, 2),
    make(Date.UTC(2023, 0, 2), "S14", -50, 1),
  ];
  const summary = summarizeMethod(rows, "primaryLowHigh", "A");
  assert.ok(Math.abs(summary.netPnl - 0.05) < 1e-12);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.maxRealizedDrawdown, 0.25);
  assert.equal(summary.byMonth["2023-01"].count, 2);
});

test("plateau selector prefers a robust family median over a peak", () => {
  const metric = (netPnl, maxRealizedDrawdown, dropTop20NetPnl) => ({
    netPnl,
    maxRealizedDrawdown,
    dropTop20NetPnl,
  });
  const selected = selectPlateau({
    A: metric(0, 10, -5),
    E30: metric(3, 10, -2),
    E60: metric(5, 10.5, 0),
    S6_30: metric(8, 9, 2),
    S6_60: metric(-1, 12, -8),
    S12_30: metric(-2, 11, -7),
    S12_60: metric(-3, 13, -9),
  });
  assert.equal(selected.method, "E30");
  assert.equal(selected.family, "EMA20_RECLAIM_FALLBACK");
});

test("filtered summary reports retained frequency and skipped baseline counterfactual", () => {
  const result = (netPnl, exitTime) => ({
    skipped: false,
    netPnl,
    exitTime,
    fees: 1,
    fundingPnl: 0,
    entryImprovementAtr: 0,
    mfe24Atr: 1,
    mae24Atr: 1,
    holdMs: 1,
  });
  const rows = [
    {
      setup: "S13", signalTime: Date.UTC(2023, 0, 1),
      scenarios: { x: { A: result(100, 1), F: { skipped: true } } },
    },
    {
      setup: "S13", signalTime: Date.UTC(2023, 0, 2),
      scenarios: { x: { A: result(100, 2), F: result(50, 2) } },
    },
  ];
  const summary = summarizeFilteredMethod(rows, "x", "F");
  assert.equal(summary.sourceCount, 2);
  assert.equal(summary.retainedCount, 1);
  assert.equal(summary.retainedFraction, 0.5);
  assert.ok(Math.abs(summary.netPnl - 0.15) < 1e-12);
  assert.ok(Math.abs(summary.skippedBaselinePnl - 0.3) < 1e-12);
});

test("filter selector requires frequency, net, drawdown, tail, and losing skipped cohort", () => {
  const selected = selectFilter(
    { netPnl: 10, maxRealizedDrawdown: 5, dropTop20NetPnl: -2 },
    {
      good: { retainedFraction: 0.9, netPnl: 12, maxRealizedDrawdown: 4, dropTop20NetPnl: 0, skippedBaselinePnl: -3 },
      lowFrequency: { retainedFraction: 0.5, netPnl: 20, maxRealizedDrawdown: 2, dropTop20NetPnl: 5, skippedBaselinePnl: -10 },
      skippedWinners: { retainedFraction: 0.9, netPnl: 13, maxRealizedDrawdown: 4, dropTop20NetPnl: 1, skippedBaselinePnl: 2 },
    },
  );
  assert.equal(selected.method, "good");
});

test("standalone summary reports side and year stability after costs", () => {
  const trades = [
    { signalTime: Date.UTC(2023, 0, 1), exitTime: 2, side: "LONG", netReturn: 0.02, mfeAtr: 2, maeAtr: 1 },
    { signalTime: Date.UTC(2023, 1, 1), exitTime: 1, side: "SHORT", netReturn: -0.01, mfeAtr: 1, maeAtr: 1 },
  ];
  const summary = summarizeStandalone(trades);
  assert.equal(summary.count, 2);
  assert.equal(summary.netReturn, 0.01);
  assert.equal(summary.maxRealizedDrawdown, 0.01);
  assert.equal(summary.bySide.LONG.count, 1);
  assert.equal(summary.byYear["2023"].count, 2);
});

test("standalone selector rejects a family without a positive parameter plateau", () => {
  const selection = selectStandalone([
    { config: { id: "a", family: "x" }, summary: { netReturn: 1, dropTop20NetReturn: 0.5 } },
    { config: { id: "b", family: "x" }, summary: { netReturn: -1, dropTop20NetReturn: -2 } },
    { config: { id: "c", family: "x" }, summary: { netReturn: -1, dropTop20NetReturn: -2 } },
    { config: { id: "d", family: "x" }, summary: { netReturn: -1, dropTop20NetReturn: -2 } },
  ]);
  assert.equal(selection.configId, null);
  assert.equal(selection.family, null);
});
