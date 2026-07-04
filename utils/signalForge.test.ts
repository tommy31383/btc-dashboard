import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SIGNAL_FORGE_CONFIG,
  SIGNAL_FORGE_INDICATOR_KEYS,
  cloneSignalForgeConfig,
  evaluateCompositeSignal,
  runSignalForge,
  type SignalForgeConfig,
  type SignalForgeKline,
} from "./signalForge";

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

function disabledConfig(): SignalForgeConfig {
  const config = cloneSignalForgeConfig(DEFAULT_SIGNAL_FORGE_CONFIG);
  for (const key of SIGNAL_FORGE_INDICATOR_KEYS) {
    config.indicators[key].enabled = false;
  }
  return config;
}

test("runSignalForge marks SMA bullish when fast SMA is above slow SMA", () => {
  const config = disabledConfig();
  config.indicators.sma = { ...config.indicators.sma, enabled: true, fastLength: 2, slowLength: 3 };
  const result = runSignalForge(candlesFromCloses([10, 11, 12, 13]), config);

  assert.equal(result.bars[result.bars.length - 1].states.sma, "Bullish");
});

test("runSignalForge marks SMA bearish when fast SMA is below slow SMA", () => {
  const config = disabledConfig();
  config.indicators.sma = { ...config.indicators.sma, enabled: true, fastLength: 2, slowLength: 3 };
  const result = runSignalForge(candlesFromCloses([13, 12, 11, 10]), config);

  assert.equal(result.bars[result.bars.length - 1].states.sma, "Bearish");
});

test("runSignalForge marks RSI bullish and bearish around configured thresholds", () => {
  const config = disabledConfig();
  config.indicators.rsi = { ...config.indicators.rsi, enabled: true, length: 2, longLevel: 70, shortLevel: 30 };
  const bullish = runSignalForge(candlesFromCloses([10, 11, 12, 13, 14]), config);
  const bearish = runSignalForge(candlesFromCloses([14, 13, 12, 11, 10]), config);

  assert.equal(bullish.bars[bullish.bars.length - 1].states.rsi, "Bullish");
  assert.equal(bearish.bars[bearish.bars.length - 1].states.rsi, "Bearish");
});

test("evaluateCompositeSignal requires all enabled indicators in AND mode", () => {
  assert.deepEqual(
    evaluateCompositeSignal({ sma: "Bullish", rsi: "Neutral" }, ["sma", "rsi"], true),
    { long: false, short: false }
  );
  assert.deepEqual(
    evaluateCompositeSignal({ sma: "Bullish", rsi: "Bullish" }, ["sma", "rsi"], true),
    { long: true, short: false }
  );
});

test("evaluateCompositeSignal accepts any enabled indicator in OR mode", () => {
  assert.deepEqual(
    evaluateCompositeSignal({ sma: "Neutral", rsi: "Bearish" }, ["sma", "rsi"], false),
    { long: false, short: true }
  );
  assert.deepEqual(
    evaluateCompositeSignal({ sma: "Bullish", rsi: "Neutral" }, ["sma", "rsi"], false),
    { long: true, short: false }
  );
});
