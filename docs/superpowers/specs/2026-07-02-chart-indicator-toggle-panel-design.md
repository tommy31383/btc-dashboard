# CHART tab — Indicator toggle panel (TradingView-style UX)

## Problem

`components/TradingChartTab.web.tsx` hard-mounts every indicator at once
(EMA9/21, Bollinger, SuperTrend, VWAP, RSI, StochRSI, MACD, ADX/DMI, S/R
lines, rule entry/TP/SL overlay) across 5 fixed panes. There is no way to
hide an indicator, and the 4 oscillator panes permanently eat vertical space
from the main candlestick chart.

## Goal

Let Tommy toggle indicators on/off like TradingView: a floating control that
opens an indicator checklist, and panes for oscillator-type indicators
(RSI/StochRSI/MACD/ADX) collapse when nothing in them is enabled, giving the
space back to the candlestick chart. Chart space is the priority — indicator
controls should stay minimal until opened.

## Architecture

### Indicator registry

A static `INDICATORS` registry describes every indicator:

```ts
type IndicatorKey = "ema" | "bb" | "supertrend" | "vwap" | "rsi" | "stochRsi" | "macd" | "adx" | "sr" | "rules";

interface IndicatorDef {
  key: IndicatorKey;
  label: string;          // "EMA 9/21", "RSI (14)", ...
  placement: "overlay" | "pane" | "priceLine"; // overlay = main pane 0, pane = own oscillator pane, priceLine = S/R & rule lines
}
```

`sr` and `rules` are `priceLine`-placement — they're not lightweight-charts
series at all (already implemented via `createPriceLine`/`removePriceLine`),
so toggling them just gates whether the existing price-line effect runs.

### Enabled-set state + persistence

- `enabledIndicators: Set<IndicatorKey>` (or array) is the single source of
  truth, held in `TradingChartTab.web.tsx` state.
- Persisted to `AsyncStorage` under key `@chart_indicators_v1` (debounced
  write on change, read once on mount before first chart paint).
- **Default set** (chart-space-first): `ema`, `supertrend`, `sr`, `rules`
  enabled. Everything else (`bb`, `vwap`, `rsi`, `stochRsi`, `macd`, `adx`)
  starts OFF.
- Control panel has a "Reset mặc định" action that restores the default set.

### Series lifecycle (no chart recreation)

Chart mount effect (existing, unchanged) still only creates
candlestick+volume. All indicator series/panes are created/destroyed by a
new effect keyed on `[ready, enabledIndicators]`, using real lightweight-charts
v5.2.0 API confirmed by Codex:

- `chart.addSeries(SeriesDef, options, paneIndex?)` to add.
- `chart.removeSeries(seriesApi)` to remove (irreversible — ref is dropped,
  a fresh series is created if re-enabled later; this is a deliberate
  simplification, not a bug — recreating a single series is cheap and
  avoids managing hide/show semantics).
- Pane index for oscillator indicators is assigned **dynamically** based on
  current enabled pane-indicators' order (not hard-coded to 1/2/3/4 like
  today), so turning off RSI mid-session doesn't leave a gap where MACD used
  to be at pane 3.
- When an oscillator pane's last indicator is disabled, its series are
  removed; lightweight-charts drops the now-empty pane automatically once no
  series reference it (confirmed via `chart.panes()`/`removePane` semantics
  — no series left in a pane means no visible row for it).
- `series.applyOptions({ visible: false })` is NOT used for the toggle path
  (Codex confirmed hide ≠ pane reclaim) — only real add/remove changes pane
  layout.

### Data feed

The existing TF/klines-change effect keeps computing all indicator series
values only for currently-enabled indicators (skip the calc entirely for
disabled ones — no point computing ADX if it's off), then calls `setData` on
whichever series refs are currently mounted.

### Control panel UI

- A floating **"Indicators"** icon button anchored top-right of the chart
  area (small footprint, doesn't compete with candlesticks for space).
- Tapping it opens a **bottom sheet** (works identically on Android APK and
  web — avoids a desktop-only dropdown that would look broken on mobile).
- Sheet content: one row per `IndicatorDef`, each with a toggle switch and
  label. Grouped into "Overlay" (ema/bb/supertrend/vwap/sr/rules) and
  "Oscillator panes" (rsi/stochRsi/macd/adx) sections.
- "Reset mặc định" button at the bottom of the sheet.
- Sheet dismiss = tap outside or a close button; no explicit "Apply" step —
  toggles take effect immediately (matches TradingView's live-toggle feel).

### Out of scope (explicitly deferred, per Codex's phase-2 suggestion)

- TradingView's per-indicator status-line (eye/gear/x hover controls
  directly on the chart) — deferred; the bottom-sheet panel covers the same
  need with less complexity for a v1.
- Per-indicator settings (period, color, style) — all indicators keep their
  current hardcoded params (EMA9/21, RSI14, etc.); this spec is scoped to
  visibility toggling only, not configuration.
- Removing an indicator's underlying calc code — toggling never deletes
  data, only mount/unmount of series.

## Testing

- Extend the existing indicator-mapper-style unit test coverage is not
  applicable here (this is UI/chart wiring, no pure-function to unit test
  beyond what `utils/indicators.ts` already has).
- Verification is manual, via the browser preview: toggle each indicator
  off/on, confirm the corresponding pane appears/disappears and the main
  candlestick pane visibly grows when oscillator panes are off; confirm
  AsyncStorage persistence survives a page reload; confirm default set on
  first-ever load (clear storage) matches the spec above.

## Files touched

- `components/TradingChartTab.web.tsx` — main rework (registry, state,
  dynamic series lifecycle, control-panel trigger button).
- New: `components/ChartIndicatorPanel.tsx` — the bottom-sheet UI itself
  (kept separate from `TradingChartTab.web.tsx` so the sheet is a plain,
  reusable, platform-agnostic RN component, not tied to `.web.tsx`).
- `components/TradingChartTab.native.tsx` — no change needed (still just
  shows the fallback message; toggle panel is irrelevant until native chart
  exists).
