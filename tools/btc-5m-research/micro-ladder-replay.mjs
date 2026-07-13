import { causalAtr } from "./h01-filter.mjs";
import { buildMicroPlan, MICRO_METHODS } from "./micro-ladder.mjs";

const HORIZON_MS = 20 * 24 * 60 * 60_000;

function sum(children, field) {
  return children.reduce((total, child) => total + child[field], 0);
}

export function aggregateMicroChildren(method, children, baselineOpen, signalAtr) {
  if (
    typeof method !== "string" ||
    !method ||
    !Array.isArray(children) ||
    !children.length ||
    children.some((child) => !child?.complete) ||
    !Number.isFinite(baselineOpen) ||
    !Number.isFinite(signalAtr) ||
    signalAtr <= 0
  ) {
    throw new Error("MICRO_AGGREGATE_INPUT_INVALID");
  }
  const filledWeight = sum(children, "weight");
  if (Math.abs(filledWeight - 1) > 1e-12) {
    throw new Error(`MICRO_AGGREGATE_WEIGHT_INVALID:${filledWeight}`);
  }
  const fillPrice = children.reduce(
    (total, child) => total + child.weight * child.fillPrice,
    0,
  );
  const exitPrice = children.reduce(
    (total, child) => total + child.weight * child.exitPrice,
    0,
  );
  return Object.freeze({
    method,
    complete: true,
    children: Object.freeze(children),
    childOrders: children.length,
    filledWeight,
    fillTime: Math.min(...children.map((child) => child.fillTime)),
    fillPrice,
    exitTime: Math.max(...children.map((child) => child.exitTime)),
    exitPrice,
    holdMs: children.reduce(
      (total, child) => total + child.weight * child.holdMs,
      0,
    ),
    grossEntryNotional: sum(children, "grossEntryNotional"),
    grossPnl: sum(children, "grossPnl"),
    fundingPnl: sum(children, "fundingPnl"),
    fundingProxyCount: sum(children, "fundingProxyCount"),
    fees: sum(children, "fees"),
    netPnl: sum(children, "netPnl"),
    entryImprovementAtr: (baselineOpen - fillPrice) / signalAtr,
    timedOut: children.some((child) => child.fillReason === "TIMEOUT_MARKET"),
    mfe24Atr: children.reduce(
      (total, child) => total + child.weight * child.mfe24Atr,
      0,
    ),
    mae24Atr: children.reduce(
      (total, child) => total + child.weight * child.mae24Atr,
      0,
    ),
  });
}

export function buildMicroRows({
  bars5m,
  funding,
  signals,
  oracle,
  simulate,
  scenarios,
  atrAt = causalAtr,
}) {
  if (
    !Array.isArray(bars5m) ||
    !bars5m.length ||
    !Array.isArray(funding) ||
    !Array.isArray(signals) ||
    !signals.length ||
    typeof oracle?.hedge01TrailingExit !== "function" ||
    typeof simulate !== "function" ||
    typeof atrAt !== "function" ||
    !scenarios ||
    !Object.keys(scenarios).length
  ) {
    throw new Error("MICRO_REPLAY_INPUT_INVALID");
  }
  const indexByTime = new Map(bars5m.map((bar, index) => [bar.time, index]));
  const fundingPriceByTime = new Map(bars5m.map((bar) => [bar.time, bar.open]));
  return signals.map((signal) => {
    const signalIndex = indexByTime.get(signal.signalTime);
    if (!Number.isSafeInteger(signalIndex)) {
      throw new Error(`MICRO_SIGNAL_BAR_MISSING:${signal.setup}:${signal.signalTime}`);
    }
    const atr5 = atrAt(bars5m, signalIndex, 14);
    const scenarioRows = {};
    for (const [scenarioName, scenario] of Object.entries(scenarios)) {
      const methods = {};
      for (const method of Object.values(MICRO_METHODS)) {
        const plan = buildMicroPlan(bars5m, signalIndex, atr5, method);
        const children = plan.map((child) => simulate({
          child,
          atr: signal.atr,
          bars5m,
          startIndex: indexByTime.get(child.fillTime),
          funding,
          fundingPriceByTime,
          oracle,
          cost: scenario.cost,
          intrabarOrder: scenario.intrabarOrder,
          horizonMs: HORIZON_MS,
        }));
        if (children.some((child) => !child?.complete)) {
          throw new Error(`MICRO_CHILD_INCOMPLETE:${signal.setup}:${signal.signalTime}:${scenarioName}:${method.id}`);
        }
        methods[method.id] = aggregateMicroChildren(
          method.id,
          children,
          bars5m[signalIndex].open,
          signal.atr,
        );
      }
      scenarioRows[scenarioName] = Object.freeze(methods);
    }
    return Object.freeze({
      setup: signal.setup,
      signalTime: signal.signalTime,
      split: new Date(signal.signalTime).getUTCFullYear() <= 2023 ? "discovery" : "oos",
      atr: signal.atr,
      atr5,
      scenarios: Object.freeze(scenarioRows),
    });
  });
}
