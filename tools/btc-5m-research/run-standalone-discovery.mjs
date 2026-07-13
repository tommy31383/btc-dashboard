import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeStandalone } from "./evaluate.mjs";
import { loadFrozenInputs } from "./provenance.mjs";
import {
  STANDALONE_CONFIGS,
  atrSeries,
  buildBiasSeries,
  compressionFlags,
  runStandaloneConfig,
} from "./standalone.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const OUTPUT = path.join(REPO, "docs/research/btc-5m-2026-07-13/artifacts/standalone-discovery.json");
const CUTOFF = Date.UTC(2024, 0, 1);
const SCENARIO = Object.freeze({ feeBps: 4, slippageBps: 2, intrabarOrder: "ADVERSE_FIRST" });

const frozen = loadFrozenInputs();
const bars = frozen.bars5m.filter((bar) => bar.time < CUTOFF);
const funding = frozen.funding.filter((row) => row.time < CUTOFF);
const biasByIndex = buildBiasSeries(bars);
const atrByIndex = atrSeries(bars, 14);
const compressionCache = new Map();
const results = [];
for (const config of STANDALONE_CONFIGS) {
  const key = config.family === "COMPRESSION_EXPANSION"
    ? `${config.compressionBars}|${config.rangePercentile}`
    : null;
  if (key && !compressionCache.has(key)) {
    compressionCache.set(key, compressionFlags(
      bars,
      config.compressionBars,
      config.rangePercentile,
      config.compressionLookbackBars,
    ));
  }
  const trades = runStandaloneConfig({
    bars,
    funding,
    config,
    scenario: SCENARIO,
    biasByIndex,
    atrByIndex,
    compressionByIndex: key ? compressionCache.get(key) : null,
  });
  const summary = summarizeStandalone(trades);
  results.push({ config, summary });
  console.log(JSON.stringify({ id: config.id, count: summary.count, netReturn: summary.netReturn }));
}
writeFileSync(OUTPUT, `${JSON.stringify({
  schemaVersion: 1,
  split: "discovery",
  startTime: bars[0].time,
  endExclusive: CUTOFF,
  scenario: SCENARIO,
  results,
}, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, configs: results.length }));
