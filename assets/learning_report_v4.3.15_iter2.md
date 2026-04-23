# Learning Report — v4.3.15 iteration 1
Generated: 2026-04-20T02:02:03.816Z
Data: Binance BTCUSDT, 10K candles 1h + HTF 4h/1d

## Summary
| # | Side | Label | Claim WR | Fresh WR | Drift | Accuracy | N | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | LONG | LONG Widened EMA+FLAT | 0% | 78.1% | +78.1% | 0% | 32 | 🔴 DRIFT |
| 2 | LONG | Golden ATR+EMA+FLAT | 100% | 100% | +0% | 100% | 10 | 🟢 VERIFIED |
| 3 | LONG | Golden ATR+FLAT | 100% | 100% | +0% | 100% | 12 | 🟢 VERIFIED |
| 4 | LONG | LONG Trend-follow ATR+4hUP+1dRSImid | 0% | 22.3% | +22.3% | 0% | 798 | 🔴 DRIFT |
| 5 | LONG | LONG Bottom-fish EMAfar+4hDOWN+1dRSIstable | 0% | 22.4% | +22.4% | 0% | 294 | 🔴 DRIFT |

## Per-rule loss analysis

### #1 [LONG] LONG Widened EMA+FLAT
- Trades: 32 (W25 / L7 / T0)
- Avg RSI 4h at LOSS: 49.4, at WIN: 53.9
- Loss by 4h trend: {"DOWN":4,"FLAT":3}
- Win by 4h trend:  {"UP":22,"FLAT":3}
- Loss by 1d trend: {"FLAT":7}
- Suggestions:
  - ✅ WR match/beat claim, rule OK

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

### #4 [LONG] LONG Trend-follow ATR+4hUP+1dRSImid
- Trades: 798 (W178 / L252 / T368)
- Avg RSI 4h at LOSS: 56.6, at WIN: 56.6
- Loss by 4h trend: {"UP":252}
- Win by 4h trend:  {"UP":178}
- Loss by 1d trend: {"DOWN":31,"UP":209,"FLAT":12}
- Suggestions:
  - 💡 100% loss xảy ra khi 4h trend = UP → nếu khác rule intent, thêm filter loại
  - ✅ WR match/beat claim, rule OK

### #5 [LONG] LONG Bottom-fish EMAfar+4hDOWN+1dRSIstable
- Trades: 294 (W66 / L170 / T58)
- Avg RSI 4h at LOSS: 36, at WIN: 33.8
- Loss by 4h trend: {"DOWN":170}
- Win by 4h trend:  {"DOWN":66}
- Loss by 1d trend: {"DOWN":153,"UP":10,"FLAT":7}
- Suggestions:
  - 💡 100% loss xảy ra khi 4h trend = DOWN → nếu khác rule intent, thêm filter loại
  - ✅ WR match/beat claim, rule OK

## Next iteration plan
Based on suggestions above, re-inject rule v2 with HTF 1d context filter + adjusted thresholds.