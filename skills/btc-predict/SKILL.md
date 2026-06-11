---
name: btc-predict
description: Dự báo BTC khung ngày — tổng hợp median OHLC từng cây nến tương lai từ 15 kịch bản lịch sử tương tự, vẽ thành "predicted candles" với Q25-Q75 band. Dùng khi Tommy hỏi "BTC sẽ đi đâu?", "dự báo giá", "predict path", "forecast candles".
---

# BTC Predict — Composite Candle Forecast

Chạy script dự báo:

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
