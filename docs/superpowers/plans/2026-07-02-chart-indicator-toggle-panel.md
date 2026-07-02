# Chart Indicator Toggle Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Tommy toggle CHART-tab indicators on/off from a control panel (TradingView-style), with oscillator panes (RSI/StochRSI/MACD/ADX) collapsing when empty so the candlestick chart gets maximum space by default.

**Architecture:** A static `INDICATORS` registry (in a new `utils/chartIndicators.ts`) plus an `enabledIndicators: IndicatorKey[]` state in `TradingChartTab.web.tsx`, persisted to AsyncStorage. Overlay indicators (main pane) toggle independently via simple add/remove. Oscillator-pane indicators (RSI/StochRSI/MACD/ADX) use a full reconcile-on-change strategy (remove all, re-add enabled ones in fixed order with sequential pane indices) to avoid a pane-index bug Codex identified with incremental toggling. The control-panel UI is a shared `ChartIndicatorPanel` content component wrapped differently per platform (web popover vs native bottom-sheet).

**Tech Stack:** React Native (Expo, web+native), `lightweight-charts@5.2.0`, `@react-native-async-storage/async-storage` (already a project dependency).

**Spec:** `docs/superpowers/specs/2026-07-02-chart-indicator-toggle-panel-design.md`

---

## Task 1: Indicator registry + persistence hook

**Files:**
- Create: `utils/chartIndicators.ts`
- Create: `hooks/useChartIndicators.ts`
- Test: `hooks/useChartIndicators.test.ts`

- [ ] **Step 1: Write `utils/chartIndicators.ts`**

```ts
// utils/chartIndicators.ts
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
  | "rules";

export type IndicatorPlacement = "overlay" | "pane" | "priceLine";

export interface IndicatorDef {
  key: IndicatorKey;
  label: string;
  group: "overlay" | "oscillator";
  placement: IndicatorPlacement;
}

// Order here is the fixed pane-assignment order for "pane" placement
// indicators — pane index is 1 + position among *currently enabled*
// pane indicators, recomputed on every toggle (see Task 4).
export const INDICATORS: IndicatorDef[] = [
  { key: "ema", label: "EMA 9 / 21", group: "overlay", placement: "overlay" },
  { key: "bb", label: "Bollinger Bands (20,2)", group: "overlay", placement: "overlay" },
  { key: "supertrend", label: "SuperTrend (10,3)", group: "overlay", placement: "overlay" },
  { key: "vwap", label: "VWAP (daily anchor)", group: "overlay", placement: "overlay" },
  { key: "sr", label: "Support/Resistance", group: "overlay", placement: "priceLine" },
  { key: "rules", label: "Rule Entry/TP/SL", group: "overlay", placement: "priceLine" },
  { key: "rsi", label: "RSI (14)", group: "oscillator", placement: "pane" },
  { key: "stochRsi", label: "Stoch RSI (14,14,3,3)", group: "oscillator", placement: "pane" },
  { key: "macd", label: "MACD (12,26,9)", group: "oscillator", placement: "pane" },
  { key: "adx", label: "ADX / DMI (14)", group: "oscillator", placement: "pane" },
];

export const DEFAULT_ENABLED_INDICATORS: IndicatorKey[] = ["ema", "supertrend", "sr", "rules"];

const VALID_KEYS = new Set<IndicatorKey>(INDICATORS.map((i) => i.key));

// Defensive parse for AsyncStorage payload: invalid JSON, non-array, or
// empty-after-filtering all fall back to the default set. Unknown keys
// (from a prior app version) are dropped; duplicates are deduped.
export function parseStoredIndicators(raw: string | null): IndicatorKey[] {
  if (!raw) return DEFAULT_ENABLED_INDICATORS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_ENABLED_INDICATORS;
  }
  if (!Array.isArray(parsed)) return DEFAULT_ENABLED_INDICATORS;
  const filtered = Array.from(new Set(parsed)).filter((k): k is IndicatorKey => VALID_KEYS.has(k as IndicatorKey));
  return filtered.length > 0 ? filtered : DEFAULT_ENABLED_INDICATORS;
}

export const CHART_INDICATORS_STORAGE_KEY = "@chart_indicators_v1";
```

- [ ] **Step 2: Write the failing test for `parseStoredIndicators`**

```ts
// hooks/useChartIndicators.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStoredIndicators, DEFAULT_ENABLED_INDICATORS } from "../utils/chartIndicators";

test("parseStoredIndicators: null returns default set", () => {
  assert.deepEqual(parseStoredIndicators(null), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: invalid JSON returns default set", () => {
  assert.deepEqual(parseStoredIndicators("{not json"), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: non-array JSON returns default set", () => {
  assert.deepEqual(parseStoredIndicators(JSON.stringify({ foo: "bar" })), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: drops unknown keys and dedupes", () => {
  const raw = JSON.stringify(["rsi", "rsi", "unknownLegacyKey", "macd"]);
  assert.deepEqual(parseStoredIndicators(raw), ["rsi", "macd"]);
});

test("parseStoredIndicators: empty array after filtering falls back to default", () => {
  const raw = JSON.stringify(["unknownLegacyKey1", "unknownLegacyKey2"]);
  assert.deepEqual(parseStoredIndicators(raw), DEFAULT_ENABLED_INDICATORS);
});

test("parseStoredIndicators: valid subset passes through unchanged (order preserved)", () => {
  const raw = JSON.stringify(["adx", "ema"]);
  assert.deepEqual(parseStoredIndicators(raw), ["adx", "ema"]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd btc-dashboard && npx tsx --test hooks/useChartIndicators.test.ts`
Expected: FAIL — `Cannot find module '../utils/chartIndicators'` (file doesn't exist yet if you run this before Step 1; if Step 1 is already done, this step is a no-op confirmation — skip ahead if `utils/chartIndicators.ts` already exists and tests already pass).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd btc-dashboard && npx tsx --test hooks/useChartIndicators.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write `hooks/useChartIndicators.ts`**

```ts
// hooks/useChartIndicators.ts
import { useEffect, useRef, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  IndicatorKey,
  DEFAULT_ENABLED_INDICATORS,
  CHART_INDICATORS_STORAGE_KEY,
  parseStoredIndicators,
} from "../utils/chartIndicators";

export function useChartIndicators() {
  const [enabled, setEnabled] = useState<IndicatorKey[]>(DEFAULT_ENABLED_INDICATORS);
  // Guards against the AsyncStorage read resolving AFTER the user has
  // already toggled something (Codex-caught P2): if the user interacts
  // before hydration finishes, the late-arriving stored value must NOT
  // clobber their in-flight change.
  const userInteracted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(CHART_INDICATORS_STORAGE_KEY).then((raw) => {
      if (cancelled || userInteracted.current) return;
      setEnabled(parseStoredIndicators(raw));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: IndicatorKey[]) => {
    AsyncStorage.setItem(CHART_INDICATORS_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const toggle = useCallback(
    (key: IndicatorKey) => {
      userInteracted.current = true;
      setEnabled((prev) => {
        const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const reset = useCallback(() => {
    userInteracted.current = true;
    setEnabled(DEFAULT_ENABLED_INDICATORS);
    persist(DEFAULT_ENABLED_INDICATORS);
  }, [persist]);

  return { enabled, toggle, reset };
}
```

- [ ] **Step 6: Commit**

```bash
cd btc-dashboard
git add utils/chartIndicators.ts hooks/useChartIndicators.ts hooks/useChartIndicators.test.ts
git commit -m "feat: indicator registry + persisted enabled-set hook for CHART tab"
```

---

## Task 2: `ChartIndicatorPanel` shared content component

**Files:**
- Create: `components/ChartIndicatorPanel.tsx`

- [ ] **Step 1: Write the component**

```tsx
// components/ChartIndicatorPanel.tsx
import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { P } from "../utils/v2Theme";
import { INDICATORS, IndicatorKey } from "../utils/chartIndicators";

interface Props {
  enabled: IndicatorKey[];
  onToggle: (key: IndicatorKey) => void;
  onReset: () => void;
}

export default function ChartIndicatorPanel({ enabled, onToggle, onReset }: Props) {
  const overlayIndicators = INDICATORS.filter((i) => i.group === "overlay");
  const oscillatorIndicators = INDICATORS.filter((i) => i.group === "oscillator");

  const renderRow = (key: IndicatorKey, label: string) => {
    const isOn = enabled.includes(key);
    return (
      <Pressable key={key} onPress={() => onToggle(key)} style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <View style={[styles.toggleTrack, isOn && styles.toggleTrackOn]}>
          <View style={[styles.toggleThumb, isOn && styles.toggleThumbOn]} />
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>OVERLAY</Text>
      {overlayIndicators.map((i) => renderRow(i.key, i.label))}
      <Text style={styles.sectionTitle}>OSCILLATOR PANES</Text>
      {oscillatorIndicators.map((i) => renderRow(i.key, i.label))}
      <Pressable onPress={onReset} style={styles.resetBtn}>
        <Text style={styles.resetLabel}>Reset mặc định</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: P.card, borderRadius: 12, padding: 12, minWidth: 240 },
  sectionTitle: { color: P.dim, fontSize: 10, fontWeight: "700", marginTop: 10, marginBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: P.border,
  },
  rowLabel: { color: P.text, fontSize: 13 },
  toggleTrack: { width: 36, height: 20, borderRadius: 10, backgroundColor: P.borderSoft, padding: 2, justifyContent: "center" },
  toggleTrackOn: { backgroundColor: P.primaryContainer },
  toggleThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: P.text },
  toggleThumbOn: { alignSelf: "flex-end" },
  resetBtn: { marginTop: 12, paddingVertical: 8, alignItems: "center" },
  resetLabel: { color: P.dim, fontSize: 12, fontWeight: "600" },
});
```

- [ ] **Step 2: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep ChartIndicatorPanel`
Expected: no output (no errors referencing this file)

- [ ] **Step 3: Commit**

```bash
cd btc-dashboard
git add components/ChartIndicatorPanel.tsx
git commit -m "feat: ChartIndicatorPanel shared checklist content component"
```

---

## Task 3: Web popover wrapper + trigger button

**Files:**
- Create: `components/ChartIndicatorPanel.web.tsx`
- Modify: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Write the web popover wrapper**

```tsx
// components/ChartIndicatorPanel.web.tsx
import React, { useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import ChartIndicatorPanel from "./ChartIndicatorPanel";
import { IndicatorKey } from "../utils/chartIndicators";

interface Props {
  visible: boolean;
  onClose: () => void;
  enabled: IndicatorKey[];
  onToggle: (key: IndicatorKey) => void;
  onReset: () => void;
}

// Absolutely-positioned popover anchored under the trigger button, with a
// dismiss-on-outside-click listener (web-only — uses DOM APIs directly,
// which is why this lives in the .web.tsx split rather than the shared
// content component).
export default function ChartIndicatorPanelWeb({ visible, onClose, enabled, onToggle, onReset }: Props) {
  const wrapperRef = useRef<View>(null);

  useEffect(() => {
    if (!visible) return;
    const handleClickOutside = (e: MouseEvent) => {
      const node = wrapperRef.current as unknown as HTMLElement | null;
      if (node && !node.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <View ref={wrapperRef} style={styles.popover}>
      <ChartIndicatorPanel enabled={enabled} onToggle={onToggle} onReset={onReset} />
    </View>
  );
}

const styles = StyleSheet.create({
  popover: {
    position: "absolute",
    top: 40,
    right: 8,
    zIndex: 50,
    // @ts-expect-error web-only boxShadow, RN StyleSheet types don't include it
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  },
});
```

- [ ] **Step 2: Wire the trigger button + popover into `TradingChartTab.web.tsx`**

Modify the imports (add to the top, after existing imports at line 11):

```tsx
import ChartIndicatorPanelWeb from "./ChartIndicatorPanel.web";
import { useChartIndicators } from "../hooks/useChartIndicators";
```

Add state for panel visibility and the hook, right after `const [ready, setReady] = useState(false);` (line 40):

```tsx
  const { enabled: enabledIndicators, toggle: toggleIndicator, reset: resetIndicators } = useChartIndicators();
  const [panelOpen, setPanelOpen] = useState(false);
```

Modify the returned JSX (replace the existing `return (...)` block at lines 242-260) to add the trigger button and popover:

```tsx
  return (
    <View style={styles.container}>
      <DebugLabel name="TradingChartTab" />
      <View style={styles.tfRow}>
        {TIMEFRAMES.map((tf) => (
          <Text
            key={tf.key}
            onPress={() => onSelectTF(tf.key)}
            style={[styles.tfBtn, selectedTF === tf.key && styles.tfBtnActive]}
          >
            {tf.label}
          </Text>
        ))}
      </View>
      <View style={{ flex: 1, width: "100%" }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {/* Floating trigger, top-right of the chart area itself (not the TF
            row) — per spec, minimal footprint over the candlesticks rather
            than competing for space in the timeframe row. */}
        <Pressable onPress={() => setPanelOpen((v) => !v)} style={styles.indicatorBtn}>
          <Text style={styles.indicatorBtnLabel}>⚙ Indicators</Text>
        </Pressable>
        <ChartIndicatorPanelWeb
          visible={panelOpen}
          onClose={() => setPanelOpen(false)}
          enabled={enabledIndicators}
          onToggle={toggleIndicator}
          onReset={resetIndicators}
        />
      </View>
      <Text style={styles.attribution}>Powered by TradingView Lightweight Charts</Text>
    </View>
  );
}
```

Add `Pressable` to the react-native import at line 2:

```tsx
import { View, StyleSheet, Text, Pressable } from "react-native";
```

Add two new styles to the `StyleSheet.create` call at the bottom of the file
(`indicatorBtn` is `position: "absolute"` so it floats over the chart
without taking layout space):

```tsx
  indicatorBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 40,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: P.card,
    borderRadius: 8,
  },
  indicatorBtnLabel: { color: P.text, fontSize: 11, fontWeight: "600" },
```

`ChartIndicatorPanel.web.tsx`'s popover `top: 40` offset (Task 3 Step 1)
already anchors correctly below this repositioned button since both are
relative to the same `View style={{ flex: 1, width: "100%" }}` wrapper.

- [ ] **Step 3: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output

- [ ] **Step 4: Manual browser check (trigger + popover open/close)**

Start the dev server (`preview_start` with the `btc-dashboard-dev` launch config), navigate to CHART tab, click "Indicators" button, confirm the popover renders with all 10 rows, click outside, confirm it closes. (Toggling doesn't do anything yet — that's Task 4.)

- [ ] **Step 5: Commit**

```bash
cd btc-dashboard
git add components/ChartIndicatorPanel.web.tsx components/TradingChartTab.web.tsx
git commit -m "feat: wire Indicators trigger button + web popover into chart tab"
```

---

## Task 4: Reactive series lifecycle keyed on `enabledIndicators`

This is the core rework: overlay series and oscillator-pane series are now
created/destroyed based on `enabledIndicators`, instead of all being mounted
once at chart-creation time.

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Replace the chart-mount effect to only create candle+volume**

Replace the mount effect (lines 43-105) — remove every `chart.addSeries(...)`
call except candlestick and volume, and remove the corresponding ref
assignments:

```tsx
  // Mount chart once — only candlestick + volume. All indicator series are
  // managed reactively by the two effects below, keyed on enabledIndicators.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: P.bg }, textColor: P.text },
      grid: { vertLines: { color: P.border }, horzLines: { color: P.border } },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.bull, downColor: COLORS.bear,
      borderUpColor: COLORS.bull, borderDownColor: COLORS.bear,
      wickUpColor: COLORS.bull, wickDownColor: COLORS.bear,
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    setReady(true);

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, []);
```

The overlay series refs (`ema9SeriesRef`, `ema21SeriesRef`, `bbUpperSeriesRef`,
`bbLowerSeriesRef`, `superTrendSeriesRef`, `vwapSeriesRef`) and oscillator
series refs (`rsiSeriesRef`, `stochKSeriesRef`, `stochDSeriesRef`,
`macdHistSeriesRef`, `plusDISeriesRef`, `minusDISeriesRef`, `adxSeriesRef`)
stay declared at the top (they still hold the currently-mounted series, just
created/destroyed dynamically now instead of once).

- [ ] **Step 2: Add the overlay-series reconcile effect**

Insert this new effect right after the mount effect (before the existing
"Feed data whenever TF or klines change" effect):

```tsx
  // Reconcile overlay series (main pane 0) whenever the enabled set changes.
  // Overlay toggles never touch pane 1+, so no pane-index bug here — plain
  // add-if-missing / remove-if-present per key.
  useEffect(() => {
    if (!ready || !chartRef.current) return;
    const chart = chartRef.current;
    const has = (k: IndicatorKey) => enabledIndicators.includes(k);

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
  }, [ready, enabledIndicators]);
```

- [ ] **Step 3: Add the oscillator-pane full-reconcile effect**

Insert this effect right after the overlay-reconcile effect. This is the
fix for the P1 Codex caught: full remove-then-readd in fixed order,
sequential pane indices computed only from what's currently enabled —
never an incremental add/remove that could land a series in the wrong pane.

```tsx
  // Full reconcile for oscillator-pane indicators (rsi/stochRsi/macd/adx).
  // addSeries(..., paneIndex) does NOT insert a pane in the middle — if
  // paneIndex already exists it just adds to that pane. Incrementally
  // toggling one oscillator on/off while others stay enabled can therefore
  // land a re-enabled indicator in the wrong pane (Codex-caught P1). Fix:
  // whenever the oscillator subset of enabledIndicators changes, remove
  // ALL currently-mounted oscillator series and re-add the enabled ones
  // fresh, in fixed order (rsi, stochRsi, macd, adx), pane 1..N sequential.
  // Boolean deps (not the enabledIndicators array reference, and not a
  // joined string) so this satisfies react-hooks/exhaustive-deps cleanly —
  // Codex flagged a joined-string dep as functionally fine but lint-unclean
  // since the effect body still reads `enabledIndicators` as a whole.
  const rsiEnabled = enabledIndicators.includes("rsi");
  const stochRsiEnabled = enabledIndicators.includes("stochRsi");
  const macdEnabled = enabledIndicators.includes("macd");
  const adxEnabled = enabledIndicators.includes("adx");

  useEffect(() => {
    if (!ready || !chartRef.current) return;
    const chart = chartRef.current;

    ([rsiSeriesRef, stochKSeriesRef, stochDSeriesRef, macdHistSeriesRef, plusDISeriesRef, minusDISeriesRef, adxSeriesRef] as const).forEach(
      (ref) => {
        if (ref.current) {
          chart.removeSeries(ref.current);
          ref.current = null;
        }
      }
    );

    let paneIndex = 1;
    if (rsiEnabled) {
      rsiSeriesRef.current = chart.addSeries(LineSeries, { color: "#e91e63", lineWidth: 1, title: "RSI" }, paneIndex);
      paneIndex++;
    }
    if (stochRsiEnabled) {
      stochKSeriesRef.current = chart.addSeries(LineSeries, { color: "#4caf50", lineWidth: 1, title: "StochK" }, paneIndex);
      stochDSeriesRef.current = chart.addSeries(LineSeries, { color: "#ff9800", lineWidth: 1, title: "StochD" }, paneIndex);
      paneIndex++;
    }
    if (macdEnabled) {
      macdHistSeriesRef.current = chart.addSeries(HistogramSeries, { title: "MACD" }, paneIndex);
      paneIndex++;
    }
    if (adxEnabled) {
      plusDISeriesRef.current = chart.addSeries(LineSeries, { color: COLORS.bull, lineWidth: 1, title: "+DI" }, paneIndex);
      minusDISeriesRef.current = chart.addSeries(LineSeries, { color: COLORS.bear, lineWidth: 1, title: "-DI" }, paneIndex);
      adxSeriesRef.current = chart.addSeries(LineSeries, { color: "#9e9e9e", lineWidth: 1, title: "ADX" }, paneIndex);
    }

    // Force the data-feed effect to re-populate the freshly (re)created
    // series — bump a counter so its dependency array sees a change even
    // when rawKlines/selectedTF haven't changed.
    setOscillatorReconcileTick((t) => t + 1);
  }, [ready, rsiEnabled, stochRsiEnabled, macdEnabled, adxEnabled]);
```

Note: the `removeSeries` calls no longer need the awkward intersection-type
cast Codex flagged as unnecessary — each ref's own type
(`ISeriesApi<"Line"> | null` or `ISeriesApi<"Histogram"> | null`) already
satisfies `removeSeries(series: ISeriesApi<SeriesType>)` directly.

Add the new `oscillatorReconcileTick` state near the top with the other
`useState` calls:

```tsx
  const [oscillatorReconcileTick, setOscillatorReconcileTick] = useState(0);
```

- [ ] **Step 3b: Fix a pre-existing stale-price-line edge case surfaced by the new toggle (Codex-caught P2)**

The data-feed effect currently has `if (klines.length === 0) return;` right
after computing `klines` — before any S/R/price-line clearing runs. That was
harmless before (S/R was always on, so "no data" just meant "nothing to
draw yet"). Now that `sr` can be toggled OFF by the user while a TF happens
to have no data loaded, that early return would skip clearing existing S/R
lines, leaving stale lines on screen. Fix: move the price-line clear
(`priceLinesRef.current.forEach(...)`) to run unconditionally before the
`klines.length === 0` guard:

```tsx
    const klines = getClosedKlines(rawKlines[selectedTF] ?? []);
    if (klines.length === 0) {
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = [];
      return;
    }
```

- [ ] **Step 4: Gate the existing data-feed effect on `enabledIndicators` + the reconcile tick, and only set data for mounted series**

Modify the data-feed effect's dependency array (currently
`[ready, rawKlines, selectedTF]`) to:

```tsx
  }, [ready, rawKlines, selectedTF, enabledIndicators, oscillatorReconcileTick]);
```

Every `xSeriesRef.current?.setData(...)` call already no-ops safely via
optional chaining when the ref is `null` (disabled indicator) — no further
change needed there. But wrap the calc calls themselves so disabled
indicators skip computation entirely (not just skip the `setData`). Replace
the block from `const ema9Vals = calcEMASeries(...)` (current line 125)
through the S/R block with:

```tsx
    if (enabledIndicators.includes("ema")) {
      const ema9Vals = calcEMASeries(closes, 9);
      const ema21Vals = calcEMASeries(closes, 21);
      ema9SeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: ema9Vals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      ema21SeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: ema21Vals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("bb")) {
      const bb = calcBollingerSeries(closes, 20, 2);
      bbUpperSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: bb.upper[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      bbLowerSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: bb.lower[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("rsi")) {
      const rsiVals = calcRSISeriesAligned(closes);
      rsiSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: rsiVals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("stochRsi")) {
      const stoch = calcStochRSISeries(closes);
      stochKSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: stoch.kSeries[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      stochDSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: stoch.dSeries[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("macd")) {
      const macd = calcMACDSeries(closes);
      macdHistSeriesRef.current?.setData(
        times
          .map((t, i) => ({ time: t, value: macd.histogram[i] }))
          .filter((p): p is { time: UTCTimestamp; value: number } => p.value !== null)
          .map((p) => ({ ...p, color: p.value >= 0 ? COLORS.bull : COLORS.bear } as HistogramData<UTCTimestamp>))
      );
    }

    if (enabledIndicators.includes("supertrend")) {
      const superTrend = calcSuperTrendSeries(klines, 10, 3);
      superTrendSeriesRef.current?.setData(
        times
          .map((t, i) => ({ time: t, value: superTrend.value[i], trend: superTrend.trend[i] }))
          .filter((p): p is { time: UTCTimestamp; value: number; trend: "up" | "down" } => p.value !== null)
          .map((p) => ({ time: p.time, value: p.value, color: p.trend === "up" ? COLORS.bull : COLORS.bear } as LineData<UTCTimestamp>))
      );
    }

    if (enabledIndicators.includes("vwap")) {
      const showVwap = !["1d", "1w", "1M"].includes(selectedTF);
      const vwapVals = showVwap ? calcVWAPSeries(klines) : [];
      vwapSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: vwapVals[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("adx")) {
      const adxRes = calcADXSeries(klines, 14);
      plusDISeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: adxRes.plusDI[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      minusDISeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: adxRes.minusDI[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
      adxSeriesRef.current?.setData(
        times.map((t, i) => ({ time: t, value: adxRes.adx[i] })).filter((p): p is LineData<UTCTimestamp> => p.value !== null)
      );
    }

    if (enabledIndicators.includes("sr")) {
      const currentPrice = klines[klines.length - 1].close;
      const srLevels = detectSRLevels(klines, currentPrice);
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = srLevels.map((lvl) =>
        candleSeriesRef.current!.createPriceLine({
          price: lvl.price,
          color: lvl.kind === "support" ? COLORS.bull : COLORS.bear,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: lvl.kind === "support" ? "S" : "R",
        })
      );
    } else {
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = [];
    }
```

- [ ] **Step 5: Gate the rule-overlay effect on the `rules` indicator toggle**

Modify the existing "Draw rule entry/TP/SL overlay" effect's guard clause
(currently `if (!ready || !candleSeriesRef.current) return;`) to:

```tsx
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];
    if (!enabledIndicators.includes("rules")) return;

    const matching = activeAlerts.filter((a) => a.tfKey === selectedTF);
    // ... rest unchanged ...
  }, [ready, activeAlerts, selectedTF, enabledIndicators]);
```

(The line-clearing happens unconditionally before the early-return, so
disabling `rules` mid-session correctly removes existing lines.)

- [ ] **Step 6: Import `IndicatorKey` type**

Add to the existing `chartIndicators` usage — the import from Task 3 already
brought in `useChartIndicators`; also import the type used in this task's
`has()` helper and oscillator filter:

```tsx
import { IndicatorKey } from "../utils/chartIndicators";
```

(This can be merged into the same import line added in Task 3 Step 2 if not
already present.)

- [ ] **Step 7: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output

- [ ] **Step 8: Manual browser verification**

Using the dev server preview:
1. Open CHART tab — confirm default view shows candlestick + EMA + SuperTrend
   overlay + S/R + rule lines, and NO RSI/StochRSI/MACD/ADX panes (main
   candlestick pane should look visibly larger than the previous
   all-indicators-on layout).
2. Open Indicators panel, toggle "RSI (14)" on — confirm a new oscillator
   pane appears below the main chart with the RSI line.
3. Toggle "MACD" on too — confirm it appears in its own pane below RSI's.
4. Toggle "RSI (14)" off while MACD stays on — confirm MACD's pane doesn't
   disappear and RSI's pane is gone (this is the scenario that would have
   hit the P1 pane-index bug without the full-reconcile fix).
5. Toggle "RSI (14)" back on — confirm it reappears in its own pane (not
   overlapping MACD's).
6. Reload the page — confirm the same enabled set persists (AsyncStorage).
7. Open panel, click "Reset mặc định" — confirm it goes back to the
   ema/supertrend/sr/rules-only default.
8. Check `preview_console_logs` for errors after each step above.

- [ ] **Step 9: Commit**

```bash
cd btc-dashboard
git add components/TradingChartTab.web.tsx
git commit -m "feat: reactive indicator series lifecycle keyed on enabledIndicators"
```

---

## Task 5: Full typecheck + Codex audit + version bump

**Files:**
- Modify: `App.tsx` (version bump)
- Modify: `app.json` (version bump)

- [ ] **Step 1: Full project typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep -E "TradingChartTab|ChartIndicatorPanel|chartIndicators|useChartIndicators"`
Expected: no output

- [ ] **Step 2: Run the unit tests**

Run: `cd btc-dashboard && npx tsx --test hooks/useChartIndicators.test.ts`
Expected: PASS (6 tests, 0 failures)

- [ ] **Step 3: Codex audit (mandatory per project CLAUDE.md — this changes rule-signal-adjacent chart display code)**

Run via `scripts/codex/ask.sh` (read-only), pointed at
`components/TradingChartTab.web.tsx`, `components/ChartIndicatorPanel.tsx`,
`components/ChartIndicatorPanel.web.tsx`, `hooks/useChartIndicators.ts`,
`utils/chartIndicators.ts`. Ask specifically:
1. Does the oscillator full-reconcile effect correctly avoid the P1
   pane-index bug in every toggle-order scenario (not just the one manually
   tested)?
2. Any memory leak from repeated `addSeries`/`removeSeries` cycles (e.g. if
   a user rapidly toggles an indicator on/off many times)?
3. Does disabling `rules` or `sr` actually clear existing price lines, or
   could stale lines survive a toggle-off?
4. Does the `oscillatorReconcileTick` counter correctly force a re-feed
   without ever causing a stale-data flash (old pane's data briefly shown
   in a new pane before `setData` runs)?

Paste findings into the task notes; fix any P1 before moving to Step 4.

- [ ] **Step 4: Bump version (minor bump — new feature, per project CLAUDE.md rule)**

Read current version from `App.tsx`'s `APP_VERSION` constant, bump the
minor component (e.g. `4.11.8` → `4.12.0`), update `BUILD_DATE` to today's
date, and sync `app.json`'s `expo.version` to match — same 3-place bump
already required by this project's existing convention.

- [ ] **Step 5: Commit the version bump**

```bash
cd btc-dashboard
git add App.tsx app.json
git commit -m "chore: bump version for indicator toggle panel feature"
```

(Do NOT run `npm run build:web:deploy` here — that step only happens when
Tommy explicitly says "build", per project convention. This plan ends at a
committed, typechecked, manually-verified, Codex-audited state.)

---

## Self-Review Notes (from writing-plans skill)

- **Spec coverage:** registry (Task 1) ✓, persistence+validation (Task 1) ✓,
  shared panel content (Task 2) ✓, platform-adapted presentation — web
  popover done (Task 3); **native bottom-sheet wrapper
  (`ChartIndicatorPanel.native.tsx`) is NOT included in this plan** — the
  spec's "Files touched" section calls for it, but `TradingChartTab.native.tsx`
  currently only renders a fallback message (no real chart), so there is
  nothing to attach a native indicator panel to yet. Deferred until a native
  chart implementation exists; tracked as an explicit gap, not silently
  dropped.
- Full oscillator-pane reconcile (Task 4) ✓ addresses the Codex P1.
- Default set chart-space-first (Task 1's `DEFAULT_ENABLED_INDICATORS`) ✓.
- Out-of-scope items from spec (status-line, per-indicator settings) —
  correctly not present in any task.
- **Post-plan-audit fixes (2nd Codex pass on this plan, all P2, no P1):**
  hydration race guarded via `userInteracted` ref (Task 1); oscillator
  reconcile effect deps switched from a joined string to individual boolean
  deps for clean `exhaustive-deps` (Task 4 Step 3); removed an unnecessary
  type-cast on `removeSeries` calls (Task 4 Step 3); trigger button moved
  from the TF row into an absolutely-positioned floating button over the
  chart area, matching the spec's "floating, top-right of chart" wording
  (Task 3 Step 2); added Step 3b to fix a stale-price-line edge case when
  toggling `sr` off on a TF with no loaded data. Version bump number and
  `npx tsx --test` invocation both confirmed correct against current repo
  state.
