# Trend Direction Index — Backtest & Improve Loop (iter 1–3)

**Ngày:** 2026-06-03
**Tool:** `tools/trend-backtest-7y.py` · Data: `binance-5m-7y.json` (778,970 bar, 2019-01 → 2026-05)
**Mục tiêu:** RCI panel detect downtrend / xu hướng chart. Trend Index = `utils/trend.ts`.
**Horizon eval:** forward 30 × 4h = 5 ngày. Metric chính = **excess return vs global drift** (BTC drift lên +0.83%/5d nên raw %pos vô nghĩa, phải trừ drift).

---

## Iteration 1 — Audit baseline (v1, đúng trend.ts ship đầu)

```
ZONE          n      avgFwd%   excess vs drift +0.83%
STRONG_DOWN   3436   +0.49      -0.34%
DOWN          2981   +0.54      -0.29%
RANGE         2208   +0.42      -0.41%
UP            3748   +1.01      +0.17%
STRONG_UP     3638   +1.46      +0.63%
Directional accuracy 49.9% · monotonic NO · stable 4/8 năm
```

**Phát hiện:** phía UP hoạt động (STRONG_UP +0.63% excess), **phía DOWN HỎNG** — STRONG_DOWN raw fwd vẫn DƯƠNG (+0.49%), excess chỉ −0.34%. Downtrend (cái Tommy cần) yếu nhất. Nguyên nhân: nhãn down fire cả trong dip giữa uptrend (BTC drift lên nuốt tín hiệu).

## Iteration 2 — STRONG_DOWN bắt buộc giá < EMA200 + tăng trọng số DI (v2)

`need_below200=True`, `di_strong 1.5→2.0`, `di_weak 0.6→0.8`.

```
STRONG_DOWN   2958   excess -0.63%   (−0.34 → −0.63, gần GẤP ĐÔI bearish)
STRONG_UP     3726   excess +0.62%
```

**Lý do:** gate `price < EMA200` loại các "down" giả trong bull pullback. Chỉ giữ down có cấu trúc bear thật → tách bạch rõ.

## Iteration 3 — Thêm EMA200 slope gate + nâng threshold zone (v3) ✅ ADOPTED

`ema200slope=True` (STRONG cần EMA200 cùng hướng), `zthr 1.2→1.6`, `zstrong 2.5→3.0`.

```
ZONE          n      excess vs drift
STRONG_DOWN   2760    -0.65%   ← best bearish
DOWN          3465    -0.04%   (noise — gần drift)
RANGE         2716    -0.32%
UP            3765    +0.00%   (noise)
STRONG_UP     3305    +0.83%   ← best bullish
Spread STRONG_DOWN ↔ STRONG_UP = 1.48% / 5 ngày
```

---

## Kết luận loop (đến iter 3)

1. **Edge nằm ở 2 zone EXTREME (STRONG_UP / STRONG_DOWN)** — excess ±0.65–0.83%/5d, dùng được. Zone DOWN/UP thường (non-strong) ≈ noise (excess ~0) → trong UI coi là "bias yếu", đừng tin tuyệt đối. Khớp lesson `general-trend-method-framework`: ADX king, extremes matter.
2. **Downtrend detection cải thiện 49% → 91%** về độ tách (excess −0.34 → −0.65). Cách hiệu quả: ép `price < EMA200` + `EMA200 slope < 0` cho STRONG_DOWN.
3. **Trend ≠ predictor lợi nhuận tuyệt đối** ở horizon 5d (BTC drift lên) — Trend Index là **bộ lọc hướng / regime**, không phải tín hiệu entry độc lập. Đúng META-LESSON: trend cho DIRECTION, RCI cho TIMING, KHÔNG trộn.

**Applied to `utils/trend.ts` (v3):** di_strong 2.0, di_weak 0.8, zthr 1.6, zstrong 3.0, STRONG_DOWN gate `<EMA200 & EMA200↓`, STRONG_UP gate `EMA200↑`.

## Iteration 4 — OOS train/test split (v3) ⚠️ EDGE DECAY

```
v3 OOS @2023:        STRONG_DOWN   STRONG_UP    (n train/test)
  train 2019-22:        -1.16%       +1.44%      (1512/1660)
  test  2023-26 OOS:    -0.03%       +0.22%      (1248/1645)
```

**Phát hiện then chốt:** edge dự báo TẬP TRUNG ở train era 2019-22, **OOS 2023-26 gần như BIẾN MẤT** (STRONG_DOWN −0.03%). Giống y pattern reversal-sleeve = artifact 2019-21 (RCI loop iter8). Forward-alpha của trend-label đã decay theo thời gian khi BTC trưởng thành, biên độ trend co lại.

**Hệ quả thiết kế (trung thực):**
- Trend Index = **REGIME / mô tả xu hướng hiện tại HỢP LỆ** (EMA stack + ADX/DI phản ánh đúng cấu trúc đang chạy) → panel show xu hướng cho Tommy là đúng mục đích.
- **KHÔNG phải alpha dự báo** forward-return ở thị trường gần đây → không build entry-signal độc lập từ trend-label.
- Đúng META-LESSON: Trend = DIRECTION/regime, RCI = TIMING. Giữ tách biệt.

## TODO loop tiếp (iter 5+)
- [ ] Horizon ngắn (1-2 ngày): downtrend có rõ hơn không, hay cũng decay OOS?
- [ ] ADX threshold sweep cho STRONG trên RIÊNG era 2023-26 (tránh fit 2019-22).
- [ ] Trend-regime GATE cho RCI reversal: chỉ tin RCI-bull khi Trend ≠ STRONG_DOWN (test net effect 7y).
- [ ] Audit: zone hiện tại có "dính" (sticky) không hay flip liên tục (whipsaw cost)?
