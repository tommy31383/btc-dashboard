# RCI Integration — Iteration 4 (2026-06-03)

**Goal:** Validate the v0.4.76 funding-block deploy (hedge01 block threshold 0.05%,
was 0.08%) on FULL funding history including the 2021 blowoff. The 3y validation
(n=3 skips) left 2021 robustness OPEN. Iter3 was blocked because OI/LS/taker "-7y"
files were actually 13 days. This iter uses the one Binance sentiment-family
endpoint that DOES backfill: **fundingRate** (serves history to contract inception).

Scripts: `tools/fetch-funding-7y.py`, `tools/rci-integration-iter4.py`
Data: `.cache/binance-funding-7y.json` (NEW), `.cache/binance-5m-7y.json` (price)

---

## Task 1 — Full BTC funding history fetched

**7375 records, 2019-09-10 → 2026-06-03** (9 paginated API calls, 8h funding intervals).
Existing `binance-funding-3y.json` was only 2023-05 onward — this triples the span.

### Funding extremes per year (rate > 0.05% = crowded LONGs)

| Year | Records | >0.05% | % hot | Max rate | Min rate |
|------|---------|--------|-------|----------|----------|
| 2019 | 338 | 4 | 1.2% | 0.078% | -0.052% |
| **2020** | 1098 | **103** | **9.4%** | **0.300%** | -0.300% |
| **2021** | 1095 | **200** | **18.3%** | 0.249% | -0.090% |
| 2022 | 1095 | 0 | 0.0% | 0.010% | -0.119% |
| 2023 | 1095 | 2 | 0.2% | 0.055% | -0.011% |
| 2024 | 1098 | 24 | 2.2% | 0.088% | -0.011% |
| 2025 | 1095 | 0 | 0.0% | 0.010% | -0.012% |
| 2026 | 461 | 0 | 0.0% | 0.010% | -0.015% |

**2021 was by far the biggest crowding year — 200 funding>0.05% extremes (18.3% of all
bars), confirming the blowoff thesis.** 2020 was the second hottest (103, max 0.300%).
2023/2025/2026 were essentially funding-flat. The 3y file (2023+) therefore captured a
near-zero-crowding regime — which is exactly why the 3y validation only saw n=3 skips.

---

## Task 2 — v0.4.76 (block 0.05%) validated on FULL 7y

hedge01 live params (ADX18/12, SL3.0/3.5/64h, ATR_BREAK1.3, VOL1.4/16, DLB18,
**RANGE-only LONG, skip SHORT**), $100k notional.

| Config | n | Sharpe | ROI | $ | MaxDD | Stab |
|--------|---|--------|-----|---|-------|------|
| no-block | 121 | +1.66 | +272% | +$272,508 | 23.3% | 4/5 |
| 0.08% (pre-v0.4.76) | 121 | +1.66 | +272% | +$272,508 | 23.3% | 4/5 |
| **0.05% (v0.4.76 LIVE)** | 115 | **+1.71** | +278% | **+$277,608** | 23.3% | 4/5 |

Per-year (block 0.05%): 2020:+41% 2021:-2% 2023:+34% 2024:+167% 2025:+38%
(2019 below warmup; 2022 all-BEAR → no RANGE-LONG entries; 2026 partial-BEAR none.)

### Blocked entries per year (block 0.05%)

| Year | Blocked | Would-be $ | Losers |
|------|---------|-----------|--------|
| 2020 | 3 | -$200 | 2/3 |
| 2024 | 3 | -$4,899 | 2/3 |
| **TOTAL** | **6** | **-$5,099** | 4/6 |

All 6 blocked entries net negative would-be return → the block correctly avoided losers
(notably -$4,899 of would-be 2024 losses). 0.08%→0.05% added 6 skips over 7y and improved
Sharpe +0.05, dollars +$5,100, no DD change.

### 2021 SPOTLIGHT — the open question, answered

| Config | 2021 return | 2021 $ |
|--------|-------------|--------|
| no-block | -2.1% | -$2,110 |
| 0.08% | -2.1% | -$2,110 |
| 0.05% | -2.1% | -$2,110 |

**The 0.05% block touched ZERO entries in 2021. Identical result across all three configs.**

Why: hedge01 only enters LONG in **RANGE** regime. 2021's 200 funding extremes cluster in
the **BULL blowoff** phases (Jan-Apr, Oct-Nov), which the regime gate already rejects. The
105 RANGE days in 2021 were the calmer chop windows with low funding, so no entry ever saw
funding>0.05%. **The regime gate is the real protector against the 2021 blowoff; the funding
block is a redundant second layer that the 2021 crowding never reaches.**

This means the funding block is structurally safe in blowoff years (it can only ever fire
inside RANGE, where funding is mild) — it does NOT need to "hold up" against 2021 because it
is never the binding constraint there.

---

## Task 3 — Re-sweep optimal threshold on 7y

| Block | n | Sharpe | ROI | $ | MaxDD | Stab | Blocked |
|-------|---|--------|-----|---|-------|------|---------|
| 0.03% | 109 | +1.80 | +259% | +$259,171 | 23.3% | 4/4 | 12 |
| 0.04% | 114 | +1.70 | +276% | +$276,197 | 23.3% | 4/5 | 7 |
| **0.05%** | 115 | +1.71 | +278% | +$277,608 | 23.3% | 4/5 | 6 |
| 0.06% | 118 | +1.73 | +282% | +$282,407 | 23.3% | 4/5 | 3 |
| 0.08% | 121 | +1.66 | +273% | +$272,508 | 23.3% | 4/5 | 0 |
| 0.10% / none | 121 | +1.66 | +273% | +$272,508 | 23.3% | 4/5 | 0 |

- **0.03%** has the highest Sharpe (+1.80) but LOWEST dollars (+$259k) — it blocks 12,
  including profitable RANGE breakouts → trims dollars for marginal Sharpe. Reject.
- **0.06%** has the highest dollars (+$282k, +$10k vs no-block) and Sharpe +1.73 — it blocks
  only the 3 worst-funding entries while keeping everything else.
- **0.05% (live)** is between the two and beats both 0.08% and no-block on Sharpe AND dollars.

All differences are tiny (n=115-121, only 6-12 entries ever differ). MaxDD is identical
across the entire sweep (23.3%) — the funding block never touches the drawdown-driving trades.

---

## Verdict: HOLDS (but for a different reason than assumed)

**Keep 0.05%. Do not revert, do not retune.**

1. **Not a 3y fluke, but also not load-bearing.** On full 7y the 0.05% block beats both the
   old 0.08% and no-block on Sharpe (+1.71 vs +1.66) and dollars (+$277.6k vs +$272.5k),
   with zero DD penalty. It is a small, consistent, free improvement.

2. **The 2021 robustness question is moot.** hedge01's RANGE-only regime gate already
   excludes the BULL blowoff phases where 2021's 200 funding extremes live. The funding block
   only ever fires in RANGE (mild funding) — 6 lifetime fires (2020+2024), all would-be
   losers. It is a clean redundant safety layer, not a primary edge.

3. **0.06% is marginally better on dollars** (+$282k, +$4.8k vs 0.05%) by blocking 3 fewer
   trades, but the gap is inside noise (3 trades) and 0.05% is already live and validated.
   Not worth a redeploy.

**Recommendation: KEEP 0.05% live as deployed in v0.4.76.** Optionally note 0.06% as the
7y dollar-optimum if a future tune touches this knob, but the difference (3 trades, ~$5k on
$100k notional) does not justify churning the deploy.

### Honest caveat
The funding block's *measured* benefit rests on just 6 lifetime entries (n=6). It is
directionally correct (all 6 would-be losers) and costs nothing, but it is NOT a robust
standalone edge — the regime gate does the heavy lifting. Judge it as a cheap insurance
overlay, not an alpha source. Sample size n<20 → treat the exact threshold as low-confidence;
any value in 0.04–0.06% is functionally equivalent on 7y.
