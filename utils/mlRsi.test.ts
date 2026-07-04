import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ML_RSI_CONFIG,
  calculateMlRsiFeatureSeries,
  evaluateMlRsiSignals,
  runMlRsi,
  selectNearestMlRsiNeighbors,
  type MlRsiBankRow,
  type MlRsiConfig,
  type MlRsiFeatureVector,
  type MlRsiSignalInputBar,
} from "./mlRsi";
import type { SignalForgeKline } from "./signalForge";

function candlesFromCloses(closes: number[]): SignalForgeKline[] {
  return closes.map((close, i) => ({
    time: i * 60_000,
    open: i === 0 ? close : closes[i - 1],
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + i,
  }));
}

function syntheticCandles(count: number): SignalForgeKline[] {
  const candles: SignalForgeKline[] = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    close += Math.sin(i / 5) * 1.3 + (i % 23 < 12 ? 0.45 : -0.35);
    candles.push({
      time: i * 60_000,
      open: close - 0.25,
      high: close + 1.4,
      low: close - 1.2,
      close,
      volume: 1000 + i,
    });
  }
  return candles;
}

function config(overrides: Partial<MlRsiConfig> = {}): MlRsiConfig {
  return { ...DEFAULT_ML_RSI_CONFIG, ...overrides };
}

test("calculateMlRsiFeatureSeries maps base RSI into normalized value and midpoint features", () => {
  const features = calculateMlRsiFeatureSeries(candlesFromCloses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), config({ rsiBase: 2, winLen: 5 }));
  const firstReady = features.find((feature): feature is MlRsiFeatureVector => feature !== null);

  assert.ok(firstReady);
  assert.equal(firstReady.value, 1);
  assert.equal(firstReady.mid, 1);
  for (const value of Object.values(firstReady)) {
    assert.ok(value >= 0 && value <= 1);
  }
});

test("selectNearestMlRsiNeighbors keeps the k smallest weighted Lorentzian gaps", () => {
  const current: MlRsiFeatureVector = { value: 0, slope: 0, accel: 0, mid: 0, pct: 0, churn: 0, spread: 0, regime: 0 };
  const rows: MlRsiBankRow[] = [
    { sourceIndex: 10, features: { ...current, value: 0.4 }, outcome: 1 },
    { sourceIndex: 11, features: { ...current, value: 0.05 }, outcome: -1 },
    { sourceIndex: 12, features: { ...current, value: 0.8 }, outcome: 2 },
    { sourceIndex: 13, features: { ...current, value: 0.1 }, outcome: -2 },
  ];

  const nearest = selectNearestMlRsiNeighbors(current, rows, DEFAULT_ML_RSI_CONFIG.manualWeights, 2, 1);

  assert.deepEqual(
    nearest.map((neighbor) => neighbor.row.sourceIndex),
    [11, 13]
  );
  assert.ok(nearest[0].gap <= nearest[1].gap);
});

test("runMlRsi keeps rank and confidence scores inside 0..100", () => {
  const result = runMlRsi(syntheticCandles(220), config({ autoMinRows: 10 }));

  for (const score of [...result.rank, ...result.confidence]) {
    if (score === null) continue;
    assert.ok(score >= 0 && score <= 100);
  }
});

test("evaluateMlRsiSignals requires qualification, cooldown, and confirmed bars", () => {
  const bars: MlRsiSignalInputBar[] = [
    { index: 0, time: 0, price: 100, biasDir: 0, rank: 59, confidence: 80, gatesPass: true, confirmed: true },
    { index: 1, time: 60_000, price: 101, biasDir: 1, rank: 80, confidence: 80, gatesPass: true, confirmed: true },
    { index: 2, time: 120_000, price: 99, biasDir: -1, rank: 80, confidence: 80, gatesPass: false, confirmed: true },
    { index: 6, time: 360_000, price: 98, biasDir: -1, rank: 80, confidence: 80, gatesPass: true, confirmed: true },
    { index: 10, time: 600_000, price: 102, biasDir: 1, rank: 80, confidence: 80, gatesPass: true, confirmed: false },
  ];

  const signals = evaluateMlRsiSignals(bars, config({ gateRank: 60, gateConf: 50 }));

  assert.deepEqual(
    signals.map((signal) => [signal.index, signal.side]),
    [
      [1, "long"],
      [6, "short"],
    ]
  );
});
