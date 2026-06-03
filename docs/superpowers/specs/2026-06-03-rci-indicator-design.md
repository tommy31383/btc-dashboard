# Reversal Confluence Index (RCI) — Design Spec
**Date:** 2026-06-03  
**Status:** Approved by Tommy → Implementation phase

---

## 1. Goal

Một đường oscillator duy nhất dao động âm/dương để xác định thời điểm giá BTC quay đầu (cả đỉnh và đáy), với precision cao (ít false signal).

---

## 2. Architecture

```
INPUT: BTC OHLCV data — 4h + 1h + 15m (multi-TF)

LAYER 1: WDC — Weighted Divergence Composite
  → RSI divergence (4h × 0.35, 1h × 0.25)
  → MACD hist divergence (4h × 0.25)
  → Volume divergence (1h × 0.15)
  → Smooth: EMA(WDC_raw, 3) = RCI_line

LAYER 2: MPC — Multi-Pattern Confirmation (filter)
  → 5 patterns: RSI extreme, Stoch cross, Engulfing, Vol climax, Liq sweep
  → Signal ONLY khi MPC_score ≥ 2

OUTPUT: RCI_line (float, oscillator)
  > +0.8 AND MPC≥2 → BEARISH signal (đỉnh sắp quay đầu)
  < -0.8 AND MPC≥2 → BULLISH signal (đáy sắp quay đầu)
```

---

## 3. WDC Formula

### Pivot detection
- Swing high: bar[i].high > max(bar[i-N:i].high) AND bar[i].high > max(bar[i+1:i+N+1].high), N=5
- Swing low: bar[i].low < min(...), N=5

### Divergence calculation (per TF)

**Bearish (đỉnh):**
```python
# Tìm 2 swing high gần nhất: prev_high, curr_high
if curr_high.price > prev_high.price and curr_high.rsi < prev_high.rsi:
    age_factor = max(0, 1 - (curr_bar_idx - prev_high.bar_idx) / 50)
    rsi_div_bear = (prev_high.rsi - curr_high.rsi) / prev_high.rsi * age_factor
else:
    rsi_div_bear = 0
```

**Bullish (đáy):**
```python
# Tìm 2 swing low gần nhất: prev_low, curr_low
if curr_low.price < prev_low.price and curr_low.rsi > prev_low.rsi:
    age_factor = max(0, 1 - (curr_bar_idx - prev_low.bar_idx) / 50)
    rsi_div_bull = (curr_low.rsi - prev_low.rsi) / prev_low.rsi * age_factor
else:
    rsi_div_bull = 0
```

### Weighted sum
```python
WDC_bear = (rsi_div_bear_4h * 0.35 + rsi_div_bear_1h * 0.25
          + macd_div_bear_4h * 0.25 + vol_div_bear_1h * 0.15)

WDC_bull = -(rsi_div_bull_4h * 0.35 + rsi_div_bull_1h * 0.25
           + macd_div_bull_4h * 0.25 + vol_div_bull_1h * 0.15)

WDC_raw = WDC_bear + WDC_bull
RCI_line[i] = EMA(WDC_raw, period=3)
```

### Volume divergence
```python
vol_ma20 = MA(volume, 20)
# Bearish: price at swing high nhưng volume thấp
vol_div_bear = max(0, 1 - volume[i] / vol_ma20) if at_swing_high else 0
# Bullish: price at swing low nhưng volume thấp  
vol_div_bull = max(0, 1 - volume[i] / vol_ma20) if at_swing_low else 0
```

---

## 4. MPC Patterns (Layer 2)

| ID | Pattern | TF | Điều kiện | Score |
|----|---------|-----|-----------|-------|
| P1 | RSI extreme + reverting | 4h | RSI<30 và tăng, hoặc RSI>70 và giảm | 1 |
| P2 | Stochastic cross | 1h | Stoch(14) cắt lên từ <20 hoặc xuống từ >80 | 1 |
| P3 | Engulfing candle | 4h | Bullish/bearish engulfing | 1 |
| P4 | Volume climax | 1h | vol > vol_MA20×2.5 + close reversal | 1 |
| P5 | Liquidity sweep | 4h | Wick phá 20-bar low/high + close ngược | 1 |

**MPC_score = P1 + P2 + P3 + P4 + P5 (0-5)**  
Signal filter: **MPC_score ≥ 2**

---

## 5. Signal Definition

```
BULLISH_SIGNAL: RCI_line < -0.8 AND MPC_score ≥ 2
  → Giá đáy sắp quay đầu lên, xem xét LONG entry

BEARISH_SIGNAL: RCI_line > +0.8 AND MPC_score ≥ 2
  → Giá đỉnh sắp quay đầu xuống, xem xét EXIT long / caution
```

---

## 6. Validation

**Definition "reversal thật":**
- TOP: giá drop ≥ 3% trong 48h sau signal
- BOTTOM: giá pump ≥ 3% trong 48h sau signal

**Targets:**
- Precision ≥ 60%
- Coverage ≥ 40% đỉnh/đáy lớn
- 8-20 signals/năm
- Per-year: ≥ 5/7 năm precision ≥ 50%

**Split:**
- Train: 2019-2022
- Test OOS: 2023-2026

---

## 7. Usage

- Research/monitoring tool — không trade tự động
- Display trên btc-dashboard: panel riêng
- Alert khi signal fire
- Trader tự quyết action dựa trên RCI + regime context
