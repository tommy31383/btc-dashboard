---
name: btc4h
description: Phân tích market context BTC khung 4H — so sánh 42 nến 4H (~7 ngày) hiện tại với 7 năm lịch sử, tìm kịch bản tương tự, RSI/StochRSI/BB, chart nến, report HTML. Dùng khi Tommy hỏi về tình huống BTC khung 4 tiếng, swing trade context, so sánh pattern ngắn hạn.
---

# BTC Market Context — Khung 4H

Chạy script phân tích với timeframe **4H**:

```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/fetch_and_analyze.py --tf 4h
```

Output: `/tmp/btc_context_result_4h.json` · Chart: `/tmp/btc_context_chart_4h.png`

Để tạo HTML report:
```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/generate_report.py --tf 4h
```

**Config 4H:**
- Window so sánh: 42 nến (= ~7 ngày)
- Context hiển thị: 120 nến (= ~20 ngày)
- Forecast: +1D, +3D, +7D, +14D, +30D (tính theo bar offset)
- Dedup: kịch bản cách nhau < 42 bars → giữ 1

**Lưu ý:** khung 4H có nhiều matches hơn 1D nhưng noise cao hơn. Dùng để xác nhận entry, không dùng để define kịch bản lớn.

Xem full skill logic tại `$HOME/.claude/skills/btc-market-context/SKILL.md`
