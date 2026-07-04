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
- On HTTP 429/418 (rate limited), back off: skip that fetch cycle, surface
  `error`, and let the next 60s interval retry — no tight retry loop.

**Stale-response race guard (Codex-caught P1):** if the user switches
symbol quickly (e.g. ETH → SOL → BTC before ETH's fetch resolves), a
late-arriving response for a no-longer-selected symbol must NOT overwrite
`rawKlines`. The hook tags every fetch with the `symbol` it was requested
for and only commits the result if `symbol` still matches the hook's
current input at resolve time:

```ts
useEffect(() => {
  if (!symbol) { setRawKlines({}); return; }
  let cancelled = false;
  const fetchForSymbol = async () => {
    const results = await Promise.all(/* ... per-TF fetch ... */);
    if (cancelled) return; // symbol changed again before this resolved — discard
    setRawKlines(newRawKlines);
  };
  fetchForSymbol();
  const interval = setInterval(fetchForSymbol, 60000);
  return () => { cancelled = true; clearInterval(interval); };
}, [symbol]);
```

The `cancelled` flag (closed over per-effect-run) is sufficient — no
`AbortController` needed since these are plain `fetch` calls with no
in-flight cancellation requirement beyond "don't apply a stale result".

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

**Codex-caught P1 (mislabeled stale chart):** the original draft said "keep
showing previously-loaded data while fetching" — but if the user is on ETH
and switches to SOL, `fetchedKlines` still holds ETH data until SOL's fetch
resolves. Silently leaving the ETH candles on screen while the symbol row
shows "SOL" selected is a labeled-wrong-coin bug, not an acceptable
loading UX. Fixed behavior:

- `useSymbolKlines` tracks which symbol its current `rawKlines` actually
  belongs to (internally, alongside the stale-response guard above — the
  same `symbol` tag used to discard late responses is also compared before
  ever showing data for a *different* symbol than requested).
- In `TradingChartTab`, `activeKlines` is only "ready" once
  `useSymbolKlines`'s data corresponds to the currently-selected symbol.
  Until then (i.e. on every symbol switch, while the new fetch is
  in-flight), the chart's candle/volume series are cleared (`setData([])`)
  and a centered "Loading ETH..." overlay is shown instead of leaving the
  previous symbol's candles visible. This is a deliberate UX tradeoff:
  a brief blank/loading state is preferable to a mislabeled chart.
  Switching timeframe (not symbol) is unaffected — that continues to use
  already-fetched data with no flash, since all TFs are fetched together
  per symbol.
- On fetch error, show a compact red inline error text near the symbol row
  (reuse the existing error display pattern from `useBinanceKlines`'s
  `klineError` if one exists in this component, otherwise a simple `Text`
  node) — the chart does not crash, it shows the loading/error state, never
  a stale different-symbol chart.

## Codex Audit Notes (post-write)

2 P1s found and fixed inline above (stale-response race guard;
mislabeled-stale-chart on symbol switch). 3 P2s noted, not blocking:

- Rate-limit handling (429/418 backoff) — addressed above in Data Fetching.
- Direct-to-Binance-public-API dependency for non-BTC symbols has more
  geo/WAF exposure than the server-proxied BTC path; Binance's own docs
  suggest `data-api.binance.vision` for market-data-only use. Not switching
  to it now (adds a second endpoint to maintain for 3 symbols) — revisit if
  ETH/ETHFI/SOL fetches prove unreliable in practice.
- The Indicators panel's "Rule Entry/TP/SL" toggle stays in whatever
  on/off state the user left it — switching to a non-BTC symbol suppresses
  the drawn lines but does NOT auto-toggle the checkbox off. This is
  intentional (documented here so the implementation plan doesn't "fix" it
  as a bug) — toggling back to BTC while the checkbox is still on
  immediately restores the lines with no extra user action needed.

## Out of Scope

- No persistence of selected symbol across reload.
- No native (mobile) implementation changes beyond what's needed for
  `TradingChartTab.native.tsx` to keep compiling (if it shares props with
  the web version) — native fallback can keep BTC-only if it doesn't
  already have a symbol selector story; this spec only covers the web chart
  experience Tommy is looking at.
- No changes to `useBinanceKlines`, `useRuleAlerts`, or any rule-engine code.
