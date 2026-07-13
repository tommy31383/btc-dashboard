# BTC 5m Deep Research Report - 2026-07-13

## Decision

**Final verdict: REJECT ALL 5m CANDIDATES / KEEP H01 MARKET_NOW.**

No server source, live parameter, rule arming, deployment, order, or position was
changed. The research did not find a BTC 5m timing, filter, micro-ladder,
positioning gate, or standalone rule that passed the frozen evidence gates.

## Scope and Fidelity

- BTCUSDT USD-M perpetual only.
- 719,413 five-minute bars; SHA-256
  `57d6d4d9ececb67cd8362123635cbb78bc0d29039d82586825a25e7b1897a8c1`.
- 7,490 funding records; SHA-256
  `5dc6289ba8253c28f6506a2ad7bb3c987c7950e19be0b3567aa1dea3dd2dd08e`.
- 114 H01 S12/S13/S14 source signals from commit
  `0eb49d6613e8a77f0ab8b537a450bec2704caeb3`.
- Production `hedge01TrailingExit` oracle imported from the hash-locked Run3
  worktree. Baseline parity passed on fill, exit, fees, funding, and net PnL.
- Primary execution: 4 bp fee and 2 bp adverse market slippage per side.
- Stress execution: 6 bp fee and 5 bp adverse market slippage per side.
- Both `LOW_HIGH` and `HIGH_LOW` intrabar paths were replayed where applicable.
- Closed bars, causal features, next-open fills, funding, and mandatory fallback.

## H01 Timing and Filters

Discovery contains 78 signals through 2023; OOS contains 36 signals from 2024.

| Policy | Discovery net | OOS net | Discovery result | OOS result |
|---|---:|---:|---|---|
| A - market now | $251.49 | $242.04 | Baseline | Baseline |
| EMA20 reclaim, 30m | $231.99 | $239.28 | Worse | Worse |
| EMA20 reclaim, 60m | $222.01 | $238.47 | Worse | Worse |
| Sweep reclaim 6 bars, 30m | $234.96 | $242.18 | Worse | +$0.14 but DD/tail worse |
| Sweep reclaim 6 bars, 60m | $223.47 | $230.53 | Worse | Worse |
| Sweep reclaim 12 bars, 30m | $233.85 | $239.73 | Worse | Worse |
| Sweep reclaim 12 bars, 60m | $219.42 | $236.13 | Worse | Worse |

The delayed methods generally bought higher, not lower: discovery mean entry
degradation was about 0.20-0.32 source ATR. Waiting for visual confirmation
therefore paid more after the rebound and weakened the right tail.

Hard no-reclaim filters retained only 17.9%-62.8% of source entries and removed
large positive cohorts. The softer first-15m toxicity filter retained 97.4% in
discovery but lost $4.26 versus A; OOS lost $25.99, increased drawdown from
$93.98 to $115.20, and worsened drop-top-20% from -$101.56 to -$128.84.

## Micro-Ladder

Eight frozen variants split 50% or 70% immediate and placed the remainder at
0.25 or 0.5 ATR5 below the signal, with 15m or 30m mandatory market fallback.
Every signal and total target size were preserved.

- Discovery: 0/8 qualified. Two 15m variants improved net by only $0.28-$0.47,
  but both worsened drop-top-20%; 30m variants lost net.
- OOS: all 8 lost net in all four cost/path scenarios. Primary deltas ranged
  from -$0.90 to -$3.52; all increased drawdown and weakened the tail.

Verdict: `DISCOVERY_NULL`, confirmed by OOS audit.

## Futures Positioning Metrics

Binance official daily archives supplied open interest, account/top-trader
long-short ratios, and taker buy/sell ratio. Two caches were built:

- H01 windows: 261 checksummed archives, 75,156 snapshots, SHA-256
  `b256e0290f1315a3b390acb9a082634cfb0560f20de86b574708be5aaa28d019`.
- Continuous standalone range: 1,948 checksummed archives, 560,390 snapshots,
  SHA-256 `77edb19658df4d68be42447a85d0f3776581c7fa97bf5280bd5d548d7e3384b7`.

Source defects were modeled explicitly: identical duplicate timestamps were
collapsed, zero/blank outage fields became `null`, conflicting duplicates fail,
and off-second event timestamps were preserved rather than rounded backward.

Three H01 states were frozen. Only `SHORT_COVERING_RALLY` (price up, OI down)
passed discovery with 14/51 flagged signals, but the gain was just $0.43. OOS
rejected it: 10/36 flagged, net delta -$1.56, tail delta -$1.96, 2024 delta
-$2.03, and all four cost/path scenarios negative. `BUY_ABSORPTION` and
`CROWDED_LONG` failed the discovery sample floor.

## Standalone 5m Rules

The first frozen grid tested 12 price-only configurations across liquidity
sweep reclaim, compression expansion, and impulse-pullback continuation. All
12 were deeply negative in discovery and OOS after costs; LONG and SHORT were
both negative and drop-top-20% remained negative.

The second grid used independent futures positioning data:

| Family | Trades/config | Discovery net-return sum | PF range | Verdict |
|---|---:|---:|---:|---|
| Position-backed continuation | 4,894-7,648 | -5.87 to -9.09 | 0.51-0.59 | Reject |
| Long liquidation reclaim | 941-1,298 | -1.14 to -1.66 | 0.52-0.61 | Reject |

No family reached a positive three-of-four discovery plateau, so OOS was not
opened for this second standalone grid.

## Interpretation

The user's visual observation is plausible: some H01 entries occur after a
small-timeframe advance near local resistance. The replay shows why that fact
does not become a profitable gate: those same extended entries contain many of
H01's large winners. Confirmation waits buy after the rebound; skip filters
remove positive convexity; shallow ladders improve a few fills but weaken tail
outcomes; OI/taker states did not separate the harmful cases consistently.

The actionable conclusion is not that 5m has no information. It is that the
tested 5m information does not improve H01 execution after realistic costs and
concentration checks. H01 `MARKET_NOW` remains the evidence-backed choice.

The next credible frontier is true historical L2/order-book resiliency,
cross-venue lead-lag, or labeled liquidation tape. Binance's public archive
documents klines, trades, and aggregate trades but does not provide historical
depth snapshots in the same archive. Reconstructing L2 absorption from OHLCV,
taker ratio, or OI would be false precision. See the
[Binance public-data repository](https://github.com/binance/binance-public-data)
and recent research on
[BTC perpetual order-book state and passive-buy toxicity](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6693260).

## Limitations

- H01 drawdown is realized by exit chronology, not full mark-to-market account
  equity. Liquidation, cross-margin burden, exchange capacity, and accepted
  intent behavior are outside this replay.
- The initial H01 timing/filter OOS rows were generated in the same raw replay
  before the discovery lock but were not read before selection. They are
  blind-generated, not a pristine independent experiment.
- The conditional metrics OOS is exploratory because aggregate micro-ladder OOS
  had already been inspected before the conditional state hypothesis.
- Binance metrics are snapshots, not an order book. About 10.9% of standalone
  discovery bars lacked a complete taker window, primarily because of source
  gaps; no forward-fill was used.
- The data ends before a future untouched forward period. Any later candidate
  would still require a new preregistration and untouched forward evidence.

## Evidence Index

- Preregistrations: `preregistration.json`, `prereg-micro-ladder.json`,
  `prereg-futures-metrics.json`, `prereg-standalone-futures-metrics.json`.
- Locks: `h01-selection-lock.json`, `h01-filter-selection-lock.json`,
  `standalone-selection-lock.json`, `micro-ladder-selection-lock.json`,
  `futures-metrics-discovery-lock.json`,
  `standalone-metrics-discovery-lock.json`.
- OOS audits: `micro-ladder-oos-audit.json`,
  `futures-metrics-oos-audit.json`, and the original `results.json`.
- Test suite at report draft: 52/52 passed.
