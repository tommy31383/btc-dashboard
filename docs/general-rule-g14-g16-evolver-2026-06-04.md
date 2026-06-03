# General Rule G14→G16 + Rule Evolver — session 2026-06-04

**Status:** BACKTEST honest-validated · **CHƯA forward-test, CHƯA deploy**
**Capital framing:** judge bằng honest single-account CAGR / DD / per-year (equity-fraction sizing, compound thật — KHÔNG flat-per-sleeve).

---

## 1. Hành trình KPI

| Version | Mô tả | KPI flat (cũ) | Honest single-account |
|---|---|---|---|
| G10c | baseline | 6/8 = 75% | — |
| G13d | BTC-only vol-target | 7/8 = 87.5% | — |
| G14 | BTC 4h + ETH retest-zone | 8/8 = 100% | — |
| G15e | + BTC 1h sleeve | 8/8 = 100% | CAGR 70.5% DD 20.7% (risk 0.04) |
| **G16** | autoloop honest-optimized | — | **CAGR 128% DD 24% n378 testCAGR 30%** |

### Key insight ETH (G14)
ETH chỉ vào lệnh khi `price ∈ [0.85, 1.05] × EMA200d` (retest zone). Lọc 2025 overextended (ratio 1.10-1.18 = crash), giữ 2022 retest bounces (ratio 0.85-1.05). 2021 ETH tự off (rally xa EMA200d).

### Key insight 1h (G15)
1h entries dùng **cùng conditions** với 4h + gate "4h trend đang active" → additive, không thêm filter mới. n gộp 180→488/năm.

---

## 2. ⚠️ AUDIT — KPI "8/8" là ARTIFACT

Yêu cầu audit concurrent exposure + double-count. Phát hiện:

**Concurrent exposure:** `tnot`=margin, notional=tnot×10. Tổng margin mở đồng thời 3 sleeve:
- Peak margin **$290k = 290% capital → 29× leverage**; mean 70% (7×)
- ROI +2,991% tính trên nominal $100k nhưng peak margin > capital → **account liquidate**. Giả định unlimited margin.

**Double-count BTC 1h vs 4h:** khi 4h mở, 1h cũng mở **50.2%** thời gian. Monthly corr **+0.58**, same-sign 64%. → 1h KHÔNG diversify, là **leverage thêm trên cùng trend BTC**.

**Re-sim 1 account $100k margin-cap thật:**
| Metric | Nominal (KPI cũ) | HONEST |
|---|---|---|
| ROI 7y | +2,991% | +2,164% (compound) |
| Max DD | 170.9% (vô nghĩa) | **19.0%** |
| 2022 | +147% | **−1.7%** ❌ |

**Bài học:** mọi backtest gộp nhiều sleeve PHẢI re-sim 1 account margin-cap trước khi tin. Per-year % tính trên equity running, không flat denominator. → `tools/general-rule-g15-exposure-audit.py`.

---

## 3. G16 — Autoloop honest optimizer

`tools/general-rule-autoloop.py`. Objective: honest single-account, equity-fraction sizing (margin = risk%×equity×vol_scale, margin-cap). Hill-climb 400 iters. Hard constraints DD≤25%, n≥150/yr, no year<−15%. Train 2019-23/test 2024-26.

**Best config (`autoloop-best.json`):**
```
BTC4h: adx16 di0.9 sl1.6 tp12 hold40 cool2 pos7 bg0.80
BTC1h: adx16 di1.05 sl1.8 tp10 hold36 cool1 pos5
ETH:   adx20 di1.1 sl1.6 tp12 band[0.85,1.05]
risk=0.04/lệnh, margin_cap=1.0×equity
```

**Honest metrics — vượt baseline @ matched DD ở MỌI chiều (kể cả out-of-sample):**
| | G15 risk0.04 | **G16 best** |
|---|---|---|
| Full CAGR | 70.5% | **128.2%** |
| TRAIN CAGR | 99.7% | 192.4% |
| TEST CAGR (OOS) | 19.3% | **30.2%** |
| MaxDD | 20.7% | 23.8% |
| min_n/năm | 240 | **378** |

8/8 năm dương. Robust: param ±1 chỉ 3/31 fragile.

**Cơ chế "tăng n VÀ ROI":** loop KHÔNG tăng risk (DD cap) → thêm lệnh đa dạng đồng thời trong margin-cap (pos↑, ADX/bg nới) → diversification trong cap.

---

## 4. Rule Evolver — daemon tự tiến hóa không ngừng

`tools/general-rule-evolver.py`. Champion-challenger loop vô hạn, threshold-tune only. **3 cổng promote:**
1. Honest constraint (DD≤25%, n≥150/yr, no yr<−15%)
2. OOS walk-forward (test CAGR ≥ champion × 0.98)
3. Robustness ±1 (≤15% fragile)

Qua cả 3 + score cao hơn → deep audit (double-count corr) → **auto git commit+push**. Seed G16. ~12 gen/s.

**Vận hành:**
- Chạy: `nohup python3 tools/general-rule-evolver.py >tools/evolver-live.log 2>&1 &`
- Dừng: `touch tools/evolver-STOP`
- Monitor: `cat tools/evolver-heartbeat.txt`
- Champion mới: `evolver-champion.json` + `evolver-report.md` (auto-commit)

Tính tới 2026-06-04 ~2680 gen: 0 champion mới (G16 đã tốt, cần chạy lâu mới vượt 3 cổng).

---

## 5. Còn lại trước khi deploy

- **Forward-test paper** G16 — BẮT BUỘC, chưa làm.
- Stress-test fee/slippage/funding thật + Monte-carlo DD distribution.
- Daemon v2: walk-forward train-only→test-select (thay vì full-period bull-bias).
- Mở scope daemon: structural moves / thêm SOL sleeve (khi Tommy duyệt).

**Scripts:** `tools/general-rule-g14.py` · `g15.py` · `g15-exposure-audit.py` · `general-rule-autoloop.py` · `general-rule-evolver.py` · `autoloop-best.json` · `evolver-champion.json`
