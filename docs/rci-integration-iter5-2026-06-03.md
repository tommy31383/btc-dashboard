# RCI Integration — Iteration 5 (2026-06-03)

**New direction:** stop bolting RCI onto hedge01 (a trend rule — iter1-4 all REJECTED for
fighting its edge). Instead build a **standalone mean-reversion LONG sleeve** ("RCI-reversal")
and test whether it is profitable on its own AND a low-correlation diversifier for the
hedge01 + turtle book.

Tools: `tools/rci-integration-iter5.py` (sleeve sweep), `tools/rci-iter5-book.py` (corr + book).
Data: `.cache/binance-5m-7y.json`, `.cache/binance-funding-7y.json`. BTC only, 7y.

---

## Sleeve design

- **Entry (oversold composite, 4h):** RSI(14)<30 AND Stoch(14)<20 AND BB%B(20)<0.05.
  Optional funding<0 variant (require longs flushed).
- **Confirmation variants tested:** `none` / `close>prior close` / `reclaim EMA9`.
- **Exit variants:** fixed TP {3,5,8}% / RCI-top (overbought mirror: RSI>70 & Stoch>80 & BB%B>0.95)
  / ATR-trail. All carry a protective −2.2×ATR stop.
- **Regime variants:** RANGE-only / RANGE+BEAR / ALL.
- Cooldown 12 bars, MAX_HOLD 200 bars (~33d).

Sweep = 3 regimes × 2 funding × 3 confirm × 5 exit = 90 configs.

---

## Task 1+2 — Standalone 7y performance

Raw oversold bars in 7y: **384** (funding<0 subset: only **78** → funding filter is too rare to be useful).

**Best config (by $ and gate):** `ALL regime | no funding filter | no confirm | RCI-top exit`

| metric | value |
|---|---|
| n trades | 137 |
| RA / Sharpe(ann) | +0.211 / **+0.87** |
| WR | 40% |
| ROI (R-multiple) | +253% → **+$253k** on $100k |
| MaxDD | **57%** (large) |
| per-year stab | **6/8 positive** |
| exits | RCI-top 53, SL 82 (60% cut), MAXHOLD 2 |
| median hold | 21 bars (~3.5d) |

Per-year: 2019 +18, 2020 +78, 2021 +84, 2022 +18, 2023 +50, 2024 −13, 2025 +38, 2026 −19.

**Why it works:** classic asymmetric reversal — 60% of entries cut quickly at −2.2×ATR (small
losses), the 53 winners ride to overbought (RCI-top). It is NOT a "wait out losers" artifact
(only 2 MAXHOLD). This is the validated "cut losers, let reversal winners run" structure.

### Honest caveats (the task hypothesis did NOT hold)
- **Confirmation (the central iter1 lesson) did NOT help.** `close` / `ema9` confirm reduced n
  and did not improve $. The rescue was the **RCI-top exit + tight ATR stop**, not entry confirm.
- **funding<0 filter is useless** — only 78 bars/7y, collapses n to ~10 (e.g. `ALL|f1|close|tp5`
  = n=10, +$40k; `ALL|f1|close|atr` = n=10, all 10 SL, +$11k). n<20 = overfit red flag.
- **57% standalone MaxDD** is severe. The Sharpe 0.87 is decent but the equity path is rough.
- Cross-cycle: only 6/8 years positive; loses in 2024 and 2026 (recent → not reassuring).

**Profitable standalone? YES (marginally):** +$253k, Sharpe 0.87, 6/8 years. Passes the
≥5/8 gate. But it leans on a 57% DD and the "winning" config is the loosest one (no confirm,
all-regime), which is the opposite of what the iter1 meta-lesson predicted.

---

## Task 3 — Correlation + book impact

Monthly-return correlation (83 common months):

| pair | Pearson r |
|---|---|
| RCI-reversal vs hedge01 | **+0.013** |
| RCI-reversal vs turtle | **+0.091** |
| hedge01 vs turtle | +0.066 |

→ RCI-reversal is a **genuine near-zero-correlation diversifier** (well under 0.3 gate).

Risk-parity book (monthly Sharpe ×√12, MaxDD in R%, total in book units):

| book | Sharpe | MaxDD | total |
|---|---|---|---|
| 2-way hedge01+turtle (current LIVE) | +1.17 | **13** | **+443** |
| 3-way +RCI-reversal | **+1.45** | **28** | +350 |

**Mixed result:**
- Book Sharpe improves materially: **1.17 → 1.45** (low corr does its job).
- BUT book MaxDD **doubles: 13 → 28** (the sleeve's own 56% DD bleeds through).
- Book total return **drops** 443 → 350 units (risk-parity gives weight to the high-vol sleeve
  but its R-per-trade is lower).

The Sharpe gain is real but is bought with double the drawdown and lower total return — not a
clean improvement. For a book whose whole appeal is the turtle's DD-halving, doubling DD is a
hard sell.

---

## Deploy recommendation

**ADD AS PAPER SLEEVE ONLY — do NOT size, NOT a clean win.**

Reasoning:
1. It IS profitable standalone (6/8 yrs, Sharpe 0.87) and IS a true near-zero diversifier
   (corr +0.01 / +0.09). That alone clears the prior mean-rev KILL LIST — the funding+composite
   RCI structure with an RCI-top exit is the first mean-rev sleeve that doesn't lose money.
2. BUT it fails the "improve the book cleanly" bar: it **doubles book MaxDD (13→28)** and
   **lowers total return**, only raising Sharpe. That is the wrong trade for this book.
3. The winning config is the *loosest* one — the iter1 confirmation lesson did NOT rescue it,
   funding<0 is too rare to use. So the "win" is fragile / not robust to the strictness we'd
   normally demand, and recent years (2024, 2026) are negative.

**Verdict for the autonomous loop: WEAK YES → PAPER, not LIVE, not sized.**
Forward-test the `ALL|f0|none|rcitop` sleeve on paper (multi-month) to confirm the asymmetric
reversal edge persists out-of-sample before considering a small risk-parity slice. Re-confirm
the 57% DD is acceptable, and check if capping hold / tightening the stop reduces DD without
killing the edge. Until then it does not earn book capital.
