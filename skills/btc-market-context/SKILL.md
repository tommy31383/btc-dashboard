---
name: btc-market-context
description: Phân tích cấu trúc thị trường BTC hiện tại bằng cách so sánh 14 nến 1D với 7 năm lịch sử để tìm các kịch bản tương tự, sau đó phân tích sâu đa timeframe (3D, Weekly, Monthly) và các indicator kỹ thuật. Dùng skill này khi Tommy hỏi "tình huống hiện tại giống gì trong quá khứ", "so sánh kịch bản", "market structure hiện tại", "BTC đang ở đâu trong lịch sử", hoặc bất kỳ câu hỏi phân tích thị trường BTC cần context lịch sử.
---

# BTC Market Context — Phân Tích Kịch Bản Lịch Sử

## Mục tiêu

Trả lời câu hỏi: **"Tình huống hiện tại của BTC giống kịch bản nào trong quá khứ?"**

Không dự đoán giá. Chỉ cung cấp context để ra quyết định tốt hơn.

## Quy trình

### Bước 1 — Lấy data

Chạy script `scripts/fetch_and_analyze.py` để:
- Fetch 14 nến 1D mới nhất từ Binance API (live)
- Load 7-year cache từ `$HOME/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json`
- Tính indicators trên mọi timeframe

```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/fetch_and_analyze.py
```

Script output ra `/tmp/btc_context_result.json`. Đọc file đó để lấy kết quả.

### Bước 2 — Định nghĩa structure hiện tại (14D)

Từ 14 nến 1D, xác định:

1. **Price action**: swing highs/lows, HH/HL/LH/LL pattern
2. **Momentum**: số nến đỏ/xanh liên tiếp, % drop từ 14D high
3. **Position**: close vs 14D high/low (đang ở đâu trong range)
4. **EMA200_1D**: giá đang trên hay dưới, gap bao nhiêu %

Kết luận structure hiện tại bằng 1 câu: ví dụ *"Downtrend rõ, 8 nến đỏ liên tiếp, -22% từ high, sát low"*

### Bước 3 — Tìm kịch bản tương tự trong 7 năm

Script tự động scan toàn bộ lịch sử với tiêu chí:
- Drop từ 14D high tương tự (±5%)
- Consecutive red/green streak tương tự (±2 nến)
- Vị trí trong range tương tự (close vs low/high)

Với mỗi match, thu thập:
- **Context**: xảy ra trong bull/bear, catalyst gì
- **Điều gì xảy ra ngay sau** (7 ngày)
- **Điều gì xảy ra trung hạn** (14 ngày, 30 ngày)
- **Cách kịch bản kết thúc**: V-shape, dead cat, tiếp tục dump

### Bước 4 — Phân tích đa timeframe (MTF)

Với **timeframe hiện tại** và với **mỗi kịch bản tương tự**, so sánh:

| Timeframe | Metrics cần xem |
|-----------|----------------|
| **3D** | Trend (HH/HL vs LH/LL), position vs EMA50_3D |
| **Weekly** | Nến weekly hiện tại xanh/đỏ, %chg week, EMA20W |
| **Monthly** | Monthly bar, position vs range tháng trước |

Mục đích: xác định xem các timeframe lớn hơn **confirm** hay **mâu thuẫn** với structure 1D.

### Bước 5 — Indicators bổ sung

Tính thêm để làm rõ kịch bản:

- **RSI_1D**: oversold (<30) hay chưa? So sánh RSI hiện tại vs RSI tại đáy của các kịch bản tương tự
- **ATR_1D**: volatility đang tăng hay giảm? (panic = ATR tăng mạnh)
- **Volume**: volume nến gần nhất so với average 20D (selling climax?)
- **EMA200_4H**: champion engine cần BTC > EMA200_4H để unlock — gap hiện tại bao nhiêu, lịch sử mất bao lâu để recover

### Bước 6 — Tổng hợp và so sánh

Output cuối gồm 3 phần:

#### A. Structure hiện tại
```
14D: [ngày bắt đầu → hôm nay]
Pattern: [LH+LL / HH+HL / mixed]
Drop: -X% từ $Y (high ngày Z)
Streak: N nến đỏ liên tiếp
RSI_1D: X (oversold / neutral / overbought)
ATR đang: tăng/giảm
Weekly: xanh/đỏ, X% tuần này
```

#### B. Top 3-5 kịch bản tương tự (ranked by similarity)
Với mỗi kịch bản:
```
📅 YYYY-MM-DD [Event name]
   Similarity: X/5 tiêu chí khớp
   Context: [bull/bear market, catalyst]
   Structure lúc đó: [giống gì]
   Sau 7D: +X% | Sau 14D: +X% | Sau 30D: +X%
   Kết thúc như thế nào: [V-shape / dead cat / dump tiếp]
   MTF lúc đó: Weekly [xanh/đỏ], RSI [X]
```

#### C. Nhận xét tổng hợp
- Kịch bản nào giống nhất và tại sao
- Điểm khác biệt quan trọng giữa hiện tại và quá khứ
- Điều gì cần xảy ra để xác nhận từng kịch bản (price action tiếp theo)
- **Implication cho engines**: hedge01 / champion / stochBreak sẽ phản ứng thế nào trong từng kịch bản

## Nguyên tắc

- **Không dự đoán** — chỉ mô tả xác suất dựa trên lịch sử
- **Judge by structure** — không quan trọng giá tuyệt đối, chỉ quan trọng pattern
- **Honest về uncertainty** — nếu chỉ có 2-3 precedent thì nói rõ sample nhỏ
- **Implication cho engines** luôn được đề cập — đây là mục đích cuối cùng

## Tạo report HTML

```bash
python3 $HOME/.claude/skills/btc-market-context/scripts/generate_report.py
```

Tự động: fetch data → vẽ chart → build HTML → mở browser.
Output: `/tmp/btc_context_report.html`

## Lưu ý kỹ thuật

- 7y cache data: `$HOME/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json` (5m bars, Jan 2019 → May 2026)
- Live data: Binance API `GET /api/v3/klines?symbol=BTCUSDT&interval=1d&limit=N`
- Script path: `$HOME/.claude/skills/btc-market-context/scripts/fetch_and_analyze.py`
