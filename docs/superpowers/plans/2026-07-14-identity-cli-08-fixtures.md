# Identity Deterministic Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unsafe generic Identity fixture path with deterministic, schema-redacted SDK-level capture/replay, immutable content-addressed artifacts, closed command handoffs, and native crash-consistent publication.

**Architecture:** One logical-call transaction wraps Smithy retries and accepts a fixture only after the real action normalizer or safe error mapper accepts the terminal SDK-shaped value. Capture and replay use real SDK clients and request handlers; canonical artifacts remain in unique protected capture roots until one native transaction verifies and publishes a sealed generation.

**Tech Stack:** TypeScript, AWS SDK v3 middleware, Smithy Core 3.29.1, SHA-256, strict canonical JSON, the plan 03 native adapter, Bun test and subprocess kill-point tests.

---

## File Structure

```text
src/testing/identity-fixtures/
|-- types.ts
|-- canonical.ts
|-- algebra.ts
|-- redaction.ts
|-- recorder.ts
|-- replay.ts
|-- manifest.ts
`-- publication.ts

src/testing/identity-live/
`-- types.ts

scripts/identity-fixtures/
|-- capture.ts
|-- list.ts
|-- publish.ts
|-- discard.ts
`-- reap.ts

native/identity/test/
|-- binding.gyp
|-- addon.cc
|-- fixture_kill_points.h
`-- fixture_kill_points.cc

test/fixtures/identity-fixture-tree/identity/v1/
|-- objects/
|-- manifests/
`-- suite-index.json

test/subprocess/
|-- identity-fixture-native-helper.ts
|-- identity-fixture-commands.test.ts
`-- identity-fixture-publication-kill.test.ts
```

This plan creates the shared live/capture result and run-port types in
`src/testing/identity-live/types.ts`; plan 09 implements the one production recovery engine behind
that port. Fixture modules remain parallel to the legacy Harness recorder: they do not modify
`src/testing/fixtures.tsx` or existing Harness `__fixtures__`. They never implement a second cleanup,
ownership, or production native-publication protocol.

## Task 1: Define The Closed Fixture And Command Algebras

**Files:**

- Create: `src/testing/identity-fixtures/types.ts`
- Create: `src/testing/identity-fixtures/types.test.ts`
- Create: `src/testing/identity-live/types.ts`
- Create: `test/compile/identity-fixture-types.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write exact-union and negative compile tests**

Cover `FixtureRecordV1`, every `FixtureValue` tag, logical page tokens, flow entries/manifests,
`FixtureReadyV1`, capture/list/publish/discard/reap results, publication durability, and native handle
state. Compile fixtures reject:

- unknown operations or statuses;
- raw request/response values;
- request IDs and service messages;
- arbitrary unknown-union bodies;
- physical continuation tokens;
- open capture handles passed to publish;
- caller-selected artifact paths, base state, or next-index bytes.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-fixtures/types.test.ts
bun run verify:tsc
```

- [ ] **Step 3: Implement the exact record algebra**

Define:

```ts
export type FixtureRecordV1<O extends IdentityOperationName = IdentityOperationName> =
  | Readonly<{
      version: 1;
      kind: "success";
      operation: O;
      transport: Readonly<{
        requestHandlerInvoked: true;
        responseCompleted: true;
        httpStatus: IdentityExpectedSuccessStatus[O];
      }>;
      output: FixtureValue;
      markers?: Readonly<{ oauthFailureReasonPresent: true }>;
    }>
  | Readonly<{
      version: 1;
      kind: "modeledError";
      operation: O;
      transport: Readonly<{
        requestHandlerInvoked: true;
        responseCompleted: true;
        httpStatus: number;
      }>;
      code: SafeServiceCode;
    }>;

export type FixtureValue =
  | Readonly<{ type: "null" }>
  | Readonly<{ type: "boolean"; value: boolean }>
  | Readonly<{ type: "number"; value: number }>
  | Readonly<{ type: "string"; value: string }>
  | Readonly<{ type: "date"; value: string }>
  | Readonly<{ type: "pageToken"; value: LogicalPageToken }>
  | Readonly<{ type: "array"; value: readonly FixtureValue[] }>
  | Readonly<{
      type: "object";
      value: readonly Readonly<{ key: string; value: FixtureValue }>[];
    }>
  | Readonly<{ type: "unknownUnion"; member: SafeMemberName }>;
```

Operation success status is derived from the plan 04 registry. Modeled errors require integer
`300..599` and the allowlisted code. Number constructors reject non-finite values and normalize `-0`
to `0`.

- [ ] **Step 4: Define the capture-run handoff without a second runner**

`src/testing/identity-live/types.ts` owns `RunPurposeV1`, `RunAuditReportV1`,
`RunCleanupSnapshotV1`, terminal row-state names, and:

```ts
export interface FixtureCaptureRunnerPort {
  execute(
    request: FixtureCaptureRunRequest,
    flow: (scope: FixtureCaptureFlowScope) => Promise<FixtureCaptureFlowOutcome>,
  ): Promise<FixtureCaptureRunOutcome>;
}
```

The outcome contains exact run ID, root ID, ledger digest, cleanup snapshot, audit, and
all-rows-terminal evidence. The fixture layer cannot construct that evidence; plan 08 tests this port
with fakes, and only plan 09's canonical ledger/audit implementation supplies the production runner.

- [ ] **Step 5: Verify and commit**

```bash
bun test src/testing/identity-fixtures/types.test.ts
bun run verify:tsc
git add src/testing/identity-fixtures/types.ts src/testing/identity-fixtures/types.test.ts src/testing/identity-live/types.ts test/compile/identity-fixture-types.ts tsconfig.json
git commit -m "feat(identity): define safe fixture algebras"
```

## Task 2: Implement Canonical Fixture JSON And Content Identity

**Files:**

- Create: `src/testing/identity-fixtures/canonical.ts`
- Create: `src/testing/identity-fixtures/canonical.test.ts`

- [ ] **Step 1: Write canonical-codec adversarial tests**

Cover UTF-8 without BOM, no trailing newline, duplicate keys, comments, trailing commas, depth/node
caps, sorted object entries by encoded key bytes, preserved array order, `-0`, finite-number spelling,
all JSON escapes, lone surrogates, invalid UTF-8, inherited keys, `__proto__`, byte-identical
round-trips, and digest mismatch.

```ts
expect(encodeCanonicalFixtureJson({ b: 1, a: -0 })).toEqual(
  new TextEncoder().encode('{"a":0,"b":1}'),
);
expect(parseCanonicalFixtureJson(new TextEncoder().encode('{"a":1,"a":2}')).kind).toBe("invalid");
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-fixtures/canonical.test.ts
```

- [ ] **Step 3: Implement one canonical codec**

Expose:

```ts
export interface CanonicalFixtureBytesV1 {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export function encodeCanonicalFixtureJson(value: FixtureCanonicalValue): CanonicalFixtureBytesV1;
export function parseCanonicalFixtureJson(bytes: Uint8Array): CanonicalFixtureParseOutcome;
```

Use the duplicate-aware parser from plan 02. Do not use ambient `JSON.stringify` for artifact
identity. Verify canonical re-encoding byte-for-byte before minting a parsed value.

- [ ] **Step 4: Verify and commit**

```bash
bun test src/testing/identity-fixtures/canonical.test.ts
bun run verify:tsc
git add src/testing/identity-fixtures/canonical.ts src/testing/identity-fixtures/canonical.test.ts
git commit -m "feat(identity): add canonical fixture encoding"
```

## Task 3: Build The Operation Schema, Redaction, And Reflection Registry

**Files:**

- Create: `src/testing/identity-fixtures/algebra.ts`
- Create: `src/testing/identity-fixtures/algebra.test.ts`
- Create: `src/testing/identity-fixtures/redaction.ts`
- Create: `src/testing/identity-fixtures/redaction.test.ts`
- Modify: `src/handlers/identity/domain/secretSlots.ts`
- Modify: `src/core/identity/operations.ts`

- [ ] **Step 1: Write exhaustive registry drift tests**

For every Identity operation, assert one public request schema, safe fixture output/error codec,
success status, page-token paths, timestamp paths, resource-name/ARN/secret-ID paths, dynamic map
paths, and sensitive paths. A new operation, union member, schema member, or sensitive trait must fail
the registry test before filesystem access.

Use high-entropy sentinels in every sensitive request path and every response-derived representation:
strings, dynamic keys, number lexemes/canonical numbers, booleans, null, dates, unknown names,
physical/logical/production tokens, request IDs, and HTTP status.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-fixtures/algebra.test.ts src/testing/identity-fixtures/redaction.test.ts
```

- [ ] **Step 3: Implement schema-guided request identity**

Expose:

```ts
export interface RedactedFixtureRequest {
  readonly operation: IdentityOperationName;
  readonly canonical: CanonicalFixtureBytesV1;
  readonly requestDigest: string;
}

export function redactFixtureRequest(
  operation: IdentityOperationName,
  input: unknown,
): FixtureRedactionOutcome;
```

Traverse only registered schemas. Replace each sensitive leaf with a stable path/type marker before
canonicalization. Hash a domain-separated operation name plus canonical request. Unknown operations,
members, union arms, duplicates, inherited data, or schema drift return a closed failure before native
or filesystem access.

- [ ] **Step 4: Implement safe fixture projection and reconstruction**

Operation-specific codecs:

- project only registered output fields;
- omit raw failure text, request IDs, and `$metadata`;
- sanitize only unknown member names;
- encode valid dates and registered page tokens;
- reconstruct a fresh SDK-shaped value;
- revalidate the reconstruction before staging.

The complete-value matcher remains a private closure from the binding/recorder. It is never accepted
by a public action or fixture port.

- [ ] **Step 5: Verify and commit**

```bash
bun test src/testing/identity-fixtures/algebra.test.ts src/testing/identity-fixtures/redaction.test.ts src/core/identity/statusRegistry.test.ts
bun run verify:tsc
git add src/testing/identity-fixtures/algebra.ts src/testing/identity-fixtures/algebra.test.ts src/testing/identity-fixtures/redaction.ts src/testing/identity-fixtures/redaction.test.ts src/handlers/identity/domain/secretSlots.ts src/core/identity/operations.ts
git commit -m "feat(identity): add schema-safe fixture projection"
```

## Task 4: Implement One Logical-Call Acceptance Transaction Across Retries

**Files:**

- Create: `src/testing/identity-fixtures/recorder.ts`
- Create: `src/testing/identity-fixtures/transaction.test.ts`
- Modify: `src/core/identity/bindings.ts`
- Modify: `src/core/identity/factory.ts`
- Modify: `src/core/identity/paginator.ts`
- Modify: `src/core/identity/statusRegistry.ts`
- Modify: `src/handlers/identity/actions/types.ts`
- Modify: `src/handlers/identity/actions/query.ts`
- Modify: `src/handlers/identity/actions/picker.ts`
- Modify: `src/handlers/identity/actions/mutation.ts`
- Modify: `src/handlers/identity/composition.ts`

- [ ] **Step 1: Write Smithy middleware-order and retry tests**

Instrument the pinned stack and prove:

```text
initialize transaction: once per Client.send
serialize: once in the pinned stack
request handler: once per SDK attempt
deserialize projector: once per response attempt
retry selection: one terminal output/rejection
finalization: at most once per logical call
```

Cover `500 -> 200`, exhausted allowlisted modeled error, network failure, cancellation, unmodeled
error, projection failure, repeated serialization, and mutation `maxAttempts: 1`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-fixtures/transaction.test.ts
```

- [ ] **Step 3: Implement the state machine**

```ts
export type FixtureCallState = "open" | "terminalStaged" | "finalized" | "discarded";

export interface LogicalFixtureCall {
  stageTerminal(terminalObject: object): FixtureStageOutcome;
  finalize(acceptance: FixtureAcceptance): FixtureFinalizeOutcome;
  discard(): void;
}
```

An initialize middleware creates one transaction and a private call-ID object. Per-attempt projectors
create detached immutable candidates and correlate them through a call-local
`WeakMap<object, DetachedFixtureCandidate>`. Only the initialize wrapper may stage the exact terminal
object selected by retry middleware. Workflow normalizers and safe error mappers receive a private
acceptance callback through construction; production receives the same shape with no-op storage.

Any transaction not finalized is discarded in `finally`. Intermediate attempts install no object,
append no flow entry, reserve/consume no occurrence, and poison nothing.

The fixture-neutral binding/action extension accepts one logical call or one all-pages batch only
after the production normalizer or safe error mapper succeeds. No fixture type, recorder, filesystem,
or replay implementation crosses the action port.

- [ ] **Step 4: Verify and commit**

```bash
bun test src/testing/identity-fixtures/transaction.test.ts src/core/identity
bun run verify:tsc
git add src/testing/identity-fixtures/recorder.ts src/testing/identity-fixtures/transaction.test.ts src/core/identity/bindings.ts src/core/identity/factory.ts src/core/identity/paginator.ts src/core/identity/statusRegistry.ts src/handlers/identity/actions/types.ts src/handlers/identity/actions/query.ts src/handlers/identity/actions/picker.ts src/handlers/identity/actions/mutation.ts src/handlers/identity/composition.ts
git commit -m "feat(identity): add logical fixture transactions"
```

## Task 5: Implement Capture And Replay Through Real SDK Clients

**Files:**

- Modify: `src/testing/identity-fixtures/recorder.ts`
- Create: `src/testing/identity-fixtures/recorder.test.ts`
- Create: `src/testing/identity-fixtures/replay.ts`
- Create: `src/testing/identity-fixtures/replay.test.ts`
- Modify: `src/core/identity/factory.ts`

- [ ] **Step 1: Write capture ordering and body tests**

Assert the capture request-handler wrapper:

1. invokes the real handler;
2. bounds the original body with `normalizeIdentityBody`;
3. restores exact status, headers, and fresh copied bytes;
4. lets raw compatibility/status/map middleware run first;
5. projects only after generated deserialization;
6. stages only the retry-selected terminal object;
7. finalizes only after action/current-state normalization.

Cover exact/N+1 one-MiB bodies, nonempty 204, alternate 2xx, additive guarded response, malformed map,
reflected secret, modeled errors, unmodeled errors, and committed normalization failure.

- [ ] **Step 2: Write replay reservation tests**

Use:

```text
available -> reserved(callId) -> consumed
                             \-> poisoned(callId)
```

Test exact sequence, operation/digest/occurrence collisions, retry reuse, missing/extra/reordered/
foreign calls, discard after reservation, later matching calls after poison, and final unconsumed/
reserved/poisoned verification. A discarded reservation is never returned to `available`.

- [ ] **Step 3: Verify the tests fail**

```bash
bun test src/testing/identity-fixtures/recorder.test.ts src/testing/identity-fixtures/replay.test.ts
```

- [ ] **Step 4: Implement capture and replay request handlers**

Construct real `BedrockAgentCoreControlClient` instances with concrete capture/replay handlers. Do not
replace bound `send` and do not cast `{ send }` as a client. Replay reserves one immutable record before
the first attempt and synthesizes bounded wire bytes for every SDK retry. Those bytes traverse the same
body normalizer, raw guard, map revival, generated deserializer, transport classifier, action
normalizer, and outer fixture verifier as capture.

An accepted `204` synthesizes absent body. Modeled errors use static CLI-owned messages and no request
ID. Unknown tags, invalid dates, unsupported scalar types, operation/status mismatch, over-cap bytes,
or malformed wire shape fail closed.

- [ ] **Step 5: Prove isolation from existing non-Identity fixtures**

Do not modify `src/testing/fixtures.tsx` or existing Harness `__fixtures__`. Add an integration test
proving Identity composition selects only the registered Identity adapter and that no Identity
operation can reach the legacy recorder. Existing Harness fixture tests must remain byte-compatible.

- [ ] **Step 6: Verify and commit**

```bash
bun test src/testing/identity-fixtures/recorder.test.ts src/testing/identity-fixtures/replay.test.ts src/handlers/harness/harness.test.tsx
bun run verify:tsc
git add src/testing/identity-fixtures/recorder.ts src/testing/identity-fixtures/recorder.test.ts src/testing/identity-fixtures/replay.ts src/testing/identity-fixtures/replay.test.ts src/core/identity/factory.ts
git commit -m "feat(identity): add real-client fixture capture and replay"
```

## Task 6: Implement Logical Tokens, Resources, Timestamps, And Flow Manifests

**Files:**

- Create: `src/testing/identity-fixtures/manifest.ts`
- Create: `src/testing/identity-fixtures/manifest.test.ts`
- Modify: `src/testing/identity-fixtures/algebra.ts`
- Modify: `src/testing/identity-fixtures/recorder.ts`
- Modify: `src/testing/identity-fixtures/replay.ts`

- [ ] **Step 1: Write deterministic mapping tests**

Cover:

- stable repository-owned flow IDs;
- operation/digest zero-based occurrences;
- ordered exact call sequence;
- one in-flight call per flow;
- parallel disjoint flows and shuffled worker schedules;
- per-flow/per-list-operation physical-to-logical token bijections;
- unissued continuation rejection before network;
- repeated token/cycle alias equality;
- logical-to-physical names, ARNs, secret IDs, and ownership tags;
- fixed epoch with one-millisecond timestamp roles;
- immutable `createdTime` change rejection;
- byte-identical manifests and object content across two physical recordings.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-fixtures/manifest.test.ts
```

- [ ] **Step 3: Implement flow state**

`LogicalPageToken` matches `^fixture-token-v1-[0-9]{8}$`. The first physical token maps to ordinal
`00000000`; repeated physical values reuse their alias. Fixture identity is computed from the logical
request before physical resource/token mapping. Physical values never enter artifact bytes, names, or
output.

Flow manifests list exact operation, request digest, occurrence, object digest, and byte length in call
order. Replay consumes every entry exactly once. A sorted suite index makes discovery independent of
worker order.

- [ ] **Step 4: Verify and commit**

```bash
bun test src/testing/identity-fixtures/manifest.test.ts src/testing/identity-fixtures/recorder.test.ts src/testing/identity-fixtures/replay.test.ts
bun run verify:tsc
git add src/testing/identity-fixtures/manifest.ts src/testing/identity-fixtures/manifest.test.ts src/testing/identity-fixtures/algebra.ts src/testing/identity-fixtures/recorder.ts src/testing/identity-fixtures/replay.ts
git commit -m "feat(identity): add deterministic fixture flows"
```

## Task 7: Compose And Crash-Test Native Capture Publication

**Files:**

- Create: `src/testing/identity-fixtures/publication.ts`
- Create: `src/testing/identity-fixtures/publication.test.ts`
- Create: `native/identity/test/binding.gyp`
- Create: `native/identity/test/addon.cc`
- Create: `native/identity/test/fixture_kill_points.h`
- Create: `native/identity/test/fixture_kill_points.cc`
- Create: `test/subprocess/identity-fixture-native-helper.ts`
- Create: `test/subprocess/identity-fixture-publication-kill.test.ts`

- [ ] **Step 1: Write capture artifact tests**

Against plan 03's production native primitives, cover exclusive cryptographic capture roots,
immutable object/manifest install, exact
`.agentcore-capture-tmp-<32-hex>` grammar, no-replace contention, valid cache hit, empty/truncated/
wrong-digest/non-canonical existing object, process kill before/after sync/rename, cleanup of every
normal-return temporary, and `READY` installed last only after directory sync and no temporary.

- [ ] **Step 2: Write publication transaction tests**

Test:

- handle identity and `RUN_BINDING`;
- lock order capture -> authority -> retained tree;
- nonblocking contention and reverse release;
- descriptor-relative reserved-temporary cleanup;
- exact base, stale third state, and already-current next index;
- object/manifest verification and install;
- index rename as the commit point;
- pre-commit `notPublished`;
- post-commit `directorySynced`, `processCrashOnly`, or `unknownAfterCommit`;
- idempotent retry;
- alternate path, bind mount, separate private `/tmp` namespace, copied/moved/reboot-stale capture;
- no JavaScript mutation fallback.

- [ ] **Step 3: Verify the tests fail**

```bash
bun run build:native:host
bun run build:native:fixture-test
bun test src/testing/identity-fixtures/publication.test.ts src/native/identity/capture.test.ts
```

- [ ] **Step 4: Implement the fixture publication orchestration**

Consume, without redefining, plan 03's production API:

```ts
export function publishFixtureTransaction(
  authority: NativePublicationAuthorityHandle,
  capture: NativeSealedCaptureRootHandle,
  fixtureTree: NativeFixtureTreeHandle,
  runRoot: NativeProtectedRootHandle,
): NativeFixturePublicationOutcome;
```

The native transaction rereads canonical `READY`, derives all paths/digests/base/next bytes, revalidates
all handles and provenance, owns locks, installs objects, commits the index, classifies durability, and
cleans only exact reserved temporaries.

`publication.ts` assembles canonical artifacts and maps closed native outcomes. It never opens a path
for mutation, renames, locks, recursively deletes, supplies index bytes, or implements a JavaScript
fallback. Production sealing remains disabled until plan 09 injects its proof-gated
`FixtureCaptureSealPort`.

- [ ] **Step 5: Build the test-only kill-point addon**

Compile the plan 03 sources only with `AGENTCORE_IDENTITY_FIXTURE_TESTING` for this helper addon. Hard
exit before and after artifact fsync/no-replace, `READY` fsync/rename, index fsync/rename, and final
directory sync. The production prebuild exports no kill-point control and contains no enabled test
branch.

- [ ] **Step 6: Verify and commit**

```bash
bun run build:native:host
bun run build:native:fixture-test
bun test src/testing/identity-fixtures/publication.test.ts src/native/identity test/subprocess/identity-fixture-publication-kill.test.ts
bun run verify:tsc
git add src/testing/identity-fixtures/publication.ts src/testing/identity-fixtures/publication.test.ts native/identity/test test/subprocess/identity-fixture-native-helper.ts test/subprocess/identity-fixture-publication-kill.test.ts
git commit -m "test(identity): verify native fixture publication"
```

## Task 8: Implement Closed Fixture Command Handoffs

**Files:**

- Modify: `src/testing/identity-fixtures/publication.ts`
- Modify: `src/testing/identity-fixtures/publication.test.ts`
- Create: `scripts/identity-fixtures/capture.ts`
- Create: `scripts/identity-fixtures/list.ts`
- Create: `scripts/identity-fixtures/publish.ts`
- Create: `scripts/identity-fixtures/discard.ts`
- Create: `scripts/identity-fixtures/reap.ts`
- Create: `test/subprocess/identity-fixture-commands.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write strict parser/result/exit tests**

Reject positionals, unknown flags, duplicate scalar flags, authority/staging overrides, endpoint,
profile, flow subset, relative/NUL/over-4096-byte paths, malformed IDs/digests, missing scope,
out-of-order/duplicate families, and absent consent. Parser failure emits no document and exits `2`.

Test every exact result and exit rule:

- completed definitive success `0`;
- handled/retryable failure `1`;
- parser, unknown durability, or required cleanup failure `2`;
- no native/AWS error text;
- final capture-result output failure after seal retains a discoverable root.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/testing/identity-fixtures/publication.test.ts test/subprocess/identity-fixture-commands.test.ts
```

- [ ] **Step 3: Implement list, publish, discard, and reap commands**

Use exact command surfaces from the design. Publication accepts the six-field join:
fixture tree, run root, capture ID, READY digest, expected run ID, and expected ledger digest. It passes
no artifact list/base/next bytes to native code. Definitive publication and `staleBase` discard the
capture; unknown/retryable outcomes retain it. Explicit discard requires `--yes`. Automatic reap never
removes a same-boot sealed `READY` root.

- [ ] **Step 4: Implement capture command over `FixtureCaptureRunnerPort`**

Capture:

1. rejects endpoint overrides and requires `AWS_PROFILE=deploy`;
2. asks the injected run port to establish the exact account/region/partition/owner/family scope;
3. creates a unique open capture root;
4. runs every stable golden flow through the action/presentation/fixture stack;
5. poisons on any assertion, output, reflection, acceptance, or flow failure;
6. requests final cleanup/audit from the run port;
7. seals only for `quiescent`, completed zero-finding audit, and all terminal rows;
8. emits one exact `FixtureCaptureCommandResultV1`;
9. discards an unsealed open root in `finally` and reports its actual disposition.

The capture module has no alternative cleanup logic. Plan 09's `createFixtureCaptureRunner` is the
only production implementation accepted by composition. Until plan 09 installs that runner and its
proof-gated seal port, the production capture entrypoint returns a closed unavailable result without
creating a capture root or making an AWS call.

- [ ] **Step 5: Add package scripts**

```json
{
  "test:identity:fixtures:capture": "bun scripts/identity-fixtures/capture.ts",
  "test:identity:fixtures:list": "bun scripts/identity-fixtures/list.ts",
  "test:identity:fixtures:publish": "bun scripts/identity-fixtures/publish.ts",
  "test:identity:fixtures:discard": "bun scripts/identity-fixtures/discard.ts",
  "test:identity:fixtures:reap": "bun scripts/identity-fixtures/reap.ts"
}
```

- [ ] **Step 6: Verify and commit**

```bash
bun test src/testing/identity-fixtures/publication.test.ts test/subprocess/identity-fixture-commands.test.ts
bun run verify:tsc
git add src/testing/identity-fixtures/publication.ts src/testing/identity-fixtures/publication.test.ts scripts/identity-fixtures test/subprocess/identity-fixture-commands.test.ts package.json bun.lock
git commit -m "feat(identity): add fixture command handoffs"
```

## Task 9: Build Golden Flows And Fixture Regression Gates

**Files:**

- Create: `src/testing/identity-fixtures/golden.test.ts`
- Create: `src/testing/identity-fixtures/integration.test.ts`
- Create: `src/testing/identity-fixtures/package.test.ts`
- Create: `test/fixtures/identity-fixture-tree/identity/v1/`
- Test: `src/handlers/identity/**/*.test.tsx`
- Test: all fixture/native/action/router paths

- [ ] **Step 1: Add stable golden flow coverage**

Record/replay through the real root router, actions, SDK clients, middleware, and renderer:

- Create/Get/List/Update/Delete for each family;
- all OAuth families and both payment vendors through representative complete flows;
- managed/external secrets and repeated redacted-key collisions;
- Tag/List Tags/Untag;
- one-page, all-page, and picker pagination;
- modeled errors and unknown output unions;
- no-change and reprepare;
- Commander and Ink output boundaries.

Every flow uses stable logical names and high-entropy sentinel secrets. Scan stdout, stderr, fixtures,
goldens, filenames, errors, capture root, and final tree.

- [ ] **Step 2: Add poison/retry/kill-point suites**

Cover normalization failure after staging, replay discard followed by a matching call, retry attempt
selection, all-page atomic batches, interrupted object install, stale base, publication crash before/
after index commit, result-write failure after seal, and discovery recovery.

- [ ] **Step 3: Run the fixture gate**

```bash
bun run build:native:host
bun run build:native:fixture-test
bun test src/testing/identity-fixtures src/native/identity src/handlers/identity src/core/identity test/subprocess/identity-fixture-commands.test.ts test/subprocess/identity-fixture-publication-kill.test.ts
bun run build
bun run verify:tsc
bun run format:check
npm pack --dry-run --json > /tmp/identity_fixture_pack.json 2>&1
git diff --check
```

- [ ] **Step 4: Run independent Codex reviews**

Run separate `openai.gpt-5.6-sol` factual/architecture and security/implementation reviews. Require
explicit checks for schema completeness, secret reflection, retry transaction ownership, irreversible
replay poison, real client use, token/resource/time determinism, native mutation authority, lock order,
commit-point durability, command retention, and the one shared recovery port. Fix and repeat until both
reports end in `VERDICT: PASS`.

- [ ] **Step 5: Push**

```bash
git push origin feat/identity-cli
```
