# RCI + Trend Direction Index — Master Summary
**Date:** 2026-06-03  **Iterations:** 30  **Data:** BTC 7y (2019-05 → 2026-05)

---

## Part 1: Trend Direction Index (`utils/trend.ts` v4)

### Final Config (v4, iter 1-18)
```
Components: pve=0.4 (price vs EMA50), di_strong=2.5/di_weak=0.8 (ADX/DI),
            slope±0.7/0.3 (EMA50 5-bar), c1=0.5 (1h EMA confirm)
EMA stack: REMOVED (overfit 2019-22, hurts STRONG_UP OOS)
Thresholds: zthr=1.6, zstrong=3.0
STRONG_DOWN gates: price<EMA200 AND EMA200 slope<0 AND ADX>28 AND DI->DI+
STRONG_UP gates:   EMA200 slope>0 AND ADX>28 AND DI+>DI-
```

### OOS Performance (2023-26)
| Zone | Excess/5d | Sharpe | n OOS |
|---|---|---|---|
| STRONG_DOWN | −0.05% | 0.008 | 1175 |
| STRONG_UP | **+0.50%** | **0.086** | 1596 |

### Key Lessons
1. **DI/ADX is king** — largest weight component, robust across all eras
2. **EMA stack overfit** 2019-22 era, drops +0.31→+0.46% STRONG_UP when removed
3. **STRONG_DOWN forward-alpha DEAD OOS** — all horizons 1-7d excess ≈ 0
4. **ETH cross-asset:** STRONG_UP ETH +1.27% (> BTC +0.83%) — valid cross-asset
5. **RANGE = weak-trend** (ADX 15-28, 86% of RANGE bars), not true sideways
6. **Zone sticky:** avg run 32h, 12.4 flips/100bar — UX acceptable
7. **Trend = regime/display ONLY** — not entry-trigger, not gate for hedge01/Turtle OOS

---

## Part 2: RCI Reversal Index (`utils/rci.ts` v5/v6)

### Component OOS Survival (2023-26, base=26.7%)
| Component | OOS prec | vs base | Status | Weight |
|---|---|---|---|---|
| Funding >0.03% | 31.5% | +4.8pp | **KING** | 2.0 |
| FundingAccel (×1.5) | 48.0% | +21pp | **STAR** (n=25) | 1.2 |
| VolExhaust | 33.3% | +6.7pp | sparse (n=9) | 0.8 |
| RSI 4h | 16.4% | −10pp | **DEAD** | ×0.5 |
| Stoch 4h | 19-21% | −6-8pp | **DEAD** | ×0.5 |
| BB%B 4h | 20-23% | −4-7pp | **DEAD** | ×0.5 |
| MACD | 22% | −4.4pp | **DEAD** | 0.15 |
| ADXslope | 22-24% | −3-6pp | **DEAD** | 0 |

### v6 Composite (Fund+FundAccel, OOS)
```
thr=1.5: n=123, prec=31.7% (+5.1pp), stable 4/5 years  ← PRACTICAL
thr=2.0: n=25,  prec=48.0% (+21pp)                      ← BEAR_STRONG gate
```

### Key Lessons
1. **All momentum-overbought signals DEAD OOS** — bull 2023-26 makes RSI>70 etc anti-predictive
2. **Funding is the only real signal** — crowding (not momentum) is what predicts reversal
3. **FundAccel surprise star:** acceleration = even more extreme crowding signal
4. **Composite v5 = over-engineering** — funding>0.03% alone n=178 OOS ≈ composite n=70
5. **RCI panel = funding display** — show funding rate prominently, composite is context

---

## Part 3: Cross-Strategy Integration Tests

### hedge01 RANGE gate × Trend STRONG_DOWN (iter28-29)
```
ALL 7y:    RANGE-pass+Trend-block avg −0.30% vs both-pass +0.47% → delta +0.78% ADDITIVE
OOS 2023: blocked avg −0.00% vs pass +0.23% → delta +0.24% REDUNDANT ~
```
**Verdict:** Trend gate REDUNDANT OOS. Display only. No server change.

### RCI-bull (dip-buy RSI<30) × Trend STRONG_DOWN gate (iter6)
```
OOS 2023-26: gated skip STRONG_DOWN HURTS — dip in downtrend bounces hardest (V-recovery)
```
**Verdict:** REJECT gate. Trend+reversal bolt = fight against edge. META-LESSON confirmed.

### Turtle × Trend STRONG_UP (iter30)
```
OOS 2023-26: STRONG_UP +7.6% vs ungated +6.7% → weak +0.9% only
7y: STRONG_UP LOWER than ungated (−3.1%) — Trend LAGS Turtle breakout entry
```
**Verdict:** Trend panel lags Donchian breakout by design. No gate. Display only.

---

## Master Architecture: Panel Display Roles

| Panel | Purpose | DO | DON'T |
|---|---|---|---|
| **XU HƯỚNG (Trend)** | Regime context | Show STRONG_DOWN as size-reduction alert | Gate entries/exits |
| **FUNDING RATE** | Primary reversal signal | Show prominently, alert >0.03% | Trust RSI/Stoch/BB |
| **RCI composite** | Secondary context | Reference at high threshold (>2.0) | Use as standalone entry |

**Bottom line:** Market structure 2023-26 has invalidated all classic momentum-overbought indicators for short-side timing. Only crowding (funding) captures real edge. Trend = structural direction display. No forward-alpha gate works OOS. Use panels as human context, not automated rules.

### ⭐ iter31 ACTIONABLE FINDING: Turtle × Funding Extreme

```
Turtle Donchian entry when funding >0.05% (extreme crowded longs):
  7y:        n=14  avg= -1.7%  %pos=14%  → delta -17.6pp vs baseline +15.9%
  OOS 23-26: n=2   avg= -5.7%  %pos=0%   → ALL LOSSES

Normal funding entry: avg +17.8% (7y), +7.3% (OOS) — baseline intact
```

**RULE: SKIP Turtle entry when funding >0.05%** — extreme longs crowding = breakout is likely squeeze trap not real trend. This is structurally sound (crowded longs = squeeze risk at breakout), confirmed 7y. n=14 small but delta -17pp is extreme. Consider adding funding gate to Turtle server logic.

---

## Deployed Versions
- `v4.10.8` (2026-06-03): Trend v4 + RCI v5/v6 weights + FundingBar prominent UI
- Tools: `trend-backtest-7y.py` (18 modes), `rci-oos-recalibrate.py`, `rci-v4-backtest-7y.py`
- Detail: `docs/trend-backtest-iter1-3-2026-06-03.md`
