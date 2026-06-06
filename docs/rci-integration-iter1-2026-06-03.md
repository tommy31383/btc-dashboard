# RCI Integration — Iteration 1

**Date:** 2026-06-03
**Goal:** Apply Reversal Confluence Index (RCI v3) to improve hedge01-BTC live rule (v0.4.75) via backtest.
**Window:** 3y (2023-05-25 → 2026-05-24, funding-rate availability). Capital $100k simulated.
**Script:** `btc-dashboard/tools/rci-integration-iter1.py`
**Verdict (1 line):** **BOTH RCI overlays REJECTED. RCI as a trade trigger destroys hedge01's edge — it is an observation/alert tool only, not a trading signal. KEEP hedge01 v0.4.75 unchanged.**

---

## RCI v3 formula used

Per `docs/rci-indicator-research-2026-06-03.md`:
```
raw = Funding(×2.0) + RSI(×1.5, 4h + 1h½) + Stoch(×0.8, 4h + 1h½) + BB%B(×0.8, 4h) + MACD(×0.4, neutralized)
RCI = EMA(raw, 3)
POSITIVE = bearish/top pressure ; NEGATIVE = bullish/bottom pressure
```
Thresholds: >+4.0 BEAR_STRONG (exit trigger), <−2.5 BULL_STRONG (entry trigger).

**Calibration note (limitation):** my live-scaled formula runs hotter than the doc's reference. In the 3y window RCI>4.0 fired 420 times (vs the doc's ~5/yr precision-study count). To make sure the REJECT was not just a too-trigger-happy threshold, I swept the exit threshold 4.0→7.0 (see Task 1).

---

## TASK 3 — Baseline hedge01 v0.4.75 (3y, RANGE-only LONG breakout)

Config: ADX18/12, SL3.0/3.5 trans@16(64h), ATR_BREAK1.3, VOL1.4/16, DLB18, RANGE-only LONG, S12/S13/S14.

| Metric | Value |
|---|---|
| n trades | **81** |
| RA (per-trade) | **+0.360** |
| Sharpe (annualized) | **+1.87** |
| Win rate | 56% |
| avg win / avg loss | +7.28% / −3.09% |
| ROI | **+216.2%** ($+216,228) |
| MaxDD | 23.3% ($23,251) |
| Stability | **3/3 years positive** |
| Per-year | 2023 +16% · 2024 +162% · 2025 +38% |
| Exits | 100% ATR stop |

hedge01 is healthy on the 3y window — strong asymmetry (R:R ~2.4), every year green.

---

## TASK 1 — RCI EXIT overlay (hold LONG + RCI>+4.0 → exit immediately)  → **REJECT**

| Metric | Baseline | + RCI-EXIT (thr 4.0) | Δ |
|---|---|---|---|
| n | 81 | 81 | 0 |
| Sharpe | +1.87 | **+0.23** | **−1.64** |
| ROI | +216% | **+9.1%** | **−207pp** |
| $ | +216,228 | +9,112 | **−$207,116** |
| MaxDD | 23.3% | 27.7% | +4.5pp |
| avg win | +7.28% | **+1.76%** | winners gutted |
| Exits | 81 SL | 19 SL / **62 RCI** | — |

**Threshold sweep (robustness):**

| Exit thr | Sharpe | ROI | $ vs base | Verdict |
|---|---|---|---|---|
| 4.0 | +0.23 | +9% | −$207k | REJECT |
| 5.0 | +1.33 | +84% | −$132k | REJECT |
| 6.0 | +1.54 | +142% | −$74k | REJECT |
| 7.0 | +1.84 | +186% | −$30k | REJECT (≈baseline) |

**Why it fails:** hedge01's edge is *letting winners run* on the ATR trail (avgW +7.28%). RCI hits BEAR_STRONG during strong uptrends (BTC can stay overbought + high-funding for weeks), so the overlay sells into the middle of winning legs. Damage is monotonic in the threshold: the *best* RCI-exit can do is "fire almost never and equal baseline." It never improves on doing nothing. Selling at an RCI-top **cuts winners early**, it does not lock in more profit. This matches the standing lesson "Expectancy ở ENTRY, không ở xử-lý-lỗ" — and here, not in trimming winners either.

---

## TASK 2 — RCI ENTRY boost (RCI<−2.5 + RANGE + ADX>18 → LONG, no breakout)  → **REJECT**

| Metric | Baseline | + RCI-ENTRY | Δ |
|---|---|---|---|
| n | 81 | 126 (+45) | more entries ✓ |
| Sharpe | +1.87 | **+1.34** | **−0.53** ✗ |
| ROI | +216% | +177.8% | −38pp |
| $ | +216,228 | +177,811 | **−$38,417** |
| MaxDD | 23.3% | **37.9%** | **+14.7pp** ✗ |
| WR | 56% | 45% | worse |

**Isolated RCI-entry trades (the 45 added):**

| Metric | Value |
|---|---|
| n | 45 |
| RA | **−0.174** |
| Sharpe | −0.67 |
| WR | 27% |
| ROI | **−38.4%** ($−38,417) |
| MaxDD | 71.4% |
| Stability | **1/3 years** (2023 +33% · 2024 −40% · 2025 −32%) |

**Why it fails:** the accept gate required *more entries AND Sharpe maintained AND per-period stability*. It added entries but Sharpe fell, MaxDD nearly doubled, and the new trades are net-negative (−$38k) with 1/3 stability. Buying RCI-bottoms = catching falling knives without breakout confirmation. RANGE+ADX>18 is not enough; the funding component is almost never negative (min −0.00015, only 15% of bars <0), so BULL signals are driven by oversold RSI/Stoch — exactly the "OB/OS not predictive in trending market" failure flagged in the research KILL LIST.

---

## Recommendation

**Deploy NONE of the RCI overlays.** Keep hedge01 v0.4.75 exactly as-is.

RCI is confirmed as an **observation/alert tool**, not a trade trigger — consistent with the research doc's own caveat ("Không phải trading signal"). Acceptable non-trading uses (no backtest edge, but harmless UI):
- Dashboard panel showing current RCI zone (informational).
- Funding>0.0005 alert as a *manual* caution flag (the one component with real precision, 64% for tops).

Do **not** wire RCI into entry/exit logic of any live engine.

---

## Next iteration ideas

1. **RCI as size-down, not exit.** Instead of full exit on BEAR_STRONG, test reducing new-entry size (skip *new* entries while RCI>3.0) — never touch open winners. Tests "don't add into crowding" without cutting trails.
2. **Funding-only top filter.** Drop technical components; test funding>0.0005 as a pure "block new LONG for 24h" gate. Isolates the one 64%-precision signal.
3. **OI proxy for 7y.** Funding only covers 3y → 3 years is thin. Backtest a funding-proxy (open-interest delta) to validate across 2019–2022 before trusting any funding-based rule.
4. **Recalibrate RCI scaling** so live thresholds match the doc's precision study (RCI>4.0 ≈ 5/yr, not 420/3y) before any further trigger experiments — current scaling makes thresholds non-comparable to research.
5. **Forward-test funding alert in paper** for 3 months (per research NEXT STEPS) rather than backtest-fitting BULL precision.
