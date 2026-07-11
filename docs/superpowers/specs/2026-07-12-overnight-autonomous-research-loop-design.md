# BTC_PC Overnight Autonomous Research Loop - Design

**Date:** 2026-07-12  
**Owner permission ceiling:** Scope B selected by Tommy.

**Night-1 operating scope:** Dashboard-only source changes and local BTC
research. `btc-trader-server` is read-only.

**Activation gate:** A real Claude review must approve the final revised design
with no unresolved P0-P2. Grok's blocking design findings must be resolved and
re-audited before the autonomous implementation loop starts.

**Hard stop:** `2026-07-12T07:00:00+07:00` (`deadline_unix=1783814400`).

**Safety boundary:** No deployment, live arming, server source change, secret
access, authenticated exchange/VPS access, or exchange write.

## 1. Objective

Run one bounded research cycle through the morning that:

1. Diagnoses whether repository live-designated Hedge01 S12/S13/S14 market
   signals systematically occur after an impulse and too close to local
   resistance, without claiming unverified VPS byte identity.
2. Uses the exact production signal path or returns `INVALID` rather than
   substituting a convenient approximation.
3. Compares entry timing with deterministic, time/regime/direction-matched
   controls and reports entry-quality distributions on discovery and untouched
   validation periods.
4. Uses Claude for bounded code/causality review and Grok as the mandatory
   adversarial result auditor.
5. Produces reproducible code, provenance, a diagnosis, and a morning report.

Night 1 does not create, optimize, or test a replacement filter, entry rule,
threshold, sizing rule, or H05 action. Its valid terminal scientific statuses are
`DIAGNOSIS_COMPLETE`, `INSUFFICIENT_SAMPLE`, or `INVALID`; none means that a
profitable replacement rule has been found.

## 2. Permission Boundary

The owner selected Scope B as a permission ceiling. This run deliberately uses a
narrower dashboard-only sub-scope. Any future live-server research sub-mode needs
a separate reviewed design with a path allowlist, CLOSE/membership regression
suite, and a deploy refusal guard for research branches.

### Allowed

- Read non-secret committed project code, docs, tests, reports, journals, and
  existing local historical market-data caches.
- Create one isolated `btc-dashboard` worktree and research branch.
- Add dashboard-only diagnosis tools, tests, reports, and evidence artifacts.
- Read `btc-trader-server` source to identify and import or invoke the faithful
  signal path without modifying that repository.
- Commit coherent dashboard research checkpoints to the research branch.
- Before preregistration freeze only, make unauthenticated public market-data
  requests if the local cache is incomplete; record each request and resulting
  data hash. After freeze, an incomplete cache is `INVALID` and no network fill
  is allowed.

### Forbidden

- Run `deploy.sh`, restart PM2, rsync production, or edit production files.
- Arm a rule, change a REAL flag, remove an entry gate, or change live settings.
- Edit `/etc/btc-trader/env`, rotate credentials, read or print secret values,
  change DNS, or modify access control.
- Run SSH, PM2, an authenticated Binance client, an account/position snapshot,
  or any script that loads production credentials.
- Submit, cancel, amend, close, DCA, reverse, or otherwise mutate any exchange
  position or order.
- Modify any `btc-trader-server` source file during Night 1.
- Change the CLOSE-before-entry-gate invariant.
- Merge live-server research changes to `main` automatically.
- Claim that a discovery-sample PASS is live validation.

## 3. Current Constraints

- The existing relay watcher is running, but `AI_RELAY.md` contains a stale
  lower STATUS block and is unsuitable as the detailed overnight state store.
- The workspace contains many historical backtest scripts and artifacts with
  inconsistent provenance. Their conclusions are not trusted until reproduced.
- Claude and Grok have quota and timeout failure modes. A failed call is evidence
  of no audit, never an implicit PASS.
- The owner previously constrained this research line to BTC. Other assets are
  not optimized or proposed as live sleeves during this run.
- Full project TypeScript currently has known unrelated errors in legacy tools.
  Every touched module still requires a clean targeted strict check, and the
  exact command set is frozen in the implementation plan before activation.

## 4. Architecture

### 4.1 Codex supervisor

Codex owns the single diagnosis cycle, worktree, implementation, verification,
and final report. It runs under an explicit active goal and continues without
waiting for user input unless a forbidden action or genuine blocker is
encountered.

The executable supervisor is a local Node process with these mechanical guards:

- atomically acquires
  `${TMPDIR}/btc-pc-overnight-2026-07-12/.supervisor.lock/` using `mkdir`; the
  directory stores PID, OS process-start identity, hostname, supervisor start,
  random run ID, and deadline;
- exits non-zero when a live lock exists; a stale lock is recoverable only on the
  recorded host when the PID is absent or its OS start identity differs. A lock
  from another host or an unverifiable identity fails closed, and every recovery
  is appended to the ledger;
- asserts that its repository root is the dedicated dashboard research worktree
  before every source-writing step;
- owns the only ledger writer and uses temp-file-plus-rename for structured state;
- starts every child detached in a new owned process group, records PID/PGID/run
  ID, gives it a wall-clock timeout, and terminates the entire owned process group
  at timeout or cutoff;
- recursively samples each child's PPID tree, records every observed descendant
  PID/start identity, and uses both the process group and tracked descendant set
  during cleanup;
- executes a frozen command allowlist. SSH, rsync, PM2, deploy scripts,
  authenticated clients, server writes/cwd, and every server import except the
  hash-locked pure modules below are rejected.

No two agents write the same files. A long replay may overlap only with
read-only review of its already-frozen inputs.

Descendant discovery recursively walks `/bin/ps` PPID links every 100 ms while a
child is alive and again immediately before termination. Cleanup sends `SIGTERM`
deepest-first to tracked descendants and to the negative owned PGID, waits five
seconds, then repeats with `SIGKILL`. It refuses PID/PGID `<=1`, refuses an
identity not recorded under the current run ID, and verifies both the live PPID
tree and all tracked identities are gone. Tests cover a normal grandchild, a
`setsid` grandchild with a new PGID, and an unrelated control process; the two
owned trees must die and the control must survive.

On this macOS host, OS process-start identity is the normalized value of
`/bin/ps -o lstart= -p <pid>` plus the resolved executable path. Both are recorded
at lock creation and compared during stale-lock recovery; parse/read failure is
unverifiable and therefore fails closed.

#### Command and path matrix

Before activation, the implementation commits
`docs/research/overnight-2026-07-12/command-path-matrix.json` and its SHA-256.
The supervisor loads exactly that file and refuses an unknown executable,
subcommand, argument pattern, read path, write path, or network origin.

| Operation | Frozen policy |
|---|---|
| Dashboard writes | Allow only the dedicated worktree under `tools/overnight-entry-audit/**` and `docs/research/overnight-2026-07-12/**`. |
| Local data reads | Allow only cache files enumerated with SHA-256 in preregistration. |
| Production signal imports | Allow read-only imports of hash-locked `btc-trader-server/dist/engine/rules/hedge01.js`, `dist/engine/rules/ruleHelpers.js`, `dist/engine/regime.js`, and `dist/engine/hwm.js`. Resolve the complete runtime import graph before freeze; every transitive module must be on this pure-module list and hash-locked, otherwise the rule is `INVALID`. Only `evalHedge01TrendSnapshot` may be invoked for entry signals. |
| Local executables | Allow `/usr/bin/sandbox-exec` plus exact argument patterns for `git` metadata/commit operations, the repository's local Node/TypeScript runtime, frozen targeted tests/typecheck, SHA-256, Claude read-only audit, and `scripts/grok/ask.sh` with committed packets. |
| Public data fallback | Allow HTTPS GET only to the preregistered public kline endpoint and only before preregistration is frozen; the resulting file/hash becomes the frozen cache. |
| Always deny | Any write/cwd under `btc-trader-server`; source `.ts` runtime import; `ssh`, `scp`, `sftp`, `rsync`, `pm2`, `deploy.sh`, `curl`/generic HTTP clients, shell evaluation, production env loaders, authenticated Binance/account modules, relay TURN edits, and any unlisted network origin. |

Automated guard tests exercise every allowed class and every deny row. Imported
server module and complete transitive-import-graph hashes must equal
preregistration; mismatch is `INVALID`. This matrix allows pure signal execution
while mechanically excluding server writes, credential-bearing modules, and
operational tooling.

Every supervisor child, not only the import child, runs through
`/usr/bin/sandbox-exec` with a phase-specific profile frozen inside the matrix and
an exact phase-specific environment allowlist. Local inventory/test/replay phases
deny all network and allow writes only to their exact TMP run directory plus the
phase's declared dashboard paths. Public-cache fill and Claude/Grok audit phases
permit outbound network only through their dedicated allowlisted executable and
still deny every write under `btc-trader-server`, `$HOME`, unrelated repos, and
all non-declared dashboard paths. Before and after every child, the supervisor
requires `git -C btc-trader-server status --porcelain` to be empty and rechecks
the four preregistered server-module hashes; a difference stops the run without
reverting it. Sandbox denial itself is a failed phase, never a reason to retry
without the profile.

Before dynamic import, a static closure scan rejects production env/secret access,
network modules/calls, child-process calls, filesystem writes, cwd mutation, and
every non-literal/computed `require(...)` or `import(...)`. The only permitted env
read is the exact non-secret literal `process.env.RULE_DISABLE_S12`; its frozen
repository-default value is `false` and is recorded in preregistration. Every
other env read is `INVALID`. The complete literal import graph must resolve to the
hash-locked allowlist. A computed or unresolved edge is `INVALID`; test fixtures
prove each class is rejected.

The import then runs in an isolated child whose entire environment is rebuilt from
an exact minimal allowlist (`TZ=UTC`, `LANG=C`, `LC_ALL=C`,
`RULE_DISABLE_S12=false`); executables use frozen absolute paths, so inherited
`PATH`, `HOME`, tokens, keys, and arbitrary variables are absent. Network,
child-process, write, and `chdir` operations are trapped; any attempt terminates
the process group and records `INVALID`. Tests prove a pure allowed import plus
every static and runtime side-effect class.

The pure-graph scan and isolated import are an activation go/no-go check, before
preregistration or outcome replay. If either production signal graph is impure or
cannot load under these guards, the affected rule is recorded `INVALID`, the run
does not build/replay an approximation, and the morning report states that the
faithful path was structurally unavailable.

### 4.2 Research state

The detailed run state lives under:

`btc-dashboard/docs/research/overnight-2026-07-12/`

Required files:

- `run.json`: finalized evidence copy of supervisor timestamps, deadline, owned
  process groups, and terminal phase.
- `ledger.jsonl`: append-only events written by the single supervisor.
- `prereg/entry-quality-diagnosis.json`: canonical pre-registration.
- `prereg/entry-quality-diagnosis.sha256`: hash required by the evaluator.
- `registry.jsonl`: immutable mechanism/sample verdict registry.
- `knowledge-map.md`: current facts, stale claims, reusable tools, and conflicts.
- `queue.md`: the single active diagnosis, blockers, and deferred backlog.
- `morning-report.md`: final results and recommendations.
- `packets/`: short Claude and Grok review packets.

`queue.md`, `knowledge-map.md`, preregistration, registry, matrix, packets, source,
and tests are committed and frozen before replay. Transient lock data, active
child manifests, temp files, and mutable supervisor state live only under
`${TMPDIR}/btc-pc-overnight-2026-07-12/<run-id>/`, outside Git. `run.json`,
`ledger.jsonl`, raw rows, aggregates, and reports are generated evidence.

The complete post-freeze dirty-path allowlist is exactly:

1. `docs/research/overnight-2026-07-12/run.json`
2. `docs/research/overnight-2026-07-12/ledger.jsonl`
3. `docs/research/overnight-2026-07-12/artifacts/entry-quality-signals.jsonl`
4. `docs/research/overnight-2026-07-12/artifacts/entry-quality-aggregate.json`
5. `docs/research/overnight-2026-07-12/artifacts/entry-quality-provenance.json`
6. `docs/research/overnight-2026-07-12/artifacts/claude-result-audit.txt`
7. `docs/research/overnight-2026-07-12/artifacts/grok-result-audit.txt`
8. `docs/research/overnight-2026-07-12/morning-report.md`

The source-clean check parses `git status --porcelain=v1 -z` and permits only
those eight literals. Any other changed, staged, renamed, or untracked path after
the freeze commit blocks replay. Thus the immutable source commit stays clean
while declared outputs are generated and later committed.

The existing relay watcher remains untouched at `TURN=TOMMY`. The research
ledger is the sole source of truth for this run; the supervisor neither changes
relay TURN, writes relay checkpoints, nor asks that watcher to execute work.

Each diagnosis ledger record includes:

- stable diagnosis ID and parent mechanism, if any;
- status: `PLANNED`, `RUNNING`, `RESULT_RECORDED`, `AUDIT_PENDING`,
  `DIAGNOSIS_COMPLETE`, `INSUFFICIENT_SAMPLE`, `INVALID`, `CUTOFF`, or
  `BLOCKED`;
- exact frozen question and preregistration hash;
- source commit, dirty flag, evaluator version, data range, and data hashes;
- discovery/validation labels;
- commands and test counts;
- signal count, cohort coverage, MFE/MAE, first-move direction, resistance
  distance, impulse, same-side/regime/time-matched controls, and costs when
  applicable;
- concentration, time-split, control, and robustness results;
- Claude and Grok verdicts, including failures/timeouts;
- next decision.

The evaluator refuses to run when the preregistration file is missing, its
SHA-256 does not match, the source worktree is dirty outside the exact generated
evidence allowlist, any replay byte differs from the preregistered data hashes, or a result
already exists for the same
`mechanism_id + rule_fingerprint + data_range_hash + cost_model_id`.

Night 1 permits exactly one mechanism ID, `entry-quality-diagnosis`, and one
data-range hash for the whole run. A second mechanism ID, renamed mechanism,
changed data hash, changed rule fingerprint, changed cost model, or later variant
is refused. There is no owner-override field or override path in Night 1; a
future run needs a new pre-approved design and untouched validation data.

The supervisor additionally permits exactly one preregistration creation and one
registry append during the entire Night-1 run, regardless of mechanism name or
data hash. Once either is written, a second freeze attempt is refused rather than
creating a fresh hash.

### 4.3 Repository isolation

- Dashboard research uses a dedicated worktree named
  `overnight-2026-07-12-entry-audit` on a `research/overnight-2026-07-12-*`
  branch.
- The main dashboard worktree and every `btc-trader-server` worktree are
  read-only for Night 1.
- The research branch is never automatically pushed, deployed, or merged.
- Generated evidence is committed only after the source commit is clean and the
  report provenance points to that source.

### 4.4 Agent adapters

Claude receives packets under 250 lines and reviews one bounded question at a
time. The initial Claude task is this design audit. Later tasks cover code,
causality, accounting, test gaps, or a proposed next hypothesis.

Grok receives a compact adversarial packet only after a faithful result exists.
It attacks lookahead, data leakage, overfit, costs, concentration, no-ruin, and
verdict math. One compact retry is allowed after a timeout. Its machine-readable
terminal must be exactly `ALLOW_DIAGNOSIS`, `KILL_DIAGNOSIS`, or `AUDIT_FAILED`;
any other/missing terminal is `AUDIT_FAILED`.

The result-audit response must end with one JSON object containing `terminal` and
`reason_code`. `ALLOW_DIAGNOSIS` requires `reason_code=NONE`;
`KILL_DIAGNOSIS` requires one of `CAUSALITY_INVALID`, `PARITY_INVALID`,
`CONTROL_INVALID`, or `INSUFFICIENT_SAMPLE`; `AUDIT_FAILED` requires
`TIMEOUT`, `QUOTA`, `MALFORMED`, or `TOOL_FAILURE`. Missing or inconsistent
fields become `AUDIT_FAILED/MALFORMED`.

Codex remains the orchestrator. Claude and Grok may propose the next item, but
they do not deploy or arm anything.

## 5. Night-1 Research Cycle

### 5.1 Frozen question

Do repository live-designated Hedge01 S12/S13/S14 market signals show a
repeatable late/crowded-entry signature: a large already-completed impulse,
little remaining distance to causal local resistance, and worse near-term path
quality than matched same-side timestamps?

The exact production signal path is mandatory. If it cannot be invoked or shown
equivalent without editing `btc-trader-server`, the affected rule is `INVALID`.
No approximate rewrite can contribute to the diagnosis.

The Night-1 unit is a market-deterministic entry signal, not an exchange fill or
an account-accepted order. `evalHedge01TrendSnapshot` is the production single
source of truth for S12/S13/S14 market gates but intentionally excludes cooldown,
qty, HWM, bucket-cap, and scheduler/account gates. Therefore:

- output rows are labeled `MARKET_SIGNAL`, never `LIVE_FILL`;
- H01 results cannot claim the distribution of actually accepted intents or fills;
- no win rate, PnL edge, or live execution rate is inferred from this diagnosis;
- a later actual-intent audit requires a separately preregistered stateful replay
  of rule state, cooldown confirmation, exits, bucket capacity, and scheduler
  gates, plus deployment/trade-log identity evidence.

Champion is explicitly deferred because `evalSleeveSnapshot` includes capacity
and cooldown in its PASS verdict. Treating those inputs as always-passing would be
an approximation; reproducing them requires a separately preregistered stateful
Champion replay. No Champion row or conclusion appears in Night 1.

Preregistration pins the local server git SHA, package version, module/import-graph
hashes, and any pre-existing non-secret deployment evidence available before
activation. If that evidence proves only a version match, the report must say
`VERSION_MATCHED_NOT_BYTE_VERIFIED`; if it proves no match, it must say
`DEPLOYMENT_IDENTITY_UNVERIFIED`. No Night-1 result may claim VPS byte parity or
"current deployed behavior" without a pre-existing byte-level provenance record.

### 5.2 Causal input contract

Night 1 is labeled `FUNCTION_FAITHFUL_INPUTS_NOT_LIVE_VERIFIED`: it invokes the
hash-locked production market-gate function with preregistered causal inputs but
does not claim a live reference-vector comparison.

- Source bars are the frozen BTC 1h cache with UTC open timestamps. The runner
  validates ordering, uniqueness, one-hour spacing, and OHLC consistency before
  any signal call.
- 4h and 1d bars use UTC epoch buckets and only complete constituent 1h bars. At
  each 4h evaluation, 1h/4h/1d arrays include one explicit synthetic current
  partial bar because the production helpers discard their final item with
  `slice(0,-1)`; the synthetic values are fixture-tested to prove they cannot
  affect the signal.
- Signal time is the just-closed 4h bar's close timestamp. Outcome measurement
  begins at the next 4h open; no closed bar after signal time enters any feature.
- Funding is an as-of join using the latest record timestamp `<= signal_time`.
  A missing or stale preregistered funding record invalidates that row rather
  than filling from the future.
- H01 regime state starts from the production defaults and steps exactly once per
  newly closed daily bar using `detectRegime` plus
  `stepRegimePersist(..., persistBars=1)`. The value `1` is the current H01
  call-site behavior; the helper's default `3` is not used.
- Volatility quintile is causal per timestamp: current ATR percentile against the
  preceding 90 closed 4h bars, then bucketed into five fixed bins. No full-split
  quantile boundary is fitted.

Hand-computed fixtures cover UTC 1h->4h and 1h->1d boundaries, partial-bar
exclusion, next-bar indexing, funding as-of behavior, a regime transition with
`persistBars=1`, and causal volatility bins. Fixture failure is `INVALID`, not a
reason to alter input construction after seeing outcomes.

### 5.3 Measurements

For every causal next-bar entry, measure using only information closed at signal
time:

- prior impulse in ATR units and distance from the recent causal swing low;
- distance in ATR units to Donchian/recent resistance and EMA bands;
- higher-timeframe structure, lower-timeframe trend, and volatility quintile;
- delay from the first qualifying context event;
- MFE and MAE after 1, 3, 6, 12, 24, and 48 rule-timeframe bars;
- favorable-first versus adverse-first path and fee/slippage break-even.

Two controls are frozen before replay:

1. twenty deterministic same-side timestamps per entry, matched inside the same
   temporal split on rule timeframe, calendar quarter, causal trend regime, and
   volatility quintile, excluding the +/-48-bar entry neighborhood; and
2. the same entry delayed exactly one bar, when a next bar exists.

Every control uses the same side and fixed horizon as its source signal. The
seed is derived from the stable diagnosis ID, source commit, and frozen data hash
and is itself stored in the preregistration. Unmatched entries remain visible and
reduce the reported matched-coverage denominator.

The same-side, same-regime, same-volatility, same-quarter matched control is the
operative defense against disguised BTC beta and exposure timing. Strategy beta,
time in market, turnover, and PnL are `N/A` because Night 1 has no stateful
accepted-intent/exit replay; none may be inferred from fixed-horizon signals.

### 5.4 Sample and split contract

- The data range is the complete frozen local BTC cache available before outcome
  replay. Inspecting timestamps and hashes is allowed; inspecting entry outcomes
  before preregistration is not.
- The first 80% of time is discovery and the last 20% is validation. Purge 48
  rule-timeframe bars from both sides of the split boundary.
- A setup is `INSUFFICIENT_SAMPLE` for inference with fewer than 30 total signals,
  fewer than 10 validation entries, or less than 80% matched-control coverage.
- The two confirmatory deltas are frozen as (1) prior impulse and (2) causal
  overhead-resistance distance versus matched controls. A repeated late/crowded
  signature requires both expected directions in discovery and validation and
  both validation two-sided 97.5% bootstrap intervals excluding zero
  (Bonferroni family-wise alpha 0.05 across two tests).
- Each signal delta is measured against the median of its twenty controls.
  Confidence intervals use 10,000 deterministic calendar-month block-bootstrap
  resamples within each split so twenty controls and nearby signals are not
  treated as independent observations.
- Adverse-first rate, normalized MAE, normalized MFE, and one-bar-delay outcomes
  are exploratory diagnostics. They are always reported but cannot complete the
  late/crowded diagnosis or select a replacement rule.
- All confidence intervals, failed checks, and per-setup denominators are
  reported. No pooled result can hide an under-sampled setup.

### 5.5 Explicit backlog

New entry methods, threshold filters, macro/tactical variants, H05 hold/cut/DCA/
hedge/reverse counterfactuals, and full-project knowledge archaeology are deferred.
They may be listed in `queue.md` but cannot be implemented or replayed in Night 1.
Any future H05 counterfactual remains labeled `SIMULATED` and cannot alone justify
a positive production verdict.

## 6. Diagnosis Cycle

The single cycle follows this order:

1. **Metadata inventory:** a separate outcome-blind executable identifies faithful
   evaluator paths, file size, row count, first/last timestamp, SHA-256, and exact
   test commands. It cannot import signal/evaluator modules and a static test
   rejects access to OHLCV/funding values or outcome/result fields; only schema,
   count, timestamps, filesystem metadata, and hashes are allowed.
2. **Pre-registration:** write canonical JSON containing the frozen question,
   evaluator identities, data/split algorithm, costs, controls, sample floors,
   metrics, bootstrap method, and mechanical interpretation checks.
3. **Freeze:** commit preregistration, write its SHA-256, and append the registry
   key before any replay result exists.
4. **Test first:** add failing tests for closed-bar causality, next-bar entry,
   production-function identity, causal input fixtures, split purge,
   deterministic controls, and hash refusal.
5. **Implement:** add the smallest dashboard-only diagnosis runner.
6. **Replay:** run once against the frozen cache and preregistration. There is no
   parameter sweep or nearby-parameter perturbation.
7. **Record:** save raw per-signal rows, aggregate JSON, provenance, commands, and
   `RESULT_RECORDED`; do not attach positive language yet.
8. **Claude audit:** review implementation, causal input construction, indexing,
   function identity, and accounting.
9. **Grok audit:** attack leakage, controls, concentration, interpretation, and
   whether “late entry” is actually exposure or beta; return exactly one defined
   machine-readable terminal.
10. **Verdict:** only after both audits, record `DIAGNOSIS_COMPLETE`,
    `INSUFFICIENT_SAMPLE`, or `INVALID`. Any unavailable or failed mandatory audit
    leaves the status `AUDIT_PENDING`.
11. **Stop scientific search:** do not retune, add a filter, or reinterpret checks
    on the same sample. Record a future preregistered experiment in the backlog.

## 7. Evidence Standards

The diagnosis requires:

- hash-locked production-function identity plus hand-fixture-verified causal input
  construction, labeled `FUNCTION_FAITHFUL_INPUTS_NOT_LIVE_VERIFIED`;
- closed-bar causality and next-bar measurement tests;
- source commit, dirty flag, evaluator identity/hash, local data range/hash,
  preregistration hash, deterministic seed, and exact command set;
- per-setup and per-split signal counts, matched coverage, monthly/yearly coverage,
  MFE/MAE, impulse, resistance distance, and first-move direction;
- signal cohort versus same-side/regime/volatility/quarter matched controls and
  one-bar-delay controls on identical horizons, data, and cost assumptions;
- explicit `N/A` for strategy beta, percent time in market, gross notional,
  turnover, PnL, and win rate because no stateful intent/exit replay exists;
- concentration checks after removing the top 10% fixed-horizon favorable
  outcomes and after removing the best calendar month;
- discovery and untouched validation results with the frozen 48-bar purge;
- online/offline equality when refreshed data are used, otherwise `N/A` with the
  reason that only one frozen local cache was used;
- every raw row needed to reproduce aggregates without contacting a live service.

`DIAGNOSIS_COMPLETE` means only that the causal entry-quality question has enough
audited evidence to answer. It requires all mechanical checks, Claude with no
unresolved P0-P2, and Grok terminal `ALLOW_DIAGNOSIS`. `KILL_DIAGNOSIS` records
`INVALID` or `INSUFFICIENT_SAMPLE` according to the cited mechanism;
`AUDIT_FAILED` remains `AUDIT_PENDING`. None means `ACCEPTED`, profitable,
deployable, or eligible for live arming.

## 8. Continuous Execution Policy

The active window starts only after both design audits pass and ends exactly at
`2026-07-12T07:00:00+07:00` (`deadline_unix=1783814400`).

- Each external audit call has a 20-minute timeout and one compact retry.
- Each test or replay child has a 45-minute timeout.
- No new source-writing or replay phase starts at or after `06:30` ICT.
- At `06:30`, the supervisor enters closeout: finish an owned process group only
  when its timeout is before the hard stop, otherwise terminate the full group
  and record `CUTOFF`.
- At the hard stop, terminate and verify only process groups and recursively
  tracked descendant identities recorded under the current run ID, atomically
  write the final run state and partial-or-complete morning report, and start no
  new work.
- If Claude or Grok is unavailable, freeze the result at `AUDIT_PENDING`; do not
  switch to another scientific lane or generate another candidate.
- While a replay runs, only non-conflicting review of frozen inputs or report
  scaffolding is allowed.

"Continuous" means keeping this one bounded cycle moving and preserving evidence.
It does not mean generating parameter combinations or filling time with new rule
families.

## 9. Design and Runtime Activation Gates

Before implementation:

1. Claude receives the final design and attacks scope, safety, anti-overfit
   controls, and feasibility.
2. Grok re-audits the revised design against its blocking findings.
3. A quota, timeout, command failure, or missing verdict is recorded as an audit
   failure, never an approval.
4. Every valid P0-P2 is resolved in the design and the affected auditor reruns.
5. Implementation may begin only after explicit Claude approval with no unresolved
   P0-P2 and no unresolved blocking Grok finding.

The first Claude quota failure and Grok `NOT APPROVED` verdict remain in the
audit log; later success does not erase them.

Before preregistration or any outcome replay, a second runtime gate requires:

1. the frozen command/path matrix and hash;
2. a committed pure-import report that resolves every literal transitive edge,
   rejects computed/dynamic edges, verifies all module hashes, and shows the
   isolated no-side-effect import passed;
3. green guard tests for environment allowlisting, command/path denial,
   all-child filesystem sandboxing, server-clean/hash assertions, source-clean
   filtering, process-group plus recursive-PPID descendant termination including
   `setsid`, and report status routing;
4. a dry run that creates transient state and evidence scaffolding without
   importing outcome data or replaying signals; and
5. enough wall-clock remains to finish the next phase before its timeout and the
   hard stop.

An affected impure/unloadable signal graph is `INVALID` at this gate. It is not
approximated or discovered only after a replay starts.

## 10. Failure Handling

- A dirty or wrong worktree blocks all writes and replay, not only evidence output.
- A missing/mismatched preregistration hash or duplicate registry key refuses the
  replay and records `INVALID`.
- A local cache change, public-data extension, or any other replay byte whose
  SHA-256 differs from preregistration records `INVALID`; data cannot be extended
  after freeze.
- A failed causal-input fixture or production-function identity test blocks commit
  and replay.
- A production-function/input-contract mismatch invalidates the affected setup; it
  is not patched by approximating server behavior.
- A forbidden command/path attempt, credential-loading attempt, unexpected server
  behavior, or possible exchange mutation stops the entire run immediately.
- Claude/Grok failure freezes the result at `AUDIT_PENDING` after one compact
  retry; it cannot become a positive status or be retuned.
- The report renderer has a status-routing unit test: for `AUDIT_PENDING`,
  `INSUFFICIENT_SAMPLE`, `INVALID`, `CUTOFF`, or `BLOCKED`, metrics cannot appear
  under `Audited diagnosis`, positive, promotion, or recommendation sections.
- Renderer section IDs are frozen as `audited_diagnosis`, `audit_pending`,
  `insufficient_sample`, `invalid`, `cutoff_blocked`, and `backlog`; tests assert
  both ID and visible heading so renaming cannot bypass status routing.
- The supervisor never kills, resets, edits, or cleans unrelated user processes,
  branches, worktrees, or files.

## 11. Morning Deliverables

By the hard stop, produce:

1. `morning-report.md` with a plain-language diagnosis or exact blocker.
2. A per-setup table for H01 S12/S13/S14 with sample sufficiency, control
   coverage, discovery/validation deltas, and audit status.
3. Raw per-signal evidence, aggregate JSON, preregistration/hash, source/data hashes,
   commands, test results, and concentration checks.
4. Separate `Audited diagnosis` and `Unaudited/AUDIT_PENDING` sections; unaudited
   metrics never appear under a positive or promotion heading.
5. The next falsifiable experiment as backlog only, without implementation or
   tuning on Night 1.
6. Explicit confirmation that no server source, live setting, secret, VPS,
   authenticated exchange client, order, position, deploy, or arming was touched.

## 12. Acceptance Criteria for the Process

The overnight process is acceptable only if:

- Claude explicitly approves the final design and revised Grok blockers are closed;
- lock contention, stale-lock recovery, exact worktree assertion, command/path
  refusal, computed-import refusal, all-child filesystem sandboxing,
  server-clean/hash assertions, process-group plus recursive-PPID termination of
  normal and `setsid` descendants, child timeout, and hard-cutoff behavior have
  automated tests;
- a dry run creates atomic state, preregistration, registry, and packets without
  replaying outcomes or modifying `btc-trader-server`;
- the evaluator refuses a missing/mismatched preregistration hash and duplicate
  mechanism/sample registry key;
- the evaluator accepts only `entry-quality-diagnosis` for the frozen data hash,
  has no override path, and refuses any post-freeze data-byte change;
- the supervisor refuses a second preregistration or registry append in the run,
  even when its proposed data hash differs;
- touched dashboard modules pass the exact frozen strict/test command set;
- hash-locked H01 function identity and hand-fixture causal input/next-bar behavior
  pass for every audited setup, or that setup is marked `INVALID`;
- every diagnosis has structured ledger events and raw reproducible evidence;
- a unit test proves the report separates audited, under-sampled, invalid,
  cutoff/blocked, and audit-pending results without leaking their metrics into a
  positive section;
- no server write, deploy, arm, secret access, authenticated API/VPS access, or
  exchange mutation occurs.
