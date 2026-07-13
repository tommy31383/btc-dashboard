import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeStandalone } from "./evaluate.mjs";
import { atrSeries, buildBiasSeries } from "./standalone.mjs";
import {
  buildMetricFeaturesByBar,
  METRIC_STANDALONE_CONFIGS,
  runMetricStandaloneConfig,
  selectMetricStandalone,
} from "./standalone-metrics.mjs";
import { loadFrozenInputs } from "./provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/research/btc-5m-2026-07-13");
const CACHE = path.join(REPO, ".cache/binance-futures-btcusdt-metrics-2020-09-2025-12.json");
const MANIFEST = path.join(ROOT, "artifacts/futures-metrics-full-manifest.json");
const TRADES = path.join(ROOT, "artifacts/standalone-metrics-discovery-trades.jsonl");
const LOCK = path.join(ROOT, "standalone-metrics-discovery-lock.json");
const WARMUP = Date.UTC(2020, 7, 1);
const START = Date.UTC(2020, 8, 1);
const END = Date.UTC(2024, 0, 1);
const SCENARIO = Object.freeze({ feeBps: 4, slippageBps: 2, intrabarOrder: "ADVERSE_FIRST" });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const metricBytes = readFileSync(CACHE);
if (sha256(metricBytes) !== manifest.combinedSha256) throw new Error("FULL_METRICS_CACHE_HASH_MISMATCH");
const metrics = JSON.parse(metricBytes).filter((row) => row.time < END);
const inputs = loadFrozenInputs();
const bars = inputs.bars5m.filter((bar) => bar.time >= WARMUP && bar.time < END);
const funding = inputs.funding.filter((row) => row.time >= WARMUP && row.time <= END);
const biasByIndex = buildBiasSeries(bars);
const atrByIndex = atrSeries(bars, 14);
const metricFeaturesByIndex = buildMetricFeaturesByBar(bars, metrics);
const tradesByConfig = Object.fromEntries(METRIC_STANDALONE_CONFIGS.map((config) => [
  config.id,
  runMetricStandaloneConfig({
    bars,
    funding,
    config,
    scenario: SCENARIO,
    biasByIndex,
    atrByIndex,
    metricFeaturesByIndex,
    startTime: START,
    endTime: END,
  }),
]));
const stats = Object.fromEntries(METRIC_STANDALONE_CONFIGS.map((config) => [
  config.id,
  summarizeStandalone(tradesByConfig[config.id]),
]));
const selection = selectMetricStandalone(stats);
const featureCoverage = metricFeaturesByIndex.reduce((counts, feature, index) => {
  if (bars[index].time < START) return counts;
  counts.total += 1;
  if (feature.available) counts.available += 1;
  else counts.reasons[feature.reason] = (counts.reasons[feature.reason] ?? 0) + 1;
  return counts;
}, { total: 0, available: 0, reasons: {} });
const lock = {
  schemaVersion: 1,
  lockedBeforeOos: new Date().toISOString(),
  role: "DISCOVERY_ONLY",
  split: { start: new Date(START).toISOString(), endExclusive: new Date(END).toISOString() },
  scenario: SCENARIO,
  featureCoverage,
  stats,
  selection,
  verdict: selection.method ? "DISCOVERY_CANDIDATE" : "DISCOVERY_NULL",
};
const tradeRows = METRIC_STANDALONE_CONFIGS.flatMap((config) => tradesByConfig[config.id]);
writeFileSync(TRADES, tradeRows.length
  ? `${tradeRows.map((trade) => JSON.stringify(trade)).join("\n")}\n`
  : "");
writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
console.log(JSON.stringify({
  trades: TRADES,
  lock: LOCK,
  tradeRows: tradeRows.length,
  featureCoverage,
  selectedFamily: selection.family,
  selectedMethod: selection.method,
  verdict: lock.verdict,
}));
