# BTC-only StochRSI Macro-cycle Backtest

**Verdict: INSUFFICIENT_SAMPLE**

Sample limitation: 3 completed DAILY_EPISODE campaigns; fewer than 5 completed DAILY_EPISODE campaigns forces INSUFFICIENT_SAMPLE. Historical results are evidence for this frozen hypothesis only and do not authorize live trading.

## Frozen strategy

BTCUSDT only. RSI 14, StochRSI 14, %K SMA 3, %D SMA 3, close source, 0..100 scale.
1W and 2W each must first move below 20 in %K or %D and later produce a bullish cross. The macro cycle arms only after both rebounds confirm while both %K values remain below 80.
During the armed cycle, DAILY_EPISODE buys 0.001 BTC once per distinct closed-1D %K < 10 episode at the next available daily open. It rearms after closed-1D %K >= 10.
The whole campaign exits at the next available daily open after completed 1W and 2W %K are both >= 80.
No stop loss. No partial close. No maximum-hold exit. Historical funding applies to every open leg.
Costs: 0.04% taker fee per side and 0.02% adverse slippage per side.

## Data and provenance

- Raw hourly range: 2019-09-08T17:00:00.000Z to 2026-07-11T13:00:00.000Z (59949 rows)
- All-indicator warmup completes: 2020-11-30T00:00:00.000Z
- Valid 1D / 1W / 2W: 2019-10-11T00:00:00.000Z / 2020-04-20T00:00:00.000Z / 2020-11-30T00:00:00.000Z
- Deterministic data cutoff: 2026-07-11T14:00:00.000Z
- Hourly SHA-256: e5a6d966b322d562f17ae0be680b9c9aa9194181831ba57d3129456405264334
- Funding SHA-256: d72db4af0b0c078d3510e2b9c12f339082cf5980e7d416b89c0227e5b55562d2
- Evaluator: stochrsi-macro-cycle/v2 at 0ed621249308cd60dd2fa1222ca033523178528d; dirty=false
- Listed >3h source gaps: 0

## Campaign inventory

Macro cycles: 4; completed: 3; open: 1; zero/one/multiple DAILY_EPISODE entries: 0/1/3.

| Arm | Exit | Episode entries | Every-bar entries | Status |
|---|---|---:|---:|---|
| 2021-08-09T00:00:00.000Z | 2023-02-06T00:00:00.000Z | 18 | 61 | COMPLETED |
| 2023-10-16T00:00:00.000Z | 2023-11-27T00:00:00.000Z | 1 | 1 | COMPLETED |
| 2024-08-19T00:00:00.000Z | 2024-12-09T00:00:00.000Z | 6 | 13 | COMPLETED |
| 2025-04-28T00:00:00.000Z | null | 24 | 68 | OPEN |

## Variant summary

**WINDOW_FULL_AT_ARM: SIMULATED_NOT_TRADABLE. It uses the future DAILY_EPISODE leg count and is only an exposure-normalized timing counterfactual.**

| Variant | Warning | Closed/open/zero | Legs | Campaign WR | Leg WR | Gross | Fees | Slippage | Funding | Net | Max DD | Worst unrealized | Min wallet | Max qty | Max notional |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| MACRO_ONCE | TRADABLE_REPLAY | 3/1/0 | 4 | 66.6667% | 66.6667% | 2.7666 | 0.1538 | 0.0769 | -12.6484 | -10.1126 | 69.9241 | -35.9571 | 33.6654 | 0.001 | 125.986 |
| DAILY_EPISODE | TRADABLE_REPLAY | 3/1/0 | 49 | 66.6667% | 48% | -736.6939 | 1.7572 | 0.8785 | -77.8122 | -817.1418 | 1067.3416 | -869.1423 | 974.2955 | 0.024 | 1649.708 |
| DAILY_EVERY_BAR | TRADABLE_REPLAY | 3/1/0 | 143 | 66.6667% | 37.3333% | -2205.3228 | 4.8307 | 2.4151 | -223.1774 | -2435.7459 | 3043.0343 | -2265.9787 | 2880.9964 | 0.068 | 4448.658 |
| WINDOW_FULL_AT_ARM | SIMULATED_NOT_TRADABLE | 3/1/1 | 3 | 66.6667% | 66.6667% | -108.2933 | 0.8892 | 0.4446 | -112.2542 | -221.8813 | 1008.3803 | -510.3588 | 605.8069 | 0.018 | 1236.8673 |

## MACRO_ONCE

Returns: expectancy 7.9887 USDT; average 15.1281%; median 36.2606%. Average/median legs per campaign: 1/1.
Timing: average hold 6837.5h; average underwater 4062.5h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 55764.8032; improvement vs MACRO_ONCE 0%.
Entry (closed campaigns only, exposure-matched): weighted average 43114.4912; improvement vs MACRO_ONCE 0%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 1 legs; net 40.4948 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 1 legs; net -26.3719 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T14:00:00.000Z; 1 legs; net -34.0786 USDT

### Monthly entries and realized PnL

| Month | Entries | Realized PnL USDT |
|---|---:|---:|
| 2021-08 | 1 | 0 |
| 2023-02 | 0 | -26.3719 |
| 2023-10 | 1 | 0 |
| 2023-11 | 0 | 9.843 |
| 2024-08 | 1 | 0 |
| 2024-12 | 0 | 40.4948 |
| 2025-04 | 1 | 0 |

### Fixed-wallet feasibility

| Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---|---:|---:|
| 100 | -10.1126% | SURVIVED | false | 0 | 66.3446 |
| 250 | -4.045% | SURVIVED | false | 0 | 216.3446 |
| 500 | -2.0225% | SURVIVED | false | 0 | 466.3446 |
| 1000 | -1.0113% | SURVIVED | false | 0 | 966.3446 |

### Concentration

Best one/three campaign PnL: 40.4948 / 23.966 USDT; shares: 168.9679% / 100%.
Net without best one/three: -16.5288 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 1 | -26.3719 | 0% |
| 2023 onward | 2 | 2 | 50.3379 | 100% |

## DAILY_EPISODE

Returns: expectancy -20.5312 USDT; average 3.7589%; median 1.9868%. Average/median legs per campaign: 12.25/12.
Timing: average hold 6195.5h; average underwater 4558.75h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 68078.7853; improvement vs MACRO_ONCE 2.3194%.
Entry (closed campaigns only, exposure-matched): weighted average 43220.472; improvement vs MACRO_ONCE 7.3232%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 6 legs; net 197.4065 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 18 legs; net -259.7271 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T14:00:00.000Z; 24 legs; net -755.5481 USDT

### Monthly entries and realized PnL

| Month | Entries | Realized PnL USDT |
|---|---:|---:|
| 2021-09 | 2 | 0 |
| 2021-10 | 1 | 0 |
| 2021-11 | 1 | 0 |
| 2021-12 | 2 | 0 |
| 2022-01 | 2 | 0 |
| 2022-02 | 1 | 0 |
| 2022-04 | 1 | 0 |
| 2022-05 | 1 | 0 |
| 2022-06 | 1 | 0 |
| 2022-08 | 2 | 0 |
| 2022-10 | 1 | 0 |
| 2022-11 | 1 | 0 |
| 2022-12 | 1 | 0 |
| 2023-02 | 1 | -259.7271 |
| 2023-11 | 1 | 0.7269 |
| 2024-09 | 2 | 0 |
| 2024-10 | 2 | 0 |
| 2024-11 | 2 | 0 |
| 2024-12 | 0 | 197.4065 |
| 2025-05 | 2 | 0 |
| 2025-06 | 2 | 0 |
| 2025-07 | 2 | 0 |
| 2025-08 | 2 | 0 |
| 2025-09 | 3 | 0 |
| 2025-10 | 1 | 0 |
| 2025-11 | 2 | 0 |
| 2026-01 | 2 | 0 |
| 2026-02 | 2 | 0 |
| 2026-03 | 1 | 0 |
| 2026-05 | 3 | 0 |
| 2026-06 | 2 | 0 |

### Fixed-wallet feasibility

| Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---|---:|---:|
| 100 | null | LIQUIDATED_PATH_INVALID | true | 1 | -874.2855 |
| 250 | null | LIQUIDATED_PATH_INVALID | true | 1 | -724.2855 |
| 500 | null | LIQUIDATED_PATH_INVALID | true | 1 | -474.2855 |
| 1000 | -81.7142% | SURVIVED | false | 0 | 25.7145 |

### Concentration

Best one/three campaign PnL: 197.4065 / -61.5937 USDT; shares: null / null.
Net without best one/three: -259.0002 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 18 | -259.7271 | 0% |
| 2023 onward | 2 | 7 | 198.1334 | 100% |

## DAILY_EVERY_BAR

Returns: expectancy -167.7012 USDT; average 5.2311%; median 1.9868%. Average/median legs per campaign: 35.75/37.
Timing: average hold 6195.5h; average underwater 4545.25h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 65213.0016; improvement vs MACRO_ONCE 5.1387%.
Entry (closed campaigns only, exposure-matched): weighted average 41758.6102; improvement vs MACRO_ONCE 9.4292%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 13 legs; net 465.0263 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 61 legs; net -968.8568 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T14:00:00.000Z; 68 legs; net -1932.6424 USDT

### Monthly entries and realized PnL

| Month | Entries | Realized PnL USDT |
|---|---:|---:|
| 2021-09 | 6 | 0 |
| 2021-10 | 6 | 0 |
| 2021-11 | 3 | 0 |
| 2021-12 | 3 | 0 |
| 2022-01 | 7 | 0 |
| 2022-02 | 5 | 0 |
| 2022-04 | 6 | 0 |
| 2022-05 | 7 | 0 |
| 2022-06 | 8 | 0 |
| 2022-08 | 5 | 0 |
| 2022-10 | 1 | 0 |
| 2022-11 | 1 | 0 |
| 2022-12 | 2 | 0 |
| 2023-02 | 1 | -968.8568 |
| 2023-11 | 1 | 0.7269 |
| 2024-09 | 5 | 0 |
| 2024-10 | 4 | 0 |
| 2024-11 | 4 | 0 |
| 2024-12 | 0 | 465.0263 |
| 2025-05 | 3 | 0 |
| 2025-06 | 6 | 0 |
| 2025-07 | 4 | 0 |
| 2025-08 | 7 | 0 |
| 2025-09 | 5 | 0 |
| 2025-10 | 4 | 0 |
| 2025-11 | 9 | 0 |
| 2026-01 | 5 | 0 |
| 2026-02 | 4 | 0 |
| 2026-03 | 3 | 0 |
| 2026-05 | 10 | 0 |
| 2026-06 | 8 | 0 |

### Fixed-wallet feasibility

| Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---|---:|---:|
| 100 | null | LIQUIDATED_PATH_INVALID | true | 1 | -2780.9864 |
| 250 | null | LIQUIDATED_PATH_INVALID | true | 1 | -2630.9864 |
| 500 | null | LIQUIDATED_PATH_INVALID | true | 1 | -2380.9864 |
| 1000 | null | LIQUIDATED_PATH_INVALID | true | 1 | -1880.9864 |

### Concentration

Best one/three campaign PnL: 465.0263 / -503.1035 USDT; shares: null / null.
Net without best one/three: -968.1298 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 61 | -968.8568 | 0% |
| 2023 onward | 2 | 14 | 465.7532 | 100% |

## WINDOW_FULL_AT_ARM - SIMULATED_NOT_TRADABLE

Returns: expectancy -73.9604 USDT; average 15.1281%; median 36.2606%. Average/median legs per campaign: 0.75/1.
Timing: average hold 4200h; average underwater 2619.75h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 46635.6925; improvement vs MACRO_ONCE 0%.
Entry (closed campaigns only, exposure-matched): weighted average 46635.6925; improvement vs MACRO_ONCE 0%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 1 legs; net 242.969 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 1 legs; net -474.6934 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T14:00:00.000Z; 0 legs; net 0 USDT

### Monthly entries and realized PnL

| Month | Entries | Realized PnL USDT |
|---|---:|---:|
| 2021-08 | 1 | 0 |
| 2023-02 | 0 | -474.6934 |
| 2023-10 | 1 | 0 |
| 2023-11 | 0 | 9.843 |
| 2024-08 | 1 | 0 |
| 2024-12 | 0 | 242.969 |

### Fixed-wallet feasibility

| Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---|---:|---:|
| 100 | null | LIQUIDATED_PATH_INVALID | true | 1 | -505.7969 |
| 250 | null | LIQUIDATED_PATH_INVALID | true | 1 | -355.7969 |
| 500 | null | LIQUIDATED_PATH_INVALID | true | 1 | -105.7969 |
| 1000 | -22.1881% | SURVIVED | false | 0 | 394.2031 |

### Concentration

Best one/three campaign PnL: 242.969 / -221.8813 USDT; shares: null / null.
Net without best one/three: -464.8504 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 1 | -474.6934 | 0% |
| 2023 onward | 2 | 2 | 252.8121 | 100% |
