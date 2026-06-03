# Loop iter10 — SOL hedge01 re-validation with DEPLOYED-SAFE params (2026-06-03)

**Question:** SOL is the only remaining non-artifact additive ROI lever. Does hedge01-SOL hold up with
the **deployed-safe params** (solPaperLogger v0.4.77) — not the rejected R87-overfit params — and is it
ready to size?

**Engine:** faithful hedge01 (RANGE-breakout 4h LONG; S12 EMA-cross / S13 ATR-break / S14 Donchian;
filt = ADX>thr ×2bar + close>EMA200-1h + ATR%ile≥50th/90 + RANGE-regime; ATR trailing SL).
Reuses `tools/backtest-bull-regime-reaudit-7y.py` helpers. Script: `tools/loop-iter10-sol-validation.py`.
**No funding gate for SOL** (no SOL funding cache; deployed logger applies none either).

Deployed-safe SOL params (from `btc-trader-server/src/engine/solPaperLogger.ts`):
`ADX_THRESH=15, ADX_PERIOD=12 (ATR period 12 too), SL_INIT=3.0, SL_TRAIL=3.5, SL_TRANS=64 bars,
ATR_BREAK=1.3, VOL_MA=16, VOL_MULT=1.4, DLB=18, RANGE-only, EMA200-1h gate, ATR%ile≥50th, MAX_HOLD=200.`

---

## TASK 1 — SOL hedge01, deployed-SAFE vs R87-overfit

| Config | n | ret%tot | WR | monthlySharpe(×√12) | maxDD | 2023 | 2024 | 2025 | yrs+ |
|---|---|---|---|---|---|---|---|---|---|
| **deployed-SAFE** | 38 | **+227%** | 71% | **+2.50** | −9% | +139% | +6% | +82% | 3/3 |
| R87-overfit | 33 | +278% | 73% | +2.71 | −6% | +159% | +27% | +92% | 3/3 |

**Verdict T1:** SOL is genuinely profitable with the **deployed-safe** params, NOT only with the rejected
overfit set. Safe loses just ~8% of Sharpe vs R87 (2.50 vs 2.71) and ~18% of total ret%. This is the
opposite of the overext / reversal artifacts — the edge does NOT collapse when you swap the overfit knobs
for the structurally-honest ones. The prior general-rule "Sharpe ~2.0" claim is **confirmed and slightly
exceeded** by the safe config. The deployed paper logger is running the right config.

---

## TASK 2 — Era / year robustness

- **3/3 years positive** (2023 partial-from-May, 2024, 2025).
- **Edge is concentrated, not spread:** 2023 = 61% of total, 2025 = 36%, **2024 = only 2%** (+6% nearly flat).
  So the "3/3 positive" is technically true but 2024 contributed almost nothing.
- **2026 = ZERO trades.** SOL data runs to 2026-05-25 but the RANGE-gate + ADX×2bar + EMA + ATR%ile stack
  produced **no SOL signals at all in 2026**. Effective sample = ~2.5 years (mid-2023 → 2025), ~12 trades/yr.

### Jackpot dependence (deployed-SAFE)
- Ex-best-year (drop 2023): total still **+88%** → SURVIVES.
- Ex-best-trade (−35%): +192% → robust to single trade.
- Top-1 trade = 16% of total, top-3 = 38%, top-5 = 57%. Moderate concentration (typical of a trend sleeve),
  not a single-jackpot artifact.

**Verdict T2:** Survives ex-best-year and ex-best-trade — NOT a one-jackpot artifact. BUT: only ~2.5
effective years, n=38 total, edge carried by 2023+2025 with 2024 flat and 2026 silent. This is a thin,
alt-cycle-shaped sample. Honest read: real edge, fragile evidence base.

---

## TASK 3 — Correlation + book impact (SOL-window: 2023-07 → 2025-10, 24 months)

Monthly-return Pearson:
- SOL-hedge01 vs BTC-hedge01 = **−0.144**  (well under 0.3 → additive)
- SOL-hedge01 vs turtle-BTC  = **−0.135**  (additive)
- BTC-hedge01 vs turtle-BTC  = −0.010

Book Sharpe (risk-parity, equal-risk weight, SOL window):

| Book | Sharpe |
|---|---|
| BTC-hedge01 alone | +1.01 |
| turtle-BTC alone | +0.91 |
| SOL-hedge01 alone | +1.49 |
| BTC-h01 + turtle | +1.37 |
| **BTC-h01 + turtle + SOL** | **+2.14**  (Δ **+0.77**) |

ROI (ret% over the 24-month SOL window, equal notional per sleeve):
- BTC-h01 +144%, turtle +86%, SOL +227%.
- 2-sleeve sum +230% → 3-sleeve sum +457%. **SOL adds ~+99% ROI** over the 2-sleeve book at equal weight.

**Verdict T3:** SOL is genuinely diversifying (corr ≈ −0.14, near-zero/slightly negative with both existing
sleeves). Adding it lifts book Sharpe +1.37 → +2.14 and roughly doubles window ROI. **This is the real ROI
prize** — and it's the largest single additive lever found in 10 iterations. Caveat: the +0.77 Sharpe jump
is measured on the same thin 2.5y window, so treat it as an upper bound, not a forward expectation.

---

## TASK 4 — Sizing-readiness verdict

**Does deployed-safe SOL hold up vs the rejected overfit version?** YES. Safe Sharpe 2.50 vs R87 2.71 —
edge persists with honest params. Unlike the BTC sleeves killed in iter 1-9 (reversal/BULL-pullback =
2019-21 artifacts; overext = v0438 leak), SOL's edge does not depend on the rejected knobs.

**Why NOT size live yet (honest blockers):**
1. **Only ~2.5 effective years, n=38.** Below the comfort bar for a new live sleeve.
2. **2024 flat + 2026 silent.** The edge is shaped by the 2023 and 2025 alt-up legs. We have not yet seen
   SOL-hedge01 work in a *fresh* regime out-of-sample — and 2026 (the only truly forward period) produced
   zero signals, so the live paper logger has essentially nothing to show yet.
3. **Alt-season dependence is real.** RANGE-gate + LONG-only means this sleeve harvests SOL up-legs; it has
   not been stress-tested through a SOL bear without the regime gate saving it by simply not firing.

**Realistic ROI uplift if sized at proper weight:** at equal risk-parity weight, the backtest window shows
~+99% ROI add and +0.77 book Sharpe. Discount heavily for the thin sample — a defensible *live expectation*
is more like a **+0.2 to +0.4 book-Sharpe** uplift and a meaningful but not doubled ROI, given near-zero
correlation is the durable part while the absolute SOL return is the fragile part.

### The exact forward-test bar SOL must clear before sizing
Keep `solPaperLogger` running at QTY normalized to ~$30 notional (fair vs BTC). SOL may size live ONLY when
ALL of the following hold:

1. **≥ 6 months of live paper** with **≥ 10 closed paper trades** (SOL fires ~12/yr, so 6mo ≈ the minimum
   to get a real sample — extend to 9-12mo if signals stay sparse).
2. **Live paper monthly Sharpe ≥ 1.0** over that window (vs backtest 2.50 — we require it to clear half the
   backtest, not match it, to allow for live slippage + the thin-sample optimism).
3. **Win rate ≥ 55%** and **no single trade > 50% of paper PnL** (re-run the jackpot check live).
4. **Realized live corr with BTC-hedge01 stays < 0.3** over the paper window (the diversification thesis must
   survive forward, not just in-sample).
5. At least **one losing-or-flat SOL stretch survived** (i.e. the RANGE gate correctly stood down or the ATR
   cut contained a drawdown) — proves the risk side, not just the bull-leg harvest.

If all 5 clear → size SOL at risk-parity weight, **capped** (e.g. ≤ the smaller of BTC-h01 / turtle risk
budget) given the 2.5y history. If signals stay this sparse or 2026-style silence continues, SOL stays
paper-only — keep logging, do not size.

---

## Bottom line
SOL hedge01 with **deployed-safe params is real, not an overfit artifact** (Sharpe 2.50, 3/3 yrs+, survives
jackpot checks) and is the **single biggest additive lever** in the search (corr ≈ −0.14, book Sharpe
+1.37→+2.14, ~+99% window ROI). The catch is a **thin 2.5y / n=38 sample with 2024 flat and 2026 silent**,
so it is **not size-ready today** — it must clear the 5-point forward-test bar above (≥6mo / ≥10 trades /
live Sharpe ≥1.0 / corr<0.3 / one survived drawdown) on the already-deployed paper logger first.
