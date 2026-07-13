import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertBaselineParity } from "./h01-timing.mjs";
import { buildH01Rows, SCENARIOS } from "./h01-replay.mjs";
import { loadFrozenInputs } from "./provenance.mjs";
import { simulateChild } from "../../.worktrees/run-3-2026-07-12-execution-abcd/tools/h01-execution-abcd/execution.mjs";
import { loadExecutionOracle } from "../../.worktrees/run-3-2026-07-12-execution-abcd/tools/h01-execution-abcd/oracle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RUN3_COMMIT = "0eb49d6613e8a77f0ab8b537a450bec2704caeb3";
const RUN3_ROWS = "docs/research/run-3-2026-07-12-execution-abcd/artifacts/execution-rows.jsonl";
const OUTPUT = path.join(
  REPO,
  "docs/research/btc-5m-2026-07-13/artifacts/h01-timing-rows.jsonl",
);

function loadRun3Rows() {
  const bytes = execFileSync("git", ["show", `${RUN3_COMMIT}:${RUN3_ROWS}`], {
    cwd: REPO,
    maxBuffer: 32 * 1024 * 1024,
  });
  return bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const inputs = loadFrozenInputs();
const oracle = await loadExecutionOracle();
const rows = buildH01Rows({
  ...inputs,
  oracle,
  simulate: simulateChild,
});
assertBaselineParity(rows, loadRun3Rows(), Object.keys(SCENARIOS));

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

const splitCounts = rows.reduce((counts, row) => {
  counts[row.split] = (counts[row.split] ?? 0) + 1;
  return counts;
}, {});
console.log(JSON.stringify({ output: OUTPUT, rows: rows.length, splitCounts, baselineParity: true }));
