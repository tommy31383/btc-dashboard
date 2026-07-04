import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BEARISH_LEG,
  BULLISH_LEG,
  calculateSmcLegs,
  runSmc,
  type SmcCandle,
  type SmcConfigInput,
} from "./smc";

function candle(index: number, high: number, low: number, close: number): SmcCandle {
  return {
    time: index * 60_000,
    open: close,
    high,
    low,
    close,
    volume: 100 + index,
  };
}

function structureCandles(): SmcCandle[] {
  return [
    candle(0, 11, 6, 8),
    candle(1, 10, 5, 7),
    candle(2, 9, 2, 3),
    candle(3, 8, 5, 6),
    candle(4, 12, 6, 7),
    candle(5, 10, 7, 9),
    candle(6, 9, 8, 8),
    candle(7, 13, 9, 13),
    candle(8, 8, 5, 6),
  ];
}

function internalOnlyConfig(): SmcConfigInput {
  return {
    internalSize: 2,
    swingsLength: 2,
    showInternal: true,
    showSwing: false,
    showOrderBlocks: true,
    showEqualHighLow: false,
    showPremiumDiscountZones: false,
    maxOrderBlocks: 5,
  };
}

test("calculateSmcLegs follows Pine leg(size) bullish and bearish pivots", () => {
  const legs = calculateSmcLegs(structureCandles(), 2);

  assert.equal(legs[0], BEARISH_LEG);
  assert.equal(legs[4], BULLISH_LEG);
  assert.equal(legs[6], BEARISH_LEG);
});

test("runSmc labels BOS versus CHoCH from the current structure trend", () => {
  const result = runSmc(structureCandles(), internalOnlyConfig());
  const internalEvents = result.structureEvents.filter((event) => event.scope === "internal");

  assert.deepEqual(
    internalEvents.map((event) => [event.type, event.bias, event.barIndex, event.pivotIndex, event.priceLevel]),
    [
      ["BOS", "bullish", 7, 4, 12],
      ["CHoCH", "bearish", 8, 5, 7],
    ]
  );
});

test("runSmc removes a bullish order block when price mitigates below its bottom", () => {
  const beforeMitigation = runSmc(structureCandles().slice(0, 8), internalOnlyConfig());
  const afterMitigation = runSmc(structureCandles(), internalOnlyConfig());

  assert.equal(beforeMitigation.orderBlocks.some((block) => block.bias === "bullish"), true);
  assert.equal(afterMitigation.orderBlocks.some((block) => block.bias === "bullish"), false);
  assert.equal(afterMitigation.orderBlocks.some((block) => block.bias === "bearish"), true);
});
