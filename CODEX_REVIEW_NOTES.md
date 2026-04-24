# Codex Review Notes

Date: 2026-04-23

Scope: deep review of BTC Dashboard trading/rule-alert path after v4.3.20 fixes.

Update: 2026-04-23 fix pass applied. The findings below are retained as review history; see each status line.

## Current Findings

### P1: Rule alerts do not really re-evaluate every 60s

Status: Fixed. `useRuleAlerts` now throttles by last-candle content fingerprint instead of open time only, so live close/high/low/volume changes re-trigger evaluation while push notifications still dedupe by candle open time.

`App.tsx` says tracked rules re-evaluate on every klines update, and `useBinanceKlines` fetches every 60s. However `useRuleAlerts` skips the whole evaluation when `lastCandle.time` has not changed. Binance `/klines` returns the currently open candle as the last item, so the open time stays fixed for the whole 5m/15m/1h/4h candle while close/high/low continue changing.

Impact: if a rule becomes true mid-candle, the app will not detect it until the next candle opens. For 1h and 4h rules this can mean missing the actionable signal for a long time. If the intended behavior is live monitoring, the throttle should use a content fingerprint of the last candle or remove the per-candle skip. If the intended behavior is closed-candle-only, the app should explicitly drop the last open candle before evaluating and tell users alerts are close-confirmed.

Primary references:

- `hooks/useRuleAlerts.ts:760-773`
- `hooks/useRuleAlerts.ts:1046-1073`
- `hooks/useBinanceKlines.ts:159-167`

### P2: Indicator tables and general alerts are stale within the current candle

Status: Fixed. `useBinanceKlines` now caches `TFAnalysis` by live-candle content fingerprint instead of open time only.

`useBinanceKlines` caches `TFAnalysis` by last candle open time. Because the open time does not change while the candle is forming, `tfData` can remain stale even though the latest close/high/low/volume changed on the next REST fetch. This affects `useAlerts`, `TimeframeTable`, `LiveFeatureSnapshot`, and `OverallVerdict` because they consume `tfData`.

Impact: the price header can move live via websocket, but RSI/MACD/ATR/table/verdict can remain from the first fetch of the candle. This creates contradictory UI and stale non-rule alerts.

Primary references:

- `hooks/useBinanceKlines.ts:169-180`
- `App.tsx:140`

### P2: Notification settings are partially dead

Status: Partially fixed. `notifyMinScore` is now passed into `useRuleAlerts` and gates rule-fire push notifications. The unused exit-result toggle was removed from `SettingsPanel` because the current app no longer mounts `useLiveSignals` exit tracking.

The app passes only `settings.notifyEntrySignal` into `useRuleAlerts`. The UI still exposes `notifyExitSignal` and `notifyMinScore`, but the current app path does not call `useLiveSignals`, and `useRuleAlerts` does not accept min score or exit notification settings.

Impact: users can change "Kết quả tín hiệu" and "Score tối thiểu để báo", but rule-fire push notifications ignore those settings. This can lead to unexpected notifications and user distrust.

Primary references:

- `App.tsx:144`
- `components/SettingsPanel.tsx:124-149`
- `utils/constants.ts:40-42`
- `hooks/useLiveSignals.ts` exists but is not mounted from `App.tsx`

### P3: Disabled/delegated rules are auto-tracked and shown as ARMED

Status: Fixed. Added `isRuleMonitorable`; first-run auto-track, restored saved tracked IDs, rule list display, tracked counts, and bulk-track now exclude disabled/delegated rules.

`useTrackedRules` auto-tracks every bundled rule on first launch. `assets/hard_rules.json` contains many `disabled: true` rules and several `delegatedTo: "useRiskRadar"` rules. `ruleMatchesSmart` skips these, but the status builder maps every non-matching rule to `ARMED`, so disabled/delegated rules can look monitorable/armed instead of hidden or OFF.

Impact: tracked counts are inflated, "Chỉ hiện rule đang theo dõi" can include rules that will never fire, and users may spend time on dead rules.

Primary references:

- `hooks/useTrackedRules.ts:59-70`
- `hooks/useRuleAlerts.ts:511-515`
- `hooks/useRuleAlerts.ts:1030-1044`
- `assets/hard_rules.json`

### P3: Bulk untrack writes many async storage updates

Status: Fixed. Added `untrackMany` to persist one final tracked set instead of looping through `toggle`.

The "Tắt tất cả" button loops through rules and calls `tracked.toggle` once per rule. Each toggle schedules its own `AsyncStorage.setItem`. Those writes can resolve out of order, so the persisted tracked set can theoretically end up stale even if React state is eventually correct.

Impact: after restarting the app, some supposedly untracked rules can come back if an older async write wins the race. Prefer a single `untrackMany(ids)` or `setTrackedForTF(tfKey, ids, false)` path that computes one final set and persists once.

Primary references:

- `components/TradingRulesPanel.tsx:686-690`
- `hooks/useTrackedRules.ts:76-91`

## Follow-Up Fix Order

1. Validate on device that intrabar rule-fire banners update after a 60s refresh without waiting for the next candle.
2. Consider adding a visible "live/intrabar" label so users know signals can move before candle close.
3. If exit-result notifications are needed again, reintroduce them with a mounted signal lifecycle tracker instead of a dormant settings toggle.

## Lesson Learned

Date: 2026-04-24

Scope: GPT rule experiments and 1h feature-scan/backtest work through `2026-04-24`.

### 1h quality setups are not "oversold bounces"

The strongest 1h LONG setups found in scan/backtest were not deep-oversold reversal catches. The durable cluster was low volatility plus price already slightly above EMA50, not panic RSI or knife-catch behavior. The best pair over the 3-year retest was `ema:0.5..2% & atr:<0.3%` with `306` trades, `67.03%` win rate, and `3.05` profit factor.

### Sample-scan winners can collapse on long retest

Several combos that looked excellent in the initial scan did not hold up when expanded to the 3-year retest. In particular, many `htf:FLAT` combinations that showed `70%+` scan win rate fell back to about `48-52%` in the larger sample. Lesson: treat scan output as hypothesis generation only, not promotion-ready truth.

### The durable 1h GPT edge cluster is narrow

The combinations that survived re-test concentrated around a very specific context:

- `ATR < 0.3%`
- price `0.5%..2%` above EMA50
- optional confirmation from `RSI 55-70` or `MACD > 50`
- bearish candle retrace can improve entry quality inside the same cluster

This is a continuation/resume context, not a broad "buy every dip" rule.

### Feature-only GPT rules should be archived before they are live-ready

The current live rule engine still expects classic condition triggers such as `macdCross`, `divergence`, or reversal logic. Pure feature-filter GPT rules can be stored in `hard_rules.json`, but they should remain disabled until the runtime can fire on feature-only states reliably. For that reason, the new `GPT_HIGHWR_1H` rules were saved as archive metadata, not enabled live monitors.

### Win rate alone is not enough

This round reinforced the earlier lesson from 15m testing: high win rate can still hide a weak or fake edge, and lower win rate can still be profitable if the reward/risk structure is better. Promotion decisions should continue to use at least:

- retest sample size
- profit factor
- net expectancy / net result
- whether the setup survives a longer date range

### 3-year retest confirms a narrow 1h LONG cluster and adds a real 1h SHORT cluster

The second-stage 3-year retest on selected 1h rules confirmed that the durable LONG cluster is still the same one found earlier: low ATR with price slightly above EMA50. The cleanest surviving pair was `ema:0.5..2% & atr:<0.3%` with `306` trades, `67.03%` win rate, and `3.05` profit factor. This is the highest-confidence 1h LONG family found so far.

The 3-year retest also surfaced a real SHORT family on 1h that was not just sample noise. The strongest durable short cluster was centered around weak RSI plus moderate/low volatility, especially when HTF was down. The best retested example was `rsi:<30 & atr:0.3-0.6% & htf:DOWN` with `258` trades, `60.26%` win rate, and `2.27` profit factor, while `rsi:30-45 & macd:0..50 & atr:<0.3%` reached `74.73%` win rate over `145` trades.

### Promotion rule: 3-year retest beats sample beauty

After this pass, feature combos should not be promoted because they look extreme in a scan output. Promotion should prefer combinations that survive the 3-year retest with all of:

- sufficient trade count
- profit factor comfortably above `1.0`
- win rate that still clears the intended threshold after retest
- behavior that still makes market-structure sense, not only statistical novelty
