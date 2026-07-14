# Identity Commander Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount the complete `agentcore identity` command tree with safe typed parsing, all 46 workflow selections, literal-secret compatibility warnings, correlated mutation output, and exactly one normalized JSON document for every successful leaf.

**Architecture:** The Identity router follows the existing Harness layout while deriving workflow ownership from one closed command registry. Leaf handlers perform presentation-only parsing, secret extraction/context creation, action invocation, confirmation where specified, and safe output; all request construction, update semantics, and SDK behavior remain in plans 02-05.

**Tech Stack:** Commander 15.0.0, Zod 4.4.3, TypeScript, awaited output ports, Bun test and subprocess tests.

---

## File Structure

```text
src/handlers/identity/
|-- index.tsx
|-- types.ts
|-- composition.ts
|-- routes.tsx
|-- options.ts
|-- format.ts
|-- interaction.ts
|-- commander.ts
|-- oauth2-provider/{create,get,list,update,delete,tag,untag,list-tags}/index.tsx
|-- api-key-provider/{create,get,list,update,delete,tag,untag,list-tags}/index.tsx
|-- payment-provider/{create,get,list,update,delete,tag,untag,list-tags}/index.tsx
|-- workload-identity/{create,get,list,update,delete,tag,untag,list-tags}/index.tsx
`-- token-vault/{get,set-cmk}/index.tsx

src/runtime/output/commanderOutput.ts
test/subprocess/identity-commander.test.ts
```

Every leaf directory also owns a focused `*.test.tsx`. Screen files are added by plan 07. Shared
handler factories may remove mechanical duplication, but every command remains an explicit registry
row and mount point so route parity and help snapshots can enumerate the public surface.

## Task 1: Correct Bare-Command Detection And Closed Parser Failures

**Files:**

- Modify: `src/middleware/withTuiOnEmptyFlagsAndArgs.tsx`
- Create: `src/middleware/withTuiOnEmptyFlagsAndArgs.test.tsx`
- Modify: `src/router/flags.tsx`
- Modify: `src/router/index.tsx`
- Create: `src/router/safeUsageError.ts`
- Modify: `src/router/router.test.ts`
- Modify: `src/handlers/harness/index.tsx`

- [ ] **Step 1: Write option-source and parser-safety tests**

Compile real commands containing omitted defaulted booleans and assert:

- omitted `--all`, `--yes`, and clear toggles still mount Ink;
- explicitly supplied false/default-equivalent values select Commander;
- global `--region`, `--endpoint-url`, and `--debug` alone do not make a leaf non-bare;
- global `--json` always bypasses Ink;
- any positional or local option selects Commander;
- invalid input containing terminal controls, paths, or sentinel text emits only a static usage error.

```ts
test("does not count a defaulted boolean as supplied", async () => {
  const command = compile(identityLeafWithBoolean(), testContext());
  await command.parseAsync(["node", "agentcore", "identity", "oauth2-provider", "list"]);
  expect(renderTuiCalls).toBe(1);
  expect(handlerCalls).toBe(0);
});
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/middleware/withTuiOnEmptyFlagsAndArgs.test.tsx src/router/router.test.ts
```

- [ ] **Step 3: Implement source-aware routing and closed usage errors**

Use the executing `Command` and its local `options`:

```ts
function hasCliSuppliedLeafOption(command: Command): boolean {
  return command.options.some((option) => {
    const source = command.getOptionValueSource(option.attributeName());
    return source === "cli";
  });
}
```

Do not inspect `optsWithGlobals()` for leaf-specific emptiness. Arguments count only when their parsed
presence makes `command.args.length > 0`. Keep `JsonKey` as the explicit bypass. Update Harness to use
the source-aware middleware contract without changing its existing command behavior.

Replace raw `TypeError` construction with one CLI-owned error:

```ts
export type SafeUsageFailureKind =
  | "missingArgument"
  | "missingOptionValue"
  | "missingRequiredOption"
  | "conflictingOption"
  | "unknownOption"
  | "excessArguments"
  | "unknownCommand"
  | "invalidInput"
  | "internal";

export class SafeUsageError extends Error {
  constructor(readonly kind: SafeUsageFailureKind) {
    super("SafeUsageError");
    this.name = "SafeUsageError";
  }
}
```

The execution policy maps only the error kind or pinned Commander code to static text. It never
interpolates parser messages, option spelling, nested errors, or rejected values.

- [ ] **Step 4: Verify shared behavior**

```bash
bun test src/middleware/withTuiOnEmptyFlagsAndArgs.test.tsx src/router src/handlers/harness/harness.test.tsx
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/middleware/withTuiOnEmptyFlagsAndArgs.tsx src/middleware/withTuiOnEmptyFlagsAndArgs.test.tsx src/router/flags.tsx src/router/index.tsx src/router/safeUsageError.ts src/router/router.test.ts src/handlers/harness/index.tsx
git commit -m "fix: route bare commands by explicit option source"
```

## Task 2: Define The Identity Command Registry And Composition Root

**Files:**

- Create: `src/handlers/identity/types.ts`
- Create: `src/handlers/identity/routes.tsx`
- Create: `src/handlers/identity/routes.test.tsx`
- Modify: `src/handlers/identity/composition.ts`
- Modify: `src/handlers/identity/composition.test.ts`
- Create: `src/handlers/identity/index.tsx`
- Create: `src/handlers/identity/index.test.tsx`
- Modify: `src/handlers/index.tsx`
- Modify: `src/handlers/types.tsx`
- Modify: `src/handlers/root.test.tsx`
- Modify: `src/core/index.tsx`
- Modify: `src/testing/TestCoreClient.tsx`
- Modify: `src/handlers/help.screen.test.tsx`
- Modify: `src/tui/tui.test.tsx`
- Create: `test/compile/identity-command-handlers.ts`

- [ ] **Step 1: Write command-tree and injection tests**

Assert one root `identity` sibling after `harness` and before `config`, five resource groups, 34 public
leaves, and 46 exact workflow IDs. Tag/Untag/List Tags rows own ordered
`[nameWorkflow, resourceArnWorkflow]`; every other leaf owns one workflow.

```ts
expect(IDENTITY_COMMAND_REGISTRY.map((row) => row.path)).toEqual([
  "identity/oauth2-provider/create",
  "identity/oauth2-provider/get",
  "identity/oauth2-provider/list",
  "identity/oauth2-provider/update",
  "identity/oauth2-provider/delete",
  "identity/oauth2-provider/tag",
  "identity/oauth2-provider/untag",
  "identity/oauth2-provider/list-tags",
  "identity/api-key-provider/create",
  "identity/api-key-provider/get",
  "identity/api-key-provider/list",
  "identity/api-key-provider/update",
  "identity/api-key-provider/delete",
  "identity/api-key-provider/tag",
  "identity/api-key-provider/untag",
  "identity/api-key-provider/list-tags",
  "identity/payment-provider/create",
  "identity/payment-provider/get",
  "identity/payment-provider/list",
  "identity/payment-provider/update",
  "identity/payment-provider/delete",
  "identity/payment-provider/tag",
  "identity/payment-provider/untag",
  "identity/payment-provider/list-tags",
  "identity/workload-identity/create",
  "identity/workload-identity/get",
  "identity/workload-identity/list",
  "identity/workload-identity/update",
  "identity/workload-identity/delete",
  "identity/workload-identity/tag",
  "identity/workload-identity/untag",
  "identity/workload-identity/list-tags",
  "identity/token-vault/get",
  "identity/token-vault/set-cmk",
]);
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/index.test.tsx src/handlers/identity/composition.test.ts src/handlers/root.test.tsx
```

- [ ] **Step 3: Implement the closed registry**

Define:

```ts
export type IdentityCommandPath = (typeof IDENTITY_COMMAND_REGISTRY)[number]["path"];

export interface IdentityCommandRegistration<
  Workflows extends readonly [IdentityWorkflowId, ...IdentityWorkflowId[]],
> {
  readonly path: string;
  readonly workflows: Workflows;
  readonly tui: "interactive";
}

declare const IDENTITY_HANDLER_WORKFLOWS: unique symbol;

export interface IdentityCommandHandler<
  Workflows extends readonly [IdentityWorkflowId, ...IdentityWorkflowId[]],
> {
  readonly workflows: Workflows;
  readonly [IDENTITY_HANDLER_WORKFLOWS]: (workflows: Workflows) => Workflows;
  invoke(options?: IdentityCallOptions): Promise<IdentityLeafCompletion>;
}
```

The symbol-owning registry constructor installs the private handler/workflow brand before the broad
router `Handler` erases authoring detail. `routes.tsx` is presentation-neutral despite its extension:
it contains the explicit 34-row command/workflow registry and no React component. Rows are immutable,
duplicate-free, and checked with `satisfies`; six Tag/Untag/List Tags rows per family retain
`[nameWorkflow, resourceArnWorkflow]` order.

- [ ] **Step 4: Implement composition and root mounting**

Plan 05 creates `IdentityActionCatalog` in this same feature composition module. Plan 06 extends the
composition root without rebuilding actions or accepting independently selected workflow metadata.
`createIdentityComposition(core, io)` consumes:

- the exact plan 05 action catalog built from the plan 04 factory catalog;
- one `CommitSecretContextFactory`;
- the invocation-owned mutation action/presentation controller;
- Commander and Ink output adapters;
- all leaf handlers.

It accepts no config file or project-state dependency. `createIdentityHandler(core, io)` installs
`withTuiOnEmptyFlagsAndArgs` once on the Identity router, registers every resource router, and sets the
Identity default TUI route. Extend `Core` with only the plan 04 Identity factory catalog, not CRUD
methods.

- [ ] **Step 5: Verify**

```bash
bun test src/handlers/identity/index.test.tsx src/handlers/identity/routes.test.tsx src/handlers/identity/composition.test.ts src/handlers/root.test.tsx src/handlers/help.screen.test.tsx src/tui/tui.test.tsx
bun run verify:tsc
```

- [ ] **Step 6: Commit**

```bash
git add src/handlers/identity/types.ts src/handlers/identity/routes.tsx src/handlers/identity/routes.test.tsx src/handlers/identity/composition.ts src/handlers/identity/composition.test.ts src/handlers/identity/index.tsx src/handlers/identity/index.test.tsx src/handlers/index.tsx src/handlers/types.tsx src/handlers/root.test.tsx src/handlers/help.screen.test.tsx src/tui/tui.test.tsx src/core/index.tsx src/testing/TestCoreClient.tsx test/compile/identity-command-handlers.ts
git commit -m "feat(identity): mount the identity command registry"
```

## Task 3: Implement Static Diagnostics And Correlated Commander Output

**Files:**

- Create: `src/handlers/identity/format.ts`
- Create: `src/handlers/identity/format.test.ts`
- Create: `src/handlers/identity/commander.ts`
- Create: `src/handlers/identity/commander.test.ts`
- Create: `src/runtime/output/commanderOutput.ts`
- Create: `src/runtime/output/commanderOutput.test.ts`
- Modify: `src/tui/index.tsx`
- Modify: `src/handlers/identity/composition.ts`

- [ ] **Step 1: Write exhaustive diagnostic tests**

Instantiate every member of `IdentityDiagnostic`, `UsageIdentityError`, `SecretIdentityError`,
`ServiceIdentityError`, pagination reason, parser code, and mutation presentation failure. Assert exact
static guidance, catalog-only labels, validated metadata order, and no unknown text.

Use sentinel-bearing `Error`, service body, Commander message, option value, path, env name, and secret
objects. Recursively scan stdout/stderr and assert no sentinel, stack, cause, inspection, or raw
message appears.

- [ ] **Step 2: Write one-document and receipt tests**

Cover successful query, no-change, committed mutation, serialization failure, callback failure,
backpressure/drain, EPIPE, close, cancellation after accepted write, `mutationOutcomeUnknown`, and
`committedOutputUnavailable`. A successful document is serialized fully before one `writeUtf8`.

- [ ] **Step 3: Verify the tests fail**

```bash
bun test src/handlers/identity/format.test.ts src/handlers/identity/commander.test.ts src/runtime/output/commanderOutput.test.ts
```

- [ ] **Step 4: Implement the formatter and output adapter**

Expose:

```ts
export function formatIdentityDiagnostic(diagnostic: IdentityDiagnostic): string;

export interface CommanderIdentityOutput {
  writeQuery(document: SafeIdentityDocument<QueryWorkflowId>): Promise<IdentityLeafCompletion>;
  writeMutation<W extends MutationWorkflowId>(
    attempt: CommitAttempt<W>,
  ): Promise<IdentityLeafCompletion>;
  writeFailure(diagnostic: IdentityDiagnostic): Promise<IdentityLeafCompletion>;
}
```

The mutation path registers the exact action lease before commit, begins Commander presentation only
for a settled execution, writes through `CommanderMutationOutputPort`, and retires only the matching
receipt. Serialization or output failure consults that execution's authoritative final certainty.
Failed leaves emit no success document. Empty Delete/Tag/Untag values serialize as `{}`.
`commander.ts` owns the reusable query and mutation presentation transactions. It serializes only the
flat `SafeIdentityDocument.value`, fully and before one awaited write; it never uses the repository's
synchronous generic renderer.

- [ ] **Step 5: Verify**

```bash
bun test src/handlers/identity/format.test.ts src/handlers/identity/commander.test.ts src/runtime/output/commanderOutput.test.ts src/runtime/output
bun run verify:tsc
```

- [ ] **Step 6: Commit**

```bash
git add src/handlers/identity/format.ts src/handlers/identity/format.test.ts src/handlers/identity/commander.ts src/handlers/identity/commander.test.ts src/runtime/output/commanderOutput.ts src/runtime/output/commanderOutput.test.ts src/tui/index.tsx src/handlers/identity/composition.ts
git commit -m "feat(identity): add safe correlated commander output"
```

## Task 4: Implement Common Options, Secret Sources, And Literal Warnings

**Files:**

- Modify: `src/handlers/identity/types.ts`
- Create: `src/handlers/identity/options.ts`
- Create: `src/handlers/identity/options.test.ts`
- Create: `src/handlers/identity/interaction.ts`
- Create: `src/handlers/identity/interaction.test.ts`
- Create: `src/handlers/identity/secretOptions.test.ts`
- Modify: `src/handlers/identity/composition.ts`
- Modify: `src/handlers/keys.tsx`

- [ ] **Step 1: Write option-catalog tests**

For each of the six slot prefixes, assert exact support for:

```text
--<slot> <literal>
--<slot>-stdin
--<slot>-env <variable-name>
--<slot>-file <path>
--<slot>-external-secret-id <secret-id>
--<slot>-external-json-key <json-key>
--<slot>-source <managed|external>
```

Test one value source, complete external pairs, source agreement, one stdin consumer, no prompt under
`--json` or non-TTY execution, and hidden prompt fallback only when interactive. Assert every literal
flag, including literal sensitive leaves accepted inside raw JSON, emits exactly one static warning per
command and never includes a value, variable, or path.

The interaction tests also cover serialized hidden prompts, TTY/non-TTY behavior, cancellation, Set
CMK confirmation defaulting to No, `--yes`, and `--json` never implying consent.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/options.test.ts src/handlers/identity/interaction.test.ts src/handlers/identity/secretOptions.test.ts
```

- [ ] **Step 3: Implement reusable option descriptors**

Generate flag declarations from `IDENTITY_SECRET_SLOT_CATALOG`, but keep parser output as
`SecretSourceSelection` plus opaque extracted selections. The option builder may derive spellings from
the catalog's stable prefix; it may not infer sensitive SDK paths or provider applicability.

Use exact common options:

- `--name`;
- `--resource-arn`;
- `--tags <json>`;
- `--tag-keys <tag-keys...>`;
- `--next-token`;
- `--max-results`;
- `--all`;
- optional `--token-vault-id`;
- `--yes` only for token-vault Set CMK.

Required selectors remain optional in Zod so a bare leaf can reach Ink; Commander execution enforces
them with closed Identity usage outcomes.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/options.test.ts src/handlers/identity/interaction.test.ts src/handlers/identity/secretOptions.test.ts src/router
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/types.ts src/handlers/identity/options.ts src/handlers/identity/options.test.ts src/handlers/identity/interaction.ts src/handlers/identity/interaction.test.ts src/handlers/identity/secretOptions.test.ts src/handlers/identity/composition.ts src/handlers/keys.tsx
git commit -m "feat(identity): add safe identity command options"
```

## Task 5: Implement Get, List, And List-Tags Leaves

**Files:**

- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/get/index.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/list/index.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/list-tags/index.tsx`
- Create: focused `*.test.tsx` beside each handler

- [ ] **Step 1: Write Commander query tests**

Route through `createRootHandler` and assert:

- missing `--name` in Commander mode is a closed usage failure;
- one-page list sends default 10 and preserves the service envelope;
- family-specific `maxResults` bounds;
- `--all` conflicts with `--next-token`, traverses all pages, and omits `nextToken`;
- malformed/noncanonical production tokens send no request;
- List Tags requires exactly one selector and chooses one branded action;
- direct ARN issues no prerequisite Get;
- every successful leaf emits one flat V1 document with no `$metadata`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/*/{get,list,list-tags}/*.test.tsx
```

- [ ] **Step 3: Implement query handlers**

Each handler:

1. parses only presentation inputs;
2. selects the exact registry workflow;
3. invokes one action;
4. sends its closed outcome to `CommanderIdentityOutput`;
5. returns `IdentityLeafCompletion`.

It never imports AWS command input/output unions. Preserve list keys:
`credentialProviders` for API-key/OAuth/payment and `workloadIdentities` for workload.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/*/{get,list,list-tags}/*.test.tsx
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/oauth2-provider/get src/handlers/identity/oauth2-provider/list src/handlers/identity/oauth2-provider/list-tags src/handlers/identity/api-key-provider/get src/handlers/identity/api-key-provider/list src/handlers/identity/api-key-provider/list-tags src/handlers/identity/payment-provider/get src/handlers/identity/payment-provider/list src/handlers/identity/payment-provider/list-tags src/handlers/identity/workload-identity/get src/handlers/identity/workload-identity/list src/handlers/identity/workload-identity/list-tags
git commit -m "feat(identity): add commander identity queries"
```

## Task 6: Implement Create And Update Leaves

**Files:**

- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/create/index.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/update/index.tsx`
- Create: focused `*.test.tsx` beside each handler

- [ ] **Step 1: Write create/update parser and execution matrices**

Cover every resource option and conflict from the design, including all OAuth families, curated/raw
exclusivity, Microsoft tenant applicability, custom discovery alternatives, preferred/legacy auth,
payment vendor fields, workload URL replace/clear, explicit secret-only updates, tags on Create only,
literal warnings, missing-secret guidance, semantic no-op output, and raw sensitive extraction.

Assert explicit Commander mutations authorize their reviewed plan without another prompt. On
`reprepareRequired`, Commander disposes the replacement, prints the static rerun guidance, and never
constructs or authorizes another context.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/*/{create,update}/*.test.tsx
```

- [ ] **Step 3: Implement preparation and commit orchestration**

Every mutation handler owns these guards:

```text
raw parser input
-> transactional secret extraction
-> CommitSecretContextFactory.create(source selections, extracted bundle, hidden prompt, call options)
-> action.prepare
-> register exact PreparedMutation
-> action lease commit
-> correlated Commander output
-> dispose all untransferred owners in finally
```

Secret extraction and context construction complete before `prepare`; secret values are not acquired
until commit after review/guard checks. Unknown throws become static internal failure. No handler
retries a mutation or accesses the prepared capability's private commit symbol.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/*/{create,update}/*.test.tsx src/handlers/identity/actions
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/oauth2-provider/create src/handlers/identity/oauth2-provider/update src/handlers/identity/api-key-provider/create src/handlers/identity/api-key-provider/update src/handlers/identity/payment-provider/create src/handlers/identity/payment-provider/update src/handlers/identity/workload-identity/create src/handlers/identity/workload-identity/update
git commit -m "feat(identity): add commander identity create and update"
```

## Task 7: Implement Delete, Tag, And Untag Leaves

**Files:**

- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/delete/index.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/tag/index.tsx`
- Create: `src/handlers/identity/{oauth2-provider,api-key-provider,payment-provider,workload-identity}/untag/index.tsx`
- Create: focused `*.test.tsx` beside each handler

- [ ] **Step 1: Write mutation leaf tests**

Assert explicit Delete accepts no `--yes`, executes immediately, and emits `{}`. Tag/Untag require
exactly one selector, enforce map/key limits, choose one of two workflow-branded actions before
preparation, and emit `{}`. Cover target change/reprepare, direct-ARN no-Get behavior, output failure
after dispatch, duplicate submit, and impossible Commander `busy`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/*/{delete,tag,untag}/*.test.tsx
```

- [ ] **Step 3: Implement the leaves**

Reuse the common mutation presentation transaction from Task 6. Do not add confirmation or `--yes` to
Delete, Tag, or Untag. Keep the name and ARN actions separate after the selector discriminant is parsed.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/*/{delete,tag,untag}/*.test.tsx
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/oauth2-provider/delete src/handlers/identity/oauth2-provider/tag src/handlers/identity/oauth2-provider/untag src/handlers/identity/api-key-provider/delete src/handlers/identity/api-key-provider/tag src/handlers/identity/api-key-provider/untag src/handlers/identity/payment-provider/delete src/handlers/identity/payment-provider/tag src/handlers/identity/payment-provider/untag src/handlers/identity/workload-identity/delete src/handlers/identity/workload-identity/tag src/handlers/identity/workload-identity/untag
git commit -m "feat(identity): add commander delete and tagging"
```

## Task 8: Implement Token-Vault Leaves And Confirmation

**Files:**

- Create: `src/handlers/identity/token-vault/get/index.tsx`
- Create: `src/handlers/identity/token-vault/get/get.test.tsx`
- Create: `src/handlers/identity/token-vault/set-cmk/index.tsx`
- Create: `src/handlers/identity/token-vault/set-cmk/set-cmk.test.tsx`

- [ ] **Step 1: Write confirmation tests**

Cover default and explicit vault IDs, key-type/ARN validation, TTY prompt defaulting to No,
confirmation cancellation, `--yes`, non-TTY refusal without `--yes`, and `--json` not implying consent.
No AWS Get or mutation occurs before required consent. A semantic no-op emits the Set CMK-normalized
current state.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/token-vault
```

- [ ] **Step 3: Implement token-vault handlers**

Use `tokenVault.get` and `tokenVault.setCmk` actions. Confirmation is presentation-owned and occurs
before action registration/commit; the action still revalidates current state and guard at commit.
Prompts write only static text through injected stderr and read injected stdin.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/token-vault
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/token-vault
git commit -m "feat(identity): add token vault commander workflows"
```

## Task 9: Commander Contract, Help, And Subprocess Gate

**Files:**

- Create: `test/subprocess/identity-commander.test.ts`
- Modify: `src/handlers/identity/index.test.tsx`
- Modify: `src/router/executionPolicy.test.ts`
- Test: all Identity Commander handlers

- [ ] **Step 1: Add exhaustive help and option snapshots**

Assert all 34 leaves are discoverable, payment is always present with `Preview`, every option spelling
matches the catalog, no general OAuth `--grant-type` exists, and advanced JSON options are documented.
Verify bare groups/leaves route to Ink while `--json` groups show help and `--json` leaves report
missing required input.

- [ ] **Step 2: Add subprocess output-failure tests**

Exercise slow pipes and stdout closure:

- before query output;
- before mutation dispatch;
- after dispatch with unknown outcome;
- after exact-status commit;
- during callback/drain;
- with stderr also closed.

Assert natural process completion, no partial parseable-success claim, no stack, no retry, and exact
certainty-derived static guidance.

- [ ] **Step 3: Run the Commander gate**

```bash
bun test src/handlers/identity src/router src/runtime/output test/subprocess/identity-commander.test.ts
bun run build
bun run verify:tsc
bun run format:check
git diff --check
```

- [ ] **Step 4: Run independent Codex reviews**

Run `openai.gpt-5.6-sol` spec-compliance and code-quality/security reviews against exact base/head
SHAs. Require explicit checks for all commands/options, parser safety, literal warnings, context
disposal, replacement disposal, confirmation, output receipts, and exit behavior. Fix and repeat until
both reports end in `VERDICT: PASS`.

- [ ] **Step 5: Push**

```bash
git push origin feat/identity-cli
```
