# H01 Zone Policy Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, preregister, run once, reproduce, and audit a BTC-only comparison of immediate H01 entry A versus three causal post-entry fail-fast/reclaim policies.

**Architecture:** A new isolated Node ESM evaluator consumes the hash-frozen Run 2 H01 signal population, Run 3 Binance Futures caches, and hash-checked production indicator/trailing functions. Pure policy logic creates deterministic transition schedules, a lifecycle simulator applies fills/costs/funding, and a chronological portfolio projection applies setup cooldown and trend capacity before inference and audit closeout. This plan deliberately stops before server implementation; a selected candidate requires a separate money-path plan after mandatory reviews are available.

**Tech Stack:** Node.js ESM, built-in `node:test`, production compiled JavaScript oracles, JSON/JSONL evidence, Git worktrees.

## Global Constraints

- Start the execution branch from Run 3 evidence commit `0eb49d6613e8a77f0ab8b537a450bec2704caeb3`, then cherry-pick design commit `eac42149c` and this plan commit.
- BTCUSDT perpetual futures only. S13/S14 LONG receive policy candidates; S12 behavior stays baseline A.
- Initial source signal count and normalized initial quantity must equal A for every candidate.
- Do not modify frozen Run 2, Run 3, or `btc-trader-server` files.
- Do not use authenticated APIs, VPS, secrets, orders, positions, arming, or deploy commands.
- Candidate policies are exactly F1/F2/F3 from `docs/superpowers/specs/2026-07-12-h01-zone-failfast-reclaim-design.md`; no outcome-driven sweep.
- No DCA, simultaneous parent/reclaim, forced reclaim, hard resistance entry filter, paper logger, or shadow runtime.
- Reclaim is modeled as a NEW ENTRY and early cut as a CLOSE; only the chronological projection may block reclaim.
- Candidate results are `POSTHOC_HYPOTHESIS_EXPLORATORY`, never untouched confirmatory evidence.
- Commit evaluator source before preregistration; do not execute candidate outcomes before preregistration is committed.
- Exactly one recorded candidate replay is allowed for the frozen mechanism/data key.
- Claude and Grok failures are not approval. If either valid audit is unavailable, final status is `AUDIT_PENDING` and this plan stops without server work.

---

### Task 1: Frozen Policy Configuration And Pure State Machine

**Files:**
- Create: `tools/h01-zone-policy/config.mjs`
- Create: `tools/h01-zone-policy/policy.mjs`
- Create: `tools/h01-zone-policy/policy.test.mjs`

**Interfaces:**
- Produces: `RUN`, `POLICIES`, `COSTS`, `INTERVALS`, `SETUP_QTY`, `SOURCE_HASHES`, and `GENERATED_OUTPUTS`.
- Produces: `createPolicyState(source, policyId)`, `stepPolicyHour(state, hour)`, `confirmEarlyClose(state, time)`, `confirmReentry(state, time)`, and `zoneEligible(source)`.
- Policy events are `NONE`, `REQUEST_EARLY_CLOSE`, `REQUEST_REENTRY`, `EXPIRE_OBSERVATION`, and `EXPIRE_RECLAIM`.

- [ ] **Step 1: Write failing exact-configuration tests**

```js
test("F1/F2/F3 constants are exact and deeply frozen", () => {
  assert.deepEqual(POLICIES.F1, {
    id: "F1", observeHours: 8, rejectCloses: 1, rejectBufferAtr: 0.25,
    reclaimDeadlineHours: 12, reclaimCloses: 1, reclaimBufferAtr: 0.25,
    zoneGate: null,
  });
  assert.deepEqual(POLICIES.F2, {
    id: "F2", observeHours: 8, rejectCloses: 2, rejectBufferAtr: 0,
    reclaimDeadlineHours: 16, reclaimCloses: 2, reclaimBufferAtr: 0,
    zoneGate: null,
  });
  assert.deepEqual(POLICIES.F3.zoneGate, {
    maxResistanceAtr: 1, maxEfficiency12: 0.30,
  });
  assert.equal(Object.isFrozen(POLICIES.F1), true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `config.mjs` or `policy.mjs`.

- [ ] **Step 3: Implement frozen constants and state validation**

```js
export const POLICIES = deepFreeze({
  A: { id: "A", baseline: true },
  F1: { id: "F1", observeHours: 8, rejectCloses: 1, rejectBufferAtr: 0.25,
    reclaimDeadlineHours: 12, reclaimCloses: 1, reclaimBufferAtr: 0.25, zoneGate: null },
  F2: { id: "F2", observeHours: 8, rejectCloses: 2, rejectBufferAtr: 0,
    reclaimDeadlineHours: 16, reclaimCloses: 2, reclaimBufferAtr: 0, zoneGate: null },
  F3: { id: "F3", observeHours: 8, rejectCloses: 1, rejectBufferAtr: 0.25,
    reclaimDeadlineHours: 12, reclaimCloses: 1, reclaimBufferAtr: 0.25,
    zoneGate: { maxResistanceAtr: 1, maxEfficiency12: 0.30 } },
});
```

Validate source setup/time/reference/ATR, enforce monotonic closed-1h boundaries, and deeply freeze returned states/events.

- [ ] **Step 4: Add transition tests before implementation**

```js
test("F1 cuts once, waits for confirmed close, and requests one reclaim", () => {
  let state = createPolicyState(source(), "F1");
  let result = stepPolicyHour(state, hour(1, 99.74));
  assert.equal(result.event.type, "REQUEST_EARLY_CLOSE");
  assert.throws(() => stepPolicyHour(result.state, hour(2, 100.30)), /EARLY_CLOSE_UNCONFIRMED/);
  state = confirmEarlyClose(result.state, HOUR);
  result = stepPolicyHour(state, hour(2, 100.26));
  assert.equal(result.event.type, "REQUEST_REENTRY");
  state = confirmReentry(result.state, 2 * HOUR);
  assert.equal(state.phase, "RECLAIM_TRAIL");
  assert.equal(state.reentryUsed, true);
});

test("F2 requires two consecutive closes and F3 outside zone stays baseline", () => {
  const first = stepPolicyHour(createPolicyState(source(), "F2"), hour(1, 99.9));
  assert.equal(first.event.type, "NONE");
  assert.equal(stepPolicyHour(first.state, hour(2, 99.8)).event.type, "REQUEST_EARLY_CLOSE");
  assert.equal(createPolicyState(source({ resistanceAtr: 2, efficiency12: 0.5 }), "F3").phase, "BASELINE_TRAIL");
});
```

- [ ] **Step 5: Implement minimal pure transitions and expiry semantics**

`stepPolicyHour` must use strict `<` rejection and strict `>` reclaim comparisons, reset consecutive counts when a boundary fails, expire observation/reclaim at their exact deadlines, and reject all transitions after `COMPLETE` or `RECLAIM_TRAIL` except idempotent `NONE`.

- [ ] **Step 6: Run focused tests and commit**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/policy.test.mjs`

Expected: all policy tests pass.

```bash
git add tools/h01-zone-policy/config.mjs tools/h01-zone-policy/policy.mjs tools/h01-zone-policy/policy.test.mjs
git commit -m "feat: add pure H01 zone policy state machine"
```

---

### Task 2: Frozen Inputs, Breakout References, And Zone Metadata

**Files:**
- Create: `tools/h01-zone-policy/input.mjs`
- Create: `tools/h01-zone-policy/input.test.mjs`
- Create: `tools/h01-zone-policy/oracle.mjs`
- Create: `tools/h01-zone-policy/oracle.test.mjs`

**Interfaces:**
- Consumes: Run 2 signal JSONL hash `d72ad3c684b726a1539e60754f805f37d7a25d81c7fcf027011b1dbd7fa721c9`.
- Consumes: Run 3 5m hash `57d6d4d9ececb67cd8362123635cbb78bc0d29039d82586825a25e7b1897a8c1`, 1h hash `f738aefc1304fda8bb871cb919fc00b8c2b98ac0be23cb05e94c22158bd000a7`, and funding hash `5dc6289ba8253c28f6506a2ad7bb3c987c7950e19be0b3567aa1dea3dd2dd08e` from its committed preregistration.
- Produces: `loadFrozenInputs()`, `parseSourceSignals(bytes)`, `buildPolicySource(signal, bars4h)`, `efficiencyRatio12(closes)`, and `loadPolicyOracle()`.

- [ ] **Step 1: Write failing source-whitelist and causal-anchor tests**

```js
test("source parser exposes no Run 2 outcomes", () => {
  const [signal] = parseSourceSignals(sourceBytes);
  assert.deepEqual(Object.keys(signal).sort(), ["atr", "setup", "signalClose", "signalTime", "split"]);
});

test("S13/S14 references and pivot metadata use only prior closed 4h bars", () => {
  const s13 = buildPolicySource(signal("S13"), bars4h);
  assert.equal(s13.breakoutReference, previous.close + signalAtr * 1.3);
  const s14 = buildPolicySource(signal("S14"), bars4h);
  assert.equal(s14.breakoutReference, Math.max(...prior18.map((bar) => bar.high)));
  assert.equal(s14.resistanceAtr, expectedNearestConfirmedPivotDistance);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/{input,oracle}.test.mjs`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement hash-bound input loading**

Read the Run 3 preregistration rather than duplicating abbreviated hashes. Verify full SHA-256, size, row count, endpoints, and server identity before parsing. Reject any source count other than S12=2, S13=44, S14=68 and any S13/S14 reference not below `signalClose`.

```js
export function efficiencyRatio12(closes) {
  if (!Array.isArray(closes) || closes.length !== 13 || closes.some((v) => !Number.isFinite(v))) {
    throw new Error("EFFICIENCY_INPUT_INVALID");
  }
  const path = closes.slice(1).reduce((sum, value, index) => sum + Math.abs(value - closes[index]), 0);
  return path === 0 ? 0 : Math.abs(closes.at(-1) - closes[0]) / path;
}
```

Use the frozen Run 2 `resistanceMetric` export without modifying that package. Pass `index4h` so every pivot satisfies its existing two-right-bar causal guard.
The thirteen closes supplied to `efficiencyRatio12` end at the complete source
signal bar; they never include the next/forming 4h bar.

- [ ] **Step 4: Implement hash-checked production oracle imports**

`loadPolicyOracle()` must verify and expose only:

```js
{
  hedge01TrailingExit,
  calcStochRSISeries,
  calcATR,
}
```

Use the exact server module hashes frozen by Run 3. Add a tamper fixture proving hash validation happens before import.

- [ ] **Step 5: Run input/oracle tests and commit**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/{input,oracle}.test.mjs`

Expected: all tests pass, including signal-close parity and no future-pivot access.

```bash
git add tools/h01-zone-policy/input.mjs tools/h01-zone-policy/input.test.mjs tools/h01-zone-policy/oracle.mjs tools/h01-zone-policy/oracle.test.mjs
git commit -m "feat: add causal H01 zone policy inputs"
```

---

### Task 3: Policy Lifecycle, Costs, Funding, And Baseline Parity

**Files:**
- Create: `tools/h01-zone-policy/lifecycle.mjs`
- Create: `tools/h01-zone-policy/lifecycle.test.mjs`
- Create: `tools/h01-zone-policy/replay.mjs`
- Create: `tools/h01-zone-policy/replay.test.mjs`

**Interfaces:**
- Produces: `simulatePolicySignal(context, scenario, policyId)`.
- Produces: `buildPolicyRows({ signals, bars5m, hourly, funding, oracle })` and deterministic JSONL serialization.
- Each method result contains `initialChild`, optional `earlyClose`, optional `reentryChild`, transition log, desired reclaim, costs, funding, net PnL, gross entry notional, and realized time.

- [ ] **Step 1: Write failing lifecycle ordering tests**

```js
test("closed 1h rejection exits at that boundary's 5m open before intrabar extremes", () => {
  const result = simulatePolicySignal(rejectionFixture, primaryLowHigh, "F1");
  assert.equal(result.earlyClose.reason, "ZONE_REJECTION");
  assert.equal(result.earlyClose.time, 2 * HOUR);
  assert.equal(result.earlyClose.rawPrice, bars5mByTime.get(2 * HOUR).open);
});

test("reclaim cannot overlap parent and receives a fresh trailing lifecycle", () => {
  const result = simulatePolicySignal(reclaimFixture, primaryLowHigh, "F1");
  assert.ok(result.earlyClose.time < result.reentryChild.fillTime);
  assert.equal(result.reentryChild.fillReason, "ZONE_RECLAIM");
  assert.equal(result.reentryChild.atrEntry, reclaimFixture.source.atr);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/lifecycle.test.mjs`

Expected: FAIL because lifecycle functions do not exist.

- [ ] **Step 3: Implement one event-ordered lifecycle loop**

At every 5m bar:

1. process a closed-1h policy transition when `bar.time` is an hourly boundary;
2. execute requested early close/reclaim at that bar open with market slippage;
3. process `LOW_HIGH` or `HIGH_LOW` trailing events for an open child;
4. record funding only while each child is open;
5. stop each child at its own 20-day horizon.

Do not call the policy on forming 1h bars. Reject a missing 5m boundary, duplicated transition, or horizon gap.

- [ ] **Step 4: Add cost/funding and no-reclaim tests**

```js
test("failed breakout with no reclaim never forces an entry", () => {
  const result = simulatePolicySignal(noReclaimFixture, primaryLowHigh, "F1");
  assert.equal(result.desiredReentry, null);
  assert.equal(result.reentryChild, null);
  assert.equal(result.transitionLog.at(-1).phase, "COMPLETE");
});

test("LONG funding and every market side cost are included", () => {
  const result = simulatePolicySignal(costFixture, primaryLowHigh, "F1");
  assert.ok(result.fundingPnl < 0);
  assert.equal(result.fees, expectedEntryExitReentryExitFees);
});
```

- [ ] **Step 5: Prove baseline A byte-parity with Run 3**

Build all 114 A rows under four cost/path scenarios and compare every fill time, fill price, exit time, exit price, fee, funding, net PnL, and return against Run 3 `execution-rows.jsonl`.

```js
assert.deepEqual(projectBaselineRows(newRows), projectRun3Baseline(run3Rows));
```

Any mismatch is P0 and blocks preregistration.

- [ ] **Step 6: Implement paired row validation and commit**

Every included row must contain A/F1/F2/F3, identical initial target 1.0, no partial method, and deterministic transition ordering.

Run: `/usr/local/bin/node --test tools/h01-zone-policy/{lifecycle,replay}.test.mjs`

Expected: all tests pass and baseline parity fixture is exact.

```bash
git add tools/h01-zone-policy/lifecycle.mjs tools/h01-zone-policy/lifecycle.test.mjs tools/h01-zone-policy/replay.mjs tools/h01-zone-policy/replay.test.mjs
git commit -m "feat: add H01 zone policy lifecycle replay"
```

---

### Task 4: Chronological Capacity Projection

**Files:**
- Create: `tools/h01-zone-policy/portfolio.mjs`
- Create: `tools/h01-zone-policy/portfolio.test.mjs`

**Interfaces:**
- Consumes: independent signal lifecycle rows.
- Produces: `projectPortfolio(rows, method, options)` with accepted initial entries, accepted reentries, blocked reasons, realized PnL events, and max open trend quantity.
- Frozen quantities: S12=0.005, S13=0.003, S14=0.005 BTC; trend LONG cap=0.02 BTC; setup cooldown S12=12h, S13=4h, S14=12h.

- [ ] **Step 1: Write failing cooldown/capacity tests**

```js
test("portfolio accepts CLOSE before same-time NEW reclaim and never exceeds cap", () => {
  const result = projectPortfolio(overlapFixture, "F1", frozenOptions);
  assert.ok(result.events.findIndex((e) => e.type === "CLOSE") < result.events.findIndex((e) => e.type === "REENTRY"));
  assert.ok(result.maxOpenLongQty <= 0.02 + 1e-12);
});

test("blocked reclaim does not alter the confirmed parent close", () => {
  const result = projectPortfolio(capBlockedFixture, "F1", frozenOptions);
  assert.equal(result.blockedReentries[0].reason, "TREND_CAP");
  assert.equal(result.parentClosesConfirmed, 1);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/portfolio.test.mjs`

Expected: FAIL because `portfolio.mjs` does not exist.

- [ ] **Step 3: Implement deterministic event projection**

Sort by event time, then priority `CLOSE`, `SOURCE_ENTRY`, `REENTRY`, then setup lexical order and source time. Initial source entries and reentries update setup cooldown only when accepted. Ignore all child events belonging to an initial source blocked by baseline cooldown/capacity. A rejected reclaim records its reason and contributes no reentry PnL/funding/fees.

Do not model daily-loss, HWM, panic, manual positions, or exchange uncertainty as historical facts. Report them as unmodeled NEW-entry gates and cover them later with server tests.

- [ ] **Step 4: Add baseline/candidate equality and accounting tests**

```js
test("all candidates expose the same initial source population as A", () => {
  for (const method of ["F1", "F2", "F3"]) {
    assert.equal(projectPortfolio(rows, method, opts).sourceSignals, projectPortfolio(rows, "A", opts).sourceSignals);
  }
});

test("realized portfolio PnL equals accepted child sums", () => {
  const result = projectPortfolio(rows, "F1", opts);
  assert.equal(result.netPnl, result.realizedEvents.reduce((sum, event) => sum + event.netPnl, 0));
});
```

- [ ] **Step 5: Run tests and commit**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/portfolio.test.mjs`

Expected: all tests pass.

```bash
git add tools/h01-zone-policy/portfolio.mjs tools/h01-zone-policy/portfolio.test.mjs
git commit -m "feat: add H01 zone policy capacity projection"
```

---

### Task 5: Metrics, Inference, Winner Routing, And Report

**Files:**
- Create: `tools/h01-zone-policy/metrics.mjs`
- Create: `tools/h01-zone-policy/metrics.test.mjs`
- Create: `tools/h01-zone-policy/report.mjs`
- Create: `tools/h01-zone-policy/report.test.mjs`

**Interfaces:**
- Produces: `aggregatePolicyRows(rows, options)`, `blockBootstrapNetDollarDelta(items, options)`, `classifyPolicies(input)`, and `renderPolicyReport(aggregate)`.
- Statuses: `EXPLORATORY_CANDIDATE`, `NO_ZONE_POLICY_WINNER`, `INSUFFICIENT_SAMPLE`, `AUDIT_PENDING`, and `AUDIT_REJECTED`.

- [ ] **Step 1: Write failing corrected-inference tests**

```js
test("three policy comparisons use corrected 98.333 percent confidence", () => {
  assert.equal(INFERENCE.confidence, 1 - 0.05 / 3);
});

test("positive dollars with validation CI crossing zero is no winner", () => {
  assert.equal(classifyPolicies(crossingZeroFixture).status, "NO_ZONE_POLICY_WINNER");
});

test("candidate with fewer initial sources is rejected", () => {
  assert.match(classifyPolicies(reducedSignalFixture).methods.F1.failures.join("|"), /initialSourceCount/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/{metrics,report}.test.mjs`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement signal and portfolio aggregates**

Report both layers separately. Primary promotion evidence is chronological fixed-quantity portfolio net dollars. Signal-level return is diagnostic. Include child order count, early-cut rate, desired/accepted/blocked reclaim counts, turnover, fee/funding delta, PF, win rate, max drawdown, MFE/MAE, and hold time by setup/year/zone/transition.

- [ ] **Step 4: Implement all frozen robustness gates**

For F1/F2/F3 versus A compute:

- corrected validation calendar-month block-bootstrap net-dollar delta;
- primary `LOW_HIGH` and alternate `HIGH_LOW` delta;
- stress-cost delta;
- drop-candidate-top-10% delta;
- remove-candidate-best-month delta;
- S13 and S14 separate results;
- 2025 delta;
- one-closed-1h-delay falsification;
- F1 cut-only and F2 cut-only ablations;
- fixed perturbation diagnostics without winner selection.

- [ ] **Step 5: Implement scope-safe report tests**

```js
test("report cannot call projection wallet ROI or authorize live", () => {
  const text = renderPolicyReport(aggregateFixture);
  assert.doesNotMatch(text, /wallet ROI|deploy approved|live winner/i);
  assert.match(text, /POSTHOC_HYPOTHESIS_EXPLORATORY/);
});
```

- [ ] **Step 6: Run tests and commit**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/{metrics,report}.test.mjs`

Expected: all tests pass.

```bash
git add tools/h01-zone-policy/metrics.mjs tools/h01-zone-policy/metrics.test.mjs tools/h01-zone-policy/report.mjs tools/h01-zone-policy/report.test.mjs
git commit -m "feat: add H01 zone policy inference and reporting"
```

---

### Task 6: Single-Use Runtime, Preregistration, And Provenance

**Files:**
- Create: `tools/h01-zone-policy/run.mjs`
- Create: `tools/h01-zone-policy/run.test.mjs`
- Create: `docs/research/run-4-2026-07-12-h01-zone-policy/authorization.md`
- Create: `docs/research/run-4-2026-07-12-h01-zone-policy/packets/claude-result-audit.md`
- Create: `docs/research/run-4-2026-07-12-h01-zone-policy/packets/grok-result-audit.md`
- Generate later: preregistration, registry, run state, ledger, rows, aggregate, provenance, audits, and report.

**Interfaces:**
- CLI modes: `inventory`, `preregister`, `dry-run`, `replay`, `verify`, and `closeout`.
- Produces exactly one registry key `h01-zone-policy:<dataRangeHash>:<sourceSignalHash>`.

- [ ] **Step 1: Write failing freeze/single-use tests**

```js
test("dry-run verifies every frozen input without invoking candidate outcomes", async () => {
  const result = await executeDryRun({ verifyFreeze, outcomeBuilder: () => { throw new Error("OUTCOME_READ"); } });
  assert.equal(result.outcomeRead, false);
});

test("second replay, source drift, or duplicate registry key fail closed", async () => {
  await assert.rejects(() => replay(recordedFixture), /REPLAY_ALREADY_RECORDED/);
  await assert.rejects(() => verifyFreeze(tamperedFixture), /HASH_MISMATCH/);
  await assert.rejects(() => preregister(duplicateRegistryFixture), /REGISTRY_DUPLICATE/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/run.test.mjs`

Expected: FAIL because `run.mjs` does not exist.

- [ ] **Step 3: Implement atomic generated outputs**

Generated files are exactly:

```text
run.json
ledger.jsonl
artifacts/policy-rows.jsonl
artifacts/policy-aggregate.json
artifacts/policy-provenance.json
artifacts/codex-audit.md
artifacts/claude-audit.txt
artifacts/grok-audit.txt
report.md
```

`verify` must hash raw/aggregate/provenance, parse every row, recompute aggregate byte-for-byte, verify initial target equality, and require `replayInvocationCount=1`.

- [ ] **Step 4: Implement audit-aware closeout**

Valid terminals:

```text
Codex: PASS_NO_P0_P2 | KILL_RESULT
Claude: APPROVED | KILL_RESULT | AUDIT_UNAVAILABLE
Grok: ALLOW_EXPLORATORY_RESULT | KILL_RESULT | AUDIT_UNAVAILABLE
```

Any `KILL_RESULT` routes to `AUDIT_REJECTED`. Either `AUDIT_UNAVAILABLE` routes to `AUDIT_PENDING`. Only valid approval terminals preserve the pre-audit candidate/no-winner status. `AUDIT_PENDING` must clear `selectedPolicy` in the final report.

- [ ] **Step 5: Run all tests and commit runtime source**

Run: `/usr/local/bin/node --test tools/h01-zone-policy/*.test.mjs`

Run: `/usr/local/bin/node --test /Users/lap16116/BTC_PC/btc-trader-server/test/p1a-pipeline.test.mjs`

Expected: all research and all 9 server parity tests pass.

```bash
git add tools/h01-zone-policy docs/research/run-4-2026-07-12-h01-zone-policy/authorization.md docs/research/run-4-2026-07-12-h01-zone-policy/packets
git commit -m "feat: add fail-closed H01 zone policy research runtime"
```

- [ ] **Step 6: Inventory, preregister, and commit the freeze**

Run: `/usr/local/bin/node tools/h01-zone-policy/run.mjs inventory`

Run: `/usr/local/bin/node tools/h01-zone-policy/run.mjs preregister`

Inspect the complete preregistration and verify it binds design/plan/source/test/server/data hashes, seed, three candidates, costs, inference, known posthoc disclosure, single replay, and no-live runtime.

```bash
git add docs/research/run-4-2026-07-12-h01-zone-policy/prereg docs/research/run-4-2026-07-12-h01-zone-policy/registry.jsonl
git commit -m "test: preregister H01 zone policy run"
```

---

### Task 7: One Replay, Reproduction, Audits, And Evidence Commit

**Files:**
- Generate only the nine declared output files.

- [ ] **Step 1: Prove dry-run is outcome blind**

Run: `/usr/local/bin/node tools/h01-zone-policy/run.mjs dry-run`

Expected: `status=PLANNED`, exact preregistration hash, `outcomeRead=false`, and no result artifacts.

- [ ] **Step 2: Execute exactly one candidate replay**

Run: `/usr/local/bin/node tools/h01-zone-policy/run.mjs replay`

Expected: `replayInvocationCount=1` and hash-bound raw/aggregate/provenance artifacts.

- [ ] **Step 3: Independently reproduce and audit invariants**

Run: `/usr/local/bin/node tools/h01-zone-policy/run.mjs verify`

Independently inspect all rows for A/F1/F2/F3, initial weight 1.0, no S12 policy transition, strict hourly boundaries, one-reclaim maximum, no overlap, cost/funding sums, and portfolio cap.

- [ ] **Step 4: Write Codex audit before external review**

Review causal anchors, policy thresholds, transition order, close/reclaim semantics, baseline parity, fee/funding, capacity projection, bootstrap, winner routing, and claims. End `artifacts/codex-audit.md` with `PASS_NO_P0_P2` only when no unresolved P0-P2 exists; otherwise `KILL_RESULT`.

- [ ] **Step 5: Attempt each mandatory external audit once**

Claude:

```bash
claude -p "$(cat docs/research/run-4-2026-07-12-h01-zone-policy/packets/claude-result-audit.md)"
```

Grok:

```bash
/Users/lap16116/BTC_PC/scripts/grok/ask.sh docs/research/run-4-2026-07-12-h01-zone-policy/packets/grok-result-audit.md
```

Record exact usable output. If the known quota/balance failure repeats, record a concise evidence file ending in `AUDIT_UNAVAILABLE`; do not retry-loop and do not substitute Codex approval.

- [ ] **Step 6: Close out and run fresh verification**

Run: `/usr/local/bin/node tools/h01-zone-policy/run.mjs closeout`

Run: `/usr/local/bin/node --test tools/h01-zone-policy/*.test.mjs`

Run: `/usr/local/bin/node --test /Users/lap16116/BTC_PC/btc-trader-server/test/p1a-pipeline.test.mjs`

Run: `/usr/local/bin/node tools/h01-zone-policy/run.mjs verify`

Run: `git diff --check`

Expected final status today is `AUDIT_PENDING` if reviewer availability has not changed. No live claim is allowed in that state.

- [ ] **Step 7: Commit evidence and preserve the worktree**

```bash
git add docs/research/run-4-2026-07-12-h01-zone-policy/run.json \
  docs/research/run-4-2026-07-12-h01-zone-policy/ledger.jsonl \
  docs/research/run-4-2026-07-12-h01-zone-policy/artifacts \
  docs/research/run-4-2026-07-12-h01-zone-policy/report.md
git commit -m "test: publish H01 zone policy evidence"
```

Verify dashboard worktree and server repository are clean. Keep the research branch/worktree; do not merge, implement server code, arm, or deploy.

---

## Conditional Follow-Up

If the pre-audit result is `NO_ZONE_POLICY_WINNER` or `INSUFFICIENT_SAMPLE`, stop permanently for this mechanism/data key.

If it is `EXPLORATORY_CANDIDATE`, preserve the selected policy and evidence but do not implement live code while status is `AUDIT_PENDING`. After Claude and Grok both return valid approvals, write a separate server implementation design/plan covering state migration, shared production policy function, scheduler reclaim routing, intent recovery, Telegram, catastrophic stop, full `npm test`, version bump, deploy, and runtime verification.
