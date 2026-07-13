import { METHODS, buildMethodEntry } from "./h01-timing.mjs";

const FIVE_MINUTES_MS = 5 * 60_000;
const HORIZON_MS = 20 * 24 * 60 * 60_000;

export const SCENARIOS = Object.freeze({
  primaryLowHigh: Object.freeze({
    cost: Object.freeze({ feeBps: 4, marketSlippageBps: 2 }),
    intrabarOrder: "LOW_HIGH",
  }),
  primaryHighLow: Object.freeze({
    cost: Object.freeze({ feeBps: 4, marketSlippageBps: 2 }),
    intrabarOrder: "HIGH_LOW",
  }),
  stressLowHigh: Object.freeze({
    cost: Object.freeze({ feeBps: 6, marketSlippageBps: 5 }),
    intrabarOrder: "LOW_HIGH",
  }),
  stressHighLow: Object.freeze({
    cost: Object.freeze({ feeBps: 6, marketSlippageBps: 5 }),
    intrabarOrder: "HIGH_LOW",
  }),
});

function validateInputs({ bars5m, funding, signals, oracle, simulate, scenarios }) {
  if (
    !Array.isArray(bars5m) ||
    !bars5m.length ||
    !Array.isArray(funding) ||
    !Array.isArray(signals) ||
    !signals.length ||
    typeof oracle?.hedge01TrailingExit !== "function" ||
    typeof simulate !== "function" ||
    !scenarios ||
    !Object.keys(scenarios).length
  ) {
    throw new Error("H01_REPLAY_INPUT_INVALID");
  }
}

export function buildH01Rows({
  bars5m,
  funding,
  signals,
  oracle,
  simulate,
  scenarios = SCENARIOS,
}) {
  validateInputs({ bars5m, funding, signals, oracle, simulate, scenarios });
  const fiveMinuteIndex = new Map(bars5m.map((bar, index) => [bar.time, index]));
  const fundingPriceByTime = new Map(bars5m.map((bar) => [bar.time, bar.open]));
  return signals.map((signal) => {
    const signalIndex = fiveMinuteIndex.get(signal.signalTime);
    if (!Number.isSafeInteger(signalIndex)) {
      throw new Error(`SIGNAL_BAR_MISSING:${signal.setup}:${signal.signalTime}`);
    }
    const scenarioRows = {};
    for (const [scenarioName, scenario] of Object.entries(scenarios)) {
      const methods = {};
      for (const method of Object.values(METHODS)) {
        const child = buildMethodEntry(bars5m, signalIndex, method);
        const startIndex = fiveMinuteIndex.get(child.fillTime);
        const result = simulate({
          child,
          atr: signal.atr,
          bars5m,
          startIndex,
          funding,
          fundingPriceByTime,
          oracle,
          cost: scenario.cost,
          intrabarOrder: scenario.intrabarOrder,
          horizonMs: HORIZON_MS,
        });
        if (!result?.complete) {
          throw new Error(`TIMING_CHILD_INCOMPLETE:${signal.setup}:${signal.signalTime}:${scenarioName}:${method.id}`);
        }
        methods[method.id] = Object.freeze({
          ...result,
          entryImprovementAtr: (bars5m[signalIndex].open - result.fillPrice) / signal.atr,
          waitBars: (result.fillTime - signal.signalTime) / FIVE_MINUTES_MS,
          timedOut: result.fillReason === "TIMEOUT_MARKET",
        });
      }
      scenarioRows[scenarioName] = Object.freeze(methods);
    }
    return Object.freeze({
      setup: signal.setup,
      signalTime: signal.signalTime,
      split: new Date(signal.signalTime).getUTCFullYear() <= 2023 ? "discovery" : "oos",
      atr: signal.atr,
      scenarios: Object.freeze(scenarioRows),
    });
  });
}
