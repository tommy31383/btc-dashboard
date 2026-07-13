import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeMethod } from "./evaluate.mjs";
import {
  buildMetricsPolicyRows,
  METRICS_STATES,
  selectMetricsDiscovery,
} from "./metrics-policy.mjs";
import { computeMetricsFeatures } from "./metrics-states.mjs";
import { loadFrozenInputs } from "./provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/research/btc-5m-2026-07-13");
const CACHE = path.join(REPO, ".cache/binance-futures-btcusdt-metrics-h01-windows.json");
const MANIFEST = path.join(ROOT, "artifacts/futures-metrics-manifest.json");
const MICRO = path.join(ROOT, "artifacts/micro-ladder-discovery.jsonl");
const FEATURES = path.join(ROOT, "artifacts/futures-metrics-discovery-features.jsonl");
const LOCK = path.join(ROOT, "futures-metrics-discovery-lock.json");
const START = Date.UTC(2020, 8, 1);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadMetrics() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const bytes = readFileSync(CACHE);
  if (sha256(bytes) !== manifest.combinedSha256) throw new Error("METRICS_CACHE_HASH_MISMATCH");
  const rows = JSON.parse(bytes);
  if (!Array.isArray(rows) || rows.length !== manifest.combinedRowCount) {
    throw new Error("METRICS_CACHE_COUNT_MISMATCH");
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].time <= rows[index - 1].time) throw new Error(`METRICS_CACHE_ORDER_INVALID:${index}`);
  }
  return rows;
}

function loadJsonl(file) {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const inputs = loadFrozenInputs();
const signals = inputs.signals.filter(
  (signal) => signal.signalTime >= START && new Date(signal.signalTime).getUTCFullYear() <= 2023,
);
if (signals.length !== 51) throw new Error(`METRICS_DISCOVERY_SIGNAL_COUNT_INVALID:${signals.length}`);
const metrics = loadMetrics();
const indexByTime = new Map(inputs.bars5m.map((bar, index) => [bar.time, index]));
const featureRows = signals.map((signal) => {
  const signalIndex = indexByTime.get(signal.signalTime);
  if (!Number.isSafeInteger(signalIndex)) throw new Error(`METRICS_SIGNAL_BAR_MISSING:${signal.signalTime}`);
  return Object.freeze({
    setup: signal.setup,
    signalTime: signal.signalTime,
    split: "discovery",
    features: computeMetricsFeatures({ metrics, bars5m: inputs.bars5m, signalIndex }),
  });
});
const featuresByKey = new Map(featureRows.map((row) => [
  `${row.setup}|${row.signalTime}`,
  row.features,
]));
const microRows = loadJsonl(MICRO).filter((row) => row.signalTime >= START);
if (microRows.length !== 51) throw new Error(`METRICS_MICRO_DISCOVERY_COUNT_INVALID:${microRows.length}`);
const policyRows = buildMetricsPolicyRows(microRows, featuresByKey);
const baseline = summarizeMethod(policyRows, "primaryLowHigh", "A");
const summaries = Object.fromEntries(METRICS_STATES.map((state) => {
  const summary = summarizeMethod(policyRows, "primaryLowHigh", state);
  return [state, {
    ...summary,
    flaggedCount: policyRows.filter(
      (row) => row.scenarios.primaryLowHigh[state].stateFlagged,
    ).length,
  }];
}));
const selection = selectMetricsDiscovery(baseline, summaries);
const unavailableReasons = featureRows.reduce((counts, row) => {
  if (!row.features.available) counts[row.features.reason] = (counts[row.features.reason] ?? 0) + 1;
  return counts;
}, {});
const lock = {
  schemaVersion: 1,
  lockedBeforeConditionalOos: new Date().toISOString(),
  role: "DISCOVERY_ONLY",
  sourceSignals: signals.length,
  featureAvailableSignals: policyRows.length,
  unavailableReasons,
  baseline,
  summaries,
  selection,
  verdict: selection.candidates.length ? "DISCOVERY_CANDIDATES" : "DISCOVERY_NULL",
};
writeFileSync(FEATURES, `${featureRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
console.log(JSON.stringify({
  features: FEATURES,
  lock: LOCK,
  sourceSignals: signals.length,
  featureAvailableSignals: policyRows.length,
  unavailableReasons,
  candidates: selection.candidates,
  verdict: lock.verdict,
}));
