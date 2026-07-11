# BTC StochRSI Macro Cycle - Design

**Date:** 2026-07-11  
**Status:** Approved concept, written specification awaiting final user review  
**Scope:** Offline BTC-only evaluator and seven-year backtest. No live rule, arming, deploy, dashboard UI, ETH, or SOL work.

## 1. Objective

Test one specific trading method:

1. Use closed 1W and synthetic closed 2W StochRSI to identify a large recovery cycle from oversold.
2. While that macro LONG cycle is active, add LONG only at distinct closed-1D StochRSI deep-oversold episodes.
3. Hold every leg without partial profit taking.
4. Close the whole campaign when both closed 1W and closed 2W StochRSI are overbought.

The backtest must answer whether the method improves entry price and net dollars versus entering once at macro confirmation, while exposing its drawdown, capital requirement, concentration, and monthly entry frequency.

## 2. Approaches Considered

### Chosen: stateful macro cycle plus one entry per 1D oversold episode

The evaluator records an oversold-to-rebound state independently on 1W and 2W. It starts a campaign once both timeframes have confirmed a rebound. During the campaign it consumes each distinct 1D `%K < 10` episode once. This maps directly to the requested method and avoids buying repeatedly just because one daily oscillator episode lasts several days.

### Rejected as the primary rule: buy every day while 1D `%K < 10`

This converts oscillator timing into time-based DCA. It will remain a fixed negative-control baseline so the report quantifies the effect of repeated buying, but it cannot become the selected result after seeing the data.

### Rejected: add Champion, ADX, EMA, support, ATR, or lower-timeframe filters

Those conditions answer a different hypothesis and would make attribution impossible. Version 1 tests only the 1W/2W macro cycle and 1D oversold entries.

## 3. Fixed Indicator Definition

All three timeframes use the repository's shared `calcStochRSISeries` behavior:

- RSI period: `14`, Wilder smoothing.
- Stochastic lookback over RSI: `14`.
- `%K`: SMA `3` of raw StochRSI.
- `%D`: SMA `3` of `%K`.
- Scale: `0..100`.
- Source: candle close.

Thresholds are fixed before the first run:

- Macro oversold: below `20`.
- Daily deep oversold entry: `%K < 10`.
- Macro overbought exit: `%K >= 80` on both 1W and 2W.

There is no threshold sweep and no best-cell selection.

## 4. Candle Construction And Causality

The source is BTCUSDT historical candles refreshed through the run date. The runner records source path, first and last timestamps, row count, SHA-256, evaluator git SHA, and evaluator version.

- 1D bars are UTC calendar days.
- 1W bars run Monday `00:00 UTC` through Sunday `23:59:59.999 UTC`.
- 2W bars are deterministic pairs of Monday-aligned weeks, anchored to Monday `1970-01-05 00:00 UTC`.
- Only completed bars may update indicators or state.
- The current partial 1D, 1W, or 2W candle is never used.
- A signal known at a candle close fills at the next available daily open, never at the signal close.

The long 2W StochRSI warmup is accepted. The report prints the first date on which all required indicators are valid rather than pretending the full raw-data range is tradable.

## 5. Macro State Machine

Before a campaign starts, each macro timeframe has two latches:

- `oversoldSeen`: set when a closed candle has `%K < 20` or `%D < 20`.
- `reboundConfirmed`: set when `oversoldSeen` is true and a later closed candle produces a bullish cross, defined as previous `%K <= %D` and current `%K > %D`.

Rules:

1. Evaluate 1W and 2W independently whenever a new completed candle exists for that timeframe.
2. If a timeframe reaches `%K >= 80` before the other timeframe confirms, clear that timeframe's two latches. This prevents a stale rebound from an old oscillator cycle being combined with a much later rebound.
3. Arm `MACRO_LONG` at the first causal timestamp where both timeframes have `reboundConfirmed = true` and both current `%K < 80`.
4. Once armed, do not disarm on intermediate oscillator noise.
5. Exit only when the latest completed 1W `%K >= 80` and latest completed 2W `%K >= 80`.
6. After the exit fill, clear all latches and wait for a new oversold-to-rebound cycle.

This is an objective historical proxy for the user's visual 1W/2W judgment. It does not claim to measure discretionary forecasting skill.

## 6. Daily Entry State Machine

While `MACRO_LONG` is armed:

1. A daily oversold episode starts when closed 1D `%K` changes from `>= 10` to `< 10`.
2. The episode creates one LONG intent, filled at the next daily open.
3. No more entries occur while `%K` remains below `10`.
4. The episode rearms only after a closed 1D candle has `%K >= 10`.
5. If the macro cycle arms while 1D `%K` is already below `10`, the current episode may create one entry immediately at the next daily open.
6. Exit has priority over entry when both become known at the same decision timestamp.

Every accepted episode adds one equal leg. There is no DCA based on price, no add-on-winner requirement, no stop loss, no partial close, and no maximum-hold exit in the literal hypothesis.

## 7. Execution And Accounting

The primary executable replay uses:

- Quantity: `0.001 BTC` per accepted daily episode.
- Entry: next daily open plus `0.02%` adverse slippage.
- Exit: next daily open minus `0.02%` adverse slippage.
- Taker fee: `0.04%` per side.
- Historical funding: charged or credited against every open leg at the applicable funding timestamps.
- All legs close at the same campaign exit.

The total modeled round-trip trading friction is therefore `0.12%` before funding. Costs remain fixed for all baselines.

The signal-quality report also gives equal-weight percentage results so fixed BTC quantity does not let later high-price years dominate every conclusion.

No arbitrary wallet size is used to hide solvency. The runner reports:

- Maximum simultaneous BTC quantity and notional.
- Worst campaign and account mark-to-market drawdown.
- Minimum wallet equity needed to survive the observed path under the repository's cross-margin model with maintenance rate `0.004` for the tested notional tier.
- ROI and liquidation feasibility for fixed starting wallets of `100`, `250`, `500`, and `1,000 USDT`.
- ROI and liquidation feasibility at the read-only live-wallet snapshot, clearly labeled with its timestamp and as feasibility rather than strategy evidence.

The literal method has no hard stop. A simulated liquidation is a failed campaign and a no-ruin failure, not an ignored datapoint.

## 8. Frozen Comparisons

All variants share macro windows, exit, fills, costs, and funding:

1. `MACRO_ONCE`: buy one `0.001 BTC` leg when the macro campaign arms; hold to macro exit.
2. `DAILY_EPISODE`: the requested primary method; buy one `0.001 BTC` leg per distinct 1D `%K < 10` episode.
3. `DAILY_EVERY_BAR`: buy one `0.001 BTC` leg on every closed day with `%K < 10`; negative control for repeated DCA.
4. `WINDOW_FULL_AT_ARM`: counterfactual timing benchmark. For each completed campaign, buy at macro arm the same total BTC quantity that `DAILY_EPISODE` eventually accumulated, then hold to the same exit. It uses future leg count only to normalize exposure and must be labeled `SIMULATED_NOT_TRADABLE`.

The report will not choose a variant by tuning thresholds. `DAILY_EPISODE` is the pre-registered primary hypothesis; the others explain where its result comes from.

## 9. Required Report

### Campaign results

- Number of macro cycles and completed campaigns.
- Campaigns with zero, one, or multiple entries.
- Campaign win rate, net expectancy, median return, best and worst campaign.
- Entry-to-exit hold time and time underwater.
- Open final campaign shown separately and marked to market, excluded from closed-campaign win rate.

### Leg and timing results

- Total legs and leg win rate at the common campaign exit.
- Entries by month and year.
- Average and median number of legs per campaign.
- Weighted average entry improvement or deterioration versus `MACRO_ONCE`.
- Days where 1D stayed below `10` and duplicate entries were correctly suppressed.

### Money and risk results

- Gross PnL, fees, slippage, funding, and net PnL in USDT.
- ROI for `100`, `250`, `500`, and `1,000 USDT` starting wallets and the read-only current-wallet snapshot.
- Max drawdown, worst unrealized loss, maximum notional, minimum liquidation buffer, and liquidation count.
- Per-year and per-month realized PnL and entry count.
- Result after removing the best campaign and the best three campaigns.
- Early/late stability split at `2023-01-01 00:00 UTC`. This is validation only, not parameter selection.

## 10. Components

Implementation will be isolated into:

1. A pure candle aggregation and StochRSI state evaluator with no file or network access.
2. A replay/accounting layer for fills, legs, fees, funding, equity, and liquidation.
3. A CLI runner that refreshes or loads BTC data, writes provenance, and emits JSON plus a Markdown report.
4. Focused tests for indicator parity, candle boundaries, state transitions, fill timing, episode deduplication, exit priority, and accounting.

The evaluator will import or parity-test against the repository's shared StochRSI implementation. It will not copy one of the older Python implementations whose flat-range handling differs from the TypeScript source of truth.

## 11. Failure Handling

The runner fails closed when:

- Data is missing, unsorted, duplicated, or has a gap greater than three expected source intervals that is not listed in provenance with its duration and handling.
- The requested range does not provide enough completed 2W candles for indicator warmup.
- Indicator arrays are misaligned with candle timestamps.
- A next-open fill is unavailable.
- Provenance metadata or data hash cannot be produced.
- NaN, infinite equity, impossible quantity, or negative wallet state appears outside an explicitly recorded liquidation.

No partial report may be labeled complete after one of these failures.

## 12. Acceptance Criteria

The work is complete when:

1. Pure tests prove closed-bar behavior and state-machine semantics.
2. A refreshed BTC-only seven-year replay completes reproducibly.
3. JSON and Markdown outputs include all required provenance and metrics.
4. The primary method and all frozen baselines run through the same execution/accounting path.
5. Grok adversarially reviews the implementation and raw report.
6. No live server file, runtime flag, secret, position, or deployment is changed.

An attractive backtest result does not authorize live arming. Live implementation would require a separate design, faithful server evaluator, account-ownership review, tests, and explicit user approval.
