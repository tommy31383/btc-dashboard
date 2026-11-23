import assert from "node:assert/strict";
import {
  isOversoldEpisodeStart,
  pullbackZoneTouched,
  shouldFireEpisodeEntry,
  shouldFireMacroBackedEntry,
  higherLowReclaim,
} from "./pullback-entry-research";

assert.equal(isOversoldEpisodeStart(12, 9, 10), true);
assert.equal(isOversoldEpisodeStart(9, 8, 10), false);
assert.equal(isOversoldEpisodeStart(null, 9, 10), false);

assert.equal(pullbackZoneTouched(99, 101, 100), true);
assert.equal(pullbackZoneTouched(101, 102, 100), false);

assert.equal(shouldFireEpisodeEntry({ active: true, entered: false }, true), true);
assert.equal(shouldFireEpisodeEntry({ active: true, entered: true }, true), false);
assert.equal(shouldFireEpisodeEntry({ active: false, entered: false }, true), false);
assert.equal(shouldFireMacroBackedEntry({ active: true, entered: false }, false, true), false);
assert.equal(shouldFireMacroBackedEntry({ active: true, entered: false }, true, true), true);

assert.equal(higherLowReclaim(100, 104, 101, 105), true);
assert.equal(higherLowReclaim(100, 104, 99, 105), false);

console.log("pullback entry helper regression: PASS");
