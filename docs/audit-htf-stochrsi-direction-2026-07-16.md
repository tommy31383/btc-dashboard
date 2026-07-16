# BTC HTF StochRSI Direction Audit

Date: 2026-07-16
Scope: BTCUSDT, completed 1W and 2W bars, direction after the signal close.

## Method

- Source: Binance Futures BTCUSDT 1H cache, 66,002 rows, through 2026-07-15.
- SHA256: `226f4ebcaac46817e34e2d11b038845fade357f5d4a7448ba782a58f23902d85`.
- Evaluator: `tools/audit-htf-stochrsi-direction.ts`.
- Indicator: project-standard RSI14 -> StochRSI14 -> K SMA3 -> D SMA3.
- Only completed higher-timeframe bars are used. Returns are close-to-close after the signal bar; no lookahead.
- Sample: 392 completed 1W bars (2019-01-07 to 2026-07-06), 195 completed 2W bars (2019-01-14 to 2026-06-22).

## Results

| Signal | Horizon | N | P(price up) | Mean return | Median return |
|---|---:|---:|---:|---:|---:|
| 1W K rising | 1W | 169 | 52.7% | +1.4% | +0.2% |
| 1W K rising | 2W | 168 | 54.2% | +2.3% | +1.6% |
| 1W K rising | 4W | 168 | 52.4% | +3.9% | +0.4% |
| 1W K rising | 8W | 168 | 51.8% | +7.8% | +0.5% |
| 2W K rising | 2W | 74 | 55.4% | +2.7% | +1.9% |
| 2W K rising | 4W | 74 | 52.7% | +4.9% | +0.7% |
| 2W K rising | 8W | 73 | 58.9% | +9.9% | +4.9% |
| 2W K rising | 16W | 69 | 59.4% | +25.0% | +6.8% |
| 2W bullish cross | 4W | 18 | 66.7% | +12.7% | +7.6% |
| 2W cross from K<20 | 4W | 11 | 72.7% | +8.7% | +7.7% |
| 1W + 2W K rising | 8W | 59 | 57.6% | +9.3% | +3.5% |

## Interpretation

The user's observation is directionally valid, especially on 2W. The strongest tested condition is not simply `K rising`; it is a 2W bullish K/D cross after low momentum. The sample is small for cross signals, so this is a research edge, not an accepted live rule.

The 1W result is weak and unstable. At the 8W horizon, `K rising` was positive in 2020, 2021, 2023, and 2024, but negative in 2019, 2022, and 2026. The 2W result is also regime-dependent: 2021, 2022, 2025, and the partial 2026 sample did not support a blind Long.

The important rejection is `1W K<20 and rising`: it produced only 39.1% up after one week and 42.2% after four weeks. A low oscillator that is merely rising is not enough; the market can remain in a falling macro structure. The safer interpretation is:

1. 2W supplies the directional bias.
2. A bullish K/D cross is better than a raw positive slope.
3. 1D or 4H supplies the entry timing.
4. The macro state must remain below the overbought exit zone; do not enter just because K is high and rising.

## Decision

`RESEARCH_ONLY`: do not change live Champion/H05 yet. The next valid test is a causal BTC-only strategy with 2W macro filter, 1D K<10 recovery entry, 4H/1H execution, one position per campaign, fees/slippage, walk-forward split, and comparison against the current Champion. The existing macro-cycle report already shows that repeated daily additions are harmful; the next test must avoid that DCA behavior.

## Exact one-entry replay

Using the existing 7-year macro-cycle replay dataset and its historical funding series, the first 1D K<10 entry per campaign was tested with one 0.001 BTC Long, next available daily open fill, and exit at the macro overbought condition:

- 4 campaigns total; 3 closed and 1 open.
- Closed campaign win rate: 2/3 (66.7%).
- Total marked net PnL: `-$36.65`.
- Maximum drawdown: `-$69.92`.
- Closed campaign PnL: `-$28.26`, `+$0.73`, `+$39.95`.
- Open campaign marked PnL: `-$49.07`.

This confirms the user's concern: a visually attractive win rate is not enough. The first campaign lost `-$28.26`, while the open campaign is currently down `-$49.07`; the positive campaigns do not compensate. The rule is therefore not accepted for live deployment.

## Early-entry and structure-exit sweep

The same campaigns were replayed with one entry per campaign and the first available daily open. The key comparison was entering at the macro arm instead of waiting for daily K<10:

| Entry | Exit | Campaigns | Closed WR | Marked net PnL | Max DD |
|---|---|---:|---:|---:|---:|
| Macro arm | Both 1W/2W overbought | 4 | 66.7% | -$10.18 | -$69.92 |
| Macro arm | 2W K/D bearish cross | 4 | 75.0% | +$17.58 | -$28.97 |
| Macro arm | 1W K/D bearish cross | 4 | 75.0% | +$18.95 | -$12.70 |
| Daily K<20 | Both 1W/2W overbought | 4 | 66.7% | -$34.58 | -$69.92 |
| Daily K<20 | 1W K/D bearish cross | 4 | 50.0% | -$5.45 | -$15.56 |

This supports the diagnosis that the late daily entry is harmful. The current research lead is `MACRO_ARM + WEEK_CROSS_DOWN`: enter at the macro arm and invalidate on the first completed 1W bearish K/D cross. It removes the large 2021 loss and closes the 2025 campaign before the marked drawdown in the cached sample. However, `N=4` is too small for acceptance; the result can still be dominated by one campaign and needs broader event sampling and walk-forward validation.

## Expanded event and 4H checks

To reduce the four-campaign limitation, an independent event sweep tested 2W bullish crosses from low StochRSI values. With 1W slope confirmation and 1W bearish-cross exits, there were 9 events, 55.6% wins, `+$37.73` marked net PnL, and `+$7.78` after removing the best event. The result was still negative in parts of 2022 and 2026, so it is not stable enough for acceptance.

A 4H entry test (`4H K<20 reclaim` and `4H oversold -> break previous high`) produced 4/4 entries, 3/4 wins, `+$17.52` and `+$16.46` respectively, with the same 1W bearish-cross exit. These results are close to entering at macro arm; the lower-timeframe entry did not create a material improvement. This indicates that the main improvement is **early invalidation/exit**, not a more complicated entry trigger.

A weekly price-location filter was also tested. Rejecting macro arms more than 5% above weekly EMA20 left only two entries and `+$6.22`; it removed the current campaign as well as the 2021 campaign. The filter reduces exposure but is not accepted as an edge because the sample is too small and it discards a profitable campaign in the replay.

An event-level structure filter was then tested: accept a 2W low-area bullish cross only when the aligned weekly close is above EMA20 and weekly EMA20 is rising. It produced 3 events, 3 wins, `+$42.68`, `+$12.73` without the best event, and `-$13.82` max drawdown. It excluded the 2022 and partial-2026 losses but also excluded a profitable 2023 event. Status: `RESEARCH_LEAD`, not accepted; the sample is only three events and this filter must pass a later walk-forward sample before any live consideration.

The oversold threshold sweep did not reveal a robust optimization: K<20 and K<30 produced the same events; K<10 removed a profitable 2023 event and reduced the result. This supports keeping the conventional K<20 threshold for research and avoiding parameter fitting.

## Extended spot validation

The event logic was replayed on the available BTC spot 1H cache from 2017-08-17 through 2026-07-11. This is a structural validation only: it is spot data and has no reliable funding series before the futures funding cache begins, so it is not a substitute for the futures money-path replay.

- Unfiltered 2W low-area cross + 1W rising + 1W bearish exit: 13 events, 53.8% wins, `+$38.21`, `+$8.38` without the best event, max drawdown `-$29.43`.
- Add weekly close above EMA20 and rising EMA20: 5 events, 5/5 wins, `+$44.02`, `+$14.19` without the best event, max drawdown `-$13.80`.

The five-event filter survives the longer history better than the four-event futures-only sample, but five trades remain statistically small. It is a candidate for a dedicated walk-forward futures replay, not a live authorization.

On the same five filtered spot events, the exit comparison favored the faster weekly invalidation: weekly bearish cross produced 5/5 wins, `+$44.02`, max drawdown `-$13.80`; 2W bearish cross produced 4/5 wins, `+$35.77`, max drawdown `-$27.66`.

The anticipatory version was also tested: enter on a 2W K slope turn-up after the low area, with the same weekly trend filter and weekly bearish exit. It produced 5 events, 4/5 wins, `+$19.64`, `+$7.05` without the best event, and `-$15.37` max drawdown. This is earlier but weaker than waiting for the completed 2W K/D cross; it is the more relevant candidate when entry latency is the primary concern.

Finally, 4H timing was applied only after the filtered 2W event using UTC-aligned 4H buckets. Immediate ARM entry returned `+$44.02`; waiting for the first 4H oversold reclaim returned `+$45.94` with max drawdown improving to `-$11.90`; waiting for a 4H break of the previous high returned `+$42.30` and introduced a loss. The 4H reclaim is the preferred timing variant for further futures walk-forward testing, not an accepted live rule.

On the exact futures 7-year cache, the same UTC-aligned 4H timing comparison had only three filtered campaigns: ARM `+$42.68`, 4H reclaim `+$44.46` with `-$11.94` max drawdown, and 4H break `+$41.18`. Removing the best campaign left `+$12.63` for the reclaim variant.

## Current research lead

```text
SETUP:
  2W StochRSI K/D bullish cross
  at least one of the prior two completed 2W K values < 20
  aligned 1W K is rising
  aligned weekly close > weekly EMA20
  weekly EMA20 is rising

ENTRY:
  next available open after the completed 2W signal
  optional 4H reclaim is a timing variant, not a separate bias

EXIT / INVALIDATION:
  first completed 1W bearish K/D cross
  no waiting for both 1W and 2W K>=80
  one position per event; no repeated daily DCA in this test
```

Status: `RESEARCH_LEAD_ONLY`. It is an early-entry momentum-continuation rule, not a bottom-fishing rule. It intentionally does not satisfy the user's earlier desire to force a trade every day; forcing daily entries would change the tested expectancy and is not justified by this evidence.

At the latest completed futures cache bar (`2026-07-11T17:00:00Z`), the candidate is inactive: 1W K=17.8 below D=20.3, 2W K=30.1 below D=44.5, and weekly close 63,617 below weekly EMA20 71,918. The correct action for this research lead is no Long signal.

## Expanded entry lane

The hard EMA20 filter was removed to avoid suppressing all opportunities. The relaxed lane is:

```text
2W K slope-turn up after the low area
1W K rising
4H K<20 reclaim
exit on the first 1W bearish K/D cross
```

On the futures 7-year cache it produced 8 events, 62.5% wins, `+$24.61`, `+$11.55` without the best event, and `-$15.45` max drawdown. On the extended spot cache it produced 12 events, 58.3% wins, `+$27.19`, `+$14.16` without the best event, and `-$15.86` max drawdown. This lane improves opportunity count and is the preferred candidate for the next walk-forward test. It remains `RESEARCH_ONLY` because eight futures events are still insufficient for live authorization.

## High-opportunity 4H lane

An entry-only audit scanned all UTC-aligned 4H bars instead of macro campaigns. The broad condition `4H K turn-up after K<20` with only a soft `1D K rising` context produced 284 futures signals:

- After 3 x 4H bars: 54.2% positive, mean `+0.18%`.
- After 12 x 4H bars: 53.5% positive, mean `+0.36%`.

This keeps many more opportunities than the hard EMA20 lane. The numbers are close-to-close forward-return statistics with overlapping observations, not deployable PnL; the next required test is a full trade replay with fees, fill rules, stops, exits, and position overlap.

The first full 4H trade replay used next 4H open fills, 0.04% fees per side, 0.02% adverse slippage per side, 1.5 ATR stop, 3 ATR target, 1W-style 4H bearish-cross exit, and one position at a time:

- `K_TURN + 1D rising`: 515 trades, 37.7% wins, PF 1.12, net `+0.333R`, max drawdown `0.247R`.
- `K_RECLAIM + 1D rising`: 439 trades, 36.9% wins, PF 1.08, net `+0.163R`, max drawdown `0.316R`.
- `K_TURN` without HTF context gate: 942 trades, 40.7% wins, PF 1.29, net `+1.466R`, max drawdown `0.251R`.

This is the first evidence that a high-opportunity lane can remain positive without filtering away most entries. It is still a research replay, not live approval; the result needs year-by-year stability, exact spot validation, and a production-equivalent exit implementation.

Reproduce:

```bash
cd /Users/lap16116/BTC_PC/btc-dashboard
STOCHRSI_SOURCE=/tmp/binance-futures-btcusdt-1h-current-20260715.json \
  npx tsx tools/audit-htf-stochrsi-direction.ts
```

## Expanded 4H replay: execution sensitivity

The entry lane was replayed with the same signals and fees while changing only the ATR exit geometry. This is a sensitivity check, not parameter optimization. Futures is the primary money-path dataset; spot is a longer structural check.

| Exit geometry | Dataset | Lane | Trades | Win rate | PF | Net R | Max DD R |
|---|---|---|---:|---:|---:|---:|---:|
| 1.0 ATR / 2.0 ATR / 18 bars | Futures 7Y | K_TURN_ANY | 979 | 38.3% | 1.47 | +1.564 | 0.119 |
| 1.0 ATR / 2.0 ATR / 18 bars | Spot 2017-2026 | K_TURN_ANY | 1,277 | 38.8% | 1.53 | +2.403 | 0.188 |
| 1.5 ATR / 3.0 ATR / 30 bars | Futures 7Y | K_TURN_ANY | 942 | 40.7% | 1.29 | +1.466 | 0.251 |
| 1.5 ATR / 3.0 ATR / 30 bars | Spot 2017-2026 | K_TURN_ANY | 1,227 | 39.9% | 1.21 | +1.578 | 0.300 |
| 2.0 ATR / 4.0 ATR / 30 bars | Futures 7Y | K_TURN_ANY | 920 | 40.9% | 1.16 | +1.000 | 0.604 |
| 2.0 ATR / 4.0 ATR / 30 bars | Spot 2017-2026 | K_TURN_ANY | 1,199 | 40.0% | 1.13 | +1.158 | 0.678 |

The 1.0/2.0 ATR geometry had the best observed PF and lower drawdown in both datasets, while the wider 2.0/4.0 geometry materially worsened drawdown and reduced PF. This does not authorize changing live exits: the replay uses a simplified 4H bearish-cross exit and must still be checked against production fill/order behavior and walk-forward splits.

The expanded lane is therefore split into two research candidates:

- **Opportunity candidate:** `K_TURN_ANY` on 4H, with no hard 1D/1W trend gate. It supplies roughly 1,000 non-overlapping entries over the futures sample and remains positive across the tested exit geometries, but it has negative years in the 1.5/3.0 replay (2019, 2022, 2026).
- **Quality candidate:** `EMA20_RECLAIM`, which produces fewer entries and a higher baseline win rate, but its edge is less stable under the wider stop/target geometry and is not consistently better than the broad lane.

Decision: keep the broad lane research-only and continue with regime/walk-forward analysis. Do not deploy it or force daily entries from these results.

## Current-cache sanity replay

As a separate freshness check, the same replay was run on `/tmp/binance-futures-btcusdt-1h-current-20260715.json`, ending at `2026-07-15T14:00:00Z`. The broad `K_TURN_ANY` lane returned 1,038 trades, 39.8% wins, PF 1.30, net `+1.680R`, max drawdown `0.300R`; `EMA20_RECLAIM` returned 597 trades, 40.7% wins, PF 1.18, net `+0.549R`, max drawdown `0.265R`. This confirms the broad lane is not dependent on the exact 7-year file boundary, but it is still a historical replay and not a current live signal.

## Anticipatory entry: buy the first oversold push

The confirmation trigger was separated from the entry trigger. `K_FIRST_OVERSOLD` enters at the next 4H open after the first completed 4H StochRSI K<20 in a new oversold episode; it does not wait for K to rise or for a K/D bullish cross. A second entry is not created until K exits the oversold zone and later re-enters it. The replay keeps the same one-position rule, 0.04% fee per side, 0.02% adverse slippage per side, and completed-bar data.

| Exit geometry | Dataset | Lane | Trades | Win rate | PF | Net R | Max DD R |
|---|---|---|---:|---:|---:|---:|---:|
| 1.5 ATR / 3.0 ATR / 30 bars | Futures 7Y | K_FIRST_OVERSOLD | 630 | 47.1% | 1.58 | +1.611 | 0.169 |
| 1.0 ATR / 2.0 ATR / 18 bars | Futures 7Y | K_FIRST_OVERSOLD | 632 | 47.5% | 2.04 | +1.662 | 0.075 |
| 2.0 ATR / 4.0 ATR / 30 bars | Futures 7Y | K_FIRST_OVERSOLD | 628 | 46.0% | 1.44 | +1.659 | 0.329 |
| 1.5 ATR / 3.0 ATR / 30 bars | Spot 2017-2026 | K_FIRST_OVERSOLD | 809 | 44.7% | 1.39 | +1.697 | 0.440 |

This is materially closer to the requested behavior than `K_TURN_ANY`: it enters before the oscillator recovery, and the edge remains positive across both narrower and wider exits on futures. It is not proof that every dip should be bought: 2019, 2022 and 2026 still contain negative years in some exit geometries, and the spot drawdown is higher. The next validation is walk-forward plus an explicit position-size/DCA ladder, not deployment of the raw first-oversold trigger.

Reproduce the full-trade replay reported above:

```bash
cd /Users/lap16116/BTC_PC/btc-dashboard
npx tsx tools/backtest-4h-entry-lane-7y.ts
STOCHRSI_HOURLY=.cache/binance-spot-btcusdt-1h-full.json \
  npx tsx tools/backtest-4h-entry-lane-7y.ts
```

## Focused Claude audit

A focused read-only Claude review was run against the replay script and this report after the relay-wide packet timed out. Claude found:

- **PASS:** UTC 4H aggregation, completed-bar handling, next-bar-open entry, and daily context lookup show no lookahead.
- **PASS with INFO:** `K_FIRST_OVERSOLD` re-arms after K>=20 and prevents a second trade in the same oversold episode during normal replay. The raw signal state can re-arm during the six-bar cooldown if K briefly crosses back above 20 and below again; this needs explicit sensitivity testing.
- **MEDIUM:** SL/TP exits are settled at the triggering bar's open rather than at the stop/target price. This makes SL optimistic and TP pessimistic relative to level fills.
- **MEDIUM:** if SL/TP is hit on the entry bar, settlement uses entry open and can omit the actual intrabar price move, leaving mostly fees/slippage in the result.
- **CONCERN:** the earlier report reproduce command pointed at `audit-htf-stochrsi-direction.ts`, not this full replay script; the exact command is now recorded above.

Claude verdict: `CONDITIONAL`, not a clean PASS. The reported edge remains a research estimate until exact stop/target fills and entry-bar handling are replayed.

## Corrected exact-fill replay: prior positive edge superseded

The fill-model fix was implemented after the Claude finding. SL exits now settle at the stop level and TP exits at the target level, both with adverse exit slippage; market exits still settle at the next bar open. Entry-bar SL/TP is now priced at the actual level instead of the entry open. The focused settlement regression passes.

The corrected replay invalidates the earlier positive table for this trade model:

| Exit geometry | Dataset | Lane | Trades | Win rate | PF | Net R | Max DD R |
|---|---|---|---:|---:|---:|---:|---:|
| 1.0 ATR / 2.0 ATR / 18 bars | Futures 7Y | K_FIRST_OVERSOLD | 632 | 37.5% | 0.85 | -0.900 | 0.917 |
| 1.5 ATR / 3.0 ATR / 30 bars | Futures 7Y | K_FIRST_OVERSOLD | 630 | 40.2% | 0.81 | -1.277 | 1.300 |
| 2.0 ATR / 4.0 ATR / 30 bars | Futures 7Y | K_FIRST_OVERSOLD | 628 | 42.7% | 0.85 | -1.116 | 1.131 |
| 1.5 ATR / 3.0 ATR / 30 bars | Spot 2017-2026 | K_FIRST_OVERSOLD | 809 | 38.9% | 0.74 | -2.669 | 2.725 |

The same exact-fill correction also makes the broad `K_TURN_ANY` lane negative in the tested replay. Therefore `K_FIRST_OVERSOLD` is **REJECTED for live promotion under the current exit model**. The earlier positive numbers remain historical evidence of the fill-model bug, not strategy performance.

## Follow-up: early entry with soft 2W context and time exit

After the exact-fill rejection, the next hypothesis kept the entry early but removed the noisy 4H bearish-cross exit:

```text
ENTRY: first completed 4H K<20 in a new episode
CONTEXT: completed 2W K rising
EXIT: 2 ATR stop, 4 ATR target, or 48 x 4H time-stop
```

Exact-fill results:

| Dataset/window | Trades | Win rate | PF | Net R | Without best | Max DD R |
|---|---:|---:|---:|---:|---:|---:|
| Futures 7Y | 149 | 38.3% | 1.10 | +0.270 | +0.131 | 0.290 |
| Futures IS 2020-2023 | 75 | 38.7% | 1.04 | +0.064 | -0.055 | 0.276 |
| Futures OOS 2024-2026 | 74 | 37.8% | 1.16 | +0.206 | +0.068 | 0.290 |
| Spot 2017-2026 | 208 | 40.4% | 1.29 | +1.059 | +0.897 | 0.328 |

This is the first early-entry variant that remains slightly positive after exact fills on both datasets, but it is not robust enough: futures IS is nearly flat, the OOS result is regime-dependent, and 2026 is negative. It remains `RESEARCH_LEAD_CONDITIONAL`, not a live candidate. K10 plus 2W rising failed on futures (PF 0.95, net `-0.130R`) under the same exit.

## Post-fix gap-fill recheck

The exact-fill correction was extended to gap-through exits. For a long, an SL hit on a bar that opens below the stop is filled at the bar open; a TP hit on a bar that opens above the target is also filled at the bar open. Non-gap hits use the configured level, and market/time exits still use the next bar open. The behavior is centralized in `backtest-4h-entry-lane-7y-fill.ts` and covered by the settlement regression.

The main early-entry sweep was rerun after this correction with `TIME` exit, 2 ATR stop, 4 ATR target, and 48 4H bars:

| Dataset | Lane | Trades | Win rate | PF | Net R | Without best | Max DD R |
|---|---|---:|---:|---:|---:|---:|---:|
| Futures 7Y | K10 | 381 | 38.1% | 1.15 | +1.168 | +0.940 | 0.992 |
| Futures 7Y | K20_2W_RISING | 149 | 38.3% | 1.10 | +0.270 | +0.131 | 0.290 |
| Futures 7Y | K20_ATR_HIGH | 207 | 38.6% | 1.10 | +0.505 | +0.341 | 0.596 |
| Spot 2017-2026 | K10 | 501 | 37.9% | 1.08 | +1.033 | +0.697 | 1.181 |
| Spot 2017-2026 | K20_2W_RISING | 208 | 40.4% | 1.29 | +1.059 | +0.897 | 0.328 |
| Spot 2017-2026 | K20_ATR_HIGH | 279 | 38.7% | 1.08 | +0.655 | +0.310 | 0.656 |

The broad K10 result is positive in aggregate but has negative 2019, 2022, 2025 and 2026 futures years; the 2W-context lane is positive in aggregate but its IS 2020-2023 is only `+0.064R` and OOS 2024-2026 is `+0.206R`, with 2026 negative. These are research leads, not evidence for live promotion.

Reproduce the primary result:

```bash
cd /Users/lap16116/BTC_PC/btc-dashboard
STOCHRSI_EXIT_MODE=TIME STOCHRSI_STOP_ATR=2 STOCHRSI_TARGET_ATR=4 STOCHRSI_MAX_HOLD=48 \
  npx --yes tsx@4.23.1 tools/backtest-4h-early-entry-sweep-7y.ts
```

The focused Claude audit packet covers this post-fix code path and is recorded in the next section. The decision remains `RESEARCH_ONLY`; no live rule, server code, or deployment has changed.

## Focused Claude audit: post-fix replay

Claude independently reviewed the corrected helper, early-entry sweep, regression test, and report. Verdict: `CONDITIONAL` for research and `REJECT` for live promotion.

### Code findings

- `triggeredExitPrice` correctly handles normal and gap-through SL/TP fills, with adverse slippage applied by `settleLong`.
- 4H aggregation, completed-bar handling, next-open entry, ATR timing, and 1D/1W/2W context lookup show no lookahead.
- `blockedUntil` enforces one position at a time.
- Same-bar SL-before-TP priority is conservative but should remain documented as a backtest assumption.
- A low-probability, unquantified rapid re-arm is possible after an entry-bar SL if the oscillator exits and re-enters oversold within a few bars. This is a research sensitivity item, not a live authorization.

### Performance decision

Claude agrees that the `K20_2W_RISING`, `TIME`, 2/4 ATR, 48-bar result is not live-ready: futures IS is noise-level and negative without the best trade, OOS is regime-dependent, 2026 is negative, and the spot/futures performance gap needs explanation. The correct status remains `RESEARCH_ONLY`; no live rule or server code was changed.

The report's earlier full-replay command for `backtest-4h-entry-lane-7y.ts` is stale for this newer sweep. The explicit command in the post-fix section above is authoritative.

## Fresh-cache sanity check

The same corrected replay was run on `/tmp/binance-futures-btcusdt-1h-current-20260715.json`, ending at `2026-07-15T14:00:00Z`. The best early lanes were:

| Lane | Trades | Win rate | PF | Net R | Without best | Max DD R |
|---|---:|---:|---:|---:|---:|---:|
| K10_1D_RISING | 218 | 40.8% | 1.31 | +1.325 | +1.115 | 0.396 |
| K20_2W_RISING | 173 | 39.9% | 1.25 | +0.743 | +0.595 | 0.328 |
| K20_ATR_HIGH | 231 | 38.5% | 1.12 | +0.643 | +0.455 | 0.585 |

This freshness check improves the aggregate picture but does not change the decision: K10_1D_RISING is negative in 2022 and 2025, while K20_2W_RISING is negative in 2021 and 2026. The cache also ends before the current date, so it is evidence of replay stability at a recent file boundary, not a current live signal.

## Rapid-rearm sensitivity

To quantify Claude's medium concern about a new signal shortly after an entry-bar SL, the sweep now accepts an optional `STOCHRSI_MIN_SIGNAL_GAP` in 4H bars. The default is `0`, preserving the original replay; the gate only consumes a new oversold episode when it falls inside the configured gap. This is a sensitivity control, not a production rule.

With the primary `TIME`, 2/4 ATR, 48-bar exit:

| Dataset | Lane | Min gap | Trades | PF | Net R | Without best | Max DD R |
|---|---|---:|---:|---:|---:|---:|---:|
| Futures 7Y | K20_2W_RISING | 0 | 149 | 1.10 | +0.270 | +0.131 | 0.290 |
| Futures 7Y | K20_2W_RISING | 2 | 149 | 1.10 | +0.270 | +0.131 | 0.290 |
| Futures 7Y | K20_2W_RISING | 6 | 147 | 1.12 | +0.324 | +0.186 | 0.287 |
| Spot 2017-2026 | K20_2W_RISING | 0 | 208 | 1.29 | +1.059 | +0.897 | 0.328 |
| Spot 2017-2026 | K20_2W_RISING | 6 | 205 | 1.29 | +1.049 | +0.887 | 0.309 |

The result does not support treating rapid re-arm as the source of the observed edge. The small futures improvement is not mirrored by spot and the yearly regime instability remains. Keep the default gap at `0` for faithful baseline comparison; do not promote `minGap=6` as an optimized live parameter.

Reproduce the sensitivity rows explicitly:

```bash
cd /Users/lap16116/BTC_PC/btc-dashboard
for gap in 0 2 6; do
  STOCHRSI_MIN_SIGNAL_GAP=$gap STOCHRSI_EXIT_MODE=TIME \
    STOCHRSI_STOP_ATR=2 STOCHRSI_TARGET_ATR=4 STOCHRSI_MAX_HOLD=48 \
    npx --yes tsx@4.23.1 tools/backtest-4h-early-entry-sweep-7y.ts
done

for gap in 0 6; do
  STOCHRSI_HOURLY=.cache/binance-spot-btcusdt-1h-full.json \
    STOCHRSI_MIN_SIGNAL_GAP=$gap STOCHRSI_EXIT_MODE=TIME \
    STOCHRSI_STOP_ATR=2 STOCHRSI_TARGET_ATR=4 STOCHRSI_MAX_HOLD=48 \
    npx --yes tsx@4.23.1 tools/backtest-4h-early-entry-sweep-7y.ts
done
```

## Focused Claude audit: rapid-rearm sensitivity

Claude reviewed the sensitivity helper, test, replay integration, and reported rows. The gate semantics and default `minGap=0` fidelity passed. A blocked signal intentionally consumes that oversold episode, so no retry occurs until K exits and re-enters the zone; this is now documented as a sensitivity assumption. Claude found the 0/2/6 rows reproducible from the code but rated methodology `CONDITIONAL` because the commands were previously missing and the effect is too small to explain the edge.

Claude's live verdict remains `REJECT` for both `K20_2W_RISING` and `K10_1D_RISING`: neither has sufficient per-mode walk-forward evidence, both have negative years, and the futures/spot difference is unresolved.

The missing `K10_1D_RISING` futures split was then run:

| Lane | Window | Trades | PF | Net R | Without best | Max DD R |
|---|---|---:|---:|---:|---:|---:|
| K10_1D_RISING | IS 2020-2023 | 107 | 1.40 | +0.900 | +0.687 | 0.417 |
| K10_1D_RISING | OOS 2024-2026 | 80 | 1.16 | +0.211 | +0.086 | 0.344 |

This makes the candidate more interesting than `K20_2W_RISING`, but it still has a small and regime-sensitive OOS sample, with 2025 negative. It remains `RESEARCH_ONLY`, not a live entry rule.

### Cross-asset split for K10_1D_RISING

To answer Claude's cross-asset gap, the same exact-fill replay was run on the longer spot cache using the comparable split (`2019-2023` IS and `2024-2026` OOS):

| Dataset/window | Trades | PF | Net R | Without best | Max DD R |
|---|---:|---:|---:|---:|---:|
| Spot IS 2019-2023 | 139 | 1.40 | +1.163 | +0.953 | 0.396 |
| Spot OOS 2024-2026 | 80 | 1.16 | +0.208 | +0.084 | 0.335 |

The futures and spot OOS numbers are close, which is useful structural confirmation, but both OOS windows contain only the same recent regime and 2025 is negative. This strengthens the candidate as a research lead, not as live authorization.

### K10_1D_RISING exit-geometry sensitivity

The early candidate was also tested without changing its entry or context, using three fixed `TIME` exit geometries:

| Geometry | Dataset | Trades | PF | Net R | Without best | Max DD R |
|---|---|---:|---:|---:|---:|---:|
| 1 / 2 ATR, 18 bars | Futures 7Y | 231 | 1.19 | +0.494 | +0.349 | 0.242 |
| 1.5 / 3 ATR, 24 bars | Futures 7Y | 221 | 1.20 | +0.654 | +0.436 | 0.493 |
| 2 / 4 ATR, 48 bars | Futures 7Y | 193 | 1.27 | +1.021 | +0.808 | 0.417 |
| 1 / 2 ATR, 18 bars | Spot 2017-2026 | 299 | 1.14 | +0.507 | +0.362 | 0.449 |
| 1.5 / 3 ATR, 24 bars | Spot 2017-2026 | 287 | 1.30 | +1.359 | +1.141 | 0.360 |
| 2 / 4 ATR, 48 bars | Spot 2017-2026 | 253 | 1.35 | +1.855 | +1.645 | 0.396 |

The sign is stable across all six exact-fill replays and the best-trade concentration is moderate. However, this is still not live authorization: 2022 is negative in every geometry, recent OOS is short, and no production-order replay or risk-sizing validation has been performed.

## Final heartbeat and completion evidence

The scheduled research runner completed at `2026-07-16 22:00:06 +07` after 52 heartbeat iterations. It ran the configured futures/spot exact-fill sweeps, the 1.5/3 ATR stress lane, the 2020-2023 IS and 2024-2026 OOS split, and the current-cache sanity lane. The process exited normally; no live server, order, arming, or deployment command was executed.

Final decision: `RESEARCH_ONLY`. `K10_1D_RISING` is the strongest early-entry research lead, but Claude's bounded audits reject live promotion because the recent OOS is regime-limited, negative years remain, and production-order/risk-sizing validation is still absent. `K20_2W_RISING` remains weaker and near noise-level on futures IS.
