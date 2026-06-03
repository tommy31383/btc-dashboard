# Auto-Rule Evolution — Methodology / Playbook

**Mục đích:** quy trình chuẩn để TỰ ĐỘNG sinh → kiểm định → cải tiến → mở rộng trading rule, không thổi phồng, không overfit. Áp cho mọi task "loop optimize rule" của Tommy.

> Đây là tài liệu về **QUY TRÌNH** (cách làm). Tài liệu về **NỘI DUNG rule** (6 nguyên tắc trading) là `general-trend-method-framework.md`. Hai cái bổ trợ nhau.

---

## 0. Nguyên tắc tối cao

**Judge bằng HONEST single-account dollars/CAGR, KHÔNG bằng metric normalize.**
Mọi metric reset-capital-mỗi-năm hoặc cộng-ROI-nhiều-sleeve đều thổi phồng. Tin số nào → số đó phải đến từ 1 account thật, margin-cap, compound.

---

## 1. Pipeline 5 bước

```
GEN  →  BACKTEST  →  AUDIT (3 cổng)  →  IMPROVE  →  MỞ RỘNG
 ↑__________________________________________________|
                  (champion-challenger loop)
```

### Bước 1 — GEN (sinh challenger)
- **Tách indicator (precompute 1 lần) khỏi threshold (tune).** Period cố định (ADX14, EMA200/20, ATR14) → mỗi eval chỉ vài giây. Đây là chìa khóa để loop nhanh (~12 gen/s).
- Move-set theo cấp độ an toàn:
  1. **Threshold tune** (an toàn nhất): ADX/DI/SL/TP/HOLD/COOL/pos/risk/band. Bắt đầu ở đây.
  2. **Structural moves** (mở sau): bật/tắt sleeve, đổi exit logic, thêm filter từ palette ĐÃ validated (EMA-gate, vol-MA, ATR-pctile). KHÔNG data-scan filter (h=16, Thu/Sun).
  3. **Asset** (mở sau): chỉ BTC/ETH/SOL. SOL validated (hedge01 Sh2.0).
- Perturb 1 param/vòng; sau plateau (>150 vòng không promote) → multi-perturb để thoát.

### Bước 2 — BACKTEST (honest single-account)
- **Equity-fraction sizing:** margin = risk% × equity_hiện_tại × vol_scale. KHÔNG fixed-dollar (fixed-dollar → % per-year giảm dần khi equity tăng).
- **Margin cap:** tổng margin mở đồng thời ≤ cap × equity. Skip entry khi hết free margin.
- **Compound:** equity += pnl mỗi close; per-year % tính trên equity đầu năm.
- Data 7y full-cycle `.cache/binance-5m-7y.json` (2019→2026, đủ 2 bull + 2 bear).

### Bước 3 — AUDIT (3 cổng — KHÔNG promote nếu trượt bất kỳ cổng nào)
| Cổng | Kiểm tra | Chống |
|---|---|---|
| **1. Honest constraint** | DD≤cap, n≥target/năm, no year < −X% | over-leverage, sample mỏng, năm sập |
| **2. OOS walk-forward** | test (3 năm cuối) CAGR ≥ champion × 0.98 | overfit train (bull years lấn át) |
| **3. Robustness ±1** | ≤15% neighbor (param ±1 step) fragile | curve-fit nhọn |

Khi promote, deep-audit thêm: **concurrent margin peak %** (phải ≤ cap), **double-count corr** giữa các sleeve cùng symbol (corr cao = leverage trá hình, không phải diversify).

### Bước 4 — IMPROVE (champion-challenger)
- Champion mới chỉ khi: full-score cao hơn **VÀ** qua cả 3 cổng.
- Score = honest_CAGR × stability (stability = frac năm dương → chống front-load).
- Persist champion-state để resume; log mọi vòng.

### Bước 5 — MỞ RỘNG (khi champion ổn định / Tommy duyệt)
- Nâng move-set: threshold → +structural → +asset (SOL).
- Walk-forward v2: optimize **train-only** rồi select theo **test** (đúng hơn full-period).
- Deep audit thêm: fee/slippage thật, Monte-carlo shuffle DD, per-regime BULL/RANGE/BEAR.
- **Forward-test gate (BẮT BUỘC):** mọi champion trước khi size thật phải paper-test live-forward, đối chiếu backtest.

---

## 2. Guard-rails (nhúng cứng vào tool — lessons đã trả giá)

| Guard | Lý do |
|---|---|
| Honest single-account, no flat-per-sleeve | KPI gộp sleeve thổi phồng (case G14: 8/8 → 2022 thực −1.7%) |
| Walk-forward train/test | combo 3y bull-only không tin được; ≥6/8 năm dương |
| Robustness ±1 gate | thêm filter → n giảm → overfit; structural OK, data-scan risky |
| SL luôn có | "no SL" = survivorship bias, cấm tuyệt đối |
| No BEAR-short | đã test 2 lần 8 method, ngồi cash BEAR là đúng |
| Universe BTC/ETH/SOL | cấm alt khác |
| Judge dollars khi size vary | rule có DCA/pyramid → RA% ngược dấu dollar thật |

---

## 3. Tooling (reference implementation)

| File | Vai trò |
|---|---|
| `tools/general-rule-autoloop.py` | engine: precompute + sleeve gen + honest scorer + hill-climb. Import lại được (`__name__` guard). Modes: baseline/loop/verify/cmp. |
| `tools/general-rule-evolver.py` | daemon không ngừng: 3-cổng + auto-commit. Import autoloop làm engine. |
| `tools/general-rule-g15-exposure-audit.py` | audit độc lập: concurrent margin + double-count + single-account re-sim. |
| `autoloop-best.json` / `evolver-champion.json` | champion hiện tại + metrics. |
| `evolver-report.md` | lịch sử champion (auto-append). |

**Vận hành daemon:**
```bash
nohup python3 tools/general-rule-evolver.py >tools/evolver-live.log 2>&1 &  # chạy không ngừng
cat tools/evolver-heartbeat.txt        # monitor
touch tools/evolver-STOP               # dừng sạch
# resume: chạy lại — tự load evolver-champion.json
```
**Lưu ý git:** daemon auto-commit khi promote → khi mình cần commit tay, `touch evolver-STOP` pause 1 nhịp rồi relaunch (tránh git lock).

---

## 4. Checklist nhanh khi Tommy giao task "optimize rule"

1. [ ] Scorer honest single-account chưa? (KHÔNG flat-per-sleeve)
2. [ ] Equity-fraction sizing + margin cap chưa?
3. [ ] Train/test split chronological chưa?
4. [ ] 3 cổng (constraint / OOS / robustness) đủ chưa?
5. [ ] Guard-rails (SL, no-bear-short, universe) nhúng chưa?
6. [ ] Concurrent exposure + double-count audit khi promote chưa?
7. [ ] Forward-test gate ghi rõ "chưa deploy" chưa?

**Reference session:** `general-rule-g14-g16-evolver-2026-06-04.md` (case study đầy đủ: KPI artifact → honest re-sim → G16 → evolver).
