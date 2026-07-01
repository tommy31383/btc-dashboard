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
  engine (`use5mAllTrader`), its 10 presets, `utils/all5mAccount.ts`, and the "5m ALL
  Engine Mode" reference on the LIVE tab all go away. AsyncStorage keys
  (`@all5m_data_v1`, `@all5m_preset_v1`, `@all5m_rule_open`) are left alone on-device
  (no migration needed) — the app just stops reading/writing them.
  - **`UnifiedTradesPanel.tsx`** currently merges LIVE real trades + 5m ALL paper
    trades into one view. Per Tommy's decision, this panel drops the 5m ALL column
    entirely and shows LIVE real trades only — it does NOT keep `all5mAccount` around
    just to feed this display.
  - `hooks/useBinanceLive.ts` and `utils/liveTraderEngine.ts` both import
    `getActivePreset` from `all5mAccount.ts` inside already-inert legacy code (dead
    behind the `SERVER_OWNS_TRADING` kill switch — see project CLAUDE.md). Deleting
    `all5mAccount.ts` breaks their imports at compile time even though the code never
    runs. Fix: remove the `getActivePreset` import/call from both files (they're inert,
    so this is a mechanical cleanup, not a behavior change) rather than leave a stub.
- **Drawing tools:** out of scope for v1 (no trendline/fib/etc — `lightweight-charts`
  doesn't ship these, they'd need custom primitives work).
- **Platform:** web-first. `lightweight-charts` is a DOM/canvas library; on native
  (APK/iOS) it would need `react-native-webview` (not currently a dependency). v1 shows
  a "chưa hỗ trợ trên app" fallback on native instead of crashing or shipping WebView
  integration risk in the same pass. Implemented as a real platform split —
  `TradingChartTab.web.tsx` (imports `lightweight-charts`) +
  `TradingChartTab.native.tsx` (fallback message, no import of the DOM-only library) —
  not a single file with a runtime `Platform.OS` branch, so Metro never has to resolve
  `lightweight-charts` when bundling for native.

## Architecture

- New components (real platform split, see above): `components/TradingChartTab.web.tsx`
  + `components/TradingChartTab.native.tsx`, imported from callers as
  `components/TradingChartTab` (Metro/Expo resolves the platform-specific file
  automatically).
  - `TradingChartTab.web.tsx`: mounts a `<div>` ref, calls `lightweight-charts`
    `createChart()` once, adds a candlestick series + volume histogram + EMA9/EMA21
    line series + Bollinger Band lines, plus separate panes for RSI / StochRSI / MACD.
    **Multi-pane and `addPriceLine()` placement (chart-level vs series-level) are
    unverified assumptions** — confirm against the installed `lightweight-charts`
    version's docs once the dependency is added, before relying on this shape in the
    implementation plan.
  - `TradingChartTab.native.tsx`: renders a simple "chart chưa hỗ trợ trên app, dùng
    bản web" message — no `lightweight-charts` import anywhere in this file.
  - **Time unit:** `Kline.time` from `useBinanceKlines` is milliseconds;
    `lightweight-charts` expects seconds (`UTCTimestamp`) or `BusinessDay`. The mapper
    below must divide by 1000, not pass `Kline.time` through directly.
- Data source: reuse `RawKlinesMap` from `useBinanceKlines` (already fetched app-wide,
  no new network calls). A small pure mapper converts `Kline[] → CandlestickData[]`
  (`{time: seconds, open, high, low, close}` + separate volume array).
- Indicators: reuse existing pure functions from `utils/indicators.ts`
  (`calcEMASeries`, `calcBollingerSeries`, `calcRSISeriesAligned`, `calcStochRSISeries`,
  `calcMACDSeries`) — same source of truth as the RULE tab's live evaluator, so chart
  and rule-fire numbers can't drift.
- S/R levels: `utils/supportResistance.ts` `detectSRLevels()` (already used by
  `BinanceChart.tsx`) → rendered as price lines (exact API TBD-at-implementation, see
  unverified-assumption note above).
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
- `components/UnifiedTradesPanel.tsx`: remove the `all5mAccount` prop, the 5m ALL
  paper-trade rows/column, and `onGoToAll5m` — panel shows LIVE real trades only.
- `hooks/useBinanceLive.ts` and `utils/liveTraderEngine.ts`: remove the
  `getActivePreset` import from `all5mAccount.ts` and the dead code path using it
  (both files are already inert behind `SERVER_OWNS_TRADING`, so this is a compile-fix,
  not a behavior change).
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
