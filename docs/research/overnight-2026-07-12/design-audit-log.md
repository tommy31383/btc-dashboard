# Overnight Research Design Audit Log

This log is append-only in meaning: later approvals do not erase earlier failed
or blocking audits.

## Claude attempt 1 - failed, no verdict

- Recorded before: `2026-07-12T01:40:10+07:00`
- Model: `claude-opus-4-8`, high effort, plan permission mode, read-only tools
- Packet: `packets/claude-design-audit.md`
- Result: command exited 1 with `You've hit your limit`; reported reset was
  `02:10am (Asia/Saigon)`.
- Disposition: `CLAUDE_AUDIT_FAILED`. This is not approval. Activation remained
  closed.

## Grok attempt 1 - NOT APPROVED

- Completion was immediately before this record at
  `2026-07-12T01:43:13+07:00`.
- Model: the repository `scripts/grok/ask.sh` default (`grok-4.5`, max effort)
- Packet: `packets/grok-design-audit.md`
- Verdict: `NOT APPROVED`

Blocking findings and dispositions:

| Finding | Disposition in revised design |
|---|---|
| P0-1 server writes were policy-only | Night 1 is dashboard-only; server source, VPS, authenticated clients, deploy, and arming are forbidden. A future server sub-mode needs a separate design. |
| P0-2 preregistration was honor-system | Canonical preregistration plus SHA-256 and a mechanism/sample registry are mandatory; the evaluator refuses mismatches and duplicate keys. |
| P0-3 evidence could confuse entry quality with exposure/beta | Added deterministic matched and one-bar-delay controls, equal horizons/notional, exposure/beta reporting, fixed concentration checks, and validation confidence intervals. |
| P0-4 lock/cutoff/worktree controls were aspirational | Added an atomic lock, exact worktree assertion, single writer, command allowlist, child ownership/timeouts, 06:30 closeout, and hard deadline `1783814400`. |
| P1-1 audit failure could become soft PASS | Removed PASS/ACCEPTED statuses from Night 1. Missing Claude or Grok leaves only `AUDIT_PENDING`. |
| P1-2 live read-only access was unsafe | Removed VPS and authenticated exchange access. Existing local caches are default; only unauthenticated public market data can fill a missing cache. |
| P1-3 four lanes were not feasible overnight | Reduced Night 1 to one entry-quality diagnosis. New rules, H05, filters, and broad archaeology are backlog only. |
| P2 leakage/perturbation/relay/test concerns | Fixed 80/20 split with purge, removed perturbations, froze relay at `TURN=TOMMY`, and required exact test commands in the implementation plan. |

Status after revision: activation remains closed pending Grok re-audit and a real
Claude audit of the final text.

## Grok attempt 2 - NOT APPROVED

- Completion was immediately before this record at
  `2026-07-12T01:47:55+07:00`.
- Packet: `packets/grok-design-reaudit.md`
- Verdict: `NOT APPROVED`; former P0 findings were resolved, with two new P1 and
  three P2 fixes required.

Dispositions:

| Finding | Disposition in final candidate design |
|---|---|
| P1 owner override could be self-minted | Removed the override field and path. Night 1 accepts only one fixed mechanism and requires a future pre-approved design plus untouched data for any variant. |
| P1 command/path policy conflicted with faithful server imports | Added a frozen command/path matrix: exact hash-locked pure dist modules may be read/invoked; every server write/cwd, credential module, and operational command is denied and guard-tested. |
| P2 cosmetic mechanism IDs could bypass registry | Fixed the sole mechanism ID to `entry-quality-diagnosis` per data hash and refuse every second/renamed mechanism. |
| P2 Grok terminal was soft prose | Defined exactly `ALLOW_DIAGNOSIS`, `KILL_DIAGNOSIS`, or `AUDIT_FAILED`; only the first can complete a diagnosis. |
| P2 post-freeze data could drift | Replay refuses every byte whose SHA-256 differs from preregistration, including public-data extensions. |

Status after second revision: activation remains closed pending Grok attempt 3
and a real Claude audit of this final candidate text.

## Grok attempt 3 - APPROVED

- Completion was immediately before this record at
  `2026-07-12T01:50:30+07:00`.
- Packet: `packets/grok-design-reaudit-2.md`
- Verdict: `APPROVED` as an implementable process design, not as a trading or
  live-validation verdict.
- Open P0/P1: none.

Grok reported three non-blocking P2 clarity risks. They were still resolved
before Claude review:

- public data fallback now explicitly ends before preregistration freeze;
- the full transitive import graph of pure server dist modules must be resolved,
  allowlisted, and hash-locked;
- the supervisor permits exactly one preregistration creation and one registry
  append for the whole run, regardless of data hash.

Status: Grok design gate passed. Activation remains closed until a real Claude
audit approves this final post-P2 text with no unresolved P0-P2.

## Grok attempt 4 - APPROVED

- Completion was immediately before this record at
  `2026-07-12T01:52:55+07:00`.
- Packet: `packets/grok-design-reaudit-2.md`
- Verdict: `APPROVED`; open P0/P1: none. The audit confirmed the post-attempt-3
  public-data, transitive-import, and single-freeze clarifications.

Two non-blocking implementation-fidelity P2s and two P3 bookkeeping notes were
reported and resolved in the final Claude candidate:

- terminology now says `repository live-designated`; package/version/source and
  module hashes are pinned, and VPS byte parity cannot be claimed without
  pre-existing byte-level deployment provenance;
- import closure is statically scanned and dynamically loaded in a child that
  traps secret-env, network, child-process, filesystem-write, and cwd side effects;
- Night 1 wording now permits one mechanism and one data hash for the whole run;
- Grok result terminals require a structured `reason_code`.

Status: Grok gate remains approved. Claude approval is still mandatory and has
not yet occurred.

## Codex pre-Claude self-review

Read-only source inventory found that `evalHedge01TrendSnapshot` is the exact
market-gate path but intentionally excludes account/execution gates. The design
now labels every Night-1 row `MARKET_SIGNAL`, forbids fill/accepted-intent and win
rate/PnL claims, and defers stateful actual-intent replay to a separate preregistered
run. This narrows the claim without changing the Grok-approved money-path or
anti-retune controls.

## Claude attempt 2 - NOT APPROVED

- Completion was immediately before this record at
  `2026-07-12T02:15:59+07:00`.
- Model: `claude-opus-4-8`, high effort, plan permission mode, read-only tools.
- Packet: `packets/claude-design-audit.md`.
- Verdict: `NOT APPROVED`; no P0, three P1 and two blocking P2 findings.
- Limitation: the command ran from the dashboard repository and Claude was not
  granted read access to sibling root/server paths. Its import-graph finding was
  explicitly a flagged risk, not an empirical claim. The re-audit will run from
  the workspace root so it can verify those files directly.

Required findings accepted for resolution:

| ID | Disposition |
|---|---|
| O | Move pure transitive-import proof into the activation gate. If it fails, stop before replay and report `INVALID`; never approximate. |
| K | Spawn each child in an owned process group and terminate/verify the whole group at timeout/cutoff. |
| A | Reject every computed/dynamic `require` or `import()` in the allowed import closure. |
| M | Put transient lock/process state outside Git and define source cleanliness by an exact generated-evidence exemption. |
| H | Add a renderer test proving non-complete statuses cannot appear in audited/positive sections. |

Recommended B/J/E hardening is also accepted: minimal env allowlist, PID
start-identity stale-lock validation, and a structurally outcome-blind metadata
inventory executable.

Status: activation remains closed pending fixes plus Grok and Claude re-audits.
