# BTC Skills (Claude Code)

3 bộ skill phân tích BTC dùng trên Claude Code — sync để làm việc trên nhiều PC.

| Skill | Trigger | Mô tả |
|---|---|---|
| `btc-market-context` / `btc1d` / `btc4h` / `btc1h` | "market context", "tình huống giống gì quá khứ" | So cấu trúc nến hiện tại với 7y lịch sử → top 15 analog (magnitude-anchored + shape + RSI/StochRSI), regime split, conviction, multi-TF. Chart + HTML. |
| `btc-predict` | "dự báo", "predict path", "forecast candles" | Composite candle forecast: weighted median OHLC từ analog → predicted candles +1D..+30D + Q25-Q75 band. |

## Cài đặt trên PC mới

1. **Copy skills vào Claude:**
   ```bash
   cp -R skills/btc-market-context skills/btc-predict skills/btc1d skills/btc4h skills/btc1h ~/.claude/skills/
   ```

2. **Data cache (BẮT BUỘC — 90MB, KHÔNG nằm trong git):**
   Scripts cần file `binance-5m-7y.json` để scan lịch sử. Mặc định tìm ở:
   ```
   ~/BTC_PC/btc-dashboard/.cache/binance-5m-7y.json
   ```
   - Nếu giữ layout `~/BTC_PC/btc-dashboard/` thì để cache vào đó là chạy được ngay.
   - Hoặc set env trỏ tới file bất kỳ:
     ```bash
     export BTC_5M_CACHE=/đường/dẫn/tới/binance-5m-7y.json
     ```
   - Lấy cache: copy từ PC cũ, hoặc fetch lại từ Binance (5m klines BTCUSDT, Jan2019→nay).

3. **Python deps:** chỉ cần `python3` + `matplotlib` (cho chart):
   ```bash
   pip3 install matplotlib
   ```

## Chạy thủ công (ngoài Claude)
```bash
python3 ~/.claude/skills/btc-market-context/scripts/fetch_and_analyze.py --tf 1d
python3 ~/.claude/skills/btc-market-context/scripts/multi_tf_context.py     # đồng thuận 1d/4h/1h
python3 ~/.claude/skills/btc-predict/btc_predict.py
```

## Lưu ý
- Scripts fetch live data từ Binance public API (không cần key).
- Path đã portable: dùng `$HOME` + `os.path.expanduser` + env `BTC_5M_CACHE`.
- Skill = CONTEXT lịch sử qualitative. Median outcome KHÔNG beat base-rate (đã backtest OOS) → KHÔNG dùng làm tín hiệu vào lệnh.
