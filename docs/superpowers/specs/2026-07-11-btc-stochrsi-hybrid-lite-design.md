# BTC StochRSI Hybrid-Lite V2 - Design

**Date:** 2026-07-11  
**Status:** Approved by delegated decision from Tommy  
**Scope:** BTC-only offline research variant and falsification report. No live rule, server change, deploy, or account access.

## 1. Objective

The original `DAILY_EPISODE` rule improves entry price but loses because long macro campaigns accumulate the most legs. The two losing campaigns contain 18 and 24 legs, while the winning campaigns contain 1 and 6. Campaign win rate is therefore not the objective.

Hybrid-Lite V2 must:

1. Execute every original distinct closed-1D `%K < 10` episode entry at the same causal next-daily-open timestamp.
2. Preserve one macro core that participates in the original 1W/2W cycle.
3. Convert later episode entries into bounded tactical inventory instead of stacking every leg until macro exit.
4. Improve total net USDT and no-ruin behavior through lifecycle changes, not through hidden entry filtering or a smaller global size multiplier.

Primary judgment remains total net USDT, closed net USDT, max drawdown, minimum wallet, fixed-wallet liquidation, and executed entry count. Campaign and leg win rates are diagnostic only.

## 2. Diagnosis

The base result has 2 winning campaigns out of 3 completed campaigns, but closed expectancy is negative:

- Completed campaign PnL: `-259.7271`, `+0.7269`, `+197.4065 USDT`.
- Closed expectancy: `-20.5312 USDT` per campaign.
- Closed legs: `18`, `1`, and `6`.
- Open campaign: `24` legs and `-755.5481 USDT` marked to market.

The dominant failure is endogenous exposure: longer failed recoveries produce more daily oversold episodes and therefore more position size. The dual-overbought exit then holds that enlarged inventory through a long adverse regime.

Equal-quantity tranche rotation is rejected as the primary fix. Closing an old leg at price `P` and reopening the same quantity at `P` preserves terminal gross PnL algebraically, `(P-E) + (X-P) = X-E`, while adding fees. A pure notional cap can improve survival but cannot by itself establish lifecycle edge.

## 3. Frozen Hybrid-Lite Rules

Signal generation remains unchanged:

- BTCUSDT only.
- Closed 1W and synthetic closed 2W StochRSI oversold-to-bullish-cross arms the macro campaign.
- Each distinct closed-1D `%K < 10` episode creates exactly one entry intent.
- All entry intents fill at the same next daily open used by the base evaluator.
- Quantity remains `0.001 BTC` per entry.

Within each macro campaign:

1. The first daily episode entry is labeled `CORE`.
2. The core remains open until the original macro exit, when both latest completed 1W and 2W `%K >= 80`.
3. Every later daily episode entry is labeled `TACTICAL`.
4. A tactical leg exits at the next daily open after a completed 1D candle has `%K >= 10`. This is the same event that rearms the daily episode state.
5. If macro exit and tactical recovery resolve to the same fill timestamp, macro exit has priority and the leg records `MACRO_OVERBOUGHT` as its exit reason.
6. Macro exit closes the core and any still-open tactical leg.
7. There is no hard stop, macro invalidation, partial split, threshold sweep, or maximum hold in V2.

The episode state guarantees that a new tactical entry cannot occur before the prior episode has rearmed at `%K >= 10`. Therefore at most one tactical leg can coexist with one core, and maximum structural quantity is `0.002 BTC`.

Across the current four campaigns, the expected classification is 4 core entries plus 45 tactical entries, preserving all 49 base entries. Across completed campaigns it is 3 core plus 22 tactical, preserving all 25 completed-campaign entries.

## 4. Required Signal Metadata

The pure signal layer must expose each episode's causal recovery timestamp without performing fills or accounting.

Each campaign keeps its existing entry arrays and adds one recovery value aligned by index with `episodeEntries`:

- Entry index `i` is the episode start fill timestamp.
- Recovery index `i` is the first later completed-1D close timestamp with `%K >= 10`, represented as its next-open fill timestamp.
- An episode that has not recovered before the data cutoff or macro exit has no recovery timestamp.
- Exit priority prevents a same-time recovery from overriding macro exit.

Offline JSON must preserve alignment explicitly. Missing recovery values are serialized as `null`, not silently removed.

## 5. Replay Semantics

Leg intents gain an optional leg-specific exit timestamp, role, and exit reason:

- `CORE`: campaign macro exit or open mark.
- `TACTICAL`: earliest causal recovery exit before macro exit; otherwise campaign macro exit or open mark.
- Existing variants retain their common campaign exit behavior.

Partial tactical exits introduce realized PnL inside an active macro campaign. Risk calculations must therefore include, at every hourly point:

1. Net PnL of legs already closed by that hour.
2. Entry fees, funding, and unrealized PnL of currently active legs.
3. Intrahour low for downside equity and maintenance.
4. Intrahour high for the causal drawdown peak.

The existing campaign-risk shortcut that only sums active legs is insufficient for partial exits and must be replaced or extended. Existing variant results must remain unchanged under the new generalized path logic.

## 6. Frozen Comparisons

The report adds these rows without selecting a winner after seeing results:

1. `MACRO_ONCE`: existing one-leg macro baseline.
2. `DAILY_EPISODE`: existing stacked primary baseline.
3. `HYBRID_LITE`: the only V2 candidate.
4. `DAILY_EPISODE_MATCHED_PEAK`: simulated, non-tradable exposure control. It executes all base episode entries with one global quantity multiplier chosen so full-history peak quantity equals Hybrid-Lite's structural `0.002 BTC` peak.
5. `DAILY_EVERY_BAR`: existing repeated-buy negative control.
6. `WINDOW_FULL_AT_ARM`: existing future-exposure timing counterfactual.

`DAILY_EPISODE_MATCHED_PEAK` must be labeled `SIMULATED_NOT_TRADABLE` because its multiplier uses the completed replay's maximum base episode count. It is evidence about size rescaling, not an executable strategy.

Hybrid attribution is reported directly from leg roles:

- Core entry count and net PnL.
- Tactical entry count, realized count, open count, gross PnL, costs, funding, and net PnL.
- Tactical exits by `DAILY_RECOVERY`, `MACRO_OVERBOUGHT`, and open mark.

No separate core-only or tactical-only candidate is eligible for selection. Their additive PnL attribution is descriptive only.

## 7. Report Denominators

Campaign and leg states must remain distinct:

- `closedCampaigns`: macro campaigns with a macro exit.
- `closedNetPnl`: PnL from completed macro campaigns only.
- `realizedLegs`: every leg with an actual exit, including tactical legs realized inside the still-open macro campaign.
- `allLegs`: every executed entry, including currently open legs.
- `closedCampaignWinRate`: completed macro campaigns only.
- `realizedLegWinRate`: every realized leg, regardless of whether its macro campaign remains open.
- `totalNetPnl`: completed campaigns plus realized and marked-to-market PnL in the open campaign.

The report schema and evaluator version must be bumped because these semantics extend the previous closed-leg denominator.

## 8. Falsification And Kill Criteria

Hybrid-Lite is killed if any condition holds:

1. It executes fewer episode entries or changes any entry timestamp relative to `DAILY_EPISODE`.
2. Peak quantity exceeds `0.002 BTC`.
3. Closed net PnL is not positive.
4. Total net PnL including the open campaign is not positive.
5. Total net PnL is less than or equal to `DAILY_EPISODE_MATCHED_PEAK`; this means the apparent improvement is no better than reducing exposure.
6. Tactical net PnL after all costs is not positive.
7. Fixed wallets of `250`, `500`, or `1,000 USDT` liquidate on the observed path.
8. Net-PnL improvement versus the matched-peak control does not have the same positive sign in at least 2 of the 3 completed campaigns.

Passing the current replay does not authorize live use. It only makes Hybrid-Lite eligible for longer-history validation.

## 9. Longer-History Validation

The entire 2019-2026 Futures sample has already influenced this design and is discovery data, not honest out-of-sample evidence. Post-2023 must not be relabeled as untouched OOS.

After the frozen Futures replay:

- Older BTC spot history may be used as a separate untouched temporal holdout for signal frequency, episode lifecycle, gross price-path PnL, and regime failure rates.
- Spot evidence must not be mixed into Futures net USDT because historical perpetual funding did not exist before the Futures period.
- No threshold or lifecycle change may be selected from the holdout and then reported on the same holdout as validation.
- Actual prospective OOS evidence requires future completed campaigns after this V2 is frozen.

## 10. Tests

Required focused tests:

1. Episode recovery aligns with the first completed-1D `%K >= 10` event after entry.
2. Macro exit beats same-time tactical recovery.
3. An unrecovered final episode remains open.
4. First campaign episode is core; all later episodes are tactical.
5. Tactical legs never overlap each other.
6. Every Hybrid entry timestamp exactly matches the base episode entry list.
7. Hybrid peak quantity never exceeds `0.002 BTC` in a multi-episode fixture.
8. Partial tactical exits contribute realized PnL to hourly campaign and account drawdown paths.
9. Funding stops at each tactical exit and is not double counted.
10. Realized tactical legs inside an open macro campaign are included in realized-leg win rate but excluded from completed-campaign win rate.
11. Existing variant outputs remain unchanged in fixed regression fixtures.
12. Matched-peak control is exposure matched and labeled simulated/non-tradable.

## 11. Acceptance Criteria

The research task is complete when:

1. The frozen implementation and focused tests pass.
2. Clean online and offline replays match except for `generatedAt`.
3. The report publishes all Hybrid attribution and matched-exposure controls.
4. Kill criteria are evaluated mechanically with no manual override.
5. Grok performs an adversarial audit of code and raw evidence.
6. An independent Claude review checks logic, accounting, causality, and report labels.
7. No live server, deployment, account state, or secret is touched.
