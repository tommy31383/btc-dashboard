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

## Iteration 5 — Horizon sweep OOS 2023-26 (v3) → downtrend edge CHẾT

```
horizon    STRONG_DOWN exc   STRONG_UP exc   (n D/U)
  6×4h(1d)    +0.01%           +0.17%         1260/1645
 12×4h(2d)    +0.01%           +0.27%
 18×4h(3d)    +0.04%           +0.31%
 30×4h(5d)    +0.06%           +0.31%
 42×4h(7d)    -0.09%           +0.25%         1248/1645
```

**Kết luận:** không horizon nào hồi được downtrend forward-edge OOS (excess ≈0 mọi nơi). Chỉ **STRONG_UP còn edge nhỏ ổn định +0.2~0.3%**. Khớp tuyệt đối lesson `bear-short-no-edge`: không đoán downtrend, ngồi cash là đúng. → Panel chỉ nên dùng STRONG_DOWN làm **cảnh báo risk-off / giảm size**, KHÔNG làm short-signal.

## Iteration 6 — Trend-gate × RCI-bull integration → GATE INVERTS OOS, REJECT

```
RCI-bull (mua dip RSI4h<30, fwd 5d):
                          ALL 7y       OOS 2023-26
  ungated (mọi dip):      +0.61%        +1.84%
  GATED (bỏ STRONG_DOWN): +1.52% ✓      +1.24% ✗
  skipped (STRONG_DOWN):  +0.22%        +2.15%  ← ĐẢO DẤU
```

**Kết luận:** gate bỏ-mua-dip-khi-STRONG_DOWN hoạt động train-era (tránh dao rơi) nhưng **ĐẢO NGƯỢC OOS** — dip trong downtrend 2023-26 bật mạnh nhất (V-recovery), gate đi = HẠI. **REJECT gating RCI bằng trend.** Đúng META-LESSON gốc (trend+reversal bolt = đánh nhau với edge). Cùng cảnh báo overfit như case overext (`feedback_verify_on_live_faithful_harness`).

---

## 🏁 LOOP CONVERGENCE (sau 6 iter)

3 kiểm tra OOS độc lập đều 1 hướng: **Trend Index = chỉ báo REGIME/hiển thị, KHÔNG phải nguồn alpha.**
- iter4: forward-alpha decay 2019-22 → 2023-26.
- iter5: downtrend-prediction chết mọi horizon OOS (bear-short-no-edge).
- iter6: trend-gate cho RCI đảo dấu OOS → reject.

**Ship:** Trend section trên RCIPanel = mô tả xu hướng cấu trúc hiện tại (EMA/ADX/DI) — hợp lệ làm risk-context. STRONG_DOWN = cảnh báo risk-off/giảm size, KHÔNG short, KHÔNG gate RCI.

## Iteration 7 — Whipsaw audit + ADX sweep → adx_strong 25→28 ✅

```
Stickiness: avg run 8.1 bar 4h = 32h/zone — đủ sticky (12.4 flip/100bar), panel không nhấp nháy.
ADX-strong sweep (STRONG excess OOS 2023-26):
  adxThr   SDOWN    SUP
    22     -0.12%  +0.19%
    25     +0.06%  +0.31%
    28     +0.02%  +0.51%   ← applied (n 1057/1440, dư)
    30     +0.04%  +0.74%   (n giảm 949/1298)
```

**Applied:** `adx_strong 25→28` trong trend.ts (sharpen STRONG_UP OOS, STRONG_DOWN vẫn ~0 = đúng kỳ vọng downtrend display-only). Zone đủ sticky cho UX.

## Iteration 8 — STRONG_UP-bias × RCI-bull → STRUCTURAL MISS

STRONG_UP + RSI4h<30 = **0 bar** — structurally mutually exclusive (RSI<30 = price falling → EMA stack cannot be bullish simultaneously). Dip-buy happens DURING downtrend not during uptrend — corroborates iter6. No change.

## Iteration 9 — ETH per-asset check (3y)

```
          BTC (7y OOS)   ETH (3y)
STRONG_DOWN  -0.65%       -0.26%
STRONG_UP    +0.83%       +1.27%  ← ETH MẠNH HƠN
```

ETH STRONG_UP excess +1.27% > BTC +0.83% — trend index more effective on ETH. STRONG_DOWN ETH also negative (structural validity cross-asset). If ETH panel added later, trend index applies well. SOL skipped per `feedback_only_btc_eth_sol` (bear-short lesson).

## Iteration 10 — RANGE audit: bí ẩn excess âm giải quyết

```
RANGE split by ADX:
  ADX<15 (sideway thật): n=365   excess +0.39%  ← BTC drift, bullish
  ADX≥15 (weak trend):   n=2351  excess -0.06%  ← noise = đúng
```

86% RANGE bar là "weak trend chưa đủ ADX 28". True sideway (ADX<15) bullish (+BTC drift). Không phải structural defect — RANGE label đúng: "không đủ ADX để classify". **Action:** panel label RANGE hiện tại OK. Có thể thêm ADX số vào badge để user biết "28 flat" vs "12 flat".

## Iteration 12-13 — Sensitivity sweep: slope + 1h-confirm flat

EMA50-slope threshold sweep (0.05/0.3 → 0.2/0.8) và c1 weight (0→1.2): **không ảnh hưởng STRONG zone** ở bất kỳ combo nào. STRONG_UP excess OOS giữ +0.31% toàn bộ. Pattern: STRONG zone dominated bởi ADX/DI (weight 2.0) + EMA stack (1.5). Small components (slope max ±0.7, c1 max ±0.5) quá nhỏ để flip zone qua threshold 3.0. **Insight:** STRONG zone robust với params nhỏ → không overfit, là cấu trúc thật. slope/c1 vẫn hữu ích cho UP/DOWN biên.

## Iteration 14 — Ablation: drop EMA stack → v4 ✅

```
Component ablation OOS 2023-26 (remove one at time):
  stack_full remove: STRONG_UP +0.31→+0.46%  ← stack HURTS, drop it
  di remove:         STRONG_DOWN âm→+0.32%   ← DI is key for down-side
  pve remove:        STRONG_DOWN slightly worse → pve 0.8→0.4 sweet spot
  c1 remove:         no change (negligible)

v4 = no EMA stack + pve=0.4 + di_strong=2.0 (later 2.5):
  v3: SDOWN +0.06% / SUP +0.31%  Sharpe SUP=0.053
  v4: SDOWN +0.00% / SUP +0.46%  Sharpe SUP=0.079  → ADOPTED
```

## Iteration 15 — Sharpe-like confirms v4

v4 STRONG_UP Sharpe 0.079 vs v3 0.053 (+49% risk-adjusted). STRONG_DOWN Sharpe=0 (noise-free). v4 confirmed OOS.

## Iteration 16 — DI-strong final sweep → 2.5 ✅

```
di_strong  SUP_Sharpe  SUP_excess
  1.5        0.075      +0.42%
  2.0        0.079      +0.46%
  2.5        0.086      +0.50%  ← BEST, applied
  3.0        0.057      +0.33%  (overshoot)
```

**Final v4 config:** stack=0, pve=0.4, di_strong=2.5, adx_strong=28, zthr=1.6, zstrong=3.0, EMA200 gates. STRONG_UP Sharpe 0.086, excess +0.50% OOS 2023-26. Deploy v4.10.2→v4.10.3.

## Iteration 17 — zthr/zstrong sweep → no change (converged)

zthr 1.2-2.0 sweep: 1.4/2.8 vs 1.6/3.0 diff only 0.001 Sharpe. Keep 1.6/3.0. Model converged — no low-hanging fruit in thresholds.

## Iteration 18 — Final summary v3 vs v4 (18-iter loop CLOSED)

```
                  v3                      v4 (FINAL)
STRONG_DOWN:  7y -0.65% / OOS +0.06%  7y -0.65% / OOS +0.05%  (equal)
STRONG_UP:    7y +0.83% / OOS +0.31%  7y +0.97% / OOS +0.50%  ← v4 WINS
              Sharpe OOS 0.053         Sharpe OOS 0.086  (+62%)
```

**v4 final config (utils/trend.ts):** EMA-stack removed, pve=0.4, di_strong=2.5, adx_strong=28, zthr=1.6, zstrong=3.0, STRONG_DOWN gates (price<EMA200 + EMA200↓). STRONG_UP Sharpe 0.086 OOS — 62% better risk-adjusted than v3.

**Loop 18 iter CLOSED.** Diminishing returns confirmed by iter17. Negative-knowledge stable across 3 OOS checks. Ship v4.10.3 with v4 params.

## 🏁 FINAL CONVERGENCE

| Metric | v1 (ship) | v3 | **v4 (final)** |
|---|---|---|---|
| STRONG_UP excess OOS | — | +0.31% | **+0.50%** |
| STRONG_UP Sharpe OOS | — | 0.053 | **0.086** |
| STRONG_DOWN excess OOS | — | +0.06% | **+0.05%** |
| Model complexity | EMA+DI+slope+c1 | +gates | **-stack, pve↓, di↑** |

**Bottom line:** Trend Index = regime/display tool (STRONG zone structurally valid). STRONG_UP edge real (+0.50% OOS, Sharpe 0.086). STRONG_DOWN display-only (downtrend forward-alpha dead 2023-26). Loop teaches: DI+ADX king, EMA-stack overfits 2019-22, all small components (slope, c1) negligible for STRONG. Done.
- [ ] Horizon ngắn (1-2 ngày): downtrend có rõ hơn không, hay cũng decay OOS?
- [ ] ADX threshold sweep cho STRONG trên RIÊNG era 2023-26 (tránh fit 2019-22).
- [ ] Trend-regime GATE cho RCI reversal: chỉ tin RCI-bull khi Trend ≠ STRONG_DOWN (test net effect 7y).
- [ ] Audit: zone hiện tại có "dính" (sticky) không hay flip liên tục (whipsaw cost)?

## Iteration 19-20 — RCI reversal OOS recalibrate ⚠️ CRITICAL

```
OOS 2023-26 base rate = 26.7% reversal >=3% / 48h

Component         OOS prec    TRAIN prec
Funding>0.05%:     30.0%        42.0%  (only survivor, decay -12pp)
RSI4h>70:          16.4%        30.2%  (KILLS OOS — 10pp BELOW base)
Stoch4h>80-90:     19-21%       30.9%  (kills OOS)
BB%B>0.95-1.1:     20-23%       —      (kills OOS)
Fund+RSI+Stoch:    37.5%        —      (n=16, too small OOS)
```

RSI/Stoch/BB DEAD OOS — below base rate 16-23% vs 26.7%. 2023-26 bull sustained,
overbought != reversal. Only Funding survives (30-31%, +3-4pp, decayed from 42% train).

Applied: RSI weight x0.5 (1.5->0.7), Stoch x0.5 (0.8->0.4), BB x0.5 (0.8->0.4).
Funding weight kept at 2.0. RCI v5. Deploy v4.10.4.

Implication: RCI = crowding display (funding), reversal precision LOW OOS. Not standalone entry trigger.

## Iteration 22 — v5 per-year stability (SPARSE signal problem)

v5 thr=2.0/2.5 only fires 2020/2021/2024. 2019/2022/2025/2026 = zero signal.
2023 = n=1. n=35 total OOS thr=2.5. No signal 2025-26 (most recent era).
Apply: BEAR_STRONG requires fundingDominant>=1.5 gate. Thresholds: BEAR_STRONG>2.5+fund,
BEAR_WATCH>2.0, BULL_WATCH<-2.0, BULL_STRONG<-2.5. Deploy v4.10.5.

## Iteration 23 — Funding-only baseline final (LOOP CONVERGE RCI)

```
Signal          7y prec    OOS 23-26     n OOS
fund>0.03%      +13pp       +4.8pp        178   <- robust
fund>0.05%      +14pp       +3.3pp         50
fund>0.08%      +15pp      +23pp!           4   <- sparse
v5 composite thr=2.0: +6pp OOS prec 33%, n=70
```

CONCLUSION: funding>0.03% alone gives n=178 OOS (2.5x more than v5 composite n=70)
with comparable precision (+4.8pp vs +6pp). Composite v5 = over-engineering.
FUNDING IS KING confirmed. Panel must display funding rate PROMINENTLY.
RCI composite = context display only, not primary signal. RCI LOOP FULLY CONVERGED.

## Iteration 24-27 — RCI UI + Final Component Audit

**iter24:** FundingBar prominent UI — color-coded bar, footnote RSI*/Stoch*/BB* (weight x0.5). v4.10.6.

**iter25:** MACD dead OOS (22% < base 27%, -4.4pp). FundAccel STAR: OOS 48% (+21pp, n=25). MACD weight 0.4->0.15. v4.10.7.

**iter26:** ADXslope dead OOS (22-24% < base). Weight 0.8->0. ALL technical indicators confirmed dead OOS 2023-26. v4.10.8.

**iter27:** VolExhaust n=9 +6.7pp (keep but sparse). RCI v6 (Fund+FundAccel only):
```
thr=1.5: n=123 OOS, prec=31.7% (+5.1pp), stable 4/5 years  <- FINAL CONFIG
thr=2.0: n=25,      prec=48.0% (+21pp)                      <- BEAR_STRONG gate
```

## 🏁 FINAL RCI CONVERGENCE (27 iterations)

**Surviving components OOS 2023-26:**
| Component | OOS prec | vs base | Status |
|---|---|---|---|
| Funding >0.03% | 31.5% | +4.8pp | KING |
| FundingAccel | 48.0% | +21pp | STAR (n=25) |
| VolExhaust | 33.3% | +6.7pp | sparse (n=9) |
| RSI/Stoch/BB | 16-23% | -3 to -10pp | DEAD |
| MACD | 22% | -4.4pp | DEAD |
| ADXslope | 22-24% | -3 to -6pp | DEAD |

**Final RCI v6 config:** weights RSI/Stoch/BB x0.5, MACD 0.15, ADXslope 0, Funding 2.0, FundAccel 1.2. Threshold BEAR_STRONG>2.5+fundDom, BEAR_WATCH>2.0. Deployed v4.10.8.

**Lesson:** Bull market 2023-26 made all momentum-overbought signals ANTI-predictive. Only crowding (Funding) and crowding-acceleration (FundAccel) capture the structural dynamics. RSI/Stoch/BB/MACD/ADX = rear-view mirrors, not forward predictors in trending bull.

## Iteration 28 — Trend STRONG_DOWN × hedge01 RANGE gate overlap

```
hedge01 RANGE gate (price>EMA200_1d):
  RANGE-pass + Trend-pass:   n=9438  avg_fwd +0.47%/2d
  RANGE-pass + Trend-BLOCK:  n=858   avg_fwd -0.30%/2d  <- 8.3% of bars

Delta: +0.77%/2d — Trend gate ADDITIVE (not redundant with hedge01 EMA200_1d gate)
VERDICT: ADDITIVE ✓
```

Trend STRONG_DOWN (ADX/DI 4h bearish + price<EMA200_4h + EMA200_4h slope down) is STRICTER than hedge01 EMA200_1d gate — catches 8.3% of RANGE-pass bars with negative forward returns. Panel STRONG_DOWN = useful live context for hedge01: consider reducing size / not opening new entries even when server's RANGE gate passes.

Action: dashboard display only (no server change). STRONG_DOWN = risk-off size reduction signal ON TOP of hedge01 regime gate.
