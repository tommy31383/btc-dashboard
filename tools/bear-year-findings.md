# BTC Bear-YEAR Anatomy — deep research (BTC-only, daily từ binance-5m-7y.json 2019→2026-06-08)

## 8 bear episodes (close<EMA200d ≥20d)
span                     days  peak→trough reliefs maxRelief atr% %redDays
2019-09→10                31    -47.7%       4   25.6%  4.9% 61%
2019-11→2020-01           53    -41.2%       5   15.6%  4.5% 57%
2020-03 COVID             52    -64.0%      17   80.6%  8.9% 44%
2021-05→07                69    -55.6%      23   45.3%  8.9% 49%
2021-12→2022-03           89    -52.3%      14   19.5%  5.4% 51%
2022-04→2023-01 (marathon)285   -67.9%      36   22.7%  4.7% 54%
2025-11→2026-05           188   -52.5%      13   19.6%  3.9% 52%
2026-05-11→06-08 (now)    29    -28.6%       0    0.0%  2.9% 72%
median drawdown ~ -52%.

## Regime daily behavior (warmup 200d)
        days  meanRet medRet up%  dailyVol atr% tail5%(avg worst5%)
BULL    1567  +0.37%  +0.15% 53%  2.93%   4.3%  -5.98%
BEAR     949  -0.28%  -0.23% 45%  3.55%   5.0%  -8.85%

## Key behaviors
- EMA200 reclaim attempts 40, FAIL-back-within-10d = 26 (65%) → reclaim KHÔNG phải buy-signal đáng tin trong bear.
- Relief-rally bull-trap: rally tag EMA50 → fwd10d median -1.9%, rejected 59% (n=22). Tag EMA200 → -9.4%, rejected 100% (n=4, nhỏ).
- Damage concentration: worst-10%-days = 42-66% tổng down-moves mỗi episode → damage dồn vài ngày, không né intraday được → phải né cả regime.
- Bears lớn có NHIỀU relief (2022: 36 reliefs tới 22%; 2021: 23 tới 45%) = hút dip-buyer.
- NOW: grind-down 29d, 0 relief, ATR co 2.9% (vol thấp = CHƯA panic-flush), -21% dưới EMA200, -13.5% dưới EMA50.

## Cảnh báo tautology (Claude tự nêu)
close<EMA200 cơ học ⟹ tương quan return-âm-gần-đây. "BEAR mean -0.28%/day" có thể một phần là định-nghĩa-lại chính nó, KHÔNG phải predictive. Cần đo: regime tag tại t có dự báo return [t, t+k] (strictly future, no overlap với cửa sổ định regime) vượt base-rate không.
