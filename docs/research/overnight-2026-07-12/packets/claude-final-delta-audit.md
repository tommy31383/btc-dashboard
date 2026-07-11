# Claude Final Delta Design Audit

Audit the current committed design at:

`/Users/lap16116/BTC_PC/btc-dashboard/docs/superpowers/specs/2026-07-12-overnight-autonomous-research-loop-design.md`

This is a compact retry after an Opus session-limit failure. It is still a real
mandatory Claude gate; quota/failure is not approval.

Verify only whether all prior blocking findings are now closed:

1. H01-only `MARKET_SIGNAL`; Champion stateful snapshot deferred.
2. Hash-locked `p1aPipeline` slice oracle with forming bar and 500-bar depth;
   existing server test passed 9/9.
3. Exactly six pure callable exports; ATR everywhere is exclusively
   `atrEntry4h(gateSlice4h(...,500))`; stateful entry/exit/label paths denied.
4. Causal regime/funding/volatility construction is fixed and fixture-tested.
5. Raw and gate-conditioned control arms both required; 2 metrics x 2 arms x 3
   setups use Bonferroni `0.05/12`; formulas/signs/estimands are frozen.
6. Every child is sandboxed; server clean/hash pre/post; PGID + recursive PPID
   cleanup; runtime safety gate commits before prereg/replay.
7. No deploy, arm, server write, secret, VPS/auth API, exchange mutation, PnL,
   win-rate, fill, or live-byte-parity claim.
8. Missing audit/guard/time leaves `AUDIT_PENDING`/`CUTOFF`/`INVALID`, never pass.

Read server source when needed. Return findings P0-P3 and explicit `APPROVED` or
`NOT APPROVED`. Do not edit files or contact live systems.
