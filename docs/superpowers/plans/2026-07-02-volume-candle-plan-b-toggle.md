# Volume Candle — Plan B: Toggle Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-built-and-verified `VolumeCandleSeries` (Plan A) into the CHART tab's existing Indicators toggle panel, so toggling "Volume Candle" swaps the main candle series between regular `CandlestickSeries` and the custom variable-width renderer — preserving zoom/pan position, S/R + rule price-lines, and correct overlay z-order across the swap.

**Architecture:** Registry entry in `utils/chartIndicators.ts`; a swap effect in `TradingChartTab.web.tsx` that removes the old candle series (clearing its price-lines first), creates the new one, restores the visible logical range, and forces overlay series + price-lines to re-create in correct z-order via a shared `reconcileOverlaySeries()` function (extracted from the existing overlay-reconcile effect so both effects call one implementation, not two copies).

**Tech Stack:** `lightweight-charts@5.2.0`, existing `VolumeCandleSeries`/`klinesToVolumeCandleData` from Plan A.

**Spec:** `docs/superpowers/specs/2026-07-02-volume-candle-design.md`

---

## Task 1: Registry entry

**Files:**
- Modify: `utils/chartIndicators.ts`

- [ ] **Step 1: Add the new key**

```ts
export type IndicatorKey =
  | "ema"
  | "bb"
  | "supertrend"
  | "vwap"
  | "rsi"
  | "stochRsi"
  | "macd"
  | "adx"
  | "sr"
  | "rules"
  | "volumeCandle";
```

Add to the `INDICATORS` array (after the `"rules"` entry, keeping it in the
overlay group):

```ts
  { key: "volumeCandle", label: "Volume Candle", group: "overlay", placement: "overlay" },
```

Do NOT add `"volumeCandle"` to `DEFAULT_ENABLED_INDICATORS` — starts OFF.

- [ ] **Step 2: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep chartIndicators`
Expected: no output

- [ ] **Step 3: Run existing indicator hook tests (must still pass unchanged)**

Run: `cd btc-dashboard && npx tsx --test hooks/useChartIndicators.test.ts`
Expected: PASS (all existing tests, no new test needed here — the parser
already handles any valid key generically)

- [ ] **Step 4: Commit**

```bash
cd btc-dashboard
git add utils/chartIndicators.ts
git commit -m "feat: register volumeCandle indicator key (starts off by default)"
```

---

## Task 2: Extract `reconcileOverlaySeries` as a shared function

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

This refactors the existing overlay-reconcile effect's body into a plain
function so both it AND the new swap effect (Task 3) can call it —
avoiding two independent pieces of code that mutate the same overlay
series refs (the hook-ordering hazard Codex flagged when auditing the
spec).

- [ ] **Step 1: Read the current overlay-reconcile effect to confirm exact code before extracting**

Run: `sed -n '88,131p' components/TradingChartTab.web.tsx`

- [ ] **Step 2: Extract the body into a standalone function, defined above the component (or as a `useCallback` inside it — use a plain function above the component since it only needs `chart` + refs passed as args, no closure over component state beyond what's passed in)**

Replace the existing overlay-reconcile effect:

```tsx
  // Reconcile overlay series (main pane 0) whenever the enabled set changes.
  // Overlay toggles never touch pane 1+, so no pane-index bug here — plain
  // add-if-missing / remove-if-present per key.
  useEffect(() => {
    if (!ready || !chartRef.current) return;
    reconcileOverlaySeries(chartRef.current, enabledIndicators, {
      ema9SeriesRef, ema21SeriesRef, bbUpperSeriesRef, bbLowerSeriesRef,
      superTrendSeriesRef, vwapSeriesRef,
    }, false);
  }, [ready, enabledIndicators]);
```

Add this function above the component (after the imports, before
`export default function TradingChartTab(...)`):

```tsx
interface OverlaySeriesRefs {
  ema9SeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  ema21SeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  bbUpperSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  bbLowerSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  superTrendSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
  vwapSeriesRef: React.MutableRefObject<ISeriesApi<"Line"> | null>;
}

// Add/remove overlay (main-pane) series to match enabledIndicators.
// forceRecreate=true unconditionally removes+re-adds every currently-
// enabled overlay series (used after a candle-series swap, to restore
// correct z-order above the freshly-created candle series); forceRecreate
// =false (the normal path) only add/removes what actually changed.
function reconcileOverlaySeries(
  chart: IChartApi,
  enabledIndicators: IndicatorKey[],
  refs: OverlaySeriesRefs,
  forceRecreate: boolean
): void {
  const has = (k: IndicatorKey) => enabledIndicators.includes(k);
  const { ema9SeriesRef, ema21SeriesRef, bbUpperSeriesRef, bbLowerSeriesRef, superTrendSeriesRef, vwapSeriesRef } = refs;

  if (forceRecreate) {
    [ema9SeriesRef, ema21SeriesRef, bbUpperSeriesRef, bbLowerSeriesRef, superTrendSeriesRef, vwapSeriesRef].forEach((ref) => {
      if (ref.current) {
        chart.removeSeries(ref.current);
        ref.current = null;
      }
    });
  }

  if (has("ema") && !ema9SeriesRef.current) {
    ema9SeriesRef.current = chart.addSeries(LineSeries, { color: "#f7931a", lineWidth: 1, title: "EMA9" });
    ema21SeriesRef.current = chart.addSeries(LineSeries, { color: "#00bcd4", lineWidth: 1, title: "EMA21" });
  } else if (!has("ema") && ema9SeriesRef.current) {
    chart.removeSeries(ema9SeriesRef.current);
    chart.removeSeries(ema21SeriesRef.current!);
    ema9SeriesRef.current = null;
    ema21SeriesRef.current = null;
  }

  if (has("bb") && !bbUpperSeriesRef.current) {
    bbUpperSeriesRef.current = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Upper" });
    bbLowerSeriesRef.current = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Lower" });
  } else if (!has("bb") && bbUpperSeriesRef.current) {
    chart.removeSeries(bbUpperSeriesRef.current);
    chart.removeSeries(bbLowerSeriesRef.current!);
    bbUpperSeriesRef.current = null;
    bbLowerSeriesRef.current = null;
  }

  if (has("supertrend") && !superTrendSeriesRef.current) {
    superTrendSeriesRef.current = chart.addSeries(LineSeries, { color: COLORS.bull, lineWidth: 2, title: "SuperTrend" });
  } else if (!has("supertrend") && superTrendSeriesRef.current) {
    chart.removeSeries(superTrendSeriesRef.current);
    superTrendSeriesRef.current = null;
  }

  if (has("vwap") && !vwapSeriesRef.current) {
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: "#ba68c8", lineWidth: 1, title: "VWAP" });
  } else if (!has("vwap") && vwapSeriesRef.current) {
    chart.removeSeries(vwapSeriesRef.current);
    vwapSeriesRef.current = null;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output

- [ ] **Step 4: Manual sanity check — existing overlay toggles still work identically**

Start dev server, toggle EMA/BB/SuperTrend/VWAP on/off a few times, confirm
no regression versus current behavior (this step is pure refactor — no new
behavior yet).

- [ ] **Step 5: Commit**

```bash
cd btc-dashboard
git add components/TradingChartTab.web.tsx
git commit -m "refactor: extract reconcileOverlaySeries as shared fn (prep for candle-series swap)"
```

---

## Task 3: Candle-series swap effect

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Widen `candleSeriesRef`'s type to accept either series type**

```tsx
const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Custom"> | null>(null);
```

- [ ] **Step 2: Add a `candleSwapTick` state and the swap effect**

Add near `oscillatorReconcileTick`:

```tsx
const [candleSwapTick, setCandleSwapTick] = useState(0);
```

Add this new effect, placed AFTER the oscillator-reconcile effect and
BEFORE the data-feed effect:

```tsx
  const volumeCandleEnabled = enabledIndicators.includes("volumeCandle");

  useEffect(() => {
    if (!ready || !chartRef.current || !candleSeriesRef.current) return;
    const chart = chartRef.current;
    const isCurrentlyCustom = candleSeriesRef.current.seriesType() === "Custom";
    const shouldBeCustom = volumeCandleEnabled;
    if (isCurrentlyCustom === shouldBeCustom) return; // already correct type, nothing to swap

    // 1. Preserve viewport across the swap
    const savedRange = chart.timeScale().getVisibleLogicalRange();

    // 2. Clear price-lines attached to the OLD series (they don't survive
    //    removeSeries and must be recreated on the new one — done by the
    //    data-feed / rule-overlay effects once candleSwapTick bumps)
    priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    priceLinesRef.current = [];
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];

    // 3. Remove old series, create new one
    chart.removeSeries(candleSeriesRef.current);
    candleSeriesRef.current = shouldBeCustom
      ? chart.addCustomSeries(new VolumeCandleSeries(), {})
      : chart.addSeries(CandlestickSeries, {
          upColor: COLORS.bull, downColor: COLORS.bear,
          borderUpColor: COLORS.bull, borderDownColor: COLORS.bear,
          wickUpColor: COLORS.bull, wickDownColor: COLORS.bear,
        });

    // 4. Restore viewport
    if (savedRange) chart.timeScale().setVisibleLogicalRange(savedRange);

    // 5. Force-recreate overlay series so they z-order above the new candle
    //    series (Codex-caught P1 in the spec) — reuse the shared function,
    //    not a second copy of the add/remove logic.
    reconcileOverlaySeries(chart, enabledIndicators, {
      ema9SeriesRef, ema21SeriesRef, bbUpperSeriesRef, bbLowerSeriesRef,
      superTrendSeriesRef, vwapSeriesRef,
    }, true);

    // 6. Bump tick so data-feed + rule-overlay effects repopulate against
    //    the new series ref (both effects' dependency arrays include this)
    setCandleSwapTick((t) => t + 1);
  }, [ready, volumeCandleEnabled]);
```

- [ ] **Step 3: Add the import**

```tsx
import { VolumeCandleSeries } from "./volumeCandleSeries";
```

- [ ] **Step 4: Add `candleSwapTick` to the data-feed effect's dependency array**

Find the data-feed effect's closing dependency array (currently `[ready,
rawKlines, selectedTF, enabledIndicators, oscillatorReconcileTick]`) and
change to:

```tsx
  }, [ready, rawKlines, selectedTF, enabledIndicators, oscillatorReconcileTick, candleSwapTick]);
```

- [ ] **Step 5: Add `candleSwapTick` to the rule-overlay effect's dependency array (Codex-caught P1 in the spec — this effect is separate from data-feed and was missed in the first draft)**

Find the rule-overlay effect's closing dependency array (currently
`[ready, activeAlerts, selectedTF, enabledIndicators]`) and change to:

```tsx
  }, [ready, activeAlerts, selectedTF, enabledIndicators, candleSwapTick]);
```

- [ ] **Step 6: Branch the candle `setData` call on series type**

Find the candle `setData` call in the data-feed effect (currently
`candleSeriesRef.current.setData(klinesToCandlestickData(klines)...)`)
and change to:

```tsx
    if (candleSeriesRef.current.seriesType() === "Custom") {
      (candleSeriesRef.current as ISeriesApi<"Custom">).setData(
        klinesToVolumeCandleData(klines).map((p) => ({ ...p, time: p.time as UTCTimestamp }))
      );
    } else {
      (candleSeriesRef.current as ISeriesApi<"Candlestick">).setData(
        klinesToCandlestickData(klines).map((p) => ({ ...p, time: p.time as UTCTimestamp })) as CandlestickData<UTCTimestamp>[]
      );
    }
```

- [ ] **Step 7: Add the mapper import**

```tsx
import { klinesToVolumeCandleData } from "../utils/chartDataMapper";
```

(Merge into the existing `import { klinesToCandlestickData, klinesToVolumeData }
from "../utils/chartDataMapper";` line if simpler — one import statement,
three named imports.)

- [ ] **Step 8: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output. If `seriesType()` isn't a real method (verify against
`node_modules/lightweight-charts/dist/typings.d.ts` — grep for
`seriesType`), use the alternative: track a boolean ref
(`isCustomCandleRef`) updated at swap-time instead of calling a runtime
type-check method. Confirm which approach compiles before proceeding.

- [ ] **Step 9: Commit**

```bash
cd btc-dashboard
git add components/TradingChartTab.web.tsx
git commit -m "feat: candle-series swap effect for Volume Candle toggle (viewport-preserving, z-order-correct)"
```

---

## Task 4: Full manual verification + Codex audit + version bump

**Files:**
- Modify: `App.tsx`, `app.json` (version bump only, if Codex audit passes clean)

- [ ] **Step 1: Typecheck + existing tests**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep -E "TradingChartTab|chartIndicators|volumeCandleSeries|chartDataMapper"`
Run: `cd btc-dashboard && npx tsx --test utils/chartDataMapper.test.ts hooks/useChartIndicators.test.ts`
Expected: both clean / all passing

- [ ] **Step 2: Manual browser verification**

Using the dev server preview, on the CHART tab:
1. Open Indicators panel, toggle "Volume Candle" ON — confirm the main
   candlestick pane switches to variable-width candles, body width visibly
   correlates with the volume histogram below.
2. Confirm S/R lines and rule entry/TP/SL lines (if any active rule fires)
   are still present after the swap — this is the scenario the price-line
   clear/recreate logic exists for.
3. Pan/zoom before toggling, note the visible range, toggle Volume Candle
   on, confirm the viewport did NOT jump/reset.
4. With Volume Candle ON, toggle EMA/SuperTrend on/off — confirm those
   overlay lines still draw ABOVE the candle bodies (not hidden behind
   them) — this is the z-order fix being exercised.
5. Toggle Volume Candle back OFF — confirm it swaps back to normal
   candlesticks cleanly, same checks as above in reverse.
6. Check `preview_console_logs` for errors throughout all of the above —
   must stay clean.
7. Reload the page with Volume Candle left ON — confirm it persists
   (AsyncStorage) and the custom series mounts correctly on fresh load (not
   just on live toggle).

- [ ] **Step 3: Codex audit (mandatory per project convention)**

Run `scripts/codex/ask.sh` (read-only) pointed at the full diff since Plan
A's last commit. Ask specifically about: swap-effect correctness (does
`seriesType()` really exist, or was the Step 8 fallback needed), price-line
lifecycle correctness, whether `reconcileOverlaySeries`'s `forceRecreate`
path has any gap, and any other bug in the final diff. Fix any P1 before
proceeding.

- [ ] **Step 4: Bump version (minor — new feature) and commit**

Read `APP_VERSION` from `App.tsx`, bump minor, update `BUILD_DATE`, sync
`app.json`. Per this session's established pattern, this step is optional —
`npm run build:web:deploy` also auto-bumps patch on its own when Tommy
says "build"; only do a manual minor bump here if you want the version
jump to reflect "new feature" rather than "patch", consistent with the
project's own bump-size convention.

```bash
cd btc-dashboard
git add App.tsx app.json
git commit -m "chore: bump version for Volume Candle feature"
```

(Do NOT run the build/deploy script — only on explicit "build" command.)

---

## Self-Review Notes

- **Spec coverage:** registry (Task 1) ✓, shared reconcile fn to avoid the
  two-effects-same-refs hazard (Task 2) ✓, swap effect with viewport
  preserve + price-line clear/recreate + z-order fix (Task 3) ✓,
  `candleSwapTick` added to BOTH data-feed AND rule-overlay effects (Task 3
  Steps 4-5) — this was the specific P1 gap Codex caught in the spec draft,
  now explicitly present as its own step so it can't be silently dropped
  during implementation.
- `seriesType()` existence is flagged as unverified in Task 3 Step 8 with an
  explicit fallback path — do not guess silently if it doesn't compile.
- Task 3 Step 1's type widening means any other code touching
  `candleSeriesRef.current` with `Candlestick`-specific methods (there
  shouldn't be any beyond what Tasks 3/4 already touch) would now fail
  typecheck and surface immediately — that's a deliberate safety net, not a
  gap to fix.
