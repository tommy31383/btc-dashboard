# Grok Re-audit - Claude Attempt-4 Findings

Claude attempt 4 returned `NOT APPROVED` with one P1 and three P2 blockers.
Re-audit the current design adversarially. Claude approval remains mandatory.

Read:

- `/Users/lap16116/BTC_PC/btc-dashboard/docs/superpowers/specs/2026-07-12-overnight-autonomous-research-loop-design.md`
- `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/pure-import-design-precheck.md`
- `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/design-audit-log.md`
- `/Users/lap16116/BTC_PC/btc-trader-server/src/engine/p1aPipeline.ts`
- `/Users/lap16116/BTC_PC/btc-trader-server/test/p1a-pipeline.test.mjs`
- `/Users/lap16116/BTC_PC/btc-trader-server/src/engine/rules/hedge01.ts`

Verify:

1. Gate inputs directly use hash-locked `p1aPipeline` slice oracles with forming
   bar included and exact 500-bar live depth; existing server tests plus dashboard
   parity/hand fixtures are mandatory.
2. Raw-market and gate-conditioned other-setup PASS control arms are both frozen;
   both must confirm, family correction covers 2 metrics x 2 arms x 3 setups,
   and Grok must attack gate-selection confounding explicitly.
3. Causal volatility rank and exact quintile boundaries are fixed and tested.
4. Full runtime safety gate commits first; no guard may be weakened for time;
   CUTOFF/AUDIT_PENDING without replay is acceptable.
5. Matrix/report hashes are cross-bound in preregistration, daemon/background
   commands are denied, import/type-erasure drift is INVALID, and diagnosis prose
   comes from status-specific templates.
6. All prior H01-only, money-path, anti-retune, sandbox, descendant cleanup,
   inference, audit-status, and cutoff controls remain sound.

Return P0-P3 findings with exact sections, then `APPROVED` or `NOT APPROVED`.
Do not edit files, access secrets, contact VPS/exchange, or deploy.
