import assert from "node:assert/strict";
import test from "node:test";

import { aggregateMicroChildren, buildMicroRows } from "./micro-ladder-replay.mjs";

test("micro aggregation preserves weighted execution economics", () => {
  const children = [
    {
      complete: true,
      weight: 0.7,
      fillPrice: 100,
      fillTime: 1_000,
      fillReason: "MARKET_NOW_PARTIAL",
      exitTime: 4_000,
      exitPrice: 110,
      holdMs: 3_000,
      grossEntryNotional: 70,
      grossPnl: 7,
      fundingPnl: -0.2,
      fundingProxyCount: 1,
      fees: 0.1,
      netPnl: 6.7,
      mfe24Atr: 2,
      mae24Atr: 0.5,
    },
    {
      complete: true,
      weight: 0.3,
      fillPrice: 90,
      fillTime: 2_000,
      fillReason: "TIMEOUT_MARKET",
      exitTime: 5_000,
      exitPrice: 105,
      holdMs: 3_000,
      grossEntryNotional: 27,
      grossPnl: 4.5,
      fundingPnl: -0.1,
      fundingProxyCount: 0,
      fees: 0.05,
      netPnl: 4.35,
      mfe24Atr: 3,
      mae24Atr: 1,
    },
  ];
  const value = aggregateMicroChildren("M70", children, 100, 10);
  assert.equal(value.fillPrice, 97);
  assert.equal(value.grossEntryNotional, 97);
  assert.equal(value.netPnl, 11.05);
  assert.equal(value.exitTime, 5_000);
  assert.equal(value.entryImprovementAtr, 0.3);
  assert.equal(value.timedOut, true);
  assert.equal(value.mfe24Atr, 2.3);
  assert.ok(Math.abs(value.mae24Atr - 0.65) < 1e-12);
  assert.equal(value.holdMs, 3_000);
});

test("micro replay applies causal ATR and simulates every child", () => {
  const bars5m = Array.from({ length: 40 }, (_, index) => ({
    time: index * 300_000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
  }));
  const calls = [];
  const rows = buildMicroRows({
    bars5m,
    funding: [],
    signals: [{ setup: "S12", signalTime: 20 * 300_000, atr: 10 }],
    oracle: { hedge01TrailingExit() {} },
    scenarios: { primary: { cost: {}, intrabarOrder: "LOW_HIGH" } },
    atrAt: (_bars, index) => {
      assert.equal(index, 20);
      return 4;
    },
    simulate: ({ child }) => {
      calls.push(child);
      return {
        ...child,
        complete: true,
        fillPrice: child.rawFillPrice,
        exitTime: child.fillTime + 300_000,
        exitPrice: child.rawFillPrice + 1,
        holdMs: 300_000,
        grossEntryNotional: child.weight * child.rawFillPrice,
        grossPnl: child.weight,
        fundingPnl: 0,
        fundingProxyCount: 0,
        fees: 0,
        netPnl: child.weight,
        mfe24Atr: 1,
        mae24Atr: 0.5,
      };
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(Object.keys(rows[0].scenarios.primary).length, 9);
  assert.equal(calls.length, 17);
  assert.equal(rows[0].split, "discovery");
});
