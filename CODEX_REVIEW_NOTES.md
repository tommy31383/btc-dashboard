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
