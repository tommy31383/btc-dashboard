import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMetricsCsv, requiredMetricDates } from "./metrics-data.mjs";
import { loadFrozenInputs } from "./provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const CACHE = path.join(REPO, ".cache/binance-futures-btcusdt-metrics-h01-windows.json");
const MANIFEST = path.join(
  REPO,
  "docs/research/btc-5m-2026-07-13/artifacts/futures-metrics-manifest.json",
);
const BASE = "https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT";
const START = Date.UTC(2020, 8, 1);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "BTC-PC-research/1.0" } });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error(`METRICS_DOWNLOAD_FAILED:${url}:${lastError?.message}`);
}

async function loadDate(date, temporary) {
  const filename = `BTCUSDT-metrics-${date}.zip`;
  const url = `${BASE}/${filename}`;
  const [zip, checksumBytes] = await Promise.all([
    fetchBytes(url),
    fetchBytes(`${url}.CHECKSUM`),
  ]);
  const expected = checksumBytes.toString("utf8").trim().split(/\s+/)[0];
  const actual = sha256(zip);
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
    throw new Error(`METRICS_CHECKSUM_MISMATCH:${date}:${actual}:${expected}`);
  }
  const zipPath = path.join(temporary, filename);
  writeFileSync(zipPath, zip);
  const csv = execFileSync("unzip", ["-p", zipPath], { maxBuffer: 2 * 1024 * 1024 })
    .toString("utf8");
  const rows = parseMetricsCsv(csv);
  return {
    rows,
    manifest: {
      date,
      filename,
      sha256: actual,
      rowCount: rows.length,
      firstTime: rows[0]?.time ?? null,
      lastTime: rows.at(-1)?.time ?? null,
    },
  };
}

async function mapConcurrent(values, concurrency, fn) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index], index);
      if ((index + 1) % 25 === 0 || index + 1 === values.length) {
        console.log(`metrics-download ${index + 1}/${values.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const inputs = loadFrozenInputs();
const eligibleSignals = inputs.signals.filter((signal) => signal.signalTime >= START);
if (eligibleSignals.length !== 87) {
  throw new Error(`METRICS_ELIGIBLE_SIGNAL_COUNT_INVALID:${eligibleSignals.length}`);
}
const dates = requiredMetricDates(eligibleSignals);
const temporary = mkdtempSync(path.join(tmpdir(), "btc-metrics-"));
try {
  const daily = await mapConcurrent(dates, 12, (date) => loadDate(date, temporary));
  const rows = daily.flatMap((item) => item.rows).sort((left, right) => left.time - right.time);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].time <= rows[index - 1].time) {
      throw new Error(`METRICS_COMBINED_TIME_INVALID:${index}`);
    }
  }
  const cacheBytes = Buffer.from(`${JSON.stringify(rows)}\n`);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: BASE,
    signalCount: eligibleSignals.length,
    dateCount: dates.length,
    firstDate: dates[0],
    lastDate: dates.at(-1),
    combinedRowCount: rows.length,
    combinedSha256: sha256(cacheBytes),
    archives: daily.map((item) => item.manifest),
  };
  mkdirSync(path.dirname(CACHE), { recursive: true });
  mkdirSync(path.dirname(MANIFEST), { recursive: true });
  writeFileSync(CACHE, cacheBytes);
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ cache: CACHE, manifest: MANIFEST, ...manifest, archives: undefined }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
