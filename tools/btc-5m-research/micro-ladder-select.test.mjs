import assert from "node:assert/strict";
import test from "node:test";

import { selectMicroLadder } from "./micro-ladder-select.mjs";

function value(netPnl, drawdown = 10, tail = 5) {
  return { netPnl, maxRealizedDrawdown: drawdown, dropTop20NetPnl: tail };
}

test("micro selector rejects an isolated peak", () => {
  const stats = { A: value(100) };
  for (let index = 0; index < 8; index += 1) {
    stats[`M${index}`] = value(index === 0 ? 110 : 99);
  }
  assert.equal(selectMicroLadder(stats).method, null);
});

test("micro selector requires a six-of-eight plateau and deterministic representative", () => {
  const stats = {
    A: value(100),
    M50_O025_T15: value(101, 10, 6),
    M50_O025_T30: value(102, 10, 6),
    M50_O05_T15: value(103, 10, 6),
    M50_O05_T30: value(104, 10, 6),
    M70_O025_T15: value(105, 10, 6),
    M70_O025_T30: value(106, 10, 6),
    M70_O05_T15: value(99),
    M70_O05_T30: value(98),
  };
  const selection = selectMicroLadder(stats);
  assert.equal(selection.qualifyingCount, 6);
  assert.equal(selection.method, "M50_O05_T15");
});
