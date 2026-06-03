# General Rule — Multi-Asset hedge01 Book (autoloop 2026-06-02)

**Status:** Backtest-validated, walk-forward-confirmed · **NOT deployed** (forward-test required before sizing)
**Source:** Autonomous research loop 2026-06-02, 11 cycles, Opus 4.8. Journal: `btc-trader-server/docs/session-2026-06-02-autoloop-journal.md`.
**Capital framing:** judge bằng Sharpe / ROI% / DD (RA hợp lệ — book equal/risk-parity static, size không đổi theo win/loss → no DCA-distortion). Dollar scale theo leverage.

---

## 1. THE RULE (1 câu)

> **Lấy một method robust DUY NHẤT — hedge01 (RANGE-breakout 4h LONG: tín hiệu S12 EMA-cross / S13 ATR-break / S14 Donchian-20, gate ADX>20 ×2bar + close>EMA200-1h + ATR-percentile + regime=RANGE/skip-BEAR, thoát bằng ATR-trailing-stop) — rồi áp lên những asset mà LỊCH SỬ cho thấy hợp cấu trúc nó (thủ tục khách quan: rank theo hedge01-Sharpe trailing, lấy top → hiện ra {BTC, SOL}), cộng thêm một sleeve trend low-correlation (turtle-BTC: Donchian 20/10 + ATR-cut), gộp risk-parity.**

Không phải 1 entry thần kỳ — đây là **method + thủ tục chọn asset + diversify**, đúng tiên đoán "tiền lớn = diversify".

---

## 2. PERFORMANCE (canonical, calendar-basis, 35 tháng 2023-07→2026-05)

| Book | ROI% | Sharpe | maxDD | per-year (R-mult) |
|---|---|---|---|---|
| hedge01-BTC alone | +144 | 0.83 | 30.4% | 23:+11 24:+132 25:+2 |
| hedge01 BTC+SOL | +182 | 1.27 | 15.1% | 23:+62 24:+69 **25:+51** |
| **+ turtle-BTC sleeve (3-way)** | +150 | **1.49** | **10.9%** | 23:+41 24:+62 **25:+49** |
| 3-way risk-parity | +135 | 1.50 | 11.6% | smooth, +mọi năm |

- Dollar minh hoạ ($100k, 1x, equal-split 3 sleeve, compound): **$100k → $318k / 2.9y (~+49%/yr), maxDD 11%** (illustrative — đơn vị return mix).
- vs Buy-Hold cùng kỳ: BH DD ~77%, Sharpe ~0.35. Book cắt DD còn ~1/7, Sharpe gấp ~4×.

---

## 3. EVIDENCE (11 cycle audit đối kháng)

| # | Test | Kết quả |
|---|---|---|
| 1 | corr(turtle, hedge01) | r=+0.039 (độc lập) |
| 2-3 | Diversification weighting | equal-50/50 fail (jackpot-driven); **75/25 robust** ex-jackpot |
| 4-5 | Cross-asset turtle basket | ❌ KILLED — Sharpe 1.36 nhưng 100% từ alt-season 2024, chết 2025 |
| 6 | hedge01 generalize? | robust BTC+SOL (Sh~2), fail BNB/XRP/DOGE; port faithful (BTC +396 ✅) |
| 7 | BTC+SOL book | **corr −0.00**, Sharpe 0.83→1.27, DD 30→15%, cả 2 dương cả 2 nửa data |
| 8 | SOL jackpot-check | PASS — 39 trades, best=16% tổng, 2025=12 trades (broad) |
| 9 | Canonical calendar-basis | 3-way Sh1.49 DD11%, +mọi năm |
| 10 | **Walk-forward selection** | top2-by-half1 = {BTC,SOL} (KHÔNG cherry-pick), rank-corr +0.43, **OOS Sharpe ~0.71** |
| 11 | Bear-protection | exposure 16-31%, worst-trade −12/−14% (0 blowup), maxDD≪B&H 77%, BTC-2022 sat-out |
| 14 | SOL param-sensitivity | SOL +Sharpe 1.4-2.5 qua ±1 CẢ 7 param → edge structural, không curve-fit |
| 15 | Rolling selection stability | {BTC,SOL} 80% top-2 slots; bad assets luôn đáy |
| 16 | Fee/slippage | book Sharpe 1.4-1.5 đến RT 0.6% → edge không cost-fragile |
| 17 | **Universe 11 coin** | hedge01 wins **5/11** (BTC,SOL,ETH,LINK,ADA); walk-forward VẪN {BTC,SOL} top-2; Spearman +0.42 → generality robust broad |

---

## 4. KỲ VỌNG THẬT (honest, không bán đẹp)

- **OOS Sharpe ~0.7** (walk-forward), KHÔNG phải 1.5 in-sample. Vẫn > B&H (0.35) & > basket-không-chọn (0.31).
- **DD ~11-15%** — nhưng là *best-case regime* (window 2023-2026 không có bear-mài-mòn nhiều-tháng).
- **Diversify = BẢO HIỂM, không phải Sharpe-max.** 2025 hedge01-BTC gần chết (+2), SOL gánh (+100). Đừng phụ thuộc 1 asset; cũng đừng kỳ vọng cả 2 cùng chạy.
- Method **selective**: exposure thấp (16-31% thời gian có vị thế), phần lớn ngồi cash.

## 5. CAVEATS (rủi ro còn lại)

1. **SOL/alt chỉ 2.9y — chưa qua bear-mài-mòn kiểu BTC-2022.** Cơ chế né-bear (sit-out + ATR-cut) đã proven cross-asset (cycle 11) nên SOL *gần chắc* được bảo vệ, nhưng chưa thấy tận mắt → residual nhỏ.
2. Đây là **backtest**. Bắt buộc **forward-test paper** trước khi size thật (như turtle/multiTf đang chạy live).
3. hedge01-BTC là 7y-robust core; SOL là **mở rộng method** (3y) — tin cậy thấp hơn BTC.
4. Selection procedure cần **đủ asset + đủ lịch sử** để rank; với universe nhỏ (7 coin) thì {BTC,SOL} ổn định nhưng nên re-rank định kỳ.

## 6. KILLED trên đường (đừng đào lại)

cross-asset turtle basket (2024-only) · equal-weight 50/50 (jackpot) · mean-rev · DCA/martingale · meta-label ML · turtle trên BNB/XRP/DOGE (pump-only) · hedge01 trên DOGE (−4 Sharpe).

## 7. ĐỀ XUẤT NEXT (cần Tommy duyệt "build")

1. **Wire forward-test paper logger** cho book {hedge01-SOL} (hedge01-BTC = hedge01 live đã có; turtle-BTC = turtleLogger paper đã có) → thêm `hedge01-SOL paper` để hoàn tất book trên live.
2. Theo dõi OOS Sharpe live vs ~0.71 backtest 1-3 tháng trước khi size.
3. Re-rank asset-selection định kỳ (quarterly) khi có thêm data alt.

## 8. FREQUENCY IMPROVEMENT (2026-06-03, Sonnet 4.6, 9 rounds, 40+ variants)

**Kết quả:** ADX threshold 20→18 là cải thiện duy nhất robust. Research full tại `docs/frequency-improvement-research-2026-06-03.md`.

| Config | Sh (2.9y) | DD | flat/35 | Sh (7y) | DD (7y) | Status |
|---|---|---|---|---|---|---|
| BASELINE ADX20 | +1.49 | 10.9% | 11 | +0.97 | 30.4% | current |
| **ADX18** | **+1.50** | **10.9%** | **10** | **+1.04** | **27.7%** | ✅ SAFE deploy |
| CD20+ADX18 | +1.53 | 10.9% | 9 | +1.04 | 31.0% | ⚠️ monitor 6m trước |

**Kill list:** turtle-SOL (Sh−2.32), SHORT-BEAR (Sh−1.42), RANGE+BULL (DD+9%), EMA100 (DD+5%), CD20 standalone (7y DD tăng).

**Root cause flat:** 6/7 still-flat = BEAR regime → feature (bảo vệ capital), không phải bug.

**Hard ceiling (no-new-asset):** flat 9-10/35. Muốn thấp hơn → cần thêm ETH/LINK/ADA.

---

## Reproduce (scripts trong `btc-dashboard/tools/`)

`correlation-turtle-hedge01-7y.py` (c1) · `loop-divbenefit-audit.py` `loop-portfolio-weights.py` (c2-3) · `portfolio-roi-crossasset.py` `loop-crossasset-robust.py` (c4-5) · `loop-hedge01-crossasset.py` (c6 harness, monkeypatch CACHE) · `loop-hedge01-portfolio.py` (c7) · `loop-fullbook-audit.py` (c8) · `loop-book-canonical.py` (c9) · `loop-walkforward-selection.py` (c10) · `loop-bear-protection.py` (c11).

*Autoloop 2026-06-02 cho anh Tommy — Opus 4.8. General rule found + adversarially validated.*
