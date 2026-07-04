# Chart Tab Symbol Selector — Design

**Goal:** Let Tommy switch the CHART tab's candlestick chart between BTC, ETH,
ETHFI, and SOL, so he can eyeball TA on other coins — without touching the
BTC-only rule engine that powers the rest of the app.

## Scope

- Symbol selection is **local to the CHART tab only**. RuleAlertBanner,
  TradingRulesPanel, AlertBanner, RiskRadar, RCIPanel, and every other panel
  keep tracking BTC exactly as today — no cross-symbol rule/alert logic.
- Symbols: `BTC` (BTCUSDT), `ETH` (ETHUSDT), `ETHFI` (ETHFIUSDT), `SOL`
  (SOLUSDT) — all valid Binance spot symbols.
- Indicators (EMA, Bollinger Bands, SuperTrend, VWAP, RSI, StochRSI, MACD,
  ADX, S/R, Volume Candle) all continue to compute normally against
  whichever symbol is currently selected.
- **Exception: "Rule Entry/TP/SL" price-lines are BTC-only** (they come from
  `activeAlerts`, which is always BTC rule data) — this overlay is hidden
  whenever the selected symbol is not BTC, regardless of whether the user
  has it toggled on in the Indicators panel. It reappears automatically when
  switching back to BTC (assuming the toggle is still on).

## Data Fetching

`TradingChartTab` currently receives `rawKlines: RawKlinesMap` (BTC klines,
all timeframes) as a prop from `App.tsx`, sourced from the app-wide
`useBinanceKlines()` hook that also feeds the rule engine.

New hook: **`hooks/useSymbolKlines.ts`**

```ts
export function useSymbolKlines(symbol: string | null): {
  rawKlines: RawKlinesMap;
  loading: boolean;
  error: string | null;
}
```

- `symbol` is a Binance symbol string (e.g. `"ETHUSDT"`) or `null`.
- When `symbol` is `null`, the hook does nothing and returns
  `{ rawKlines: {}, loading: false, error: null }` — this is the case when
  the chart is showing BTC (see below, BTC reuses the existing prop data
  instead of a second fetch).
- When `symbol` changes to a non-null value, fetches all `TIMEFRAMES`
  directly from `${BINANCE_REST}/klines?symbol=${symbol}&interval=${tf.interval}&limit=${tf.limit}`
  in parallel (mirrors the existing Binance-direct fallback path in
  `useBinanceKlines.fetchAllKlines`, but WITHOUT the server-proxy-first step
  — the server proxy only caches BTC — and WITHOUT `TFAnalysis`/AsyncStorage
  caching, since the chart tab computes its own indicator series locally
  and doesn't need the analyzed-per-TF summary object).
- Re-fetches on an interval (reuse the same 60s cadence as
  `useBinanceKlines`) for as long as `symbol` stays non-null, and clears the
  interval when `symbol` goes back to `null` or changes to a different
  symbol.
- Kline parsing (tuple → `Kline` object) reuses the exact same mapping logic
  as `useBinanceKlines` (extracted inline — small enough that duplicating
  the ~10 line map is simpler than introducing a shared module for one
  caller).

**Why not extend `useBinanceKlines` itself:** it also drives
`useRuleAlerts`/`useAlerts`/`useRiskRadar`/etc., all of which assume BTC.
Parameterizing it risks an accidental behavior change to the rule engine.
A small standalone hook scoped to exactly what the chart needs is safer and
easier to reason about in isolation.

## Component Wiring

In `TradingChartTab.web.tsx`:

```ts
type ChartSymbol = "BTC" | "ETH" | "ETHFI" | "SOL";
const SYMBOL_TO_BINANCE: Record<ChartSymbol, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", ETHFI: "ETHFIUSDT", SOL: "SOLUSDT",
};

const [selectedSymbol, setSelectedSymbol] = useState<ChartSymbol>("BTC");
const { rawKlines: fetchedKlines } = useSymbolKlines(
  selectedSymbol === "BTC" ? null : SYMBOL_TO_BINANCE[selectedSymbol]
);
const activeKlines = selectedSymbol === "BTC" ? rawKlines /* prop from App.tsx */ : fetchedKlines;
```

All existing effects that currently read the `rawKlines` prop switch to
reading `activeKlines` instead. Everything downstream (candle mapper,
indicator calc, S/R detection) is symbol-agnostic already — it just
operates on whatever `Kline[]` it's given.

`selectedSymbol` is **not persisted** (resets to BTC on reload) — this is a
transient viewing preference, not a setting worth persisting weight for.

## UI

A new row of 4 small buttons (BTC / ETH / ETHFI / SOL) directly above the
existing timeframe row (5M 15M 1H 4H 1D 1W 1MO), same visual style
(Pressable + active-state highlight) as the timeframe buttons for
consistency.

## Rule Entry/TP/SL Suppression

In the rule-overlay `useEffect` (the one gated on
`enabledIndicators.includes("rules")`), add a top guard:

```ts
if (selectedSymbol !== "BTC") {
  // clear any existing alert price-lines, then return
  alertLinesRef.current.forEach((line) => candleSeriesRef.current?.removePriceLine(line));
  alertLinesRef.current = [];
  return;
}
```

placed after the existing `!enabledIndicators.includes("rules")` early
return, before the line-drawing logic. Add `selectedSymbol` to this effect's
dependency array.

## Loading / Error States

While `useSymbolKlines` is fetching (symbol switch to non-BTC), the chart
keeps showing the previously-loaded data (if any) rather than blanking —
avoids a jarring empty-chart flash on every symbol switch. A small inline
"Loading ETH..." label appears near the symbol row while `loading` is true
and `rawKlines` for that symbol is still empty. On fetch error, show a
compact red inline error text near the symbol row (reuse the existing error
display pattern from `useBinanceKlines`'s `klineError` if one exists in this
component, otherwise a simple `Text` node) — the chart does not crash, it
just remains on last-known-good data.

## Out of Scope

- No persistence of selected symbol across reload.
- No native (mobile) implementation changes beyond what's needed for
  `TradingChartTab.native.tsx` to keep compiling (if it shares props with
  the web version) — native fallback can keep BTC-only if it doesn't
  already have a symbol selector story; this spec only covers the web chart
  experience Tommy is looking at.
- No changes to `useBinanceKlines`, `useRuleAlerts`, or any rule-engine code.
