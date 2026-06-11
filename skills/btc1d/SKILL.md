---
name: btc1d
description: Phân tích market context BTC khung NGÀY (1D) — so sánh 14 nến 1D hiện tại với 7 năm lịch sử, tìm kịch bản tương tự, RSI/StochRSI/BB, chart nến, report HTML. Dùng khi Tommy hỏi về tình huống thị trường BTC khung ngày, so sánh lịch sử, market structure 1D.
---

# BTC Market Context — Khung 1D

Chạy script phân tích với timeframe **1D**:

```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/fetch_and_analyze.py --tf 1d
```

Output: `/tmp/btc_context_result_1d.json` · Chart: `/tmp/btc_context_chart_1d.png`

Để tạo HTML report:
```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/generate_report.py --tf 1d
```

**Config 1D:**
- Window so sánh: 14 nến (= 14 ngày)
- Context hiển thị: 45 nến (= 45 ngày)
- Forecast: +1D, +3D, +7D, +14D, +30D
- Dedup: kịch bản cách nhau < 14 ngày → giữ 1

Xem full skill logic tại `$HOME/.claude/skills/btc-market-context/SKILL.md`
