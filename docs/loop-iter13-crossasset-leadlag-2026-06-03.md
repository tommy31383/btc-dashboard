# Loop iter13 — Cross-asset lead-lag & relative-strength rotation (BTC/ETH/SOL)

Date: 2026-06-03 · Data: BTC 7y + ETH/SOL 3y (binance 5m → 4h aligned, 6578 common bars, 2023-05-25 → 2026-05-25)
Harness: faithful hedge01 (`tools/backtest-bull-regime-reaudit-7y.py`) · Script: `tools/loop-iter13-crossasset-leadlag.py`
Era rule (3y assets): require ≥3/4 years positive · Additive rule: monthly corr < 0.3 vs existing book.

## THE QUESTION
Does information lead-lag or relative-strength rotation among BTC/ETH/SOL create a tradeable edge
*beyond* what single-asset hedge01-BTC / turtle / hedge01-SOL already capture?

---

## TASK 1 — Lead-lag cross-correlation (4h returns). VERDICT: NO LEAD — CONTEMPORANEOUS.

corr( BTC return at t−L , ALT return at t ), positive L = BTC leads ALT by L bars:

| lag (4h bars) | BTC→ETH | BTC→SOL |
|---|---|---|
| **0** | **+0.813** | **+0.727** |
| 1 | +0.019 | −0.013 |
| 2 | +0.016 | +0.006 |
| 3 | +0.000 | −0.003 |
| 6 | −0.045 | −0.059 |
| 12 | −0.006 | −0.006 |

All the co-movement lives at **lag 0** (contemporaneous, 0.73–0.81, stable every year 2023→2026).
At lag ≥1 corr collapses to ~0 (noise). **BTC does NOT lead ETH/SOL on the 4h grid** — by the time a 4h
BTC bar closes, the alt has already moved with it. Hypothesis A is **REJECTED**: there is no exploitable
lead-lag delay at tradeable resolution. (A finer 5m grid might show sub-bar microstructure lead, but that
is HFT latency territory, not a swing edge, and not executable on this book.)

---

## TASK 2 — Relative-strength rotation (hold the strongest trailing-momentum asset). VERDICT: REPACKAGED BETA — REJECT.

Rotation (ROT = hold leader) vs Equal-Weight (EW) vs BTC-only, total return% + monthly Sharpe + per-year:

| LB / rebal | strat | ret%tot | Sharpe | per-year (23/24/25/26) |
|---|---|---|---|---|
| 7d / 7d  | ROT | +168 | +0.71 | +143 / +62 / −7 / −31 |
|          | EW  | +153 | +0.87 | +87 / +84 / +4 / −22 |
|          | BTC | +137 | **+1.03** | +49 / +93 / +3 / −9 |
| 7d / 1d  | ROT | +220 | +0.93 | +164 / +55 / +20 / −20 |
| 30d / 7d | ROT | +164 | +0.76 | +144 / +34 / +6 / −20 |
| 15d / 5d | ROT | +243 | **+1.01** | +183 / +38 / +43 / −21 |

Findings:
- Best ROT (15d/5d) has higher total return (+243 vs BTC +138) but **the same Sharpe as BTC-only** (~1.0)
  and **worse Sharpe than several BTC-only / EW variants**. Extra return is just extra beta/vol, not alpha.
- ROT return is **front-loaded into 2023** (+183) — the SOL/alt-season tail. In 2025 it's mixed and in
  2026 it loses (−21) like everything. Not the clean ≥3/4 robustness we want; it rides one regime.
- **Monthly corr(ROT 15d/5d, BTC buy-hold) = 0.715**; EW = 0.913. Far above the 0.3 additive threshold.
  Rotation is **highly correlated repackaged beta** — it does not diversify the book.
- "Hold whatever pumped" is exactly the trend-chasing pattern flagged as suspect. **REJECT.**

---

## TASK 3 — Beta-timing: gate ETH/SOL hedge01-longs on BTC regime (RANGE/BULL + ADX rising). VERDICT: GENUINE IMPROVEMENT for ETH; SOL inconclusive.

hedge01 alt-longs, standalone vs only-when-BTC-gate-passes:

| asset | gate | trades | ret%tot | WR% | Sharpe | per-year (23/24/25) |
|---|---|---|---|---|---|---|
| ETH | standalone | 51 | +92  | 51 | +0.99 | +7 / +73 / +13 |
| ETH | **BTC-gated** | 35 | **+102** | **60** | **+1.60** | **+38 / +54 / +10** |
| SOL | standalone | 39 | +220 | 59 | +2.02 | +113 / +6 / +100 |
| SOL | BTC-gated | 27 | +188 | 70 | +2.40 | +116 / −15 / +100→+88 |

Findings:
- **ETH: BTC-gate is a clear win.** Fewer trades (51→35, drops bad ones), higher total (+92→+102),
  WR 51→60%, Sharpe 0.99→**1.60**, and per-year goes from leaning-on-2024 (+7/+73/+13) to **balanced
  3/3 positive** (+38/+54/+10). Conditioning alt entries on BTC state removes losing entries taken while
  BTC was choppy/down. This is structural (BTC dominance → alt beta only pays in BTC uptrend) and
  era-robust → **3/3 years positive.**
- **SOL: improves quality (WR 59→70, Sharpe 2.02→2.40) but not dollars** (+220→+188), and turns 2024
  slightly negative (−15). SOL's standalone edge is already very strong (Sharpe 2.0); the gate just trims
  trades without adding net dollars. **Inconclusive — no clear benefit beyond standalone hedge01-SOL.**

---

## TASK 4 — Honest verdict + correlation / additivity

| Hypothesis | Result |
|---|---|
| A. Lead-lag (BTC leads ETH/SOL) | **REJECT** — co-movement is 100% contemporaneous (lag 0 = 0.73–0.81, lag≥1 ≈ 0). No tradeable delay. |
| B. RS-rotation (hold the leader) | **REJECT** — same/worse Sharpe than BTC-only, corr 0.72 with BTC buy-hold = repackaged beta, front-loaded to 2023 alt-season. Not additive. |
| C. Beta-timing alt-longs on BTC regime | **PARTIAL ACCEPT** — for **ETH only**: Sharpe 0.99→1.60, WR +9pts, per-year 3/3 positive. SOL: quality up but dollars down, inconclusive. |

The only novel finding is **C-for-ETH**: gating ETH hedge01-longs on BTC regime/ADX-rising is a structural
filter that makes ETH's marginal hedge01 sleeve era-robust. But this is a **refinement of single-asset
hedge01-ETH**, not a new cross-asset sleeve. It does not produce a decorrelated return stream — it just
removes ETH entries that BTC's state predicts will fail.

**Does single-asset hedge01 already capture everything?** Essentially yes. hedge01-SOL already owns SOL's
edge; rotation and lead-lag add no decorrelated alpha (corr 0.72–0.91). The cross-asset structure that IS
real — BTC dominance driving alt beta — shows up not as a lead-lag trade but as a **regime filter on alt
entries**, which is best deployed *inside* the existing per-asset hedge01 sleeves, not as a standalone book.

## RECOMMENDATION
- **No new cross-asset sleeve to deploy.** Rotation and lead-lag are rejected (beta / no edge).
- **Optional refinement (paper first):** add a "BTC regime RANGE/BULL + ADX-rising" gate to **hedge01-ETH**
  entries — backtest shows Sharpe 0.99→1.60 and 3/3-year positive. Treat as a single-asset filter, not a
  new strategy. Forward-test on paper before sizing (ETH not yet a live sleeve). Do NOT apply to SOL
  (no net-dollar benefit; standalone already strong).
- Net: **the book's single-asset hedge01 design already captures the available cross-asset edge.**
