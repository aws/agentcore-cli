# Identity Ink TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete Harness-style Ink experience for every Identity command, including paged selection, curated forms, redacted review, confirmation, reprepare, hidden secret entry, safe results, and correlated mutation-frame retirement.

**Architecture:** One feature-owned route registry mounts every Identity route and is parity-checked against the Commander registry. Screens consume only workflow-branded actions, hook state, reviews, safe documents, and diagnostics; lifecycle hooks own picker sessions and mutation capabilities while all provider policy, replacement logic, transport pagination, and mutation certainty remain outside React.

**Tech Stack:** Ink 7.1.0, React 19.2.7, React Router 8.1.0, action-owned lifecycle hooks, ink-testing-library, deterministic action fakes, direct TUI Harness MCP verification.

---

## File Structure

```text
src/handlers/identity/
|-- screen.tsx
|-- routes.tsx
|-- routes.test.tsx
|-- IdentityErrorBoundary.tsx
|-- hooks/
|   |-- useIdentityQuery.tsx
|   |-- useIdentityPicker.tsx
|   |-- useIdentityMutation.tsx
|   `-- useHiddenSecretPrompt.tsx
|-- components/
|   |-- IdentityPicker.tsx
|   |-- IdentityResult.tsx
|   |-- MutationReview.tsx
|   |-- SecretInput.tsx
|   |-- StringListEditor.tsx
|   `-- IdentityTextInput.tsx
|-- oauth2-provider/{create,get,list,update,delete,tag,untag,list-tags}/screen.tsx
|-- api-key-provider/{create,get,list,update,delete,tag,untag,list-tags}/screen.tsx
|-- payment-provider/{create,get,list,update,delete,tag,untag,list-tags}/screen.tsx
|-- workload-identity/{create,get,list,update,delete,tag,untag,list-tags}/screen.tsx
`-- token-vault/{get,set-cmk}/screen.tsx

src/runtime/output/inkOutput.ts
src/testing/TestIdentityRuntime.tsx
test/tui/identity-driver.tsx
```

Each hook, component, boundary, and interactive directory owns a focused adjacent test. Shared
presentation code does not know SDK types, Core clients, continuation tokens, or resource-specific
update rules.

## Task 1: Create One Identity Route Registry And Root Mount

**Files:**

- Create: `src/handlers/identity/routes.tsx`
- Create: `src/handlers/identity/routes.test.tsx`
- Create: `src/handlers/identity/screen.tsx`
- Modify: `src/components/Root.tsx`
- Modify: `src/handlers/types.tsx`
- Modify: `src/handlers/identity/types.ts`
- Modify: `src/handlers/identity/composition.ts`
- Modify: `src/testing/renderScreen.tsx`
- Modify: `src/testing/index.tsx`
- Create: `src/testing/TestIdentityRuntime.tsx`

- [ ] **Step 1: Write route/Commander parity tests**

Assert six menu routes and exactly 34 static leaf routes. Every `IDENTITY_COMMAND_REGISTRY` row has one
screen and no route is orphaned. Tag/Untag/List Tags inherit both ordered workflow IDs from the neutral
Commander registry. Target selection, selector mode, and wizard phase remain component state; dynamic
name, ARN, and detail routes are forbidden.

```ts
expect(identityRouteRegistry.map((route) => route.commandPath).sort()).toEqual(
  IDENTITY_COMMAND_REGISTRY.map((command) => command.path).sort(),
);

for (const command of IDENTITY_COMMAND_REGISTRY) {
  const route = identityRouteRegistry.find((candidate) => candidate.commandPath === command.path);
  expect(route?.workflows).toEqual(command.workflows);
}

expect(identityMenuRoutes).toHaveLength(6);
expect(identityRouteRegistry).toHaveLength(34);
```

Mount every static route through the real `Root` and assert it does not reach `HelpScreen`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/routes.test.tsx src/handlers/root.test.tsx
```

- [ ] **Step 3: Implement the registry**

Define:

```tsx
export interface IdentityInteractiveRoute<P extends IdentityCommandPath> {
  readonly commandPath: P;
  readonly routePath: string;
  readonly workflows: IdentityCommandWorkflows<P>;
  readonly element: (props: ScreenProps) => ReactElement;
}

type IdentityScreenMap = Readonly<{
  [P in IdentityCommandPath]: (props: ScreenProps) => ReactElement;
}>;

export const IDENTITY_ROUTE_REGISTRY = compileIdentityRoutes(
  IDENTITY_COMMAND_REGISTRY,
  IDENTITY_SCREEN_MAP satisfies IdentityScreenMap,
);
```

The explicit screen map supplies no workflow tuple of its own. The compiler inherits each tuple from
the neutral command registry and rejects duplicate command paths, duplicate route paths, missing
screens, extra screens, or a missing workflow brand. `Root.tsx` imports and mounts the compiled feature
manifest once; it does not add 34 hand-written Identity `<Route>` nodes.

- [ ] **Step 4: Implement Identity resource navigation**

`IdentityScreen` uses the compiled Commander tree through the existing `RouterScreen` behavior and
shows the four resource families plus token vault. Payment is always present with a visible `Preview`
label. The resource signal and commands must fit within the existing terminal layout without nested
panels.

- [ ] **Step 5: Verify**

```bash
bun test src/handlers/identity/routes.test.tsx src/handlers/root.test.tsx src/testing/TestIdentityRuntime.test.tsx
bun run verify:tsc
```

- [ ] **Step 6: Commit**

```bash
git add src/handlers/identity/routes.tsx src/handlers/identity/routes.test.tsx src/handlers/identity/screen.tsx src/handlers/identity/types.ts src/handlers/identity/composition.ts src/components/Root.tsx src/handlers/types.tsx src/testing/renderScreen.tsx src/testing/index.tsx src/testing/TestIdentityRuntime.tsx src/testing/TestIdentityRuntime.test.tsx
git commit -m "feat(identity): add one ink route registry"
```

## Task 2: Implement Correlated Ink Output And Error Containment

**Files:**

- Create: `src/runtime/output/inkOutput.ts`
- Create: `src/runtime/output/inkOutput.test.tsx`
- Modify: `src/handlers/identity/composition.ts`
- Modify: `src/tui/index.tsx`
- Modify: `src/components/Root.tsx`
- Create: `src/handlers/identity/IdentityErrorBoundary.tsx`
- Create: `src/handlers/identity/IdentityErrorBoundary.test.tsx`

- [ ] **Step 1: Write frame-epoch and failure tests**

Exercise:

- one Commander-independent Ink presentation begin;
- finite frame epoch opening;
- render-generation commit evidence;
- callback/drain quiescence through the captured accepted-write high-water mark;
- later animation writes excluded from the epoch;
- frame flush retirement while `waitUntilExit()` remains pending;
- exit fallback after unmount/output failure;
- stale, duplicate, foreign, cross-kind, and cross-execution receipts;
- sequential mutations with isolated certainty;
- output/render/state failure at `none`, `outcomeUnknown`, and `committed`.

- [ ] **Step 2: Write async error-boundary tests**

Throw sentinel-bearing values from render, query callbacks, submit callbacks, hidden prompts, and
state continuations. Assert only closed diagnostics enter state or output. React's boundary catches
render failures; every async callback catches at its observation point.

- [ ] **Step 3: Verify the tests fail**

```bash
bun test src/runtime/output/inkOutput.test.tsx src/handlers/identity/IdentityErrorBoundary.test.tsx
```

- [ ] **Step 4: Implement the typed Ink facade**

Expose:

```ts
export interface IdentityInkMutationController {
  register<W extends MutationWorkflowId>(
    mutation: PreparedMutation<W>,
  ): MutationPresentationActionRegistration<W>;
  begin<W extends MutationWorkflowId>(
    execution: SettledMutationExecution<W>,
  ): MutationPresentationBeginOutcome<W, "ink">;
  openFrame<W extends MutationWorkflowId>(
    presentation: PresentingMutationExecution<W, "ink">,
  ): InkFrameEpoch<W>;
  flushFrame<W extends MutationWorkflowId>(
    epoch: InkFrameEpoch<W>,
    generationCommitted: Promise<InkFrameCommitEvidence<W>>,
  ): Promise<InkFrameFlushOutcome<W>>;
  finish<W extends MutationWorkflowId>(
    receipt: MutationPresentationReceipt<W>,
  ): MutationPresentationFinishOutcome;
}
```

All receipt/evidence constructors remain private. On output failure while an action is active, abort
that action, wait for the same action to settle, then classify its final monotonic certainty. Do not
replace an existing screen with a foreign `busy` result.

- [ ] **Step 5: Verify**

```bash
bun test src/runtime/output/inkOutput.test.tsx src/handlers/identity/IdentityErrorBoundary.test.tsx src/runtime/mutation
bun run verify:tsc
```

- [ ] **Step 6: Commit**

```bash
git add src/runtime/output/inkOutput.ts src/runtime/output/inkOutput.test.tsx src/handlers/identity/composition.ts src/tui/index.tsx src/components/Root.tsx src/handlers/identity/IdentityErrorBoundary.tsx src/handlers/identity/IdentityErrorBoundary.test.tsx
git commit -m "feat(identity): add correlated ink mutation output"
```

## Task 3: Implement Action-Only Identity Lifecycle Hooks

**Files:**

- Create: `src/handlers/identity/hooks/useIdentityQuery.tsx`
- Create: `src/handlers/identity/hooks/useIdentityQuery.test.tsx`
- Create: `src/handlers/identity/hooks/useIdentityPicker.tsx`
- Create: `src/handlers/identity/hooks/useIdentityPicker.test.tsx`
- Create: `src/handlers/identity/hooks/useIdentityMutation.tsx`
- Create: `src/handlers/identity/hooks/useIdentityMutation.test.tsx`
- Create: `src/handlers/identity/hooks/useHiddenSecretPrompt.tsx`
- Create: `src/handlers/identity/hooks/useHiddenSecretPrompt.test.tsx`
- Modify: `src/handlers/identity/composition.ts`

- [ ] **Step 1: Write lifecycle ownership tests**

`useIdentityQuery` owns one generation and `AbortController`; cancellation, replacement input, unmount,
late completion, action rejection, and state-update failure leave only a closed action outcome in
state.

`useIdentityPicker` synchronously creates one opaque session only when traversal begins, keeps a frozen
page cache and fixed service page size, rejects concurrent `next()` as `busy`, reads Back from cache,
does not reset traversal on terminal resize, and disposes the session exactly once on every terminal
outcome, cancellation, replacement, and unmount.

`useIdentityMutation` owns extracted selections, context, prepared capability, action registration,
replacement, and generation in refs. Tests cover synchronous submit latching, review, confirmation,
serialized hidden prompts, commit, `busy`, every closed failure, `reprepareRequired`, fresh context
binding, stale completion, repeated/buffered submit, cancellation, and exact disposal.

`useHiddenSecretPrompt` serializes masked requests, returns one bounded prompt outcome at a time, and
clears the entered value immediately after transfer or cancellation.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/hooks
```

- [ ] **Step 3: Implement closed hook state**

The hooks expose only these presentation states:

```ts
export type IdentityQueryState<W extends QueryWorkflowId> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "settled"; outcome: QueryOutcome<W> }>;

export type IdentityPickerState<W extends IdentityListWorkflowId> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading"; pages: readonly IdentityPickerPage<W>[] }>
  | Readonly<{
      kind: "ready";
      pages: readonly IdentityPickerPage<W>[];
      pageIndex: number;
    }>
  | Readonly<{
      kind: "settled";
      pages: readonly IdentityPickerPage<W>[];
      outcome: Exclude<IdentityPickerPageOutcome<W>, { kind: "page" }>;
    }>;

export type IdentityMutationViewState<W extends MutationWorkflowId> =
  | Readonly<{ kind: "editing" }>
  | Readonly<{ kind: "preparing" }>
  | Readonly<{ kind: "review"; review: IdentityReviewModel<W> }>
  | Readonly<{ kind: "prompting"; review: IdentityReviewModel<W> }>
  | Readonly<{ kind: "committing"; review: IdentityReviewModel<W> }>
  | Readonly<{
      kind: "replacementReview";
      review: IdentityReviewModel<Extract<W, RepreparableWorkflowId>>;
    }>
  | Readonly<{
      kind: "settled";
      result:
        | Readonly<{ kind: "succeeded"; value: SafeIdentityDocument<W> }>
        | Readonly<{ kind: "failed"; diagnostic: IdentityDiagnostic }>;
    }>;
```

No hook imports TanStack Query, a Core client, SDK types, transport cursors, continuation tokens,
request builders, or certainty writers. Every async continuation catches `unknown` at its observation
point and maps it to the static internal diagnostic before updating state.

- [ ] **Step 4: Verify and commit**

```bash
bun test src/handlers/identity/hooks
bun run verify:tsc
git diff --check
git add src/handlers/identity/hooks src/handlers/identity/composition.ts
git commit -m "feat(identity): add ink identity lifecycle hooks"
```

## Task 4: Build Shared Identity Presentation Components

**Files:**

- Create: `src/handlers/identity/components/IdentityPicker.tsx`
- Create: `src/handlers/identity/components/IdentityPicker.test.tsx`
- Create: `src/handlers/identity/components/IdentityResult.tsx`
- Create: `src/handlers/identity/components/IdentityResult.test.tsx`
- Create: `src/handlers/identity/components/MutationReview.tsx`
- Create: `src/handlers/identity/components/MutationReview.test.tsx`
- Create: `src/handlers/identity/components/SecretInput.tsx`
- Create: `src/handlers/identity/components/SecretInput.test.tsx`
- Create: `src/handlers/identity/components/StringListEditor.tsx`
- Create: `src/handlers/identity/components/StringListEditor.test.tsx`
- Create: `src/handlers/identity/components/IdentityTextInput.tsx`
- Create: `src/handlers/identity/components/IdentityTextInput.test.tsx`

- [ ] **Step 1: Write component contract tests**

`IdentityPicker` tests prove the component sees only frozen `IdentityPickerPage` values and hook-owned
navigation commands. It never receives a session, binding, transport cursor, counter, continuation
token, Core client, or SDK type.

`MutationReview` renders every review change and requirement with terminal-safe strings and no secret
bytes. `SecretInput` uses masked entry, never stores a raw `Error`, and returns only one
`SecretSourceSelection` or cancellation. `StringListEditor` supports add/remove/reorder/clear without
duplicate entries. `IdentityTextInput` displays terminal-safe encoded text while preserving the
original value for domain validation; backslashes, controls, ANSI/OSC, bidi characters, and unpaired
surrogates remain visibly distinct.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/components
```

- [ ] **Step 3: Implement stable component APIs**

```tsx
export interface IdentityPickerProps<W extends IdentityListWorkflowId> {
  readonly pages: readonly IdentityPickerPage<W>[];
  readonly pageIndex: number;
  readonly loading: boolean;
  readonly canLoadNext: boolean;
  readonly onNext: () => void;
  readonly onBack: () => void;
  readonly onSelect: (item: DeepReadonly<IdentityPickerItemMap[W["key"]]>) => void;
  readonly onCancel: () => void;
}

export interface MutationReviewProps<W extends MutationWorkflowId> {
  readonly review: IdentityReviewModel<W>;
  readonly previewLabel?: "Preview";
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export interface IdentityResultProps<W extends IdentityWorkflowId> {
  readonly document?: SafeIdentityDocument<W>;
  readonly diagnostic?: IdentityDiagnostic;
  readonly onDone: () => void;
}
```

Use existing UI primitives and keyboard conventions. Keep dimensions stable for picker tables, review
rows, field controls, and status lines. Dynamic values cross only the terminal-safe domain encoder.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/components
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/components
git commit -m "feat(identity): add shared ink identity controls"
```

## Task 5: Implement Query, Picker, And Tag-Read Screens

**Files:**

- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/get/screen.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/list/screen.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/list-tags/screen.tsx`
- Create: focused `*.screen.test.tsx` beside each screen

- [ ] **Step 1: Write complete query-screen tests**

For all four families, cover:

- loading, empty, page, detail, not-found, service, compatibility, cancellation, and internal states;
- forward page and cached Back behavior;
- terminal resize without traversal reset, another AWS call, or session replacement;
- safe unknown vendor/union display;
- OAuth status and static failure guidance;
- OAuth callback URL on Get;
- Payment `Preview`;
- List Tags selector choice between picker/name and direct ARN;
- direct ARN local validation and no Get;
- no raw exception or token in frames.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/*/{get,list,list-tags}/*.screen.test.tsx
```

- [ ] **Step 3: Implement query screens**

Use only `useIdentityQuery` and `useIdentityPicker` over actions from the injected Identity composition.
Target selection and detail display remain state inside the static leaf screen. No Identity screen
imports TanStack Query, Core, an SDK type, or an `IdentityPickerSession`; the hooks own lifecycle and
disposal.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/*/{get,list,list-tags}/*.screen.test.tsx
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/oauth2-provider/get src/handlers/identity/oauth2-provider/list src/handlers/identity/oauth2-provider/list-tags src/handlers/identity/api-key-provider/get src/handlers/identity/api-key-provider/list src/handlers/identity/api-key-provider/list-tags src/handlers/identity/payment-provider/get src/handlers/identity/payment-provider/list src/handlers/identity/payment-provider/list-tags src/handlers/identity/workload-identity/get src/handlers/identity/workload-identity/list src/handlers/identity/workload-identity/list-tags
git commit -m "feat(identity): add ink identity query screens"
```

## Task 6: Implement Create Wizards

**Files:**

- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/create/screen.tsx`
- Create: focused `*.screen.test.tsx` beside each screen

- [ ] **Step 1: Write wizard interaction matrices**

OAuth tests cover all family-driven field sets, Microsoft-only optional tenant, complete custom
discovery choices, preferred/legacy conflicts, OBO/private endpoint JSON entry, managed/external
storage, raw JSON mode, and callback URL result display.

API-key tests cover managed hidden entry and external reference. Payment tests cover both vendors,
independent two-slot secret entry, external references, and visible `Preview`. Workload tests cover
zero through five URLs and tags. Every wizard covers Back, cancel, stale async completion, review,
confirmation, secret prompt after the first fresh rebase, success, and all closed failures.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/*/create/*.screen.test.tsx
```

- [ ] **Step 3: Implement create state machines**

Use one explicit generation counter and `AbortController` per preparation. On changed input, navigation,
or unmount:

1. abort the old generation;
2. dispose its selections/context guard;
3. dispose any late prepared pair;
4. ignore its view update.

All screens use `useIdentityMutation`; resource screens supply only parsed presentation input and
render the hook's closed state. The shared state sequence is:

```text
editing -> preparing -> review -> acquiring/committing -> result
   ^          |           |              |
   `----------+-----------+--------------+ closed failure/cancel
```

Review never contains a secret. Hidden prompt acquisition occurs only through the context owned by the
confirmed prepared pair.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/*/create/*.screen.test.tsx
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/oauth2-provider/create src/handlers/identity/api-key-provider/create src/handlers/identity/payment-provider/create src/handlers/identity/workload-identity/create
git commit -m "feat(identity): add ink identity create wizards"
```

## Task 7: Implement Update And Reprepare Flows

**Files:**

- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/update/screen.tsx`
- Create: focused `*.screen.test.tsx` beside each screen

- [ ] **Step 1: Write update interaction matrices**

Cover resource picking, current-state loading, family-specific editing, explicit clears, secret-only
rotation, managed re-entry, preserved external references, no-change, first rebase change before prompt,
second rebase change after prompt, `reprepareRequired`, replacement review, fresh context binding,
missing replacement inventory retry, second confirmation, successful second commit, replacement
dispose on unmount, and repeated-submit suppression.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/*/update/*.screen.test.tsx
```

- [ ] **Step 3: Implement replacement ownership**

When commit returns `reprepareRequired`:

1. install only the unbound replacement and its review;
2. dispose the old context shell;
3. render the new review;
4. require a new explicit confirmation;
5. construct a fresh context for the replacement requirements;
6. call `bindContext`;
7. register and commit the returned fresh pair.

Never loop or auto-authorize. A context inventory validation failure returns to secret entry while the
replacement remains retryable. A foreign/unavailable context changes neither object. Unmount disposes
the unbound replacement.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/*/update/*.screen.test.tsx src/handlers/identity/actions
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/oauth2-provider/update src/handlers/identity/api-key-provider/update src/handlers/identity/payment-provider/update src/handlers/identity/workload-identity/update
git commit -m "feat(identity): add ink guarded update flows"
```

## Task 8: Implement Delete, Tag, And Untag Screens

**Files:**

- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/delete/screen.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/tag/screen.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/untag/screen.tsx`
- Create: focused `*.screen.test.tsx` beside each screen

- [ ] **Step 1: Write destructive/tag interaction tests**

Delete always selects/fetches the target and defaults confirmation to No. Tag/Untag offer resource
picker/name and direct-ARN modes, validate tags/keys, show redacted review, and require confirmation.
Cover target reuse, reprepare, cancel, duplicate input, output failure, and every static diagnostic.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/*/{delete,tag,untag}/*.screen.test.tsx
```

- [ ] **Step 3: Implement screens**

Use `useIdentityPicker`, `useIdentityMutation`, `IdentityPicker`, `MutationReview`, and the exact
selector-specific actions. Do not reuse
Commander consent policy: TUI Delete always confirms. On `reprepareRequired`, use the same unbound
replacement flow from Task 7.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/*/{delete,tag,untag}/*.screen.test.tsx
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/oauth2-provider/delete src/handlers/identity/oauth2-provider/tag src/handlers/identity/oauth2-provider/untag src/handlers/identity/api-key-provider/delete src/handlers/identity/api-key-provider/tag src/handlers/identity/api-key-provider/untag src/handlers/identity/payment-provider/delete src/handlers/identity/payment-provider/tag src/handlers/identity/payment-provider/untag src/handlers/identity/workload-identity/delete src/handlers/identity/workload-identity/tag src/handlers/identity/workload-identity/untag
git commit -m "feat(identity): add ink delete and tagging flows"
```

## Task 9: Implement Token-Vault Inspection And CMK Change

**Files:**

- Create: `src/handlers/identity/token-vault/get/screen.tsx`
- Create: `src/handlers/identity/token-vault/get/get.screen.test.tsx`
- Create: `src/handlers/identity/token-vault/set-cmk/screen.tsx`
- Create: `src/handlers/identity/token-vault/set-cmk/set-cmk.screen.test.tsx`

- [ ] **Step 1: Write token-vault screen tests**

Cover default/custom vault ID, loading, KMS configuration display, key-type segmented choice,
conditional ARN input, invalid aliases/multi-region keys, redacted review, confirmation default No,
no-change, reprepare, cancellation, success, and every safe failure.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/token-vault
```

- [ ] **Step 3: Implement screens**

Set CMK always confirms in Ink. It uses the same prepared/replacement lifecycle and correlated frame
receipt as other mutations. Routine live automation remains absent from this screen and never changes
the singleton vault without the user's direct confirmation.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/token-vault
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/token-vault/get src/handlers/identity/token-vault/set-cmk
git commit -m "feat(identity): add ink token vault workflows"
```

## Task 10: TUI Regression, Harness, And Safety Gate

**Files:**

- Test: all Identity route, component, and screen files
- Test: `src/components/Root.tsx`
- Test: `src/runtime/output/inkOutput.ts`
- Create: `test/tui/identity-driver.tsx`
- Create: `test/tui/identity-driver.test.tsx`
- Modify: `src/testing/TestIdentityRuntime.tsx`

- [ ] **Step 1: Run all screen and route tests**

```bash
bun test src/handlers/identity src/components src/runtime/output/inkOutput.test.tsx src/tui test/tui/identity-driver.test.tsx
bun run build
bun run verify:tsc
bun run format:check
git diff --check
```

- [ ] **Step 2: Drive representative flows through TUI Harness**

Build `test/tui/identity-driver.tsx` around the real Root and deterministic fake action catalog, with no
AWS client or service access. Use the built driver in a headless PTY and capture screens only on
changes. Exercise at minimum:

- Identity root and each resource menu;
- OAuth named and custom Create;
- OAuth Update with reprepare;
- payment Create and Update with two independent secret slots;
- API-key rotation;
- workload URL editing and clear;
- Delete confirmation;
- name and ARN tag flows;
- token-vault Get and cancelled Set CMK;
- loading, empty, error, cancellation, and success states;
- 80x24 and 120x40 terminals.

Verify no overlapping text, clipped controls, token display, secret echo, unstable dimensions, or
missing route. Directly use the TUI Harness tools; do not invoke a Claude TUI agent.

- [ ] **Step 3: Run independent Codex reviews**

Run separate `openai.gpt-5.6-sol` spec-compliance and UI/code-quality/security reviews. Require explicit
checks for full route coverage, picker ownership, async containment, secret timing, replacement
ownership, confirmation, frame receipts, terminal-safe rendering, and payment preview. Fix and repeat
until both reports end in `VERDICT: PASS`.

- [ ] **Step 4: Push**

```bash
git push origin feat/identity-cli
```
