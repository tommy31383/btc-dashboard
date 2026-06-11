import assert from "node:assert/strict";
import { analyzeKlines, Kline } from "../hooks/useBinanceKlines";
import { computeTrend } from "../utils/trend";

function bars(count: number, partial = false): Kline[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 50_000 + i * 20;
    return {
      time: i * 3_600_000,
      closeTime: (i + 1) * 3_600_000 - 1,
      isClosed: !partial || i < count - 1,
      open: close - 5,
      high: close + 20,
      low: close - 20,
      close,
      volume: 100 + i,
    };
  });
}

const closed4h = bars(220);
const closed1h = bars(220);
const withPartial4h = [...closed4h, { ...bars(1)[0], time: 999_000_000, isClosed: false, close: 10_000, high: 60_000, low: 9_000 }];
const withPartial1h = [...closed1h, { ...bars(1)[0], time: 999_000_000, isClosed: false, close: 10_000 }];

const confirmed = computeTrend({ klines4h: withPartial4h, klines1h: withPartial1h });
withPartial4h[withPartial4h.length - 1].close = 100_000;
withPartial1h[withPartial1h.length - 1].close = 100_000;
const movedPartial = computeTrend({ klines4h: withPartial4h, klines1h: withPartial1h });
assert.equal(movedPartial.value, confirmed.value, "partial price must not change confirmed trend");
assert.equal(movedPartial.zone, confirmed.zone, "partial price must not change confirmed zone");

const indicatorA = analyzeKlines(withPartial1h, "1h", "1H");
withPartial1h[withPartial1h.length - 1].close = 5_000;
const indicatorB = analyzeKlines(withPartial1h, "1h", "1H");
assert.equal(indicatorB.rsi, indicatorA.rsi, "partial price must not change confirmed RSI");

withPartial4h[withPartial4h.length - 1].isClosed = true;
const afterClose = computeTrend({ klines4h: withPartial4h, klines1h: withPartial1h });
assert.notEqual(afterClose.value, confirmed.value, "closing a new bar must update confirmed trend");

const allClosed = computeTrend({ klines4h: closed4h, klines1h: closed1h });
assert.equal(allClosed.confirmedBarTime, closed4h[closed4h.length - 1].time, "all-closed data must retain its last bar");

console.log("chart-v2 closed/partial tests passed");
