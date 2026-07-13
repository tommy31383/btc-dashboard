import assert from "node:assert/strict";
import { test } from "node:test";

import { dropTopFraction, maxRealizedDrawdown, selectPlateau, summarizeMethod } from "./evaluate.mjs";

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
