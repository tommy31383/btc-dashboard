import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeMethod } from "./evaluate.mjs";
import { buildMicroRows } from "./micro-ladder-replay.mjs";
import { MICRO_METHODS } from "./micro-ladder.mjs";
import { SCENARIOS } from "./h01-replay.mjs";
import { assertBaselineParity } from "./h01-timing.mjs";
import { loadFrozenInputs } from "./provenance.mjs";
import { simulateChild } from "../../.worktrees/run-3-2026-07-12-execution-abcd/tools/h01-execution-abcd/execution.mjs";
import { loadExecutionOracle } from "../../.worktrees/run-3-2026-07-12-execution-abcd/tools/h01-execution-abcd/oracle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUN3_COMMIT = "0eb49d6613e8a77f0ab8b537a450bec2704caeb3";
const RUN3_ROWS = "docs/research/run-3-2026-07-12-execution-abcd/artifacts/execution-rows.jsonl";
const ROOT = path.join(REPO, "docs/research/btc-5m-2026-07-13");
const OUTPUT = path.join(ROOT, "artifacts/micro-ladder-oos.jsonl");
const SUMMARY = path.join(ROOT, "micro-ladder-oos-audit.json");

function loadRun3Oos() {
  const bytes = execFileSync("git", ["show", `${RUN3_COMMIT}:${RUN3_ROWS}`], {
    cwd: REPO,
    maxBuffer: 32 * 1024 * 1024,
  });
  return bytes.toString("utf8").trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => new Date(row.signalTime).getUTCFullYear() >= 2024);
}

const inputs = loadFrozenInputs();
const signals = inputs.signals.filter(
  (signal) => new Date(signal.signalTime).getUTCFullYear() >= 2024,
);
if (signals.length !== 36) throw new Error(`MICRO_OOS_COUNT_INVALID:${signals.length}`);
const oracle = await loadExecutionOracle();
const rows = buildMicroRows({
  ...inputs,
  signals,
  oracle,
  simulate: simulateChild,
  scenarios: SCENARIOS,
});
assertBaselineParity(rows, loadRun3Oos(), Object.keys(SCENARIOS));
const stats = Object.fromEntries(Object.keys(SCENARIOS).map((scenario) => [
  scenario,
  Object.fromEntries(Object.keys(MICRO_METHODS).map((method) => [
    method,
    summarizeMethod(rows, scenario, method),
  ])),
]));
const audit = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  role: "AUDIT_ONLY_AFTER_DISCOVERY_NULL",
  sourceCount: rows.length,
  baselineParity: true,
  stats,
};
mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
writeFileSync(SUMMARY, `${JSON.stringify(audit, null, 2)}\n`);
console.log(JSON.stringify({
  output: OUTPUT,
  summary: SUMMARY,
  rows: rows.length,
  scenarios: Object.keys(SCENARIOS),
  baselineParity: true,
}));
