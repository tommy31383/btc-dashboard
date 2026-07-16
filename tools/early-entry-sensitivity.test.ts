import assert from "node:assert/strict";

import { signalGapAllowed } from "./early-entry-sensitivity";

assert.equal(signalGapAllowed(10, -1, 0), true);
assert.equal(signalGapAllowed(10, 10, 0), true);
assert.equal(signalGapAllowed(12, 10, 2), true);
assert.equal(signalGapAllowed(11, 10, 2), false);
assert.equal(signalGapAllowed(9, 10, 2), false);

console.log("early-entry signal-gap regression: PASS");
