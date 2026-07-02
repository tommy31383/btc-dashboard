# TradingView-style chart tab (replace "5m ALL") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "5m ALL" bottom-nav tab (paper-trading engine) with a full-screen `lightweight-charts`-based chart tab that overlays the app's own rule-signal (entry/TP/SL), and remove the 5m ALL paper engine and its now-dead surface area.

**Architecture:** Two new platform-specific files (`components/TradingChartTab.web.tsx` / `.native.tsx`) feed off the existing `RawKlinesMap`, `utils/indicators.ts`, and `utils/supportResistance.ts` — no new data fetching. The "5m ALL" removal cuts across `App.tsx`, `BottomNavBar.tsx`, `LiveTab.tsx`, and deletes `All5mPanel.tsx` / `use5mAllTrader.ts` / `all5mAccount.ts` / `UnifiedTradesPanel.tsx` (confirmed dead code).

**Tech Stack:** Expo (React Native + react-native-web), TypeScript, `lightweight-charts` (new dependency, web-only via Metro's `.web.tsx` resolution).

Reference spec: `docs/superpowers/specs/2026-07-01-tradingview-chart-tab-design.md` (includes Codex-audited corrections — read it once before starting, not per-task).

---

### Task 1: Add `lightweight-charts` dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (via npm, not by hand)

- [ ] **Step 1: Install the package**

Run: `npm install lightweight-charts@^5`
Expected: `package.json` gains `"lightweight-charts": "^5.x.x"` under `"dependencies"`, `package-lock.json` updates.

- [ ] **Step 2: Verify the multi-pane / price-line API this plan relies on**

Run: `grep -n "addPriceLine\|addPane\|createChart" node_modules/lightweight-charts/dist/typings.d.ts | head -30`

Read enough of `node_modules/lightweight-charts/dist/typings.d.ts` to confirm:
- Whether `addPriceLine` is a method on a *series* (`ISeriesApi.createPriceLine(...)`) or on the chart itself.
- Whether multi-pane (RSI/Stoch/MACD in separate panes) is via `chart.addPane()`/a `paneIndex` option on `addSeries`, or requires separate `createChart()` instances stacked in the DOM.

Write down the confirmed shape in a one-line code comment at the top of `TradingChartTab.web.tsx` in Task 3 (e.g. `// verified: ISeriesApi<'Candlestick'>.createPriceLine(...); panes via addSeries(..., paneIndex)`). This replaces the "unverified assumption" flagged in the spec — do not guess past this point.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add lightweight-charts dependency for new chart tab"
```

---

### Task 2: Kline → lightweight-charts data mapper (pure function, TDD)

**Files:**
- Create: `utils/chartDataMapper.ts`
- Test: `utils/chartDataMapper.test.ts`

**Corrected note on test runner (2026-07-02, after Task 2 dispatch hit NEEDS_CONTEXT):**
this repo (`btc-dashboard`) has **no test runner set up at all** — no `"test"` script,
no Jest, no `tsx`/`ts-node` installed. The `test/*.test.mjs` convention referenced in
an earlier draft of this plan was copied from the *sibling* `btc-trader-server`
project by mistake — it does not apply here. The only existing precedent in this repo
is `tools/chart-v2-closed-bars.test.ts`: a `.ts` file, sibling to the code it tests
(not a separate `test/`/`__tests__` folder), using `node:assert/strict` + `node:test`.
Follow that precedent: create `utils/chartDataMapper.test.ts` next to
`utils/chartDataMapper.ts`, and run it via `npx tsx --test utils/chartDataMapper.test.ts`
(`tsx` downloads on-demand via `npx`, do NOT add it as a project devDependency — this
plan doesn't establish new test infra project-wide, just verifies this one file).

- [ ] **Step 1: Write the failing test**

Create `utils/chartDataMapper.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { klinesToCandlestickData, klinesToVolumeData } from "./chartDataMapper";

test("klinesToCandlestickData converts ms time to seconds and maps OHLC", () => {
  const klines = [
    { time: 1719800000000, open: 100, high: 110, low: 90, close: 105, volume: 50 },
    { time: 1719800300000, open: 105, high: 108, low: 102, close: 106, volume: 40 },
  ];
  const result = klinesToCandlestickData(klines);
  assert.deepEqual(result, [
    { time: 1719800000, open: 100, high: 110, low: 90, close: 105 },
    { time: 1719800300, open: 105, high: 108, low: 102, close: 106 },
  ]);
});

test("klinesToVolumeData converts time to seconds and colors by direction", () => {
  const klines = [
    { time: 1719800000000, open: 100, high: 110, low: 90, close: 105, volume: 50 }, // up (close>=open)
    { time: 1719800300000, open: 105, high: 108, low: 90, close: 100, volume: 40 }, // down
  ];
  const result = klinesToVolumeData(klines, { upColor: "#2ed573", downColor: "#ff4757" });
  assert.equal(result[0].time, 1719800000);
  assert.equal(result[0].value, 50);
  assert.equal(result[0].color, "#2ed573");
  assert.equal(result[1].color, "#ff4757");
});

test("klinesToCandlestickData returns empty array for empty input", () => {
  assert.deepEqual(klinesToCandlestickData([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test utils/chartDataMapper.test.ts`
Expected: FAIL — `Cannot find module './chartDataMapper'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `utils/chartDataMapper.ts`:

```ts
import { Kline } from "../hooks/useBinanceKlines";

export interface CandlestickPoint {
  time: number; // seconds (UTCTimestamp) — lightweight-charts does NOT accept ms
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumePoint {
  time: number; // seconds
  value: number;
  color: string;
}

/** Kline.time is milliseconds (Binance convention used app-wide) — lightweight-charts
 *  expects seconds. This is the ONLY place that conversion happens for the chart tab. */
export function klinesToCandlestickData(klines: Kline[]): CandlestickPoint[] {
  return klines.map((k) => ({
    time: Math.floor(k.time / 1000),
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
  }));
}

export function klinesToVolumeData(
  klines: Kline[],
  colors: { upColor: string; downColor: string }
): VolumePoint[] {
  return klines.map((k) => ({
    time: Math.floor(k.time / 1000),
    value: k.volume,
    color: k.close >= k.open ? colors.upColor : colors.downColor,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test utils/chartDataMapper.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/chartDataMapper.ts utils/chartDataMapper.test.ts
git commit -m "feat: add Kline→lightweight-charts data mapper with ms→s time conversion"
```

---

### Task 3: `TradingChartTab.web.tsx` — core chart (candlestick + volume + EMA/BB)

**Files:**
- Create: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Write the component**

```tsx
import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Text } from "react-native";
import { createChart, IChartApi, ISeriesApi, ColorType, CandlestickSeries, HistogramSeries, LineSeries } from "lightweight-charts";
import { COLORS, TIMEFRAMES, TimeframeKey } from "../utils/constants";
import { P } from "../utils/v2Theme";
import { RawKlinesMap, closedKlines as getClosedKlines } from "../hooks/useBinanceKlines";
import { calcEMASeries, calcBollingerSeries } from "../utils/indicators";
import { klinesToCandlestickData, klinesToVolumeData } from "../utils/chartDataMapper";
import { RuleAlert } from "../hooks/useRuleAlerts";
import DebugLabel from "./DebugLabel";

interface Props {
  rawKlines: RawKlinesMap;
  selectedTF: TimeframeKey;
  onSelectTF: (tf: TimeframeKey) => void;
  activeAlerts: RuleAlert[];
}

export default function TradingChartTab({ rawKlines, selectedTF, onSelectTF, activeAlerts }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<any[]>([]);
  const [ready, setReady] = useState(false);

  // Mount chart once
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
    const ema9 = chart.addSeries(LineSeries, { color: "#f7931a", lineWidth: 1, title: "EMA9" });
    const ema21 = chart.addSeries(LineSeries, { color: "#00bcd4", lineWidth: 1, title: "EMA21" });
    const bbUpper = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Upper" });
    const bbLower = chart.addSeries(LineSeries, { color: "#888", lineWidth: 1, title: "BB Lower" });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ema9SeriesRef.current = ema9;
    ema21SeriesRef.current = ema21;
    bbUpperSeriesRef.current = bbUpper;
    bbLowerSeriesRef.current = bbLower;
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

  // Feed data whenever TF or klines change
  useEffect(() => {
    if (!ready || !candleSeriesRef.current) return;
    const klines = getClosedKlines(rawKlines[selectedTF] ?? []);
    if (klines.length === 0) return;

    candleSeriesRef.current.setData(klinesToCandlestickData(klines));
    volumeSeriesRef.current?.setData(klinesToVolumeData(klines, { upColor: COLORS.bull + "80", downColor: COLORS.bear + "80" }));

    const closes = klines.map((k) => k.close);
    const times = klines.map((k) => Math.floor(k.time / 1000));
    const ema9Vals = calcEMASeries(closes, 9);
    const ema21Vals = calcEMASeries(closes, 21);
    const bb = calcBollingerSeries(closes, 20, 2);

    ema9SeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: ema9Vals[i] })).filter((p): p is { time: number; value: number } => p.value !== null)
    );
    ema21SeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: ema21Vals[i] })).filter((p): p is { time: number; value: number } => p.value !== null)
    );
    bbUpperSeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: bb.upper[i] })).filter((p): p is { time: number; value: number } => p.value !== null)
    );
    bbLowerSeriesRef.current?.setData(
      times.map((t, i) => ({ time: t, value: bb.lower[i] })).filter((p): p is { time: number; value: number } => p.value !== null)
    );
  }, [ready, rawKlines, selectedTF]);

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
      <div ref={containerRef} style={{ flex: 1, width: "100%", height: "100%" }} />
      <Text style={styles.attribution}>Powered by TradingView Lightweight Charts</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: P.bg },
  tfRow: { flexDirection: "row", gap: 8, padding: 8 },
  tfBtn: { color: P.dim, fontSize: 12, paddingHorizontal: 8, paddingVertical: 4 },
  tfBtnActive: { color: P.primaryContainer, fontWeight: "700" },
  attribution: { color: P.dim, fontSize: 9, textAlign: "center", padding: 4 },
});
```

Adjust `addSeries(CandlestickSeries, ...)` vs. `addCandlestickSeries(...)` and `.createPriceLine` placement per whatever Task 1 Step 2 confirmed against the actually-installed version — the snippet above is v5-style (`addSeries` + series-type constant), which is what `lightweight-charts@^5` uses, but verify before assuming.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep TradingChartTab`
Expected: no output (no errors in this file). If there are errors from the `lightweight-charts` type imports, fix the import names against Task 1 Step 2's findings before moving on.

- [ ] **Step 3: Commit**

```bash
git add components/TradingChartTab.web.tsx
git commit -m "feat: TradingChartTab.web — candlestick + volume + EMA/BB via lightweight-charts"
```

---

### Task 4: Add RSI / StochRSI / MACD panes + S/R lines + rule overlay to `TradingChartTab.web.tsx`

**Files:**
- Modify: `components/TradingChartTab.web.tsx`

- [ ] **Step 1: Add indicator panes**

Extend the mount effect from Task 3 to add 3 more series (RSI, StochRSI K/D, MACD histogram) using whatever pane mechanism Task 1 Step 2 confirmed (`paneIndex` option on `addSeries`, most likely `{ paneIndex: 1 }`, `{ paneIndex: 2 }`, `{ paneIndex: 3 }` for v5). Add refs (`rsiSeriesRef`, `stochKSeriesRef`, `stochDSeriesRef`, `macdHistSeriesRef`) alongside the existing ones, mirroring the pattern already in the file.

Feed them in the data effect using `calcRSISeriesAligned(closes)`, `calcStochRSISeries(closes)`, `calcMACDSeries(closes)` (already imported in `utils/indicators.ts` — add these three imports to the existing import line from Task 3).

- [ ] **Step 2: Add S/R price lines**

In the data effect, after setting candle data:

```ts
import { detectSRLevels } from "../utils/supportResistance";
// ...
const currentPrice = klines[klines.length - 1].close;
const srLevels = detectSRLevels(klines, currentPrice);
priceLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
priceLinesRef.current = srLevels.map((lvl) =>
  candleSeriesRef.current!.createPriceLine({
    price: lvl.price,
    color: lvl.kind === "support" ? COLORS.bull : COLORS.bear,
    lineWidth: 1,
    lineStyle: 2, // dashed — verify this is the correct LineStyle enum value/import
    title: lvl.kind === "support" ? "S" : "R",
  })
);
```

Verify `createPriceLine` exists on the series API (per Task 1 Step 2) and that `removePriceLine` is the correct cleanup method name before finalizing — adjust names if the installed version differs.

- [ ] **Step 3: Add rule-signal overlay (entry/TP/SL)**

Add an effect keyed on `[ready, activeAlerts, selectedTF]` that filters `activeAlerts` to `a.tfKey === selectedTF`, clears any previously-drawn alert price-lines (track them in a separate ref, e.g. `alertLinesRef`), then draws one entry line + one TP line (green) + one SL line (red) per matching alert via `createPriceLine`, each `title` set to the rule id (e.g. `#2 ENTRY`, `#2 TP`, `#2 SL`).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep TradingChartTab`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add components/TradingChartTab.web.tsx
git commit -m "feat: TradingChartTab.web — RSI/Stoch/MACD panes + S/R lines + rule entry/TP/SL overlay"
```

---

### Task 5: `TradingChartTab.native.tsx` — fallback

**Files:**
- Create: `components/TradingChartTab.native.tsx`

- [ ] **Step 1: Write the fallback component**

```tsx
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { P } from "../utils/v2Theme";
import DebugLabel from "./DebugLabel";
import { RawKlinesMap } from "../hooks/useBinanceKlines";
import { TimeframeKey } from "../utils/constants";
import { RuleAlert } from "../hooks/useRuleAlerts";

interface Props {
  rawKlines: RawKlinesMap;
  selectedTF: TimeframeKey;
  onSelectTF: (tf: TimeframeKey) => void;
  activeAlerts: RuleAlert[];
}

// Intentionally does NOT import "lightweight-charts" (DOM-only library) — this file
// is the native counterpart Metro resolves for iOS/Android builds.
export default function TradingChartTab(_props: Props) {
  return (
    <View style={styles.container}>
      <DebugLabel name="TradingChartTab.native" />
      <Text style={styles.text}>
        Chart chuyên nghiệp hiện chỉ hỗ trợ bản web.{"\n"}Mở trên trình duyệt để xem đầy đủ.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: P.bg },
  text: { color: P.dim, textAlign: "center", fontSize: 14 },
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep TradingChartTab`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add components/TradingChartTab.native.tsx
git commit -m "feat: TradingChartTab.native — web-only fallback message"
```

---

### Task 6: Wire the new tab into `App.tsx` + `BottomNavBar.tsx`

**Files:**
- Modify: `components/v2/BottomNavBar.tsx`
- Modify: `App.tsx:28` (import), `App.tsx:134` (activeTab type), `App.tsx:336-371` (tab render block)

- [ ] **Step 1: Update `BottomNavBar.tsx`**

In `components/v2/BottomNavBar.tsx`, change:

```ts
export type NavTab = "radar" | "trades" | "gptRule" | "live" | "all5m" | "server";
```
to:
```ts
export type NavTab = "radar" | "trades" | "gptRule" | "live" | "chart" | "server";
```

And change the `ALL_TABS` entry:
```ts
{ key: "all5m",   label: "5m ALL",  icon: "auto_graph" },
```
to:
```ts
{ key: "chart",   label: "CHART",   icon: "candlestick_chart" },
```

If `"candlestick_chart"` isn't a valid icon name in `MaterialIcon`'s prop type, check `components/v2/MaterialIcon.tsx` for the actual supported name list and pick the closest valid one (e.g. `"show_chart"` or `"auto_graph"` — do not guess a nonexistent icon name, the type will fail to compile if wrong).

- [ ] **Step 2: Update `App.tsx` imports and state**

Replace:
```ts
import BinanceChart from "./components/BinanceChart";
```
```ts
import { use5mAllTrader } from "./hooks/use5mAllTrader";
```
with:
```ts
import TradingChartTab from "./components/TradingChartTab";
```
(delete the `use5mAllTrader` import line entirely — no replacement needed, the hook is deleted in Task 8).

Change the `activeTab` union type (line 134) from:
```ts
const [activeTab, setActiveTab] = useState<"dashboard" | "risk" | "gptRule" | "live" | "all5m" | "server">("dashboard");
```
to:
```ts
const [activeTab, setActiveTab] = useState<"dashboard" | "risk" | "gptRule" | "live" | "chart" | "server">("dashboard");
```

- [ ] **Step 3: Update `handleNavSelect`**

Change:
```ts
else if (t === "all5m") setActiveTab("all5m");
```
to:
```ts
else if (t === "chart") setActiveTab("chart");
```

- [ ] **Step 4: Replace the `all5m` tab render block**

Replace the entire `if (activeTab === "all5m") { ... }` block (currently lines 336-371) with:

```tsx
  if (activeTab === "chart") {
    return (
      <ErrorBoundary>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="light" />
          <TopAppBar
            title="BTC DASHBOARD"
            version={APP_VERSION}
            buildDate={BUILD_DATE}
            lastUpdate={lastUpdate}
            onNotifications={() => {}}
            onSettings={() => setShowSettings(true)}
          />
          <PanelBoundary name="TradingChartTab">
            <TradingChartTab
              rawKlines={rawKlines}
              selectedTF={selectedTF}
              onSelectTF={setSelectedTF}
              activeAlerts={activeAlerts}
            />
          </PanelBoundary>
          <SettingsPanel visible={showSettings} settings={settings} onUpdate={updateSettings} />
          <BottomNavBar
            active={navTab}
            tradesBadge={firingGoldensCount}
            onSelect={handleNavSelect}
          />
        </SafeAreaView>
      </ErrorBoundary>
    );
  }
```

- [ ] **Step 5: Remove the `all5m` engine mount + `BinanceChart` mount inside the RULE tab**

Delete the line (around line 206):
```ts
const all5m = use5mAllTrader(rawKlines, tfData, priceData?.price ?? null, true);
```

Delete the RULE-tab `BinanceChart` panel block (around lines 548-552):
```tsx
            <PanelBoundary name="BinanceChart">
              <BinanceChart rawKlines={rawKlines} selectedTF={selectedTF} onSelectTF={setSelectedTF} />
            </PanelBoundary>
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "App\.tsx|BottomNavBar"`
Expected: no output. If `all5m` is still referenced anywhere (e.g. `all5m.account` in a block not yet touched — that's Task 7), you'll see an error here; fix forward-references by completing Task 7 before re-running this check if needed.

- [ ] **Step 7: Commit**

```bash
git add App.tsx components/v2/BottomNavBar.tsx
git commit -m "feat: replace 5m ALL tab with new chart tab in nav + App.tsx"
```

---

### Task 7: Delete dead 5m ALL engine + panel files

**Files:**
- Delete: `components/All5mPanel.tsx`
- Delete: `hooks/use5mAllTrader.ts`
- Delete: `utils/all5mAccount.ts`
- Delete: `components/UnifiedTradesPanel.tsx`
- Delete: `components/BinanceChart.tsx`

- [ ] **Step 1: Confirm nothing else imports these (re-verify before deleting)**

Run: `grep -rln "All5mPanel\|use5mAllTrader\|all5mAccount\|UnifiedTradesPanel\|BinanceChart" --include="*.tsx" --include="*.ts" . | grep -v node_modules`

Expected output at this point (after Task 6's edits): only `components/LiveTab.tsx` should still reference `all5mAccount` (handled in Task 8) — everything else should be gone or about to be deleted in this task. If `App.tsx` still appears, go back and finish Task 6 first.

- [ ] **Step 2: Delete the files**

```bash
git rm components/All5mPanel.tsx hooks/use5mAllTrader.ts utils/all5mAccount.ts components/UnifiedTradesPanel.tsx components/BinanceChart.tsx
```

(Do NOT delete `utils/all5mAccount.ts` yet if Tasks 8 and 8b haven't run — both
`LiveTab.tsx` and `utils/liveTraderEngine.ts` still import from it. Complete Task 8
AND Task 8b before this Step 2 if you're executing tasks out of order.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Cannot find module.*(All5mPanel|use5mAllTrader|all5mAccount|UnifiedTradesPanel|BinanceChart)"`
Expected: no output (Task 8 must be done first, or this will show `LiveTab.tsx` errors).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete dead 5m ALL engine/panel files (superseded by chart tab)"
```

---

### Task 8: Remove `use5mAllEngineMode` toggle from `LiveTab.tsx` (dead behind `SERVER_OWNS_TRADING`)

**Files:**
- Modify: `components/LiveTab.tsx`
- Modify: `utils/liveTraderEngine.ts:46,80` (only if `all5mAccount.ts` is already deleted per Task 7 — otherwise do this task BEFORE Task 7 Step 2)

**Do this task before Task 7 Step 2** (deleting `all5mAccount.ts`), since `LiveTab.tsx` imports from it.

- [ ] **Step 1: Remove the import and hook**

In `components/LiveTab.tsx`, delete:
```ts
import { PRESETS, PresetKey, getActivePresetKey, DEFAULT_PRESET_KEY } from "../utils/all5mAccount";
```
and delete the `useActivePreset()` function (lines ~82-94) along with its two call sites:
```ts
const presetKey = useActivePreset();
const preset = PRESETS[presetKey];
```
(around line 99-100) and:
```ts
const livePresetKey = useActivePreset();
const livePreset = PRESETS[livePresetKey];
```
(around line 540-541).

- [ ] **Step 2: Remove JSX that references `preset`/`livePreset`/`fiveMModeOn`**

Delete the banner block using `fiveMModeOn`/`preset` (around lines 109-119 — the `{fiveMModeOn && (...)}` block).

Delete the settings-modal block using `draft.use5mAllEngineMode` (the toggle switch around lines 730-758, including its warning `Alert.alert(...)` confirmation text at ~585 if it references `use5mAllEngineMode`/`preset`).

Grep to confirm you got everything before moving on:
Run: `grep -n "use5mAllEngineMode\|PRESETS\|PresetKey\|getActivePresetKey\|DEFAULT_PRESET_KEY\|preset\b\|livePreset\|fiveMModeOn" components/LiveTab.tsx`
Expected: no matches remain.

- [ ] **Step 3: Remove `use5mAllEngineMode` from `LiveSettings` type + default**

In `utils/liveTraderEngine.ts`, delete the field from the interface (line ~46):
```ts
use5mAllEngineMode: boolean;      // default false
```
and from the default settings object (line ~80):
```ts
use5mAllEngineMode: false,     // default OFF — phải bật rõ ràng trong SETTINGS
```

Also remove the entire dead `useEffect` block in `hooks/useBinanceLive.ts` that this
field guards — it spans from the `// ─── 5m ALL ENGINE MODE (anh Tommy v4.7.8) ───`
comment (line 487) through the effect's closing `}, [role, ltfCtx.closedBar5m?.time, currentPrice]);`
(line 555), i.e. delete lines 487-555 as one unit. This whole effect was already
unreachable behind `SERVER_OWNS_TRADING` (line 495 `if (SERVER_OWNS_TRADING) return;`
fires before the `use5mAllEngineMode` check ever runs) — deleting it is a pure
dead-code removal, not a behavior change. It also removes the `getActivePreset()` call
(~line 504) that otherwise breaks after `all5mAccount.ts` is deleted in Task 7.
After deleting, check whether `getActivePreset`/`AlertInput`/`decideEntry`/
`executeAction` imports at the top of `hooks/useBinanceLive.ts` are still used
elsewhere in the file — if this was their only use, remove the now-unused imports too
(run `grep -n "getActivePreset\|AlertInput\b" hooks/useBinanceLive.ts` to check).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "LiveTab|liveTraderEngine|useBinanceLive"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add components/LiveTab.tsx utils/liveTraderEngine.ts hooks/useBinanceLive.ts
git commit -m "chore: remove dead use5mAllEngineMode toggle from LiveTab (unreachable behind SERVER_OWNS_TRADING)"
```

---

### Task 8b: Fix the OTHER `getActivePreset` call site — this one is NOT dead code

**Files:**
- Modify: `utils/liveTraderEngine.ts:16,~735-742`

**Important:** unlike Task 8's `use5mAllEngineMode` effect, this second call site is
part of the live auto-import/reconciliation logic (matching untracked Binance
positions back into the app's tracked list) and runs regardless of
`SERVER_OWNS_TRADING` — it is NOT dead code. Read the surrounding function (search
`// 5 FIX (v4.7.15)` around line 725) before touching it.

- [ ] **Step 1: Read the current fallback behavior**

The existing code already has a fallback path for when `getActivePreset()` fails:
```ts
let presetTp = 4, presetSl = 2; // BALANCED defaults
try {
  const preset = await getActivePreset();
  presetTp = preset.tpPct;
  presetSl = preset.slPct;
} catch {
  // Use defaults
}
```

- [ ] **Step 2: Replace with the hardcoded fallback directly (no more preset source to read)**

Since `all5mAccount.ts` (and its preset selection UI) is gone, there is no "active
preset" left to fetch — always use the BALANCED defaults this code already falls back
to:

```ts
const presetTp = 4, presetSl = 2; // BALANCED defaults (was: read from 5m ALL active preset, now removed)
```

Remove the `try { ... } catch { ... }` wrapper and the `getActivePreset()` call
entirely — replace with the two `const` lines above.

- [ ] **Step 3: Remove the now-unused import**

Delete line 16:
```ts
import { getActivePreset } from "./all5mAccount";
```

Confirm no other reference remains: `grep -n "getActivePreset" utils/liveTraderEngine.ts` → expect no output.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep liveTraderEngine`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add utils/liveTraderEngine.ts
git commit -m "fix: replace getActivePreset() auto-import fallback with hardcoded BALANCED defaults (5m ALL preset source removed)"
```

---

### Task 9: Full typecheck + manual browser verification

**Files:** none (verification only)

- [ ] **Step 1: Full project type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "^tools/"`
Expected: no errors outside of `tools/` (pre-existing unrelated errors in `tools/*.ts` are out of scope for this plan — confirm any remaining errors are in files this plan didn't touch).

- [ ] **Step 2: Run the full test suite**

Run: `node --test test/*.test.mjs` (or whatever the project's actual test-running convention is — check `package.json` scripts first)
Expected: all pass, including the new `utils/chartDataMapper.test.ts` (run via `npx tsx --test`).

- [ ] **Step 3: Start the dev server and manually verify in browser**

Use the project's `expo start --web` preview flow (per project CLAUDE.md "show browser before build" rule). Verify:
- Bottom nav shows "CHART" instead of "5m ALL", clicking it opens the new tab.
- Candlesticks render for at least 2 different timeframes (switch and confirm reflow).
- EMA9/EMA21/BB lines render.
- RSI/StochRSI/MACD panes render below the main chart.
- S/R dashed lines render at expected price levels (cross-check against the old `BinanceChart.tsx` behavior if a git stash/diff is handy).
- If any rule is currently FIRED (visible on the RULE tab banner), its entry/TP/SL lines appear on the chart tab for the matching timeframe.
- RULE tab no longer shows the old small `BinanceChart` panel.
- LIVE tab no longer shows any "5m ALL Engine" banner/toggle.
- Browser console has zero errors (check via the preview tool's console-log inspection, not just visually).

- [ ] **Step 4: Codex read-only audit (project standing rule)**

Run `scripts/codex/ask.sh` (per `btc-dashboard/CLAUDE.md` "Codex auto-audit" rule) against the full diff of this plan's changes before considering it done — this is not optional, paste the findings into the final report regardless of severity.

- [ ] **Step 5: Final commit (if Step 4 surfaces fixes)**

If Codex finds issues, fix them, re-run Steps 1-3, then:
```bash
git add -A
git commit -m "fix: address Codex audit findings on TradingChartTab feature"
```

---

## Explicitly out of scope (per spec)

- Drawing tools (trendline/fib/rectangle/text).
- Native (APK/iOS) real chart parity — `TradingChartTab.native.tsx` is a fallback message only.
- Any change to `hooks/useRuleAlerts.ts` matching logic — this plan only *reads* `activeAlerts`, never changes how they're computed.
- Version bump / `npx expo export -p web` / git push to `docs/app` — that's the separate "build" step Tommy triggers explicitly by typing "build" (per project CLAUDE.md), not part of this implementation plan.
