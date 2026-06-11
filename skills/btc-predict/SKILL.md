---
name: btc-predict
description: Phân phối kết quả lịch sử BTC khung ngày — tổng hợp median OHLC từng cây nến tương lai từ 15 cửa sổ lịch sử giống hình dạng, vẽ kèm Q25-Q75 band. KHÔNG phải dự báo có edge (đã falsify OOS + R1). Dùng khi Tommy hỏi "lịch sử sau tình huống này thường đi đâu?", "phân phối analog". KHÔNG dùng làm tín hiệu vào lệnh.
---

# BTC Predict — Historical Analog Distribution (NOT a forecast)

> ⚠️ **KHÔNG PHẢI DỰ BÁO CÓ EDGE.** Phương pháp này (tìm cửa sổ lịch sử giống → median forward)
> đã được kiểm chứng và **KHÔNG vượt base-rate**:
> - Backtest OOS: median không beat base-rate.
> - Nghiên cứu R1 (analog-retrieval, 2026-06, pre-registered): CRPS **tệ hơn** climatology
>   (skill −0.0533, CI [−0.061, −0.045]); Spearman IC ≈ 0 (CI băng qua 0).
> - Band Q25–Q75 **hẹp giả tạo** (analog chồng lấn forward → không độc lập); analog **trộn regime**.
>
> Output chỉ là **context lịch sử qualitative**. **Context-only — KHÔNG dùng cho entry, sizing, TP/SL,
> hay bất kỳ quyết định trading nào.** Số "+30D median / endpoint" luôn phải đọc kèm Q25/Q75 + số mẫu +
> effective independent sample; không bao giờ coi là price target.

Chạy script:

```bash
python3 $HOME/.claude/skills/btc-predict/btc_predict.py
```

Output: `/tmp/btc_predict.html` (tự mở browser)

**Cách hoạt động:**
1. Load 7y cache + fetch live 1D (90 bars) từ Binance
2. Tính cấu trúc hiện tại: drop 14D, position in range
3. Quét toàn bộ lịch sử tìm kịch bản tương tự (same scoring as btc1d)
4. Dedup (kịch bản cách nhau <14 ngày → giữ 1) → top 15
5. Với mỗi kịch bản, lấy OHLC các ngày +1 đến +30, normalize về % từ close ngày match
6. Tính median O/H/L/C + Q25/Q75 cho mỗi ngày tương lai
7. Convert về absolute price từ current BTC close
8. Vẽ chart: bên trái 30 nến thực + bên phải 30 nến predicted (median + Q25-Q75 band)

**Output chart có:**
- 30 nến thực bên trái (màu sắc bình thường)
- Đường chia "TODAY"
- 30 nến predicted bên phải (màu nhạt hơn)
- Đường dotted = median close path
- Band màu vàng = Q25-Q75 range
- Nhãn +1D, +7D, +14D, +21D, +30D
- Panel RSI (thực + predicted extrapolated)

**Files:**
- Script: `$HOME/.claude/skills/btc-predict/btc_predict.py`
- Result JSON: `/tmp/btc_predict_result.json`
- Chart: `/tmp/btc_predict_chart.png`
- HTML: `/tmp/btc_predict.html`
