import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPECTED,
  assertFuturesCachePath,
  parseBars,
  parseSignals,
} from "./provenance.mjs";

test("rejects the legacy spot cache path", () => {
  assert.throws(
    () => assertFuturesCachePath(".cache/binance-5m-7y.json"),
    /SPOT_CACHE_FORBIDDEN/,
  );
  assert.equal(
    assertFuturesCachePath(EXPECTED.fiveMinute.path),
    EXPECTED.fiveMinute.path,
  );
});

test("bar parser enforces hash, schema, order, and exact endpoints", () => {
  const rows = [
    { time: 300_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    { time: 600_000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 4 },
  ];
  const bytes = Buffer.from(JSON.stringify(rows));
  const expected = {
    sha256: "6bd508f8674afbb7ce1b4b371e9408d205da368023b2b9dc737dbe3453d08930",
    rowCount: 2,
    firstTime: 300_000,
    lastTime: 600_000,
  };
  assert.deepEqual(parseBars(bytes, expected), rows);
  assert.throws(
    () => parseBars(bytes, { ...expected, sha256: "0".repeat(64) }),
    /HASH_MISMATCH/,
  );
  assert.throws(
    () => parseBars(Buffer.from(JSON.stringify([rows[1], rows[0]])), {
      ...expected,
      sha256: null,
    }),
    /BAR_TIME_INVALID/,
  );
});

test("signal parser exposes only causal source fields and exact counts", () => {
  const rows = [
    { setup: "S12", signalTime: 1, atr: 2, signalClose: 3, split: "discovery", future: 99 },
    { setup: "S13", signalTime: 2, atr: 2, signalClose: 3, split: "validation" },
    { setup: "S14", signalTime: 3, atr: 2, signalClose: 3, split: "discovery" },
  ];
  const bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const parsed = parseSignals(bytes, {
    expectedCounts: { S12: 1, S13: 1, S14: 1 },
  });
  assert.deepEqual(Object.keys(parsed[0]).sort(), [
    "atr",
    "setup",
    "signalClose",
    "signalTime",
    "split",
  ]);
  assert.equal(parsed.length, 3);
  assert.throws(
    () => parseSignals(bytes, { expectedCounts: { S12: 2, S13: 1, S14: 1 } }),
    /SIGNAL_COUNT_MISMATCH/,
  );
});
