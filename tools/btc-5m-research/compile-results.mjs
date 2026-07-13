import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateTimingRows,
  summarizeFilteredMethod,
  summarizeMethod,
} from "./evaluate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ROOT = path.join(REPO, "docs/research/btc-5m-2026-07-13");

function json(name) {
  return JSON.parse(readFileSync(path.join(ROOT, name), "utf8"));
}

function jsonl(name) {
  return readFileSync(path.join(ROOT, name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const timingRows = jsonl("artifacts/h01-timing-rows.jsonl");
const timing = evaluateTimingRows(timingRows);
const filterRows = jsonl("artifacts/h01-filter-rows.jsonl");
const filterMethods = ["NR_E60", "NR_S6_60", "NR_S12_60", "TOXICITY_SKIP"];
const filter = Object.fromEntries(["discovery", "oos", "full"].map((split) => {
  const rows = split === "full" ? filterRows : filterRows.filter((row) => row.split === split);
  return [split, Object.fromEntries(Object.keys(rows[0].scenarios).map((scenario) => [
    scenario,
    {
      A: summarizeMethod(rows, scenario, "A"),
      ...Object.fromEntries(filterMethods.map((method) => [
        method,
        summarizeFilteredMethod(rows, scenario, method),
      ])),
    },
  ]))];
}));
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  h01TimingSelection: json("h01-selection-lock.json").selected,
  h01FilterSelection: json("h01-filter-selection-lock.json").selected,
  standaloneSelection: json("standalone-selection-lock.json"),
  h01Timing: timing,
  h01Filter: filter,
  standaloneDiscovery: json("artifacts/standalone-discovery.json"),
  standaloneOos: json("artifacts/standalone-oos.json"),
};
writeFileSync(path.join(ROOT, "results.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  output: path.join(ROOT, "results.json"),
  timingSelection: output.h01TimingSelection.method,
  filterSelection: output.h01FilterSelection.method,
  standaloneSelection: output.standaloneSelection.selected.configId,
}));
