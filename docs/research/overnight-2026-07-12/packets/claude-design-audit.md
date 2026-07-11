# Claude Design Audit Packet - Overnight Autonomous Research Loop

## Task

Audit the proposed autonomous overnight BTC_PC research process before it is
implemented or activated.

## Scope

- Workspace: `/Users/lap16116/BTC_PC`
- Design:
  `/Users/lap16116/BTC_PC/btc-dashboard/docs/superpowers/specs/2026-07-12-overnight-autonomous-research-loop-design.md`
- Process reference:
  `/Users/lap16116/BTC_PC/docs/THREE_AGENT_PROCESS.md`
- Live-server policy:
  `/Users/lap16116/BTC_PC/btc-trader-server/AGENTS.md`
- Pure-import design precheck:
  `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/pure-import-design-precheck.md`
- Prior audit trail:
  `/Users/lap16116/BTC_PC/btc-dashboard/docs/research/overnight-2026-07-12/design-audit-log.md`

## Owner decision and narrowed run scope

Scope B is the permission ceiling, but Night 1 is narrower:

- dashboard-only source changes and one H01 S12/S13/S14 market-signal diagnosis;
- `btc-trader-server` is read-only;
- no new rule/filter/H05 replay, authenticated API/VPS, deploy, live arming,
  secret access, exchange writes, or position changes;
- Claude must approve the design before activation.

## Known context

- Existing relay watcher is running but the detailed relay STATUS is stale.
- The watcher remains untouched at `TURN=TOMMY`; the run ledger is the sole source
  of truth.
- Codex will orchestrate; Claude is a bounded reviewer; Grok is adversarial.
- BTC is the research target for this run.
- Grok's first design audit returned `NOT APPROVED`; its P0/P1 findings were
  incorporated and a re-audit is mandatory.
- Claude attempt 2 returned `NOT APPROVED`; findings O/K/A/M/H plus recommended
  B/J/E were incorporated. Attempt 2 could not read sibling server/root files;
  this re-audit runs from the workspace root and must verify them directly.
- Claude attempt 3 empirically cleared the import graph but returned one P1 and
  four P2 findings. The design now removes state-dependent Champion from Night 1,
  freezes/tests H01 causal input construction with `persistBars=1`, sandboxes
  every child, adds recursive PPID/`setsid` cleanup, and uses two Bonferroni-
  corrected primary deltas.
- Grok attempt 6 then found residual metric shopping. The final text fixes one
  six-bar/ATR14 impulse scalar, one 90-bar confirmed overhead-pivot scalar, both
  signs, no feature peek, no path-quality claim, and family-wise correction over
  all setup-metric-control-arm tests.
- Claude attempt 4 then found the live 500-bar depth oracle, gate-selection
  confounding, vague volatility bins, and deadline pressure. The final text now
  imports hash-locked `p1aPipeline` slices at 500 bars, requires raw and other-
  setup PASS control arms with twelve-test correction, fixes causal rank bins,
  and commits the full safety gate before any preregistration/replay.
- Grok attempt 8 then caught an invocable-export contradiction and an unbound ATR
  implementation. The final text allowlists exactly the six pure exports needed
  and requires every signal/control ATR to call
  `atrEntry4h(gateSlice4h(...,500))`; stateful entry/exit/label exports remain
  denied.
- The hard stop is `2026-07-12T07:00:00+07:00`.

## Attack questions

1. Do the dashboard-only scope and command/path guards mechanically exclude every
   money path and server source write?
2. Do preregistration hashing, duplicate registry refusal, frozen 80/20 split,
   and no-filter rule prevent same-sample retuning?
3. Are matched controls, one-bar-delay controls, exposure/beta fields, and
   concentration checks sufficient for the narrow diagnosis being claimed?
4. Can missing Claude/Grok audits produce any positive status or report language?
5. Are lock, worktree, child ownership, timeouts, and hard-cutoff semantics
   implementable and fail-closed?
6. Is the single diagnosis feasible before the exact deadline?
7. Which remaining requirements are ambiguous, contradictory, or impossible to
   test?

## Expected response

- Findings first, severity `P0` through `P3`, with design section references.
- Explicit `APPROVED` or `NOT APPROVED`.
- Exact required changes for every blocking finding.
- Residual risks and the smallest safe activation plan.
- Do not edit files, deploy, access secrets, or contact the exchange.
