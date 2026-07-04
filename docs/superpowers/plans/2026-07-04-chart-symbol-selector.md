# Chart Tab Symbol Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a BTC/ETH/ETHFI/SOL selector to the CHART tab so Tommy can view
candlestick charts for other coins, while every other panel (rule engine,
alerts) keeps tracking BTC exactly as today.

**Architecture:** New standalone hook `useSymbolKlines(symbol)` fetches
klines directly from Binance for a given symbol (mirrors the existing
Binance-direct fallback in `useBinanceKlines`, without the BTC-only server
proxy or the TFAnalysis/AsyncStorage machinery). `TradingChartTab.web.tsx`
picks between the `rawKlines` prop (BTC, already fetched by `App.tsx`) and
this new hook's data based on which symbol is selected, and gates
"ready-to-render" on the fetched data actually matching the selected
symbol (no mislabeled-stale-chart).

**Tech Stack:** React hooks, Binance public REST API, existing
`lightweight-charts` chart already in `TradingChartTab.web.tsx`.

**Spec:** `docs/superpowers/specs/2026-07-04-chart-symbol-selector-design.md`

---

## Task 1: `useSymbolKlines` hook (TDD)

**Files:**
- Create: `hooks/useSymbolKlines.ts`
- Test: `hooks/useSymbolKlines.test.ts`

This hook is intentionally pure-logic-testable: the fetch function and the
stale-response guard are the two things worth unit testing. Since it's a
React hook (uses `useState`/`useEffect`), we test it by extracting the pure
parsing function separately and testing that directly — full hook-lifecycle
testing (mount/unmount timing) is covered by manual browser verification in
Task 4, not automated tests, matching how `useBinanceKlines` itself has no
test file.

- [ ] **Step 1: Write the failing test for kline-tuple parsing**

```ts
// hooks/useSymbolKlines.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseBinanceKlineTuples } from "./useSymbolKlines";

test("parseBinanceKlineTuples: maps Binance kline tuples to Kline objects", () => {
  const tuples = [
    [1700000000000, "100.5", "110.2", "90.1", "105.3", "42.7", 1700000299999, true],
    [1700000300000, "105.3", "108.0", "103.0", "104.0", "17.1", 1700000599999, false],
  ];
  const result = parseBinanceKlineTuples(tuples);
  assert.deepEqual(result, [
    { time: 1700000000000, closeTime: 1700000299999, isClosed: true, open: 100.5, high: 110.2, low: 90.1, close: 105.3, volume: 42.7 },
    { time: 1700000300000, closeTime: 1700000599999, isClosed: false, open: 105.3, high: 108.0, low: 103.0, close: 104.0, volume: 17.1 },
  ]);
});

test("parseBinanceKlineTuples: empty input returns empty array", () => {
  assert.deepEqual(parseBinanceKlineTuples([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd btc-dashboard && npx tsx --test hooks/useSymbolKlines.test.ts`
Expected: FAIL — `useSymbolKlines.ts` does not exist yet

- [ ] **Step 3: Write the hook**

```ts
// hooks/useSymbolKlines.ts
import { useState, useEffect, useRef } from "react";
import { BINANCE_REST, TIMEFRAMES } from "../utils/constants";
import { Kline, RawKlinesMap } from "./useBinanceKlines";

export function parseBinanceKlineTuples(tuples: any[]): Kline[] {
  return tuples.map((k: any[]) => ({
    time: k[0],
    closeTime: typeof k[6] === "number" ? k[6] : undefined,
    isClosed: typeof k[7] === "boolean" ? k[7] : (typeof k[6] === "number" ? k[6] < Date.now() : false),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

interface UseSymbolKlinesResult {
  rawKlines: RawKlinesMap;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches klines for a single Binance symbol across all TIMEFRAMES, direct
 * from the public Binance REST API (no server proxy — that only caches
 * BTC). Intentionally separate from useBinanceKlines: that hook also feeds
 * the BTC-only rule engine (useRuleAlerts, useAlerts, useRiskRadar, etc.)
 * and must not be parameterized, to avoid any risk of an accidental
 * behavior change to live trading signals.
 *
 * symbol=null means "not fetching" (used when the chart is showing BTC,
 * which reuses the rawKlines prop from App.tsx instead of a second fetch).
 */
export function useSymbolKlines(symbol: string | null): UseSymbolKlinesResult {
  const [rawKlines, setRawKlines] = useState<RawKlinesMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks which symbol the current `rawKlines` state actually belongs to —
  // read by TradingChartTab to detect "fetch still in flight for a symbol
  // switch" vs "data is ready for the currently-selected symbol".
  const dataSymbolRef = useRef<string | null>(null);

  useEffect(() => {
    if (!symbol) {
      setRawKlines({});
      dataSymbolRef.current = null;
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchForSymbol = async () => {
      setLoading(true);
      try {
        const results = await Promise.all(
          TIMEFRAMES.map(async (tf) => {
            const url = `${BINANCE_REST}/klines?symbol=${symbol}&interval=${tf.interval}&limit=${tf.limit}`;
            const res = await fetch(url);
            if (res.status === 429 || res.status === 418) {
              throw new Error(`Rate limited (${res.status}) cho ${tf.label} — sẽ thử lại sau`);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status} cho ${tf.label}`);
            const data = await res.json();
            return { tf, data };
          })
        );

        // Stale-response guard: a slower fetch for a symbol the user has
        // since switched away from must not overwrite newer state.
        if (cancelled) return;

        const newRawKlines: RawKlinesMap = {};
        for (const { tf, data } of results) {
          newRawKlines[tf.key] = parseBinanceKlineTuples(data);
        }

        if (cancelled) return;
        setRawKlines(newRawKlines);
        dataSymbolRef.current = symbol;
        setLoading(false);
        setError(null);
      } catch (e: any) {
        if (cancelled) return;
        setError(e.message || "Lỗi tải dữ liệu");
        setLoading(false);
      }
    };

    fetchForSymbol();
    const interval = setInterval(fetchForSymbol, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol]);

  // Only expose data once it actually belongs to the requested symbol —
  // prevents a caller from briefly seeing a previous symbol's candles
  // under the current symbol's label (Codex-caught P1 in the spec).
  const isDataReady = symbol !== null && dataSymbolRef.current === symbol;

  return {
    rawKlines: isDataReady ? rawKlines : {},
    loading,
    error,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd btc-dashboard && npx tsx --test hooks/useSymbolKlines.test.ts`
Expected: PASS (2/2 tests)

- [ ] **Step 5: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep useSymbolKlines`
Expected: no output

- [ ] **Step 6: Commit**

```bash
cd btc-dashboard
git add hooks/useSymbolKlines.ts hooks/useSymbolKlines.test.ts
git commit -m "feat: useSymbolKlines hook for non-BTC chart symbols (stale-fetch guarded)"
```

---

## Task 2: Symbol state + data source switch in TradingChartTab.web.tsx

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Add the import and symbol constant map**

Add to the top imports:

```tsx
import { useSymbolKlines } from "../hooks/useSymbolKlines";
```

Add above the component (after the `OverlaySeriesRefs`/`reconcileOverlaySeries`
block, before `export default function TradingChartTab(...)`):

```tsx
type ChartSymbol = "BTC" | "ETH" | "ETHFI" | "SOL";
const CHART_SYMBOLS: ChartSymbol[] = ["BTC", "ETH", "ETHFI", "SOL"];
const SYMBOL_TO_BINANCE: Record<ChartSymbol, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  ETHFI: "ETHFIUSDT",
  SOL: "SOLUSDT",
};
```

- [ ] **Step 2: Add symbol state + hook call + activeKlines/isSymbolDataReady**

Add near the other `useState` calls (after `const indicatorBtnRef = useRef<View>(null);`):

```tsx
  const [selectedSymbol, setSelectedSymbol] = useState<ChartSymbol>("BTC");
  const {
    rawKlines: fetchedKlines,
    loading: symbolLoading,
    error: symbolError,
  } = useSymbolKlines(selectedSymbol === "BTC" ? null : SYMBOL_TO_BINANCE[selectedSymbol]);

  // BTC reuses the rawKlines prop (already fetched app-wide for the rule
  // engine) — no second fetch. Non-BTC symbols use the standalone hook.
  // isSymbolDataReady gates the data-feed effect: for non-BTC, the hook
  // only returns non-empty rawKlines once they actually belong to the
  // selected symbol (see useSymbolKlines's isDataReady check) — so
  // fetchedKlines being non-empty here already implies "matches selectedSymbol".
  const activeKlines = selectedSymbol === "BTC" ? rawKlines : fetchedKlines;
  const isSymbolDataReady = selectedSymbol === "BTC" || Object.keys(fetchedKlines).length > 0;
```

- [ ] **Step 3: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output

- [ ] **Step 4: Commit**

```bash
cd btc-dashboard
git add components/TradingChartTab.web.tsx
git commit -m "feat: add selectedSymbol state + useSymbolKlines wiring (not yet used by effects)"
```

---

## Task 3: Switch data-feed effect to activeKlines, gate on isSymbolDataReady

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Update the data-feed effect's early guards and klines source**

Find:

```tsx
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    const klines = getClosedKlines(rawKlines[selectedTF] ?? []);
    if (klines.length === 0) {
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = [];
      return;
    }
```

Replace with:

```tsx
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    if (!isSymbolDataReady) return; // symbol switch in flight — chart clears via the loading overlay, not stale data
    const klines = getClosedKlines(activeKlines[selectedTF] ?? []);
    if (klines.length === 0) {
      priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
      priceLinesRef.current = [];
      return;
    }
```

- [ ] **Step 2: Update the effect's dependency array**

Find:

```tsx
  }, [ready, rawKlines, selectedTF, enabledIndicators, oscillatorReconcileTick, candleSwapTick]);
```

Replace with:

```tsx
  }, [ready, activeKlines, isSymbolDataReady, selectedTF, enabledIndicators, oscillatorReconcileTick, candleSwapTick]);
```

- [ ] **Step 3: Clear the chart when a symbol switch is in flight (mislabeled-stale-chart fix)**

Add a new effect, placed right after the data-feed effect (before the
rule-overlay effect):

```tsx
  // Clear the candle/volume series while a symbol switch's fetch is still
  // in flight — prevents briefly showing the PREVIOUS symbol's candles
  // under the newly-selected symbol's label (Codex-caught P1 in the spec).
  // Timeframe switches (selectedSymbol unchanged) are unaffected: this only
  // fires when isSymbolDataReady flips to false, which happens on symbol
  // change, not TF change.
  useEffect(() => {
    if (!ready || !candleSeriesRef.current || isSymbolDataReady) return;
    candleSeriesRef.current.setData([]);
    volumeSeriesRef.current?.setData([]);
  }, [ready, isSymbolDataReady]);
```

- [ ] **Step 4: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output

- [ ] **Step 5: Commit**

```bash
cd btc-dashboard
git add components/TradingChartTab.web.tsx
git commit -m "feat: data-feed effect reads activeKlines, clears chart during symbol-switch fetch"
```

---

## Task 4: Suppress Rule Entry/TP/SL when symbol != BTC

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Add the guard to the rule-overlay effect**

Find:

```tsx
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];
    if (!enabledIndicators.includes("rules")) return;
```

Replace with:

```tsx
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
    alertLinesRef.current = [];
    if (!enabledIndicators.includes("rules")) return;
    // Rule Entry/TP/SL lines come from activeAlerts, which is always BTC
    // rule data — suppress on non-BTC symbols rather than drawing BTC
    // price levels on an ETH/ETHFI/SOL chart. The Indicators checkbox
    // itself stays whatever the user left it (not auto-toggled off) — this
    // is a display suppression, not a preference change (see spec).
    if (selectedSymbol !== "BTC") return;
```

- [ ] **Step 2: Update this effect's dependency array**

Find:

```tsx
  }, [ready, activeAlerts, selectedTF, enabledIndicators, candleSwapTick]);
```

Replace with:

```tsx
  }, [ready, activeAlerts, selectedTF, enabledIndicators, candleSwapTick, selectedSymbol]);
```

- [ ] **Step 3: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output

- [ ] **Step 4: Commit**

```bash
cd btc-dashboard
git add components/TradingChartTab.web.tsx
git commit -m "feat: suppress Rule Entry/TP/SL lines when chart symbol is not BTC"
```

---

## Task 5: Symbol selector UI row + loading/error display

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

This task adds the visible button row above the existing timeframe row, and
the loading/error text. First locate the existing timeframe row's JSX to
match its style.

- [ ] **Step 1: Confirmed existing timeframe row style (already verified against the file)**

The timeframe row is at `components/TradingChartTab.web.tsx:457` —
`<View style={styles.tfRow}>` — and its button style (`:492-494`) is:

```tsx
tfRow: { flexDirection: "row", gap: 8, padding: 8 },
tfBtn: { color: P.dim, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4 },
tfBtnActive: { color: P.primaryContainer, fontWeight: "700" },
```

Note these are `Text` styles applied directly (color-only, no background) —
the new symbol row mirrors this exact pattern, not a background-pill style.

- [ ] **Step 2: Add the symbol row JSX directly above the timeframe row**

In the render return, immediately before the `<View style={styles.tfRow}>`
at line 457, add:

```tsx
        <View style={styles.symbolRow}>
          {CHART_SYMBOLS.map((sym) => (
            <Text
              key={sym}
              onPress={() => setSelectedSymbol(sym)}
              style={[styles.symbolBtn, selectedSymbol === sym && styles.symbolBtnActive]}
            >
              {sym}
            </Text>
          ))}
          {selectedSymbol !== "BTC" && !isSymbolDataReady && !symbolError && (
            <Text style={styles.symbolStatusText}>Đang tải {selectedSymbol}...</Text>
          )}
          {selectedSymbol !== "BTC" && symbolError && (
            <Text style={styles.symbolErrorText}>{symbolError}</Text>
          )}
        </View>
```

This mirrors the existing `tfRow`/`tfBtn` pattern exactly (plain `Text`
with `onPress`, color-only active state — no `Pressable`/background pill).

- [ ] **Step 3: Add the styles**

Find the `StyleSheet.create({...})` block (starts around line 490, grep for
`const styles = StyleSheet.create`) and add these entries, matching the
existing `tfRow`/`tfBtn`/`tfBtnActive` pattern exactly (verified against
`utils/v2Theme.ts`: `P.dim` and `P.primaryContainer` are real tokens
already used by `tfBtn`/`tfBtnActive`; `COLORS.bear` is already imported
via `../utils/constants`):

```tsx
  symbolRow: { flexDirection: "row", gap: 8, paddingHorizontal: 8, paddingTop: 8, alignItems: "center" },
  symbolBtn: { color: P.dim, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4, fontWeight: "700" as const },
  symbolBtnActive: { color: P.primaryContainer },
  symbolStatusText: { color: P.dim, fontSize: 10, fontFamily: "monospace", marginLeft: 4 },
  symbolErrorText: { color: COLORS.bear, fontSize: 10, fontFamily: "monospace", marginLeft: 4 },
```

- [ ] **Step 4: Typecheck**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep TradingChartTab`
Expected: no output

- [ ] **Step 5: Commit**

```bash
cd btc-dashboard
git add components/TradingChartTab.web.tsx
git commit -m "feat: add BTC/ETH/ETHFI/SOL symbol selector row above timeframe row"
```

---

## Task 6: Full manual verification + Codex audit

**Files:**
- None (verification only)

- [ ] **Step 1: Typecheck + run all chart-related tests**

Run: `cd btc-dashboard && npx tsc --noEmit 2>&1 | grep -E "TradingChartTab|useSymbolKlines|chartDataMapper|chartIndicators"`
Run: `cd btc-dashboard && npx tsx --test hooks/useSymbolKlines.test.ts hooks/useChartIndicators.test.ts utils/chartDataMapper.test.ts`
Expected: both clean / all passing

- [ ] **Step 2: Manual browser verification**

Using the dev server preview, on the CHART tab:
1. Confirm default view is BTC (unchanged from before this feature).
2. Click ETH — confirm chart briefly clears/shows "Đang tải ETH..." then
   renders ETH candles (different price scale than BTC, obviously).
3. Confirm indicators (EMA, SuperTrend, RSI, etc. — whichever are enabled)
   recompute and draw correctly against ETH data.
4. Confirm "Rule Entry/TP/SL" lines are NOT drawn while on ETH, even if
   that indicator's checkbox is still toggled on in the Indicators panel.
5. Click SOL immediately after ETH (before ETH's chart fully settles) —
   confirm no ETH candles leak into the SOL view (race-guard check).
6. Click BTC — confirm instant return to BTC data (no fetch delay, reuses
   the existing `rawKlines` prop) and Rule Entry/TP/SL lines reappear if
   the checkbox is on.
7. Switch timeframe (5M/15M/1H/...) while on ETH — confirm no flash/reload
   of the chart (all TFs were already fetched together for ETH).
8. Check `preview_console_logs` for errors throughout — must stay clean.

- [ ] **Step 3: Codex audit (mandatory per project convention)**

Run `scripts/codex/ask.sh` (read-only) pointed at the full diff since this
plan's first commit. Ask specifically about: the stale-response guard's
correctness under rapid symbol switching, whether `isSymbolDataReady`
correctly gates all the places that need it (data-feed effect, the new
clear-on-switch effect, rule-overlay effect), any other bug in the diff,
and whether `ETHFIUSDT`/`SOLUSDT`/`ETHUSDT` are being used correctly as
literal Binance REST symbol params. Fix any P1 before proceeding.

- [ ] **Step 4: Bump version (minor — new feature) and commit**

Read `APP_VERSION` from `App.tsx`, bump minor (e.g. `4.12.1` → `4.13.0`),
update `BUILD_DATE` to the current date, sync `app.json`.

```bash
cd btc-dashboard
git add App.tsx app.json
git commit -m "chore: bump version for chart symbol selector feature"
```

(Do NOT run the build/deploy script — only on explicit "build" command.)

---

## Self-Review Notes

- **Spec coverage:** hook + stale-fetch guard (Task 1) ✓, symbol state +
  data source switch (Task 2) ✓, data-feed effect reads `activeKlines` +
  gates on `isSymbolDataReady` (Task 3) ✓, mislabeled-stale-chart fix via
  clear-on-switch effect (Task 3 Step 3 — this is the second Codex-caught
  P1 from the spec, now an explicit step) ✓, Rule Entry/TP/SL suppression
  (Task 4) ✓, UI row + loading/error text (Task 5) ✓, full verification +
  Codex audit + version bump (Task 6) ✓.
- Out-of-scope items from the spec (no persistence, no native changes, no
  `useBinanceKlines`/rule-engine changes) — plan never touches
  `hooks/useBinanceKlines.ts`, `hooks/useRuleAlerts.ts`, or
  `TradingChartTab.native.tsx`, matching the spec's explicit exclusions.
- Type consistency check: `ChartSymbol`, `SYMBOL_TO_BINANCE`, `selectedSymbol`,
  `activeKlines`, `isSymbolDataReady` names are used identically across
  Tasks 2–5 — no renaming drift between tasks.
