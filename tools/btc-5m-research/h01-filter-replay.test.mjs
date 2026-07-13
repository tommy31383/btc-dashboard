import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFilterRows } from "./h01-filter-replay.mjs";
import { SCENARIOS } from "./h01-replay.mjs";

const M5 = 5 * 60_000;

test("filter replay distinguishes skipped, retained reclaim, and toxicity pass", () => {
  const bars5m = Array.from({ length: 60 }, (_, index) => ({
    time: index * M5,
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100 + index * 0.1,
    volume: 10,
  }));
  const signal = { setup: "S13", signalTime: 25 * M5, atr: 2, signalClose: 102.5 };
  const value = (timedOut) => ({ timedOut, fillTime: 25 * M5, netPnl: 1 });
  const timingRows = [{
    setup: "S13",
    signalTime: signal.signalTime,
    split: "discovery",
    scenarios: {
      primaryLowHigh: {
        A: value(false),
        E60: value(true),
        S6_60: value(false),
        S12_60: value(true),
      },
    },
  }];
  let calls = 0;
  const rows = buildFilterRows({
    bars5m,
    funding: [],
    signals: [signal],
    timingRows,
    oracle: { hedge01TrailingExit() {} },
    scenarios: { primaryLowHigh: SCENARIOS.primaryLowHigh },
    simulate: ({ child }) => {
      calls += 1;
      return { ...child, complete: true, fillPrice: child.rawFillPrice, exitTime: child.fillTime + M5, netPnl: 2 };
    },
  });
  assert.equal(rows[0].scenarios.primaryLowHigh.NR_E60.skipped, true);
  assert.equal(rows[0].scenarios.primaryLowHigh.NR_S6_60.skipped, false);
  assert.equal(rows[0].scenarios.primaryLowHigh.TOXICITY_SKIP.skipped, false);
  assert.equal(calls, 1);
});
