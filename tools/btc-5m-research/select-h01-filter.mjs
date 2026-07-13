import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectFilter, summarizeFilteredMethod, summarizeMethod } from "./evaluate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RAW = path.join(REPO, "docs/research/btc-5m-2026-07-13/artifacts/h01-filter-rows.jsonl");
const OUTPUT = path.join(REPO, "docs/research/btc-5m-2026-07-13/h01-filter-selection-lock.json");

const bytes = readFileSync(RAW);
const rows = bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
const discovery = rows.filter((row) => row.split === "discovery");
if (discovery.length !== 78) throw new Error(`FILTER_DISCOVERY_COUNT_INVALID:${discovery.length}`);
const scenario = "primaryLowHigh";
const baseline = summarizeMethod(discovery, scenario, "A");
const methods = ["NR_E60", "NR_S6_60", "NR_S12_60", "TOXICITY_SKIP"];
const candidates = Object.fromEntries(
  methods.map((method) => [method, summarizeFilteredMethod(discovery, scenario, method)]),
);
const selected = selectFilter(baseline, candidates);
const output = {
  schemaVersion: 1,
  selectionObservedAt: new Date().toISOString(),
  rawSha256: createHash("sha256").update(bytes).digest("hex"),
  contract: "Selection reads only discovery rows. Skipped outcomes are zero; skipped baseline outcomes are tagged SIMULATED counterfactual evidence.",
  discoveryCount: discovery.length,
  scenario,
  baseline,
  candidates,
  selected,
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, method: selected.method }));
