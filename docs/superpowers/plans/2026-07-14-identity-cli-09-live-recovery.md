# Identity Live Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement recoverable live and golden-capture execution with a canonical durable run ledger, exact ownership proof, bounded audit, safe dry-run/mutating reap, read-only inspection, and terminal cleanup evidence.

**Architecture:** One protected run root and permanent lock own one append-only-by-transition canonical ledger. Create/Delete uncertainty is durably recorded at the request-handler boundary; deletion becomes terminal only after an exact correlated receipt, complete absence polling, a post-mutation zero-finding audit, and one audited terminalization CAS.

**Tech Stack:** TypeScript, strict canonical JSON, plan 03 native protected-root/lock/atomic-replace APIs, AWS SDK AgentCore/STS/Secrets Manager v3.1079.0, deterministic clocks, Bun test and explicit deploy-account integration tests.

---

## File Structure

```text
src/testing/identity-live/
|-- types.ts
|-- ledger.ts
|-- audit.ts
|-- cleanup.ts
|-- runner.ts
|-- inspect.ts
`-- commands.ts

test/subprocess/
|-- identity-live-killpoints.test.ts
`-- identity-live-commands.test.ts
```

No module scans or deletes by the shared `acci-` prefix. Every mutation candidate originates in one
valid ledger row and passes the complete row/name/ARN/scope/tag/time conjunction.

## Task 1: Implement Canonical Run Ledger Parsing, Encoding, And Transitions

**Files:**

- Modify: `src/testing/identity-live/types.ts`
- Create: `src/testing/identity-live/ledger.ts`
- Create: `src/testing/identity-live/ledger.test.ts`
- Create: `test/compile/identity-run-ledger.ts`

- [ ] **Step 1: Write parser boundary and canonicality tests**

Reject empty, BOM, invalid UTF-8, 1,048,577 bytes, depth 9, node 16,385, duplicate/unknown/missing
keys, comments, trailing bytes, noncanonical numbers, malformed unions, unsorted/duplicate rows,
empty/duplicate/out-of-order families, invalid IDs/names/ARNs/proofs, timestamp-order violations,
scope/purpose mismatches, and incorrect weighted generation.

Accept exact boundaries: 1,048,576 bytes, depth 8, node 16,384, 256 all-`deleted` rows, safe integer
timestamps, and canonical byte-identical re-encoding.

- [ ] **Step 2: Write every transition test**

Legal edges are exactly:

```text
absent -> initialized empty ledger
ledger -> ledger plus one planned row
planned -> createOutcomeUnknown
planned -> createNotSent
createOutcomeUnknown -> createNotSent
createOutcomeUnknown -> observed
observed -> deleteOutcomeUnknown
deleteOutcomeUnknown -> deleteAccepted
one or more deleteAccepted -> deleted in one audited batch
```

Every other edge, mutation of immutable row/scope facts, row removal, transition shortcut, or
generation error fails.

- [ ] **Step 3: Verify the tests fail**

```bash
bun test src/testing/identity-live/ledger.test.ts
bun run verify:tsc
```

- [ ] **Step 4: Implement exact constants and types**

```ts
export const RUN_LEDGER_BASENAME = ".run-ledger-v1.json" as const;
export const RUN_LOCK_BASENAME = ".run.lock" as const;
export const RUN_LEDGER_MAX_BYTES = 1_048_576 as const;
export const RUN_LEDGER_MAX_ROWS = 256 as const;
export const RUN_LEDGER_MAX_DEPTH = 8 as const;
export const RUN_LEDGER_MAX_NODES = 16_384 as const;
export const CREATE_SEND_DEADLINE_MS = 300_000 as const;
export const SERVICE_CLOCK_SKEW_MS = 300_000 as const;

export type RunRowStateV1 =
  | Readonly<{ kind: "planned" }>
  | Readonly<{
      kind: "createOutcomeUnknown";
      createDispatchRecordedAtEpochMs: number;
    }>
  | Readonly<{
      kind: "createNotSent";
      createDispatchRecordedAtEpochMs: number | null;
      createNotSentAtEpochMs: number;
    }>
  | Readonly<{
      kind: "observed";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
    }>
  | Readonly<{
      kind: "deleteOutcomeUnknown";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
      deleteDispatchRecordedAtEpochMs: number;
    }>
  | Readonly<{
      kind: "deleteAccepted";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
      deleteDispatchRecordedAtEpochMs: number;
      deleteAcceptedAtEpochMs: number;
      absenceConfirmedAtEpochMs: number;
    }>
  | Readonly<{
      kind: "deleted";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
      deleteDispatchRecordedAtEpochMs: number;
      deleteAcceptedAtEpochMs: number;
      absenceConfirmedAtEpochMs: number;
      deletionConfirmedAtEpochMs: number;
    }>;
```

Implement the full `RunLedgerV1`, row, observation, purpose, scope, and stale-authority unions from the
design. Generation equals the sum of state weights `1,2,3,3,4,5,6`.

- [ ] **Step 5: Implement the fixed-cap canonical codec**

Parse with strict UTF-8 and duplicate-aware JSON before semantic allocation. Count depth/nodes exactly
as specified. Require parsed bytes to equal canonical re-encoding. Only the codec may mint
`CanonicalRunLedgerBytesV1`.

- [ ] **Step 6: Verify and commit**

```bash
bun test src/testing/identity-live/ledger.test.ts
bun run verify:tsc
git add src/testing/identity-live/types.ts src/testing/identity-live/ledger.ts src/testing/identity-live/ledger.test.ts test/compile/identity-run-ledger.ts
git commit -m "feat(identity): add canonical live run ledger"
```

## Task 2: Compose Protected Run Roots, Permanent Locks, And Atomic Ledger CAS

**Files:**

- Create: `src/testing/identity-live/ledgerNative.test.ts`
- Modify: `src/testing/identity-live/ledger.ts`

- [ ] **Step 1: Write root/lock/proof tests**

Cover:

- exclusive creation of a caller-selected new absolute run root;
- exact protected permissions/ACLs and safe ancestors;
- retained root identity;
- permanent mode-0600 `.run.lock` creation and validation;
- nonblocking process lock and process-death release;
- lock never unlinked/replaced;
- ledger replacement never changes the lock object;
- Linux boot ID, protected-root ID, lock-object ID, and `STATX_MNT_ID_UNIQUE`;
- unsupported unique mount proof;
- macOS/Windows `auditOnly`;
- copied root, symlink/reparse, mount change, boot change, and network filesystem.

- [ ] **Step 2: Write CAS uncertainty tests**

Exercise expected absence/digest, `expectedDigestMismatch`, `alreadyCurrent`, and `commitUnknown`
readback of exact old, exact next, missing, or third bytes. A third/missing state never retries or
guesses.

- [ ] **Step 3: Verify the tests fail**

```bash
bun run build:native:host
bun test src/testing/identity-live/ledgerNative.test.ts
```

- [ ] **Step 4: Implement the run-ledger repository over plan 03 native APIs**

Consume plan 03's protected-root, permanent-lock, mount-proof, and expected-digest atomic-replacement
primitives behind this test-owned interface:

```ts
export interface RunLedgerRepository {
  read(root: NativeProtectedRootHandle): RunLedgerReadOutcome;
  replace(
    root: NativeProtectedRootHandle,
    expected: Readonly<{ kind: "absent" } | { kind: "sha256"; digest: string }>,
    next: CanonicalRunLedgerBytesV1,
  ): RunLedgerReplaceOutcome;
}
```

The repository validates and encodes the next canonical ledger before calling native replacement.
Plan 03 native code creates/protects/verifies the same-directory temporary, writes complete bytes,
syncs, atomically renames, and classifies commit uncertainty. Plan 09 adds no TypeScript or C++
filesystem mutation and has no pathname fallback.

- [ ] **Step 5: Verify and commit**

```bash
bun run build:native:host
bun test src/testing/identity-live/ledgerNative.test.ts src/native/identity
bun run verify:tsc
git add src/testing/identity-live/ledger.ts src/testing/identity-live/ledgerNative.test.ts
git commit -m "feat(identity): compose durable run ledger storage"
```

## Task 3: Enforce Dual Create Deadlines At Exact Handler Dispatch

**Files:**

- Modify: `src/testing/identity-live/runner.ts`
- Create: `src/testing/identity-live/createDispatch.test.ts`
- Modify: `src/core/identity/factory.ts`
- Modify: `src/core/identity/statusRegistry.ts`

- [ ] **Step 1: Write deterministic deadline and kill-point tests**

Test expiry:

- before the first handler-entry check;
- before `planned -> createOutcomeUnknown`;
- while ledger sync is pending;
- after sync and before the second check;
- at exact wall/monotonic equality;
- one millisecond past either clock;
- immediately before underlying handler invocation.

Assert every expired path invokes no handler and commits `createNotSent` only with exact local proof.
Kill between every transition and prove a surviving ledger is exactly old or next canonical bytes.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-live/createDispatch.test.ts
```

- [ ] **Step 3: Implement handler-owned authorization**

Planning records:

```ts
export interface PlannedCreateDeadline {
  readonly plannedAtEpochMs: number;
  readonly wallDeadlineEpochMs: number;
  readonly monotonicDeadlineMs: number;
}
```

At exact request-handler `handle()` entry:

1. read both clocks;
2. if either is past its inclusive deadline, CAS `planned -> createNotSent`;
3. otherwise CAS and durably sync `createOutcomeUnknown`;
4. read both clocks again;
5. if expired, CAS `createOutcomeUnknown -> createNotSent` with local not-invoked proof;
6. in one synchronous block, mark tracker invoked and call the underlying handler.

There is no hook, timer, promise, middleware callback, or caller code between final tracker update and
handler invocation. Serialization/client/cancellation failures before handler entry may use only that
same local tracker to prove not sent.

- [ ] **Step 4: Implement post-Create observation**

Create success does not terminalize or observe a row. A fresh family Get plus List Tags, or Secrets
Manager Describe with tags, must prove exact name, ARN, scope, four tags, service creation time, and
attempt window before CAS to `observed`.

- [ ] **Step 5: Verify and commit**

```bash
bun test src/testing/identity-live/createDispatch.test.ts src/core/identity
bun run verify:tsc
git add src/testing/identity-live/runner.ts src/testing/identity-live/createDispatch.test.ts src/core/identity/factory.ts src/core/identity/statusRegistry.ts
git commit -m "feat(identity): guard live create dispatch deadlines"
```

## Task 4: Implement Ownership Reads, Polling, Delete Acceptance, And Terminalization

**Files:**

- Create: `src/testing/identity-live/cleanup.ts`
- Create: `src/testing/identity-live/cleanup.test.ts`
- Modify: `src/testing/identity-live/types.ts`
- Modify: `src/testing/identity-live/ledger.ts`

- [ ] **Step 1: Write deterministic polling tests**

Use exact constants:

```ts
export const RUN_POLL_OFFSETS_MS = [
  0, 250, 750, 1_750, 3_750, 7_750, 15_750, 31_750, 61_750, 91_750, 121_750,
] as const;
export const RUN_POLL_DEADLINE_MS = 150_000 as const;
export const RUN_READ_ATTEMPT_TIMEOUT_MS = 15_000 as const;
```

Assert nonoverlapping attempts, per-read abort, fixed overall deadline, early verified-present success,
final scheduled NotFound absence, and `indeterminate` after any failed read even if a later read is
NotFound.

- [ ] **Step 2: Write exact Delete-receipt tests**

AgentCore requires 204 with zero-byte normal EOF. Secrets Manager requires 200 normal EOF and modeled
ARN/name equal to the observation. Test alternate status, nonempty/malformed body, abnormal EOF,
mismatched secret result, timeout, restart, OAuth `DELETING`, OAuth `DELETE_FAILED`, and absence without
receipt.

- [ ] **Step 3: Write terminalization tests**

`deleteOutcomeUnknown -> deleteAccepted` requires same-process receipt correlation to action lease,
candidate, operation, target, dispatch, and the complete clean absence poll. `deleteAccepted -> deleted`
requires a final audit after the last mutation, zero findings, clean repeated absence, exact audited
ledger digest, one batch CAS, and an all-terminal reread.

- [ ] **Step 4: Verify the tests fail**

```bash
bun test src/testing/identity-live/cleanup.test.ts
```

- [ ] **Step 5: Implement cleanup primitives**

Before every Delete:

1. reread current resource and ownership;
2. reject mismatch/indeterminate;
3. CAS `observed -> deleteOutcomeUnknown` and sync;
4. dispatch one exact Delete;
5. classify receipt;
6. complete the fixed absence poll;
7. CAS to `deleteAccepted` only with all evidence.

An existing `deleteOutcomeUnknown` may retry guarded Delete. `deleteAccepted` performs no additional
Delete and waits for absence plus final audit. `planned`, `createNotSent`, and `deleted` authorize no
Delete.

- [ ] **Step 6: Verify and commit**

```bash
bun test src/testing/identity-live/cleanup.test.ts src/testing/identity-live/ledger.test.ts
bun run verify:tsc
git add src/testing/identity-live/cleanup.ts src/testing/identity-live/cleanup.test.ts src/testing/identity-live/types.ts src/testing/identity-live/ledger.ts
git commit -m "feat(identity): add evidence-bound live cleanup"
```

## Task 5: Implement The Bounded Cross-Service Audit

**Files:**

- Create: `src/testing/identity-live/audit.ts`
- Create: `src/testing/identity-live/audit.test.ts`
- Modify: `src/testing/identity-live/types.ts`

- [ ] **Step 1: Write the complete audit boundary matrix**

Use:

```ts
export const RUN_AUDIT_DEADLINE_MS = 300_000 as const;
export const RUN_AUDIT_MAX_PAGES = 512 as const;
export const RUN_AUDIT_MAX_ITEMS = 8_192 as const;
export const RUN_AUDIT_MAX_FINDINGS = 256 as const;
```

Test equality/N+1 for each cap, deadline before each page/item/follow-up/token step, family declaration
order, independent per-family token sets, same token across families, family-local cycle, page 512
ending one family with no next-family request, 256/257 findings, partial safe findings, malformed
ownership, unledgered resources, ledgered resources, terminal-row contract violations, and every
service/shape failure.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-live/audit.test.ts
```

- [ ] **Step 3: Implement the exact audit union**

```ts
export type RunAuditReportV1 =
  | Readonly<{ kind: "notRun" }>
  | Readonly<{
      kind: "completed";
      pages: number;
      items: number;
      findings: readonly RunAuditFindingV1[];
    }>
  | Readonly<{
      kind: "overflow";
      reason: "deadline" | "pageLimit" | "itemLimit" | "findingLimit" | "cycle";
      pages: number;
      items: number;
      findings: readonly RunAuditFindingV1[];
    }>
  | Readonly<{
      kind: "indeterminate";
      reason:
        | "credentialRefreshRequired"
        | "paginationFailure"
        | "serviceFailure"
        | "internalFailure";
      pages: number;
      items: number;
      findings: readonly RunAuditFindingV1[];
    }>;
```

Before each page request, check deadline then the global page count. Increment pages only after a valid
List response. Check the item cap before accepting each item and finding cap before retaining a 257th.
Handle token after all page items: empty terminates, repeated is `overflow/cycle`, new token inserts,
then page-limit check. Secrets Manager always sends `IncludePlannedDeletion: true`.

- [ ] **Step 4: Implement snapshot derivation**

Precedence:

```text
not started -> notRun
audit overflow -> auditOverflow
row mismatch/read failure/contradiction/indeterminate audit -> indeterminate
finding or verified owned row -> resourcesPresent
clean eligible-row absence plus completed zero-finding audit -> quiescent
```

No partial report yields `quiescent`. Findings never authorize deletion.

- [ ] **Step 5: Verify and commit**

```bash
bun test src/testing/identity-live/audit.test.ts
bun run verify:tsc
git add src/testing/identity-live/audit.ts src/testing/identity-live/audit.test.ts src/testing/identity-live/types.ts
git commit -m "feat(identity): add bounded cleanup audit"
```

## Task 6: Implement Total Run Results And Read-Only Inspection

**Files:**

- Create: `src/testing/identity-live/inspect.ts`
- Create: `src/testing/identity-live/inspect.test.ts`
- Modify: `src/testing/identity-live/types.ts`
- Create: `src/testing/identity-live/result.test.ts`

- [ ] **Step 1: Write command-phase result matrices**

Instantiate every:

- command/mode combination;
- pre-lock authorization row;
- stop-reason precedence collision;
- metadata nullability boundary;
- legal/illegal row-state, current-state, and send-attempt tuple;
- mid-row stop and unexamined suffix;
- dry-run finding;
- row mismatch versus audit result;
- valid/invalid final ledger.

Assert:

```text
examined    = reports.length
createSends = invoked create attempts
deleteSends = invoked delete attempts
retained    = nonterminal or owned/mismatch/indeterminate reports
unexamined  = final valid row count - examined
```

- [ ] **Step 2: Write inspect mappings**

Inspect opens only the protected root and ledger, not `.run.lock`, AWS, credentials, profile, endpoints,
or mutation. Map native `notFound`/`limitExceeded` and all parser failures to `invalidLedger`; ownership/
ACL/link identity failures to `unsafe`; missing capability to `unsupported`; other closed read/hash
failure to `unavailable`.

- [ ] **Step 3: Verify the tests fail**

```bash
bun test src/testing/identity-live/result.test.ts src/testing/identity-live/inspect.test.ts
```

- [ ] **Step 4: Implement result derivation**

Use fixed post-authorization stop precedence:

```text
ledgerFailure
credentialRefreshRequired
internalFailure
serviceFailure
auditOverflow
cleanupIncomplete
testFailure
null
```

Proof refusal remains the primary reason even when its best-effort audit is secondary overflow or
indeterminate. `live` is always mutate; `reap` is mutate only with `--yes`. A complete dry-run with
visible resources is completed/null. Any nonnull post-authorization reason is partial.

- [ ] **Step 5: Implement inspect**

Return the run ID, native opaque root ID, SHA-256 of the exact canonical bytes, generation, creation
time, scope, and row count. Close the retained handle in `finally`. Concurrent replacement may make the
snapshot stale but cannot mix generations.

- [ ] **Step 6: Verify and commit**

```bash
bun test src/testing/identity-live/result.test.ts src/testing/identity-live/inspect.test.ts
bun run verify:tsc
git add src/testing/identity-live/inspect.ts src/testing/identity-live/inspect.test.ts src/testing/identity-live/result.test.ts src/testing/identity-live/types.ts
git commit -m "feat(identity): add total run results and inspect"
```

## Task 7: Implement Dry-Run And Proof-Bound Stale Reaping

**Files:**

- Modify: `src/testing/identity-live/cleanup.ts`
- Create: `src/testing/identity-live/reaper.test.ts`
- Modify: `src/testing/identity-live/runner.ts`

- [ ] **Step 1: Write every reaper refusal and mutation test**

Cover active lock, scope mismatch, account mismatch, proof unavailable/mismatch, copied root,
replaced ledger before/after lock, changed digest, boot change, remount, network filesystem,
macOS/Windows audit-only, young row, same-name recreation, malformed tags, out-of-window creation,
unledgered findings, `planned`, terminal rows, dry-run, partial rerun, and exact same-boot Linux cleanup.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-live/reaper.test.ts
```

- [ ] **Step 3: Implement stale authority validation**

Mutating reap:

1. opens the original protected root;
2. reads canonical ledger and digest;
3. verifies Linux same-boot root/lock/mount proof;
4. acquires permanent `.run.lock` nonblocking;
5. rereads ledger through the retained root;
6. repeats every proof/scope/run validation;
7. requires exact pre-lock digest;
8. verifies STS account and official endpoints;
9. captures one age cutoff;
10. holds the lock through every read, Delete, poll, audit, and ledger CAS.

Dry-run performs the same protected-root, lock-exclusion, canonical ledger, scope, account, endpoint,
and credential checks but requires no mutation proof and performs no Delete or ledger write.

- [ ] **Step 4: Verify**

```bash
bun test src/testing/identity-live/reaper.test.ts src/testing/identity-live/cleanup.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/testing/identity-live/cleanup.ts src/testing/identity-live/reaper.test.ts src/testing/identity-live/runner.ts
git commit -m "feat(identity): add proof-bound stale run reaping"
```

## Task 8: Implement Live Matrix And Fixture-Capture Run Port

**Files:**

- Create: `src/testing/identity-live/runner.ts`
- Create: `src/testing/identity-live/runner.test.ts`
- Create: `src/testing/identity-live/fixtureCapturePort.test.ts`
- Modify: `src/testing/identity-live/types.ts`
- Modify: `src/testing/identity-fixtures/publication.ts`
- Modify: `src/testing/identity-fixtures/publication.test.ts`

- [ ] **Step 1: Write fake-service live matrix tests**

Cover:

- named, included per-tenant/global, custom, and Microsoft OAuth;
- OBO replace/remove and secret-method transitions;
- raw custom Create with omitted auth method;
- API-key managed/external;
- workload replace/clear and six-URL rejection;
- both payment vendors in managed/external modes;
- all six source-switch directions in both directions;
- four-family tag lifecycle;
- small-page traversal;
- default token-vault read;
- readiness/update polling;
- cleanup in `finally`;
- sentinel scans.

- [ ] **Step 2: Write fixture-port sealing tests**

The production `FixtureCaptureRunnerPort` uses purpose `fixtureCapture`, exact owner
`agentcore-cli-identity-fixture-capture-v1`, and the same ledger/dispatch/observation/Delete/audit
engine. Test:

- `READY` only for `quiescent`, completed zero findings, and all rows `createNotSent`/`deleted`;
- any planned/outcome-unknown/observed/delete-accepted row blocks seal;
- audit overflow and indeterminate results;
- seal failure after successful quiescent audit;
- exact `notCreated`/`discarded`/`retained` capture-root cleanup;
- no duplicate fixture-only cleanup.

Define a narrow proof-gated handoff:

```ts
export interface FixtureCaptureSealPort {
  seal(
    request: FixtureCaptureSealRequest,
    evidence: FixtureRunSealEvidenceV1,
  ): Promise<FixtureCaptureSealOutcome>;
}
```

Only the live runner module can mint `FixtureRunSealEvidenceV1`, after a quiescent completed
zero-finding audit, an all-terminal ledger reread, and an unchanged exact ledger digest. Plan 08's
publication module adapts this port to plan 03's native seal primitive; neither side implements cleanup
or native mutation owned by another plan.

- [ ] **Step 3: Verify the tests fail**

```bash
bun test src/testing/identity-live/runner.test.ts src/testing/identity-live/fixtureCapturePort.test.ts
```

- [ ] **Step 4: Implement one operation environment**

Live, capture, and reap reject `--endpoint-url`, bypass environment/profile endpoint overrides, resolve
official HTTPS AgentCore/STS/Secrets Manager endpoints before STS, and resolve credentials once. Give
all clients non-refreshing clones over the same snapshot and check freshness before every send.

- [ ] **Step 5: Implement the matrix and capture port**

The live runner creates the run root/lock/ledger before AWS, injects four ownership tags in each
original Create, uses exact workflow actions for behavior assertions, performs final cleanup/audit,
terminalizes accepted deletions, rereads the all-terminal ledger, and derives one result.

`createFixtureCaptureRunner` wraps the same engine around the fixture flow callback. It holds the run
lock through the terminal ledger reread and `FixtureCaptureSealPort.seal`, then returns only the closed
run and seal outcome required by plan 08. Any unresolved row, audit finding, audit overflow,
quiescence failure, digest change, or seal failure returns `notSealed` and never writes `READY`.

- [ ] **Step 6: Verify and commit**

```bash
bun test src/testing/identity-live/runner.test.ts src/testing/identity-live/fixtureCapturePort.test.ts src/testing/identity-fixtures/publication.test.ts
bun run verify:tsc
git add src/testing/identity-live/types.ts src/testing/identity-live/runner.ts src/testing/identity-live/runner.test.ts src/testing/identity-live/fixtureCapturePort.test.ts src/testing/identity-fixtures/publication.ts src/testing/identity-fixtures/publication.test.ts
git commit -m "feat(identity): add recoverable live and capture runs"
```

## Task 9: Implement Strict Live, Reap, And Inspect Commands

**Files:**

- Create: `src/testing/identity-live/commands.ts`
- Create: `src/testing/identity-live/commands.test.ts`
- Create: `test/subprocess/identity-live-commands.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write parser and exit tests**

Reject positionals, endpoint/ledger/prefix/force/all/profile flags, duplicate scalars, duplicate or
out-of-order families, missing values, noncanonical numbers, relative/NUL/over-4096-byte paths, and
argument/environment/ledger scope mismatch before AWS.

Parser failure emits no result and exits 2. `completed` exits 0; `active`, `refused`, and `partial` exit

1. Inspect success exits 0, closed inspect failure 1, usage 2.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-live/commands.test.ts test/subprocess/identity-live-commands.test.ts
```

- [ ] **Step 3: Implement exact command surfaces**

Add:

```json
{
  "test:identity:live": "bun src/testing/identity-live/commands.ts live",
  "test:identity:reap": "bun src/testing/identity-live/commands.ts reap",
  "test:identity:inspect": "bun src/testing/identity-live/commands.ts inspect"
}
```

Live requires a nonexistent root and `--yes`. Reap requires an existing root, expected run/scope,
minimum age 1800..31536000, and defaults to dry-run. Inspect accepts only `--run-root`.

- [ ] **Step 4: Verify and commit**

```bash
bun test src/testing/identity-live/commands.test.ts test/subprocess/identity-live-commands.test.ts
bun run verify:tsc
git add src/testing/identity-live/commands.ts src/testing/identity-live/commands.test.ts test/subprocess/identity-live-commands.test.ts package.json bun.lock
git commit -m "feat(identity): add live recovery commands"
```

## Task 10: Run Kill-Point, Host-Proof, And Deploy-Account Gates

**Files:**

- Create: `test/subprocess/identity-live-killpoints.test.ts`
- Test: all live/fixture/native modules

- [ ] **Step 1: Run exhaustive deterministic kill points**

Kill before/after planned CAS, both Create deadline checks, outcome-unknown sync, handler invocation,
service acceptance, observation, Delete outcome sync/send/receipt, every poll, delete acceptance, final
audit, deleted batch sync, all-terminal reread, `READY`, and final directory sync. Every survivor is old
or next canonical generation. Absence without correlated exact Delete success never advances.

- [ ] **Step 2: Run host-native proof tests**

On Linux, perform same-boot unmount/remount and prove unique mount ID changes and mutation is refused.
Exercise permanent lock exclusion through process death. macOS/Windows assert explicit audit-only stale
recovery while ordinary live run cleanup remains supported in-process.

- [ ] **Step 3: Refresh deploy credentials**

Run in the background before live execution:

```bash
ada credentials update --account 603141041947 --role Admin --profile deploy > /tmp/identity_ada_credentials.txt 2>&1 &
```

Wait for the credential process and verify success before any AWS command.

- [ ] **Step 4: Run the explicit live suite**

```bash
AWS_PROFILE=deploy AWS_REGION=us-east-1 AWS_ACCOUNT_ID=603141041947 bun run test:identity:live -- --run-root /tmp/agentcore-identity-live-<new-id> --expected-account 603141041947 --expected-region us-east-1 --expected-partition aws --expected-owner agentcore-cli-identity-live-v1 --expected-family api-key-provider --expected-family oauth2-provider --expected-family payment-provider --expected-family workload-identity --expected-family secrets-manager-secret --yes > /tmp/identity_live_results.txt 2>&1
```

Expected: exit 0, completed result, `quiescent`, completed zero-finding audit, all rows terminal, no
remaining Identity resources or Secrets Manager secrets. Inspect the bounded result from the temp file.

- [ ] **Step 5: Run the full recovery gate**

```bash
bun run build:native:host
bun test src/testing/identity-live src/testing/identity-fixtures test/subprocess/identity-live-killpoints.test.ts
bun run build
bun run verify:tsc
bun run format:check
git diff --check
```

- [ ] **Step 6: Run independent Codex reviews**

Run four focused `openai.gpt-5.6-sol` reviews: ledger/state machine, AWS factual/API, cleanup security,
and implementation readiness. Require explicit checks for dual deadlines, handler-local no-send proof,
receipt correlation, planned-deletion audit, cycle representation, counters, result derivation, lock
proof, dry-run, capture seal gate, and every kill point. Fix and repeat until all reports end in
`VERDICT: PASS`.

- [ ] **Step 7: Push**

```bash
git push origin feat/identity-cli
```
