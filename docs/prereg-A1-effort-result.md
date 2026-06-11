# PRE-REGISTRATION — A1: Effort vs Result (candle-state only)

**Locked:** 2026-06-11 (trước khi chạy). Mục tiêu = **FEATURE TRIAGE**, KHÔNG phải validation/strategy.
Toàn bộ data ≤2026-06 = **development**. Không TP/SL, không sizing, không structure/S-R/multi-TF.

## Hypothesis (hẹp)
Candle-state thuần (effort=volume, result=price location/range) có chứa thông tin về **forward return**
và **future range expansion** vượt baseline drift.

## Features (công thức KHÓA — OHLCV-only, closed bars)
- `medRange[i]` = rolling median của (high-low), LB=**50**. `medVol[i]` = rolling median volume, LB=**50**.
- `closePos=(c-l)/(h-l)`, `rangeRatio=(h-l)/medRange`, `volRatio=v/medVol`.

## States (KHÓA, ưu tiên theo thứ tự; chỉ 4 state + NEUTRAL)
- `EXHAUSTION`: rangeRatio≥1.8 AND volRatio≥2.0
- `ABSORPTION`: volRatio≥1.5 AND rangeRatio≤0.8
- `DEMAND`: volRatio≥1.5 AND closePos≥0.66
- `SUPPLY`: volRatio≥1.5 AND closePos≤0.34
- `NEUTRAL`: còn lại (= baseline comparator nội bộ)

## Event timing (KHÓA — no lookahead)
- State tính trên **nến đã đóng** i (chỉ dùng dữ liệu tới i). `rightBars`=0 (candle-state là thuộc tính nến đóng).
- **Đo bắt đầu ở cây kế tiếp:** base = close[i]; horizon đếm bar SAU i.

## Horizons (KHÓA): 1, 3, 6, 12 bar. TF chính = 4h (lặp lại 1h, 1d để stability).

## Metrics (KHÓA) — mỗi state vs NEUTRAL
- forward return % `(close[i+h]-close[i])/close[i]`: **mean, median, directional hit-rate**.
- **MFE/MAE** trên i+1..i+h: upMFE=max(high-close[i])/close[i], dnMAE=min(low-close[i])/close[i].
- **future range expansion** = (max high − min low trên i+1..i+h)/medRange[i]: mean.
- **rank-biserial effect size** (Mann-Whitney U: state vs NEUTRAL) + p-value (normal approx).

## Sample minimums (KHÓA)
- ≥**30 trades/năm** cho state được xét stability theo năm; ≥**200** toàn kỳ để báo cáo chính.

## Multiple testing (KHÓA)
- Primary tests = 4 state × 4 horizon = **16**. **Bonferroni** α=0.05 → ngưỡng p<0.05/16=**0.003125**.
- Báo cả raw p và pass/fail Bonferroni. Không cherry-pick ô lẻ.

## Stability (KHÓA)
- Per-year: dấu của mean fwd-return có nhất quán không (báo #năm cùng dấu / tổng).
- Parameter neighborhood: lặp với LB∈{40,50,60}, volRatio threshold ±0.2, rangeRatio ±0.2 → effect size có giữ dấu/độ lớn không.

## Decision rule (triage)
- **KEEP** state-feature nếu: |rank-biserial|≥0.1 AND p<Bonferroni AND dấu nhất quán ≥5/ số-năm AND giữ qua neighborhood.
- Else **DROP**. KHÔNG được xuất `confidence`. Kết quả = triage, không phải tín hiệu giao dịch.
