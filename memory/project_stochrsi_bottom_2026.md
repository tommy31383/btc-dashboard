---
name: project_stochrsi_bottom_2026
description: Research StochRSI + price breakdown multi-TF — LONG oversold + SHORT breakdown, validated 7y
---

## StochRSI Multi-TF Research — 2026-06-06

### LONG — Oversold entry (K_1h < threshold)

**Data:** 2708 nến 1d / 7 năm (365/năm đúng định nghĩa đáy 24h)

**TF ranking (sensitive → lag):**
- **1h**: avg K=52, K<10=9% ngày (~33/năm), K<20=18% — nhạy nhất, reliable
- **4h**: K<10=16% ngày — secondary confirm tốt
- **15m**: noisy, K rải đều, dùng time entry chứ không dùng filter
- **1d**: K>50 ở 50% ngày → vô dụng làm filter

**Signal line D:** K↑D ~50% (bình thường). Chỉ ý nghĩa khi K thấp (K<10 mà D-K>15 → chưa đáy thật)

**Seasonality:** Dec K<10@1h = 13% (cao nhất), Sep/Nov thấp nhất. Feb K<20 = 20%

**2026 vs 7y:** avg K_1d = 50.5 (cao nhất 7y) → đáy 2026 ít extreme hơn, market mature

---

### LONG Backtest — Best regime gate

**Signal:** K_1h < 20 tại close 1h  
**Best regime:** multitf_mom (4h close > 4h close 5 bars trước)  
**Params:** Hold 72h | Cooldown 12h

| Metric | Value |
|--------|-------|
| PnL | $160,879 |
| WR | 53.9% |
| n | 1389 |
| RA | 8.04 |
| Stab | 75% (6/8) |

- 2022: ✗ −$5k (bear, nhưng multitf_mom giảm thiệt hại tốt nhất)
- Regime ranking LONG: multitf_mom > adx > ema200 > price_struct > funding > none

---

### SHORT Backtest — Price Breakdown

**Signal:** close_1h < min(6h lookback) + nến đỏ + 4h confirm  
**Best regime:** multitf_mom (4h close < 4h close 5 bars trước = 4h đang xuống)  
**Params:** Hold 12h | Cooldown 12h | vol filter: không cần

| Metric | Value |
|--------|-------|
| PnL | $33,237 |
| WR | 47.9% |
| n | 2267 |
| RA | 4.79 |
| Stab | 88% (7/8) |

- 2022: ✓ +$16,624 (WR 55%) — bear market SHORT rất tốt
- 2026: ✓ +$1,179 — edge yếu, bounce nhanh squeeze short
- 2023 duy nhất âm (recovery year)
- Funding negative = tệ nhất (0/8 năm) — đừng dùng funding làm SHORT gate

**SHORT overbought (StochRSI K>80):** KHÔNG có edge — 0/8 năm dương. Đừng dùng.

---

### Pattern chung 2022 vs 2026

- avg K_1d tại đỉnh: 2022 = 53.3, 2026 = 53.3 (giống hệt)
- Combo K>80 multi-TF: phân bố giống nhau (2TF K>80 ~20-24%)
- 2026 K>90@1h chỉ 9% (2022=14%) → đỉnh 2026 ít extreme, bounce yếu hơn
- 2026 giống 2022 về structure → SHORT breakdown có edge nhưng yếu hơn 2022

---

### Key lessons

1. **multitf_mom = regime gate tốt nhất** cho cả LONG và SHORT (RA cao nhất cả 2 chiều)
2. **SHORT BTC = chỉ có edge qua price breakdown**, không phải overbought indicator
3. **Hold ngắn 12h** cho SHORT (tránh squeeze), **Hold dài 72h** cho LONG (give room)
4. **Funding gate = vô dụng** cho cả 2 chiều (LONG: no valid combo, SHORT: 0/8 năm)
5. **2026 SHORT edge yếu** — nếu anh Tommy muốn SHORT 2026 cần strict regime + tight SL
