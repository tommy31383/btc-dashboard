import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectPlateau, summarizeMethod } from "./evaluate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RAW = path.join(REPO, "docs/research/btc-5m-2026-07-13/artifacts/h01-timing-rows.jsonl");
const OUTPUT = path.join(REPO, "docs/research/btc-5m-2026-07-13/h01-selection-lock.json");

const rawBytes = readFileSync(RAW);
const rows = rawBytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
const discovery = rows.filter((row) => row.split === "discovery");
if (discovery.length !== 78) throw new Error(`DISCOVERY_COUNT_INVALID:${discovery.length}`);
const methods = Object.keys(discovery[0].scenarios.primaryLowHigh);
const stats = Object.fromEntries(
  methods.map((method) => [method, summarizeMethod(discovery, "primaryLowHigh", method)]),
);
const selected = selectPlateau(stats);
const output = {
  schemaVersion: 1,
  selectionObservedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString("utf8").trim(),
  rawSha256: createHash("sha256").update(rawBytes).digest("hex"),
  contract: "Selection reads only rows where split=discovery; OOS rows existed but were not evaluated before this lock.",
  discoveryCount: discovery.length,
  scenario: "primaryLowHigh",
  stats,
  selected,
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, method: selected.method, family: selected.family }));
