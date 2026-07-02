# BTC Bear-Bottom Anatomy — findings (BTC-only, 7y daily từ binance-5m-7y.json 2019-01→2026-06-08)

## Phương pháp
- resample 5m→daily. Detect "major bottom" = local-min low trong cửa sổ ±30d VÀ drawdown ≤ −25% từ đỉnh trailing-180d.
- ⚠️ cửa sổ ±30d dùng future bars (look-ahead) — CHỈ để định nghĩa đáy hậu-nghiệm, KHÔNG phải detector real-time.
- n = 13 đáy.

## Bảng (capitD=biggest 1d drop trong [-10,0]; wick%=(close-low)/(high-low); volX=vol/avg30d; atrTrend=atr/atr[-20]; retest=quay về ≤1.05×low trong +5..45d; lowerLL=có thủng low trong +90d)
date        label             capitD wick% volX atrTrend  retest        +7d +30d +90d lowerLL
2019-12-18  2019 post-rally   -3.9%  84%  1.8x 0.67x     no            12%  39% -17%  YES
2020-03-13  COVID crash       -39.5% 83%  6.0x 1.75x     no            64%  83% 145%  no
2021-06-22  May21 China       -11.2% 82%  2.0x 0.69x     +28d +1.6%    25%  12%  49%  no
2021-09-21                    -8.9%  28%  1.8x 1.14x     +5d  +2.9%     4%  57%  18%  no
2021-12-04                    -8.9%  60%  2.6x 1.32x     +32d +1.2%    18%  11%  -7%  YES
2022-01-24                    -10.4% 81%  2.5x 1.16x     +31d +4.3%    17%  13%  20%  no
2022-06-18  LUNA/3AC capit    -15.4% 43%  2.5x 1.47x     no            22%  27%  12%  no
2022-09-21                    -9.9%  18%  1.5x 1.22x     +5d  +3.1%     7%   6%  -7%  YES
2022-11-21  FTX cycle-low     -3.1%  36%  1.0x 2.07x     +7d  +3.4%     5%   9%  57%  no
2024-08-05  JPY carry unwind  -7.1%  54%  5.9x 1.10x     no            21%  18%  40%  no
2025-04-07  2025 tariff       -6.1%  69%  3.5x 0.81x     no            14%  30%  47%  no
2025-11-21  late-2025 bear    -5.4%  66%  2.9x 1.31x     +10d +4.0%    13%  10% -17%  YES
2026-02-06  2026 bear low     -14.0% 90%  4.2x 2.19x     +18d +4.2%    15%  10%  33%  no

## Template rút ra (định tính)
- Đáy THẬT (giữ, V-recovery): wick>70% + volX≥3x + atrTrend>1.4 + retest GIỮ trên low. +90d dương lớn.
- Đáy GIẢ (lower-low trong 90d, 4/13): wick ngắn, đóng sát low, volX thấp; +90d ÂM.

## Context NOW (live 2026-06-28, ngoài cache)
- close $59,577; 14d-low $58,115 → ĐÃ THỦNG đáy Feb-06 $60k (đáy Feb giữ ~90d rồi vỡ).
- RSI 30.7, StochRSI-K 7.3 (quá bán) nhưng CHƯA có climax-volume/búa-dài/hold-retest.
- EMA200d gap −24.5%, EMA200-4h gap −8.8%. Bot champion sit-out (BTC<EMA200).
