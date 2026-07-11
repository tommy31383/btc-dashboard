# BTC StochRSI Tactical-Only Exploratory - Design

**Date:** 2026-07-11  
**Status:** Pre-registered exploratory follow-up after Hybrid-Lite KILL  
**Scope:** BTC-only offline research. No live rule, server change, deploy, or account access.

## 1. Why this follow-up exists

The frozen Hybrid-Lite replay failed its total-net-PnL check:

- Hybrid total net: `-24.3576 USDT`.
- CORE attribution: `-36.6620 USDT`.
- TACTICAL attribution: `+12.3045 USDT`.
- Hybrid passed the other 7 of 8 frozen checks.

This result falsifies Hybrid-Lite. It also isolates a narrower hypothesis: the
1W/2W state may be useful as an entry gate while the 1D oscillator, rather than
the macro overbought event, should own each leg's lifecycle.

This hypothesis was selected after observing the full 2019-2026 result. The
same history is therefore discovery data, not independent validation. A
mechanical PASS below is only an exploratory historical result and cannot
authorize live use.

## 2. Frozen rule

Entry generation is unchanged:

1. BTCUSDT only.
2. Closed 1W and synthetic closed 2W StochRSI rebound confirmations arm the
   macro entry window.
3. Each distinct closed-1D `%K < 10` episode creates one `0.001 BTC` entry at
   the next available daily open.
4. Every entry timestamp must exactly match `DAILY_EPISODE`.

Lifecycle changes only:

1. Every entry is `TACTICAL`; there is no `CORE` leg.
2. Each leg closes in full at the next daily open after the first strictly
   later completed-1D candle with `%K >= 10`.
3. If the macro dual-overbought exit occurs before or at that recovery fill,
   macro exit wins and the leg records `MACRO_OVERBOUGHT`.
4. An unrecovered final episode remains open and is marked at the deterministic
   data cutoff.
5. No stop, maximum hold, partial close, threshold change, entry filter, or
   parameter sweep is allowed.

The episode state cannot create a new entry before the prior episode recovers,
so structural peak quantity is `0.001 BTC`.

## 3. Frozen comparisons and labels

Add one executable replay row named `TACTICAL_ONLY`. Preserve all six V2 rows
and the original Hybrid verdict. Add a separate `tacticalOnlyVerdict` and label
it `POST_HOC_EXPLORATORY_NOT_VALIDATION` in JSON and Markdown.

The evaluator and report schema must be bumped. Reports must retain role-level
fees, slippage, funding, realized/open counts, and exit reasons.

## 4. Frozen PASS/KILL checks

`TACTICAL_ONLY` passes mechanically only if all eight checks pass:

1. `ENTRY_PARITY`: count and ordered timestamps equal `DAILY_EPISODE`.
2. `TOTAL_NET_PNL_POSITIVE`: total net PnL including open marks is greater than zero.
3. `TACTICAL_NET_PNL_POSITIVE`: TACTICAL role net PnL is greater than zero.
4. `PEAK_QUANTITY`: maximum concurrent quantity is at most `0.001 BTC`.
5. `FIXED_WALLETS_SURVIVE`: `250`, `500`, and `1,000 USDT` paths do not liquidate.
6. `BEATS_HYBRID_LITE`: total net PnL is greater than Hybrid-Lite total net PnL.
7. `POSITIVE_COMPLETED_CAMPAIGNS`: at least 2 of the 3 completed macro campaigns have positive absolute net PnL.
8. `UNRESOLVED_LEGS_CAUSAL`: every open leg, and only an open leg, corresponds
   to an episode with no causal recovery before the cutoff or macro exit; all
   candidate legs have role `TACTICAL`.

No check may be changed after the replay result is known.

## 5. Tests and evidence

Focused tests must prove:

1. First and later campaign entries are all tactical.
2. Recovery and same-time macro priority remain causal.
3. Sequential episodes do not overlap and peak at `0.001 BTC`.
4. The final unrecovered episode is the only permitted open leg.
5. Frozen row order, schema/version, Markdown warnings, and all eight verdict
   checks are mechanical.
6. Existing six-variant results and the Hybrid verdict do not change.
7. Clean online and offline replays match except for `generatedAt`, with
   `gitDirty=false`, cache hashes, and zero invalid funding marks recorded.

## 6. Interpretation

The entire available Futures history has influenced this follow-up. Even if all
checks pass, the top-level statistical verdict remains `INSUFFICIENT_SAMPLE`
until at least five macro campaigns complete, and honest validation requires
future campaigns or a separately untouched dataset. The owner limited this
task to BTC, so no cross-asset evidence is claimed.
