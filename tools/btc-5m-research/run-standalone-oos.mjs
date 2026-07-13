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
const OUTPUT = path.join(REPO, "docs/research/btc-5m-2026-07-13/artifacts/standalone-oos.json");
const OOS_START = Date.UTC(2024, 0, 1);
const SCENARIOS = Object.freeze({
  primaryAdverse: Object.freeze({ feeBps: 4, slippageBps: 2, intrabarOrder: "ADVERSE_FIRST" }),
  primaryFavorable: Object.freeze({ feeBps: 4, slippageBps: 2, intrabarOrder: "FAVORABLE_FIRST" }),
  stressAdverse: Object.freeze({ feeBps: 6, slippageBps: 5, intrabarOrder: "ADVERSE_FIRST" }),
});

const frozen = loadFrozenInputs();
const bars = frozen.bars5m;
const funding = frozen.funding;
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
  const scenarios = {};
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const trades = runStandaloneConfig({
      bars,
      funding,
      config,
      scenario,
      biasByIndex,
      atrByIndex,
      compressionByIndex: key ? compressionCache.get(key) : null,
    }).filter((trade) => trade.signalTime >= OOS_START);
    scenarios[name] = summarizeStandalone(trades);
  }
  results.push({ config, scenarios });
  console.log(JSON.stringify({
    id: config.id,
    primaryN: scenarios.primaryAdverse.count,
    primaryNet: scenarios.primaryAdverse.netReturn,
    stressNet: scenarios.stressAdverse.netReturn,
  }));
}
writeFileSync(OUTPUT, `${JSON.stringify({
  schemaVersion: 1,
  split: "oos-audit-after-null-selection",
  startTime: OOS_START,
  endTime: bars.at(-1).time,
  scenarios: SCENARIOS,
  results,
}, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, configs: results.length }));
