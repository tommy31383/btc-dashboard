import { classifyToxicity } from "./h01-filter.mjs";

const HORIZON_MS = 20 * 24 * 60 * 60_000;
const NO_RECLAIM = Object.freeze({
  NR_E60: "E60",
  NR_S6_60: "S6_60",
  NR_S12_60: "S12_60",
});

function wrapRetained(value, reason) {
  return Object.freeze({ ...value, skipped: false, filterReason: reason });
}

function skipped(reason) {
  return Object.freeze({ skipped: true, filterReason: reason });
}

export function buildFilterRows({
  bars5m,
  funding,
  signals,
  timingRows,
  oracle,
  scenarios,
  simulate,
}) {
  if (
    !Array.isArray(bars5m) ||
    !Array.isArray(funding) ||
    !Array.isArray(signals) ||
    !Array.isArray(timingRows) ||
    typeof oracle?.hedge01TrailingExit !== "function" ||
    typeof simulate !== "function"
  ) {
    throw new Error("FILTER_REPLAY_INPUT_INVALID");
  }
  const indexByTime = new Map(bars5m.map((bar, index) => [bar.time, index]));
  const timingByKey = new Map(timingRows.map((row) => [`${row.setup}|${row.signalTime}`, row]));
  const fundingPriceByTime = new Map(bars5m.map((bar) => [bar.time, bar.open]));
  return signals.map((signal) => {
    const key = `${signal.setup}|${signal.signalTime}`;
    const timing = timingByKey.get(key);
    const signalIndex = indexByTime.get(signal.signalTime);
    if (!timing || !Number.isSafeInteger(signalIndex)) throw new Error(`FILTER_SOURCE_MISSING:${key}`);
    const toxicity = classifyToxicity(bars5m, signalIndex);
    const scenarioRows = {};
    for (const [scenarioName, scenario] of Object.entries(scenarios)) {
      const source = timing.scenarios?.[scenarioName];
      if (!source?.A) throw new Error(`FILTER_SCENARIO_MISSING:${key}:${scenarioName}`);
      const methods = { A: wrapRetained(source.A, "BASELINE") };
      for (const [method, sourceMethod] of Object.entries(NO_RECLAIM)) {
        const value = source[sourceMethod];
        methods[method] = value.timedOut
          ? skipped("NO_RECLAIM")
          : wrapRetained(value, "RECLAIM_CONFIRMED");
      }
      if (toxicity.skip) {
        methods.TOXICITY_SKIP = skipped("TOXIC_FIRST_15M");
      } else {
        const entryBar = bars5m[toxicity.fillIndex];
        const child = {
          method: "TOXICITY_SKIP",
          weight: 1,
          fillTime: entryBar.time,
          rawFillPrice: entryBar.open,
          fillKind: "MARKET",
          fillReason: "TOXICITY_PASS",
          fillPhase: "OPEN",
        };
        const value = simulate({
          child,
          atr: signal.atr,
          bars5m,
          startIndex: toxicity.fillIndex,
          funding,
          fundingPriceByTime,
          oracle,
          cost: scenario.cost,
          intrabarOrder: scenario.intrabarOrder,
          horizonMs: HORIZON_MS,
        });
        if (!value?.complete) throw new Error(`FILTER_CHILD_INCOMPLETE:${key}:${scenarioName}`);
        methods.TOXICITY_SKIP = wrapRetained({
          ...value,
          entryImprovementAtr: (bars5m[signalIndex].open - value.fillPrice) / signal.atr,
          timedOut: false,
          toxicity,
        }, "TOXICITY_PASS");
      }
      scenarioRows[scenarioName] = Object.freeze(methods);
    }
    return Object.freeze({
      setup: signal.setup,
      signalTime: signal.signalTime,
      split: new Date(signal.signalTime).getUTCFullYear() <= 2023 ? "discovery" : "oos",
      scenarios: Object.freeze(scenarioRows),
    });
  });
}
