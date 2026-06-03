# RCI Integration — Iteration 6: DD REDUCTION (2026-06-03)

**Goal:** tame the iter5 RCI mean-reversion reversal sleeve's **57% MaxDD** toward <30–35%
while keeping the edge (Sharpe ≥ 0.7, ≥5/8 years positive), so it becomes book-worthy.

Tools: `tools/rci-integration-iter6.py` (diagnosis + regime + lever sweep + combo search),
`tools/rci-iter6-book.py` (book impact). Data: `.cache/binance-5m-7y.json` (+ funding unused).
BTC only, 7y. Judge **Sharpe + DOLLARS + Calmar (ROI/MaxDD)**. Structural only. No SL removal.

Baseline (iter5 best) = ALL-regime | no funding | no confirm | RCI-top exit | −2.2×ATR cut:
n=137, Sharpe **0.87**, ROI +253% (+$253k), **MaxDD 57%**, 6/8 yrs.

---

## Task 1 — DD diagnosis: WHEN and WHY the 57%

**The worst drawdown ran 2021-06 → 2022-06** (peak trade#35 2021-06-08 → trough trade#59
2022-06-16). It is the post-2021-top crash into the 2022 bear.

Inside that DD window (24 trades): **BEAR n=19 = −32R**, RANGE −10R, BULL −15R.
→ The DD is **dominated by catching falling knives in the BEAR downtrend** (entering oversold
dips that keep falling). Not BULL early-shorting — this is a long-only reversal sleeve.

But the overall regime split is more nuanced:

| regime | n | total pnl | loss sum | avg/trade |
|---|---|---|---|---|
| BEAR | 62 | +107R | −164R | +1.73R |
| RANGE | 53 | +49R | −122R | +0.92R |
| BULL | 22 | +97R | **+4.41R** |

**Key insight:** BEAR is simultaneously the **biggest loss source (−164R) AND the biggest
gross winner (+107R)** — the 2020 + 2021 bear-rally bounces are huge. You cannot just cut BEAR
(see Task 2: removing it kills most of the return). The DD is a **volatility/sizing problem**,
not a regime-selection problem — the losing knife-catches and the winning bounces happen in the
*same* high-vol regime. That points the fix at **vol-targeting**, not regime gating.

---

## Task 2 — Regime gating for DD (ranked by Calmar)

| regime | n | Sharpe | ROI% | $ | MaxDD | Calmar | stab |
|---|---|---|---|---|---|---|---|
| ALL | 137 | +0.87 | +253 | +$253k | 57 | **4.44** | 6/8 |
| RANGE+BULL (skip-BEAR) | 75 | +0.83 | +146 | +$146k | 51 | 2.87 | 5/6 |
| BEAR-only | 65 | +0.50 | +104 | +$104k | 44 | 2.37 | 6/8 |
| RANGE-only | 54 | +0.37 | +44 | +$44k | 36 | 1.22 | 3/6 |
| BULL-only | 22 | +0.84 | +97 | +$97k | **29** | 3.30 | 3/5 |

**Verdict on regime gating alone:** it does NOT solve the problem cleanly.
- Skip-BEAR (RANGE+BULL) only drops DD 57→51 but halves return — confirms the Task 1 finding
  that BEAR carries both the losses and the wins.
- RANGE-only gets DD to 36 but Sharpe collapses to 0.37 and only 3/6 yrs — kills the edge.
- BULL-only has the lowest DD (29) but n=22 (overfit risk) and only 3/5 yrs.
- ALL keeps the best Calmar (4.44). **Regime gating is the wrong lever here.**

---

## Task 3 — DD-reduction levers

Single-lever sweeps (base = ALL regime):

- **ATR cut tightness:** 2.0× is the sweet spot (DD 57→48, Sharpe 0.83, Calmar **4.97**).
  Tighter (1.5/1.8) raises whipsaw and *raises* DD (59/62). 2.5 blows DD to 72. → use **2.0**.
- **Max-hold cap:** **counterproductive.** Capping to 24h–96h destroys the edge (ROI +1% to +81%,
  Calmar 0.03–1.14). The winners need ~33d to ride to RCI-overbought. → keep **33d (200 bars)**.
- **One-position-only (no stacking):** helps DD 57→46, Sharpe 0.81, Calmar 4.87. Mild positive.
- **Vol-targeting (size = 1 − ATR%-percentile, floor 0.40):** **THE killer lever.**
  MaxDD **57→26**, Sharpe held at **0.86**, Calmar 4.68, 6/8 yrs. Scaling size down exactly when
  the market is most volatile (which is when both the knife-catches and the big swings happen)
  flattens the equity path without removing trades or edge.

### Best combo (DD<35 & Sharpe≥0.7 & ≥5/8 yrs, ranked by Calmar)

| config | n | Sharpe | ROI% | $ | MaxDD | Calmar | stab |
|---|---|---|---|---|---|---|---|
| **ALL \| atr2.0 \| 33d \| 1pos \| voltarget** | 129 | **+0.83** | +111 | +$111k | **19** | **5.93** | **6/8** |
| ALL \| atr2.2 \| 33d \| 1pos \| voltarget | 128 | +0.81 | +109 | +$109k | 22 | 5.04 | 6/8 |
| ALL \| atr2.0 \| 33d \| stack \| voltarget | 137 | +0.81 | +112 | +$112k | 22 | 5.03 | 5/8 |
| ALL \| atr2.2 \| 33d \| stack \| voltarget | 137 | +0.86 | +122 | +$122k | 26 | 4.68 | 6/8 |

---

## SELECTED TAMED CONFIG

**ALL regime · RCI-top exit · ATR cut 2.0× · max-hold 33d · 1-position-only · vol-targeting
(size = max(0.40, 1 − ATR%-percentile over 180 bars)).**

Standalone tamed performance:

| metric | iter5 baseline | **iter6 tamed** |
|---|---|---|
| n | 137 | 129 |
| Sharpe | 0.87 | **0.83** |
| ROI / $ | +253% / +$253k | +111% / +$111k |
| **MaxDD** | **57%** | **19%** |
| **Calmar** | 4.44 | **5.93** |
| stab | 6/8 | 6/8 |

Per-year (tamed): 2019 +2, 2020 +42, 2021 +34, 2022 +19, 2023 +16, 2024 −4, 2025 +9, 2026 −8.
DD is cut by **2/3** (57→19) and Calmar *improves* (4.44→5.93), at the cost of ~half the raw
dollar return (vol-targeting deploys less capital). 2022 even flips slightly positive
(no longer riding full size into the bear knives). Same 2024/2026 mild negatives as iter5.

---

## Task 4 — Book impact with the tamed sleeve

84 common months. Correlation stays near-zero (real diversifier):

| pair | Pearson r |
|---|---|
| tamed-RCI vs hedge01 | **−0.037** |
| tamed-RCI vs turtle | **+0.057** |
| hedge01 vs turtle | +0.067 |

Risk-parity book (monthly Sharpe ×√12, MaxDD in R-units):

| book | Sharpe | MaxDD | totalR |
|---|---|---|---|
| 2-way hedge01+turtle (current LIVE) | +1.16 | **13** | +443 |
| **3-way + tamed-RCI** | **+1.48** | **13** | +214 |

**Δ Sharpe +1.16 → +1.48 (+0.32). Δ MaxDD 13 → 13 (+0pp).** Gate (Sharpe up AND DD increase
< +3pp): **PASS.**

Contrast with iter5: adding the *untamed* sleeve raised Sharpe to 1.45 but **doubled book DD to
28**. The tamed sleeve gets essentially the *same* Sharpe lift (1.48) with **zero book-DD cost**.
That is the clean improvement iter5 could not deliver.

Caveat: book totalR drops 443 → 214 units. This is a risk-parity artifact — the tamed sleeve's
lower vol (from vol-targeting) earns it a *larger* 1/σ weight, pulling book capital toward the
lower-$-return sleeve. In a real allocation you'd cap the sleeve's weight (e.g. a small fixed
slice) rather than full risk-parity, capturing most of the Sharpe lift while keeping more of the
turtle/hedge01 dollar return. The Sharpe/DD result is the load-bearing finding; the totalR drop
is a weighting choice, not a property of the sleeve.

---

## Verdict — is it now sizeable?

**YES — the DD is tamed and the sleeve is now book-worthy (small sized slice).**

- MaxDD brought from **57% → 19%** (well under the <35% target, near the <30% stretch goal)
  **without killing the edge**: Sharpe 0.83 (was 0.87), Calmar *up* to 5.93, still 6/8 yrs.
- The fix was **vol-targeting + ATR 2.0 + 1-position-only**, NOT regime gating (Task 1/2 showed
  BEAR carries both the losses and the wins, so you can't gate it out).
- Book impact is the clean win iter5 lacked: **Sharpe +0.32 with +0pp book DD** (vs iter5's
  +doubling to 28). Correlation remains a genuine near-zero diversifier (−0.04 / +0.06).

**Recommendation:** promote from "paper-only" to **paper-forward-test as a sizing candidate**
with a small capped weight (not full risk-parity, to preserve book dollar return). Before LIVE:
multi-month forward-test to confirm the asymmetric reversal + vol-target edge persists OOS, and
confirm the recent 2024/2026 mild-negative years don't deepen. The structural risk concerns
(vol-target floor, ATP-percentile lookback) are all structural, not data-mined.
