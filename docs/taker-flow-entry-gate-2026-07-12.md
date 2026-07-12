# BTC H01 True Taker-Flow Entry Timing Gate

- Verdict: **KILL_NO_TAKER_FLOW_TIMING_EDGE**
- Generated: `2026-07-12T16:29:32.770479+00:00`
- Scope: BTC H01 S13/S14 entry timing only; every entry retained; no live change or deploy.
- Population: `95` episodes at `61` unique events.

## Data Gate-0

- Verdict: **PASS_TAKER_FLOW_DATA_GATE0**
- Episode coverage: `94.74%`.
- Unique-event coverage: `93.44%`.
- `allMonthsChecksumVerified`: **PASS**
- `episodeCoverageAtLeast90pct`: **PASS**
- `eventCoverageAtLeast90pct`: **PASS**
- `allCoveredWindowsComplete`: **PASS**
- `allCoveredEntryPricesMatch`: **PASS**
- `noDuplicateTimestamps`: **PASS**

## Association Gate-1

- Verdict: **KILL_NO_TAKER_FLOW_TIMING_EDGE**
- IS: n=`36`, rho=`-0.0357`.
- OOS: n=`21`, rho=`0.1208`.
- OOS rho CI90: `[-0.2721, 0.5176]`.
- OOS high-flow: n=`7`, median delay advantage=`17.45` bps.
- `isSampleAtLeast30`: **PASS**
- `oosSampleAtLeast20`: **PASS**
- `isRhoPositive`: **FAIL**
- `oosRhoAtLeast020`: **FAIL**
- `oosRhoCi90AboveZero`: **FAIL**
- `oosHighFlowMedianPositive`: **PASS**
- `dropBestHighFlowEventMeanPositive`: **PASS**
- `removeBestHighFlowMonthMeanPositive`: **PASS**
- `bothSetupsHighFlowNonNegative`: **PASS**

## Post-Gate Audit

- The fixed top-quartile diagnostic does not generalize across the split.
- IS high-flow: n=`10`, mean=`-25.61` bps, median=`-1.26` bps, positive=`5/10`.
- OOS high-flow: n=`7`, mean=`29.40` bps, median=`17.45` bps, positive=`6/7`.
- This regime inversion is post-gate diagnostic evidence only. It cannot rescue the failed monotonic correlation, crossed-zero confidence interval, or negative IS direction.

## Reproduction And Review

- A second independent execution produced identical archive-manifest hash, observation hash, verdict, gates, correlations, bootstrap interval, and high-flow diagnostics.
- Claude was unavailable because the daily quota was exhausted. No Claude approval is claimed.
- Official data format and archive: [Binance Public Data](https://github.com/binance/binance-public-data).

## Interpretation

The public archive and causal alignment passed, but real taker flow did not pass the frozen OOS timing gate. Do not delay H01 entries from this feature and do not tune another threshold.

## Provenance

- Git commit: `156be28b1acde393b4bb730f475678d3a3f97bd4`; dirty=`false`.
- Evaluator SHA-256: `e4093621269e9c2712a57149d39c6ca8ad0258c457431d545ab247924d5ea605`.
- Preregistration SHA-256: `e77979ca6c7f2688cacfea4ea593212b356b439bf1867c659c6696175babab2a`.
- H01 source SHA-256: `30e3cd347ba78287240427f08da65fe08b90c29e3d35755d33d5fda90d3c79a0`.
- Archive manifest SHA-256: `156aa1d62a285e43bf1991402433891b92f867eba7d22181eff564ec914e4147`.
- Observation SHA-256: `e2e42165d7bc78e740bccfae266488215c5439d991e9fa06c3e5ed1aed6ce8ca`.
