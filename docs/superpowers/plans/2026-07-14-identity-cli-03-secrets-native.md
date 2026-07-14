# Identity Secrets And Native Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement secret extraction/context ownership and the first-party native adapter that securely reads secret files, owns protected roots and permanent locks, and provides the only fixture/publication mutation primitives.

**Architecture:** Parser-boundary extraction consumes sensitive strings immediately into opaque selections and leaves nominal markers in intents. A synchronous state machine transfers selections through preparation reservation, plan binding, commit claim, and lease disposal. Filesystem trust is delegated to one N-API v8 addon with closed typed outcomes; JavaScript has no pathname-reopen, ACL parser, locking, rename, or publication fallback.

**Tech Stack:** TypeScript, Bun/Node streams, N-API v8, node-addon-api 8.9.0, node-gyp 12.4.0, C++17, Linux/macOS/Windows native APIs.

---

## Task 1: Implement Opaque Secret Extraction

**Files:**

- Create: `src/handlers/identity/secrets/types.ts`
- Create: `src/handlers/identity/secrets/extraction.ts`
- Create: `src/handlers/identity/secrets/extraction.test.ts`
- Modify: `src/handlers/identity/domain/intents.ts`

- [ ] **Step 1: Write extraction failure and erasure tests**

Cover every OAuth/payment sensitive JSON path, every CLI source option, duplicate/conflicting sources,
multiple stdin consumers, failure before/after each extracted leaf, and disposal after parser rejection.
Use high-entropy sentinels and recursively scan returned markers/intents/errors.

```ts
const outcome = extractSecretSelections("oauth2.create", rawInputWithLiteral(SENTINEL));
expect(outcome.kind).toBe("extracted");
if (outcome.kind === "extracted") {
  expect(JSON.stringify(outcome.sanitized)).not.toContain(SENTINEL);
  expect(outcome.markers).toEqual(new Map([["client-secret", expect.any(Object)]]));
  outcome.selections.dispose();
}
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/secrets/extraction.test.ts
```

- [ ] **Step 3: Implement one-use selection bundles**

Expose:

```ts
export interface ExtractedSecretSelections {
  readonly markers: ReadonlyMap<SecretSlotId, SecretValueMarker<SecretSlotId>>;
  consume(): SecretSelectionInventoryOutcome;
  dispose(): void;
}

export type SanitizedJsonExtraction<C> =
  | Readonly<{ kind: "extracted"; sanitized: C; selections: ExtractedSecretSelections }>
  | Readonly<{ kind: "validationFailed"; error: UsageIdentityError }>;

export function extractSecretSelections<W extends MutationWorkflowId>(
  workflow: W,
  parserInput: unknown,
): SanitizedJsonExtraction<WorkflowIntentOf<W>>;
```

The bundle owns literal values and acquisition locators. `consume()` and `dispose()` are synchronous,
nonthrowing, mutually exclusive, and idempotent after the first terminal transition.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/secrets/extraction.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/secrets src/handlers/identity/domain/intents.ts
git commit -m "feat(identity): extract secrets into opaque selections"
```

## Task 2: Implement Commit Secret Context Ownership

**Files:**

- Create: `src/handlers/identity/secrets/context.ts`
- Create: `src/handlers/identity/secrets/context.test.ts`
- Create: `test/compile/secret-context-ownership.ts`

- [ ] **Step 1: Write the full ownership matrix**

Test:

```text
open-unbound -> preparing -> open-bound -> claimed -> disposed
open-unbound -> disposed
open-bound -> disposed
```

Cover concurrent preparation reservation, stale reuse, token/fingerprint mismatch, exact ordered
inventory, missing/extra/duplicate slots, replacement binding, bind/dispose races, duplicate commit,
claimed-shell disposal, preparation failure, no-change, cancellation, unmount, reprepare, and every
terminal commit outcome.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/handlers/identity/secrets/context.test.ts
bun run verify:tsc
```

- [ ] **Step 3: Implement the context factory and module-private coordinator**

Public surfaces:

```ts
export type SecretContextBuildOutcome =
  | Readonly<{ kind: "created"; context: CommitSecretContext }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "validationFailed"; error: UsageIdentityError }>
  | Readonly<{ kind: "secretFailed"; error: SecretIdentityError }>
  | Readonly<{ kind: "internalFailed"; error: InternalIdentityError }>;

export interface CommitSecretContextFactory {
  create(
    selections: readonly Readonly<{
      slot: SecretSlotId;
      source: SecretSourceSelection;
    }>[],
    extracted: ExtractedSecretSelections | undefined,
    prompt?: HiddenSecretPrompt,
    options?: IdentityCallOptions,
  ): Promise<SecretContextBuildOutcome>;
}

export interface CommitSecretContext {
  dispose(): void;
}
```

The factory consumes the exact ordered source declarations and optional parser-extracted bundle under
one creator-owned `try/finally`; every non-`created` outcome closes all partial locators, selections,
and values. The action-facing reservation/bind/claim functions are exported only through a private
symbol-owning module used by the action composition root. A claim transfers all values, locators,
reader, prompt, and complete-value matcher to an opaque lease whose `dispose()` is synchronous and
idempotent.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/secrets/context.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/secrets/context.ts src/handlers/identity/secrets/context.test.ts test/compile/secret-context-ownership.ts
git commit -m "feat(identity): add one-use secret context ownership"
```

## Task 3: Define And Load The Closed Native Adapter

**Files:**

- Create: `src/native/identity/types.ts`
- Create: `src/native/identity/loader.ts`
- Create: `src/native/identity/index.ts`
- Create: `src/native/identity/loader.test.ts`
- Create: `test/compile/native-identity-handles.ts`

- [ ] **Step 1: Write loader and type-state tests**

Tests must reject unknown platform/architecture, missing prebuild, malformed export/result, thrown
native errors, cross-state handle use, caller-provided publication-authority paths, and arbitrary
staging paths.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/native/identity/loader.test.ts
bun run verify:tsc
```

- [ ] **Step 3: Define the exact branded adapter surface**

Implement opaque handles and closed outcomes:

```ts
export type NativeOutcome<T, R extends string> =
  | Readonly<{ kind: "succeeded"; value: T }>
  | Readonly<{ kind: "failed"; reason: R }>;

export interface NativeSecureFileHandle {
  readonly kind: "secureFile";
}

export interface NativeProtectedRootHandle {
  readonly kind: "protectedRoot";
}

export interface NativeOpenCaptureRootHandle {
  readonly kind: "openCapture";
}

export interface NativeSealedCaptureRootHandle {
  readonly kind: "sealedCapture";
}
```

`AgentCoreNativeAdapter` must include the full design surface for secure file capture/read/close,
trusted parents, protected roots, root identity, permanent locks, publication authority, retained
fixture trees, capture creation/install/seal/open/list/discard/reap, ledger replacement, and atomic
publication. Every handle is represented internally by an unforgeable wrapper object and validated
again by native code.

Plan 03 owns every production TypeScript and C++ native publication primitive, including
`installCaptureArtifact`, capture sealing, and `publishFixtureTransaction`. Later fixture and recovery
plans may compose and test these primitives but must not add a second production rename, lock,
descriptor-relative cleanup, sealing, or publication implementation.

The loader selects exactly:

```ts
const PREBUILDS = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
} as const;
```

No JavaScript fallback is exposed.

- [ ] **Step 4: Verify**

```bash
bun test src/native/identity/loader.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/native/identity test/compile/native-identity-handles.ts
git commit -m "feat(identity): define closed native safety adapter"
```

## Task 4: Build Secure File Capture And Read Primitives

**Files:**

- Create: `native/identity/binding.gyp`
- Create: `native/identity/src/addon.cc`
- Create: `native/identity/src/common.h`
- Create: `native/identity/src/common.cc`
- Create: `native/identity/src/linux.cc`
- Create: `native/identity/src/darwin.cc`
- Create: `native/identity/src/windows.cc`
- Create: `src/native/identity/file.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write host-platform red tests**

Use temporary safe and unsafe files to cover exact `0400`/`0600`, owner, ACL/DACL, no-follow,
regular-file type, path substitution, symlink/reparse, size/change metadata, bounded read, invalid UTF-8,
unsupported filesystem, and close-once behavior. Platform-unavailable cases assert a closed
`unsupported` result, never a skipped assertion.

- [ ] **Step 2: Verify tests fail**

```bash
bun run build:native:host
bun test src/native/identity/file.test.ts
```

- [ ] **Step 3: Implement the N-API file contract**

Native functions must:

1. validate every path component without following links/reparse points;
2. open the canonical final regular file with a non-inheritable descriptor/handle;
3. verify owner and exact permissions/ACL/DACL;
4. retain native file identity and change metadata;
5. read through the held handle with a caller-independent fixed byte cap;
6. compare path and handle identity plus before/after metadata;
7. return bytes or a closed reason without OS text;
8. close idempotently.

Use platform APIs specified by the design. Do not invoke `ls`, `stat`, `getfacl`, PowerShell, or any
subprocess.

- [ ] **Step 4: Verify**

```bash
bun run build:native:host
bun test src/native/identity/file.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add native/identity src/native/identity package.json bun.lock
git commit -m "feat(identity): add secure native secret-file access"
```

## Task 5: Implement Secret Source Reading

**Files:**

- Create: `src/handlers/identity/secrets/reader.ts`
- Create: `src/handlers/identity/secrets/reader.test.ts`
- Modify: `src/handlers/identity/secrets/context.ts`

- [ ] **Step 1: Write source tests**

Cover literal, environment, file, bounded non-TTY stdin, hidden prompt, and EXTERNAL reference. Reject
TTY stdin, duplicate stdin use, empty values, byte/character overflow, invalid UTF-8, changed files,
missing env vars, unavailable prompts, cancellation, and unsupported native capability. Assert all
accepted values pass one common character validator unchanged.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/handlers/identity/secrets/reader.test.ts
```

- [ ] **Step 3: Implement the reader**

```ts
export interface SecretSourceReader {
  captureFile(path: string): NativeOutcome<SecretFileLocator, NativeFileCaptureFailureReason>;
  readEnvironment(
    name: string,
    limits: SecretValueLimits,
  ): Promise<SecretReadOutcome<string, SecretSourceReadFailureReason>>;
  readFile(
    locator: SecretFileLocator,
    limits: SecretValueLimits,
  ): Promise<SecretReadOutcome<string, SecretSourceReadFailureReason>>;
  readStdin(
    limits: SecretValueLimits,
  ): Promise<SecretReadOutcome<string, SecretSourceReadFailureReason>>;
  disposeFile(locator: SecretFileLocator): void;
}
```

The reader does not prompt. Presentation supplies `HiddenSecretPrompt` to context construction.
External references produce no local secret value.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/secrets
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/secrets
git commit -m "feat(identity): add bounded secret source reader"
```

## Task 6: Build Protected Roots, Locks, Ledger Replacement, And Capture Type States

**Files:**

- Modify: `native/identity/src/common.h`
- Modify: platform C++ files
- Create: `src/native/identity/protectedRoot.test.ts`
- Create: `src/native/identity/locks.test.ts`
- Create: `src/native/identity/capture.test.ts`

- [ ] **Step 1: Write protected-root and lock tests**

Cover invalid scalar child names, NUL/separators/dot/dot-dot/ADS/reserved DOS names, root mode/DACL,
unsafe ancestors, root replacement, lock first-create races, wrong lock type/owner/mode/ACL, no unlink/
rename, nonblocking contention, reverse-order release, and process-death release.

- [ ] **Step 2: Write capture/publication primitive tests**

Cover:

- fixed OS-selected authority root with no caller path;
- retained fixture-tree identity and co-located lock;
- `open -> sealed` capture state transition;
- origin and `RUN_BINDING` provenance;
- discovery limits and exact three-field run join;
- expected-digest ledger replacement with old/next/third/missing readback;
- native no-replace immutable object install;
- canonical `READY` sealing only after caller-supplied terminal run evidence is revalidated;
- descriptor-relative cleanup;
- lock order: capture, authority, retained tree for publication;
- stale base, already-current next index, pre/post-rename durability states;
- explicit discard and aged unsealed/reboot-stale reap.

- [ ] **Step 3: Verify tests fail**

```bash
bun test src/native/identity/protectedRoot.test.ts src/native/identity/locks.test.ts src/native/identity/capture.test.ts
```

- [ ] **Step 4: Implement native primitives**

Implement the exact lock table:

```text
capture creation / abandoned scan: publication authority -> one new/scanned capture
artifact install / seal / discard: one capture
publication: capture -> publication authority -> retained fixture tree
```

Every acquisition after the first is nonblocking. Contention releases held locks in reverse order and
returns `busy`. All cleanup, object installation, index replacement, and recursive deletion are
descriptor/handle-relative.

Implement and export only the closed wrappers already declared by Task 3, including
`installCaptureArtifact`, the open-to-sealed capture transition, and `publishFixtureTransaction`.
Production JavaScript never supplies artifact paths, index bytes, a base generation, or a fallback
mutation algorithm; native code derives and revalidates them from retained handles and canonical
metadata.

Place compile-time kill-point calls at the reviewed artifact, `READY`, index, and directory durability
boundaries behind `AGENTCORE_IDENTITY_FIXTURE_TESTING`. The ordinary host and release builds compile
those calls out and expose no control surface. Plan 08 supplies only the separate test addon and
subprocess crash harness that enables them.

Linux stale mutation proof requires `STATX_MNT_ID_UNIQUE` plus boot ID and root/lock identities.
macOS and Windows return `unsupported` for mutating stale cleanup while retaining ordinary protected
root and lock functionality.

- [ ] **Step 5: Verify**

```bash
bun run build:native:host
bun test src/native/identity
bun run verify:tsc
```

- [ ] **Step 6: Commit**

```bash
git add native/identity src/native/identity
git commit -m "feat(identity): add protected native capture primitives"
```

## Task 7: Secrets And Native Review Gate

- [ ] **Step 1: Run the complete host gate**

```bash
bun run build:native:host
bun test src/handlers/identity/secrets src/native/identity
bun run build
bun run verify:tsc
bun run format:check
git diff --check
```

- [ ] **Step 2: Run independent `openai.gpt-5.6-sol` security and implementation reviews**

Review the entire extraction/context/native surface against Secret Handling and the native/publication
contracts. Fix and repeat until both pass.

- [ ] **Step 3: Push**

```bash
git push origin feat/identity-cli
```
