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
  write on change).
- **Default set** (chart-space-first): `ema`, `supertrend`, `sr`, `rules`
  enabled. Everything else (`bb`, `vwap`, `rsi`, `stochRsi`, `macd`, `adx`)
  starts OFF.
- Control panel has a "Reset mặc định" action that restores the default set.
- **Load/validation (P2 fix per Codex audit):** state starts as the default
  set synchronously (so the chart never flashes an undefined/empty state
  before storage resolves). A mount effect reads AsyncStorage once; on
  success, parse the stored JSON defensively — if it's not valid JSON, not
  an array, or empty after filtering, keep the default set. Otherwise filter
  the stored array down to keys that still exist in the current
  `INDICATORS` registry (drops now-removed/renamed keys from old app
  versions) and dedupe, then replace state with that filtered result. This
  guards against stale cached keys from a prior build and against the async
  load racing a user toggle (the effect only ever runs once on mount, before
  any user interaction is possible, so no write-write race with user
  toggles).

### Series lifecycle (no chart recreation)

Chart mount effect (existing, unchanged) still only creates
candlestick+volume. Overlay indicators (main pane 0: ema/bb/supertrend/vwap)
are added/removed independently and don't affect pane layout — straightforward
`addSeries`/`removeSeries` per key.

Oscillator-pane indicators (rsi/stochRsi/macd/adx) are handled differently,
per a P1 correctness issue Codex caught: `addSeries(def, opts, paneIndex)`
does **not** insert a pane in the middle — if `paneIndex` already exists it
just adds the series to that existing pane. So an incremental "remove RSI,
later re-add RSI at pane 1" can land RSI in whatever pane currently sits at
index 1 (e.g. Stoch's pane after RSI was removed and everything shifted up),
producing the wrong pane assignment.

**Fix: full reconcile, not incremental diffing.** Whenever
`enabledIndicators` changes in a way that touches any oscillator-pane
indicator, remove ALL currently-mounted oscillator series (`removeSeries`
each), then re-add the currently-enabled oscillator indicators fresh, in a
fixed registry order (rsi → stochRsi → macd → adx), assigning pane index
`1, 2, 3, ...` sequentially based only on what's enabled right now. This is
cheap (at most 4 indicator groups, a handful of series) and sidesteps the
incremental-pane-index bug entirely — no stale pane-index bookkeeping needed.
Overlay-only toggles (ema/bb/supertrend/vwap/sr/rules) skip this reconcile
entirely since they never touch pane 1+.

- `chart.addSeries(SeriesDef, options, paneIndex?)` to add.
- `chart.removeSeries(seriesApi)` to remove (irreversible — ref is dropped,
  a fresh series is created if re-enabled later; this is a deliberate
  simplification, not a bug — recreating a series is cheap and avoids
  managing hide/show semantics).
- When the last oscillator indicator is disabled (0 oscillator panes left),
  `removeSeries` on the final remaining series in a pane auto-drops that
  now-empty pane — confirmed by Codex as real default behavior (as long as
  `preserveEmptyPane` isn't set and more than one pane remains), no explicit
  `chart.removePane(index)` call needed for this path.
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
