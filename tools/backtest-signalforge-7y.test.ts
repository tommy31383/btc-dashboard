import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNAL_FORGE_INDICATOR_KEYS } from "../utils/signalForge";
import {
  aggregateBars,
  buildSignalForgeBacktestConfig,
  summarizeClosedTrades,
  type Candle,
  type ClosedSignalForgeTrade,
} from "./backtest-signalforge-7y";

function candle(time: number, open: number, high: number, low: number, close: number, volume = 1): Candle {
  return { time, open, high, low, close, volume };
}

test("aggregateBars rolls fixed-minute bars with OHLCV semantics", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const bars = aggregateBars(
    [
      candle(t0, 100, 101, 99, 100, 1),
      candle(t0 + 5 * 60_000, 100, 102, 98, 101, 2),
      candle(t0 + 10 * 60_000, 101, 103, 100, 102, 3),
      candle(t0 + 15 * 60_000, 102, 104, 101, 103, 4),
    ],
    "15m"
  );

  assert.deepEqual(bars, [
    candle(t0, 100, 103, 98, 102, 6),
    candle(t0 + 15 * 60_000, 102, 104, 101, 103, 4),
  ]);
});

test("aggregateBars uses UTC calendar buckets for monthly bars", () => {
  const jan1 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const jan31 = Date.UTC(2026, 0, 31, 23, 55, 0);
  const feb1 = Date.UTC(2026, 1, 1, 0, 0, 0);

  const bars = aggregateBars(
    [
      candle(jan1, 10, 11, 9, 10, 5),
      candle(jan31, 10, 15, 8, 14, 7),
      candle(feb1, 14, 16, 13, 15, 11),
    ],
    "1mo"
  );

  assert.deepEqual(bars, [
    candle(Date.UTC(2026, 0, 1), 10, 15, 8, 14, 12),
    candle(Date.UTC(2026, 1, 1), 14, 16, 13, 15, 11),
  ]);
});

test("buildSignalForgeBacktestConfig enables all indicators and toggles ATR risk", () => {
  const andNoRisk = buildSignalForgeBacktestConfig(true, "signalOnly");
  assert.equal(andNoRisk.logic.requireAll, true);
  assert.equal(andNoRisk.risk.enableTp, false);
  assert.equal(andNoRisk.risk.enableSl, false);
  assert.equal(andNoRisk.risk.enableTs, false);

  const orRisk = buildSignalForgeBacktestConfig(false, "atrRisk");
  assert.equal(orRisk.logic.requireAll, false);
  assert.equal(orRisk.risk.enableTp, true);
  assert.equal(orRisk.risk.enableSl, true);
  assert.equal(orRisk.risk.enableTs, true);
  assert.equal(orRisk.risk.tpMultiplier, 2);
  assert.equal(orRisk.risk.slMultiplier, 1.5);
  assert.equal(orRisk.risk.tsMultiplier, 1);

  for (const key of SIGNAL_FORGE_INDICATOR_KEYS) {
    assert.equal(orRisk.indicators[key].enabled, true, `${key} should be enabled`);
  }
});

test("summarizeClosedTrades applies round-trip fees, equity stats, and yearly reliability flags", () => {
  const trades: ClosedSignalForgeTrade[] = [
    {
      side: "long",
      entryTime: Date.UTC(2019, 0, 1),
      exitTime: Date.UTC(2019, 0, 2),
      entryPrice: 100,
      exitPrice: 101,
      pnlPct: 1,
      exitReason: "oppositeSignal",
    },
    {
      side: "short",
      entryTime: Date.UTC(2019, 0, 3),
      exitTime: Date.UTC(2019, 0, 4),
      entryPrice: 100,
      exitPrice: 100.5,
      pnlPct: -0.5,
      exitReason: "oppositeSignal",
    },
    {
      side: "long",
      entryTime: Date.UTC(2020, 0, 1),
      exitTime: Date.UTC(2020, 0, 2),
      entryPrice: 100,
      exitPrice: 102,
      pnlPct: 2,
      exitReason: "takeProfit",
    },
  ];

  const stats = summarizeClosedTrades(trades, ["2019", "2020", "2021"], 0.05);

  assert.equal(stats.totalTrades, 3);
  assert.equal(stats.winRate, 66.67);
  assert.equal(stats.profitFactor, 4.67);
  assert.equal(stats.netPnlPct, 2.2);
  assert.equal(stats.maxDrawdownPct, 0.6);
  assert.deepEqual(stats.equityCurve, [0.9, 0.3, 2.2]);
  assert.equal(stats.equityTrend, "UP");
  assert.equal(stats.byYear["2019"].trades, 2);
  assert.equal(stats.byYear["2019"].netPnlPct, 0.3);
  assert.equal(stats.byYear["2019"].reliable, false);
  assert.match(stats.byYear["2019"].note ?? "", /n<20/);
  assert.equal(stats.byYear["2021"].trades, 0);
  assert.equal(stats.byYear["2021"].reliable, false);
});
