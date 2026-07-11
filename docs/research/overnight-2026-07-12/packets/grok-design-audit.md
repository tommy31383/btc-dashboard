# Grok Adversarial Design Audit - Overnight Autonomous Research Loop

Act as the adversary. Try to stop an unsafe or statistically dishonest overnight
trading-research loop. This audit does not replace the mandatory Claude gate.

Read:

- `/Users/lap16116/BTC_PC/btc-dashboard/docs/superpowers/specs/2026-07-12-overnight-autonomous-research-loop-design.md`
- `/Users/lap16116/BTC_PC/docs/THREE_AGENT_PROCESS.md`
- `/Users/lap16116/BTC_PC/btc-trader-server/AGENTS.md`

Owner-approved boundary: research may modify live-server source only behind
default-OFF gates. No deployment, arming, env/secret changes, exchange writes,
or position changes.

Attack these claims:

1. The loop cannot accidentally touch money paths or orphan CLOSE handling.
2. Pre-registration and the verdict registry actually prevent repeated
   same-sample optimization.
3. The proposed evidence is enough to distinguish entry improvement from lower
   exposure, hidden beta, or lucky campaigns.
4. The 07:00 cutoff, queue, locks, and worktrees are implementable and fail
   closed.
5. Claude/Grok quota failures cannot be silently treated as approval.
6. The planned research lanes are narrow enough to deliver useful evidence in
   one night.

Return:

- P0-P3 findings with exact design section references.
- `APPROVED` or `NOT APPROVED` as a process design.
- Required fixes for every blocking finding.
- The smallest useful first research cycle.
- Do not edit files, deploy, access secrets, or contact the exchange.
