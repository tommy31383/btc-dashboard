# Grok Re-audit - Claude Attempt-3 Findings

Claude attempt 3 returned `NOT APPROVED` with one P1 and four P2 findings.
Adversarially re-audit the current narrowed design. Claude's approval remains
mandatory and independent.

Read:

- `/Users/lap16116/BTC_PC/btc-dashboard/docs/superpowers/specs/2026-07-12-overnight-autonomous-research-loop-design.md`
- `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/pure-import-design-precheck.md`
- `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/design-audit-log.md`
- `/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/rules/hedge01.js`
- `/Users/lap16116/BTC_PC/btc-trader-server/dist/engine/regime.js`
- `/Users/lap16116/BTC_PC/btc-trader-server/AGENTS.md`

Verify:

1. Champion is fully removed from Night 1 because its snapshot is state-dependent;
   the only active unit is H01 `MARKET_SIGNAL`.
2. The label `FUNCTION_FAITHFUL_INPUTS_NOT_LIVE_VERIFIED` and hand fixtures bound
   the claim honestly; H01 uses actual call-site `persistBars=1`, not helper
   default 3.
3. Every supervisor child uses a frozen `sandbox-exec` write/network profile and
   minimal env; server cleanliness plus module hashes are checked before/after.
4. Process-group cleanup is supplemented by recursive PPID discovery/tracking and
   a `setsid` grandchild test.
5. Impulse and causal overhead-resistance distance are the only confirmatory
   deltas; both need Bonferroni-corrected 97.5% validation intervals. Other path
   metrics are exploratory.
6. Matched controls, causal volatility bins, fixed renderer IDs, money-path,
   anti-retune, hash, audit-status, and exact-cutoff protections remain intact.

Return findings first with P0-P3 and exact sections. End `APPROVED` or
`NOT APPROVED`. Do not edit files, access secrets, contact VPS/exchange, or deploy.
