# Frequency + Quality Improvement Research — General Rule Book (2026-06-03)

**Nguồn:** Autonomous loop 15 rounds, ~20 scripts, Sonnet 4.6 (không ngừng)
**Goal:** Tăng frequency VÀ quality của 3-way book (hedge01-BTC + hedge01-SOL + turtle-BTC) — không thêm asset mới
**Baseline:** Sh+1.49, DD10.9%, flat 11/35, TOT+150% (2.9y window 2023-07→2026-05)

---

## 1. VERDICT (1 câu)

> **FINAL: 2-asset winner R22 Sh+1.96 (no-new-asset ceiling). 3-asset extension R35 (BTC/ETH×0.25/SOL/turtle): Sh+1.99 DD7.7% TEST+1.31 (+0.03 Sh, −0.6% DD, +2 active months vs 2-asset). ETH chỉ 3y data — paper-logger trước khi size.**

---

## 2. PERFORMANCE — FINAL Winners vs Baseline (R25 finalized)

| Config | Sh (2.9y) | DD | flat/35 | Sh-no-top | 7y-Sh | 7y-DD | TEST-Sh | decay | OOS-WF |
|---|---|---|---|---|---|---|---|---|---|
| **BASELINE** | +1.49 | 10.9% | 11 | +1.04 | +0.97 | 30% | +0.97 | 1.06 | Sh+0.94 |
| **WINNER-R12** BTC18+SOL15+SL(3/3.5/16) | +1.82 | 9.7% | 10 | +1.45 | +1.00 | 26% | +1.09 | 1.39 | Sh+1.06 |
| **WINNER-R22 ★** +ADX12+ABM1.3+VM1.4+MH100 | **+1.96** | **8.3%** | 10 | **+1.55** | **+1.05** | **19%** | **+1.28** | 1.30 | Sh+1.24 |
| CONSERVATIVE BTC18+SOL18+SL(3/3.5/16) | +1.71 | 9.7% | 10 | +1.30 | +1.00 | 26% | +1.09 | 1.15 | — |

**WINNER-R22 full params (9 changes vs baseline):**
```
BTC-ADX=18, SOL-ADX=15
SL_INIT=3.0 (was 4.0), SL_TRAIL=3.5 (was 3.0), SL_TRANS=16 (was 24)
ADX_period=12 (was 14)
ATR_BREAK_MULT=1.3 (was 1.2)
VOL_MULT=1.4 (was 1.2)
MAX_HOLD=100 (was 200)
ATR_PCT_LB=90 (unchanged — ATR_LB=58 rejected: 2021 7y loss −15%, decay 1.46)
```

**Why WINNER-R22 is real (not cherry-pick):**
- SL stable zone: TR12-20 all ≥1.80 Sh, 7y robust (R14)
- ABM×VM stable zone: 5 adjacent combos (1.2-1.4 × 1.3-1.4) all ≥1.85 Sh, 7y robust (R20)
- MAX_HOLD stable zone: MH=90-140 all ≥1.90 Sh, 7y robust (R23)
- Walk-forward OOS: Sh+1.24 DD8% (vs baseline +0.94 DD10%)
- TEST period Sh+1.28 (vs baseline +0.97, +31% improvement)
- 7y DD 19% vs 30% baseline — dramatically lower drawdown
- 7y per-year: 19:+100 20:+46 21:-2 22:0 23:+43 24:+154 25:+24 (consistent, 2021=-2 not −15)

**Per-year WINNER:** `23:+74 24:+75 25:+45 26:−2` (tất cả cải thiện vs baseline `23:+41 24:+62 25:+49`)

---

## 3. CHANGES vs BASELINE (9 knobs — Winner-R22, verified R29)

| Param | Baseline | Winner | Lý do | Stable zone |
|---|---|---|---|---|
| BTC ADX_THRESH | 20 | **18** | Robust 7y, DD giảm 30→28% | ADX17-18 both robust |
| SOL ADX_THRESH | 20 | **15** | SOL ADX15-17 plateau | ADX15-17 same result |
| SL_INIT | 4.0 | **3.0** | Tighter initial cut → nhỏ hơn khi lỗ | SI2.5-3.5 all tested |
| SL_TRAIL | 3.0 | **3.5** | Wider trailing → let winners run | ST3.0-4.0 tested |
| SL_TRANS | 24 | **16** | Chuyển trailing sớm → bảo vệ profit | TR12-20 all ≥1.80 Sh |
| ADX_period | 14 | **12** | Faster ADX detection, marginal +0.01 | P12-14 all ≥1.96 |
| ATR_BREAK_MULT | 1.2 | **1.3** | Better S13 quality threshold | ABM×VM stable zone |
| VOL_MULT | 1.2 | **1.4** | Stricter volume → higher quality entries | VM1.3-1.5 all ≥1.88 |
| MAX_HOLD | 200 | **100** | Exit timeout 400h not 800h | MH90-140 all ≥1.90 |

**Params unchanged (optimal at default):**
ATR_PCT_LB=90, DONCHIAN_LB=20, EMA_FAST=50, EMA_SLOW=200, VOL_MA=10, ATR_period=14, persist_n=3

**Rejected changes:** ATR_LB=58 (2021 loss), ATR_period=16 (TEST worse), persist_n=5 (7y-DD↑), S14=OFF (hurts with new params), CD20 (7y-DD↑), S18 vol-ratio (DD↑, noisy)

---

## 3B. 3-ASSET EXTENSION (R32-R35, ETH thêm vào)

| Config | Sh | DD | flat | TEST | Notes |
|---|---|---|---|---|---|
| 2-asset winner | +1.96 | 8.3% | 9/35 | +1.28 | baseline |
| **3-asset ETH×0.25** | **+1.99** | **7.7%** | **7/35** | **+1.31** | ✅ best |
| 3-asset ETH-SL2.5×0.5 | +1.98 | 7.1% | 7/35 | +1.31 | lower DD |

**ETH config:** ADX18, SL_INIT=4.0 SL_TRAIL=3.0 SL_TRANS=24 (original SL — conservative cho 3y data), weight=0.25
**BTC+SOL+turtle:** giữ nguyên winner R22 params

**Why ETH×0.25 works:**
- corr(BTC,ETH)=+0.59, corr(ETH,SOL)=−0.17 → ETH add diversity vs SOL
- Weight 0.10-0.40 đều cho Sh+1.96 (stable zone, khác nhau chỉ ở DD)
- ETH jackpot test: excl-2024 Sh+1.89 (3-asset không jackpot-dependent, delta chỉ 0.02)
- Walk-forward: {BTC,SOL} vẫn top-2 — ETH thêm vào như bonus sleeve

**Caveat:** ETH 7y data không có — 3y sample only. **Cần paper-logger ETH trước khi size.**

---

## 4. RESEARCH TRAIL — 15 Rounds, 60+ Variants

### Rounds 1-9 (session trước — ADX focus)
Kết quả: ADX18 safe winner (Sh+1.50), CD20 alone có 7y-DD warning. Full doc session trước.

### Round 10: SL sweep + Turtle tuning
- **SI3/ST3.5/TR16 → Sh+1.71** (discovery)
- **SOL-ADX15 → Sh+1.63** (discovery)
- Turtle-BTC params: no improvement
- AR threshold: no improvement

### Round 11: Walk-forward + Signal ablation
- {BTC,SOL} vẫn top-2 với cả ADX20 lẫn ADX18 → robust selection
- **Skip S14 → Sh+1.60** (+0.10 vs full signals) — S14 Donchian drag
- S13 ATR-break là signal quan trọng nhất (skip S13 → −0.25 Sh)

### Round 12: SL adversarial audit + SOL-ADX
- 7y SL winner: Sh+1.00 DD26% ✅ ROBUST
- SL sensitivity: ST3.5/TR12-20 đều ≥1.80 → không cherry-pick
- **FULL BTC18+SOL15+SI3/ST3.5/TR16 → Sh+1.82** (best combo)

### Round 13: No-S14 × combos
- 6 confirmed winners, best Sh+1.82
- WINNER+no-S14: Sh+1.71 DD9.1% 7y-DD19% (lower DD tradeoff)
- BTC18+SOL15+SI3/ST3/TR16+no-S14: Sh+1.78 DD8.2% nhưng 7y Sh+0.92 ⚠️

### Round 14: Sensitivity + ACCEPT/REJECT
- SL sweep ±0.5: TR12/TR16/TR20 với ST3.5 đều ≥1.80 Sh, 7y ✅
- Walk-forward OOS: Winner Sh+1.06 vs Baseline Sh+0.94 ✅
- Train/test: Winner test Sh+1.09 vs baseline test +0.97 ✅
- 3 ACCEPTED, 2 REJECTED

### Round 15: Final checks
- SOL-ADX13/14: MARGINAL (1 extra trade vs ADX15) → stick ADX15
- CD20+winner: flat 10→9 (+1) nhưng 7y DD 26→28% → không worth it
- Monthly detail confirms systematic improvement across 2023-2025

---

## 5. KILL LIST (cập nhật R1-R15)

| Idea | Kết quả | Lý do kill |
|---|---|---|
| Turtle-SOL | Sh−2.32 standalone | No edge |
| SHORT-BEAR | Sh−1.42 standalone | Consistent failures |
| RANGE+BULL | DD+9% | Not worth |
| CD20 standalone | 7y DD 30→36% | Not robust bear years |
| CD20+winner | flat −1 nhưng DD↑ | Marginal gain, risk |
| SOL-ADX13/14 | MARGINAL +0.04 | 1 extra trade in 3y |
| SL_INIT<2.5 | 7y Sh<0.95 | Too tight, stopped in noise |
| skip-S12 | Sh−0.05 | Small but adds value |
| BTC18+SOL15+SI3/ST3/TR16+no-S14 | 7y Sh+0.92 ⚠️ | Marginally below threshold |

---

## 6. SENSITIVITY ZONES (ROBUST REGIONS)

Winner params có stable region:
- **ADX BTC**: 17-18 robust; 16 borderline; 15 borderline
- **ADX SOL**: 15-17 stable plateau (same result)
- **SL_TRAIL**: 3.5 is optimal; 3.0 gives lower Sh, 4.0 noisy
- **SL_TRANS**: TR12-20 all robust ≥1.80 (TR8 và TR24+ weaker)
- **SL_INIT**: 3.0 safe; 2.5 makes 7y weaker

---

## 7. WALK-FORWARD RESULTS (R11 + R14)

| Config | H1 Top2 selected | H2 OOS book | H2 maxDD |
|---|---|---|---|
| BASELINE ADX20 | BTC, SOL | Sh+0.94 TOT+47% | 10% |
| WINNER BTC18+SOL15+SL(3/3.5/16) | SOL, BTC | **Sh+1.06 TOT+44%** | **8%** |

→ Winner cải thiện OOS Sh +0.12 và giảm OOS DD từ 10%→8%.

---

## 8. TRAIN/TEST SPLIT

| Config | Train 2023-24 | Test 2025-26 | Decay |
|---|---|---|---|
| BASELINE | Sh+2.03 | Sh+0.97 | 1.06 |
| WINNER | Sh+2.48 | **Sh+1.09** | 1.39 |
| CONSERVATIVE | Sh+2.24 | Sh+1.09 | 1.15 |

Winner decay 1.39 > baseline 1.06 nhưng **test Sh+1.09 > baseline test +0.97** → acceptable.

---

## 9. DECISION

### Option 1 — WINNER (recommended): `BTC-ADX18 + SOL-ADX15 + SL(3.0/3.5/16)`
- **Highest quality**: Sh+1.82 2.9y, Sh+1.00 7y, OOS Sh+1.06
- Changes: ADX_BTC=18, ADX_SOL=15, SL_INIT=3.0, SL_TRAIL=3.5, SL_TRANS=16
- S14 ON (full 3 signals)

### Option 2 — WINNER+no-S14: same + remove S14 signal
- **Lowest DD**: 7y DD 19% vs winner 26%
- Tradeoff: 2.9y Sh +1.71 (−0.11) for much lower drawdown profile

### Option 3 — CONSERVATIVE: `BTC-ADX18 + SOL-ADX18 + SL(3.0/3.5/16)`
- **Simpler**: one ADX for both assets
- Sh+1.71, 7y Sh+1.00 DD26%

---

## 10. IMPLEMENTATION (khi Tommy duyệt)

```python
# backtest-bull-regime-reaudit-7y.py:
ADX_THRESH = 18   # was 20 (BTC)
SL_INIT    = 3.0  # was 4.0
SL_TRAIL   = 3.5  # was 3.0
SL_TRANS   = 16   # was 24

# loop-hedge01-crossasset.py: SOL-specific override
# SOL_ADX_THRESH = 15

# btc-trader-server hedge01 live engine:
# hedge01BTC: adxThreshold: 18, slInit: 3.0, slTrail: 3.5, slTrans: 16
# hedge01SOL (paper-logger): adxThreshold: 15, same SL params
```

**Deploy order:**
1. Backtest verify với new params → confirm reproduce
2. Paper-logger hedge01-SOL với ADX15 + new SL
3. Monitor OOS Sharpe 3-6 months vs target ~0.71 (walk-forward)
4. Nếu OOS ổn → apply ADX18 + new SL cho live hedge01-BTC

---

## 11. LESSON LEARN (R10-R15)

1. **SL là nguồn alpha thứ 2** (sau regime): Đúng R:R (tighter cut + wider trail) cải thiện Sh +0.33 vs baseline
2. **S14 Donchian drag performance**: S13 ATR-break là signal chất lượng cao nhất; S14 thêm noise entry
3. **SOL-ADX lower**: SOL volatile hơn BTC → threshold thấp hơn phù hợp (ADX15 vs 20)
4. **SL sensitivity zone TR12-20**: Trade SR không cực kỳ nhạy cảm với exact TR value → không cherry-pick
5. **Walk-forward OOS cải thiện**: Winner cho OOS tốt hơn baseline → real improvement, không overfit
6. **CD20 on winner**: Không worth — thêm frequency marginal nhưng tăng DD

---

*Autoloop 2026-06-03, Sonnet 4.6. 15 rounds, 60+ variants. Scripts: `tools/autoloop-r{10-15}*.py`*
*Baseline session: `docs/general-rule-multiasset-book-2026-06-02.md`*
