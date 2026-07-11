# H01 Entry Diagnosis Run 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-closed, dashboard-only runner and execute one preregistered BTC H01 S12/S13/S14 market-signal entry-quality diagnosis.

**Architecture:** A small Node ESM tool imports only six hash-locked pure server exports, delegates live-depth gate slicing and ATR to `p1aPipeline`, and separates runtime guards, causal replay, statistics, and status-safe reporting. The runtime safety gate is committed before preregistration; the replay runs once in an isolated worktree and can terminate only as `DIAGNOSIS_COMPLETE`, `INSUFFICIENT_SAMPLE`, `INVALID`, `AUDIT_PENDING`, `CUTOFF`, or `BLOCKED`.

**Tech Stack:** Node.js 20 ESM, `node:test`, macOS `sandbox-exec`, Git worktrees, existing compiled server ESM modules, local BTC 1h/funding JSON caches.

## Global Constraints

- Run 2 has no wall-clock deadline. Individual local children retain 45-minute
  timeouts; external audits retain 20-minute timeouts and one compact retry.
- Source writes are limited to `tools/overnight-entry-audit/**` and `docs/research/run-2-2026-07-12/**` in the dedicated dashboard worktree.
- `btc-trader-server` is read-only and must remain Git-clean with five module hashes unchanged.
- No deploy, PM2, rsync, SSH, secrets, authenticated API, account snapshot, order, position, live arming, or relay TURN change.
- H01 LONG `MARKET_SIGNAL` only; no fill, accepted-intent, PnL, ROI, win-rate, or live-byte-parity claim.
- Runtime safety gate and tests commit before preregistration. One preregistration, one registry append, one replay.
- Missing Codex self-audit or Grok result audit leaves `AUDIT_PENDING`; no positive status or prose.

## File Structure

- `tools/overnight-entry-audit/config.mjs`: immutable Run-2 paths, hashes, timestamps, statuses, export allowlist.
- `tools/overnight-entry-audit/runtime.mjs`: lock, worktree/source guards, sandboxed child ownership, cutoff cleanup, atomic writes.
- `tools/overnight-entry-audit/oracle.mjs`: hash verification and six-export allowlist adapter.
- `tools/overnight-entry-audit/input.mjs`: cache validation, UTC resampling, 500-bar oracle slices, regime/funding construction.
- `tools/overnight-entry-audit/metrics.mjs`: frozen features, dual controls, block bootstrap, sufficiency/verdict math.
- `tools/overnight-entry-audit/report.mjs`: fixed status routing and prose templates.
- `tools/overnight-entry-audit/inventory.mjs`: outcome-blind metadata/hash inventory.
- `tools/overnight-entry-audit/supervisor.mjs`: dry-run, safety-gate, replay, audit-artifact, closeout orchestration.
- `tools/overnight-entry-audit/*.test.mjs`: focused Node tests beside each module.
- `docs/research/run-2-2026-07-12/command-path-matrix.json`: frozen executable/path/sandbox policy.
- `docs/research/run-2-2026-07-12/prereg/entry-quality-diagnosis.json`: canonical frozen protocol.
- `docs/research/run-2-2026-07-12/registry.jsonl`: sole mechanism/data freeze record.
- `docs/research/run-2-2026-07-12/{run.json,ledger.jsonl,morning-report.md}` and `artifacts/*`: generated evidence.

---

### Task 1: Isolated Worktree and Immutable Run Configuration

**Files:**
- Create: `tools/overnight-entry-audit/config.mjs`
- Test: `tools/overnight-entry-audit/config.test.mjs`
- Create: `docs/research/run-2-2026-07-12/queue.md`
- Create: `docs/research/run-2-2026-07-12/knowledge-map.md`

**Interfaces:**
- Produces: `RUN`, `SERVER_MODULES`, `ALLOWED_EXPORTS`, `GENERATED_OUTPUTS`, `TERMINAL_STATUSES`.

- [ ] **Step 1: Create the dedicated worktree through the worktree skill**

Run from the dashboard repository:

```bash
git worktree add ../.worktrees/run-2-2026-07-12-entry-audit -b research/run-2-2026-07-12-entry-audit master
```

Expected: new clean worktree whose `git rev-parse --show-toplevel` ends with `run-2-2026-07-12-entry-audit`.

- [ ] **Step 2: Write the failing configuration test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { RUN, ALLOWED_EXPORTS, GENERATED_OUTPUTS } from "./config.mjs";

test("Run 2 bounds and output literals are frozen", () => {
  assert.equal(RUN.deadlineUnix, null);
  assert.equal(RUN.closeoutIso, null);
  assert.equal(GENERATED_OUTPUTS.length, 8);
  assert.deepEqual(ALLOWED_EXPORTS, [
    "gateSlice4h", "gateSlice1h", "atrEntry4h",
    "evalHedge01TrendSnapshot", "detectRegime", "stepRegimePersist",
  ]);
});
```

- [ ] **Step 3: Verify the test fails**

Run: `node --test tools/overnight-entry-audit/config.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `config.mjs`.

- [ ] **Step 4: Implement the immutable configuration**

```js
export const RUN = Object.freeze({
  id: "h01-entry-diagnosis-run-2-2026-07-12",
  worktreeSuffix: "run-2-2026-07-12-entry-audit",
  rootRel: "docs/research/run-2-2026-07-12",
  activationIso: null,
  closeoutIso: null,
  deadlineIso: null,
  deadlineUnix: null,
  mechanismId: "entry-quality-diagnosis",
});
export const ALLOWED_EXPORTS = Object.freeze([
  "gateSlice4h", "gateSlice1h", "atrEntry4h",
  "evalHedge01TrendSnapshot", "detectRegime", "stepRegimePersist",
]);
export const SERVER_MODULES = Object.freeze({
  "dist/engine/p1aPipeline.js": "3ef7b25354fc2a97aa15cfc0a36b96e09e405bb40c56aed1d0042008340b8ce8",
  "dist/engine/rules/hedge01.js": "2956e5c85f25175c09fcc66f364b267c7066dfd72670ec64efb0e10f11bece4e",
  "dist/engine/rules/ruleHelpers.js": "2a83526f25cd5e58523d4ead9b67cd6d85805569094a2877f9863c2b48310737",
  "dist/engine/regime.js": "31a5a98a15e82cd1313e88dbef7ff273617eec4745b6fefaeffd40b68ed64dba",
  "dist/engine/hwm.js": "b9ad89c30014a0d384e2fc29a31d9d5292cdda2fe7c67141fbb8e42fd816791b",
});
export const GENERATED_OUTPUTS = Object.freeze([
  "run.json", "ledger.jsonl", "artifacts/entry-quality-signals.jsonl",
  "artifacts/entry-quality-aggregate.json", "artifacts/entry-quality-provenance.json",
  "artifacts/codex-result-audit.md", "artifacts/grok-result-audit.txt",
  "morning-report.md",
]);
export const TERMINAL_STATUSES = Object.freeze([
  "DIAGNOSIS_COMPLETE", "INSUFFICIENT_SAMPLE", "INVALID",
  "AUDIT_PENDING", "CUTOFF", "BLOCKED",
]);
```

- [ ] **Step 5: Run the test and commit**

Run: `node --test tools/overnight-entry-audit/config.test.mjs`

Expected: 1/1 PASS.

Commit: `test: freeze H01 run 2 configuration`

---

### Task 2: Runtime Safety Gate

**Files:**
- Create: `tools/overnight-entry-audit/runtime.mjs`
- Test: `tools/overnight-entry-audit/runtime.test.mjs`
- Create: `docs/research/run-2-2026-07-12/command-path-matrix.json`

**Interfaces:**
- Produces: `acquireLock()`, `assertResearchWorktree()`, `assertSourceClean()`, `verifyServerIdentity()`, `atomicWriteJson()`, `appendLedger()`, `runOwnedProcess()`.

- [ ] **Step 1: Write failing tests for lock, path filtering, atomic state, and descendant cleanup**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, atomicWriteJson, filterDirtyPaths, runOwnedProcess } from "./runtime.mjs";

test("second live lock is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "h01-lock-"));
  const a = await acquireLock(root, "run-a", Date.now() + 60_000);
  await assert.rejects(() => acquireLock(root, "run-b", Date.now() + 60_000), /LIVE_LOCK/);
  await a.release(); await rm(root, { recursive: true, force: true });
});

test("only eight generated literals may be dirty", () => {
  assert.deepEqual(filterDirtyPaths(["docs/research/run-2-2026-07-12/run.json"]), []);
  assert.throws(() => filterDirtyPaths(["tools/overnight-entry-audit/input.mjs"]), /DIRTY_SOURCE/);
});

test("atomic JSON never leaves a temp file", async () => {
  const root = await mkdtemp(join(tmpdir(), "h01-json-"));
  await atomicWriteJson(join(root, "run.json"), { status: "PLANNED" });
  assert.equal(JSON.parse(await readFile(join(root, "run.json"), "utf8")).status, "PLANNED");
  await rm(root, { recursive: true, force: true });
});

test("timeout kills a setsid descendant but not an unrelated process", async () => {
  const result = await runOwnedProcess({ fixture: "setsid-grandchild", timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.ownedAlive.length, 0);
  assert.equal(result.controlAlive, true);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `node --test tools/overnight-entry-audit/runtime.test.mjs`

Expected: FAIL because `runtime.mjs` does not exist.

- [ ] **Step 3: Implement fail-closed runtime primitives**

Implement these exact rules:

```js
export async function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  await rename(tmp, path);
}

export function filterDirtyPaths(paths) {
  const allowed = new Set(GENERATED_OUTPUTS.map(x => `${RUN.rootRel}/${x}`));
  const bad = paths.filter(x => !allowed.has(x));
  if (bad.length) throw new Error(`DIRTY_SOURCE:${bad.join(",")}`);
  return [];
}
```

`acquireLock` must use atomic `mkdir`, store hostname/PID/`ps lstart`/resolved executable/run ID and `deadline:null`, refuse unverifiable locks, and release only its own run ID. `runOwnedProcess` must launch `/usr/bin/sandbox-exec` detached, sample PPID descendants every 100 ms, SIGTERM then SIGKILL owned identities, and reject PID/PGID `<=1`. The test fixture is selected only when `NODE_ENV=test`; production arguments cannot contain `setsid`, `nohup`, `&`, or shell evaluation.

- [ ] **Step 4: Freeze the command/path matrix**

Write JSON with `defaultDeny=true`, the six export names, five server read paths/hashes, exact Node/Git/sha/sandbox/Grok executable paths, Run-2 write roots, unauthenticated cache endpoint, and explicit denies for SSH/rsync/PM2/deploy/env/auth/account/exchange/relay. Include separate `local_no_network`, `public_cache_fill`, and `auditor_network` sandbox profiles.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tools/overnight-entry-audit/runtime.test.mjs`

Expected: all tests PASS, including setsid descendant cleanup.

Commit: `feat: add fail-closed H01 research runtime`

---

### Task 3: Hash-Locked Oracle and Causal Inputs

**Files:**
- Create: `tools/overnight-entry-audit/oracle.mjs`
- Create: `tools/overnight-entry-audit/input.mjs`
- Test: `tools/overnight-entry-audit/oracle.test.mjs`
- Test: `tools/overnight-entry-audit/input.test.mjs`

**Interfaces:**
- Produces: `loadOracle()`, `resampleUtc()`, `buildSignalContexts()`, `fundingAsOf()`.

- [ ] **Step 1: Write failing oracle and input tests**

```js
test("oracle exposes exactly six wrappers", async () => {
  const o = await loadOracle();
  assert.deepEqual(Object.keys(o).sort(), [...ALLOWED_EXPORTS].sort());
});

test("forming-bar mutation cannot alter H01 snapshot", async () => {
  const a = makeFixture({ formingClose: 1 });
  const b = makeFixture({ formingClose: 999999 });
  assert.deepEqual(await evaluateFixture(a), await evaluateFixture(b));
});

test("gate slice is byte-equal to p1a 500-window oracle", async () => {
  const bars = sequenceBars(700);
  assert.deepEqual(buildGate4h(bars, 600), oracle.gateSlice4h(bars, 600, 500));
  assert.equal(buildGate4h(bars, 600).length, 500);
});

test("funding join is causal and rejects age over 12h", () => {
  assert.equal(fundingAsOf([{ time: 0, rate: 0.1 }], 11 * 3_600_000).rate, 0.1);
  assert.throws(() => fundingAsOf([{ time: 0, rate: 0.1 }], 13 * 3_600_000), /STALE_FUNDING/);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `node --test tools/overnight-entry-audit/oracle.test.mjs tools/overnight-entry-audit/input.test.mjs`

Expected: module-not-found failures.

- [ ] **Step 3: Implement the deny-by-default oracle adapter**

`loadOracle` must hash all five files, statically resolve literal imports, reject dynamic imports/env reads except `RULE_DISABLE_S12`, import with env `TZ=UTC LANG=C LC_ALL=C RULE_DISABLE_S12=false`, and return frozen wrappers for only:

```js
return Object.freeze({
  gateSlice4h: p1a.gateSlice4h,
  gateSlice1h: p1a.gateSlice1h,
  atrEntry4h: p1a.atrEntry4h,
  evalHedge01TrendSnapshot: h01.evalHedge01TrendSnapshot,
  detectRegime: regime.detectRegime,
  stepRegimePersist: regime.stepRegimePersist,
});
```

- [ ] **Step 4: Implement causal input construction**

Use UTC epoch buckets. At closed 4h index `i`, call the oracle slices with `window=500`; skip missing forming indices. Daily state starts `{regime:"RANGE", consecutive:0, lastRaw:"RANGE", lastBarTime:0}` and steps once per new closed day with `persistBars=1`. Every ATR is `oracle.atrEntry4h(oracle.gateSlice4h(b4h,k,500))`; no local ATR function exists.

- [ ] **Step 5: Run existing and new parity tests, then commit**

Run:

```bash
node --test /Users/lap16116/BTC_PC/btc-trader-server/test/p1a-pipeline.test.mjs
node --test tools/overnight-entry-audit/oracle.test.mjs tools/overnight-entry-audit/input.test.mjs
```

Expected: server 9/9 PASS and all dashboard tests PASS.

Commit: `feat: add faithful H01 causal input adapter`

---

### Task 4: Frozen Metrics, Dual Controls, and Corrected Inference

**Files:**
- Create: `tools/overnight-entry-audit/metrics.mjs`
- Test: `tools/overnight-entry-audit/metrics.test.mjs`

**Interfaces:**
- Produces: `impulseMetric()`, `resistanceMetric()`, `volatilityBin()`, `matchControls()`, `blockBootstrapCi()`, `classifySetup()`.

- [ ] **Step 1: Write failing metric tests**

```js
test("impulse uses six prior lows and oracle ATR", () => {
  assert.equal(impulseMetric({ close: 110, priorLows: [100,101,102,103,104,105], atr: 5 }), 2);
});

test("resistance uses nearest confirmed strict overhead pivot", () => {
  const highs = [105,108,120,108,106,110,112];
  assert.equal(resistanceMetric({ close: 110, atr: 5, highs, index: 7 }), 2);
});

test("volatility bins have fixed boundaries", () => {
  assert.deepEqual([0,.2,.4,.6,.8,1].map(volatilityBin), [0,1,2,3,4,4]);
});

test("gate-conditioned controls require another setup PASS", () => {
  const pool = fixtureCandidates();
  const out = matchControls(pool, { target: "S13", arm: "gate" }, "seed");
  assert.ok(out.every(x => !x.pass.S13 && (x.pass.S12 || x.pass.S14)));
});

test("classification requires all 12 corrected tests", () => {
  assert.equal(classifySetup(makePassingTwelveTestMetrics()), "DIAGNOSIS_COMPLETE");
  assert.equal(classifySetup(makePassingTwelveTestMetrics({ oneCiTouchesZero: true })), "INSUFFICIENT_SAMPLE");
});
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test tools/overnight-entry-audit/metrics.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement exact frozen formulas and controls**

Impulse is `(close[i]-min(low[i-6..i-1]))/atr[i]`. Resistance is the smallest confirmed 2-left/2-right pivot high strictly above close in `i-90..i-1`, normalized by the same oracle ATR. Raw controls require target not PASS; gate controls additionally require another setup PASS. Select 20 distinct controls via seeded Fisher-Yates; resistance needs 16 non-missing controls. Volatility rank is `count(priorATR < currentATR)/90` with fixed bins.

- [ ] **Step 4: Implement deterministic month-block bootstrap**

Use 10,000 resamples with the preregistered seed. The estimand is mean per-signal delta. Return two-sided 99.5833% bounds for each of 12 setup/metric/arm tests. Both signs must hold in discovery and validation for both arms; no pooling or OR selection.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tools/overnight-entry-audit/metrics.test.mjs`

Expected: all tests PASS.

Commit: `feat: add preregistered H01 entry diagnostics`

---

### Task 5: Status-Safe Reporter

**Files:**
- Create: `tools/overnight-entry-audit/report.mjs`
- Test: `tools/overnight-entry-audit/report.test.mjs`

**Interfaces:**
- Produces: `renderReport(result)` and fixed section/status templates.

- [ ] **Step 1: Write the routing tests**

```js
for (const status of ["AUDIT_PENDING","INSUFFICIENT_SAMPLE","INVALID","CUTOFF","BLOCKED"]) {
  test(`${status} cannot leak into audited diagnosis`, () => {
    const report = renderReport({ status, metrics: { impulse: 999 }, blocker: "fixture" });
    assert.doesNotMatch(report, /id="audited_diagnosis"[\s\S]*999/);
    assert.match(report, new RegExp(`id="${statusSection(status)}"`));
  });
}
```

- [ ] **Step 2: Verify tests fail**

Run: `node --test tools/overnight-entry-audit/report.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement fixed IDs and prose templates**

Only `DIAGNOSIS_COMPLETE` may render under `audited_diagnosis` and say signature `present` or `absent`. All other statuses render a blocker-only template under `audit_pending`, `insufficient_sample`, `invalid`, `cutoff_blocked`, or `backlog`; no free-form positive prose.

- [ ] **Step 4: Run tests and commit**

Run: `node --test tools/overnight-entry-audit/report.test.mjs`

Expected: all routing snapshots PASS.

Commit: `feat: add fail-closed H01 report routing`

---

### Task 6: Supervisor and Dry Runtime Gate

**Files:**
- Create: `tools/overnight-entry-audit/supervisor.mjs`
- Test: `tools/overnight-entry-audit/supervisor.test.mjs`
- Create: `docs/research/run-2-2026-07-12/pure-import-runtime-report.json`
- Create: `docs/research/run-2-2026-07-12/packets/codex-self-audit-checklist.md`
- Create: `docs/research/run-2-2026-07-12/packets/grok-result-audit.md`

**Interfaces:**
- Consumes: runtime, oracle, input, metrics, report modules.
- Produces: `node supervisor.mjs dry-run|replay|closeout`.

- [ ] **Step 1: Write dry-run state-machine tests**

```js
test("dry-run never imports outcome data", async () => {
  const calls = [];
  const r = await runSupervisor("dry-run", { onPhase: x => calls.push(x) });
  assert.deepEqual(calls, ["LOCK","WORKTREE","SERVER_ID","MATRIX","PURE_IMPORT","GUARD_TESTS","SCAFFOLD"]);
  assert.equal(r.status, "PLANNED");
});

test("replay refuses before frozen prereg", async () => {
  await assert.rejects(() => runSupervisor("replay"), /PREREG_REQUIRED/);
});
```

- [ ] **Step 2: Implement phase orchestration**

`dry-run` acquires the lock, checks owner-stop/worktree/server/matrix state, executes guard tests, writes only scaffolding, then releases. `replay` additionally verifies prereg/matrix/report/data hashes, refuses a second registry key/result, runs one replay, atomically writes the three data artifacts, and sets `RESULT_RECORDED`. `closeout` terminates owned processes and writes the status-routed report.

- [ ] **Step 3: Run the complete safety suite**

Run:

```bash
node --test tools/overnight-entry-audit/*.test.mjs
node tools/overnight-entry-audit/supervisor.mjs dry-run
```

Expected: all tests PASS; dry-run emits no signal/artifact result and no server diff.

- [ ] **Step 4: Verify server and repository invariants**

Run:

```bash
git -C /Users/lap16116/BTC_PC/btc-trader-server status --short
git status --short
```

Expected: server empty; dashboard changes only planned source/evidence files.

- [ ] **Step 5: Commit the complete runtime safety gate**

Commit: `feat: complete H01 research safety gate`

No preregistration or replay is allowed before this commit.

---

### Task 7: Outcome-Blind Inventory and One-Time Preregistration

**Files:**
- Create: `tools/overnight-entry-audit/inventory.mjs`
- Test: `tools/overnight-entry-audit/inventory.test.mjs`
- Create: `docs/research/run-2-2026-07-12/prereg/entry-quality-diagnosis.json`
- Create: `docs/research/run-2-2026-07-12/prereg/entry-quality-diagnosis.sha256`
- Create: `docs/research/run-2-2026-07-12/registry.jsonl`

**Interfaces:**
- Produces frozen data hashes/ranges and the only registry key.

- [ ] **Step 1: Test inventory source cannot access outcome fields or signal modules**

Read the source as text and assert it contains no `.open`, `.high`, `.low`, `.close`, `.volume`, `.rate`, `evalHedge`, `metrics`, or `result` token; allow only file stat/hash, array count, key names, and first/last `time`.

- [ ] **Step 2: Run inventory against local caches**

Run:

```bash
node tools/overnight-entry-audit/inventory.mjs \
  .cache/binance-1h-7y.json \
  .cache/binance-futures-btcusdt-funding-7y.json
```

Expected: deterministic JSON with file sizes, row counts, first/last timestamps, and SHA-256 only.

- [ ] **Step 3: Write canonical preregistration**

Include the exact formulas, two arms, 12 corrected tests, split/purge, sample floors, seed derivation, server/source/data/matrix/pure-report hashes, six exports, 500-depth oracle, costs/N/A claims, and terminal rules from the design. Canonicalize by recursively sorting object keys and writing one trailing newline before SHA-256.

- [ ] **Step 4: Append the only registry record and test duplicate refusal**

Registry key is `entry-quality-diagnosis:<data_range_hash>`. A second append in the run must exit non-zero `DUPLICATE_REGISTRY_KEY`.

- [ ] **Step 5: Commit the freeze**

Commit: `test: preregister H01 entry diagnosis run 2`

After this commit, only the eight generated output literals may change.

---

### Task 8: Single Replay, Dual Audit, and Closeout

**Files:**
- Generate only the eight Run-2 output literals.

**Interfaces:**
- Produces the final status and reproducible artifacts; no source changes.

- [ ] **Step 1: Run the replay once**

Run: `node tools/overnight-entry-audit/supervisor.mjs replay`

Expected: `RESULT_RECORDED`, or an honest `INSUFFICIENT_SAMPLE`/`INVALID`/`CUTOFF`; no second replay command.

- [ ] **Step 2: Reproduce aggregates from raw rows**

Run: `node tools/overnight-entry-audit/supervisor.mjs verify-artifacts`

Expected: byte-identical aggregate hash and all prereg checks unchanged.

- [ ] **Step 3: Run bounded Codex code/result self-audit**

Review findings first against the frozen design, source diff, tests, raw/aggregate
reproduction, causal indexing, input fidelity, and interpretation. Save the review
artifact with an explicit `APPROVED` or `NOT_APPROVED`; any unresolved P0-P2
leaves `AUDIT_PENDING`.

- [ ] **Step 4: Run Grok adversarial result audit**

The packet must attack raw-arm gate-selection confounding and gate-conditioned isolation, leakage, corrected inference, concentration, and interpretation. Require the final JSON terminal/reason code; otherwise `AUDIT_FAILED/MALFORMED`.

- [ ] **Step 5: Render and verify the final report**

Run:

```bash
node tools/overnight-entry-audit/supervisor.mjs closeout
node --test tools/overnight-entry-audit/report.test.mjs
git -C /Users/lap16116/BTC_PC/btc-trader-server status --short
```

Expected: fixed status section, clean server, no live-action claim, exact source/data/prereg/audit hashes.

- [ ] **Step 6: Commit evidence and stop**

Commit: `test: publish H01 entry diagnosis run 2 evidence`

Do not merge, deploy, arm, push, retune, or begin another hypothesis.

## Self-Review

- Spec coverage: safety boundary, H01-only scope, 500-depth p1a oracle, six exports, dual controls, corrected inference, audit status, and Run-2 cutoff each map to a task.
- Placeholder scan completed; every implementation step names concrete behavior.
- Type consistency: module/export names and status literals match across all tasks.
- Execution mode: inline execution is already selected by the owner's instruction; no additional choice prompt is needed.
