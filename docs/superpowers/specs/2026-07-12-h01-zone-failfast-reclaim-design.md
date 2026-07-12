# H01 Zone Fail-Fast And Reclaim Design

## Status

Owner approved the core behavior on 2026-07-12 and requested build, commit, and
deploy. Build and research are authorized. Live activation remains conditional
on the repository's mandatory money-path evidence and review gates.

Claude is currently unavailable because its session quota is exhausted. The
Grok one-shot reviewer currently returns HTTP 402 because its usage balance is
exhausted. Neither failure is an approval. A live deployment or arming decision
must wait for explicit valid verdicts from both reviewers.

## Objective

Improve BTC Hedge01 S13/S14 handling in noisy or overhead-resistance zones
without delaying, skipping, or reducing the initial signal entry.

The current A behavior remains the initial action: enter the full normalized
target at the causal market-signal boundary. The new mechanism only manages an
early failed breakout after entry:

1. cut a rejected breakout early;
2. permit at most one full reclaim re-entry after the old position is confirmed
   closed;
3. otherwise hand the trade to the existing ATR trailing lifecycle.

This is a position-management policy attached to H01 trend trades. It is not a
new signal filter, DCA method, hedge, reverse, or forced daily-entry mechanism.

## Evidence Boundary

Frozen Run 3 compared four initial execution methods on 114 BTC H01 signals.
Immediate market entry A beat a 30/35/35 ladder, a closed-1h StochRSI wait, and a
causal retest wait. All delayed methods entered at a worse average price and
failed the preregistered winner gates. Therefore this design must not delay the
initial H01 entry.

Run 2 showed strong pre-entry impulse for S13/S14 but did not establish a
repeatable overhead-resistance signature. A posthoc merge found that adverse
first-move trades were weak, but first-move direction is an outcome and cannot
be used as a live feature. It only motivates testing a causal post-entry
acceptance/rejection state machine.

Because the hypothesis was formed after inspecting Run 2/3 summaries, the next
historical result is exploratory even if preregistered before replay. It cannot
alone be represented as untouched confirmatory evidence.

## Scope

- Asset: BTCUSDT perpetual futures only.
- Rule: Hedge01 LONG S13 and S14 only.
- S12 remains byte-for-byte behaviorally unchanged because the frozen sample
  contains only two S12 signals and it has no comparable breakout reference.
- Initial signal count and normalized target quantity must exactly equal A.
- Entry, early close, and reclaim use closed-bar causal inputs.
- Existing trailing logic remains ATR x3.0 initially and one-way ATR x3.5 after
  64 hours once the early observation policy expires or a reclaim is accepted.
- No change to Champion, H05, H04S, shortBreakdown, scheduler ordering, breakers,
  catastrophic stop ownership, or exchange credentials.

## Non-Goals

- Do not create a hard support/resistance entry filter.
- Do not wait for a pullback before the initial entry.
- Do not force a reclaim at a timeout.
- Do not DCA or add while the parent trade is losing.
- Do not open a reclaim while any child of the parent trade remains open.
- Do not infer wallet ROI, liquidation behavior, or live accepted-intent rate
  from a signal-level paired replay.
- Do not add a paper logger or shadow strategy branch.

## Frozen Causal Anchors

At confirmed initial entry, persist an immutable parent record:

- `sourceSignalTime`
- `sourceSetup` (`S13` or `S14`)
- `breakoutReference`
- `sourceAtr`
- `initialTradeId`
- `policyId`
- `policyState`
- `earlyCutConfirmed`
- `reentryUsed`
- `lastEvaluatedClosed1hTime`

Breakout references use the same closed 4h inputs as the source signal:

- S13: previous closed 4h close plus source ATR(14) x1.3.
- S14: highest high of the eighteen complete 4h bars before the source signal
  bar.

The optional zone descriptor is metadata, never an initial-entry gate:

- Overhead resistance is the nearest strict 2-left/2-right confirmed pivot high
  above source close among the prior ninety closed 4h bars.
- Distance is `(pivotHigh - sourceClose) / sourceAtr`; missing overhead
  resistance remains `null`, never zero.
- Chop uses Kaufman-style efficiency over twelve prior closed 4h closes:
  `abs(close[t]-close[t-12]) / sum(abs(close[k]-close[k-1]))`.
- Every pivot must satisfy `pivotIndex + 2 <= sourceIndex - 1`.

## Candidate Policies

The research family contains exactly three candidates plus baseline A. No broad
grid or post-outcome threshold search is allowed.

### F1 - Buffered Responsive

- Observation window: first 8 hours after initial confirmed fill.
- Reject at the first closed 1h close strictly below
  `breakoutReference - 0.25 * sourceAtr`.
- Submit an early close through the normal H01 close path.
- After confirmed close, allow one reclaim until 12 hours after source signal.
- Reclaim requires one closed 1h close strictly above
  `breakoutReference + 0.25 * sourceAtr`.
- No reclaim by the deadline means the parent lifecycle is complete.

### F2 - Persistent Rejection

- Observation window: first 8 hours after initial confirmed fill.
- Reject after two consecutive closed 1h closes strictly below the unbuffered
  breakout reference.
- After confirmed close, allow one reclaim until 16 hours after source signal.
- Reclaim requires two consecutive closed 1h closes strictly above the
  unbuffered breakout reference.
- No forced reclaim.

### F3 - Zone-Gated Responsive

- Entry and thresholds are identical to F1.
- Early rejection management is active only when source metadata has either:
  - non-null overhead resistance distance at or below 1.0 ATR; or
  - twelve-bar efficiency at or below 0.30.
- A source outside both conditions follows baseline A with no early cut or
  reclaim.

The thresholds are fixed design candidates, not live defaults. Only a candidate
that survives all evidence gates may be selected for implementation.

## State Machine

```text
SOURCE_SIGNAL
  -> INITIAL_ENTRY_PENDING
  -> OBSERVING
       -> observation expires ---------------------> BASELINE_TRAIL
       -> rejection close requested ---------------> EARLY_CLOSE_PENDING
            -> close uncertain/failed -------------> BLOCK_NEW_ENTRY + ALERT
            -> close confirmed --------------------> WAITING_RECLAIM
                 -> reclaim expires ---------------> COMPLETE
                 -> reclaim gate blocked ----------> WAITING_RECLAIM
                 -> reclaim intent accepted -------> REENTRY_PENDING
                      -> accepted ------------------> RECLAIM_TRAIL
                      -> uncertain/failed ----------> BLOCK_DUPLICATE + ALERT
```

`RECLAIM_TRAIL` uses a fresh entry price and the immutable source ATR, matching
the experiment contract. The live implementation must not infer a fill or
position from an order request; transitions occur only from confirmed intent
outcomes.

## Live Safety Invariants

- CLOSE remains evaluated and executable before every NEW-entry gate.
- Early close cannot be blocked by daily loss, consecutive loss, HWM, panic,
  ownership uncertainty, or reclaim eligibility.
- Reclaim is a NEW ENTRY. It must pass the existing scheduler freshness,
  recovery, breaker, ownership, capacity, HWM, and panic gates.
- A reclaim must use the normal intent journal and exchange submission path.
- Exactly one reclaim intent key exists per parent source signal. Restart,
  duplicate scheduler ticks, and lost ACK recovery cannot create a second order.
- Reclaim is impossible until the parent close is confirmed and owned exposure
  for that trade is zero.
- A manual or foreign position is never adopted as the parent or reclaim.
- Re-entry never bypasses trend-side quantity caps.
- Missing/malformed policy state fails closed for NEW reclaim while preserving
  management of an existing position.
- Every rejection, confirmed early close, blocked reclaim, accepted reclaim,
  uncertain intent, and policy exception is sent through central Telegram
  alerts.

## Research Replay

### Inputs

- Reuse the hash-frozen Run 2 signal population and Run 3 Binance Futures 1h,
  5m, and funding caches.
- Import the hash-checked production H01 signal/ATR/trailing functions.
- Verify source signal close and breakout reference parity before outcomes.
- Use complete closed 1h boundaries for policy transitions and the next 5m open
  for market execution.

### Costs And Outcomes

- Primary: 4 bps fee and 2 bps adverse market slippage per side.
- Stress: 6 bps fee and 5 bps adverse market slippage per side.
- Include funding for every actual holding interval.
- Use both `LOW_HIGH` and `HIGH_LOW` 5m path conventions.
- Each initial entry and reclaim receives a complete 20-day child horizon.
- Compare signal-level behavior first, then run a chronological portfolio replay
  with source cooldown, trend capacity, confirmed-close timing, and reclaim NEW
  entry gates. A candidate cannot proceed on signal-level evidence alone.

### Required Outputs

- Initial source signals, initial accepted intents, early cuts, reclaim attempts,
  reclaim accepted intents, blocked reclaims, child orders, and total turnover.
- Net dollars, gross-notional return, win rate, profit factor, mean/median return,
  max drawdown, fees, funding, MFE/MAE, and hold duration.
- Results by setup, year, zone descriptor, discovery/validation split, and policy
  transition reason.
- Delta versus A under primary, stress, alternate intrabar path, drop-top-10%,
  remove-best-month, and threshold perturbation diagnostics.

## Inference And Winner Gate

Use the existing purged Run 2 discovery/validation assignment and deterministic
calendar-month block bootstrap. Correct confidence for the three candidate
comparisons F1-A, F2-A, and F3-A.

A candidate may advance only when all are true:

1. Initial source signal count and normalized initial target quantity equal A.
2. No paired censoring difference versus A.
3. Validation net-dollar delta is positive and its corrected confidence lower
   bound is above zero.
4. Full-sample net dollars and profit factor are at least A.
5. Chronological portfolio max drawdown is no worse than A.
6. Delta remains positive under stress costs and both intrabar conventions.
7. Delta remains positive after dropping the candidate's top 10% winners and
   after removing its best month.
8. Extra fees do not account for a negative validation delta.
9. No duplicate reclaim, DCA, capacity bypass, or close-gate violation occurs.

Failure of every candidate produces `NO_ZONE_POLICY_WINNER`. Passing these gates
still produces only `EXPLORATORY_CANDIDATE` because the hypothesis used already
seen Run 2/3 evidence.

## Falsification

- F1/F2 without re-entry: determine whether value comes from cutting or reclaim.
- Re-entry without early cut is forbidden because it becomes DCA/duplicate
  exposure, but assert the runtime rejects it.
- Apply F1 to every S13/S14 source without zone metadata and compare with F3 to
  test whether the zone classifier adds value.
- Shift every policy transition one closed 1h bar later.
- Perturb buffer by +/-0.10 ATR and efficiency by +/-0.05 only as stability
  diagnostics; never select the best perturbation.
- Report S13 and S14 separately; no pooled setup claim.
- Report 2025 separately because baseline A was weak in that year.

## Implementation Architecture

Phase 1 is dashboard research only:

- `tools/h01-zone-policy/`: immutable config, causal policy state machine,
  replay, portfolio simulation, metrics, provenance, and tests.
- `docs/research/run-4-2026-07-12-h01-zone-policy/`: authorization,
  preregistration, raw rows, aggregate, audits, ledger, and report.

Phase 2 is server implementation only after a candidate passes and audits are
available:

- Extend H01 trend trade state with a versioned optional policy record.
- Keep policy transition logic pure and shared between replay and server.
- Route early close through `evalClose`; route reclaim request through the normal
  scheduler entry/intent path.
- After the server pure policy function exists, rerun the selected replay by
  importing that hash-checked production function and require byte-equivalent
  policy transitions versus the research candidate before any arming decision.
- Default policy remains hard-off until an explicit arming commit and deploy.
- Version bump and deployment follow `btc-trader-server/AGENTS.md` exactly.

## Test Contract

Research tests must cover causal indexing, exact candidate constants, boundary
strictness, one-hour closed-bar alignment, timeout expiry, fee/funding, paired
censoring, bootstrap correction, and status routing.

Server tests must cover:

- baseline parity when policy is off;
- S12 parity under every policy setting;
- early close remains allowed under every breaker;
- reclaim is blocked by every NEW-entry gate;
- confirmed-close-before-reclaim ordering;
- restart/idempotency/lost-ACK duplicate prevention;
- one-reclaim maximum;
- capacity and ownership isolation;
- malformed state migration;
- Telegram escaping and alert coverage;
- catastrophic-stop reconciliation after close and reclaim.

## Commit And Deployment Gate

Research source, preregistration, and final evidence use separate commits. Server
implementation, if authorized by evidence, uses a separate money-path commit.

No server deploy is allowed while either mandatory reviewer is unavailable. A
valid deploy requires:

1. faithful backtest and portfolio replay winner;
2. Codex self-audit with no unresolved P0-P2;
3. Claude bounded review with no unresolved P0-P2;
4. Grok adversarial `ALLOW` verdict;
5. complete server test suite and diff/secret review;
6. explicit selected `policyId` and arming state;
7. post-deploy public version, PM2, logs, Telegram, position ownership, and
   catastrophic-stop verification.

If the reviewers remain unavailable, stop after committed research/build
evidence and report `AUDIT_PENDING`; do not relabel that state as deployed.
