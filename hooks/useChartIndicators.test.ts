import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStoredIndicators, DEFAULT_ENABLED_INDICATORS } from "../utils/chartIndicators";

test("parseStoredIndicators: null returns default set", () => {
  assert.deepEqual(parseStoredIndicators(null), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: invalid JSON returns default set", () => {
  assert.deepEqual(parseStoredIndicators("{not json"), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: non-array JSON returns default set", () => {
  assert.deepEqual(parseStoredIndicators(JSON.stringify({ foo: "bar" })), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: drops unknown keys and dedupes", () => {
  const raw = JSON.stringify(["rsi", "rsi", "unknownLegacyKey", "macd"]);
  assert.deepEqual(parseStoredIndicators(raw), ["rsi", "macd"]);
});

test("parseStoredIndicators: empty array after filtering falls back to default", () => {
  const raw = JSON.stringify(["unknownLegacyKey1", "unknownLegacyKey2"]);
  assert.deepEqual(parseStoredIndicators(raw), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: valid subset passes through unchanged (order preserved)", () => {
  const raw = JSON.stringify(["adx", "ema"]);
  assert.deepEqual(parseStoredIndicators(raw), ["adx", "ema"]);
});

test("parseStoredIndicators: genuinely empty array is preserved (user disabled everything)", () => {
  assert.deepEqual(parseStoredIndicators(JSON.stringify([])), []);
});
