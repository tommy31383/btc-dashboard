# BTC 5m Deep Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** By 19:00 ICT on 2026-07-13, produce reproducible BTCUSDT perpetual-futures evidence for 5m entry timing/filter policies on current H01 signals and for causal standalone 5m mechanisms.

**Architecture:** A research-only Python package consumes the frozen Binance Futures Run 3 5m/funding caches and production H01 signal exports. One causal simulator handles next-bar fills, costs, funding, trailing exits, timing fallbacks, filtering, monthly counts, walk-forward splits, and concentration checks; no server source or live state is touched.

**Tech Stack:** Python 3 standard library, existing project indicator/evaluator helpers, JSON/JSONL evidence, `pytest`, Claude CLI for one bounded final audit.

## Global Constraints

- BTCUSDT perpetual futures only; never use the legacy spot 5m/1h caches as live evidence.
- Closed bars only; decisions on bar `t` fill no earlier than bar `t+1` open.
- Primary cost model: 4 bp fee per side, 2 bp adverse slippage per side, historical funding.
- H01 timing-only candidates preserve every source signal through a mandatory fallback entry.
- H01 filter-enabled results report removed entries and monthly counts separately.
- Standalone 5m direction is conditioned on causal 1h/4h state; no future resampled bar access.
- Discovery parameters are selected only on 2019-09-08 through 2023-12-31; 2024 onward is OOS and cannot be retuned.
- Report NET, win rate, max MTM drawdown, MAE/MFE 30m/1h/4h, monthly counts, per-year results, drop-top-20%, and parameter-neighbor stability.
- No authenticated APIs, VPS access, live edits, arming, deploy, or money-path commit.

---

### Task 1: Freeze Provenance And Baseline

**Files:**
- Create: `tools/btc_5m_research/provenance.py`
- Create: `tools/btc_5m_research/test_provenance.py`
- Create: `docs/research/btc-5m-2026-07-13/preregistration.json`

**Interfaces:**
- Produces `load_frozen_inputs()` with verified SHA-256, row counts, endpoints, monotonic timestamps, and server identity.
- Produces a production-H01 baseline row for every source signal.

- [ ] Write tests rejecting the legacy spot cache, any hash mismatch, duplicate/missing 5m timestamps, and forming-bar access.
- [ ] Implement minimal frozen input loader for `.cache/binance-futures-btcusdt-5m-run3.json` and `.cache/binance-futures-btcusdt-funding-7y.json`.
- [ ] Reproduce current H01 source count and baseline fills before evaluating candidates.
- [ ] Freeze the exact mechanisms, parameter grid, split dates, cost scenarios, and output schema in `preregistration.json`.
- [ ] Run `python3 -m pytest tools/btc_5m_research/test_provenance.py -q`; expected all pass.

### Task 2: H01 Timing-Only Policies

**Files:**
- Create: `tools/btc_5m_research/h01_timing.py`
- Create: `tools/btc_5m_research/test_h01_timing.py`

**Interfaces:**
- Produces `IMMEDIATE`, `PULLBACK_FALLBACK`, and `SWEEP_RECLAIM_FALLBACK` schedules with identical source-signal counts.
- Fallback horizons are frozen at 30 and 60 minutes; pullback/sweep thresholds are normalized by causal 5m ATR.

- [ ] Test next-bar execution, exact fallback, no lost signal, no duplicate entry, and hour-boundary resampling.
- [ ] Implement pullback-to-causal-VWAP/EMA and prior-low sweep/reclaim without outcome access.
- [ ] Record entry-price improvement, waiting cost, MAE/MFE, lifecycle PnL, and monthly counts.
- [ ] Run focused tests and baseline parity.

### Task 3: H01 Filter-Enabled Policies

**Files:**
- Create: `tools/btc_5m_research/h01_filter.py`
- Create: `tools/btc_5m_research/test_h01_filter.py`

**Interfaces:**
- Produces `TOXICITY_SKIP` and `NO_RECLAIM_SKIP` decisions using only information available before the candidate fill deadline.

- [ ] Test that filtering never changes CLOSE behavior or inspect future bars.
- [ ] Implement frozen rejection criteria from failed reclaim, displacement, relative volume, and wick/body structure.
- [ ] Report skipped count, skipped counterfactual tagged `SIMULATED`, retained realized population, and monthly frequency delta.
- [ ] Reject candidates whose benefit disappears when skipped trades are conservatively marked at baseline loss quantiles.

### Task 4: Standalone 5m Mechanisms

**Files:**
- Create: `tools/btc_5m_research/standalone.py`
- Create: `tools/btc_5m_research/test_standalone.py`

**Interfaces:**
- Produces exactly three preregistered families: `LIQUIDITY_SWEEP_RECLAIM`, `COMPRESSION_EXPANSION`, and `IMPULSE_PULLBACK_CONTINUATION`.
- Every entry has a causal 1h/4h trend/range label and next-5m-open fill.

- [ ] Test no-lookahead resampling and deterministic same-bar adverse-first exit ordering.
- [ ] Implement one small parameter neighborhood per family; do not add mechanisms after seeing OOS.
- [ ] Evaluate LONG and SHORT separately, then portfolio chronology with one-position capacity.
- [ ] Reject any family negative after costs, dependent on one market phase, or with drop-top-20% NET below zero.

### Task 5: Walk-Forward, Robustness, And Audit

**Files:**
- Create: `tools/btc_5m_research/evaluate.py`
- Create: `tools/btc_5m_research/test_evaluate.py`
- Create: `docs/research/btc-5m-2026-07-13/results.json`
- Create: `docs/research/btc-5m-2026-07-13/report.md`

**Interfaces:**
- Produces discovery/OOS, yearly/monthly, cost-stress, concentration, regime, and parameter-neighbor tables.

- [ ] Test dollar-ledger timing, fee/funding signs, MTM drawdown, drop-top-winner calculations, and zero-trade periods.
- [ ] Run discovery once, choose only a plateau candidate, and lock it before OOS execution.
- [ ] Run OOS once plus 1.5x cost stress and low/high adverse intrabar paths.
- [ ] Send one packet under 200 lines/50 KiB to Claude covering provenance, causal contract, selected evidence, concentration, and test output.
- [ ] Resolve factual audit findings, label each mechanism `ACCEPT`, `DORMANT`, or `REJECT`, and write the 19:00 report.

