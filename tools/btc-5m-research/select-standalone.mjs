import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { selectStandalone } from "./evaluate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const RAW = path.join(REPO, "docs/research/btc-5m-2026-07-13/artifacts/standalone-discovery.json");
const OUTPUT = path.join(REPO, "docs/research/btc-5m-2026-07-13/standalone-selection-lock.json");

const bytes = readFileSync(RAW);
const discovery = JSON.parse(bytes.toString("utf8"));
const selected = selectStandalone(discovery.results);
const output = {
  schemaVersion: 1,
  selectionObservedAt: new Date().toISOString(),
  rawSha256: createHash("sha256").update(bytes).digest("hex"),
  selectionRule: "A family needs >=75% configs with netReturn>0 and dropTop20NetReturn>0; representative is closest to family median.",
  selected,
  verdict: selected.configId ? "OOS_CANDIDATE" : "REJECT_DISCOVERY",
};
writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ output: OUTPUT, ...selected }));
