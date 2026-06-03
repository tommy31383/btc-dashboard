# PHƯƠNG PHÁP ĐÁNH GENERAL — Framework (validated 2026-06-02)

> Kim chỉ nam thiết kế rule. Distilled từ toàn bộ rigorous work (hedge01 / forced-daily / turtle + cross-asset).
> **Core thesis:** edge bền vững = **TREND-FOLLOWING + ATR-CUT risk-management, regime-gated, diversified, judge bằng Sharpe.** KHÔNG phải tìm điểm-vào ma thuật; alpha = CẮT đúng + theo trend + đa dạng hoá.

---

## 6 NGUYÊN TẮC (data-validated, không võ đoán)

### 1. DIRECTION = follow TREND (đa-TF)
- Vote: **1d-trend (close vs EMA50) + ADX/DI 4h (strength) + momentum TF nhỏ**. **ADX/DI là KING.**
- **Mean-reversion THUA** trong frame general/forced (adverse-excursion: trend-loser chỉ 22% gỡ @−1×ATR → không bounce). Mean-rev chỉ sống ở context HẸP (hedge04 1h trong 4h-RANGE).
- Cross-asset: trend-direction generalize (alpha 4/7 asset cùng config).

### 2. REGIME-GATE hướng
- Regime (1d: BEAR nếu <MA200; BULL nếu >MA50&MA50>MA200&trending; else RANGE) quyết long/short/skip.
- **hedge01:** RANGE-only LONG (BULL whipsaw, BEAR né). **turtle:** skip-BEAR (long-only). **forced-daily:** all-regime drift.
- Skip-BEAR / né regime sai = **giảm MaxDD mạnh** (turtle skip-BEAR: MaxDD $109→$66).

### 3. RISK = CẮT chặt ATR (nguồn ALPHA)
- Cut loser ở **~1.5–2.2×ATR**. Trend-loser KHÔNG gỡ → cắt nhanh, **TUYỆT ĐỐI KHÔNG DCA/rescue/hold** (adverse-profile: −1=22% gỡ, −2=12%, −3=8%).
- **CẮT là cái biến BETA→ALPHA:** turtle breakout TRƠN = beta (Sharpe 0.37≈B&H); +ATR-cut = ALPHA (Sharpe 0.63 robust cut1-4). Khớp "cut beats rescue" + "expectancy ở ENTRY".
- Cut cố định fragile (noise theo level) trên edge mỏng → chọn theo STABILITY, không đuổi đỉnh dollar.

### 4. WINNER để chạy — ASYMMETRY
- Cut chặt + **TP rộng (~4×ATR)** HOẶC trail trên high-TF. TP-sớm HẠI (winner cần chỗ chạy: tp2.5=$14 vs tp4=$227).
- Trail HẠI ở TF thấp (4h chop whipsaw) nhưng OK ở daily (turtle Donchian-exit). → asymmetry cut2.2/TP4 robust (đường mượt).

### 5. REVERSE on confirmed flip (phụ)
- Khi cắt + vote trend flip DECISIVE ngược → đảo chiều cưỡi trend mới (reverse-v2, "đảo có đánh giá"). Marginal (+$8-30 causal, audit clean không lookahead). KHÔNG flip mù (martingale=ruin).

### 6. DIVERSIFY + judge bằng SHARPE/DOLLARS
- Nhiều instance/TF/regime uncorrelated (hedge01↔forced↔turtle corr ≤0.20) → **Sharpe danh mục lên** (1.44→1.50).
- **JUDGE = Sharpe vs Buy-Hold (alpha test, leverage-invariant) + dollars.** KHÔNG judge return-%/RA (méo bởi jackpot %-trên-giá-rẻ: turtle +363% M3/2021 = 63% return-% nhưng 23% dollar, Sharpe bất biến ex-2021).
- Diversify ASSET nữa: trend-cut alpha 4/7 coin → áp rổ, không 1 asset.

---

## INSTANCES đã validate (đều là biến thể của framework)
| Rule | TF | Direction | Regime | Cut | Winner | Sharpe/RA |
|---|---|---|---|---|---|---|
| **hedge01** (LIVE) | 4h | S12/13/14 breakout LONG | RANGE-only | ATR×4→×3 trail | trail | RA 0.515 |
| **turtle** (paper) | daily | Donchian-20 breakout LONG | skip-BEAR | ATR×1.5 | Donchian-10 exit | Sharpe 0.63 |
| **forced-daily** (paper) | 1d-decide | multi-TF vote bidir | all (forced) | ATR×2.2 +reverse | TP×4 | RA 0.056 (drift, thin) |

## ANTI-PATTERNS (đã chứng minh THUA — đừng lặp)
- Mean-rev forced / DCA / martingale / rescue loser (−$417 đến ruin).
- No-SL (survivorship). Reverse mù (không confirm).
- Judge return-%/RA khi size đổi hoặc có jackpot %-giá-rẻ.
- Over-tune 1 asset / 1 param peak (cut-noise fragile). Thêm indicator/TF khi đã đủ (parsimony thắng: 1w/obv/macd/cci đều hại).
- Meta-label chọn-lệnh trên edge mỏng (AUC OOS 0.509 = coin-flip, entry-quality không predict được).
- Tin forward-test khi logger ≠ backtest (PHẢI audit faithfulness: ADX threshold + exit intrabar).

## THIẾT KẾ INSTANCE MỚI (checklist)
1. Chọn TF + entry-trigger trend (breakout/cross/vote). 2. Regime-gate (skip regime sai). 3. ATR-cut chặt (1.5-2.2). 4. Winner asymmetry (TP rộng/trail-high-TF). 5. Backtest no-lookahead 7y (bar đã đóng + regime D-1) → judge Sharpe-vs-BH + WF + per-year stab + monthly lumpiness. 6. Cross-asset robustness. 7. Corr với rule sẵn có (additive?). 8. Paper forward-test (logger FAITHFUL) trước khi size.

## Cross-asset + ROI + DIVERSIFICATION evidence (turtle cut1.5 skip-BEAR, CÙNG config — `portfolio-roi-crossasset.py`)
- **Cross-asset Sharpe:** BTC 0.63>0.33 · XRP 0.38>0.18 · DOGE 0.31>0.00 · AVAX −0.04>−0.41 (alpha 4/7) · ETH/BNB ≈beta · SOL hại → principle holds.
- **ROI (1x lev):** BTC turtle 7y full-cycle **+38.5%/năm, DD 30%, Sharpe 1.14** (vs BH +32.8%/77%DD). Rổ 7-coin 2.5y +23%/năm DD 24% (vs BH +15%/61%DD) — ROI/DD gấp 4× BH.
- **DIVERSIFICATION PROVEN (common 2.5y):** turtle-returns avg corr **0.29 (THẤP** — vì mỗi coin in/out lúc khác, dù giá crypto corr 0.7-0.9). **Rổ curated Sharpe > best individual:** CORE-3 (BTC XRP DOGE) **Sharpe 1.36** ann+45% DD32%, ALPHA-4 (+AVAX) **1.16** ann+34% DD26% — đều > best individual (XRP 1.13) > BTC (0.84). ALL-7 = 0.95 (loser SOL/ETH/BNB kéo → phải CURATE). → khai thác general = **rổ trend-cut đa-coin uncorrelated**, risk-adjusted ROI tốt nhất.

Liên quan: `hedge05-turtle-research-2026-06-02.md`, memory [[feedback_loss_handling_cut_beats_rescue]], [[hedge05-turtle-alpha]], [[verify-on-live-faithful-harness]].
