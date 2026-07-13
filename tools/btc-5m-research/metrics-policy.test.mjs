import assert from "node:assert/strict";
import test from "node:test";

import { buildMetricsPolicyRows, selectMetricsDiscovery } from "./metrics-policy.mjs";

test("adaptive metrics policy preserves every eligible row and changes only flagged execution", () => {
  const value = (netPnl) => ({ netPnl, exitTime: 1, fees: 0, fundingPnl: 0, entryImprovementAtr: 0, timedOut: false, mfe24Atr: 1, mae24Atr: 1, holdMs: 1 });
  const rows = [
    {
      setup: "S13",
      signalTime: 100,
      split: "discovery",
      scenarios: { primary: { A: value(1), M70_O025_T15: value(2) } },
    },
    {
      setup: "S14",
      signalTime: 200,
      split: "discovery",
      scenarios: { primary: { A: value(3), M70_O025_T15: value(4) } },
    },
  ];
  const features = new Map([
    ["S13|100", { available: true, states: { SHORT_COVERING_RALLY: true, BUY_ABSORPTION: false, CROWDED_LONG: false } }],
    ["S14|200", { available: true, states: { SHORT_COVERING_RALLY: false, BUY_ABSORPTION: true, CROWDED_LONG: false } }],
  ]);
  const policy = buildMetricsPolicyRows(rows, features);
  assert.equal(policy.length, 2);
  assert.equal(policy[0].scenarios.primary.SHORT_COVERING_RALLY.netPnl, 2);
  assert.equal(policy[1].scenarios.primary.SHORT_COVERING_RALLY.netPnl, 3);
  assert.equal(policy[1].scenarios.primary.BUY_ABSORPTION.netPnl, 4);
});

test("discovery selector enforces sample, net, drawdown, and tail together", () => {
  const baseline = { netPnl: 100, maxRealizedDrawdown: 10, dropTop20NetPnl: 5 };
  const selection = selectMetricsDiscovery(baseline, {
    SHORT_COVERING_RALLY: { flaggedCount: 8, netPnl: 101, maxRealizedDrawdown: 9, dropTop20NetPnl: 6 },
    BUY_ABSORPTION: { flaggedCount: 7, netPnl: 102, maxRealizedDrawdown: 9, dropTop20NetPnl: 6 },
    CROWDED_LONG: { flaggedCount: 8, netPnl: 103, maxRealizedDrawdown: 11, dropTop20NetPnl: 6 },
  });
  assert.deepEqual(selection.candidates, ["SHORT_COVERING_RALLY"]);
});
