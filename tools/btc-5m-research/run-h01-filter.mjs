import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFilterRows } from "./h01-filter-replay.mjs";
import { SCENARIOS } from "./h01-replay.mjs";
import { loadFrozenInputs } from "./provenance.mjs";
import { simulateChild } from "../../.worktrees/run-3-2026-07-12-execution-abcd/tools/h01-execution-abcd/execution.mjs";
import { loadExecutionOracle } from "../../.worktrees/run-3-2026-07-12-execution-abcd/tools/h01-execution-abcd/oracle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const TIMING = path.join(REPO, "docs/research/btc-5m-2026-07-13/artifacts/h01-timing-rows.jsonl");
const OUTPUT = path.join(REPO, "docs/research/btc-5m-2026-07-13/artifacts/h01-filter-rows.jsonl");

const timingRows = readFileSync(TIMING, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const inputs = loadFrozenInputs();
const oracle = await loadExecutionOracle();
const rows = buildFilterRows({
  ...inputs,
  timingRows,
  oracle,
  scenarios: SCENARIOS,
  simulate: simulateChild,
});
mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(JSON.stringify({ output: OUTPUT, rows: rows.length }));
