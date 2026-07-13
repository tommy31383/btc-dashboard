import assert from "node:assert/strict";
import { test } from "node:test";

import { causalAtr, classifyToxicity } from "./h01-filter.mjs";

const M5 = 5 * 60_000;

function bar(index, values = {}) {
  const close = values.close ?? 100;
  return {
    time: index * M5,
    open: values.open ?? close,
    high: values.high ?? Math.max(values.open ?? close, close) + 1,
    low: values.low ?? Math.min(values.open ?? close, close) - 1,
    close,
    volume: values.volume ?? 10,
  };
}

test("causal ATR excludes the signal bar and all future bars", () => {
  const bars = Array.from({ length: 30 }, (_, index) => bar(index));
  const baseline = causalAtr(bars, 20, 14);
  bars[20] = bar(20, { high: 1_000, low: 1, close: 500 });
  bars[29] = bar(29, { high: 2_000, low: 1, close: 1_000 });
  assert.equal(causalAtr(bars, 20, 14), baseline);
});

test("toxicity requires loss, below EMA, and high relative volume together", () => {
  const bars = Array.from({ length: 40 }, (_, index) => bar(index));
  bars[20] = bar(20, { open: 100, close: 99.5, low: 99, volume: 20 });
  bars[21] = bar(21, { open: 99.5, close: 99, low: 98.5, volume: 20 });
  bars[22] = bar(22, { open: 99, close: 98, low: 97.5, volume: 20 });
  const result = classifyToxicity(bars, 20);
  assert.equal(result.skip, true);
  assert.equal(result.fillIndex, 23);
  assert.ok(result.lossAtr <= -0.5);

  bars[20] = bar(20, { open: 100, close: 99.5, low: 99, volume: 10 });
  bars[21] = bar(21, { open: 99.5, close: 99, low: 98.5, volume: 10 });
  bars[22] = bar(22, { open: 99, close: 98, low: 97.5, volume: 10 });
  assert.equal(classifyToxicity(bars, 20).skip, false);
});
