# BTC StochRSI Tactical-Only Exploratory - Implementation Plan

**Goal:** Add and falsify one pre-registered lifecycle-only BTC variant without
changing any entry or threshold and without altering the recorded Hybrid-Lite KILL.

## Task 1: Freeze the follow-up before seeing its result

- Commit this design and plan separately from implementation.
- Record Grok's pre-result audit: no P0-P3 in Hybrid; tactical attribution is
  causally valid; the follow-up is post-hoc and must remain exploratory.

## Task 2: Add the tactical-only lifecycle test-first

Files:

- `tools/stochrsi-macro-cycle/replay.test.ts`
- `tools/stochrsi-macro-cycle/replay.ts`

Steps:

1. Add failing tests for all-tactical roles, causal recovery, macro priority,
   unrecovered open legs, entry parity, and `0.001 BTC` peak exposure.
2. Add `TACTICAL_ONLY` to `VariantName`, frozen row order, leg construction,
   and `runFrozenVariants`.
3. Reuse the same recovery-vs-macro resolution as Hybrid tactical legs.
4. Run focused replay tests and strict targeted TypeScript.

## Task 3: Add the frozen exploratory verdict test-first

Files:

- `tools/stochrsi-macro-cycle/report.test.ts`
- `tools/stochrsi-macro-cycle/report.ts`
- `tools/stochrsi-macro-cycle/io.test.ts`
- `tools/stochrsi-macro-cycle/io.ts`

Steps:

1. Add failing tests for schema/version bump, the exploratory warning, and the
   exact eight checks in the design.
2. Add `tacticalOnlyVerdict`, including a causal unresolved-leg comparison
   against the original campaign signals.
3. Render both Hybrid and tactical-only verdicts and role attribution.
4. Preserve Hybrid check values in fixed fixtures.
5. Run the complete macro-cycle suite and targeted strict TypeScript.

## Task 4: Generate clean evidence and audit

1. Commit source before replay.
2. Generate online and offline artifacts from separate clean detached worktrees.
3. Require Markdown byte equality and JSON equality after deleting only
   `generatedAt`; provenance must report `gitDirty=false`.
4. Record cache/output hashes, invalid-token scan, zero funding marks, raw
   metrics, and both verdicts.
5. Run Grok adversarial review and an independent code review. Claude Opus must
   be retried if its CLI quota is available; quota failure must be reported, not
   represented as a completed review.
6. Fix valid findings, regenerate evidence after any source change, and run
   final verification. Do not deploy.
