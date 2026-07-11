# BTC StochRSI Hybrid-Lite V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add and falsify a BTC-only `HYBRID_LITE` replay that executes every existing daily episode entry, holds one core to macro exit, and closes later tactical entries when the daily episode recovers.

**Architecture:** Keep candle aggregation and signal generation pure in `core.ts`, adding aligned episode recovery timestamps. Generalize `replay.ts` for per-leg exits and partial-exit account paths, then add Hybrid-Lite plus a simulated matched-peak exposure control. Extend the deterministic JSON/Markdown report and existing runner instead of creating another accounting engine.

**Tech Stack:** TypeScript, Node test runner through `tsx`, BTC Futures hourly/funding caches, existing report serializer.

## Global Constraints

- BTCUSDT only; no ETH, SOL, live server, deploy, account state, or secrets.
- Every base `DAILY_EPISODE` entry timestamp must appear exactly once in `HYBRID_LITE`.
- First episode per campaign is one `0.001 BTC` core; later episodes are `0.001 BTC` tactical legs.
- Tactical exit is next daily open after closed-1D `%K >= 10`; macro exit wins ties.
- Hybrid structural peak quantity is at most `0.002 BTC`.
- No threshold sweep, entry filter, hard stop, macro invalidation, partial split, or max hold.
- Costs remain 0.04% fee per side, 0.02% adverse slippage per side, and historical funding.
- Current 2019-2026 Futures data is discovery evidence, not honest OOS.
- Existing variants must retain identical metrics after generalized replay changes.

---

### Task 1: Record Causal Episode Recoveries

**Files:**
- Modify: `tools/stochrsi-macro-cycle/core.ts`
- Test: `tools/stochrsi-macro-cycle/core.test.ts`

**Interfaces:**
- Produces: `CampaignSignal.episodeRecoveryTimes: Array<number | null>` aligned with `episodeEntries`.
- Consumes: existing sorted `StochPoint` events and macro-exit-first priority.

- [ ] **Step 1: Write failing recovery tests**

Add fixtures for normal recovery, unrecovered final episode, and same-time macro exit priority.

```ts
assert.deepEqual(campaign.episodeEntries, [ENTRY_TIME]);
assert.deepEqual(campaign.episodeRecoveryTimes, [RECOVERY_TIME]);
assert.deepEqual(openCampaign.episodeRecoveryTimes, [null]);
assert.equal(exitPriorityCampaign.exitTime, SHARED_TIME);
assert.deepEqual(exitPriorityCampaign.episodeRecoveryTimes, [null]);
```

- [ ] **Step 2: Run RED test**

```bash
/tmp/npm-cache-tmpfix/_npx/fd45a72a545557e9/node_modules/.bin/tsx --test tools/stochrsi-macro-cycle/core.test.ts
```

Expected: failure because `episodeRecoveryTimes` does not exist.

- [ ] **Step 3: Implement aligned recovery state**

```ts
export interface CampaignSignal {
  armTime: number;
  episodeEntries: number[];
  episodeRecoveryTimes: Array<number | null>;
  dailyOversoldEntries: number[];
  exitTime?: number;
  exitReason?: "MACRO_OVERBOUGHT";
}
```

Initialize each campaign with `episodeRecoveryTimes: []`. In the daily loop, skip null `%K`, record recovery before changing `dailyEpisodeActive`, then append aligned entry/recovery values.

```ts
if (daily.k === null) continue;
const isOversold = daily.k < 10;
if (activeCampaign && dailyEpisodeActive && !isOversold) {
  const index = activeCampaign.episodeRecoveryTimes.length - 1;
  if (index >= 0 && activeCampaign.episodeRecoveryTimes[index] === null) {
    activeCampaign.episodeRecoveryTimes[index] = daily.closeTime;
  }
}
if (activeCampaign && isOversold) {
  activeCampaign.dailyOversoldEntries.push(daily.closeTime);
  if (!dailyEpisodeActive) {
    activeCampaign.episodeEntries.push(daily.closeTime);
    activeCampaign.episodeRecoveryTimes.push(null);
  }
}
dailyEpisodeActive = isOversold;
```

- [ ] **Step 4: Run GREEN test and commit**

Run the Task 1 test; expect pass.

```bash
git add tools/stochrsi-macro-cycle/core.ts tools/stochrsi-macro-cycle/core.test.ts
git commit -m "feat: record causal daily episode recoveries"
```

---

### Task 2: Generalize Replay For Per-Leg Exits

**Files:**
- Modify: `tools/stochrsi-macro-cycle/replay.ts`
- Test: `tools/stochrsi-macro-cycle/replay.test.ts`

**Interfaces:**
- Produces: `LegRole`, `LegExitReason`, extended `LegIntent`, extended `ReplayLeg`.
- Produces: partial-exit-safe campaign and account risk paths.
- Produces: the minimal executable `HYBRID_LITE` variant needed to exercise partial exits end to end.
- Consumes: `CampaignSignal.episodeRecoveryTimes`.

- [ ] **Step 1: Write failing lifecycle/accounting tests**

Use one core and two tactical legs. Assert tactical exits stop funding and realized PnL persists while core remains open.

```ts
assert.deepEqual(campaign.legs.map((leg) => leg.exitTime), [MACRO_EXIT, RECOVERY_1, RECOVERY_2]);
assert.equal(campaign.legs[1].exitReason, "DAILY_RECOVERY");
assert.equal(pathAfterRecovery.realizedPnl, campaign.legs[1].netPnl);
assert.equal(campaign.maxDrawdown, EXPECTED_DRAWDOWN_WITH_REALIZED_PNL);
```

- [ ] **Step 2: Run RED replay test**

```bash
/tmp/npm-cache-tmpfix/_npx/fd45a72a545557e9/node_modules/.bin/tsx --test tools/stochrsi-macro-cycle/replay.test.ts
```

Expected: missing lifecycle fields and per-leg exit behavior.

- [ ] **Step 3: Add lifecycle types and resolved exits**

```ts
export type LegRole = "BASE" | "CORE" | "TACTICAL" | "SIMULATED";
export type LegExitReason = "MACRO_OVERBOUGHT" | "DAILY_RECOVERY";

export interface LegIntent {
  entryTime: number;
  qty: number;
  exitTime?: number;
  role: LegRole;
  exitReason?: LegExitReason;
}
```

Add `role` and `exitReason` to `ReplayLeg`. Make `replayLeg` consume `intent.exitTime` directly and copy lifecycle metadata. Existing builders resolve campaign exit into every intent.

Add `HYBRID_LITE` to `VariantName` and build its intents here: entry index zero is `CORE`; later entries are `TACTICAL`; macro exit wins recovery ties. Task 3 will add the matched-peak control and fixed orchestration, not reimplement Hybrid.

```ts
const macroWins = campaign.exitTime !== undefined &&
  (recoveryTime === null || campaign.exitTime <= recoveryTime);
const exitTime = macroWins ? campaign.exitTime : recoveryTime ?? undefined;
const exitReason = exitTime === undefined
  ? undefined
  : macroWins
    ? "MACRO_OVERBOUGHT"
    : "DAILY_RECOVERY";
```

- [ ] **Step 4: Generalize campaign risk**

At each candle, combine already-realized leg PnL with active-leg PnL.

```ts
const closedLegs = legs.filter(
  (leg) => leg.exitTime !== undefined && leg.exitTime <= candle.time,
);
const activeLegs = legs.filter(
  (leg) => leg.entryTime <= candle.time && (leg.exitTime === undefined || leg.exitTime > candle.time),
);
const realizedPnl = sum(closedLegs.map((leg) => leg.netPnl));
const pnlAt = (price: number): number =>
  realizedPnl +
  sum(activeLegs.map((leg) => (price - leg.entryPrice) * leg.qty)) +
  activeFundingPnl -
  sum(activeLegs.map((leg) => leg.entryFee));
```

Use low for downside/drawdown and high for peak. Keep `worstUnrealizedPnl` limited to active legs.

- [ ] **Step 5: Run all macro tests and commit**

```bash
/tmp/npm-cache-tmpfix/_npx/fd45a72a545557e9/node_modules/.bin/tsx --test tools/stochrsi-macro-cycle/*.test.ts
git add tools/stochrsi-macro-cycle/replay.ts tools/stochrsi-macro-cycle/replay.test.ts
git commit -m "feat: replay tactical legs with causal exits"
```

Expected: all existing metrics remain unchanged in regression fixtures.

---

### Task 3: Add Hybrid-Lite And Matched-Peak Control

**Files:**
- Modify: `tools/stochrsi-macro-cycle/replay.ts`
- Test: `tools/stochrsi-macro-cycle/replay.test.ts`
- Modify: `tools/backtest-stochrsi-macro-cycle-7y.ts`

**Interfaces:**
- Consumes: the executable `HYBRID_LITE` variant from Task 2.
- Produces: `DAILY_EPISODE_MATCHED_PEAK` and fixed orchestration.
- Produces: `runFrozenVariants(campaigns, hourly, funding, options?)` in report order.

- [ ] **Step 1: Write failing variant tests**

```ts
assert.equal(matched.simulatedNotTradable, true);
assert.equal(matched.maxQuantity, hybrid.maxQuantity);
const frozen = runFrozenVariants(campaigns, hourly, []);
assert.deepEqual(frozen.map((run) => run.name), VARIANT_NAMES);
```

Task 2 already owns entry parity, roles, tactical overlap, and macro/recovery tie behavior. Task 3 verifies the matched control uses Hybrid's measured peak rather than a hand-entered scale.

- [ ] **Step 2: Run RED replay test**

Run the Task 2 replay command; expect unknown variant/function failures.

- [ ] **Step 3: Implement frozen orchestration**

Run base and Hybrid first, then calculate the diagnostic matched scale.

```ts
const matchedPeakScale = base.maxQuantity === 0
  ? 1
  : hybrid.maxQuantity / base.maxQuantity;
```

Replay all base episode entries with quantities multiplied by this scale and mark that row simulated/non-tradable. Return every variant exactly once in `VARIANT_NAMES` order.

- [ ] **Step 4: Switch runner and verify**

Replace `VARIANT_NAMES.map(runVariant)` with `runFrozenVariants`.

```bash
/tmp/npm-cache-tmpfix/_npx/fd45a72a545557e9/node_modules/.bin/tsx --test tools/stochrsi-macro-cycle/*.test.ts
./node_modules/.bin/tsc --noEmit --pretty false --strict --skipLibCheck --esModuleInterop --resolveJsonModule --module commonjs --moduleResolution node --target es2022 tools/stochrsi-macro-cycle/core.ts tools/stochrsi-macro-cycle/core.test.ts tools/stochrsi-macro-cycle/io.ts tools/stochrsi-macro-cycle/io.test.ts tools/stochrsi-macro-cycle/replay.ts tools/stochrsi-macro-cycle/replay.test.ts tools/stochrsi-macro-cycle/report.ts tools/stochrsi-macro-cycle/report.test.ts tools/backtest-stochrsi-macro-cycle-7y.ts
```

Expected: focused tests and targeted TypeScript pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add tools/stochrsi-macro-cycle/replay.ts tools/stochrsi-macro-cycle/replay.test.ts tools/backtest-stochrsi-macro-cycle-7y.ts
git commit -m "feat: add frozen Hybrid-Lite falsification variants"
```

---

### Task 4: Extend Report And Mechanical Verdict

**Files:**
- Modify: `tools/stochrsi-macro-cycle/report.ts`
- Test: `tools/stochrsi-macro-cycle/report.test.ts`
- Modify: `tools/stochrsi-macro-cycle/replay.ts`
- Test: `tools/stochrsi-macro-cycle/replay.test.ts`
- Modify: `tools/stochrsi-macro-cycle/io.ts`
- Test: `tools/stochrsi-macro-cycle/io.test.ts`

**Interfaces:**
- Produces: `realizedLegs`, `realizedLegWinRate`, role attribution, and Hybrid kill checks.
- Bumps evaluator to `stochrsi-macro-cycle/v4` and report schema to `btc-stochrsi-macro-cycle-report/v3`.

- [ ] **Step 1: Write failing denominator/attribution tests**

Use an open campaign with one realized tactical leg and one open core.

```ts
assert.equal(summary.realizedLegs, 1);
assert.equal(summary.totalLegs, 2);
assert.equal(summary.realizedLegWinRate, 1);
assert.equal(summary.closedCampaigns, 0);
assert.equal(summary.roleAttribution.TACTICAL.realized, 1);
```

Add report assertions for every kill check and final `PASS`/`KILL` value.

- [ ] **Step 2: Run RED report suite**

```bash
/tmp/npm-cache-tmpfix/_npx/fd45a72a545557e9/node_modules/.bin/tsx --test tools/stochrsi-macro-cycle/replay.test.ts tools/stochrsi-macro-cycle/report.test.ts tools/stochrsi-macro-cycle/io.test.ts
```

Expected: missing summary fields, verdict, and versions.

- [ ] **Step 3: Correct summary denominators and attribution**

```ts
const allLegs = run.campaigns.flatMap((campaign) => campaign.legs);
const realizedLegs = allLegs.filter((leg) => leg.closed);
const completedCampaigns = run.campaigns.filter(
  (campaign) => campaign.closed && campaign.legs.length > 0,
);
```

Build role totals for entries, realized/open legs, component PnL, net PnL, and exit reasons.

- [ ] **Step 4: Implement mechanical Hybrid verdict**

Represent each frozen criterion as `{ id, passed, actual, requirement }`. Entry parity compares ordered Hybrid/base entry timestamps. Campaign consistency counts completed campaigns where `HYBRID_LITE.netPnl - DAILY_EPISODE_MATCHED_PEAK.netPnl > 0` and requires at least two. Final verdict is `PASS` only when all eight criteria pass; otherwise `KILL`.

- [ ] **Step 5: Update JSON/Markdown and versions**

Use labels `Realized legs / all legs` and `Realized leg WR`. Add Hybrid core/tactical attribution and every kill check. Label matched peak and window-full rows simulated.

```ts
export const EVALUATOR_VERSION = "stochrsi-macro-cycle/v4";
schemaVersion: "btc-stochrsi-macro-cycle-report/v3";
```

- [ ] **Step 6: Run focused verification and commit**

Run all focused tests and targeted TypeScript from Task 3.

```bash
git add tools/stochrsi-macro-cycle/io.ts tools/stochrsi-macro-cycle/io.test.ts tools/stochrsi-macro-cycle/replay.ts tools/stochrsi-macro-cycle/replay.test.ts tools/stochrsi-macro-cycle/report.ts tools/stochrsi-macro-cycle/report.test.ts
git commit -m "feat: report Hybrid-Lite falsification evidence"
```

---

### Task 5: Generate Reproducible Evidence

**Files:**
- Modify: `assets/backtest_btc_stochrsi_macro_cycle_7y.json`
- Modify: `docs/backtest-btc-stochrsi-macro-cycle-2026-07-11.md`
- Create: `.superpowers/sdd/hybrid-lite-evidence.md` (ignored process evidence)

**Interfaces:**
- Consumes: committed clean evaluator source SHA.
- Produces: deterministic online/offline artifacts and raw Hybrid verdict.

- [ ] **Step 1: Verify and commit source before replay**

Run focused tests, targeted TypeScript, and `git diff --check`. The source tree must be clean so provenance records `gitDirty=false`.

- [ ] **Step 2: Run clean online and offline replays**

Use two isolated detached worktrees. Copy only the two Futures-specific caches into the online worktree and run:

```bash
/tmp/npm-cache-tmpfix/_npx/fd45a72a545557e9/node_modules/.bin/tsx tools/backtest-stochrsi-macro-cycle-7y.ts
```

Copy refreshed caches to the offline worktree and rerun with `--offline`. JSON must match after deleting only `generatedAt`; Markdown must match byte-for-byte.

- [ ] **Step 3: Validate artifacts**

Recompute cache hashes, reject zero funding marks, scan for `NaN`, `Infinity`, `TBD`, `TODO`, and `null%`, and inspect all Hybrid kill checks. Do not reinterpret `KILL`.

- [ ] **Step 4: Commit generated evidence**

```bash
git add assets/backtest_btc_stochrsi_macro_cycle_7y.json docs/backtest-btc-stochrsi-macro-cycle-2026-07-11.md
git commit -m "test: falsify BTC Hybrid-Lite lifecycle"
```

---

### Task 6: Adversarial Audit And Final Verification

**Files:**
- Modify only when a verified finding requires a regression fix.

**Interfaces:**
- Consumes: final committed source and artifacts.
- Produces: Grok/Claude verdicts and final verification evidence.

- [ ] **Step 1: Grok adversarial audit**

Require P0-P3 findings with exact lines for causality, partial-exit accounting, matched-control validity, and verdict math. Any valid finding gets a failing regression test before a fix and a full clean rerun.

- [ ] **Step 2: Claude independent audit**

Require reconciliation of entry parity, core/tactical counts, PnL identities, risk path, denominators, and kill criteria. Do not provide Grok's reasoning before Claude reviews.

- [ ] **Step 3: Fresh final verification**

```bash
/tmp/npm-cache-tmpfix/_npx/fd45a72a545557e9/node_modules/.bin/tsx --test tools/stochrsi-macro-cycle/*.test.ts
./node_modules/.bin/tsc --noEmit --pretty false --strict --skipLibCheck --esModuleInterop --resolveJsonModule --module commonjs --moduleResolution node --target es2022 tools/stochrsi-macro-cycle/core.ts tools/stochrsi-macro-cycle/core.test.ts tools/stochrsi-macro-cycle/io.ts tools/stochrsi-macro-cycle/io.test.ts tools/stochrsi-macro-cycle/replay.ts tools/stochrsi-macro-cycle/replay.test.ts tools/stochrsi-macro-cycle/report.ts tools/stochrsi-macro-cycle/report.test.ts tools/backtest-stochrsi-macro-cycle-7y.ts
git diff --check
git status --short
```

Expected: focused tests and targeted TypeScript pass, diff check passes, and tracked worktree is clean. Run full project TypeScript separately and report only unrelated pre-existing errors.

- [ ] **Step 4: Report without promotion language**

State mechanical `PASS` or `KILL`, raw net/drawdown/wallet results, entry parity, matched-exposure comparison, reviewer findings, commits, and no-live status.
