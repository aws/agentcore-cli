# Identity SDK Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement operation-bound SDK adapters that pin credentials/endpoints, enforce exact HTTP contracts before Smithy deserialization, preserve dynamic maps and paginator semantics, and expose only total branded binding facets to actions.

**Architecture:** `src/core/identity.tsx` is the thin composition adapter. Private modules may share transport utilities, but action constructors receive one nominal factory for one workflow/facet. Read clients retain normal retries; mutation clients use `maxAttempts: 1`; one operation binding owns both over one immutable credential snapshot and eagerly resolved endpoints.

**Tech Stack:** AWS SDK v3.1079.0, Smithy Core 3.29.1, Node/Web streams, jsonc-parser, TypeScript, Bun test.

---

## Task 1: Register Commands And Exact HTTP Success Contracts

**Files:**

- Create: `src/core/identity/operations.ts`
- Create: `src/core/identity/statusRegistry.ts`
- Create: `src/core/identity/statusRegistry.test.ts`

- [ ] **Step 1: Write exhaustive registry tests**

Reflect over every operation in the domain maps and assert one command constructor, request schema,
response schema, modeled error allowlist, exact status, and body policy. Expected statuses are:

```ts
const EXPECTED = {
  CreateApiKeyCredentialProvider: 201,
  CreateOauth2CredentialProvider: 201,
  CreatePaymentCredentialProvider: 201,
  CreateWorkloadIdentity: 201,
  UpdateApiKeyCredentialProvider: 200,
  UpdateOauth2CredentialProvider: 200,
  UpdatePaymentCredentialProvider: 200,
  UpdateWorkloadIdentity: 200,
  SetTokenVaultCMK: 200,
  DeleteApiKeyCredentialProvider: 204,
  DeleteOauth2CredentialProvider: 204,
  DeletePaymentCredentialProvider: 204,
  DeleteWorkloadIdentity: 204,
  TagResource: 204,
  UntagResource: 204,
  GetApiKeyCredentialProvider: 200,
  ListApiKeyCredentialProviders: 200,
  GetOauth2CredentialProvider: 200,
  ListOauth2CredentialProviders: 200,
  GetPaymentCredentialProvider: 200,
  ListPaymentCredentialProviders: 200,
  GetWorkloadIdentity: 200,
  ListWorkloadIdentities: 200,
  GetTokenVault: 200,
  ListTagsForResource: 200,
} as const;
```

- [ ] **Step 2: Verify the tests fail**

```bash
bun test src/core/identity/statusRegistry.test.ts
```

- [ ] **Step 3: Implement the registry**

Every row is explicit and satisfies the domain operation map. `204` allows zero bytes only for a usable
response; nonempty exact-204 still advances commit certainty but returns
`successfulResponseUnusable`.

- [ ] **Step 4: Verify**

```bash
bun test src/core/identity/statusRegistry.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/core/identity/operations.ts src/core/identity/statusRegistry.ts src/core/identity/statusRegistry.test.ts
git commit -m "feat(identity): register exact transport contracts"
```

## Task 2: Normalize And Bound Every HTTP Body

**Files:**

- Create: `src/core/identity/body.ts`
- Create: `src/core/identity/body.test.ts`

- [ ] **Step 1: Write body-shape and boundary tests**

Cover absent body, string, `ArrayBuffer`, offset views, all typed arrays, Node `Buffer`, Node
`Readable`/HTTP2-like streams, Web `ReadableStream`, and reject `null`, Blob, arbitrary async iterable,
premature close/error/abort, unsupported shapes, and backing-store mutation. Test exactly
1,048,575/1,048,576/1,048,577 bytes.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/core/identity/body.test.ts
```

- [ ] **Step 3: Implement bounded normal EOF collection**

```ts
export const MAX_IDENTITY_RESPONSE_BYTES = 1_048_576 as const;

export type BodyNormalizationOutcome =
  | Readonly<{ kind: "complete"; bytes: Uint8Array }>
  | Readonly<{ kind: "incomplete" }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "overflow" }>
  | Readonly<{ kind: "cancelled" }>;

export async function normalizeIdentityBody(
  body: unknown,
  abortSignal?: AbortSignal,
): Promise<BodyNormalizationOutcome>;
```

Copy exact byte ranges. Destroy Node streams or cancel/release Web readers immediately on overflow or
failure. Restore a fresh detached `Uint8Array` for downstream deserialization.

- [ ] **Step 4: Verify**

```bash
bun test src/core/identity/body.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/core/identity/body.ts src/core/identity/body.test.ts
git commit -m "feat(identity): bound all SDK response bodies"
```

## Task 3: Pin One Credential Snapshot And All Endpoints Per Operation

**Files:**

- Create: `src/core/identity/credentials.ts`
- Create: `src/core/identity/endpoints.ts`
- Create: `src/core/identity/credentials.test.ts`
- Create: `src/core/identity/endpoints.test.ts`
- Modify: `src/core/types.tsx`
- Modify: `src/core/factories.tsx`

- [ ] **Step 1: Write pinning and freshness tests**

Use a provider returning account-A credentials then account-B credentials; assert one invocation per
binding and isolated mutable clones per SDK request. Cover `$source` mutation, absent/finite/invalid
expiration, and `299_999`, `300_000`, `300_001` milliseconds before every send.

Endpoint tests must prove normal precedence independently for AgentCore, STS, and Secrets Manager,
`--endpoint-url` only affects AgentCore, profile/environment changes do not split an operation, and
live/capture bypass overrides and require modeled HTTPS endpoints.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/core/identity/credentials.test.ts src/core/identity/endpoints.test.ts
```

- [ ] **Step 3: Implement immutable snapshots and endpoint policy**

```ts
export type IdentityCredentialSnapshot = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  accountId?: string;
  credentialScope?: string;
  expirationEpochMs?: number;
}>;

export type IdentityEndpointPolicy =
  | Readonly<{ kind: "normal"; agentCoreEndpoint?: string }>
  | Readonly<{ kind: "officialOnly" }>;

export type OperationEnvironmentOutcome =
  | Readonly<{ kind: "created"; environment: IdentityOperationEnvironment }>
  | Readonly<{ kind: "credentialRefreshRequired" }>
  | Readonly<{ kind: "failed" }>;
```

The SDK credential provider closure returns a new plain clone and fresh `Date` every time. It never
returns the frozen snapshot. Eagerly resolve full `EndpointV2` values before the first action call.

- [ ] **Step 4: Verify**

```bash
bun test src/core/identity/credentials.test.ts src/core/identity/endpoints.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/core/identity/credentials.ts src/core/identity/endpoints.ts src/core/identity/*.test.ts src/core/types.tsx src/core/factories.tsx
git commit -m "feat(identity): pin operation credentials and endpoints"
```

## Task 4: Preserve Dynamic Maps Across Smithy Serialization

**Files:**

- Create: `src/core/identity/mapWire.ts`
- Create: `src/core/identity/mapWire.test.ts`

- [ ] **Step 1: Write request/response map tests**

Test every registered path:

- four Create tag maps;
- `TagResource.tags`;
- custom OAuth managed-VPC tags and override maps;
- payment Get tags;
- List Tags response tags.

Include `__proto__`, duplicates, inherited keys, generated serializer drift, raw byte mismatch, and
capture/replay paths.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/core/identity/mapWire.test.ts
```

- [ ] **Step 3: Implement structured middleware**

```ts
export const IDENTITY_MAP_WIRE_REGISTRY = {
  CreateApiKeyCredentialProvider: ["/tags"],
  CreateOauth2CredentialProvider: [
    "/tags",
    "/oauth2ProviderConfigInput/customOauth2ProviderConfig/privateEndpoint/managedVpcResource/tags",
    "/oauth2ProviderConfigInput/customOauth2ProviderConfig/privateEndpointOverrides/*/privateEndpoint/managedVpcResource/tags",
  ],
  // Include every design-listed request and response path.
} as const satisfies IdentityMapWireRegistry;
```

Request middleware parses generated JSON structurally, compares registered paths with original entry
lists, replaces only those nodes, and reserializes. Response middleware captures maps from bounded raw
bytes before generated deserialization and revives null-prototype records outside it.

- [ ] **Step 4: Verify**

```bash
bun test src/core/identity/mapWire.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/core/identity/mapWire.ts src/core/identity/mapWire.test.ts
git commit -m "feat(identity): preserve dynamic maps on the wire"
```

## Task 5: Add Exact Read Classification And Guarded Raw-Wire Schemas

**Files:**

- Create: `src/core/identity/rawWire.ts`
- Create: `src/core/identity/rawWire.test.ts`
- Modify: `src/core/identity/operations.ts`
- Modify: `src/core/identity/statusRegistry.ts`

- [ ] **Step 1: Write classifier matrices**

For ordinary and compatibility-guarded reads, cover informational, alternate 2xx, exact 200 malformed/
incomplete/over-cap, allowlisted modeled errors, unmodeled bounded/unbounded errors, cancellation,
credential expiry, and internal failure. Inject additive fields at every OAuth/payment known structure
and unknown union arms.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/core/identity/rawWire.test.ts
```

- [ ] **Step 3: Implement one common deserialize-step classifier**

Install relative `after` Smithy's `deserializerMiddleware` so it runs first on the response path.
Public outcomes:

```ts
export type ReadTransportOutcome<T> =
  | Readonly<{ kind: "succeeded"; output: T }>
  | Readonly<{ kind: "notFound" }>
  | Readonly<{ kind: "serviceFailed"; error: ServiceIdentityError }>
  | Readonly<{ kind: "sdkCompatibilityRequired" }>
  | Readonly<{ kind: "credentialRefreshRequired" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "internalFailed" }>;
```

OAuth/payment update schemas use exact wire keys/types/requiredness/unions and the one-MiB boundary.
Ordinary reads remain additive-tolerant after status/body/map validation.

- [ ] **Step 4: Verify**

```bash
bun test src/core/identity/rawWire.test.ts src/core/identity/statusRegistry.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/core/identity/rawWire.ts src/core/identity/rawWire.test.ts src/core/identity/operations.ts src/core/identity/statusRegistry.ts
git commit -m "feat(identity): classify exact SDK response contracts"
```

## Task 6: Implement Safe Pagination And Continuation Tokens

**Files:**

- Create: `src/core/identity/paginator.ts`
- Create: `src/core/identity/paginator.test.ts`
- Modify: `src/handlers/identity/domain/normalize.ts`
- Modify: `src/handlers/identity/domain/intents.ts`

- [ ] **Step 1: Write token and paginator tests**

Cover every UTF-16 code-unit boundary including unpaired surrogates, exact encoded/decoded caps,
canonical unpadded Base64URL, malformed versions/padding/alphabet/odd bytes/empty, frozen caller inputs,
multi-page traversal, same-token and A-B-A cycles, abort propagation, and caller input immutability.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/core/identity/paginator.test.ts
```

- [ ] **Step 3: Implement codecs and cloned paginator input**

```ts
export interface ProductionContinuationTokenCodec {
  encode(token: IdentityContinuationToken): EncodedIdentityContinuationTokenV1;
  decode(text: string): ContinuationTokenDecodeOutcome;
}

export interface IdentityReadPageCursor<T> {
  next(): Promise<ReadPageOutcome<T>>;
  dispose(): void;
}
```

Generated paginators receive a shallow mutable clone and real client instance. Cursor disposal is
synchronous, nonthrowing, and idempotent. No raw token crosses an action boundary.

- [ ] **Step 4: Verify**

```bash
bun test src/core/identity/paginator.test.ts
bun run verify:tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/core/identity/paginator.ts src/core/identity/paginator.test.ts src/handlers/identity/domain/normalize.ts src/handlers/identity/domain/intents.ts
git commit -m "feat(identity): add safe pagination transport"
```

## Task 7: Implement Nominal Binding Facets And Transactional Factories

**Files:**

- Create: `src/core/identity/bindings.ts`
- Create: `src/core/identity/factory.ts`
- Create: `src/core/identity/bindings.test.ts`
- Create: `src/core/identity/factory.test.ts`
- Create: `test/compile/identity-binding-facets.ts`
- Create: `src/core/identity.tsx`
- Modify: `src/core/index.tsx`

- [ ] **Step 1: Write facet and factory tests**

Compile tests must reject cross-operation, cross-workflow, cross-facet, structurally equal input/output,
ordinary-versus-guarded read, and direct-versus-current-state binding substitution.

Runtime tests cover sync throw, async provider/endpoint/client/handler rejection, abort before/during
construction, expiry, late completion after abort, and destruction of every partial resource.

- [ ] **Step 2: Verify tests fail**

```bash
bun test src/core/identity/bindings.test.ts src/core/identity/factory.test.ts
bun run verify:tsc
```

- [ ] **Step 3: Implement exact facets**

Expose the design interfaces:

```ts
declare const IDENTITY_READ_BINDING: unique symbol;
declare const IDENTITY_LIST_BINDING: unique symbol;
declare const IDENTITY_RESOLVED_READ_BINDING: unique symbol;
declare const IDENTITY_DIRECT_MUTATION_BINDING: unique symbol;
declare const IDENTITY_CURRENT_STATE_MUTATION_BINDING: unique symbol;
declare const IDENTITY_COMPATIBILITY_GUARDED_UPDATE_BINDING: unique symbol;

export interface IdentityReadBinding<
  W extends WorkflowForFacet<"read">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_READ_BINDING]: true;
  read(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    options?: IdentityCallOptions,
  ): Promise<ReadTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
}

export interface IdentityListBinding<
  W extends WorkflowForFacet<"list">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_LIST_BINDING]: true;
  page(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    options?: IdentityCallOptions,
  ): Promise<ReadTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
  pages(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    options?: IdentityCallOptions,
  ): IdentityReadPageCursor<OperationOutput<PrimaryOperationOf<W>>>;
}

export interface IdentityResolvedReadBinding<
  W extends WorkflowForFacet<"resolvedRead">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_RESOLVED_READ_BINDING]: true;
  resolve(
    input: Readonly<OperationInput<Extract<AuxiliaryGetOf<W>, keyof IdentityReadOperations>>>,
    options?: IdentityCallOptions,
  ): Promise<
    ReadTransportOutcome<OperationOutput<Extract<AuxiliaryGetOf<W>, keyof IdentityReadOperations>>>
  >;
  read(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    options?: IdentityCallOptions,
  ): Promise<ReadTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
}

export interface IdentityDirectMutationBinding<
  W extends WorkflowForFacet<"directMutation">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_DIRECT_MUTATION_BINDING]: true;
  mutate(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    scope: MutationExecutionScope<W>,
    options?: IdentityCallOptions,
  ): Promise<MutationTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
}

export interface IdentityCurrentStateMutationBinding<
  W extends WorkflowForFacet<"currentStateMutation">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_CURRENT_STATE_MUTATION_BINDING]: true;
  readCurrent(
    input: Readonly<OperationInput<Extract<AuxiliaryGetOf<W>, keyof IdentityReadOperations>>>,
    options?: IdentityCallOptions,
  ): Promise<
    ReadTransportOutcome<OperationOutput<Extract<AuxiliaryGetOf<W>, keyof IdentityReadOperations>>>
  >;
  mutate(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    scope: MutationExecutionScope<W>,
    options?: IdentityCallOptions,
  ): Promise<MutationTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
}

export interface IdentityCompatibilityGuardedUpdateBinding<
  W extends WorkflowForFacet<"compatibilityGuardedUpdate">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_COMPATIBILITY_GUARDED_UPDATE_BINDING]: true;
  readCompatibilityGuardedCurrent(
    input: Readonly<OperationInput<Extract<AuxiliaryGetOf<W>, keyof IdentityReadOperations>>>,
    options?: IdentityCallOptions,
  ): Promise<
    ReadTransportOutcome<OperationOutput<Extract<AuxiliaryGetOf<W>, keyof IdentityReadOperations>>>
  >;
  mutate(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    scope: MutationExecutionScope<W>,
    options?: IdentityCallOptions,
  ): Promise<MutationTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
}

export interface IdentityBindingFactory<W extends IdentityWorkflowId> extends WorkflowBranded<W> {
  create(options?: IdentityCallOptions): Promise<BindingCreationOutcome<W>>;
}

export type BindingCreationOutcome<W extends IdentityWorkflowId> =
  | Readonly<{ kind: "created"; binding: BindingFor<W> }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "credentialRefreshRequired" }>
  | Readonly<{ kind: "internalFailed"; error: InternalIdentityError }>;
```

The workflow alone derives the primary operation, auxiliary Get, input, output, facet, and policy.
There is no independent operation, input, output, or policy generic. Factory construction owns partial
resources until `created` and never rejects.

Mutation handling marks exact handler invocation, observes complete response, advances certainty only
on exact status plus normal bounded completion, and returns payload-free transport failure
discriminants.

- [ ] **Step 4: Wire the thin core adapter**

`src/core/identity.tsx` maps unbranded transport closures into consumer-owned nominal constructors.
`CoreClient` exposes factory creation/composition, not a broad Identity CRUD client.

- [ ] **Step 5: Verify**

```bash
bun test src/core/identity
bun run verify:tsc
```

- [ ] **Step 6: Commit**

```bash
git add src/core/identity.tsx src/core/identity src/core/index.tsx test/compile/identity-binding-facets.ts
git commit -m "feat(identity): add operation-bound SDK bindings"
```

## Task 8: Transport Review Gate

- [ ] **Step 1: Run verification**

```bash
bun test src/core/identity src/handlers/identity/domain
bun run build
bun run verify:tsc
bun run format:check
git diff --check
```

- [ ] **Step 2: Run `openai.gpt-5.6-sol` factual/API and architecture reviews**

Review pinned SDK behavior, middleware ordering, statuses, retries, wire schemas, map registry, endpoint
precedence, credential ownership, pagination, and facet substitution. Fix and repeat until both pass.

- [ ] **Step 3: Push**

```bash
git push origin feat/identity-cli
```
