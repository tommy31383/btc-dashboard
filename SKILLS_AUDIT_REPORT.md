# BTC SKILLS — TECHNICAL SPEC & AUDIT REPORT

> Source-of-truth cho mảng **Context Engine** của dự án BTC. Đồng bộ với các `SKILL.md` con.
> Mục đích: cross-reference nhanh trên IDE khi review. Cập nhật 2026-06-12.

---

## TỔNG QUAN — 5 skill, 2 nhóm

| Skill | Nhóm | TF | Cửa sổ hiện tại | Output |
|---|---|---|---|---|
| `btc-market-context` | A (context) | 1D + đa-TF (3D/W/M) | 14 nến 1D | analog top-15 + indicator + chart + HTML |
| `btc1d` | A | 1D | 14 nến 1D | như trên (1D) |
| `btc4h` | A | 4H | 42 nến (~7 ngày) | như trên (4H) |
| `btc1h` | A | 1H | 96 nến (~4 ngày) | như trên (1H) |
| `btc-predict` | B (forecast) | 1D | 14 nến 1D | predicted candles +1D…+30D + band Q25–Q75 |

---

## NHÓM A — MARKET CONTEXT (4 skill, chung 1 engine)

### Mục tiêu
Trả lời: **"Tình huống hiện tại của BTC giống kịch bản nào trong quá khứ?"**
→ Cung cấp CONTEXT định tính để ra quyết định tốt hơn. **KHÔNG dự đoán giá, KHÔNG phải trade signal.**

### Script lõi
```
~/.claude/skills/btc-market-context/scripts/fetch_and_analyze.py --tf {1d|4h|1h}
~/.claude/skills/btc-market-context/scripts/generate_report.py        # report HTML
~/.claude/skills/btc-market-context/scripts/multi_tf_context.py       # 3D / Weekly / Monthly
```
4 skill (`btc-market-context`, `btc1d`, `btc4h`, `btc1h`) = cùng engine, khác `--tf` + kích thước cửa sổ.

### Phương pháp
1. Lấy cửa sổ nến hiện tại (14×1D / 42×4H / 96×1H) vs **7 năm lịch sử**.
2. Tìm **top-15 analog** (kịch bản tương tự) qua scoring rev2 (bên dưới).
3. Indicator: RSI / StochRSI / Bollinger Bands.
4. Vẽ chart nến + report HTML.

### Scoring rev2 — MAGNITUDE-ANCHORED + SHAPE (lõi cần soi)
- **Gate biên độ:** `|Δdrop| ≤ 8%` + ATR-vol ratio `0.5–2.0×` → loại analog lệch tỷ lệ.
- **Rank tinh:** shape-corr (Pearson trên 14D returns).
- **Tại sao KHÔNG dùng `shape_only` thuần:** đã thử → SAI. Vô tỷ-lệ: kéo nến +1% bị xem giống Short-Squeeze +18% → tính sai mức hoảng loạn/hưng phấn. → **revert về magnitude-anchored**.
- **Bug đã fix:** `atr14_cur` thiếu bar (ATR trên 14 bar không đủ) → None → fallback sai → `total=0`. Fix: dùng `atr_pct`.
- **Ngưỡng n (số analog):** `n > 200` = noise (sideway quá nhiều match) · `n < 150` = tốt. Soft bonus, KHÔNG hard-gate.

---

## NHÓM B — BTC-PREDICT (composite candle forecast)

### Script
```
~/.claude/skills/btc-predict/btc_predict.py
```

### Phương pháp
- Lấy **top-15 analog** (cùng engine nhóm A).
- Tổng hợp **weighted median OHLC từng cây nến tương lai** từ 15 analog.
- Vẽ "predicted candles" `+1D … +30D` kèm **band Q25–Q75** (dải bất định).
- Trigger: "dự báo", "predict path", "forecast candles".

---

## 🚩 GÓT CHÂN ACHILLES — HONEST (đừng giấu reviewer)

1. **Accuracy DỰ BÁO = NULL base-rate.** Đo bằng `match-accuracy-eval.py`: median d1..d30 ≈ **coin-flip**.
   → Skill = **CONTEXT / Scenario Analysis định tính**, KHÔNG phải tín hiệu giao dịch. **DISCLAIMER bắt buộc giữ.**
2. Khớp kết luận hệ thống: **không tồn tại entry-timing alpha** (medAlpha ≈ fee). Analog/forecast để "hiểu mình ở đâu", KHÔNG để vào lệnh.

---

## 🔬 REVIEWER FOCUS — 3 tử huyệt cần đấm thẳng

### 1. [Nhóm A] Magnitude Gate vs Over-filtering khi Volatility Compression
- Điểm đúng: revert `shape_only` (shape không kèm magnitude = nhận diện sai mức biến động).
- **Cần verify:** hàm `atr_pct` mới fix có **over-filter** khi thị trường siêu tích lũy (vol compression, sideway nghẹt thở) không? Khi ATR teo, số analog `n` có tụt dưới mức ý nghĩa thống kê (n<150 → đáng tin, nhưng nếu n quá nhỏ → mất tín hiệu)?

### 2. [Nhóm B] Look-Ahead Bias ở array-slicing
- **Cần verify:** khi lấy `weighted median OHLC` của nến tương lai từ top-15 analog, mã nguồn có vô tình **đọc trước dữ liệu tương lai** của cửa sổ hiện tại trong tập so khớp không?
- Soi kỹ chỉ số `index` trong vòng lặp slicing — **lệch 1 index = toàn bộ forecast thành lừa đảo toán học ngầm**. Đảm bảo analog chỉ dùng dữ liệu ĐẾN thời điểm cửa sổ, phần "tương lai" của analog là dữ liệu SAU cửa sổ đó trong quá khứ (hợp lệ), KHÔNG phải tương lai của hiện tại.

### 3. [Cả 2 nhóm] Báo cáo có ngụ ý "dự báo đúng" vượt base-rate không?
- Verify HTML/text output không vô tình tạo ấn tượng dự báo có độ chính xác > coin-flip. Disclaimer phải nổi bật.

---

## ĐƯỜNG DẪN ĐỂ MỞ CODE

| Mục | Path |
|---|---|
| Engine + scripts | `~/.claude/skills/btc-market-context/` |
| Predict | `~/.claude/skills/btc-predict/btc_predict.py` |
| Per-TF skills | `~/.claude/skills/btc{1d,4h,1h}/SKILL.md` |
| Bản portable (committed) | `btc-dashboard/skills/` |
| Tool đo accuracy | `match-accuracy-eval.py` |

---
*Generated 2026-06-12 · Context Engine Technical Spec · v1*
