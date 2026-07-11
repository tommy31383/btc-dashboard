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

## Owner decision

Scope B is approved:

- research may modify `btc-trader-server` source only behind default-OFF entry
  gates;
- no deploy, live arming, secret edits, exchange writes, or position changes;
- Claude must approve the design before activation.

## Known context

- Existing relay watcher is running but the detailed relay STATUS is stale.
- The project has many old backtests with inconsistent provenance.
- Codex will orchestrate; Claude is a bounded reviewer; Grok is adversarial.
- BTC is the research target for this run.
- The intended active window ends around 07:00 Asia/Ho_Chi_Minh.

## Attack questions

1. Can any permitted path accidentally deploy, arm, expose secrets, mutate an
   exchange order, or interfere with CLOSE handling?
2. Are the anti-overfit rules concrete enough to prevent an endless optimizer
   from selecting a lucky rule on the same seven-year sample?
3. Is the evidence ledger sufficient to reproduce and supersede conclusions?
4. Are Claude/Grok timeout and quota behaviors fail-closed?
5. Are worktree, branch, concurrency, and stop semantics implementable without
   corrupting either repository?
6. Is the queue scoped tightly enough to produce a useful morning report?
7. Which requirements are ambiguous, contradictory, or impossible to test?

## Expected response

- Findings first, severity `P0` through `P3`, with design section references.
- Explicit `APPROVED` or `NOT APPROVED`.
- Exact required changes for every blocking finding.
- Residual risks and the smallest safe activation plan.
- Do not edit files, deploy, access secrets, or contact the exchange.
