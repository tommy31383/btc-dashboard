# Learning Report — v4.3.15 iteration 1
Generated: 2026-04-20T02:21:13.255Z
Data: Binance BTCUSDT, 10K candles 1h + HTF 4h/1d

## Summary
| # | Side | Label | Claim WR | Fresh WR | Drift | Accuracy | N | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | LONG | LONG Widened EMA+FLAT | 78.1% | 78.1% | +0% | 100% | 32 | 🟢 VERIFIED |
| 2 | LONG | Golden ATR+EMA+FLAT | 100% | 100% | +0% | 100% | 10 | 🟢 VERIFIED |
| 3 | LONG | Golden ATR+FLAT | 100% | 100% | +0% | 100% | 12 | 🟢 VERIFIED |
| 4 | LONG | LONG Multi-TF Score ≥70 | 39.1% | 31.9% | -7.2% | 81.6% | 448 | 🟡 PARTIAL |
| 5 | LONG | [LONG] RSI+Div TP+10% SL-5% · WR 50% · NET +840% | 50% | 0% | -50% | 0% | 0 | 🔴 DEAD |

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

### #4 [LONG] LONG Multi-TF Score ≥70
- Trades: 448 (W143 / L193 / T112)
- Avg RSI 4h at LOSS: 50.5, at WIN: 51.4
- Loss by 4h trend: {"UP":54,"FLAT":139}
- Win by 4h trend:  {"FLAT":102,"UP":41}
- Loss by 1d trend: {"FLAT":4,"UP":186,"DOWN":3}
- Suggestions:
  - 💡 72% loss xảy ra khi 4h trend = FLAT → nếu khác rule intent, thêm filter loại

### #5 [LONG] [LONG] RSI+Div TP+10% SL-5% · WR 50% · NET +840%
- Trades: 0 (W0 / L0 / T0)
- Avg RSI 4h at LOSS: —, at WIN: —
- Loss by 4h trend: {}
- Win by 4h trend:  {}
- Loss by 1d trend: {}
- Suggestions:
  - ⚠️ N=0 quá ít, relax filter hoặc lấy thêm data

## Next iteration plan
Based on suggestions above, re-inject rule v2 with HTF 1d context filter + adjusted thresholds.