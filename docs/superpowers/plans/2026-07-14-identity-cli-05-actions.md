# Identity Application Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 46 workflow-branded query, picker, and mutation actions that own bindings, bounded traversal, preparation, commit, reprepare, and disposal while exposing no SDK output, secret value, or presentation dependency.

**Architecture:** Actions consume the pure domain contracts from plan 02, opaque secret-context coordinator from plan 03, operation-specific binding factories from plan 04, and mutation supervisor ports from plan 01. Shared modules own only lifecycle mechanics and total outcome translation; API-key, OAuth, payment, workload, token-vault, and tag policy remains in resource-specific action modules.

**Tech Stack:** TypeScript, AWS SDK command types at the private request-builder boundary, Web Crypto SHA-256 through the domain guard module, AbortSignal, Bun test.

---

## File Structure

```text
src/handlers/identity/actions/
|-- types.ts
|-- query.ts
|-- picker.ts
|-- mutation.ts
|-- apiKey.ts
|-- oauth2.ts
|-- payment.ts
|-- workload.ts
|-- tokenVault.ts
`-- tags.ts

src/handlers/identity/
|-- composition.ts
`-- composition.test.ts

test/compile/
|-- identity-actions.ts
`-- identity-prepared-mutations.ts
```

`types.ts` owns the consumer-facing action contracts. `query.ts` and `picker.ts` own binding and
cursor lifetimes. `mutation.ts` owns the common single-use capability machinery but no resource
semantics. The six resource modules own validation, request planning, guard comparison, exact request
construction, normalization, and workflow-specific action constructors.

## Task 1: Define Closed Action, Picker, And Capability Contracts

**Files:**

- Create: `src/handlers/identity/actions/types.ts`
- Create: `src/handlers/identity/actions/types.test.ts`
- Create: `test/compile/identity-actions.ts`
- Create: `test/compile/identity-prepared-mutations.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write compile-time substitution tests**

The positive fixtures instantiate every workflow from `IDENTITY_WORKFLOWS`. Negative fixtures use
`// @ts-expect-error` independently for a foreign workflow, intent, DTO, policy, review, binding
factory, prepared capability, replacement, and query/list action. They must also prove that
`PreparedMutation` has no public `commit` member and `ReplacementPreparation` has no commit hook.

```ts
declare const oauthGet: IdentityQueryAction<IdentityWorkflowId<"oauth2.get">>;
declare const paymentGet: IdentityQueryAction<IdentityWorkflowId<"payment.get">>;
declare const oauthUpdate: PreparedMutation<IdentityWorkflowId<"oauth2.update">>;
declare const replacement: ReplacementPreparation<IdentityWorkflowId<"oauth2.update">>;

// @ts-expect-error workflow brands prevent structurally equal action substitution
const wrongQuery: typeof oauthGet = paymentGet;
// @ts-expect-error presentation cannot invoke a prepared capability directly
oauthUpdate.commit;
// @ts-expect-error an unbound replacement cannot commit
replacement.commit;
```

- [ ] **Step 2: Verify the compile fixtures fail**

```bash
bun test src/handlers/identity/actions/types.test.ts
bun run verify:tsc
```

Expected: module-not-found failures for the action contracts.

- [ ] **Step 3: Implement the exact public contracts**

Define the design unions without SDK outputs or rejecting promises:

```ts
export type QueryOutcome<W extends QueryWorkflowId> =
  | Readonly<{ kind: "succeeded"; value: SafeIdentityDocument<W> }>
  | QueryFailure;

export interface IdentityQueryAction<W extends QueryWorkflowId> extends WorkflowBranded<W> {
  execute(
    input: Readonly<WorkflowIntentOf<W>>,
    options?: IdentityCallOptions,
  ): Promise<QueryOutcome<W>>;
}

export interface IdentityListQueryAction<
  W extends IdentityListWorkflowId,
> extends IdentityQueryAction<W> {
  openPicker(input: Readonly<IdentityPickerIntent<W>>): IdentityPickerSession<W>;
}

export interface IdentityMutationAction<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  prepare(
    input: Readonly<WorkflowIntentOf<W>>,
    secrets: CommitSecretContext,
    options?: IdentityCallOptions,
  ): Promise<PrepareOutcome<W>>;
}

export interface PreparedMutation<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly review: IdentityReviewModel<W>;
  dispose(): void;
}

export interface ReplacementPreparation<
  W extends RepreparableWorkflowId,
> extends WorkflowBranded<W> {
  readonly review: IdentityReviewModel<W>;
  bindContext(secrets: CommitSecretContext): BindReplacementOutcome<W>;
  dispose(): void;
}
```

Keep `PREPARED_MUTATION_COMMIT`, capability constructors, action constructors, binding aliases, and
secret-context coordinator hooks private to the action composition boundary. Export the complete
`QueryFailure`, `PrepareFailure`, `CommitOutcome`, `CommitAttempt`, picker page/session, and
conditional policy-derived unions exactly as defined by the design.

- [ ] **Step 4: Verify action ownership types**

```bash
bun test src/handlers/identity/actions/types.test.ts
bun run verify:tsc
```

Expected: runtime shape tests and all positive/negative compile fixtures pass.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/actions/types.ts src/handlers/identity/actions/types.test.ts test/compile/identity-actions.ts test/compile/identity-prepared-mutations.ts tsconfig.json
git commit -m "feat(identity): define application action contracts"
```

## Task 2: Implement Total Query And List-All Actions

**Files:**

- Create: `src/handlers/identity/actions/query.ts`
- Create: `src/handlers/identity/actions/query.test.ts`
- Modify: `src/handlers/identity/actions/types.ts`

- [ ] **Step 1: Write the binding-lifetime and outcome matrix**

For all ordinary read, resolved-read, and list workflows, test:

- validation failure before factory creation;
- every `BindingCreationOutcome`;
- success and operation-specific V1 normalization;
- not found, cancellation, compatibility, credential refresh, service failure, and internal failure;
- synchronous factory, binding, normalizer, or serializer throws mapped to static `internalFailed`;
- one-page list preserving an encoded token;
- `--all` concatenation with no token;
- cycle, page, item, accepted-wire-byte, and exact output-byte boundaries;
- no partial result after any aggregate failure;
- cursor and binding disposal exactly once in every branch.

```ts
test("disposes a created binding after a normalized query", async () => {
  const fixture = queryFixture("apiKey.get");
  const outcome = await fixture.action.execute({ name: "provider" });

  expect(outcome.kind).toBe("succeeded");
  expect(fixture.binding.disposeCalls).toBe(1);
});

test("returns no partial list when page 1001 would be required", async () => {
  const fixture = listFixture("oauth2.list", { pages: 1000, terminalToken: "more" });
  const outcome = await fixture.action.execute({ all: true, maxResults: 10 });

  expect(outcome).toEqual({ kind: "paginationFailed", reason: "pageLimit" });
  expect(fixture.normalizedPartialDocuments).toHaveLength(0);
});
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/actions/query.test.ts
```

- [ ] **Step 3: Implement resource-neutral lifetime mechanics**

Implement module-private mechanics whose workflow determines the exact facet:

```ts
interface QueryActionInternals<W extends QueryWorkflowId> {
  readonly workflowId: W;
  readonly factory: IdentityBindingFactory<W>;
  readonly validate: (
    input: Readonly<WorkflowIntentOf<W>>,
  ) => ValidationOutcome<Readonly<OperationInput<PrimaryOperationOf<W>>>>;
  readonly normalize: (output: OperationOutput<PrimaryOperationOf<W>>) => NormalizeOutcome<W>;
}

function defineQueryAction<W extends QueryWorkflowId>(
  internals: QueryActionInternals<W>,
): IdentityQueryAction<W>;
```

Neither `QueryActionInternals` nor `defineQueryAction` is exported. Each resource module exposes only
its exact workflow-specific action set to the feature composition root; there is no public generic
action-constructor extension point.

The implementation must:

1. validate before creating a binding;
2. exhaustively translate binding creation;
3. move only `created.binding` into one `try/finally`;
4. call only the facet method derived from `W`;
5. normalize before returning;
6. map an unexpected rejection to static `internalFailed`;
7. dispose once in `finally`.

Implement list page/all traversal with the design constants:

```ts
export const MAX_IDENTITY_ALL_PAGES = 1_000 as const;
export const MAX_IDENTITY_ALL_ITEMS = 10_000 as const;
export const MAX_IDENTITY_ALL_WIRE_BYTES = 16_777_216 as const;
export const MAX_IDENTITY_ALL_OUTPUT_BYTES = 16_777_216 as const;
```

Apply limit checks in cycle, page, item, wire-byte, output-byte order. The final output-byte count uses
the same one-document V1 serializer Commander will use.

- [ ] **Step 4: Verify all query workflows**

```bash
bun test src/handlers/identity/actions/query.test.ts src/core/identity/paginator.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/actions/query.ts src/handlers/identity/actions/query.test.ts src/handlers/identity/actions/types.ts
git commit -m "feat(identity): add total query and list actions"
```

## Task 3: Implement Opaque Bounded Picker Sessions

**Files:**

- Create: `src/handlers/identity/actions/picker.ts`
- Create: `src/handlers/identity/actions/picker.test.ts`
- Modify: `src/handlers/identity/actions/query.ts`

- [ ] **Step 1: Write the picker state-machine tests**

Test the exact state sequence:

```text
idle -> opening -> open -> terminal
  \       \         \----> disposed
   \------- busy
```

Cover lazy factory/cursor construction, one in-flight `next`, `busy` without state change, frozen
normalized pages, cache lookup for back navigation without SDK work, cycle and all four aggregate
limits, cancellation, service failure, normal completion, explicit disposal, and late construction
completion after disposal.

```ts
test("does not expose a transport token or cursor in a picker page", async () => {
  const session = pickerFixture("workload.list").action.openPicker({ maxResults: 10 });
  const result = await session.next();

  expect(result.kind).toBe("page");
  if (result.kind === "page") {
    expect(Object.keys(result.page).sort()).toEqual(["hasNextPage", "items", "workflowId"]);
    expect(JSON.stringify(result.page)).not.toContain("nextToken");
  }
});
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/actions/picker.test.ts
```

- [ ] **Step 3: Implement the session**

Expose only:

```ts
export interface IdentityPickerSession<
  W extends IdentityListWorkflowId,
> extends WorkflowBranded<W> {
  next(options?: IdentityCallOptions): Promise<IdentityPickerPageOutcome<W>>;
  dispose(): void;
}
```

The private session owns the binding, transport cursor, visited decoded-token set, accepted wire
evidence, counters, token-free serializer state, and frozen page cache. It never returns a token,
cursor, counter, binding, or evidence object. A terminal or disposed session repeats `done` and
performs no work. A differently sized traversal is a new session; resizing presentation state does not
alter an existing session's service page size.

- [ ] **Step 4: Verify picker behavior**

```bash
bun test src/handlers/identity/actions/picker.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/actions/picker.ts src/handlers/identity/actions/picker.test.ts src/handlers/identity/actions/query.ts
git commit -m "feat(identity): add bounded picker sessions"
```

## Task 4: Implement Single-Use Prepared And Replacement Capabilities

**Files:**

- Create: `src/handlers/identity/actions/mutation.ts`
- Create: `src/handlers/identity/actions/mutation.test.ts`
- Modify: `src/handlers/identity/actions/types.ts`
- Modify: `src/runtime/mutation/coordinator.ts`
- Modify: `src/handlers/identity/secrets/context.ts`

- [ ] **Step 1: Write the capability/context/binding ownership matrix**

Cover:

```text
prepared -> committing -> consumed
prepared -> disposed
awaiting-context -> binding -> consumed + new prepared pair
awaiting-context -> disposed
```

Tests must include:

- synchronous context reservation before the first `await`;
- reservation failure creating no binding;
- pair token and ordered-requirement fingerprint mismatch;
- matching unavailable context;
- duplicate and concurrent commit;
- capability dispose racing registered lease commit;
- supervisor `busy` leaving the pair retryable and unchanged;
- settle in `finally` for every activated execution;
- replacement bind success, validation rollback, unexpected terminal rollback, and dispose race;
- exact one-time transfer or destruction of the binding;
- no secret I/O, AWS call, state update, or output for pre-activation rejection or `busy`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/actions/mutation.test.ts
```

- [ ] **Step 3: Implement the private capability coordinator**

`mutation.ts` may export resource-action constructor helpers, but not the commit symbol or state
writers. Its internal constructor accepts one workflow-derived plan:

```ts
interface FrozenPreparedPlan<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly explicitIntent: Readonly<WorkflowIntentOf<W>>;
  readonly effective: EffectiveMutationState<W>;
  readonly requirements: readonly SecretRequirement[];
  readonly review: IdentityReviewModel<W>;
  readonly guard: CommitGuard<W>;
  readonly binding: BindingFor<W>;
  readonly planToken: MutationPlanToken<W>;
}
```

The registered `MutationPresentationActionLease.commit()` performs in one synchronous turn:

1. pair and availability checks;
2. supervisor activation;
3. capability, binding, and context claim;
4. ownership transfer to commit-local leases.

Then it runs the resource-owned commit closure, calls `execution.settle()` in `finally`, and returns a
`CommitAttempt`. It marks `outcomeUnknown` immediately before `binding.mutate()`. Only the binding's
private exact-status evidence may advance certainty to `committed`.

`reprepareRequired` transfers the same binding into an unbound `ReplacementPreparation`. Commander can
dispose it; Ink can render its review, create a fresh context, and call `bindContext()` exactly once.

- [ ] **Step 4: Verify lifecycle and compile boundaries**

```bash
bun test src/handlers/identity/actions/mutation.test.ts src/runtime/mutation/supervisors.test.ts src/handlers/identity/secrets/context.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/actions/mutation.ts src/handlers/identity/actions/mutation.test.ts src/handlers/identity/actions/types.ts src/runtime/mutation/coordinator.ts src/handlers/identity/secrets/context.ts
git commit -m "feat(identity): add one-shot mutation capabilities"
```

## Task 5: Implement API-Key, Workload, And Token-Vault Actions

**Files:**

- Create: `src/handlers/identity/actions/apiKey.ts`
- Create: `src/handlers/identity/actions/apiKey.test.ts`
- Create: `src/handlers/identity/actions/workload.ts`
- Create: `src/handlers/identity/actions/workload.test.ts`
- Create: `src/handlers/identity/actions/tokenVault.ts`
- Create: `src/handlers/identity/actions/tokenVault.test.ts`

- [ ] **Step 1: Write resource action matrices**

API-key tests cover managed/external Create, same-mode rotation, source-switch rejection, exact Get/
List/Delete behavior, fresh target identity before Delete, secret-only rotation, no duplicate mutation,
and every guard/reprepare branch.

Workload tests cover Create with zero through five URLs, complete replacement, explicit empty clear,
semantic no-op, duplicate/sixth URL rejection, name-reuse continuity, and two-Get commit rebasing.

Token-vault tests cover default vault ID, customer/service-managed validation, key ARN restrictions,
semantic no-op, `lastModifiedDate` guard change, reprepare, and exactly one `SetTokenVaultCMK`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/actions/apiKey.test.ts src/handlers/identity/actions/workload.test.ts src/handlers/identity/actions/tokenVault.test.ts
```

- [ ] **Step 3: Implement resource-specific constructors**

Expose exact constructors that accept only their branded factories:

```ts
export function createApiKeyActions(dependencies: ApiKeyActionDependencies): ApiKeyActions;

export function createWorkloadActions(dependencies: WorkloadActionDependencies): WorkloadActions;

export function createTokenVaultActions(
  dependencies: TokenVaultActionDependencies,
): TokenVaultActions;
```

Each update commit performs: fresh read, support/status check, rebase, no-change check, first guard
comparison, secret acquisition when required, credential check, second fresh read, second rebase and
guard comparison, exact request build/validation, one mutation send, normalization, and lease disposal.
Delete performs a final Get and target continuity check before one Delete. Creates perform no Get.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/actions/apiKey.test.ts src/handlers/identity/actions/workload.test.ts src/handlers/identity/actions/tokenVault.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/actions/apiKey.ts src/handlers/identity/actions/apiKey.test.ts src/handlers/identity/actions/workload.ts src/handlers/identity/actions/workload.test.ts src/handlers/identity/actions/tokenVault.ts src/handlers/identity/actions/tokenVault.test.ts
git commit -m "feat(identity): add api key workload and vault actions"
```

## Task 6: Implement OAuth And Payment Replacement Actions

**Files:**

- Create: `src/handlers/identity/actions/oauth2.ts`
- Create: `src/handlers/identity/actions/oauth2.test.ts`
- Create: `src/handlers/identity/actions/payment.ts`
- Create: `src/handlers/identity/actions/payment.test.ts`

- [ ] **Step 1: Write exhaustive compatibility-guarded matrices**

OAuth tests cover all 25 Create descriptors, all supported authentication transitions, Microsoft
tenant recovery/reset, legacy/preferred mechanism replacement, unknown vendor/union/status, managed
secret re-entry, preserved EXTERNAL references, secret removal only under explicit valid intent,
private endpoint retention restrictions, additive raw-wire rejection on all three Gets, first/second
guard change, no-change, and reprepare.

Payment tests cover both vendors, all four slots, mixed managed/external modes, every same-mode
rotation, both source-switch directions, unknown source, managed re-entry for unchanged slots,
identifier-only updates, additive raw-wire rejection, first/second guard change, and complete
replacement requests.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/actions/oauth2.test.ts src/handlers/identity/actions/payment.test.ts
```

- [ ] **Step 3: Implement guarded resource actions**

Use only `IdentityCompatibilityGuardedUpdateBinding` for OAuth/payment Update. Ordinary Get actions
continue through tolerant read factories. Update preparation and both commit reads call only
`readCompatibilityGuardedCurrent`.

The resource modules call the plan 02 planners and builders directly. They do not use a generic deep
merge or generic mutation engine. They preserve the original explicit intent in the frozen plan and
derive a replacement from each fresh guarded state.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/actions/oauth2.test.ts src/handlers/identity/actions/payment.test.ts src/core/identity/rawWire.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/actions/oauth2.ts src/handlers/identity/actions/oauth2.test.ts src/handlers/identity/actions/payment.ts src/handlers/identity/actions/payment.test.ts
git commit -m "feat(identity): add guarded oauth and payment actions"
```

## Task 7: Implement Name-Resolved And Direct-ARN Tag Actions

**Files:**

- Create: `src/handlers/identity/actions/tags.ts`
- Create: `src/handlers/identity/actions/tags.test.ts`
- Modify: `src/handlers/identity/actions/apiKey.ts`
- Modify: `src/handlers/identity/actions/oauth2.ts`
- Modify: `src/handlers/identity/actions/payment.ts`
- Modify: `src/handlers/identity/actions/workload.ts`

- [ ] **Step 1: Write all 24 workflow tests**

For each family, test name and resource-ARN variants of Tag, Untag, and List Tags. Assert:

- selector parsing occurs before action selection;
- direct ARN validates family and resolved region and issues no Get or STS;
- name List Tags resolves once and reads tags;
- name Tag/Untag prepare records target identity and commit re-runs Get;
- recreated or missing targets return the exact closed outcome without mutation;
- direct Tag/Untag sends exactly once;
- map and key limits survive `__proto__` and `constructor`;
- List Tags normalizes absent tags to `{ "tags": {} }`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/actions/tags.test.ts
```

- [ ] **Step 3: Implement selector-specific constructors**

Create separate branded actions per selector. No action accepts
`{ name?: string; resourceArn?: string }`:

```ts
export interface IdentityTagActions<F extends IdentityCrudFamily> {
  readonly tagByName: IdentityMutationAction<IdentityWorkflowId<`${F}.tag.name`>>;
  readonly tagByArn: IdentityMutationAction<IdentityWorkflowId<`${F}.tag.resourceArn`>>;
  readonly untagByName: IdentityMutationAction<IdentityWorkflowId<`${F}.untag.name`>>;
  readonly untagByArn: IdentityMutationAction<IdentityWorkflowId<`${F}.untag.resourceArn`>>;
  readonly listTagsByName: IdentityQueryAction<IdentityWorkflowId<`${F}.listTags.name`>>;
  readonly listTagsByArn: IdentityQueryAction<IdentityWorkflowId<`${F}.listTags.resourceArn`>>;
}
```

Name-selected mutations use `currentStateMutation/continuityGuarded`; direct ARN mutations use
`directMutation/direct`; name List Tags uses `resolvedRead`; direct ARN List Tags uses `read`.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/actions/tags.test.ts src/handlers/identity/domain/arn.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/actions/tags.ts src/handlers/identity/actions/tags.test.ts src/handlers/identity/actions/apiKey.ts src/handlers/identity/actions/oauth2.ts src/handlers/identity/actions/payment.ts src/handlers/identity/actions/workload.ts
git commit -m "feat(identity): add complete tag lifecycle actions"
```

## Task 8: Prove Exhaustive Workflow Construction And Action Safety

**Files:**

- Create: `src/handlers/identity/composition.ts`
- Create: `src/handlers/identity/composition.test.ts`
- Modify: `src/handlers/identity/actions/types.test.ts`
- Modify: `test/compile/identity-actions.ts`
- Test: `src/handlers/identity/actions/`

- [ ] **Step 1: Add the 46-row construction audit**

Define a separate action catalog; `IDENTITY_WORKFLOWS` remains the plan 02 workflow-definition registry:

```ts
export type IdentityActionFor<W extends IdentityWorkflowId> = W extends IdentityListWorkflowId
  ? IdentityListQueryAction<W>
  : W extends QueryWorkflowId
    ? IdentityQueryAction<W>
    : W extends MutationWorkflowId
      ? IdentityMutationAction<W>
      : never;

export type IdentityActionCatalog = Readonly<{
  [K in IdentityWorkflowName]: IdentityActionFor<IdentityWorkflowId<K>>;
}>;

export type IdentityBindingFactoryCatalog = Readonly<{
  [K in IdentityWorkflowName]: IdentityBindingFactory<IdentityWorkflowId<K>>;
}>;
```

`createIdentityActionCatalog(...)` constructs the six resource-specific exact action sets and returns
this literal object, checked with `satisfies IdentityActionCatalog`:

```ts
return {
  "apiKey.create": apiKey.create,
  "apiKey.get": apiKey.get,
  "apiKey.list": apiKey.list,
  "apiKey.update": apiKey.update,
  "apiKey.delete": apiKey.delete,
  "oauth2.create": oauth2.create,
  "oauth2.get": oauth2.get,
  "oauth2.list": oauth2.list,
  "oauth2.update": oauth2.update,
  "oauth2.delete": oauth2.delete,
  "payment.create": payment.create,
  "payment.get": payment.get,
  "payment.list": payment.list,
  "payment.update": payment.update,
  "payment.delete": payment.delete,
  "workload.create": workload.create,
  "workload.get": workload.get,
  "workload.list": workload.list,
  "workload.update": workload.update,
  "workload.delete": workload.delete,
  "tokenVault.get": tokenVault.get,
  "tokenVault.setCmk": tokenVault.setCmk,
  "apiKey.tag.name": tags.apiKey.tagByName,
  "apiKey.tag.resourceArn": tags.apiKey.tagByArn,
  "apiKey.untag.name": tags.apiKey.untagByName,
  "apiKey.untag.resourceArn": tags.apiKey.untagByArn,
  "apiKey.listTags.name": tags.apiKey.listTagsByName,
  "apiKey.listTags.resourceArn": tags.apiKey.listTagsByArn,
  "oauth2.tag.name": tags.oauth2.tagByName,
  "oauth2.tag.resourceArn": tags.oauth2.tagByArn,
  "oauth2.untag.name": tags.oauth2.untagByName,
  "oauth2.untag.resourceArn": tags.oauth2.untagByArn,
  "oauth2.listTags.name": tags.oauth2.listTagsByName,
  "oauth2.listTags.resourceArn": tags.oauth2.listTagsByArn,
  "payment.tag.name": tags.payment.tagByName,
  "payment.tag.resourceArn": tags.payment.tagByArn,
  "payment.untag.name": tags.payment.untagByName,
  "payment.untag.resourceArn": tags.payment.untagByArn,
  "payment.listTags.name": tags.payment.listTagsByName,
  "payment.listTags.resourceArn": tags.payment.listTagsByArn,
  "workload.tag.name": tags.workload.tagByName,
  "workload.tag.resourceArn": tags.workload.tagByArn,
  "workload.untag.name": tags.workload.untagByName,
  "workload.untag.resourceArn": tags.workload.untagByArn,
  "workload.listTags.name": tags.workload.listTagsByName,
  "workload.listTags.resourceArn": tags.workload.listTagsByArn,
} satisfies IdentityActionCatalog;
```

Do not build this record with a loop, wildcard, cast, or independently supplied operation/policy.
Assert exactly 17 query and 29 mutation actions. Verify every action's workflow, operation, auxiliary
Get, facet, policy, intent, and DTO derive from its one workflow key. Scan every
plan/review/error/result recursively for sentinel secret values and reject any raw SDK output or
`Error`.

- [ ] **Step 2: Run the complete action gate**

```bash
bun test src/handlers/identity/actions src/handlers/identity/composition.test.ts src/handlers/identity/domain src/handlers/identity/secrets src/core/identity src/runtime/mutation
bun run build
bun run verify:tsc
bun run format:check
git diff --check
```

Expected: all action, dependency, compile, build, format, and diagnostic checks pass.

- [ ] **Step 3: Commit**

```bash
git add src/handlers/identity/actions src/handlers/identity/composition.ts src/handlers/identity/composition.test.ts test/compile/identity-actions.ts
git commit -m "feat(identity): compose the exhaustive action catalog"
```

- [ ] **Step 4: Run independent Codex reviews**

Run one `openai.gpt-5.6-sol` spec-compliance review and one separate code-quality/security review
against the exact base/head SHAs. Require explicit coverage of binding disposal, pair ownership,
secret timing, two-Get rebasing, mutation certainty, list limits, and all 46 workflows. Fix every valid
finding and repeat until both reports end in `VERDICT: PASS`.

- [ ] **Step 5: Push**

```bash
git push origin feat/identity-cli
```
