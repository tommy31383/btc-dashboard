# BTC Pullback Entry Research Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find a causal BTC Long entry that buys a pullback inside a confirmed higher-timeframe up-structure without waiting for a late breakout confirmation.

**Architecture:** Reuse the repository's BTC candle caches and exact-fill settlement helper. The research compares three entry families on the same position/cost/exit engine: price touching an EMA pullback zone, StochRSI oversold during a bullish context, and price-action higher-low/reclaim. Entry signals use only completed source bars and fill on the next execution bar; each candidate is evaluated on futures and spot with IS/OOS and concentration checks.

**Tech Stack:** TypeScript/Node replay tools, existing Binance JSON caches, `tsx`, TypeScript compiler, Claude bounded review through the relay packet.

## Global Constraints

- BTC only; no ETH, no Grok, no live server change.
- Closed bars only; no current/incomplete higher-timeframe candle may influence a signal.
- Exact fills: next-bar entry, gap-aware SL/TP levels, adverse fees/slippage, same-bar exit ordering documented.
- One position per campaign and no forced daily entry; signal frequency is measured, not imposed.
- Required validation: futures/spot, IS/OOS, exit sensitivity, drop-top-winner, yearly/regime breakdown.
- A positive full-sample result is `RESEARCH_ONLY` until Claude review and Tommy approval.

---

### Task 1: Establish research inputs and provenance

**Files:**
- Read: `/Users/lap16116/BTC_PC/AI_RELAY.md`
- Read: `/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-4h-entry-lane-7y-fill.ts`
- Read: `/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-pullback-7y.ts`
- Modify: `/Users/lap16116/BTC_PC/btc-dashboard/docs/audit-btc-pullback-entry-2026-07-18.md`

- [ ] Record cache paths, SHA-256 hashes, candle aggregation, indicator definition, entry fill, fees, slippage, and exit assumptions.
- [ ] Keep the existing `backtest-pullback-7y.ts` as historical context only until its fill model and overlap semantics are verified; do not call its positive rows authoritative by filename alone.
- [ ] Record the research decision boundary: no deploy or arming in this run.

### Task 2: Build the pullback entry matrix

**Files:**
- Create or modify: `/Users/lap16116/BTC_PC/btc-dashboard/tools/backtest-pullback-entry-research-7y.ts`
- Create: `/Users/lap16116/BTC_PC/btc-dashboard/tools/pullback-entry-research.test.ts`

**Entry matrix:**

| ID | HTF context | Pullback condition | Trigger |
|---|---|---|---|
| `EMA20_RECLAIM` | 1W/2W bullish, 1D K rising | 1H/4H low touches EMA20 zone | close reclaims EMA20 |
| `EMA50_RECLAIM` | same | low touches EMA50 zone | close reclaims EMA50 |
| `K10_PULLBACK` | 1W/2W bullish, weekly price not below EMA20 | 1D or 4H K<10 episode | first valid recovery/reclaim |
| `K20_PULLBACK` | same | K<20 episode | first valid recovery/reclaim |
| `HL_RECLAIM` | 1W/2W bullish | pullback makes a higher low | break of prior pullback high |
| `PULLBACK_FIRST_TOUCH` | same | first touch of the zone | next-bar entry, no late confirmation |

- [ ] Implement the state machine so one oversold/touch episode creates at most one entry until the episode resets.
- [ ] Implement context lookups from the last completed 1D/1W/2W bars only.
- [ ] Add regression tests for no-lookahead, one-entry-per-episode, next-bar fills, gap-through exits, and same-bar SL/TP ordering.
- [ ] Print sample count, win rate, PF, net R, max DD, yearly PnL, average entry distance from local swing high, and median time from pullback touch to trigger.

### Task 3: Run validation and sensitivity

**Files:**
- Modify: `/Users/lap16116/BTC_PC/btc-dashboard/docs/audit-btc-pullback-entry-2026-07-18.md`

- [ ] Run the full available BTC futures and spot caches with the same exit geometry.
- [ ] Run IS/OOS splits: futures `2020-01-01..2024-01-01` / `2024-01-01..2026-07-12`; spot `2019-01-01..2024-01-01` / `2024-01-01..2026-07-12`.
- [ ] Run exit sensitivity at `1/2 ATR, 18 bars`, `1.5/3 ATR, 24 bars`, and `2/4 ATR, 48 bars` without changing entries.
- [ ] Run minimum signal gaps `0`, `2`, and `6` execution bars to quantify rapid re-arm.
- [ ] Report drop-top-winner, yearly/regime breakdown, futures/spot agreement, and trade count. Reject candidates whose apparent edge disappears after the top winner or in OOS.

### Task 4: Claude bounded audit

**Files:**
- Modify: `/Users/lap16116/BTC_PC/AI_RELAY.md`
- Modify: `/Users/lap16116/BTC_PC/btc-dashboard/docs/audit-btc-pullback-entry-2026-07-18.md`

- [ ] Send Claude one bounded packet containing the candidate code, exact replay command, cache hashes, test output, IS/OOS table, and the top-winner/concentration table.
- [ ] Ask Claude to audit only lookahead, state transitions, exact fills, HTF alignment, overlap/cooldown, and whether the evidence supports `RESEARCH_ONLY` or `REJECTED`.
- [ ] Treat timeout or missing response as no approval; do not infer a PASS.

### Task 5: Overnight runner and closeout

**Files:**
- Modify: `/Users/lap16116/BTC_PC/btc-dashboard/docs/audit-btc-pullback-entry-2026-07-18.md`
- Modify: `/Users/lap16116/BTC_PC/AI_RELAY.md`

- [ ] Run a heartbeat loop through `2026-07-18 10:00 +07`, alternating full replay, split replay, exit sensitivity, and current-cache sanity checks.
- [ ] Record heartbeat count, last successful run, process exit, tests, Claude verdict, and final decision.
- [ ] Run regression tests, TypeScript check, and `git diff --check` before claiming completion.
- [ ] Commit only research/report changes; leave unrelated dirty files untouched.
- [ ] Do not deploy, arm, modify secrets, or change live rules.
