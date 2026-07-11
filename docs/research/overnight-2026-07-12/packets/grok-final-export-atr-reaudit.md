# Grok Final Re-audit - Export and ATR Binding

Your attempt-8 audit left one P1 and one P2. Re-audit the current design only.
Claude approval remains mandatory.

Read:

- `/Users/lap16116/BTC_PC/btc-dashboard/docs/superpowers/specs/2026-07-12-overnight-autonomous-research-loop-design.md`
- `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/pure-import-design-precheck.md`
- `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/design-audit-log.md`
- `/Users/lap16116/BTC_PC/btc-trader-server/src/engine/p1aPipeline.ts`

Verify:

1. The exact six invocable pure exports cover slicing, ATR, snapshot, and regime
   construction; stateful entry/exit/label/Champion exports remain denied.
2. Every signal/control/vol-rank ATR is exactly
   `atrEntry4h(gateSlice4h(b4h,k,500))`, using at most 499 closed bars, with no
   dashboard ATR substitute.
3. Daily 500-window indices, missing forming bars, and insufficient ATR warmup are
   fail-closed.
4. All previous dual-arm inference, p1a parity, sandbox, anti-retune, audit-status,
   money-path, and cutoff controls remain intact.

Return P0-P3 findings and end `APPROVED` or `NOT APPROVED`. Do not edit files,
access secrets, contact VPS/exchange, or deploy.
