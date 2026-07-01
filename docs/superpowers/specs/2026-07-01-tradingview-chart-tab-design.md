# TradingView-style chart tab (replace "5m ALL")

## Goal

Tommy wants the "5m ALL" bottom-nav tab (currently a paper-trading engine with 10
presets) replaced by a professional charting tab modeled on TradingView, while keeping
the app's own rule-signal overlay — something a plain TradingView widget embed can't do.

## Decisions (from brainstorming)

- **Charting engine:** `lightweight-charts` (TradingView's own open-source library,
  Apache-2.0 + attribution requirement), not the TradingView Advanced Chart iframe
  widget and not further hand-rolled SVG. Reasoning: fast/professional rendering while
  still letting the app feed its own Binance data and draw rule entry/TP/SL markers on
  top — the iframe widget is a black box that can't be annotated with app state.
- **Scope of the new tab:** a dedicated full-screen chart tab, replacing the small
  `BinanceChart.tsx` panel currently embedded inside the RULE tab (avoid having two
  divergent chart implementations).
- **5m ALL removal:** full removal, not just hiding the tab — the background paper
  engine (`use5mAllTrader`), its 10 presets, and the "5m ALL Engine Mode" reference on
  the LIVE tab all go away. AsyncStorage keys (`@all5m_data_v1`, `@all5m_preset_v1`)
  are left alone on-device (no migration needed) — the app just stops reading/writing
  them.
- **Drawing tools:** out of scope for v1 (no trendline/fib/etc — `lightweight-charts`
  doesn't ship these, they'd need custom primitives work).
- **Platform:** web-first. `lightweight-charts` is a DOM/canvas library; on native
  (APK/iOS) it would need `react-native-webview` (not currently a dependency). v1 shows
  a "chưa hỗ trợ trên app" fallback on native instead of crashing or shipping WebView
  integration risk in the same pass.

## Architecture

- New component: `components/TradingChartTab.tsx`.
  - On `Platform.OS === "web"`: mounts a `<div>` ref, calls `lightweight-charts`
    `createChart()` once, adds a candlestick series + volume histogram + EMA9/EMA21
    line series + Bollinger Band lines, plus separate panes for RSI / StochRSI / MACD
    (lightweight-charts v5 multi-pane).
  - On native: renders a simple "chart chưa hỗ trợ trên app, dùng bản web" message —
    no `lightweight-charts` import attempted (guard at the top so Metro doesn't even
    need to resolve the DOM-only library on native bundles).
- Data source: reuse `RawKlinesMap` from `useBinanceKlines` (already fetched app-wide,
  no new network calls). A small pure mapper converts `Kline[] → CandlestickData[]`
  (`{time, open, high, low, close}` + separate volume array).
- Indicators: reuse existing pure functions from `utils/indicators.ts`
  (`calcEMASeries`, `calcBollingerSeries`, `calcRSISeriesAligned`, `calcStochRSISeries`,
  `calcMACDSeries`) — same source of truth as the RULE tab's live evaluator, so chart
  and rule-fire numbers can't drift.
- S/R levels: `utils/supportResistance.ts` `detectSRLevels()` (already used by
  `BinanceChart.tsx`) → rendered via `chart.addPriceLine()` per series.
- Rule overlay: consume `activeAlerts` (already computed by `useRuleAlerts`, passed down
  from `App.tsx` the same way `RuleAlertBanner` receives it today) → for each active
  alert draw an entry price-line + TP price-line (green) + SL price-line (red), labeled
  with the rule id.
- Timeframe selector: same 7-key `TIMEFRAMES` control already used by `BinanceChart.tsx`
  (`selectedTF` / `onSelectTF` prop pattern preserved).

## Removal work (in the same change, since the tab slot is being repurposed)

- Delete `components/All5mPanel.tsx`, `hooks/use5mAllTrader.ts`, `utils/all5mAccount.ts`.
- `App.tsx`: remove the `all5m` tab branch, the `use5mAllTrader(...)` background mount,
  and the `BinanceChart` panel mount inside the RULE tab (superseded by the new tab).
- `components/LiveTab.tsx`: remove the `@all5m_preset_v1` read and "5m ALL Engine Mode"
  display line.
- `components/v2/BottomNavBar.tsx`: replace the `5m ALL` nav entry with the new chart
  tab's key/label/icon.
- Delete `components/BinanceChart.tsx` once the new tab covers its functionality
  (candlestick + EMA/BB/RSI/Stoch/MACD/S-R — confirmed superset in the design above).

## Error handling

- `lightweight-charts` failing to load/mount on web (e.g. blocked bundle) → wrap chart
  creation in `PanelBoundary` (existing app pattern) so it degrades to the existing
  fallback UI instead of white-screening the tab.
- Empty/short `rawKlines` for the selected TF (same edge case `BinanceChart.tsx` and
  `useRuleAlerts.ts` already handle) → show existing "đang tải..." state, do not call
  `createChart` methods with empty arrays.

## Testing / verification

- `npx tsc --noEmit` clean on the new/changed files.
- Manual verification via `expo start --web` (per project's "show browser before build"
  rule): confirm candlesticks render, indicator panes render, S/R lines render, active
  rule alerts show entry/TP/SL lines, timeframe switch reflows the chart, and the old
  `5m ALL` tab/engine is gone with no console errors referencing removed modules.
- Codex read-only audit (per project's standing "auto Codex audit" rule) on the new
  component + the removal diff before build.
- Native (Expo Go / APK) manual check: confirm the fallback message renders instead of
  a crash — no `lightweight-charts` under test on native in this pass.

## Out of scope (explicitly, for this spec)

- Drawing tools (trendline, fibonacci, rectangle, text annotations).
- Native WebView-based chart parity — tracked as a possible follow-up, not part of
  this change.
- Any change to the underlying rule-matching logic (`useRuleAlerts.ts`) — this spec is
  presentation-only, reusing existing computed alerts/indicators.
