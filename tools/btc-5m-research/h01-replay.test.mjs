import assert from "node:assert/strict";
import { test } from "node:test";

import { buildH01Rows, SCENARIOS } from "./h01-replay.mjs";

const M5 = 5 * 60_000;

function bars(count) {
  return Array.from({ length: count }, (_, index) => ({
    time: index * M5,
    open: 100 + index,
    high: 101 + index,
    low: 100 + index,
    close: 100.5 + index,
    volume: 10,
  }));
}

test("replay preserves every source signal across every timing method", () => {
  const calls = [];
  const rows = buildH01Rows({
    bars5m: bars(50),
    funding: [],
    signals: [{ setup: "S13", signalTime: 15 * M5, atr: 2, signalClose: 115, split: "discovery" }],
    oracle: { hedge01TrailingExit() {} },
    scenarios: { primaryLowHigh: SCENARIOS.primaryLowHigh },
    simulate: ({ child }) => {
      calls.push(child);
      return {
        ...child,
        complete: true,
        fillPrice: child.rawFillPrice,
        exitTime: child.fillTime + M5,
        exitPrice: child.rawFillPrice + 1,
        fees: 1,
        fundingPnl: 0,
        netPnl: 0,
        grossEntryNotional: child.rawFillPrice,
        mfe24Atr: 0.5,
        mae24Atr: 0.25,
        holdMs: M5,
      };
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 7);
  assert.deepEqual(Object.keys(rows[0].scenarios.primaryLowHigh), [
    "A", "E30", "E60", "S6_30", "S6_60", "S12_30", "S12_60",
  ]);
  assert.equal(rows[0].scenarios.primaryLowHigh.A.fillTime, 15 * M5);
  assert.equal(rows[0].scenarios.primaryLowHigh.E30.fillTime, 21 * M5);
});
