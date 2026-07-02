import test from "node:test";
import assert from "node:assert/strict";
import { klinesToCandlestickData, klinesToVolumeData } from "./chartDataMapper";

test("klinesToCandlestickData converts ms time to seconds and maps OHLC", () => {
  const klines = [
    { time: 1719800000000, open: 100, high: 110, low: 90, close: 105, volume: 50 },
    { time: 1719800300000, open: 105, high: 108, low: 102, close: 106, volume: 40 },
  ];
  const result = klinesToCandlestickData(klines);
  assert.deepEqual(result, [
    { time: 1719800000, open: 100, high: 110, low: 90, close: 105 },
    { time: 1719800300, open: 105, high: 108, low: 102, close: 106 },
  ]);
});

test("klinesToVolumeData converts time to seconds and colors by direction", () => {
  const klines = [
    { time: 1719800000000, open: 100, high: 110, low: 90, close: 105, volume: 50 }, // up (close>=open)
    { time: 1719800300000, open: 105, high: 108, low: 90, close: 100, volume: 40 }, // down
  ];
  const result = klinesToVolumeData(klines, { upColor: "#2ed573", downColor: "#ff4757" });
  assert.equal(result[0].time, 1719800000);
  assert.equal(result[0].value, 50);
  assert.equal(result[0].color, "#2ed573");
  assert.equal(result[1].color, "#ff4757");
});

test("klinesToCandlestickData returns empty array for empty input", () => {
  assert.deepEqual(klinesToCandlestickData([]), []);
});
