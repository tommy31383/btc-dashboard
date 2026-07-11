# H01 Research Run 2 Authorization Addendum

**Owner instructions:** `vay may tu chay`, followed by
`lach qua bo vu thoi gian cho tao`, then
`claude het token limit roi may tu lam tu audit di`, received on 2026-07-12.

This starts a new bounded research-only window rather than weakening the expired
Night-1 cutoff. It inherits every scientific, sandbox, money-path, audit-status,
and no-live restriction from:

`docs/superpowers/specs/2026-07-12-overnight-autonomous-research-loop-design.md`

Only these run-instance values change:

| Field | Run 2 value |
|---|---|
| Activation | Owner-authorized Codex execution may start immediately |
| Closeout | No wall-clock closeout |
| Hard stop | No wall-clock hard stop; stop on completion, owner stop, or safety failure |
| `deadline_unix` | `null` |
| Research directory | `docs/research/run-2-2026-07-12/` |
| Worktree name | `run-2-2026-07-12-entry-audit` |
| Branch | `research/run-2-2026-07-12-entry-audit` |
| TMP lock root | `${TMPDIR}/btc-pc-run-2-2026-07-12/` |

The eight generated-evidence literals are remapped to the Run-2 directory with
the same basenames and semantics:

1. `run.json`
2. `ledger.jsonl`
3. `artifacts/entry-quality-signals.jsonl`
4. `artifacts/entry-quality-aggregate.json`
5. `artifacts/entry-quality-provenance.json`
6. `artifacts/codex-result-audit.md`
7. `artifacts/grok-result-audit.txt`
8. `morning-report.md`

Owner instruction authorizes Codex to implement and execute autonomously without
a run-level time limit. Per-child timeouts, sandbox cleanup, one-replay freeze,
and every no-live restriction remain mandatory. It does not authorize deployment,
live arming, server writes, secrets, VPS/authenticated API, or exchange/account
mutation.

For Run 2, Codex self-audit replaces the unavailable Claude review. A confirmed
scientific conclusion requires all frozen tests/checks, a written Codex review
with no unresolved P0-P2, and independent Grok terminal `ALLOW_DIAGNOSIS`.
Otherwise the maximum status is `AUDIT_PENDING`, `INVALID`, or
`INSUFFICIENT_SAMPLE`; owner authorization cannot promote, retune, or relabel the
result.
