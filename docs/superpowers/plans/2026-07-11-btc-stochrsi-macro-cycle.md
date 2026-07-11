# BTC StochRSI Macro Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a reproducible BTC-only seven-year backtest for the approved 1W/2W StochRSI recovery cycle with one LONG leg per distinct 1D `%K < 10` episode.

**Architecture:** A pure TypeScript module builds causal 1D/1W/2W signals using the shared StochRSI implementation. A replay module applies fills, fees, funding, hourly equity, and liquidation accounting. A CLI refreshes official Binance Futures data over verified TLS, records provenance, runs frozen baselines, and writes JSON plus Markdown evidence.

**Tech Stack:** TypeScript 5.9, Node 20, `node:test`, `npx tsx`, `utils/indicators.ts`, Binance USD-M Futures public REST.

## Global Constraints

- BTCUSDT only. Do not read ETH or SOL.
- StochRSI `14/14/3/3`; macro oversold `<20`; daily entry `%K <10`; exit when both 1W and 2W `%K >=80`.
- Closed UTC candles only. 1W starts Monday; 2W is anchored to Monday `1970-01-05`.
- Next-daily-open fills, `0.02%` adverse slippage per side, `0.04%` taker fee per side, historical funding.
- `0.001 BTC` per episode; no stop, partial close, max hold, parameter sweep, or result-driven variant selection.
- No live server, settings, secrets, positions, deployment, or arming changes.
- Full-repo TypeScript errors are pre-existing; new files must pass focused tests and introduce no new diagnostics.

## Files

- Create `tools/stochrsi-macro-cycle/core.ts` and `core.test.ts`.
- Create `tools/stochrsi-macro-cycle/replay.ts` and `replay.test.ts`.
- Create `tools/stochrsi-macro-cycle/io.ts` and `io.test.ts`.
- Create `tools/backtest-stochrsi-macro-cycle-7y.ts`.
- Generate `assets/backtest_btc_stochrsi_macro_cycle_7y.json`.
- Generate `docs/backtest-btc-stochrsi-macro-cycle-2026-07-11.md`.

---

### Task 1: Causal Candle And Signal Core

**Files:** Create `tools/stochrsi-macro-cycle/core.ts`; test `tools/stochrsi-macro-cycle/core.test.ts`.

**Produces:** `aggregateCandles`, `buildStochPoints`, `advanceMacroLatch`, `buildCampaignSignals`, `CampaignSignal`.

- [ ] **Step 1: Write failing boundary tests**

```ts
test("1W starts Monday and drops the incomplete next week", () => {
  const monday = Date.UTC(2026, 0, 5);
  const input = Array.from({ length: 8 * 24 }, (_, i) => bar(monday + i * HOUR_MS, 100 + i));
  const out = aggregateCandles(input, "1w", monday + 7 * DAY_MS);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, monday);
});

test("2W anchor is stable", () => {
  assert.equal(MONDAY_ANCHOR_MS, Date.UTC(1970, 0, 5));
});
```

- [ ] **Step 2: Run RED**

Run `npx tsx --test tools/stochrsi-macro-cycle/core.test.ts`; expect missing-module failure.

- [ ] **Step 3: Implement aggregation and shared indicator alignment**

```ts
import { calcStochRSISeries } from "../../utils/indicators";
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const MONDAY_ANCHOR_MS = Date.UTC(1970, 0, 5);
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }

export function buildStochPoints(bars: Candle[], spanMs: number) {
  const { kSeries, dSeries } = calcStochRSISeries(bars.map(b => b.close), 14, 14, 3, 3);
  return bars.map((bar, i) => ({ ...bar, closeTime: bar.time + spanMs, k: kSeries[i], d: dSeries[i] }));
}
```

`aggregateCandles` floors UTC buckets, includes only source bars closed by `asOfMs`, and emits only complete target buckets.

- [ ] **Step 4: Write failing state tests**

```ts
test("macro needs oversold before a later bullish K/D cross", () => {
  let state = emptyMacroLatch();
  state = advanceMacroLatch(state, { k: 15, d: 18 });
  state = advanceMacroLatch(state, { k: 22, d: 19 });
  assert.equal(state.reboundConfirmed, true);
});

test("multi-day daily oversold produces one entry", () => {
  const campaigns = buildCampaignSignalsFromPoints(fixtureWithDailyK([12, 8, 5, 7, 11, 9]));
  assert.equal(campaigns[0].episodeEntries.length, 2);
});

test("exit wins over same-time entry", () => {
  const campaign = buildCampaignSignalsFromPoints(fixtureExitAndOversoldTogether())[0];
  assert.equal(campaign.episodeEntries.length, 0);
  assert.equal(campaign.exitReason, "MACRO_OVERBOUGHT");
});
```

- [ ] **Step 5: Implement state machine**

```ts
export function advanceMacroLatch(state: MacroLatch, value: KdValue): MacroLatch {
  if (value.k === null || value.d === null) return state;
  let oversoldSeen = state.oversoldSeen || value.k < 20 || value.d < 20;
  let reboundConfirmed = state.reboundConfirmed;
  if (oversoldSeen && state.previousK !== null && state.previousD !== null
      && state.previousK <= state.previousD && value.k > value.d) reboundConfirmed = true;
  if (!reboundConfirmed && value.k >= 80) oversoldSeen = false;
  return { oversoldSeen, reboundConfirmed, previousK: value.k, previousD: value.d };
}
```

Advance 1W/2W only at their close times; arm after both latches confirm; consume one `%K <10` daily episode until `%K >=10`; fill next daily open; evaluate exit before entry; preserve an unclosed final campaign.

- [ ] **Step 6: Run GREEN and commit**

Run `npx tsx --test tools/stochrsi-macro-cycle/core.test.ts`; expect all pass. Commit with `feat: add causal StochRSI macro cycle evaluator`.

---

### Task 2: Replay, Funding, And Solvency

**Files:** Create `tools/stochrsi-macro-cycle/replay.ts`; test `tools/stochrsi-macro-cycle/replay.test.ts`.

**Produces:** `buildVariantLegs`, `settleLeg`, `runVariant`, `summarizeVariant`, `minimumWalletToSurvive`.

- [ ] **Step 1: Write failing accounting tests**

```ts
test("fills include adverse slippage and both fees", () => {
  const leg = settleLeg({ qty: 0.001, entryOpen: 100, exitOpen: 110, funding: [] });
  assert.equal(leg.entryPrice, 100.02);
  assert.equal(leg.exitPrice, 109.978);
});

test("positive funding is paid by a long", () => {
  const leg = settleLeg({ qty: 1, entryOpen: 100, exitOpen: 110,
    funding: [{ time: 1, rate: 0.001, mark: 105 }] });
  assert.equal(leg.fundingPnl, -0.105);
});

test("full-at-arm matches episode qty and is simulated", () => {
  const result = buildVariantLegs(campaignWithEpisodeCount(3), "WINDOW_FULL_AT_ARM");
  assert.equal(result.legs[0].qty, 0.003);
  assert.equal(result.simulatedNotTradable, true);
});
```

- [ ] **Step 2: Run RED**

Run `npx tsx --test tools/stochrsi-macro-cycle/replay.test.ts`; expect missing-module failure.

- [ ] **Step 3: Implement fixed accounting**

```ts
export const QTY_PER_LEG = 0.001;
export const FEE_RATE = 0.0004;
export const SLIPPAGE_RATE = 0.0002;
export const MAINTENANCE_RATE = 0.004;
export type VariantName = "MACRO_ONCE" | "DAILY_EPISODE" | "DAILY_EVERY_BAR" | "WINDOW_FULL_AT_ARM";
```

For each leg: use adverse next-open fills, subtract entry/exit fees, subtract positive long funding and credit negative funding. Use funding mark when present, otherwise the latest causal hourly close.

- [ ] **Step 4: Test and implement hourly account path**

```ts
test("minimum wallet covers worst maintenance minus pre-wallet PnL", () => {
  assert.equal(minimumWalletToSurvive([
    { pnlBeforeWallet: -20, maintenance: 2 },
    { pnlBeforeWallet: -35, maintenance: 3 },
  ]), 38);
});
```

Track hourly unrealized PnL, funding, maintenance, equity, max drawdown, liquidation, max quantity/notional, minimum wallet, monthly entries/PnL, closed/open campaigns, campaign/leg win rates, best-one/best-three concentration, and pre/post `2023-01-01` results.

- [ ] **Step 5: Run GREEN and commit**

Run `npx tsx --test tools/stochrsi-macro-cycle/replay.test.ts`; expect all pass. Commit with `feat: replay StochRSI campaigns with account costs`.

---

### Task 3: Data Refresh And Provenance

**Files:** Create `tools/stochrsi-macro-cycle/io.ts`; test `tools/stochrsi-macro-cycle/io.test.ts`.

**Produces:** `loadAndRefreshData`, `mergeCandles`, `validateHourlyData`, `sha256File`, `Provenance`.

- [ ] **Step 1: Write failing merge/gap tests**

```ts
test("merge deduplicates and excludes forming hour", () => {
  const now = Date.UTC(2026, 6, 11, 12);
  const merged = mergeCandles([bar(now - 2 * HOUR_MS, 1)],
    [bar(now - 2 * HOUR_MS, 2), bar(now, 3)], now);
  assert.deepEqual(merged.map(x => [x.time, x.close]), [[now - 2 * HOUR_MS, 2]]);
});

test("validation lists gaps over three hours", () => {
  assert.equal(validateHourlyData([bar(0, 1), bar(5 * HOUR_MS, 2)]).gaps[0].missingHours, 4);
});
```

- [ ] **Step 2: Run RED**

Run `npx tsx --test tools/stochrsi-macro-cycle/io.test.ts`; expect missing-module failure.

- [ ] **Step 3: Implement public verified-TLS refresh**

```ts
const FUTURES_REST = "https://fapi.binance.com";
async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(`${FUTURES_REST}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Binance ${response.status} ${path}`);
  return response.json();
}
```

Paginate `/fapi/v1/klines` at 1h and `/fapi/v1/fundingRate`; never disable TLS verification or read credentials. Filter forming bars, merge atomically into ignored caches, validate OHLC, list every >3h gap with handling `aggregate_available_hours`, and hash data/funding after refresh.

- [ ] **Step 4: Run GREEN and commit**

Run `npx tsx --test tools/stochrsi-macro-cycle/io.test.ts`; expect all pass without network. Commit with `feat: add reproducible Binance backtest provenance`.

---

### Task 4: CLI And Real BTC Replay

**Files:** Create CLI and generate the JSON/Markdown paths listed above.

- [ ] **Step 1: Implement orchestration**

```ts
const data = await loadAndRefreshData({ refresh: !process.argv.includes("--offline") });
const campaigns = buildCampaignSignals(data.hourly, data.asOfMs);
const variants = VARIANT_NAMES.map(name => runVariant(name, campaigns, data.hourly, data.funding));
writeGeneratedOutputs(buildReport({ provenance: data.provenance, campaigns, variants }));
```

Report data/warmup range, campaigns, variants, monthly entries, costs/funding, wallets `100/250/500/1000 USDT`, drawdown/liquidation, concentration, pre/post-2023, and open campaign. Fewer than five completed campaigns forces `INSUFFICIENT_SAMPLE`.

- [ ] **Step 2: Run tests and online replay**

Run `npx tsx --test tools/stochrsi-macro-cycle/*.test.ts`, then `npx tsx tools/backtest-stochrsi-macro-cycle-7y.ts`. Expect refreshed latest completed hour and both outputs.

- [ ] **Step 3: Verify deterministic offline replay**

Run again with `--offline`; after excluding `generatedAt`, require exact strategy/campaign/metric equality.

- [ ] **Step 4: Inspect and commit**

Run `git diff --check` and scan outputs for `NaN`, `Infinity`, `TBD`, and `TODO`; expect none. Commit with `test: backtest BTC StochRSI macro cycle`.

---

### Task 5: Adversarial Audit And Final Verification

- [ ] **Step 1: Send Grok the diff, provenance, raw campaigns, and metrics**

Ask it to attack 2W parity, stale latches, same-close lookahead, next-open fills, funding sign, maintenance math, open-campaign treatment, sample size, and `SIMULATED_NOT_TRADABLE` labeling.

- [ ] **Step 2: Falsify material findings with tests first**

For each confirmed issue, add a failing test, run RED, make the smallest correction, run all focused tests GREEN, and rerun offline. Do not change thresholds or select another variant.

- [ ] **Step 3: Final verification**

Run `npx tsx --test tools/stochrsi-macro-cycle/*.test.ts`, offline replay, `npx tsc --noEmit --pretty false`, `git diff --check`, and `git status --short`. Record unrelated old TypeScript errors; no new error may reference new files.

- [ ] **Step 4: Commit and report**

Commit confirmed audit fixes with `audit: verify BTC StochRSI macro cycle replay`. Do not deploy. Report campaign/leg win rates, net PnL, ROI, max drawdown, monthly entries, minimum wallet, concentration, open campaign, and comparison versus `MACRO_ONCE` and `WINDOW_FULL_AT_ARM`.
