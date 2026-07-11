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
- Funding SHA-256: 7dcbb7ee3cfcae728e93a303b02083514fd2d1fe9e2f92b2841b6575d485b23b
- Evaluator: stochrsi-macro-cycle/v1 at b71274114bca1c83ca50e30c8b68d1d7bd820f6a; dirty=false
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
| MACRO_ONCE | TRADABLE_REPLAY | 3/1/0 | 4 | 66.6667% | 66.6667% | 2.7666 | 0.1538 | 0.0769 | -7.0925 | -4.5566 | 69.9241 | -35.9571 | 28.4426 | 0.001 | 125.986 |
| DAILY_EPISODE | TRADABLE_REPLAY | 3/1/0 | 49 | 66.6667% | 48% | -736.6939 | 1.7572 | 0.8785 | -51.254 | -790.5836 | 1067.3416 | -869.1423 | 947.7373 | 0.024 | 1649.708 |
| DAILY_EVERY_BAR | TRADABLE_REPLAY | 3/1/0 | 143 | 66.6667% | 40% | -2205.3228 | 4.8307 | 2.4151 | -127.8584 | -2340.4269 | 2966.9536 | -2265.9787 | 2785.6774 | 0.068 | 4448.658 |
| WINDOW_FULL_AT_ARM | SIMULATED_NOT_TRADABLE | 3/1/1 | 3 | 66.6667% | 66.6667% | -108.2933 | 0.8892 | 0.4446 | -13.6502 | -123.2773 | 967.599 | -510.3588 | 511.7961 | 0.018 | 1236.8673 |

## MACRO_ONCE

Returns: expectancy 9.8407 USDT; average 19.3953%; median 36.5647%. Average/median legs per campaign: 1/1.
Timing: average hold 6837.5h; average underwater 3869h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 55764.8032; improvement vs MACRO_ONCE 0%.
Entry (closed campaigns only, exposure-matched): weighted average 43114.4912; improvement vs MACRO_ONCE 0%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 1 legs; net 40.4948 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 1 legs; net -20.8984 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T14:00:00.000Z; 1 legs; net -34.0786 USDT

### Monthly entries and realized PnL

| Month | Entries | Realized PnL USDT |
|---|---:|---:|
| 2021-08 | 1 | 0 |
| 2023-02 | 0 | -20.8984 |
| 2023-10 | 1 | 0 |
| 2023-11 | 0 | 9.9256 |
| 2024-08 | 1 | 0 |
| 2024-12 | 0 | 40.4948 |
| 2025-04 | 1 | 0 |

### Fixed-wallet feasibility

| Wallet USDT | ROI | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---:|---:|
| 100 | -4.5566% | false | 0 | 71.5674 |
| 250 | -1.8227% | false | 0 | 221.5674 |
| 500 | -0.9113% | false | 0 | 471.5674 |
| 1000 | -0.4557% | false | 0 | 971.5674 |

### Concentration

Best one/three campaign PnL: 40.4948 / 29.522 USDT; shares: 137.1685% / 100%.
Net without best one/three: -10.9729 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 1 | -20.8984 | 0% |
| 2023 onward | 2 | 2 | 50.4204 | 100% |

## DAILY_EPISODE

Returns: expectancy -11.6785 USDT; average 5.1306%; median 1.9868%. Average/median legs per campaign: 12.25/12.
Timing: average hold 6195.5h; average underwater 4535.25h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 68078.7853; improvement vs MACRO_ONCE 2.3194%.
Entry (closed campaigns only, exposure-matched): weighted average 43220.472; improvement vs MACRO_ONCE 7.3232%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 6 legs; net 197.4065 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 18 legs; net -233.169 USDT
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
| 2023-02 | 1 | -233.169 |
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

| Wallet USDT | ROI | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---:|---:|
| 100 | -790.5836% | true | 1 | -847.7273 |
| 250 | -316.2335% | true | 1 | -697.7273 |
| 500 | -158.1167% | true | 1 | -447.7273 |
| 1000 | -79.0584% | false | 0 | 52.2727 |

### Concentration

Best one/three campaign PnL: 197.4065 / -35.0355 USDT; shares: null% / null%.
Net without best one/three: -232.442 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 18 | -233.169 | 0% |
| 2023 onward | 2 | 7 | 198.1334 | 100% |

## DAILY_EVERY_BAR

Returns: expectancy -135.9282 USDT; average 6.6305%; median 1.9868%. Average/median legs per campaign: 35.75/37.
Timing: average hold 6195.5h; average underwater 4530h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 65213.0016; improvement vs MACRO_ONCE 5.1387%.
Entry (closed campaigns only, exposure-matched): weighted average 41758.6102; improvement vs MACRO_ONCE 9.4292%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 13 legs; net 465.0263 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 61 legs; net -873.5378 USDT
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
| 2023-02 | 1 | -873.5378 |
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

| Wallet USDT | ROI | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---:|---:|
| 100 | -2340.4269% | true | 1 | -2685.6674 |
| 250 | -936.1708% | true | 1 | -2535.6674 |
| 500 | -468.0854% | true | 1 | -2285.6674 |
| 1000 | -234.0427% | true | 1 | -1785.6674 |

### Concentration

Best one/three campaign PnL: 465.0263 / -407.7846 USDT; shares: null% / null%.
Net without best one/three: -872.8109 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 61 | -873.5378 | 0% |
| 2023 onward | 2 | 14 | 465.7532 | 100% |

## WINDOW_FULL_AT_ARM - SIMULATED_NOT_TRADABLE

Returns: expectancy -41.0924 USDT; average 19.3953%; median 36.5647%. Average/median legs per campaign: 0.75/1.
Timing: average hold 4200h; average underwater 2426.25h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 46635.6925; improvement vs MACRO_ONCE 0%.
Entry (closed campaigns only, exposure-matched): weighted average 46635.6925; improvement vs MACRO_ONCE 0%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 1 legs; net 242.969 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 1 legs; net -376.172 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T14:00:00.000Z; 0 legs; net 0 USDT

### Monthly entries and realized PnL

| Month | Entries | Realized PnL USDT |
|---|---:|---:|
| 2021-08 | 1 | 0 |
| 2023-02 | 0 | -376.172 |
| 2023-10 | 1 | 0 |
| 2023-11 | 0 | 9.9256 |
| 2024-08 | 1 | 0 |
| 2024-12 | 0 | 242.969 |

### Fixed-wallet feasibility

| Wallet USDT | ROI | Liquidated | Liquidations | Minimum buffer |
|---:|---:|---|---:|---:|
| 100 | -123.2773% | true | 1 | -411.7861 |
| 250 | -49.3109% | true | 1 | -261.7861 |
| 500 | -24.6555% | true | 1 | -11.7861 |
| 1000 | -12.3277% | false | 0 | 488.2139 |

### Concentration

Best one/three campaign PnL: 242.969 / -123.2773 USDT; shares: null% / null%.
Net without best one/three: -366.2464 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 1 | -376.172 | 0% |
| 2023 onward | 2 | 2 | 252.8946 | 100% |
