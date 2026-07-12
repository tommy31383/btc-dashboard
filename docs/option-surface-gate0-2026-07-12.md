# BTC Option Direction Surface Gate-0

- Verdict: **KILL_PUBLIC_HISTORY_INSUFFICIENT**
- Generated: `2026-07-12T16:09:51.024286+00:00`
- Scope: BTC option data feasibility only; no outcome fit, rule change, live arming, or deploy.
- Population: `31` H01 episodes at `21` unique timestamps.

## Public Data Finding

- The official historical host exposes the archived instrument catalog and option trades.
- Each trade carries a trade-triggered mark price and IV, but this is not a synchronized chain snapshot.
- Historical mark/quote snapshots were unavailable on both the history and main public endpoints for archived instruments.
- Therefore the public route cannot produce a defensible 25-delta skew, 7d/30d term surface, or downside-demand change at every H01 decision.

## Coverage

- Trade-proxy surface, unique timestamps: `33.33%`.
- Trade-proxy surface, episode weighted: `35.48%`.
- True snapshot surface, unique timestamps: `0.00%`.
- True snapshot surface, episode weighted: `0.00%`.
- Median active-chain trade coverage in 15 minutes: `6.81%`.

## Gates

- `catalogDiscoverable`: **PASS**
- `historicalSnapshotEndpoint`: **FAIL**
- `causalWindowsClean`: **PASS**
- `uniqueSnapshotCoverageAtLeast90pct`: **FAIL**
- `episodeSnapshotCoverageAtLeast90pct`: **FAIL**
- `bothSetupsSnapshotCovered`: **FAIL**

## Decision

`KILL_PUBLIC_HISTORY_INSUFFICIENT` kills only the free/public historical-surface route. It does not claim that option skew has no predictive value. A future test requires a timestamped quote/mark archive, such as the historical options-chain data Deribit documents through its Tardis partnership, followed by a new preregistered Gate-0.

Trade prints remain tagged `TRADE_TRIGGERED_MARKS_ONLY`; they cannot independently authorize research acceptance or live behavior.

## Reproduction And Review

- A second independent API fetch produced the same verdict, all gate values, all coverage values, canonical trade-row SHA-256 `5dbe7e13fed4243d55af0894914b75926812d334066e74d4128c6561105492ab`, and relevant-catalog SHA-256 `9d3e7523731b096a8759b9cdbeab1fead625f187a119ba515800bdcd68e4d1d2`.
- Codex self-audit corrected expiry-at-decision classification and generated-output provenance before the recorded run.
- Claude review was unavailable because the daily quota was exhausted. No Claude approval is claimed. This conservative data-route kill does not authorize any money-path change.

## Official References

- [Deribit historical mark-price API](https://docs.deribit.com/api-reference/market-data/public-get_mark_price_history)
- [Deribit historical trade API limits](https://docs.deribit.com/api-reference/market-data/public-get_last_trades_by_currency_and_time)
- [Deribit market-data collection guidance](https://docs.deribit.com/articles/market-data-collection-best-practices)
- [Deribit historical options archive partnership](https://insights.deribit.com/exchange-updates/celebrating-our-tardis-dev-partnership-get-free-historical-data/)

## Provenance

- Git commit: `dd765bb31d46f3a92586c323093e6c56761404c8`; dirty=`false`.
- Evaluator SHA-256: `2af38287bf25bcee6a95be3104adcfc5942b4d19a39e2a4a886a815668b6ce52`.
- H01 episode source SHA-256: `34a82cdb955c33eb6a6fd0ea5e954c10be618ce68f2c72bd3f7a3191e45f27c6`.
- Canonical historical catalog SHA-256: `d02f7acf41bdd8ae91bbb2af6edd4ba0fcd5ab4a237f82aa3135ddc36da86068`.
- Raw trade source SHA-256: `3e7b5e3b44632fa13e781eb30d3e7d3af228198de547eef82704cbf015163d3e`.
- Canonical trade rows SHA-256: `5dbe7e13fed4243d55af0894914b75926812d334066e74d4128c6561105492ab`.
- Relevant historical catalog SHA-256: `9d3e7523731b096a8759b9cdbeab1fead625f187a119ba515800bdcd68e4d1d2`.
