# BTC_PC Overnight Autonomous Research Loop - Design

**Date:** 2026-07-12  
**Owner approval:** Scope B selected by Tommy  
**Activation gate:** A real Claude review must approve this design, or every
finding must be resolved, before the autonomous implementation loop starts.  
**Scope:** BTC-focused research across `btc-dashboard` and
`btc-trader-server`. No deployment, live arming, secret changes, or exchange
writes.

## 1. Objective

Run a continuous research process through the morning that:

1. Mines the project's existing code, reports, backtests, lessons, and rejected
   ideas into a usable evidence map.
2. Diagnoses why current live entry rules can enter after price has already
   moved and near lower-timeframe resistance.
3. Creates and falsifies new BTC entry and position-management hypotheses.
4. Uses Claude for bounded design/code review and Grok as an adversarial
   backtest auditor.
5. Produces reproducible code, data provenance, verdicts, and a morning report.

The objective is better calibrated decisions, not a guaranteed profitable rule.
The loop must report KILL or INSUFFICIENT_SAMPLE when that is what the evidence
supports.

## 2. Permission Boundary

The owner selected Scope B.

### Allowed

- Read all non-secret project code, docs, tests, reports, journals already
  committed to the workspace, and ignored historical market-data caches.
- Create isolated worktrees and research branches.
- Add dashboard research tools, tests, reports, and evidence artifacts.
- Modify `btc-trader-server` source for a research candidate only when every new
  entry path is behind a new or existing default-OFF gate.
- Commit coherent research checkpoints to a research branch.
- Run local tests and offline/online market-data refreshes that perform public,
  read-only requests.
- Use read-only VPS or Binance snapshots only when required to verify current
  production behavior, never to place or modify an order.

### Forbidden

- Run `deploy.sh`, restart PM2, rsync production, or edit production files.
- Arm a rule, change a REAL flag, remove an entry gate, or change live settings.
- Edit `/etc/btc-trader/env`, rotate credentials, read or print secret values,
  change DNS, or modify access control.
- Submit, cancel, amend, close, DCA, reverse, or otherwise mutate any exchange
  position or order.
- Change the CLOSE-before-entry-gate invariant.
- Merge live-server research changes to `main` automatically.
- Claim that a discovery-sample PASS is live validation.

## 3. Current Constraints

- The existing relay watcher is running, but `AI_RELAY.md` contains a stale
  lower STATUS block and is unsuitable as the detailed overnight state store.
- The workspace contains many historical backtest scripts and artifacts with
  inconsistent provenance. Their conclusions are not trusted until reproduced.
- Claude and Grok have quota and timeout failure modes. A failed call is evidence
  of no audit, never an implicit PASS.
- The owner previously constrained this research line to BTC. Other assets are
  not optimized or proposed as live sleeves during this run.
- Full project TypeScript currently has known unrelated errors in legacy tools.
  Every touched module still requires a clean targeted strict check.

## 4. Architecture

### 4.1 Codex supervisor

Codex owns the queue, worktrees, implementation, verification, and final report.
It runs under an explicit active goal and continues to the next useful task
without waiting for user input unless a forbidden action or genuine secret/access
blocker is encountered.

The supervisor never delegates two agents to write the same files. Long-running
backtests may overlap only with read-only inventory or review work.

### 4.2 Research state

The detailed run state lives under:

`btc-dashboard/docs/research/overnight-2026-07-12/`

Required files:

- `ledger.jsonl`: one immutable record per hypothesis or audit event.
- `knowledge-map.md`: current facts, stale claims, reusable tools, and conflicts.
- `queue.md`: ordered lanes, active item, blockers, and next item.
- `morning-report.md`: final results and recommendations.
- `packets/`: short Claude and Grok review packets.

`AI_RELAY.md` receives only short checkpoint summaries. It is not used to drive
an unbounded Claude/Grok ping-pong loop.

Each ledger record includes:

- stable hypothesis ID and parent hypothesis, if any;
- status: `QUEUED`, `RUNNING`, `KILL`, `EXPLORATORY_PASS`, `ACCEPTED`, `STALE`,
  `BLOCKED`, or `AUDIT_PENDING`;
- exact frozen rule and the conclusion it supersedes;
- source commit, dirty flag, evaluator version, data range, and data hashes;
- discovery/validation labels;
- commands and test counts;
- net dollars, trade count, win rate, drawdown, minimum wallet, and costs;
- concentration, time-split, and sensitivity results;
- Claude and Grok verdicts, including failures/timeouts;
- next decision.

### 4.3 Repository isolation

- Dashboard research uses a dedicated worktree and branch.
- Live-server candidates use a separate worktree and research branch.
- Neither branch is automatically pushed, deployed, or merged to the live-server
  main branch.
- Generated evidence is committed only after the source commit is clean and the
  report provenance points to that source.

### 4.4 Agent adapters

Claude receives packets under 250 lines and reviews one bounded question at a
time. The initial Claude task is this design audit. Later tasks cover code,
causality, accounting, test gaps, or a proposed next hypothesis.

Grok receives a compact adversarial packet only after a faithful result exists.
It attacks lookahead, data leakage, overfit, costs, concentration, no-ruin, and
verdict math. One compact retry is allowed after a timeout.

Codex remains the orchestrator. Claude and Grok may propose the next item, but
they do not deploy or arm anything.

## 5. Research Queue

### Lane A - Entry quality audit (highest priority)

Audit current live Champion and Hedge01 entries, plus the new BTC macro/tactical
research rule, using exact production signal paths where available.

For every historical entry, measure:

- prior impulse in ATR units and distance from recent swing low;
- distance to local resistance, Donchian high, EMA bands, and recent high;
- higher-timeframe structure and lower-timeframe trend state;
- volatility percentile and compression/expansion state;
- entry delay from the first qualifying context event;
- MFE and MAE after 1, 3, 6, 12, 24, and 48 bars;
- whether the entry first moved favorable or adverse;
- fee/slippage break-even and realized exit reason.

The first deliverable is a diagnosis, not a filter. A filter is proposed only if
the diagnosis identifies a repeated causal failure mechanism.

### Lane B - New entry methods

Generate one mechanism-led hypothesis at a time from these families:

1. Higher-timeframe trend plus lower-timeframe pullback/recovery.
2. Breakout followed by a causal retest rather than breakout chasing.
3. Volatility contraction followed by directional expansion.
4. Structure-aware dip entry that rejects entries directly below resistance.
5. Historical-context probability calibration used as a gate or size modifier,
   never as a lookahead label.

No family is parameter-swept across the full sample. The initial threshold or
event definition must be frozen before its first replay.

### Lane C - Position lifecycle and H05

Treat H05 as a management policy, not an entry signal. Build situation records
for losing positions and compare hold, cut, DCA, hedge, and reverse actions.

Counterfactual DCA, hedge, and reverse outcomes must be labeled `SIMULATED` and
cannot alone justify `ACCEPTED`. The first goal is a calibrated decision policy,
not more entries.

### Lane D - Knowledge and evaluator hardening

- Classify old reports as reproducible, stale, superseded, or unverified.
- Reuse faithful production evaluators instead of reimplementing signal logic.
- Add provenance or tests only when they directly unblock a research lane.
- Record known full-project test failures separately from touched-module results.

## 6. Hypothesis Cycle

Every cycle follows this order:

1. **Question:** state one causal failure mechanism or opportunity.
2. **Baseline:** identify the faithful current rule and exact comparator.
3. **Pre-registration:** freeze entry, exit, size, costs, data split, and 5-8
   mechanical PASS/KILL checks before the result is observed.
4. **Test first:** add a failing causal/accounting regression test.
5. **Implementation:** make the smallest change that executes the frozen rule.
6. **Clean replay:** record commit, data hashes, evaluator, fees, slippage,
   funding, and deterministic cutoff.
7. **Robustness:** evaluate temporal cohorts, winner concentration, reasonable
   execution-cost stress, and nearby one-at-a-time perturbations. Nearby checks
   diagnose fragility; they do not select a replacement parameter.
8. **Audit:** Claude reviews code/logic; Grok attacks the conclusion.
9. **Verdict:** record KILL, EXPLORATORY_PASS, ACCEPTED, STALE, BLOCKED, or
   AUDIT_PENDING without changing the frozen checks.
10. **Next item:** move to the next independent queue item. A killed hypothesis
    is not immediately retuned on the same data.

## 7. Evidence Standards

### Required for any positive historical claim

- Closed-bar causality and next-bar fill tests.
- Fees, adverse slippage, and funding where applicable.
- Trade count, monthly distribution, annual distribution, and realized-leg win
  rate with explicit denominators.
- Total and closed net dollars, max drawdown, worst unrealized PnL, minimum
  wallet, and fixed-wallet liquidation paths.
- Winner concentration and result without the best campaign/trades.
- Discovery versus untouched validation labels.
- Online/offline replay equality when the evaluator supports refreshed caches.

### `ACCEPTED` is deliberately hard

An overnight result may be `EXPLORATORY_PASS`, but it is `ACCEPTED` only when:

1. all frozen mechanical checks pass;
2. the result survives a pre-declared temporal holdout or walk-forward test;
3. it is not dependent on one campaign or a small jackpot set;
4. costs and no-ruin checks pass;
5. Claude has no unresolved P0-P2 finding;
6. Grok does not KILL the conclusion.

No overnight result is automatically eligible for live arming.

## 8. Continuous Execution Policy

The intended active window is from activation until approximately `07:00`
Asia/Ho_Chi_Minh on 2026-07-12.

"Continuous" means:

- keep a useful queue item active;
- while a long replay runs, perform non-conflicting read-only inventory or audit;
- if one agent is unavailable, mark its audit pending and work on another lane;
- never burn time repeatedly retrying the same failed external call;
- never manufacture more parameter combinations merely to stay busy.

The loop stops or pauses only when:

- the owner sends a stop or redirect;
- the morning cutoff is reached and the report is complete;
- a safety invariant may have been violated;
- all meaningful queued work requires unavailable credentials, secrets, live
  mutations, or user decisions;
- the same external blocker has repeated enough that no independent lane remains.

## 9. Claude-First Activation Gate

Before implementation:

1. Send Claude this design plus a short packet asking it to attack scope,
   anti-overfit controls, safety boundaries, and feasibility.
2. A quota or command failure is recorded as `CLAUDE_AUDIT_FAILED`.
3. Retry after the reported quota reset, without modifying the design merely to
   obtain approval.
4. Resolve every valid finding and rerun the audit when the finding changes a
   safety or evidence contract.
5. Activate the process only after Claude returns an explicit approve/pass with
   no unresolved P0-P2.

Grok may audit the design in parallel, but it does not replace this Claude gate.

## 10. Failure Handling

- A dirty worktree blocks evidence generation but not read-only inventory.
- A failed test blocks commit and replay for that hypothesis.
- A replay mismatch invalidates the artifact and triggers root-cause debugging.
- Claude/Grok timeout is recorded and retried once with a smaller packet.
- Unexpected live-server behavior or any possible exchange mutation stops the
  entire loop immediately.
- No script kills or resets unrelated user processes or worktrees.

## 11. Morning Deliverables

By the cutoff, produce:

1. `morning-report.md` with a plain-language verdict.
2. Entry-quality diagnosis for each audited live rule.
3. A table of every hypothesis, status, net dollars, entries, monthly coverage,
   drawdown, concentration, and audit verdicts.
4. Source commits, data hashes, exact commands, and test results.
5. Surviving candidates and the next honest validation required.
6. Killed ideas and the evidence that prevents rediscovery.
7. Explicit confirmation that nothing was deployed or armed.

## 12. Acceptance Criteria for the Process

The overnight process itself is acceptable only if:

- Claude approves this design before activation.
- A single supervisor lock prevents overlapping process instances.
- A dry run creates state and packets without editing live-server source.
- Every source-writing task uses an isolated worktree.
- Default-OFF live-server gates and CLOSE invariants have regression tests.
- Every positive conclusion has a structured ledger record and raw artifact.
- The morning report distinguishes discovery, validation, and unresolved risk.
- No deploy, arm, secret access, or exchange mutation occurs.
