# BTC-only StochRSI Macro-cycle Backtest

**Verdict: INSUFFICIENT_SAMPLE**

Sample limitation: 3 completed DAILY_EPISODE campaigns; fewer than 5 completed DAILY_EPISODE campaigns forces INSUFFICIENT_SAMPLE. Historical results are evidence for this frozen hypothesis only and do not authorize live trading.

**Hybrid mechanical verdict: KILL**

| Kill check | Result | Actual | Requirement |
|---|---|---|---|
| ENTRY_PARITY | PASS | {"dailyEpisodeEntryCount":49,"hybridEntryCount":49,"orderedTimestampsEqual":true,"dailyEpisodeEntryTimes":[1631232000000,1632268800000,1635033600000,1637193600000,1638748800000,1639180800000,1641427200000,1642896000000,1645315200000,1649376000000,1651968000000,1655078400000,1660953600000,1661644800000,1665619200000,1668038400000,1671408000000,1675555200000,1700352000000,1725148800000,1725667200000,1727913600000,1728604800000,1730678400000,1732752000000,1748217600000,1748563200000,1749168000000,1750464000000,1753488000000,1753833600000,1755734400000,1756252800000,1756684800000,1758758400000,1759017600000,1760659200000,1762387200000,1763337600000,1768953600000,1769385600000,1769904000000,1770336000000,1774742400000,1777593600000,1779062400000,1780012800000,1780444800000,1782518400000],"hybridEntryTimes":[1631232000000,1632268800000,1635033600000,1637193600000,1638748800000,1639180800000,1641427200000,1642896000000,1645315200000,1649376000000,1651968000000,1655078400000,1660953600000,1661644800000,1665619200000,1668038400000,1671408000000,1675555200000,1700352000000,1725148800000,1725667200000,1727913600000,1728604800000,1730678400000,1732752000000,1748217600000,1748563200000,1749168000000,1750464000000,1753488000000,1753833600000,1755734400000,1756252800000,1756684800000,1758758400000,1759017600000,1760659200000,1762387200000,1763337600000,1768953600000,1769385600000,1769904000000,1770336000000,1774742400000,1777593600000,1779062400000,1780012800000,1780444800000,1782518400000]} | {"sameEntryCount":true,"sameOrderedTimestamps":true} |
| PEAK_QUANTITY | PASS | {"maxQuantityBtc":0.002} | {"maximumQuantityBtc":0.002} |
| CLOSED_NET_PNL_POSITIVE | PASS | {"closedNetPnl":17.787516303882633} | {"greaterThan":0} |
| TOTAL_NET_PNL_POSITIVE | KILL | {"totalNetPnl":-24.357551903229542} | {"greaterThan":0} |
| BEATS_MATCHED_PEAK | PASS | {"hybridTotalNetPnl":-24.357551903229542,"matchedPeakTotalNetPnl":-68.25028439829639,"improvement":43.892732495066845} | {"improvementGreaterThan":0} |
| TACTICAL_NET_PNL_POSITIVE | PASS | {"tacticalNetPnl":12.304469958062406} | {"greaterThan":0} |
| FIXED_WALLETS_SURVIVE | PASS | [{"startingWallet":250,"liquidated":false},{"startingWallet":500,"liquidated":false},{"startingWallet":1000,"liquidated":false}] | {"wallets":[250,500,1000],"liquidated":false} |
| CAMPAIGN_CONSISTENCY | PASS | {"positiveCompletedCampaigns":2,"completedCampaignsCompared":3,"campaignImprovements":[{"armTime":1628467200000,"improvement":-14.063617224685345},{"armTime":1697414400000,"improvement":0.666346285129407},{"armTime":1724025600000,"improvement":36.31759746554229}]} | {"minimumPositiveCompletedCampaigns":2} |

## Frozen strategy

BTCUSDT only. RSI 14, StochRSI 14, %K SMA 3, %D SMA 3, close source, 0..100 scale.
1W and 2W each must first move below 20 in %K or %D and later produce a bullish cross. The macro cycle arms only after both rebounds confirm while both %K values remain below 80.
During the armed cycle, DAILY_EPISODE buys 0.001 BTC once per distinct closed-1D %K < 10 episode at the next available daily open. It rearms after closed-1D %K >= 10.
The whole campaign exits at the next available daily open after completed 1W and 2W %K are both >= 80.
No stop loss and no maximum-hold exit. Each leg is fully closed; Hybrid tactical legs may exit before the macro campaign. Historical funding applies to every open leg.
Costs: 0.04% taker fee per side and 0.02% adverse slippage per side.

## Data and provenance

- Raw hourly range: 2019-09-08T17:00:00.000Z to 2026-07-11T15:00:00.000Z (59951 rows)
- All-indicator warmup completes: 2020-11-30T00:00:00.000Z
- Valid 1D / 1W / 2W: 2019-10-11T00:00:00.000Z / 2020-04-20T00:00:00.000Z / 2020-11-30T00:00:00.000Z
- Deterministic data cutoff: 2026-07-11T16:00:00.000Z
- Hourly SHA-256: 41adc7f139a9853cb36d922ee106b28a6fdcbcc91ebcadcb2c2f43f72819a8ae
- Funding SHA-256: 5dc6289ba8253c28f6506a2ad7bb3c987c7950e19be0b3567aa1dea3dd2dd08e
- Evaluator: stochrsi-macro-cycle/v4 at 4c8e1a3905c5176ed71f4a649ccc671f6cd67c79; dirty=false
- Listed >3h source gaps: 0
- Live-wallet snapshot: NOT_SUPPLIED_TO_OFFLINE_EVALUATOR (Deterministic offline replay does not access live account state.)

## Campaign inventory

Macro cycles: 4; completed: 3; open: 1; zero/one/multiple DAILY_EPISODE entries: 0/1/3.

| Arm | Exit | Episode entries | Every-bar entries | Status |
|---|---|---:|---:|---|
| 2021-08-09T00:00:00.000Z | 2023-02-06T00:00:00.000Z | 18 | 61 | COMPLETED |
| 2023-10-16T00:00:00.000Z | 2023-11-27T00:00:00.000Z | 1 | 1 | COMPLETED |
| 2024-08-19T00:00:00.000Z | 2024-12-09T00:00:00.000Z | 6 | 13 | COMPLETED |
| 2025-04-28T00:00:00.000Z | null | 24 | 68 | OPEN |

## Variant summary

**DAILY_EPISODE_MATCHED_PEAK: SIMULATED_NOT_TRADABLE. Its full-history multiplier is an exposure control, not an executable strategy.**

**WINDOW_FULL_AT_ARM: SIMULATED_NOT_TRADABLE. It uses the future DAILY_EPISODE leg count and is only an exposure-normalized timing counterfactual.**

| Variant | Warning | Closed/open/zero | Realized legs / all legs | Closed campaign WR | Realized leg WR | Total gross | Total fees | Total slippage | Total funding | Closed net | Total net | Max DD | Worst unrealized | Min wallet | Max qty | Max notional |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| MACRO_ONCE | TRADABLE_REPLAY | 3/1/0 | 3/4 | 66.6667% | 66.6667% | 2.6917 | 0.1538 | 0.0769 | -12.6511 | 23.966 | -10.1902 | 69.9241 | -35.9571 | 33.6654 | 0.001 | 125.986 |
| DAILY_EPISODE | TRADABLE_REPLAY | 3/1/0 | 25/49 | 66.6667% | 48% | -738.4915 | 1.7572 | 0.8785 | -77.8762 | -61.5937 | -819.0034 | 1067.3416 | -869.1423 | 974.2955 | 0.024 | 1649.708 |
| HYBRID_LITE | TRADABLE_REPLAY | 3/1/0 | 48/49 | 66.6667% | 60.4167% | -7.9233 | 2.6393 | 1.3197 | -12.4752 | 17.7875 | -24.3576 | 77.1755 | -57.5612 | 45.5436 | 0.002 | 238.9732 |
| DAILY_EPISODE_MATCHED_PEAK | SIMULATED_NOT_TRADABLE | 3/1/0 | 25/49 | 66.6667% | 48% | -61.541 | 0.1464 | 0.0732 | -6.4897 | -5.1328 | -68.2503 | 88.9451 | -72.4285 | 81.2005 | 0.002 | 137.4757 |
| DAILY_EVERY_BAR | TRADABLE_REPLAY | 3/1/0 | 75/143 | 66.6667% | 37.3333% | -2210.416 | 4.8307 | 2.4151 | -223.3586 | -503.1035 | -2441.0204 | 3043.0343 | -2265.9787 | 2880.9964 | 0.068 | 4448.658 |
| WINDOW_FULL_AT_ARM | SIMULATED_NOT_TRADABLE | 3/1/1 | 3/3 | 66.6667% | 66.6667% | -108.2933 | 0.8892 | 0.4446 | -112.2542 | -221.8813 | -221.8813 | 1008.3803 | -510.3588 | 605.8069 | 0.018 | 1236.8673 |

## Hybrid role attribution

| Role | Entries | Realized | Open | Gross | Fees | Slippage | Funding | Net | Daily recovery | Macro overbought | Open mark |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BASE | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| CORE | 4 | 3 | 1 | -25.1864 | 0.165 | 0.0825 | -11.2282 | -36.662 | 0 | 3 | 1 |
| TACTICAL | 45 | 45 | 0 | 17.263 | 2.4743 | 1.2372 | -1.247 | 12.3045 | 44 | 1 | 0 |
| SIMULATED | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## MACRO_ONCE

Returns (closed campaigns only): expectancy 7.9887 USDT; average 15.1281%; median 36.2606%.
Leg counts (all campaigns): average/median per campaign 1/1.
Timing: average hold 6838h; average underwater 4063h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 55764.8032; improvement vs MACRO_ONCE 0%.
Entry (closed campaigns only, exposure-matched): weighted average 43114.4912; improvement vs MACRO_ONCE 0%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 1 legs; net 40.4948 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 1 legs; net -26.3719 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T16:00:00.000Z; 1 legs; net -34.1562 USDT

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

| Scenario | Basis | Snapshot | Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---|---|---|---:|---:|---|---|---:|---:|
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 100 | -10.1902% | SURVIVED | false | 0 | 66.3446 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 250 | -4.0761% | SURVIVED | false | 0 | 216.3446 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 500 | -2.038% | SURVIVED | false | 0 | 466.3446 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 1000 | -1.019% | SURVIVED | false | 0 | 966.3446 |

### Concentration

Best one/three campaign PnL: 40.4948 / 23.966 USDT; shares: 168.9679% / 100%.
Net without best one/three: -16.5288 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 1 | -26.3719 | 0% |
| 2023 onward | 2 | 2 | 50.3379 | 100% |

## DAILY_EPISODE

Returns (closed campaigns only): expectancy -20.5312 USDT; average 3.7589%; median 1.9868%.
Leg counts (all campaigns): average/median per campaign 12.25/12.
Timing: average hold 6196h; average underwater 4559.25h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 68078.7853; improvement vs MACRO_ONCE 2.3194%.
Entry (closed campaigns only, exposure-matched): weighted average 43220.472; improvement vs MACRO_ONCE 7.3232%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 6 legs; net 197.4065 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 18 legs; net -259.7271 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T16:00:00.000Z; 24 legs; net -757.4097 USDT

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

| Scenario | Basis | Snapshot | Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---|---|---|---:|---:|---|---|---:|---:|
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 100 | null | LIQUIDATED_PATH_INVALID | true | 1 | -874.2855 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 250 | null | LIQUIDATED_PATH_INVALID | true | 1 | -724.2855 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 500 | null | LIQUIDATED_PATH_INVALID | true | 1 | -474.2855 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 1000 | -81.9003% | SURVIVED | false | 0 | 25.7145 |

### Concentration

Best one/three campaign PnL: 197.4065 / -61.5937 USDT; shares: null / null.
Net without best one/three: -259.0002 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 18 | -259.7271 | 0% |
| 2023 onward | 2 | 7 | 198.1334 | 100% |

## HYBRID_LITE

Returns (closed campaigns only): expectancy 5.9292 USDT; average 3.2316%; median 1.9868%.
Leg counts (all campaigns): average/median per campaign 12.25/12.
Timing: average hold 6196h; average underwater 4122.75h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 68078.7853; improvement vs MACRO_ONCE 2.3194%.
Entry (closed campaigns only, exposure-matched): weighted average 43220.472; improvement vs MACRO_ONCE 7.3232%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 6 legs; net 52.7681 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 18 legs; net -35.7075 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T16:00:00.000Z; 24 legs; net -42.1451 USDT

### Monthly entries and realized PnL

| Month | Entries | Realized PnL USDT |
|---|---:|---:|
| 2021-09 | 2 | 2.729 |
| 2021-10 | 1 | 0.5803 |
| 2021-11 | 1 | -0.7758 |
| 2021-12 | 2 | 3.2914 |
| 2022-01 | 2 | 0.2961 |
| 2022-02 | 1 | -1.7678 |
| 2022-04 | 1 | -2.3651 |
| 2022-05 | 1 | -5.4429 |
| 2022-06 | 1 | -6.0225 |
| 2022-08 | 2 | 0.4248 |
| 2022-10 | 1 | 0.1901 |
| 2022-11 | 1 | 1.7048 |
| 2022-12 | 1 | 0.1339 |
| 2023-02 | 1 | -28.6838 |
| 2023-11 | 1 | 0.7269 |
| 2024-09 | 2 | 3.0382 |
| 2024-10 | 2 | 3.4586 |
| 2024-11 | 2 | 6.324 |
| 2024-12 | 0 | 39.9473 |
| 2025-05 | 2 | 0 |
| 2025-06 | 2 | 4.651 |
| 2025-07 | 2 | 1.6271 |
| 2025-08 | 2 | -1.3219 |
| 2025-09 | 3 | 1.3771 |
| 2025-10 | 1 | 2.2265 |
| 2025-11 | 2 | -8.8665 |
| 2026-01 | 2 | 3.4526 |
| 2026-02 | 2 | 4.5532 |
| 2026-03 | 1 | 0 |
| 2026-04 | 0 | 1.8285 |
| 2026-05 | 3 | 0.9337 |
| 2026-06 | 2 | -3.5259 |

### Fixed-wallet feasibility

| Scenario | Basis | Snapshot | Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---|---|---|---:|---:|---|---|---:|---:|
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 100 | -24.3576% | SURVIVED | false | 0 | 54.4664 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 250 | -9.743% | SURVIVED | false | 0 | 204.4664 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 500 | -4.8715% | SURVIVED | false | 0 | 454.4664 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 1000 | -2.4358% | SURVIVED | false | 0 | 954.4664 |

### Concentration

Best one/three campaign PnL: 52.7681 / 17.7875 USDT; shares: 296.6583% / 100%.
Net without best one/three: -34.9806 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 18 | -35.7075 | 0% |
| 2023 onward | 2 | 7 | 53.4951 | 100% |

## DAILY_EPISODE_MATCHED_PEAK - SIMULATED_NOT_TRADABLE

Returns (closed campaigns only): expectancy -1.7109 USDT; average 3.7589%; median 1.9868%.
Leg counts (all campaigns): average/median per campaign 12.25/12.
Timing: average hold 6196h; average underwater 4559.25h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 68078.7853; improvement vs MACRO_ONCE 2.3194%.
Entry (closed campaigns only, exposure-matched): weighted average 43220.472; improvement vs MACRO_ONCE 7.3232%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 6 legs; net 16.4505 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 18 legs; net -21.6439 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T16:00:00.000Z; 24 legs; net -63.1175 USDT

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
| 2023-02 | 1 | -21.6439 |
| 2023-11 | 1 | 0.0606 |
| 2024-09 | 2 | 0 |
| 2024-10 | 2 | 0 |
| 2024-11 | 2 | 0 |
| 2024-12 | 0 | 16.4505 |
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

| Scenario | Basis | Snapshot | Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---|---|---|---:|---:|---|---|---:|---:|
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 100 | -68.2503% | SURVIVED | false | 0 | 18.8095 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 250 | -27.3001% | SURVIVED | false | 0 | 168.8095 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 500 | -13.6501% | SURVIVED | false | 0 | 418.8095 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 1000 | -6.825% | SURVIVED | false | 0 | 918.8095 |

### Concentration

Best one/three campaign PnL: 16.4505 / -5.1328 USDT; shares: null / null.
Net without best one/three: -21.5834 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 18 | -21.6439 | 0% |
| 2023 onward | 2 | 7 | 16.5111 | 100% |

## DAILY_EVERY_BAR

Returns (closed campaigns only): expectancy -167.7012 USDT; average 5.2311%; median 1.9868%.
Leg counts (all campaigns): average/median per campaign 35.75/37.
Timing: average hold 6196h; average underwater 4545.75h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 65213.0016; improvement vs MACRO_ONCE 5.1387%.
Entry (closed campaigns only, exposure-matched): weighted average 41758.6102; improvement vs MACRO_ONCE 9.4292%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 13 legs; net 465.0263 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 61 legs; net -968.8568 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T16:00:00.000Z; 68 legs; net -1937.9168 USDT

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

| Scenario | Basis | Snapshot | Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---|---|---|---:|---:|---|---|---:|---:|
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 100 | null | LIQUIDATED_PATH_INVALID | true | 1 | -2780.9864 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 250 | null | LIQUIDATED_PATH_INVALID | true | 1 | -2630.9864 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 500 | null | LIQUIDATED_PATH_INVALID | true | 1 | -2380.9864 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 1000 | null | LIQUIDATED_PATH_INVALID | true | 1 | -1880.9864 |

### Concentration

Best one/three campaign PnL: 465.0263 / -503.1035 USDT; shares: null / null.
Net without best one/three: -968.1298 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 61 | -968.8568 | 0% |
| 2023 onward | 2 | 14 | 465.7532 | 100% |

## WINDOW_FULL_AT_ARM - SIMULATED_NOT_TRADABLE

Returns (closed campaigns only): expectancy -73.9604 USDT; average 15.1281%; median 36.2606%.
Leg counts (all campaigns): average/median per campaign 0.75/1.
Timing: average hold 4200h; average underwater 2619.75h; suppressed duplicate daily entries 94.
Entry (all campaigns, exposure-matched): weighted average 46635.6925; improvement vs MACRO_ONCE 0%.
Entry (closed campaigns only, exposure-matched): weighted average 46635.6925; improvement vs MACRO_ONCE 0%.
Best campaign: 2024-08-19T00:00:00.000Z -> 2024-12-09T00:00:00.000Z; 1 legs; net 242.969 USDT
Worst campaign: 2021-08-09T00:00:00.000Z -> 2023-02-06T00:00:00.000Z; 1 legs; net -474.6934 USDT
Open campaign marked to market: 2025-04-28T00:00:00.000Z -> 2026-07-11T16:00:00.000Z; 0 legs; net 0 USDT

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

| Scenario | Basis | Snapshot | Wallet USDT | ROI | Outcome | Liquidated | Liquidations | Minimum buffer |
|---|---|---|---:|---:|---|---|---:|---:|
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 100 | null | LIQUIDATED_PATH_INVALID | true | 1 | -505.7969 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 250 | null | LIQUIDATED_PATH_INVALID | true | 1 | -355.7969 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 500 | null | LIQUIDATED_PATH_INVALID | true | 1 | -105.7969 |
| FIXED_WALLET | FULL_HISTORY_SCALE_TEST | null | 1000 | -22.1881% | SURVIVED | false | 0 | 394.2031 |

### Concentration

Best one/three campaign PnL: 242.969 / -221.8813 USDT; shares: null / null.
Net without best one/three: -464.8504 / 0 USDT.

### Pre-/post-2023 stability

| Period | Campaigns | Legs | Net PnL USDT | Win rate |
|---|---:|---:|---:|---:|
| Before 2023 | 1 | 1 | -474.6934 | 0% |
| 2023 onward | 2 | 2 | 252.8121 | 100% |
