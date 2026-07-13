import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeMethod } from "./evaluate.mjs";
import { buildMetricsPolicyRows } from "./metrics-policy.mjs";
import { computeMetricsFeatures } from "./metrics-states.mjs";
import { loadFrozenInputs } from "./provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/research/btc-5m-2026-07-13");
const CACHE = path.join(REPO, ".cache/binance-futures-btcusdt-metrics-h01-windows.json");
const MANIFEST = path.join(ROOT, "artifacts/futures-metrics-manifest.json");
const DISCOVERY_LOCK = path.join(ROOT, "futures-metrics-discovery-lock.json");
const MICRO = path.join(ROOT, "artifacts/micro-ladder-oos.jsonl");
const FEATURES = path.join(ROOT, "artifacts/futures-metrics-oos-features.jsonl");
const OUTPUT = path.join(ROOT, "futures-metrics-oos-audit.json");

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
  return rows;
}

function loadJsonl(file) {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const discoveryLock = JSON.parse(readFileSync(DISCOVERY_LOCK, "utf8"));
const candidates = discoveryLock.selection?.candidates;
if (!Array.isArray(candidates) || candidates.length !== 1) {
  throw new Error(`METRICS_OOS_CANDIDATE_LOCK_INVALID:${JSON.stringify(candidates)}`);
}
const state = candidates[0];
const inputs = loadFrozenInputs();
const signals = inputs.signals.filter(
  (signal) => new Date(signal.signalTime).getUTCFullYear() >= 2024,
);
if (signals.length !== 36) throw new Error(`METRICS_OOS_SIGNAL_COUNT_INVALID:${signals.length}`);
const metrics = loadMetrics();
const indexByTime = new Map(inputs.bars5m.map((bar, index) => [bar.time, index]));
const featureRows = signals.map((signal) => {
  const signalIndex = indexByTime.get(signal.signalTime);
  if (!Number.isSafeInteger(signalIndex)) throw new Error(`METRICS_SIGNAL_BAR_MISSING:${signal.signalTime}`);
  return Object.freeze({
    setup: signal.setup,
    signalTime: signal.signalTime,
    split: "oos",
    features: computeMetricsFeatures({ metrics, bars5m: inputs.bars5m, signalIndex }),
  });
});
const featuresByKey = new Map(featureRows.map((row) => [
  `${row.setup}|${row.signalTime}`,
  row.features,
]));
const microRows = loadJsonl(MICRO);
if (microRows.length !== 36) throw new Error(`METRICS_MICRO_OOS_COUNT_INVALID:${microRows.length}`);
const policyRows = buildMetricsPolicyRows(microRows, featuresByKey);
const scenarios = Object.keys(policyRows[0]?.scenarios ?? {});
const stats = Object.fromEntries(scenarios.map((scenario) => [scenario, {
  A: summarizeMethod(policyRows, scenario, "A"),
  [state]: summarizeMethod(policyRows, scenario, state),
}]));
const primary = stats.primaryLowHigh;
const flaggedCount = policyRows.filter(
  (row) => row.scenarios.primaryLowHigh[state].stateFlagged,
).length;
const deltas = Object.fromEntries(scenarios.map((scenario) => [scenario, {
  netPnl: stats[scenario][state].netPnl - stats[scenario].A.netPnl,
  drawdown: stats[scenario][state].maxRealizedDrawdown - stats[scenario].A.maxRealizedDrawdown,
  dropTop20: stats[scenario][state].dropTop20NetPnl - stats[scenario].A.dropTop20NetPnl,
}]));
const byYearDelta = Object.fromEntries(["2024", "2025"].map((year) => [
  year,
  primary[state].byYear[year].netPnl - primary.A.byYear[year].netPnl,
]));
const qualifies =
  flaggedCount >= 8 &&
  deltas.primaryLowHigh.netPnl > 0 &&
  deltas.primaryLowHigh.drawdown <= 0 &&
  deltas.primaryLowHigh.dropTop20 > 0 &&
  Object.values(byYearDelta).every((value) => value >= 0) &&
  scenarios.filter((scenario) => scenario !== "primaryLowHigh")
    .every((scenario) => deltas[scenario].netPnl > 0);
const unavailableReasons = featureRows.reduce((counts, row) => {
  if (!row.features.available) counts[row.features.reason] = (counts[row.features.reason] ?? 0) + 1;
  return counts;
}, {});
const audit = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  role: "CONDITIONAL_OOS_AFTER_DISCOVERY_LOCK",
  state,
  sourceSignals: signals.length,
  featureAvailableSignals: policyRows.length,
  unavailableReasons,
  flaggedCount,
  stats,
  deltas,
  byYearDelta,
  qualifies,
  verdict: qualifies ? "EXPLORATORY_FORWARD_CANDIDATE" : "REJECT",
};
writeFileSync(FEATURES, `${featureRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
writeFileSync(OUTPUT, `${JSON.stringify(audit, null, 2)}\n`);
console.log(JSON.stringify({
  features: FEATURES,
  output: OUTPUT,
  state,
  sourceSignals: signals.length,
  featureAvailableSignals: policyRows.length,
  unavailableReasons,
  flaggedCount,
  deltas,
  byYearDelta,
  verdict: audit.verdict,
}));
