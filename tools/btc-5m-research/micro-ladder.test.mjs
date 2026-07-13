import assert from "node:assert/strict";
import { test } from "node:test";

import { MICRO_METHODS, buildMicroPlan } from "./micro-ladder.mjs";

const M5 = 5 * 60_000;
const bar = (index, values = {}) => ({
  time: index * M5,
  open: values.open ?? 100,
  high: values.high ?? 101,
  low: values.low ?? 99,
  close: values.close ?? 100,
  volume: 10,
});

test("micro ladder grid has eight frozen neighbors plus baseline", () => {
  assert.equal(Object.keys(MICRO_METHODS).length, 9);
  assert.equal(Object.isFrozen(MICRO_METHODS.M70_O025_T15), true);
});

test("micro plan preserves total weight and fills touched limit causally", () => {
  const bars = [
    bar(0, { open: 100, low: 99.8 }),
    bar(1, { open: 100, low: 99.4 }),
    bar(2, { open: 101, low: 100 }),
    bar(3, { open: 102, low: 101 }),
  ];
  const plan = buildMicroPlan(bars, 0, 2, MICRO_METHODS.M50_O025_T15);
  assert.equal(plan.length, 2);
  assert.equal(plan.reduce((sum, child) => sum + child.weight, 0), 1);
  assert.equal(plan[1].fillTime, M5);
  assert.equal(plan[1].rawFillPrice, 99.5);
  assert.equal(plan[1].fillReason, "MICRO_LIMIT_TOUCH");
});

test("unfilled micro limit falls back at exact timeout open", () => {
  const bars = Array.from({ length: 10 }, (_, index) =>
    bar(index, { open: 100 + index, low: 100 + index }),
  );
  const plan = buildMicroPlan(bars, 1, 2, MICRO_METHODS.M70_O05_T30);
  assert.equal(plan[1].fillTime, 7 * M5);
  assert.equal(plan[1].rawFillPrice, 107);
  assert.equal(plan[1].fillReason, "TIMEOUT_MARKET");
});
