# Volume Candle (variable-width candlestick)

## Problem

Tommy asked for TradingView's "Volume candle" chart type — real official
TradingView feature where each candle's **body width** scales with that
candle's volume (high volume = wider body), not a color change. Confirmed
via Codex research: this is a real TradingView chart type (see
[Volume candle charts](https://www.tradingview.com/support/solutions/43000724995-understanding-volume-candle-charts/)),
distinct from Volume Profile/VRVP or volume-colored candles.

`lightweight-charts@5.2.0`'s built-in `CandlestickSeries` has no per-bar
width option — this requires a hand-written custom series renderer.

## Goal

Add a **"Volume Candle"** toggle to the existing CHART tab Indicators panel
(OVERLAY group). When enabled, the main candlestick series is replaced by a
custom-rendered series whose candle body width is proportional to that
bar's volume relative to the max volume in the current visible range. Color
stays the same bull/bear scheme as regular candles. When disabled, it swaps
back to the normal `CandlestickSeries`.

## Architecture

### Custom series (real API, confirmed by Codex against v5.2.0 docs)

New file `components/volumeCandleSeries.ts` implements `ICustomSeriesPaneView`:

```ts
interface VolumeCandleData extends CustomData<UTCTimestamp> {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

class VolumeCandleSeries implements ICustomSeriesPaneView<UTCTimestamp, VolumeCandleData, VolumeCandleSeriesOptions> {
  renderer(): ICustomSeriesPaneRenderer { /* returns the renderer instance */ }
  update(data: PaneRendererCustomData<UTCTimestamp, VolumeCandleData>, options: VolumeCandleSeriesOptions): void {
    // compute visibleMaxVolume from data.visibleRange + data.bars, cache
    // it on the renderer for draw() to read — this is where "width scales
    // to the current visible range" actually gets computed, NOT via a
    // separate subscribeVisibleTimeRangeChange listener (Codex confirmed
    // update() already receives visibleRange/bars/barSpacing every redraw).
  }
  priceValueBuilder(row: VolumeCandleData): CustomSeriesPricePlotValues {
    return [row.high, row.low, row.close]; // last element = current value; library takes min/max for autoscale — must include high/low or wicks get clipped
  }
  isWhitespace(data: VolumeCandleData | CustomSeriesWhitespaceData<UTCTimestamp>): data is CustomSeriesWhitespaceData<UTCTimestamp> {
    return !("open" in data);
  }
  defaultOptions(): VolumeCandleSeriesOptions {
    return { ...customSeriesDefaultOptions, upColor: COLORS.bull, downColor: COLORS.bear };
  }
}
```

The renderer's `draw(target, priceConverter, isHovered, hitTestData)`:
- `target` is `CanvasRenderingTarget2D` (from `fancy-canvas`, re-exported by
  lightweight-charts) — NOT a raw `CanvasRenderingContext2D`. Must use
  `target.useBitmapCoordinateSpace((scope) => { const { context,
  horizontalPixelRatio, verticalPixelRatio } = scope; ... })` for crisp
  rendering at any DPR — never read `window.devicePixelRatio` manually.
- For each bar: compute `bodyWidth = clamp(barSpacing * (volume /
  visibleMaxVolume), minPx=1, maxPx=barSpacing * 0.9)`, centered on the
  bar's `x` (media coordinates from `bar.x`, converted via the pixel ratio
  inside the bitmap-coordinate-space callback).
- Wick (high-low line) is drawn at fixed 1px width regardless of volume —
  only the body varies.
- Color: `open <= close ? upColor : downColor` (same as normal candles),
  no volume-based coloring.

### Wiring into `TradingChartTab.web.tsx`

- `candleSeriesRef`'s type becomes a union
  (`ISeriesApi<"Candlestick"> | ISeriesApi<"Custom">`) since it can now be
  either series type depending on the toggle.
- A new effect, keyed on `enabledIndicators.includes("volumeCandle")`,
  performs the swap:
  1. Save `chart.timeScale().getVisibleLogicalRange()` (so the swap doesn't
     jump the viewport — Codex flagged this as a real gap in the original
     design).
  2. Remove all existing price lines on the current `candleSeriesRef`
     (`priceLinesRef` and `alertLinesRef`), clear those ref arrays.
  3. `chart.removeSeries(candleSeriesRef.current)`.
  4. Create the new series: `chart.addSeries(CandlestickSeries, {...})` (if
     toggling OFF) or `chart.addCustomSeries(new VolumeCandleSeries(), {...})`
     (if toggling ON).
  5. Re-assign `candleSeriesRef.current` to the new series.
  6. Restore the saved visible logical range via
     `chart.timeScale().setVisibleLogicalRange(...)`.
  7. Bump a `candleSwapTick` counter (same pattern as
     `oscillatorReconcileTick`) so the data-feed effect re-populates
     candlestick data, S/R lines, and rule-overlay lines against the new
     series ref.
- The data-feed effect's candle `setData` call branches on which series
  type is active: `CandlestickSeries` gets `klinesToCandlestickData(klines)`
  (existing mapper, drops volume); the custom series needs a new mapper
  `klinesToVolumeCandleData(klines)` that keeps `volume` per Codex's
  finding that `CandlestickData` doesn't carry it and the existing mapper
  drops it.
- Series **z-order**: Codex flagged that re-creating the candle series
  might draw it on top of already-created overlay lines (EMA/BB/SuperTrend)
  depending on add order. Mitigation: the swap effect also removes and
  re-adds the overlay series that are currently enabled, in the same fixed
  order used by the existing overlay-reconcile effect, immediately after
  the candle series swap — reusing that effect's logic rather than
  duplicating it (call it via a shared internal function, not copy-paste).

### Registry addition

`utils/chartIndicators.ts`: add `"volumeCandle"` to `IndicatorKey`, add to
`INDICATORS` as `{ key: "volumeCandle", label: "Volume Candle", group:
"overlay", placement: "overlay" }`. **Not** added to
`DEFAULT_ENABLED_INDICATORS` — starts OFF, matching the existing
chart-space-first default philosophy (this is a heavier custom-render
feature, not something that should silently turn on for everyone).

### Width formula

Codex found no single authoritative "TradingView official" formula (the
closest documented reference, StockCharts' CandleVolume, normalizes volume
as a percentage of total look-back volume — a different chart family, not
lightweight-charts-compatible directly since it doesn't work with a fixed
time-scale). This spec's approximation: linear scale against the max volume
in the *current visible range* (recomputed every `update()` call, which
already fires on pan/zoom), clamped to `[1px, barSpacing * 0.9]`. This is
called out explicitly as an approximation, not a claimed exact TradingView
match — acceptable since the goal is the visual concept (wide bar = high
volume), not pixel-parity with TradingView's proprietary renderer.

## Testing

- Unit test for the new mapper `klinesToVolumeCandleData` (pure function,
  same TDD pattern as `chartDataMapper.test.ts`) — verifies time-ms-to-
  seconds conversion and that `volume` passes through unchanged.
- The renderer itself (canvas drawing) is not unit-testable — verified
  manually via browser: toggle Volume Candle on/off, confirm body widths
  visibly vary with volume, confirm S/R and rule lines survive the swap,
  confirm zoom/pan position is preserved across the swap, confirm no
  console errors, confirm overlay indicators (EMA/SuperTrend/etc, if
  enabled) remain visible and not obscured after the swap.

## Out of scope

- Per-candle volume-based coloring (a different, simpler feature already
  covered by existing indicators — not requested here).
- Volume Profile / VRVP (a completely different, harder feature Codex
  identified as needing a horizontal histogram custom primitive — not what
  Tommy asked for).
- Exact pixel-parity with TradingView's real renderer — this is a visual
  approximation, explicitly noted above.
