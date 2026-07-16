import assert from "node:assert/strict";

import { settleLong, triggeredExitPrice } from "./backtest-4h-entry-lane-7y-fill";

assert.equal(settleLong(100, 90, 0, 0), -0.1);
assert.equal(settleLong(100, 120, 0, 0), 0.2);
assert(settleLong(100, 90, 0.0004, 0.0002) < -0.1);
assert(settleLong(100, 120, 0.0004, 0.0002) < 0.2);
assert.equal(triggeredExitPrice("SL", 90, 95), 90);
assert.equal(triggeredExitPrice("SL", 100, 95), 95);
assert.equal(triggeredExitPrice("TP", 125, 120), 125);
assert.equal(triggeredExitPrice("TP", 100, 120), 120);

console.log("fill settlement regression: PASS");
