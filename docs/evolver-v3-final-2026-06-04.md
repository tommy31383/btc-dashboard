# Evolver V3 — Final Result — 2026-06-04

Stopped at gen ~5175 after hội tụ (champion #1 held ~3000+ gen unchanged).

## Champion Final

| Metric | Value |
|---|---|
| trainCalmar | 10.62 |
| CAGR | 146.1% |
| MaxDD | 20.4% |
| min_n/yr | 387 |
| testCAGR (2024-26) | 39.4% |

## Per-year
| Year | ROI |
|---|---|
| 2019 | +310% |
| 2020 | +632% |
| 2021 | +203% |
| 2022 | +21% |
| 2023 | +190% |
| 2024 | +83% |
| 2025 | +9% |
| 2026 | +12% |

**8/8 năm dương** ✅

## Params
```json
{"adx4":18,"di4":0.9,"sl4":1.6,"tp4":12,"hold4":70,"cool4":2,"pos4":7,
 "adx1":16,"di1":1.05,"sl1":2.0,"tp1":8,"hold1":24,"cool1":1,"pos1":4,
 "adxe":18,"die":1.3,"sle":1.4,"tpe":12,"eblo":0.85,"ebhi":1.1,"bg":0.8,
 "use_btc4h":true,"use_btc1h":true,"use_eth":true,"exit_ema20":true,
 "f_funding":false,"f_rsi":false,"f_bear":true,
 "risk4":0.04,"risk1":0.04,"riske":0.04,"cap_btc":1.0,"cap_eth":1.0}
```

## Diagnosis (vì sao stop)
- Genome space cạn kiệt — mutate chỉ tune threshold trong AL.STEPS cố định
- Signal type không đổi (ADX/DI + 1h + ETH fixed)
- → Bàn giao cho V4 (MAP-Elites + primitive library)

## V4 status khi V3 dừng
- Gen 356, archive 9/27 cells, best calmar 6.09 (train-WF)
- Best promote: calmar 4.51, testCAGR 36%, primitive MultiTF_4h1h
