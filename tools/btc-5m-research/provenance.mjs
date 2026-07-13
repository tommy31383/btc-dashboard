import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const FIVE_MINUTES_MS = 5 * 60_000;
const SETUPS = Object.freeze(["S12", "S13", "S14"]);

export const EXPECTED = Object.freeze({
  fiveMinute: Object.freeze({
    path: path.join(REPO, ".cache/binance-futures-btcusdt-5m-run3.json"),
    sha256: "57d6d4d9ececb67cd8362123635cbb78bc0d29039d82586825a25e7b1897a8c1",
    rowCount: 719_413,
    firstTime: 1_567_965_300_000,
    lastTime: 1_783_788_900_000,
  }),
  funding: Object.freeze({
    path: path.join(REPO, ".cache/binance-futures-btcusdt-funding-7y.json"),
    sha256: "5dc6289ba8253c28f6506a2ad7bb3c987c7950e19be0b3567aa1dea3dd2dd08e",
    rowCount: 7_490,
    firstTime: 1_568_102_400_000,
    lastTime: 1_783_785_600_000,
  }),
  signals: Object.freeze({
    commit: "0eb49d6613e8a77f0ab8b537a450bec2704caeb3",
    path: "docs/research/run-2-2026-07-12/artifacts/entry-quality-signals.jsonl",
    sha256: "d72ad3c684b726a1539e60754f805f37d7a25d81c7fcf027011b1dbd7fa721c9",
    rowCount: 114,
    counts: Object.freeze({ S12: 2, S13: 44, S14: 68 }),
  }),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertFuturesCachePath(cachePath) {
  if (
    typeof cachePath !== "string" ||
    !path.basename(cachePath).startsWith("binance-futures-btcusdt-")
  ) {
    throw new Error(`SPOT_CACHE_FORBIDDEN:${cachePath}`);
  }
  return cachePath;
}

function validBar(row) {
  return (
    row &&
    Number.isSafeInteger(row.time) &&
    [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) &&
    row.open > 0 &&
    row.high >= Math.max(row.open, row.close) &&
    row.low <= Math.min(row.open, row.close) &&
    row.low > 0 &&
    row.volume >= 0
  );
}

export function parseBars(bytes, expected) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (expected?.sha256 && sha256(buffer) !== expected.sha256) {
    throw new Error("HASH_MISMATCH");
  }
  const rows = JSON.parse(buffer.toString("utf8"));
  if (!Array.isArray(rows) || rows.length !== expected?.rowCount) {
    throw new Error(`BAR_COUNT_MISMATCH:${rows?.length}:${expected?.rowCount}`);
  }
  rows.forEach((row, index) => {
    if (
      !validBar(row) ||
      (index > 0 && row.time !== rows[index - 1].time + FIVE_MINUTES_MS)
    ) {
      throw new Error(`BAR_TIME_INVALID:${index}`);
    }
  });
  if (
    rows[0]?.time !== expected.firstTime ||
    rows.at(-1)?.time !== expected.lastTime
  ) {
    throw new Error("BAR_ENDPOINT_MISMATCH");
  }
  return rows;
}

export function parseFunding(bytes, expected = EXPECTED.funding) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (expected.sha256 && sha256(buffer) !== expected.sha256) {
    throw new Error("FUNDING_HASH_MISMATCH");
  }
  const rows = JSON.parse(buffer.toString("utf8"));
  if (!Array.isArray(rows) || rows.length !== expected.rowCount) {
    throw new Error("FUNDING_COUNT_MISMATCH");
  }
  rows.forEach((row, index) => {
    if (
      !Number.isSafeInteger(row?.time) ||
      !Number.isFinite(row?.rate) ||
      (index > 0 && row.time <= rows[index - 1].time)
    ) {
      throw new Error(`FUNDING_ROW_INVALID:${index}`);
    }
  });
  if (rows[0].time !== expected.firstTime || rows.at(-1).time !== expected.lastTime) {
    throw new Error("FUNDING_ENDPOINT_MISMATCH");
  }
  return rows;
}

export function parseSignals(
  bytes,
  {
    expectedHash = null,
    expectedCounts = EXPECTED.signals.counts,
  } = {},
) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (expectedHash && sha256(buffer) !== expectedHash) {
    throw new Error("SIGNAL_HASH_MISMATCH");
  }
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("SIGNAL_NEWLINE_MISSING");
  const counts = { S12: 0, S13: 0, S14: 0 };
  const seen = new Set();
  const rows = text.trim().split("\n").map((line) => {
    const source = JSON.parse(line);
    if (
      !SETUPS.includes(source.setup) ||
      !Number.isSafeInteger(source.signalTime) ||
      !Number.isFinite(source.atr) ||
      source.atr <= 0 ||
      !Number.isFinite(source.signalClose) ||
      source.signalClose <= 0 ||
      !["discovery", "validation"].includes(source.split)
    ) {
      throw new Error("SIGNAL_ROW_INVALID");
    }
    const key = `${source.setup}|${source.signalTime}`;
    if (seen.has(key)) throw new Error(`SIGNAL_DUPLICATE:${key}`);
    seen.add(key);
    counts[source.setup] += 1;
    return Object.freeze({
      setup: source.setup,
      signalTime: source.signalTime,
      atr: source.atr,
      signalClose: source.signalClose,
      split: source.split,
    });
  });
  if (SETUPS.some((setup) => counts[setup] !== expectedCounts[setup])) {
    throw new Error(`SIGNAL_COUNT_MISMATCH:${JSON.stringify(counts)}`);
  }
  return Object.freeze(rows);
}

export function loadFrozenInputs() {
  assertFuturesCachePath(EXPECTED.fiveMinute.path);
  assertFuturesCachePath(EXPECTED.funding.path);
  const signalBytes = execFileSync(
    "git",
    ["show", `${EXPECTED.signals.commit}:${EXPECTED.signals.path}`],
    { cwd: REPO, maxBuffer: 2 * 1024 * 1024 },
  );
  return Object.freeze({
    bars5m: parseBars(readFileSync(EXPECTED.fiveMinute.path), EXPECTED.fiveMinute),
    funding: parseFunding(readFileSync(EXPECTED.funding.path), EXPECTED.funding),
    signals: parseSignals(signalBytes, {
      expectedHash: EXPECTED.signals.sha256,
      expectedCounts: EXPECTED.signals.counts,
    }),
  });
}
