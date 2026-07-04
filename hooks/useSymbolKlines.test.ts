import test from "node:test";
import assert from "node:assert/strict";
import { parseBinanceKlineTuples } from "./useSymbolKlines";

test("parseBinanceKlineTuples: maps Binance kline tuples to Kline objects", () => {
  const tuples = [
    [1700000000000, "100.5", "110.2", "90.1", "105.3", "42.7", 1700000299999, true],
    [1700000300000, "105.3", "108.0", "103.0", "104.0", "17.1", 1700000599999, false],
  ];
  const result = parseBinanceKlineTuples(tuples);
  assert.deepEqual(result, [
    { time: 1700000000000, closeTime: 1700000299999, isClosed: true, open: 100.5, high: 110.2, low: 90.1, close: 105.3, volume: 42.7 },
    { time: 1700000300000, closeTime: 1700000599999, isClosed: false, open: 105.3, high: 108.0, low: 103.0, close: 104.0, volume: 17.1 },
  ]);
});

test("parseBinanceKlineTuples: empty input returns empty array", () => {
  assert.deepEqual(parseBinanceKlineTuples([]), []);
});
