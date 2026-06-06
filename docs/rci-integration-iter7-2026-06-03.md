# RCI Integration — Iteration 7 (2026-06-03)

Weight-cap the deployed BTC reversal sleeve + test ETH/SOL reversal cross-asset.

Tamed sleeve config (from iter6, LIVE in `reversalPaperLogger.ts`):
`ALL-regime | oversold entry (RSI<30 + Stoch<20 + BB%B<0.05) 4h | exit ATR×2.0 / RCI-top / maxhold 200(33d) | 1-position-only | vol-targeting size=max(0.40, 1−atr%pctile)`
Standalone BTC 7y: n=129, Sharpe 0.83, ROI +111% (+$110.9k), MaxDD 19%, Calmar 5.93, stab 6/8.

Scripts:
- `btc-dashboard/tools/rci-iter7-book.py` — Task 1 weight-cap sweep
- `btc-dashboard/tools/rci-iter7-multiasset.py` — Tasks 2/3/4 ETH/SOL/multi-asset

---

## Task 1 — Weight-cap the book (FIX iter6 totalR drop) ✅ ACTIONABLE

iter6 problem: under full 3-way risk-parity the low-vol RCI sleeve has a tiny sd → huge
`1/sd` weight → normalization shrinks hedge01/turtle → book totalR collapses **443% → 214%**
even though Sharpe rises 1.16 → 1.48.

Fix: keep hedge01+turtle at their proven 2-way risk-parity ("CORE"), then add RCI as a
**capped fraction** `w` of book exposure: `book = (1−w)·CORE + w·RCI`.

| w_cap | Sharpe | DD% | totalR% | Calmar |
|-------|--------|-----|---------|--------|
| 0.00 (CORE only) | +1.16 | 13 | +443 | 33.9 |
| **0.10** | **+1.19** | **12** | **+410** | **35.5** |
| 0.15 | +1.21 | 11 | +393 | 34.7 |
| 0.20 | +1.23 | 11 | +376 | 33.8 |
| 0.25 | +1.25 | 11 | +360 | 32.8 |
| 0.33 | +1.29 | 11 | +333 | 31.3 |

**Optimal sleeve weight = 0.10–0.15 of book.**
- w=0.10: Sharpe +1.19, DD 12%, totalR +410% (93% of CORE), Calmar 35.5 (best) — recommended.
- w=0.15: slightly more Sharpe (+1.21) / lower DD (11%) at totalR +393% (89% of CORE) — acceptable.
- The full Sharpe 1.48 of iter6 only came by sacrificing 50% of totalR (443→214). Not worth it.
- DD never rises — the sleeve is corr≈0 with the CORE (hedge01 −0.04, turtle +0.06), so every
  cap level lowers book DD. The only trade-off is totalR vs Sharpe; cap small to keep totalR.

**Sizing recommendation: allocate the BTC reversal sleeve at 10% of book risk** (cap at 15% max).

---

## Task 2 — ETH reversal (3y) ❌ REJECT

Exact tamed config on ETH 2023-05 → 2026-05 (technical-only RCI):
n=56, **Sharpe −0.59, ROI −26% (−$25.7k), MaxDD 44%, Calmar −0.59, stab 2/4.**
Per-year: 2023 +6 / 2024 −21 / 2025 −12 / 2026 +1.

Verdict: **loses money**, fails every gate. Corr with BTC reversal **+0.35** (not even
diversifying — higher than hedge01/turtle's ~0). Mean-rev oversold-dip-buy on ETH is a
knife-catch in the 2024–25 grind-down. Do NOT deploy.

## Task 3 — SOL reversal (3y) ❌ REJECT

n=47, **Sharpe −0.11, ROI −8% (−$7.7k), MaxDD 44%, Calmar −0.17, stab 1/4.**
Per-year: 2023 +16 / 2024 −1 / 2025 −16 / 2026 −6.

Verdict: **loses money**, 1/4 years positive (only the 2023 launch-window). High-vol = more
knife-catches, not more clean ranges. Corr with BTC reversal +0.32. Do NOT deploy.

## Task 4 — Multi-asset reversal book ❌ REJECT

Risk-parity across {BTC, ETH, SOL} reversal (3y common window):

| Book | Sharpe | MaxDD | totalR |
|------|--------|-------|--------|
| BTC-only | +0.49 | 14 | +16% |
| BTC+ETH | −0.17 | 21 | −5% |
| BTC+ETH+SOL | −0.20 | 21 | −5% |

Adding ETH/SOL **destroys** the BTC reversal sleeve (Sharpe 0.49 → −0.20, DD 14 → 21).
Diversification fails because (a) ETH/SOL are individually negative-expectancy, and
(b) corr to BTC is materially positive (0.32–0.35), so they add loss + DD without smoothing.
The multi-asset reversal sleeve is NOT smoother and NOT more sizeable.

---

## Deploy recommendation

1. **Size the existing BTC reversal sleeve (already LIVE, paper) at 10% of book risk** (cap 15%).
   This is the actionable win: lifts book Sharpe 1.16 → 1.19, lowers DD 13 → 12, and keeps
   totalR at 410% (93% of the 443% baseline). Once paper forward-test confirms, this is the
   weight to use when promoting to sized capital.
2. **Do NOT add ETH or SOL reversal paper loggers.** Both are negative-expectancy on 3y
   (ETH −$25.7k Sh −0.59, SOL −$7.7k Sh −0.11), positively correlated with the BTC sleeve,
   and drag a multi-asset reversal book underwater. The mean-rev edge is BTC-specific.

### Honest notes
- BTC reversal restricted to the matched 3y window is weaker (Sh 0.39, stab 2/4) than full 7y —
  its edge is carried by 2019–2021. The full-7y sample is what justifies sizing; the 3y window
  is only for fair cross-asset comparison.
- ETH/SOL only have 3y of data (post-2023), entirely inside the 2024–25 chop/down phase that is
  hostile to dip-buying. Even so, the negative result + positive correlation is a clean REJECT.
