---
name: btc1h
description: Phân tích market context BTC khung 1H — so sánh 96 nến 1H (~4 ngày) hiện tại với 7 năm lịch sử, tìm kịch bản tương tự, RSI/StochRSI/BB, chart nến, report HTML. Dùng khi Tommy hỏi về tình huống BTC khung 1 tiếng, intraday context, timing entry/exit ngắn hạn.
---

# BTC Market Context — Khung 1H

Chạy script phân tích với timeframe **1H**:

```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/fetch_and_analyze.py --tf 1h
```

Output: `/tmp/btc_context_result_1h.json` · Chart: `/tmp/btc_context_chart_1h.png`

Để tạo HTML report:
```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/generate_report.py --tf 1h
```

**Config 1H:**
- Window so sánh: 96 nến (= ~4 ngày)
- Context hiển thị: 240 nến (= ~10 ngày)
- Forecast: +1D, +3D, +7D, +14D, +30D (tính theo bar offset)
- Dedup: kịch bản cách nhau < 96 bars → giữ 1

**Lưu ý:** khung 1H noise rất cao, matches nhiều nhưng signal thấp. Chỉ dùng để xem timing micro — KHÔNG dùng để judge kịch bản lớn. Kết hợp với btc1d để có picture đầy đủ.

Xem full skill logic tại `/Users/lap16119/.claude/skills/btc-market-context/SKILL.md`
