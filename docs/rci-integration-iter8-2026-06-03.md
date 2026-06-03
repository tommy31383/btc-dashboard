# RCI Integration — Iteration 8: Era / Regime Robustness of the Reversal Sleeve
**Date:** 2026-06-03
**Goal:** FINAL validation before trusting the deployed paper logger (v0.4.77 `reversalPaperLogger`).
**Question:** Is the BTC mean-reversion (oversold dip-buy) sleeve a *structural* edge, or a *2019-21 bull-dip-buying artifact* that won't repeat?

**Tamed config under test** (from iter6 SELECTED):
`ALL regime · RCI-top exit · ATR cut 2.0× · max-hold 200 bars (33d) · 1-position-only · vol-targeting (floor 0.40)`
All numbers size-weighted (the sleeve as actually deployed). $100k notional reference. BTC only.

**Full 7y baseline:** n=129, Sharpe +0.83, ROI +111%, $+110,858, MaxDD 19%, WR 37%, avgWin +5.39%, avgLoss −1.83%, stab 6/8.

---

## Task 1 — Era split

| Era | n | Sharpe | ROI% | $ | WR% | MaxDD% | avgWin% | avgLoss% | posYr |
|-----|---|--------|------|---|-----|--------|---------|----------|-------|
| 2019-2020 | 24 | **+1.28** | +45 | +44,892 | 46 | 7 | +6.46 | −2.01 | 2/2 |
| 2021 | 16 | **+1.31** | +34 | +34,304 | 38 | 11 | +10.20 | −2.69 | 1/1 |
| 2022 | 26 | +0.92 | +19 | +18,985 | 38 | 13 | +5.04 | −1.96 | 1/1 |
| 2023-2024 | 31 | +0.55 | +12 | +11,919 | 35 | 13 | +3.83 | −1.51 | 1/2 |
| 2025-2026 | 32 | **+0.04** | +1 | +759 | 31 | 14 | +3.43 | −1.52 | 1/2 |

Per-year size-weighted ROI:
`2019 +2.4% · 2020 +42.5% · 2021 +34.3% · 2022 +19.0% · 2023 +16.1% · 2024 −4.2% · 2025 +8.9% · 2026 −8.2%`

**Where the edge lives:** It does **not** live everywhere — it decays monotonically.
Sharpe path 1.28 → 1.31 → 0.92 → 0.55 → **0.04**. The avg win shrinks from 6–10% (2019-21) to ~3.4% (2025-26) while avg loss is flat — i.e. the *payoff asymmetry that powers the edge is disappearing*. The big years are 2020 (+42%) and 2021 (+34%): the covid-recovery V and the blowoff-top bull. Those are exactly the "dip-buy a roaring bull" regimes.

---

## Task 2 — Regime breakdown (1d regime at entry)

**Full 7y:**

| Regime | n | Sharpe | ROI% | $ | WR% | avgWin% | avgLoss% | expectancy%/trade |
|--------|---|--------|------|---|-----|---------|----------|-------------------|
| BULL | 19 | +0.81 | +41 | +40,891 | 42 | +7.92 | −2.04 | **+2.152** |
| RANGE | 52 | +0.05 | +2 | +2,244 | 33 | +3.67 | −1.72 | +0.043 |
| BEAR | 58 | +0.68 | +68 | +67,723 | 40 | +5.79 | −1.87 | +1.168 |

The full-7y BEAR number (+$68k) looks like the sleeve works in bears — but that $ is almost entirely the **2022 crash-bounce** (2022 alone +$19k, and 2020's covid crash bounce is partly tagged BEAR too). RANGE — the most common regime — has **essentially zero edge** (+0.04%/trade). So even over 7y the edge is concentrated in trending/violent regimes, not the steady RANGE the dip-buy thesis assumes.

**Recent window 2023-2026 only:**

| Regime | n | Sharpe | ROI% | $ | WR% | expectancy%/trade |
|--------|---|--------|------|---|-----|-------------------|
| BULL | 6 | +0.33 | +4 | +4,165 | 33 | +0.694 |
| RANGE | 37 | +0.20 | +5 | +5,222 | 32 | +0.141 |
| BEAR | 20 | +0.15 | +3 | +3,291 | 35 | +0.165 |

In the forward-relevant window **all three regimes flatten to near-zero expectancy** (0.14–0.69%/trade, all Sharpe < 0.35). There is no regime in 2023-26 where the sleeve is meaningfully alive. A regime gate cannot rescue it — there's nothing to gate *to*.

---

## Task 3 — Recent-window (2023-2026) honest expectancy

- n=63 over 4 yrs
- **Sharpe +0.30**, ROI(total) +13%, $+12,678, MaxDD 14%
- WR 33%, avgWin +3.64%, avgLoss −1.52%
- per-trade expectancy **+0.201%** (size-weighted)
- ~16 trades/yr → **expected annual ROI ~ +3.2%**
- stability **2/4 yrs positive** (2023 +16, 2024 −4, 2025 +9, 2026 −8)

**At 10% sleeve sizing ($10k of a $100k book):**
- expected annual sleeve PnL ~ **+$317/yr** (= 3.2% of the $10k slice)
- contribution to book ROI ~ **+0.32%/yr**

That is a rounding error at the book level, with 2/4 down years and Sharpe 0.30 — well below the ≥0.7 / ≥5-of-8-yrs bar this project uses to accept a rule. The honest expectation if the paper logger runs in a 2023-26-like regime: **roughly break-even with high variance**, occasionally a good year (2023), offset by down years (2024, 2026).

---

## Task 4 — Robustness verdict

**$ concentration:**
- 2019-2021: **$+79,196 — 71% of all sleeve profit**
- 2022-2026: $+31,663 — 29%
- 2023-2026: $+12,678 — **11%**

**Sharpe:** full 7y +0.83 → 2023-26 **+0.30**.

### Verdict: **(b) — 2019-21 artifact. Keep PAPER-ONLY. Do NOT plan to size.**

The reversal sleeve is **not** a structural edge. The evidence is unambiguous and one-directional:
1. **Monotonic era decay** (Sharpe 1.31 → 0.04), not noisy oscillation around a stable mean — the signature of an edge being arbitraged/regime-bound, not of bad luck.
2. **71% of profit from 2019-21**, the covid-V and the 2020-21 bull. Dip-buying a structural bull is not a repeatable alpha — it's beta in disguise.
3. **Payoff asymmetry collapsing**: the avgWin that made the sleeve work (6–10%) has shrunk to ~3.4% while losses stay flat.
4. **No regime survives** in 2023-26 — even BULL/RANGE/BEAR all flatten, so a regime gate (which iter6 declined anyway) cannot save it.
5. Recent expectancy +0.32%/yr to the book with 2/4 down years — below every acceptance gate, and far below the diversification value it would need to justify a sizing slot.

This is exactly the artifact iter7's honesty note feared. We were partly fooled by the 7y aggregate: the +0.83 full-period Sharpe is a 2019-21 average, not a current edge.

### Sizing recommendation
- **DO NOT size.** Do not plan a 10% slice; do not plan any live slice.
- **Keep the deployed `reversalPaperLogger` running paper-only** — it costs nothing, and forward paper data is the *only* thing that could earn it a second look. The bar to ever size it: it would have to demonstrate a *fresh* live-forward Sharpe ≥0.7 over a multi-year window that does **not** lean on 2019-21 — i.e. prove the decay reversed. The era split says don't hold your breath.
- **Stop iterating on it** for sizing purposes. The honest result is reached. Redirect search effort to edges that survive 2023-26 (where hedge01/turtle currently live).

---

## Method note
Tool: `tools/rci-integration-iter8.py` (adapts iter6 tamed `run()` for era/regime slicing). Single tamed config, size-weighted returns, $100k reference. No new parameters fitted — this is a pure robustness audit of the iter6-selected config.
