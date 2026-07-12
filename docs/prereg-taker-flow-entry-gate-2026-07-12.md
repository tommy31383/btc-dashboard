# BTC H01 True Taker-Flow Entry Timing Preregistration

Status: **FROZEN BEFORE OUTCOME EVALUATION**

## Question

Do unusually aggressive taker buys immediately before an accepted H01 breakout
identify late Long entries where waiting exactly one hour obtains a better fill?

This study evaluates entry timing only. It does not skip entries, alter position
size, change exits, arm a rule, or deploy anything.

## Population

- Asset: BTCUSDT USD-M perpetual futures only.
- Source: `docs/research/dvol-h05-gate1-source-2026-07-12.json`.
- Required source SHA-256:
  `30e3cd347ba78287240427f08da65fe08b90c29e3d35755d33d5fda90d3c79a0`.
- Reapply the frozen H01 baseline portfolio acceptance from
  `tools/dvol_h05_gate1.py`; do not select rows using outcomes.
- Include accepted S13/S14 entries only. S12 is outside this breakout-timing
  hypothesis.
- Expected population before data coverage: 95 episodes at 61 unique market
  timestamps.
- Group equal `signalTime` values into one independent market event. Preserve
  setup membership and episode counts, but never double-weight one timestamp.
- Data archive starts in 2020. The five accepted 2019 episodes are unavailable
  and must remain explicit missing coverage, not be replaced with spot data.
- Expected covered population: 90 episodes at 57 unique timestamps.

## Data Contract

- Official source:
  `https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/5m/`.
- Download every monthly BTCUSDT 5m USD-M Futures archive from `2020-01`
  through `2025-10`, plus its official `.CHECKSUM` file.
- Verify every zip against the official SHA-256 before parsing.
- Required columns are open time, OHLC, base volume, close time, trade count,
  taker-buy base volume, and taker-buy quote volume.
- Never substitute candle direction times total volume. This study uses the
  exchange-provided taker-buy field, not the old OHLCV proxy.
- Every feature uses bars with close time strictly before `signalTime`.
- The delayed fill is the 5m open at exactly `signalTime + 1 hour`.
- Raw immediate entry open must match the frozen H01 `rawFillPrice` within
  `1e-8` relative tolerance for every covered episode.

Data Gate-0 passes only if:

1. all required monthly files and checksums verify;
2. at least 90% of source episodes and unique events are usable;
3. each usable event has 169 complete closed hourly blocks through the current
   hour and the exact delayed-fill bar;
4. all covered immediate opens match the frozen H01 source;
5. there are no duplicate 5m timestamps or future bars in any feature window.

Any failure produces `KILL_TAKER_FLOW_DATA_INSUFFICIENT` and stops before the
association test.

## Frozen Feature

For each UTC-aligned hour:

```text
takerImbalance = (2 * takerBuyBaseVolume - totalBaseVolume) / totalBaseVolume
```

At event time `T`:

- current hour: `[T-1h, T)`;
- reference hours: the 168 complete hours immediately before the current hour;
- `flowRank1h`: mid-rank percentile of current-hour `takerImbalance` among the
  168 reference values.

No other feature enters the acceptance gate. Price return, 4h imbalance,
absorption, CVD, and order-count diagnostics may be reported but cannot rescue
a failed primary gate.

## Frozen Outcome

Primary outcome for a Long:

```text
delayAdvantageBps = 10_000 * (immediateOpen - openAtTPlus1h) / immediateOpen
```

Positive means waiting one hour obtains a cheaper Long entry. This is a
counterfactual fill-timing diagnostic, not a full trade PnL claim.

Secondary non-gating diagnostics are next-1h MAE in entry ATR units and
next-4h return from the immediate open.

## Split And Inference

- In-sample direction check: `2020-01-01 <= T < 2024-01-01`.
- Untouched OOS gate: `T >= 2024-01-01`.
- Primary statistic: Spearman correlation between `flowRank1h` and
  `delayAdvantageBps` across unique events.
- Uncertainty: 5,000 month-block bootstrap iterations, seed `20260712`.
- Fixed high-flow diagnostic: `flowRank1h >= 0.75`; no threshold sweep.

Association Gate-1 passes only if all are true:

1. IS has at least 30 unique events and OOS has at least 20;
2. IS Spearman rho is positive;
3. OOS Spearman rho is at least `0.20`;
4. OOS month-block bootstrap 90% CI lower bound for rho is above zero;
5. OOS high-flow events have positive median `delayAdvantageBps`;
6. removing the best high-flow event and removing the best high-flow month
   each leave positive mean `delayAdvantageBps`;
7. high-flow means are non-negative for events containing S13 and events
   containing S14.

Pass verdict: `PASS_TO_TAKER_FLOW_LIFECYCLE_GATE2`.

Any failed association gate: `KILL_NO_TAKER_FLOW_TIMING_EDGE`.

## Interpretation Boundary

- A pass only authorizes a separate faithful lifecycle comparison of immediate
  entry versus a one-hour delayed entry on high-flow events.
- That future comparison must retain every accepted entry, apply fees,
  slippage, funding, exits, portfolio capacity, stress ordering, and monthly
  reporting.
- A pass does not authorize live code. A fail closes this exact one-hour
  taker-flow timing hypothesis without parameter tuning.
