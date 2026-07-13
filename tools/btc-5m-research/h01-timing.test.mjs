import assert from "node:assert/strict";
import { test } from "node:test";

import {
  METHODS,
  assertBaselineParity,
  buildMethodEntry,
  buildTimingEntry,
  causalEma,
  findEmaReclaimEntry,
  findSweepReclaimEntry,
} from "./h01-timing.mjs";

const M5 = 5 * 60_000;

function bar(index, values = {}) {
  const close = values.close ?? 100;
  return {
    time: index * M5,
    open: values.open ?? close,
    high: values.high ?? Math.max(values.open ?? close, close),
    low: values.low ?? Math.min(values.open ?? close, close),
    close,
    volume: values.volume ?? 10,
  };
}

test("causal EMA at an index ignores every later close", () => {
  const closes = [10, 11, 12, 13, 14, 1_000];
  assert.equal(causalEma(closes, 3, 4), causalEma(closes.slice(0, 5), 3, 4));
});

test("EMA reclaim decides on a closed bar and fills the next 5m open", () => {
  const bars = [
    bar(0, { close: 100 }),
    bar(1, { close: 100 }),
    bar(2, { close: 100 }),
    bar(3, { low: 98, close: 101 }),
    bar(4, { open: 102, close: 500 }),
    bar(5, { open: 600, close: 600 }),
  ];
  const entry = findEmaReclaimEntry(bars, {
    signalIndex: 3,
    timeoutBars: 2,
    emaPeriod: 3,
  });
  assert.deepEqual(entry, {
    fillIndex: 4,
    fillTime: 4 * M5,
    reason: "EMA20_RECLAIM",
    timedOut: false,
  });
});

test("timing candidate always falls back at the exact timeout open", () => {
  const bars = Array.from({ length: 20 }, (_, index) =>
    bar(index, { open: 100 + index, close: 100 + index, low: 100 + index }),
  );
  const entry = findEmaReclaimEntry(bars, {
    signalIndex: 5,
    timeoutBars: 6,
    emaPeriod: 3,
  });
  assert.equal(entry.fillIndex, 11);
  assert.equal(entry.fillTime, 11 * M5);
  assert.equal(entry.reason, "TIMEOUT_MARKET");
  assert.equal(entry.timedOut, true);
  assert.equal(buildTimingEntry(bars, entry, "E30").rawFillPrice, 111);
});

test("sweep reclaim compares against prior lows and fills next open", () => {
  const bars = [
    bar(0, { low: 99, close: 100 }),
    bar(1, { low: 98, close: 100 }),
    bar(2, { low: 97, close: 100 }),
    bar(3, { open: 100, low: 96, close: 98, high: 101 }),
    bar(4, { open: 99, close: 99 }),
    bar(5, { open: 105, close: 105 }),
  ];
  const entry = findSweepReclaimEntry(bars, {
    signalIndex: 3,
    timeoutBars: 2,
    lookbackBars: 3,
  });
  assert.equal(entry.fillIndex, 4);
  assert.equal(entry.reason, "SWEEP_RECLAIM");
  assert.equal(buildTimingEntry(bars, entry, "S6").rawFillPrice, 99);
});

test("method grid is frozen to the preregistered timing family", () => {
  assert.deepEqual(Object.keys(METHODS), ["A", "E30", "E60", "S6_30", "S6_60", "S12_30", "S12_60"]);
  assert.equal(Object.isFrozen(METHODS.S6_60), true);
  assert.deepEqual(METHODS.S12_60, {
    id: "S12_60",
    family: "SWEEP_RECLAIM_FALLBACK",
    timeoutBars: 12,
    lookbackBars: 12,
  });
});

test("baseline parity checks exact execution fields", () => {
  const expected = [{
    setup: "S13",
    signalTime: 1,
    scenarios: {
      primaryLowHigh: { methods: { A: { children: [{ fillTime: 1, fillPrice: 2, exitTime: 3, exitPrice: 4, fees: 5, fundingPnl: 6, netPnl: 7 }] } } },
    },
  }];
  const actual = [{
    setup: "S13",
    signalTime: 1,
    scenarios: {
      primaryLowHigh: { A: { fillTime: 1, fillPrice: 2, exitTime: 3, exitPrice: 4, fees: 5, fundingPnl: 6, netPnl: 7 } },
    },
  }];
  assert.equal(assertBaselineParity(actual, expected, ["primaryLowHigh"]), true);
  actual[0].scenarios.primaryLowHigh.A.netPnl = 8;
  assert.throws(
    () => assertBaselineParity(actual, expected, ["primaryLowHigh"]),
    /BASELINE_PARITY_MISMATCH/,
  );
});

test("immediate and delayed methods share one entry interface", () => {
  const bars = Array.from({ length: 40 }, (_, index) =>
    bar(index, { open: 100 + index, close: 100 + index, low: 100 + index }),
  );
  assert.equal(buildMethodEntry(bars, 15, METHODS.A).fillTime, 15 * M5);
  const delayed = buildMethodEntry(bars, 15, METHODS.E30);
  assert.equal(delayed.fillTime, 21 * M5);
  assert.equal(delayed.fillReason, "TIMEOUT_MARKET");
});
