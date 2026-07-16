import assert from "node:assert/strict";

import { oversoldThreshold } from "./early-entry-threshold";

assert.equal(oversoldThreshold("K5"), 5);
assert.equal(oversoldThreshold("K5_1D_RISING"), 5);
assert.equal(oversoldThreshold("K10_2W_RISING"), 10);
assert.equal(oversoldThreshold("K20_WEEK_ABOVE_RISING"), 20);
assert.equal(oversoldThreshold("K30"), 30);

console.log("early-entry threshold regression: PASS");
