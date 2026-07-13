# Claude Final Audit Packet - BTC 5m 2026-07-13

You are the bounded adversarial reviewer. Do not redesign or expand scope.

## Required verdict

Return exactly one top-level verdict: `APPROVED` or `CHANGES_REQUIRED`.
Then list findings ordered P0, P1, P2 with file/line and a concise reason. If no
findings, say `No P0-P2 findings`. Review process integrity as well as code.

## Scope

Research only. No live/server source was changed or deployed. BTCUSDT perpetual
5m only. Main conclusion is REJECT ALL candidates and keep H01 MARKET_NOW.

Read these files:

1. `docs/research/btc-5m-2026-07-13/report.md`
2. `docs/research/btc-5m-2026-07-13/preregistration.json`
3. `docs/research/btc-5m-2026-07-13/prereg-micro-ladder.json`
4. `docs/research/btc-5m-2026-07-13/prereg-futures-metrics.json`
5. `docs/research/btc-5m-2026-07-13/prereg-standalone-futures-metrics.json`
6. `tools/btc-5m-research/provenance.mjs`
7. `tools/btc-5m-research/h01-replay.mjs`
8. `tools/btc-5m-research/micro-ladder.mjs`
9. `tools/btc-5m-research/micro-ladder-replay.mjs`
10. `tools/btc-5m-research/metrics-data.mjs`
11. `tools/btc-5m-research/metrics-states.mjs`
12. `tools/btc-5m-research/metrics-policy.mjs`
13. `tools/btc-5m-research/standalone-metrics.mjs`
14. `tools/btc-5m-research/evaluate.mjs`

Inspect locks/results only when needed:

- `micro-ladder-selection-lock.json`
- `micro-ladder-oos-audit.json`
- `futures-metrics-discovery-lock.json`
- `futures-metrics-oos-audit.json`
- `standalone-metrics-discovery-lock.json`
- `results.json`

## Audit questions

1. Any future leak, forming-bar use, event-time rounding leak, or split leak?
2. Does micro child aggregation preserve weight, PnL, fees, funding, exit time,
   and baseline parity correctly?
3. Are discovery locks physically before OOS inspection where claimed?
4. Do selection functions implement preregistered count/net/DD/tail gates?
5. Does one-position standalone scanning skip overlapping positions correctly?
6. Are source defects (duplicates, null outages, off-second timestamps) handled
   conservatively rather than favorably?
7. Does report overstate evidence, omit a material limitation, or misquote a
   result?
8. Is `REJECT ALL / KEEP MARKET_NOW / NO DEPLOY` supported?

Do not request new strategies, parameter sweeps, deployment, or live changes.
