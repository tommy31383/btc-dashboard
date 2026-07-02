# Volume Candle — Plan A: Renderer + Mapper (Standalone)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the `VolumeCandleSeries` custom-render engine and its data mapper in isolation — a standalone temporary mount, no toggle/panel wiring yet — so the rendering math (variable body width by volume, crisp at any DPR, correct autoscale) is proven correct before Plan B adds the toggle/swap lifecycle on top of it.

**Architecture:** `lightweight-charts@5.2.0`'s `chart.addCustomSeries(paneView, options?, paneIndex?)` API, where `paneView` implements `ICustomSeriesPaneView`. Confirmed against the installed package's real typings (`node_modules/lightweight-charts/dist/typings.d.ts`) — every method signature below is copied from there, not guessed.

**Tech Stack:** `lightweight-charts@5.2.0`, `fancy-canvas` (transitive dep, provides `CanvasRenderingTarget2D`).

**Spec:** `docs/superpowers/specs/2026-07-02-volume-candle-design.md`

---

## Task 1: `klinesToVolumeCandleData` mapper (TDD)

**Files:**
- Modify: `utils/chartDataMapper.ts`
- Modify: `utils/chartDataMapper.test.ts`

- [ ] **Step 1: Read the existing mapper and test file to match conventions**

Run: `cat utils/chartDataMapper.ts utils/chartDataMapper.test.ts`

- [ ] **Step 2: Write the failing test**

Add to `utils/chartDataMapper.test.ts`:

```ts
test("klinesToVolumeCandleData: converts time to seconds and keeps volume", () => {
  const klines = [
    { time: 1700000000000, open: 100, high: 110, low: 90, close: 105, volume: 42 },
    { time: 1700000300000, open: 105, high: 108, low: 103, close: 104, volume: 17 },
  ];
  const result = klinesToVolumeCandleData(klines);
  assert.deepEqual(result, [
    { time: 1700000000, open: 100, high: 110, low: 90, close: 105, volume: 42 },
    { time: 1700000300, open: 105, high: 108, low: 103, close: 104, volume: 17 },
  ]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd btc-dashboard && npx tsx --test utils/chartDataMapper.test.ts`
Expected: FAIL — `klinesToVolumeCandleData is not a function`

- [ ] **Step 4: Implement the mapper**

Add to `utils/chartDataMapper.ts` (same file as `klinesToCandlestickData`/
`klinesToVolumeData` — follow the exact pattern already there for the
`Math.floor(k.time / 1000)` conversion):

```ts
export interface VolumeCandleDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function klinesToVolumeCandleData(klines: Kline[]): VolumeCandleDataPoint[] {
  return klines.map((k) => ({
    time: Math.floor(k.time / 1000),
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
  }));
}
```

(Check the existing file's import of the `Kline` type from
`../hooks/useBinanceKlines` and reuse it rather than re-declaring.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd btc-dashboard && npx tsx --test utils/chartDataMapper.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 6: Commit**

```bash
cd btc-dashboard
git add utils/chartDataMapper.ts utils/chartDataMapper.test.ts
git commit -m "feat: klinesToVolumeCandleData mapper for volume candle series"
```

---

## Task 2: `VolumeCandleSeries` custom renderer

**Files:**
- Create: `components/volumeCandleSeries.ts`

- [ ] **Step 1: Write the renderer + pane view**

```ts
// components/volumeCandleSeries.ts
import {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  CustomSeriesWhitespaceData,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  Time,
  customSeriesDefaultOptions,
} from "lightweight-charts";
import { CanvasRenderingTarget2D } from "fancy-canvas";

export interface VolumeCandleData extends CustomData<Time> {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumeCandleSeriesOptions extends CustomSeriesOptions {
  upColor: string;
  downColor: string;
  wickColor: string;
}

const defaultVolumeCandleOptions: VolumeCandleSeriesOptions = {
  ...customSeriesDefaultOptions,
  upColor: "#26a69a",
  downColor: "#ef5350",
  wickColor: "#999999",
};

class VolumeCandleRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<Time, VolumeCandleData> | null = null;
  private _options: VolumeCandleSeriesOptions = defaultVolumeCandleOptions;

  update(data: PaneRendererCustomData<Time, VolumeCandleData>, options: VolumeCandleSeriesOptions): void {
    this._data = data;
    this._options = options;
  }

  draw(target: CanvasRenderingTarget2D, priceConverter: (price: number) => number): void {
    if (!this._data || !this._data.visibleRange) return;
    const { bars, barSpacing, visibleRange, conflationFactor } = this._data;

    let visibleMaxVolume = 0;
    for (let i = visibleRange.from; i < visibleRange.to; i++) {
      const vol = bars[i]?.originalData.volume ?? 0;
      if (vol > visibleMaxVolume) visibleMaxVolume = vol;
    }
    if (visibleMaxVolume <= 0) return;

    const effectiveBarSpacing = barSpacing * conflationFactor;

    target.useBitmapCoordinateSpace((scope) => {
      const { context, horizontalPixelRatio, verticalPixelRatio } = scope;
      for (let i = visibleRange.from; i < visibleRange.to; i++) {
        const bar = bars[i];
        if (!bar) continue;
        const row = bar.originalData;
        const isUp = row.close >= row.open;
        const color = isUp ? this._options.upColor : this._options.downColor;

        const rawWidth = effectiveBarSpacing * (row.volume / visibleMaxVolume);
        const bodyWidthMedia = Math.max(1, Math.min(rawWidth, effectiveBarSpacing * 0.9));
        const bodyWidthBitmap = bodyWidthMedia * horizontalPixelRatio;
        const xBitmap = bar.x * horizontalPixelRatio;

        const highY = priceConverter(row.high) * verticalPixelRatio;
        const lowY = priceConverter(row.low) * verticalPixelRatio;
        const openY = priceConverter(row.open) * verticalPixelRatio;
        const closeY = priceConverter(row.close) * verticalPixelRatio;
        const bodyTop = Math.min(openY, closeY);
        const bodyBottom = Math.max(openY, closeY);

        // Wick — fixed 1px width regardless of volume
        context.fillStyle = color;
        context.fillRect(Math.round(xBitmap - horizontalPixelRatio / 2), highY, horizontalPixelRatio, lowY - highY);

        // Body — width varies with volume
        context.fillRect(
          Math.round(xBitmap - bodyWidthBitmap / 2),
          bodyTop,
          Math.round(bodyWidthBitmap),
          Math.max(1, bodyBottom - bodyTop)
        );
      }
    });
  }
}

export class VolumeCandleSeries implements ICustomSeriesPaneView<Time, VolumeCandleData, VolumeCandleSeriesOptions> {
  private _renderer = new VolumeCandleRenderer();

  renderer(): ICustomSeriesPaneRenderer {
    return this._renderer;
  }

  update(data: PaneRendererCustomData<Time, VolumeCandleData>, options: VolumeCandleSeriesOptions): void {
    this._renderer.update(data, options);
  }

  priceValueBuilder(row: VolumeCandleData): CustomSeriesPricePlotValues {
    return [row.high, row.low, row.close];
  }

  isWhitespace(data: VolumeCandleData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
    return !("open" in data);
  }

  defaultOptions(): VolumeCandleSeriesOptions {
    return defaultVolumeCandleOptions;
  }
}
```

Notes for the implementer:
- `ICustomSeriesPaneRenderer.draw`'s real signature is `draw(target,
  priceConverter, isHovered, hitTestData?)` — the 3rd/4th params are unused
  here so they're omitted from the local override (TypeScript allows
  implementing an interface method with fewer params as long as the ones
  present match positionally — verify this compiles in Step 2 below; if
  `tsc` complains, add `_isHovered: boolean` as an explicit unused param
  instead of omitting it).
- `bars[i]?.originalData` — `bars` is indexed 0..N-1 matching all data
  points, NOT just the visible ones; `visibleRange.from`/`.to` are the
  indices to iterate.
- Do not call `window.devicePixelRatio` anywhere — `horizontalPixelRatio`/
  `verticalPixelRatio` from `useBitmapCoordinateSpace`'s scope are the
  correct source per `fancy-canvas`'s real API
  (`node_modules/fancy-canvas/canvas-rendering-target.d.ts`).

- [ ] **Step 2: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep volumeCandleSeries`
Expected: no output. If there's a signature mismatch on `draw()`, fix per
the note above (add explicit unused params matching the real interface).

- [ ] **Step 3: Commit**

```bash
cd btc-dashboard
git add components/volumeCandleSeries.ts
git commit -m "feat: VolumeCandleSeries custom renderer (variable body width by volume)"
```

---

## Task 3: Standalone verification mount

**Files:**
- Modify: `components/TradingChartTab.web.tsx` (temporary, reverted at end of this task)

This task proves the renderer works correctly BEFORE Plan B wires it into
the toggle/swap lifecycle — keeping the two concerns isolated per the
spec's stated reason for splitting into two plans.

- [ ] **Step 1: Temporarily mount `VolumeCandleSeries` as a second series (not replacing the candle series) for visual verification**

In the chart-mount effect in `TradingChartTab.web.tsx`, temporarily add
(right after the existing `volumeSeries` creation):

```tsx
import { VolumeCandleSeries } from "./volumeCandleSeries";
import { klinesToVolumeCandleData } from "../utils/chartDataMapper";
// ...
const volumeCandleTestSeries = chart.addCustomSeries(new VolumeCandleSeries(), {}, 5); // temp pane 5, well clear of existing panes
```

And in the data-feed effect, temporarily add:

```tsx
volumeCandleTestSeries.setData(klinesToVolumeCandleData(klines) as any);
```

(The `as any` here is a deliberate temporary shortcut for this
throwaway verification mount only — Plan B's real integration will type
this properly as part of the `candleSeriesRef` union.)

- [ ] **Step 2: Start the dev server and verify visually**

Use `preview_start` with the `btc-dashboard-dev` launch config, navigate to
the CHART tab. Confirm:
1. A new pane (pane index 5) appears showing candle-like shapes whose body
   width visibly varies bar-to-bar in proportion to volume (compare against
   the existing volume histogram pane — high-volume bars in the histogram
   should correspond to wider bodies in the new pane).
2. Zoom in/out (mouse wheel or pinch) — bodies stay crisp (no blurriness),
   width recalculates relative to the new visible range's max volume.
3. Check `preview_console_logs` for errors — must be clean.
4. Check autoscale: the pane's own price scale should span from lowest low
   to highest high visible, not clipped — confirms `priceValueBuilder`
   returning `[high, low, close]` is correct.

- [ ] **Step 3: Revert the temporary mount**

This verification code was explicitly temporary (Step 1 says so) — remove
the `volumeCandleTestSeries` creation, its `setData` call, and the two
added imports, restoring `TradingChartTab.web.tsx` to its pre-Task-3 state.
Confirm with `git diff components/TradingChartTab.web.tsx` that it shows no
changes before committing.

- [ ] **Step 4: Confirm clean revert**

Run: `cd btc-dashboard && git status --short components/TradingChartTab.web.tsx`
Expected: no output (file unchanged from before this task)

- [ ] **Step 5: Nothing to commit for this task** — Task 3 only produces a
  verification result (recorded in the task notes / conversation), not a
  code change. Do not commit `TradingChartTab.web.tsx`.

---

## Self-Review Notes

- **Spec coverage:** this plan covers only the "Plan A" scope from the spec
  (renderer + mapper + standalone verify) — swap lifecycle, panel registry,
  z-order fix, and price-line handling are explicitly Plan B's job, tracked
  as a separate plan doc to be written after this one is verified working.
- Renderer API surface (`renderer()`, `update()`, `priceValueBuilder()`,
  `isWhitespace()`, `defaultOptions()`, `ICustomSeriesPaneRenderer.draw()`)
  matches the real `node_modules/lightweight-charts/dist/typings.d.ts`
  signatures checked directly against the installed package version, not
  guessed from memory.
- `CanvasRenderingTarget2D` imported from `fancy-canvas` per the Codex P1
  fix already applied to the spec — this plan follows that correction.
