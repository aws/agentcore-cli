# Identity Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, exhaustive Identity workflow/catalog/input/update/normalization domain that both Commander and Ink consume without SDK-client, process, filesystem, or presentation dependencies.

**Architecture:** One closed workflow key derives family, selector, SDK operations, binding facet, policy, intent, and DTO. Provider and secret catalogs own all family exceptions; pure builders turn markerized intents plus claimed values into exact requests, while strict normalizers turn SDK-shaped values into workflow-branded JSON-only V1 documents.

**Tech Stack:** TypeScript, Zod, jsonc-parser, Smithy runtime schemas, Web Crypto/Node crypto SHA-256, Bun test.

---

## Task 1: Define Operations, Workflows, And Compile-Time Ownership

**Files:**

- Create: `src/handlers/identity/domain/operations.ts`
- Create: `src/handlers/identity/domain/workflow.ts`
- Create: `src/handlers/identity/domain/workflow.test.ts`
- Create: `test/compile/identity-workflows.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write the exhaustive compile and runtime tests**

The runtime test must assert exactly 46 workflow keys:

```ts
const crudFamilies = ["apiKey", "oauth2", "payment", "workload"] as const;
const crudVerbs = ["create", "get", "list", "update", "delete"] as const;
const tagVerbs = ["tag", "untag", "listTags"] as const;
const selectors = ["name", "resourceArn"] as const;

expect(identityWorkflowKeys).toHaveLength(
  crudFamilies.length * crudVerbs.length +
    crudFamilies.length * tagVerbs.length * selectors.length +
    2,
);
```

Compile fixtures must use `// @ts-expect-error` to reject substitution of each workflow's family,
selector, primary operation, auxiliary Get, binding facet, policy, intent, DTO, and foreign workflow
brand.

- [ ] **Step 2: Verify the test fails**

```bash
bun test src/handlers/identity/domain/workflow.test.ts
bunx tsc --noEmit test/compile/identity-workflows.ts
```

- [ ] **Step 3: Implement the closed registries**

Define the operation maps and workflow type equations from the design. Runtime metadata is an
exhaustive record checked with `satisfies`:

```ts
export const IDENTITY_WORKFLOWS = {
  "apiKey.create": {
    family: "apiKey",
    selector: "createName",
    primaryOperation: "CreateApiKeyCredentialProvider",
    auxiliaryGet: null,
    facet: "directMutation",
    policy: "direct",
  },
  "apiKey.update": {
    family: "apiKey",
    selector: "name",
    primaryOperation: "UpdateApiKeyCredentialProvider",
    auxiliaryGet: "GetApiKeyCredentialProvider",
    facet: "currentStateMutation",
    policy: "replacement",
  },
  "oauth2.update": {
    family: "oauth2",
    selector: "name",
    primaryOperation: "UpdateOauth2CredentialProvider",
    auxiliaryGet: "GetOauth2CredentialProvider",
    facet: "compatibilityGuardedUpdate",
    policy: "replacement",
  },
  "tokenVault.get": {
    family: "tokenVault",
    selector: "tokenVaultId",
    primaryOperation: "GetTokenVault",
    auxiliaryGet: null,
    facet: "read",
    policy: "query",
  },
  "tokenVault.setCmk": {
    family: "tokenVault",
    selector: "tokenVaultId",
    primaryOperation: "SetTokenVaultCMK",
    auxiliaryGet: "GetTokenVault",
    facet: "currentStateMutation",
    policy: "replacement",
  },
  // Include every remaining CRUD and name/resourceArn tag workflow explicitly.
} as const satisfies IdentityWorkflowCompatibilityMap;
```

Do not generate runtime rows dynamically; code review must see every operation/facet/policy binding.
Workflow-ID constructors remain private to the registry module.

- [ ] **Step 4: Verify workflow ownership**

```bash
bun test src/handlers/identity/domain/workflow.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/domain/operations.ts src/handlers/identity/domain/workflow.ts src/handlers/identity/domain/workflow.test.ts test/compile/identity-workflows.ts tsconfig.json
git commit -m "feat(identity): define closed workflow registry"
```

## Task 2: Implement Strict JSON, Canonical Maps, Terminal Strings, And ARN Parsing

**Files:**

- Create: `src/handlers/identity/domain/json.ts`
- Create: `src/handlers/identity/domain/maps.ts`
- Create: `src/handlers/identity/domain/strings.ts`
- Create: `src/handlers/identity/domain/unicodeSecurityTable.ts`
- Create: `src/handlers/identity/domain/arn.ts`
- Create: `scripts/generate-unicode-security-table.ts`
- Create: `test/fixtures/unicode/DerivedCoreProperties.txt`
- Create: `test/fixtures/unicode/UnicodeData.txt`
- Create: focused tests beside each module

- [ ] **Step 1: Write adversarial tests**

Tests must cover duplicate keys before materialization, `__proto__`, `constructor`, inherited keys,
literal backslashes versus controls, all surrogate boundaries, U+2028/U+2029, bidi controls, generated
Unicode 17 default-ignorables/`Cf`, normalized map order, unsafe URL/tag characters, and all four ARN
resource templates across `aws`, `aws-us-gov`, and `aws-cn`.

Use exact assertions:

```ts
expect(parseStrictJson('{"a":1,"a":2}')).toEqual({
  kind: "validationFailed",
  reason: "duplicateKey",
});

const record = materializeIdentityMap([
  { key: "__proto__", value: "x" },
  { key: "constructor", value: "y" },
]);
expect(Object.getPrototypeOf(record)).toBeNull();
expect(Object.keys(record)).toEqual(["__proto__", "constructor"]);

expect(encodeTerminalString("\u001b[31m")).toBe("\\u{001B}[31m");
expect(encodeTerminalString("\\u{001B}")).not.toBe(encodeTerminalString("\u001b"));
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/domain/json.test.ts src/handlers/identity/domain/maps.test.ts src/handlers/identity/domain/strings.test.ts src/handlers/identity/domain/arn.test.ts
```

- [ ] **Step 3: Implement strict JSON and canonical maps**

Expose:

```ts
export type IdentityStringMapEntry = Readonly<{ key: string; value: string }>;
export type IdentityStringMap = readonly IdentityStringMapEntry[];

export function parseStrictJson(text: string): StrictJsonOutcome;
export function parseIdentityMap(text: string, limits: MapLimits): IdentityMapOutcome;
export function materializeIdentityMap(
  entries: IdentityStringMap,
): Readonly<Record<string, string>>;
export function encodeTerminalString(value: string): string;
export function encodeTerminalMapKey(value: string): string;
export function parseIdentityArn(
  text: string,
  expectedFamily: IdentityCrudFamily,
  resolvedRegion: string,
): IdentityArnOutcome;
```

Use `jsonc-parser` with comments and trailing commas disabled and a visitor that detects duplicate
static and dynamic keys before any object exists. Canonicalize map entries by encoded raw key bytes.
Materialize with `Object.create(null)` and `Object.defineProperty`.

- [ ] **Step 4: Generate and verify Unicode data**

The generator hashes both vendored Unicode 17 files, emits reviewed sorted intervals, and fails if the
source digests differ from constants in the script. Runtime code imports only the generated table.

```bash
bun scripts/generate-unicode-security-table.ts --check
```

Expected: generated output is byte-identical.

- [ ] **Step 5: Verify**

```bash
bun test src/handlers/identity/domain/json.test.ts src/handlers/identity/domain/maps.test.ts src/handlers/identity/domain/strings.test.ts src/handlers/identity/domain/arn.test.ts
bun run verify:tsc
```

- [ ] **Step 6: Commit**

```bash
git add src/handlers/identity/domain scripts/generate-unicode-security-table.ts test/fixtures/unicode
git commit -m "feat(identity): add safe canonical input primitives"
```

## Task 3: Build Provider, Option, Schema-Path, And Secret-Slot Catalogs

**Files:**

- Create: `src/handlers/identity/domain/providers.ts`
- Create: `src/handlers/identity/domain/secretSlots.ts`
- Create: `src/handlers/identity/domain/schemas.ts`
- Create: `src/handlers/identity/domain/providers.test.ts`
- Create: `src/handlers/identity/domain/secretSlots.test.ts`
- Create: `test/compile/identity-sensitive-inputs.ts`

- [ ] **Step 1: Write catalog drift tests**

Tests must assert:

- 25 unique OAuth slugs and exact SDK vendor values;
- seven named, seven included per-tenant, ten included global, one custom;
- Microsoft alone owns optional tenant input;
- both payment vendors and exactly four payment secret slots;
- every sensitive SDK path maps to one slot;
- every option ID and schema path is unique;
- runtime union members equal the reviewed catalog.

```ts
expect(Object.keys(OAUTH_PROVIDERS)).toHaveLength(25);
expect(new Set(Object.values(OAUTH_PROVIDERS).map((p) => p.vendor)).size).toBe(25);
expect(Object.keys(IDENTITY_SECRET_SLOT_CATALOG)).toEqual([
  "api-key",
  "client-secret",
  "api-key-secret",
  "wallet-secret",
  "app-secret",
  "authorization-private-key",
]);
```

Compile fixtures must reject a raw string at every sensitive path of `SanitizedOAuthInput` and
`SanitizedPaymentInput`.

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/handlers/identity/domain/providers.test.ts src/handlers/identity/domain/secretSlots.test.ts
bun run verify:tsc
```

- [ ] **Step 3: Implement exhaustive catalogs**

Use exact immutable descriptors:

```ts
export type OAuthFamily = "named" | "includedPerTenant" | "includedGlobal" | "custom";

export type OAuthProviderDescriptor = Readonly<{
  slug: OAuthProviderSlug;
  vendor: CredentialProviderVendorType;
  family: OAuthFamily;
  member:
    | "atlassianOauth2ProviderConfig"
    | "githubOauth2ProviderConfig"
    | "googleOauth2ProviderConfig"
    | "linkedinOauth2ProviderConfig"
    | "microsoftOauth2ProviderConfig"
    | "salesforceOauth2ProviderConfig"
    | "slackOauth2ProviderConfig"
    | "includedOauth2ProviderConfig"
    | "customOauth2ProviderConfig";
  tenant: "forbidden" | "optional";
}>;

export type SecretSlotDescriptor<Id extends SecretSlotId> = Readonly<{
  id: Id;
  order: number;
  acceptedSources: readonly ["literal", "env", "file", "stdin", "prompt", "external"];
  sensitivePaths: readonly IdentitySchemaPath[];
  commanderPrefix: string;
}>;
```

Define every row literally. Runtime drift tests inspect the pinned schemas; no catalog is inferred
from display labels.

- [ ] **Step 4: Verify catalogs**

```bash
bun test src/handlers/identity/domain/providers.test.ts src/handlers/identity/domain/secretSlots.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/domain test/compile/identity-sensitive-inputs.ts
git commit -m "feat(identity): add exhaustive provider and secret catalogs"
```

## Task 4: Define Markerized Intents And Exact Validation

**Files:**

- Create: `src/handlers/identity/domain/intents.ts`
- Modify: `src/handlers/identity/domain/schemas.ts`
- Create: `src/handlers/identity/domain/intents.test.ts`

- [ ] **Step 1: Write intent-schema matrices**

Cover all Create/Update/tag/list/token-vault conflicts and boundaries. Required cases include:

- curated versus raw OAuth/payment exclusivity;
- exact custom discovery alternatives;
- preferred versus legacy auth mechanisms;
- all clear-option rules;
- one to five workload URLs and explicit clear;
- default list page size 10 and family-specific ranges;
- `--all` versus `--next-token`;
- tag count/key/value limits and duplicate keys;
- exact one of name/resource ARN;
- customer-managed KMS key ARN versus service-managed no ARN.

The tests must prove no intent contains a secret string:

```ts
const parsed = parseCreateApiKeyInput({
  name: "provider",
  apiKey: { kind: "literalSelection", opaqueId: "selection-1" },
});
expect(parsed.kind).toBe("accepted");
expect(JSON.stringify(parsed)).not.toContain("secret-value");
```

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/handlers/identity/domain/intents.test.ts
```

- [ ] **Step 3: Implement the exact intent unions**

Use the design's `CreateOauth2Intent`, `UpdateOauth2Intent`, API-key, payment, workload, token-vault,
selector, list, tag, and untag types. Sensitive leaves are nominal markers only:

```ts
declare const SECRET_VALUE_MARKER: unique symbol;

export interface SecretValueMarker<Slot extends SecretSlotId> {
  readonly slot: Slot;
  readonly [SECRET_VALUE_MARKER]: Slot;
}

export type SecretProvisionDirective<Slot extends SecretSlotId> =
  | Readonly<{ kind: "managed"; value: SecretValueMarker<Slot> }>
  | Readonly<{ kind: "external"; reference: SecretReference }>;
```

All parser functions return `accepted` or a closed `UsageIdentityError`. They never throw and never
accept an ordinary object pretending to be a marker.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/domain/intents.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/domain/intents.ts src/handlers/identity/domain/schemas.ts src/handlers/identity/domain/intents.test.ts
git commit -m "feat(identity): define secret-free workflow intents"
```

## Task 5: Implement OAuth, Payment, API-Key, Workload, Token-Vault, And Tag Builders

**Files:**

- Create: `src/handlers/identity/domain/oauth.ts`
- Create: `src/handlers/identity/domain/payment.ts`
- Create: `src/handlers/identity/domain/requests.ts`
- Create: `src/handlers/identity/domain/requests.test.ts`

- [ ] **Step 1: Write exhaustive request-builder tests**

Cover all 25 OAuth providers, nine OAuth union members, Microsoft `common`, custom discovery/auth/OBO/
private endpoint rules, two payment unions and all four secret slots, API-key source modes, workload
replacement/clear, CMK validation, and tag materialization. Assert exact SDK request equality.

For example:

```ts
expect(buildOauthCreate(googleIntent, values)).toEqual({
  name: "google",
  credentialProviderVendor: "GoogleOauth2",
  oauth2ProviderConfigInput: {
    googleOauth2ProviderConfig: {
      clientId: "client",
      clientSecret: "resolved",
      clientSecretSource: "MANAGED",
    },
  },
  tags: nullPrototypeRecord([["owner", "cli"]]),
});
```

Tests must reject multiple union members, vendor/member mismatch, source switching, malformed
payment keys, unsupported current source, and unknown future write shapes.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/handlers/identity/domain/requests.test.ts
```

- [ ] **Step 3: Implement pure builders**

Expose resource-specific functions, not one generic deep merge:

```ts
export function buildApiKeyCreate(
  intent: CreateApiKeyIntent,
  values: ClaimedSecretValues<"api-key">,
): RequestBuildOutcome<CreateApiKeyCredentialProviderCommandInput>;

export function buildOauthCreate(
  intent: CreateOauth2Intent,
  values: ClaimedSecretValues<"client-secret">,
): RequestBuildOutcome<CreateOauth2CredentialProviderCommandInput>;

export function buildPaymentCreate(
  intent: CreatePaymentIntent,
  values: ClaimedPaymentSecretValues,
): RequestBuildOutcome<CreatePaymentCredentialProviderCommandInput>;
```

Add corresponding update/workload/token-vault/tag builders. Every function validates a final explicit
Zod request schema before returning `built`.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/domain/requests.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/domain/oauth.ts src/handlers/identity/domain/payment.ts src/handlers/identity/domain/requests.ts src/handlers/identity/domain/requests.test.ts
git commit -m "feat(identity): build exact identity SDK requests"
```

## Task 6: Implement Update Planning, Reviews, And Commit Guards

**Files:**

- Create: `src/handlers/identity/domain/updates.ts`
- Create: `src/handlers/identity/domain/review.ts`
- Create: `src/handlers/identity/domain/guard.ts`
- Create: focused tests for each

- [ ] **Step 1: Write update/review/guard tests**

Exercise:

- omission preserves and explicit clear changes;
- secret-only rotations are mutations, never no-ops;
- required managed values are reacquired;
- reconstructable external references are preserved;
- unknown current source fails before secret I/O;
- every custom authentication transition;
- complete replacement generation;
- guard canonicalization, domain separation, finite numbers, array order, object order, and unpaired
  surrogate rejection;
- review model contains every effective change and no secret bytes.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/handlers/identity/domain/updates.test.ts src/handlers/identity/domain/review.test.ts src/handlers/identity/domain/guard.test.ts
```

- [ ] **Step 3: Implement resource-specific planners**

Expose:

```ts
export type UpdatePlanOutcome<W extends RepreparableWorkflowId> =
  | Readonly<{
      kind: "planned";
      effective: EffectiveMutationState<W>;
      requirements: readonly SecretRequirement[];
      review: IdentityReviewModel<W>;
      guard: CommitGuard<W>;
    }>
  | Readonly<{ kind: "noChange"; document: SafeIdentityDocument<W> }>
  | Readonly<{ kind: "unsupported"; error: SafeIdentityError }>;

export function planApiKeyUpdate(...): UpdatePlanOutcome<ApiKeyUpdateWorkflow>;
export function planOauthUpdate(...): UpdatePlanOutcome<OAuthUpdateWorkflow>;
export function planPaymentUpdate(...): UpdatePlanOutcome<PaymentUpdateWorkflow>;
export function planWorkloadUpdate(...): UpdatePlanOutcome<WorkloadUpdateWorkflow>;
export function planTokenVaultUpdate(...): UpdatePlanOutcome<TokenVaultSetCmkWorkflow>;
```

Guard hashing uses a typed length-delimited canonical codec and SHA-256. Review fields use terminal-safe
strings and frozen arrays/maps.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/domain/updates.test.ts src/handlers/identity/domain/review.test.ts src/handlers/identity/domain/guard.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/domain/updates.ts src/handlers/identity/domain/review.ts src/handlers/identity/domain/guard.ts src/handlers/identity/domain/*.test.ts
git commit -m "feat(identity): add guarded update planning"
```

## Task 7: Implement Safe Errors And Workflow-Branded V1 Normalization

**Files:**

- Create: `src/handlers/identity/domain/errors.ts`
- Create: `src/handlers/identity/domain/normalize.ts`
- Create: `src/handlers/identity/domain/errors.test.ts`
- Create: `src/handlers/identity/domain/normalize.test.ts`
- Create: `test/compile/safe-identity-documents.ts`

- [ ] **Step 1: Write normalization and sanitization tests**

Cover every top-level allowlist, dates, empty arrays/maps, token encoding, unknown unions at every
nested level, `PRIVATE_KEY_JWT`, omitted SDK-unknown companion configuration, safe OAuth failure
guidance, request-ID validation, and reflected secret sentinels in strings, keys, numbers, booleans,
null, dates, tokens, status, and errors.

Compile tests must reject construction or cross-workflow assignment of `SafeIdentityDocument`.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/handlers/identity/domain/errors.test.ts src/handlers/identity/domain/normalize.test.ts
bun run verify:tsc
```

- [ ] **Step 3: Implement closed error and document constructors**

Public types:

```ts
export type SafeIdentityError =
  | UsageIdentityError
  | SecretIdentityError
  | ServiceIdentityError
  | Readonly<{ category: "internal" }>;

export interface SafeIdentityDocument<W extends IdentityWorkflowId> extends WorkflowBranded<W> {
  readonly value: DeepReadonly<IdentityWorkflowDtoMap[W["key"]]>;
}

export type NormalizeOutcome<W extends IdentityWorkflowId> =
  | Readonly<{ kind: "normalized"; document: SafeIdentityDocument<W> }>
  | Readonly<{ kind: "sdkCompatibilityRequired"; error: SafeIdentityError }>
  | Readonly<{ kind: "reflectedSecret"; error: SafeIdentityError }>;
```

Brands and constructors remain private. Normalizers are operation-specific exhaustive functions;
there is no generic `JSON.stringify` sanitizer.

- [ ] **Step 4: Verify**

```bash
bun test src/handlers/identity/domain
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/handlers/identity/domain test/compile/safe-identity-documents.ts
git commit -m "feat(identity): add safe V1 normalization and errors"
```

## Task 8: Domain Review Gate

- [ ] **Step 1: Run complete domain verification**

```bash
bun test src/handlers/identity/domain
bun run verify:tsc
bun run format:check
git diff --check
```

- [ ] **Step 2: Run `openai.gpt-5.6-sol` spec and security reviews**

Review all domain commits against Provider Catalog, Input Model, Update Semantics, Unknown Future
Providers, Errors, and Normalized V1 Output. Fix and rerun until both pass.

- [ ] **Step 3: Push**

```bash
git push origin feat/identity-cli
```
