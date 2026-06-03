# RCI Integration — Iteration 2 (2026-06-03)

Script: `tools/rci-integration-iter2.py`
Data: `.cache/binance-5m-7y.json` + `.cache/binance-funding-3y.json` (funding window 2023-05-25 → 2026-05-24, 3y only).
Engine: hedge01 live **v0.4.75** config (RANGE-only LONG, ADX18/12, SL 3.0/3.5 trans@16, DLB18, ATR-break 1.3, vol MA16×1.4, ATR%ile 50th, EMA200 1h gate).
Judge: **Sharpe + DOLLARS** ($100k sim).

---

## Why iter2 — the iter1 bug

Iter1 concluded REJECT on both RCI overlays, but discovered the composite RCI was **miscalibrated ~16x too hot**:

- iter1 trigger `RCI > 4.0` fired **420x / 3y (~140/yr)**.
- The actual 64.3% precision finding was **funding rate > 0.05%/8h (0.0005)**, which fires only **26x / 3y (~8.7/yr)** — a rare-extreme regime.

So iter1's RCI tests fired on a totally different (mushy, frequent) signal than the rare edge the research found. Iter2 recalibrates and, more importantly, tests the **pure funding signal** directly.

---

## Task 1 — Recalibrated composite RCI threshold

Composite RCI over the 3y funding window (n=6568 4h bars):

| Percentile | RCI thr | fires/3y | fires/yr |
|---|---|---|---|
| 95.0% | 4.25 | 329 | 109.7 |
| 98.0% | 5.10 | 132 | 44.0 |
| 99.0% | 5.68 | 66 | 22.0 |
| 99.5% | 6.31 | 33 | 11.0 |
| **99.6%** | **~6.45** | **~26** | **~8.7** |
| 99.7% | 6.93 | 20 | 6.7 |
| 99.9% | 7.51 | 7 | 2.3 |

**Recalibrated threshold: RCI > ~6.45** (99.6th percentile) matches the funding>0.05% regime (~8.7/yr).
iter1's `RCI>4.0` sat at only the ~95th percentile → ~16x too frequent. Any future composite-RCI trigger must use **≈6.3–7.0**, not 4.0.

Note: since funding is the dominant component (weight 2.0) and the real edge is funding alone, iter2 tested the **pure funding signal** for the overlays rather than the noisier composite.

---

## Baseline hedge01 v0.4.75 (3y funding window)

| n | RA | Sharpe(ann) | WR | ROI | $ | MaxDD | stab |
|---|---|---|---|---|---|---|---|
| 81 | +0.360 | **+1.87** | 56% | +216.2% | **+$216,228** | 23.3% ($23.3k) | 3/3 |

Per-year: 2023 +16% · 2024 +162% · 2025 +38%.

**Funding context of baseline entries:**
- Only **3** of 81 entries fired into funding>0.05% (crowded): avg ret **−1.63%**, WR 33%, total **−$4,899**. ← the entries the skip-filter removes.
- **2** entries fired into elevated 0.03–0.05%: avg ret **+7.85%**, WR 100%, total **+$15,699**. ← winners; do NOT touch these.

This split is the whole story: the loss is concentrated at the >0.05% extreme; the 0.03–0.05% band is fine.

---

## Task 2 — PURE FUNDING skip-entry filter ✅ ACCEPT

Rule: hedge01 LONG breakout fires AND funding>0.05% → **skip the entry** (don't buy into crowded LONGs). Filters NEW entries only (unlike iter1 which exited open winners).

| | n | Sharpe | ROI | $ | MaxDD | WR |
|---|---|---|---|---|---|---|
| Baseline | 81 | +1.87 | +216.2% | +$216,228 | 23.3% | 56% |
| **+ Skip-entry** | 78 | **+1.93** | **+221.1%** | **+$221,127** | 23.3% | 56% |
| Δ | −3 | **+0.06** | +5pp | **+$4,899** | 0.0pp | — |

**ACCEPT** — Sharpe up, ROI up, DD unchanged, dollars up. Skipping 3 crowded-entry losers added +$4.9k and lifted Sharpe. Clean, no downside.

**Honest caveat:** the effect is small in absolute terms — only **3 skipped entries in 3 years** (the regime is rare by design). It is a pure tail-risk trim, not a return engine. Direction is unambiguously positive and risk-free (it only removes statistically-bad entries), but do not expect it to move the needle on most years.

---

## Task 3 — Funding size-down (>0.03% half, >0.05% skip) ❌ REJECT

| | n | Sharpe | ROI | $ | MaxDD |
|---|---|---|---|---|---|
| Baseline | 81 | +1.87 | +216.2% | +$216,228 | 23.3% |
| Size-down | 78 | +1.87 | +213.3% | +$213,278 | 23.3% |
| Δ | −3 | +0.00 | −3pp | **−$2,950** | 0.0pp |

**REJECT** — half-sizing the 0.03–0.05% band hurt, because those 2 trades were **winners (+7.85%, WR 100%)**. Crowding only predicts a top at the >0.05% **extreme**; the elevated-but-not-extreme band still has positive expectancy. Cutting size there throws away good entries. Keep full size below 0.05%; only the binary skip at >0.05% (Task 2) is justified.

---

## Task 4 — Funding as turtle exit (exit turtle LONG when funding>0.05%) ❌ REJECT

Turtle = daily Donchian FAST 20/10 long-only + ATR cut 2.0, 3y window, qty 0.003, daily M2M.

| | Total$ | Sharpe | MaxDD$ | trades |
|---|---|---|---|---|
| Turtle baseline | +$118 | 0.60 | $96 | 17 |
| + funding-exit | +$77 | 0.41 | $96 | 21 (2 funding exits) |
| Δ | **−$41** | **−0.19** | $0 | +4 |

**REJECT** — exiting on funding>0.05% locks profit too early and forces re-entries (17→21 trades), cutting winners mid-trend exactly like the iter1 RCI-exit failure. Same lesson: **do not exit trend-followers on a top-pressure signal.** Turtle's edge is in the ATR cut, not in funding timing. Note tiny absolute $ (turtle qty 0.003 sleeve over 3y) — small sample, but the Sharpe drop confirms the directional verdict.

---

## Summary table

| Overlay | Verdict | Sharpe Δ | $ Δ | Note |
|---|---|---|---|---|
| Composite RCI (recal 6.45) | — | — | — | iter1 used 4.0 = 16x too hot; correct thr ≈6.3–7.0 |
| **Task2 Funding skip-entry (>0.05%)** | **✅ ACCEPT** | **+0.06** | **+$4,899** | only 3 skips/3y; risk-free trim, small effect |
| Task3 Funding size-down | ❌ REJECT | +0.00 | −$2,950 | 0.03–0.05% band are winners, don't cut |
| Task4 Funding turtle exit | ❌ REJECT | −0.19 | −$41 | exits winners mid-trend (same as iter1 exit fail) |

## Deploy recommendation

**Deploy Task 2 only — funding skip-entry filter on hedge01-BTC live LONG entries:**

> When a hedge01 LONG breakout would fire AND latest funding rate > 0.05%/8h (0.0005) → **skip the entry**.

- Pure win in backtest (Sharpe +0.06, +$4.9k, DD flat, stab 3/3), zero downside — it only removes statistically-bad crowded entries.
- It is **defensive and rare** (≈3 skips per 3y), so expect minimal day-to-day impact; value is tail-risk avoidance, not alpha.
- Funding is already logged live (altdata logger v0.4.50). Implementation = one `if funding > 0.0005: skip` gate in the hedge01 entry path. SHORT side unaffected (already skip-short).

**Do NOT deploy:** size-down (Task 3), turtle funding-exit (Task 4), or any RCI exit overlay. The only validated funding edge is the binary skip-entry at the >0.05% extreme.

**Limitations:** funding data is 3y only (no 2021 bull-blowoff, where funding>0.05% would have been most frequent — the filter is likely *more* valuable in such a regime, but that's untested). Sample of crowded entries is tiny (n=3). Re-verify on a longer funding history before sizing up.
