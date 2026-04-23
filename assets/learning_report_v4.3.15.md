# Learning Report — v4.3.15 iteration 1
Generated: 2026-04-20T01:59:51.017Z
Data: Binance BTCUSDT, 10K candles 1h + HTF 4h/1d

## Summary
| # | Side | Label | Claim WR | Fresh WR | Drift | Accuracy | N | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | LONG | Golden MACD+EMA+FLAT | 95.2% | 37.5% | -57.7% | 39.4% | 8 | 🔴 DEAD |
| 2 | LONG | Golden ATR+EMA+FLAT | 93.1% | 100% | +6.9% | 92.6% | 10 | 🟢 VERIFIED |
| 3 | LONG | Golden ATR+FLAT | 81% | 100% | +19% | 76.5% | 12 | 🟡 PARTIAL |
| 4 | SHORT | Golden SHORT scalp EMA+ATR+UP | 86.7% | 19.9% | -66.8% | 22.9% | 282 | 🔴 DRIFT |
| 5 | SHORT | SHORT Overheated RSI+EMA+UP | 78% | 19.1% | -58.9% | 24.5% | 246 | 🔴 DRIFT |

## Per-rule loss analysis

### #1 [LONG] Golden MACD+EMA+FLAT
- Trades: 8 (W3 / L5 / T0)
- Avg RSI 4h at LOSS: 50.9, at WIN: 54.9
- Loss by 4h trend: {"DOWN":2,"FLAT":3}
- Win by 4h trend:  {"UP":3}
- Loss by 1d trend: {"FLAT":5}
- Suggestions:
  - ⚠️ N=8 quá ít, relax filter hoặc lấy thêm data

### #2 [LONG] Golden ATR+EMA+FLAT
- Trades: 10 (W10 / L0 / T0)
- Avg RSI 4h at LOSS: —, at WIN: 52.5
- Loss by 4h trend: {}
- Win by 4h trend:  {"UP":8,"FLAT":2}
- Loss by 1d trend: {}
- Suggestions:
  - ⚠️ N=10 quá ít, relax filter hoặc lấy thêm data

### #3 [LONG] Golden ATR+FLAT
- Trades: 12 (W12 / L0 / T0)
- Avg RSI 4h at LOSS: —, at WIN: 50.9
- Loss by 4h trend: {}
- Win by 4h trend:  {"UP":8,"FLAT":4}
- Loss by 1d trend: {}
- Suggestions:
  - ⚠️ N=12 quá ít, relax filter hoặc lấy thêm data

### #4 [SHORT] Golden SHORT scalp EMA+ATR+UP
- Trades: 282 (W56 / L113 / T113)
- Avg RSI 4h at LOSS: 54.5, at WIN: 49.6
- Loss by 4h trend: {"UP":98,"DOWN":2,"FLAT":13}
- Win by 4h trend:  {"FLAT":14,"DOWN":8,"UP":34}
- Loss by 1d trend: {"UP":113}
- Suggestions:
  - 💡 87% loss xảy ra khi 4h trend = UP → nếu khác rule intent, thêm filter loại

### #5 [SHORT] SHORT Overheated RSI+EMA+UP
- Trades: 246 (W47 / L168 / T31)
- Avg RSI 4h at LOSS: 75.8, at WIN: 71.4
- Loss by 4h trend: {"UP":168}
- Win by 4h trend:  {"UP":46,"FLAT":1}
- Loss by 1d trend: {"UP":168}
- Suggestions:
  - 💡 100% loss xảy ra khi 4h trend = UP → nếu khác rule intent, thêm filter loại

## Next iteration plan
Based on suggestions above, re-inject rule v2 with HTF 1d context filter + adjusted thresholds.