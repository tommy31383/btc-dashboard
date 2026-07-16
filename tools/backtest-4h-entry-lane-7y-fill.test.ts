import assert from "node:assert/strict";

import { settleLong } from "./backtest-4h-entry-lane-7y-fill";

assert.equal(settleLong(100, 90, 0, 0), -0.1);
assert.equal(settleLong(100, 120, 0, 0), 0.2);
assert(settleLong(100, 90, 0.0004, 0.0002) < -0.1);
assert(settleLong(100, 120, 0.0004, 0.0002) < 0.2);

console.log("fill settlement regression: PASS");
