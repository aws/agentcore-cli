# AgentCore Identity CLI and TUI Design

**Date:** 2026-07-14

**Status:** Design complete, pending implementation planning

## Summary

Add a first-class `agentcore identity` command group to the redesigned AgentCore CLI. The feature
manages OAuth2, API-key, and payment credential providers, workload identities, and the default token
vault through the public AgentCore control-plane SDK. It includes a complete curated Ink TUI and a
complete scriptable command surface.

Identity resources are standalone control-plane resources. They do not use `agentcore.json`, project
state, reconciliation, CDK, or persisted local secrets.

This document is authoritative for implementation. The investigation documents outside this
repository remain useful evidence, but their old implementation sequencing and TUI deferral are
superseded by this design.

## Goals

- Provide complete CRUD management for OAuth2, API-key, payment credential providers, and workload
  identities.
- Provide token-vault inspection and CMK configuration.
- Provide complete tag lifecycle support for taggable Identity resources.
- Provide a curated TUI for common create, inspect, list, update, delete, and tag workflows.
- Keep the full SDK-native CLI surface available for advanced configuration.
- Support all 25 OAuth2 vendors in the installed control-plane SDK.
- Make provider additions deliberate, compile-time visible, and inexpensive to implement.
- Prevent secrets from being persisted or exposed through output, errors, review screens, fixtures,
  or logs.
- Preserve existing configuration during updates whenever the service API makes that possible.
- Reuse one domain and action layer from Commander handlers and Ink screens.
- Tolerate unknown future providers on reads while rejecting unsupported writes.

## Non-Goals

- No project-scoped configuration file or `agentcore.json` integration.
- No desired-state reconciliation.
- No local secret persistence.
- No local OAuth callback server.
- No production token-vending workflow in the CLI.
- No payment manager or payment connector commands under Identity. Those belong to a separate
  Payments command group.
- No hand-written Identity catalog in a high-level SDK until another concrete consumer needs it.
- No schema-generated TUI.
- No live mutation of the singleton token-vault CMK in routine automated tests.

## Settled Product Decisions

- Commands use `agentcore identity <resource> <verb>`.
- The CLI calls the raw `@aws-sdk/client-bedrock-agentcore-control` client.
- The TUI follows the Harness approach: complete for normal resource management, curated rather
  than a visual editor for every nested SDK member.
- Advanced nested structures use one-shot SDK-native JSON arguments.
- Omitted update fields mean unchanged. Clearing requires an explicit clear option.
- Pagination follows the Harness model and never silently truncates results.
- Literal secret flags remain available for compatibility and automation, but emit a warning.
- Prompt, stdin, environment, file, and external Secrets Manager references are preferred.
- Payment credential providers remain under Identity.
- The payment provider API's preview label is visible in help and the TUI, but does not hide, gate, or
  defer its CLI, TUI, or test coverage.
- Payment manager and connector resources belong to Payments.

## Command Surface

```text
agentcore identity
|-- oauth2-provider
|   |-- create
|   |-- get
|   |-- list
|   |-- update
|   |-- delete
|   |-- tag
|   |-- untag
|   `-- list-tags
|-- api-key-provider
|   |-- create
|   |-- get
|   |-- list
|   |-- update
|   |-- delete
|   |-- tag
|   |-- untag
|   `-- list-tags
|-- payment-provider
|   |-- create
|   |-- get
|   |-- list
|   |-- update
|   |-- delete
|   |-- tag
|   |-- untag
|   `-- list-tags
|-- workload-identity
|   |-- create
|   |-- get
|   |-- list
|   |-- update
|   |-- delete
|   |-- tag
|   |-- untag
|   `-- list-tags
`-- token-vault
    |-- get
    `-- set-cmk
```

Resource commands accept names and resolve ARNs internally for tag operations. Commands that already
have an ARN may accept it directly where the repository's option conventions support both forms.

All read commands support the repository's JSON renderer. Commander list commands return one service
page by default and accept `--next-token` and `--max-results`. Scripts opt into complete traversal with
`--all`.

## Architecture

Identity uses four conceptual layers with one-way dependencies:

```text
Commander handlers and Ink screens
                |
        application actions
                |
      pure Identity domain modules
                |
       CoreIdentityClient transport
```

### Transport Layer

`src/core/identity.tsx` is a thin raw-SDK adapter that follows the repository's existing core-client
file convention. It:

- Sends typed SDK commands.
- Applies the shared region and endpoint configuration.
- Exposes page-oriented list operations.
- Exposes generated-paginator all-results operations for every paginated Identity list.
- Contains no provider classification, secret prompting, update merging, or UI policy.

`CoreIdentityClient` is the consumer-owned interface in the Identity handler boundary. The production
client and test client both implement it.

### Domain Layer

`src/handlers/identity/domain/` contains pure modules for:

- OAuth provider descriptors and family adapters.
- Payment provider descriptors and adapters.
- Secret-slot definitions and secret input types.
- Request construction.
- Update planning and response normalization.
- SDK schema validation.
- Identity semantic validation.
- Schema-sensitive redaction.
- Safe error classification.

These modules may import SDK types and runtime schemas. They do not import Commander, Ink, React,
AWS clients, or filesystem implementations.

### Application Action Layer

`src/handlers/identity/actions/` contains resource-specific workflows shared by CLI and TUI:

- Resolve input intent.
- Fetch current state for updates.
- Determine unmet secret requirements.
- Resolve secret values.
- Construct and validate the SDK request.
- Produce a redacted review model.
- Invoke `CoreIdentityClient`.
- Return a renderable result or a structured local error.

There is no generic workflow engine. OAuth and payment share catalog machinery because their unions
justify it. API-key, workload identity, token vault, and tag actions remain direct resource-specific
functions.

### Presentation Layer

Commander handlers parse flags into typed intents and invoke actions. Ink screens collect the same
intents and invoke the same actions. Neither layer constructs SDK unions or implements update merge
logic.

Resource directories follow the existing repository organization:

```text
src/handlers/identity/
|-- index.tsx
|-- screen.tsx
|-- types.ts
|-- domain/
|-- actions/
|-- oauth2-provider/
|-- api-key-provider/
|-- payment-provider/
|-- workload-identity/
`-- token-vault/
```

Verb-specific screen and handler files follow the established Harness layout. New domain and action
files without JSX use `.ts`; router, screen, and core-client files follow the repository's existing
`.tsx` convention.

## Provider Catalog

### SDK-Owned Facts

The generated SDK remains authoritative for:

- Enum values.
- Request and response types.
- Runtime structure and union schemas.
- Required-member metadata present in the installed SDK.
- Sensitive traits.
- Generated paginators.

The CLI uses the official `@aws-sdk/config/typecheck` validator for structural request validation and
`NormalizedSchema` from `@smithy/core/schema` for supported schema traversal. Both are direct
dependencies if imported. The implementation does not use Smithy's internal `schemaLogFilter` or
read static schema tuple indexes directly.

SDK runtime validation is not treated as complete. CLI validation additionally enforces:

- Exactly one union member.
- Known enum values.
- Regex and length constraints needed for fast feedback.
- Vendor-to-config-member compatibility.
- Live service requirements missing from the model.
- Conditional secret requirements.

### CLI-Owned Facts

The CLI owns only facts the generated model does not express:

- Stable command slugs.
- Human-readable labels and descriptions.
- OAuth family classification.
- Named vendor to union-member mapping.
- Per-tenant endpoint requirements.
- Microsoft tenant input and update recovery.
- TUI field presentation.
- Live-only service exceptions.

The OAuth catalog is compile-time exhaustive:

```ts
const OAUTH_PROVIDERS = {
  // one deliberately classified descriptor per SDK enum value
} satisfies Record<CredentialProviderVendorType, ProviderDescriptor>;
```

An SDK vendor addition fails compilation until it is classified and tested.

### OAuth Families

The 25 SDK vendors map to four shared adapters.

#### Named

Each named provider uses its dedicated SDK union member:

- Google
- GitHub
- Slack
- Salesforce
- Microsoft
- Atlassian
- LinkedIn

Common fields are client ID and client secret configuration. Microsoft additionally accepts an
optional tenant ID. On create, omitted tenant ID selects the service default. Resetting an existing
tenant-specific provider requires an explicit clear operation.

#### Included Per-Tenant

These providers use `includedOauth2ProviderConfig` and require issuer, authorization endpoint, and
token endpoint:

- Okta
- Cognito
- Auth0
- CyberArk
- FusionAuth
- OneLogin
- PingOne

#### Included Global

These providers use `includedOauth2ProviderConfig` and service-known discovery:

- X
- Dropbox
- Facebook
- HubSpot
- Notion
- Reddit
- Spotify
- Twitch
- Yandex
- Zoom

#### Custom

Custom OAuth supports:

- Discovery URL or authorization-server metadata.
- Client ID and conditional client secret.
- Client authentication method.
- On-behalf-of token exchange configuration.
- Private endpoint and override configuration.
- Other SDK-native nested members available in the pinned public model.

Rare nested structures remain SDK-native JSON inputs.

### Payment Providers

Payment has two vendor adapters:

- Coinbase CDP: API key ID, API key secret, wallet secret.
- Stripe/Privy: app ID, app secret, authorization private key, authorization ID.

Each vendor has exactly two secret slots. Authorization ID is a non-secret field.

## Input Model

Commander and TUI produce typed domain intents, not SDK requests:

```ts
CreateOauth2Intent;
UpdateOauth2Intent;
CreateApiKeyIntent;
UpdateApiKeyIntent;
CreatePaymentIntent;
UpdatePaymentIntent;
CreateWorkloadIdentityIntent;
UpdateWorkloadIdentityIntent;
SetTokenVaultCmkIntent;
```

### Curated Mode

Curated mode exposes stable scalar options and narrowly scoped JSON options. Examples include:

- `--name`
- `--vendor`
- `--client-id`
- `--tenant-id`
- `--issuer`
- `--authorization-endpoint`
- `--token-endpoint`
- `--discovery-url`
- `--discovery-json`
- `--on-behalf-of-json`
- `--private-endpoint-json`
- `--private-endpoint-overrides-json`
- `--return-url`
- `--tags-json`

Payment options are slot-specific so independent secret sources cannot be confused.

### Raw Mode

Create commands use `--config-json` for a complete SDK-native provider config union. Update commands
use the deliberately different `--replace-config-json` name. It replaces all non-secret provider
configuration represented by that union; it is not a patch and does not inherit omitted non-secret
members from the current resource.

Both options are mutually exclusive with curated non-secret provider options and clear options.
Secret slots remain under the shared secret resolver: existing EXTERNAL references can be preserved
when omitted, while service-required MANAGED values must be supplied again. Known secret inputs may
fill sensitive paths omitted from raw JSON. If raw JSON and a secret input both target the same path,
the command fails with a conflict error. Sensitive values embedded directly in JSON are accepted as
literal input with the same warning and redaction guarantees as literal secret flags.

The implementation performs adapter-owned composition at known secret paths; it does not implement a
generic deep-merge engine.

The chosen vendor must match the supplied union member. Unknown keys, multiple union members, and
vendor mismatches fail before an AWS call.

## Secret Handling

Secret handling separates value acquisition from AgentCore storage mode.

### CLI Value Acquisition

A managed secret value can come from exactly one source:

- Hidden interactive prompt.
- Standard input.
- Named environment variable.
- File.
- Literal option value.

Literal values are accepted but produce a warning because shell history and process inspection can
expose them.

Only one secret slot may claim stdin in a command. File input preserves content and does not broadly
trim whitespace or newlines, which is required for key material.

### AgentCore Storage Mode

Each secret slot resolves to one of:

- `MANAGED`: send the resolved value to AgentCore.
- `EXTERNAL`: send a Secrets Manager `SecretReference`; the CLI does not read the external value.

The resolver enforces mutual exclusivity between managed values and external references.

The current service does not allow a populated secret slot to switch between `MANAGED` and
`EXTERNAL` during update. This applies to API keys, OAuth client secrets, and each payment secret slot
independently. The CLI detects a requested switch after `Get` and fails before mutation. It explains
that the user must create a replacement provider, update its consumers, and then delete the old
provider. It never automates a non-atomic delete and recreate.

Secret values:

- Exist only in transient action state.
- Are never written to project or user configuration.
- Are never included in review models.
- Are never emitted to stdout or stderr.
- Are value-redacted from any optional diagnostic rendering.

## Request Flow

Create actions execute in this order:

1. Resolve the descriptor.
2. Parse scalar and JSON input.
3. Reject conflicting input.
4. Resolve secret inputs.
5. Build the exact SDK union member.
6. Run SDK structural validation.
7. Run CLI semantic validation.
8. Build a redacted review model.
9. Send through `CoreIdentityClient`.

Update actions first fetch and normalize the current resource, then apply only explicit patch intent.
The planner returns either:

- A complete validated request.
- Structured unmet requirements identifying the exact secret slots or fields still needed.

Ink uses unmet requirements to open the appropriate prompt. Noninteractive Commander execution
reports accepted options for every missing value.

## Update Semantics

### Common Rules

- Omitted update fields remain unchanged.
- Empty strings never implicitly mean clear.
- Clear operations are explicit.
- Immutable names and vendor types cannot change.
- Provider secret storage mode cannot change.
- Fetch and update are kept adjacent, but the CLI does not claim atomicity because the API exposes
  no customer-visible version token.

Curated mode exposes only service-valid clear operations:

- OAuth `--clear-tenant-id` resets Microsoft to service-default discovery.
- Custom OAuth `--clear-client-id`, `--clear-client-secret`,
  `--clear-client-authentication-method`, and `--clear-on-behalf-of` remove those optional values only
  when the resulting configuration passes semantic validation.
- Custom OAuth `--clear-private-endpoint-overrides` sends an empty override list while preserving the
  required private endpoint.
- Workload identity `--clear-return-urls` sends an empty return-URL list.

JSON options are replacement units. For example, explicitly supplying an empty overrides array
clears the override collection. Clear options are mutually exclusive with the corresponding value or
JSON option. The CLI does not offer clears for names, vendors, required discovery or per-tenant
endpoints, API keys, payment secrets, or private endpoints. The service prohibits removing an
existing private endpoint.

### OAuth

The service rebuilds OAuth configuration from the update request. It does not provide a general
preserve-on-omission contract for client secrets: omission can fail validation for a secret-bearing
authentication method, and changing to a no-secret method can remove an existing managed secret.
The CLI therefore:

- Fetches the current provider.
- Rehydrates all readable non-secret configuration.
- Applies the explicit patch.
- Preserves an EXTERNAL client-secret reference by reconstructing it from `Get`.
- Requires secure re-entry of a MANAGED client secret whenever the effective authentication method
  still requires one.
- Never removes a client secret unless the user supplied `--clear-client-secret` and the resulting
  custom OAuth authentication configuration permits no secret.
- Resends required private endpoint and per-tenant endpoint fields.

Microsoft `Get` output does not return tenant ID. For an existing tenant-specific provider, the CLI
may recover it only from the exact canonical Microsoft discovery URL pattern. If the URL is not
recognized, update requires explicit `--tenant-id`; it never silently resets to default discovery.

An older SDK may not deserialize a future output member. This is a residual limitation of the
service's replacement semantics. SDK drift tests reduce the window but cannot provide atomic
forward compatibility. Service-side patch semantics remain the permanent improvement.

### Payment

The service currently requires every managed secret in a payment update, including when only a
non-secret identifier changes.

The CLI handles this without blocking the feature:

- Rehydrate all non-secret fields from `Get`.
- Preserve each reconstructable EXTERNAL reference from its ARN, source, and JSON key.
- Require the user to supply every MANAGED secret slot again.
- Require explicit storage mode if `Get` does not identify it.
- Reject a storage-mode switch for either slot.
- Build the complete vendor configuration.

For Coinbase this means API key secret and wallet secret. For Stripe/Privy this means app secret and
authorization private key.

### API Key

API-key update is credential rotation. It always requires a new managed value or a valid external
reference in the provider's existing storage mode.

### Workload Identity

The service replaces the complete return-URL list. The CLI supports three explicit intents:

- Omitted: keep current URLs.
- Replacement list: replace with the supplied URLs.
- Clear: send an empty list through an explicit clear option.

The TUI loads the current list and edits it as a complete collection.

### Token Vault

`get` defaults to the service's `default` vault. `set-cmk` validates:

- `CustomerManagedKey` requires a KMS key ARN.
- `ServiceManagedKey` does not accept a KMS key ARN.

The TUI requires destructive-change confirmation before sending `set-cmk`.
Commander also confirmation-gates `set-cmk`: an interactive terminal prompts unless `--yes` is
present, and noninteractive execution fails before the AWS call unless `--yes` is present. `--json`
does not imply consent.

## Pagination

The transport exposes distinct operations:

- `listPage`: one service page plus `nextToken`, used by TUI pickers and paged CLI output.
- `listAll`: generated paginator consumption, used by Commander `--all`, cleanup, and completeness
  checks.

`--all` is mutually exclusive with `--next-token`. `--max-results` remains the service page size, not
an aggregate result limit. All-results JSON uses the normal response envelope with one concatenated
item array and no `nextToken`. No list method silently changes from page semantics to all-results
semantics. Tests cover both.

## Unknown Future Providers

Reads are forward-compatible:

- Unknown vendor values display as raw strings.
- Unknown config members display through generic JSON rendering.
- List and get do not crash because a catalog entry is absent.

Writes are fail-closed:

- Create and update require a known descriptor.
- A newly generated SDK vendor breaks compile-time exhaustiveness.
- A newly generated union member breaks schema contract tests.

## TUI Design

Bare Identity and resource commands mount Ink screens using the existing
`withTuiOnEmptyFlagsAndArgs` pattern.

The TUI includes:

- Identity resource menu.
- Paged resource pickers.
- OAuth create and update wizard driven by family descriptors.
- API-key create and rotate flows.
- Payment create and update flows with independent secret prompts.
- Workload identity create and return-URL editing.
- Token-vault inspection and confirmed CMK change.
- Detail screens with status and failure reason where available.
- Delete confirmation.
- Tag list, add, and remove workflows.
- Redacted review steps before mutations.
- Loading, empty, error, cancellation, and success states.

The TUI does not expose a visual editor for every recursive SDK structure. Advanced nested OAuth and
payment configuration remains available through CLI JSON options. This matches Harness: common
workflows are ergonomic without reducing command completeness.

Payment menus and screens are present unconditionally and carry a visible `Preview` label. Preview
status never substitutes for a missing screen or workflow.

## Errors

One Identity error formatter handles local and service failures.

Local errors:

- Identify the option, secret slot, or schema path.
- Explain conflicting input.
- List accepted ways to supply missing secrets.
- Fail before mutation.

Service errors:

- Include an allowlisted modeled error code.
- May include HTTP status and request ID.
- Map known cases to static actionable guidance.
- Do not serialize the entire exception.
- Do not print arbitrary raw HTTP response bodies.
- Do not trust an unknown service message to be free of echoed input.

Any future debug output applies both schema-sensitive redaction and exact resolved-value redaction.

## Secret-Safe Record and Replay

The current fixture recorder hashes the complete SDK input and stores service error messages
verbatim. Identity must not use that behavior unchanged.

Before recording Identity writes:

- Traverse the command input schema and replace sensitive leaves with stable path markers before
  deriving the fixture key.
- Add a deterministic occurrence suffix when multiple calls have the same redacted key.
- Sanitize stored error information before writing it.
- Never store a raw request body.
- Keep existing non-sensitive fixture names stable where their redacted input is unchanged.

Tests use high-entropy sentinel values and recursively scan:

- stdout
- stderr
- golden files
- SDK fixtures
- filenames
- serialized errors

The sentinel must not appear in any artifact.

## Testing Strategy

### Domain Unit Tests

- Every SDK OAuth vendor has exactly one descriptor.
- Slugs are unique.
- Every named config member exists in the SDK union schema.
- All 25 vendors build the expected union member.
- Family-specific required fields are enforced.
- Microsoft tenant recovery accepts only the canonical URL pattern.
- Union cardinality and vendor matching are enforced.
- Raw and curated input conflicts are rejected.
- Create raw configuration and update replacement configuration have distinct semantics.
- Every secret acquisition and storage-mode combination is covered.
- Multiple stdin consumers are rejected.
- All sensitive paths are redacted.
- MANAGED-to-EXTERNAL and EXTERNAL-to-MANAGED updates fail before mutation for every secret slot.
- Payment update requirements distinguish managed and external slots.
- Every supported explicit clear is distinct from omission, and prohibited clears are rejected.
- Workload unchanged, replace, and clear intents are distinct.
- Unknown vendors render on reads and fail on writes.

### Transport and Action Tests

- Every SDK operation selects the correct command.
- Region and endpoint options propagate.
- Page operations preserve `nextToken`.
- All-results operations consume generated paginators.
- Actions fetch before replacement-style updates.
- Actions do not fetch unnecessarily for direct mutations.
- Tag actions resolve and use the resource ARN.
- Error mapping does not expose complete exception objects.

### Commander Tests

- Every verb parses required and optional flags.
- Every resource supports JSON rendering.
- Missing and conflicting inputs fail with actionable messages.
- Literal secret values warn without echoing the value.
- Advanced JSON accepts valid SDK-native structures and rejects invalid structures.
- Omitted update fields remain absent from intent.
- List defaults to one page; `--all` traverses all pages and conflicts with `--next-token`.
- Noninteractive `token-vault set-cmk` requires `--yes`.

### Ink Screen Tests

- Every resource and verb route mounts.
- OAuth fields change with provider family.
- Microsoft tenant input appears only where applicable.
- Secret storage mode changes the visible controls.
- Payment update asks again for all managed secret slots.
- External references are preserved without requesting their values.
- Workload return URLs can be added, removed, replaced, and cleared.
- Pickers navigate service page tokens.
- Review screens contain no secrets.
- Cancellation makes no mutation call.
- Delete and CMK changes require confirmation.
- Empty, loading, failure, and success states render correctly.

### SDK Drift Tests

- Runtime SDK enum values equal catalog keys.
- Runtime OAuth and payment union member names equal reviewed expectations.
- SDK-sensitive paths are either automatically redacted or covered by explicit secret slots.
- Compile-time exhaustive records fail on a new enum value.

### Golden Tests

Record/replay tests exercise the real root router, middleware, action, transport, and renderer seams.
Sensitive write fixtures use schema-redacted keys. Read and mutation output fixtures contain only
service-safe response data.

### Live Tests

Live tests run only with explicit recording/integration configuration and:

```text
AWS_PROFILE=deploy
AWS_REGION=us-east-1
```

The test matrix includes:

- Named OAuth create/get/update/delete.
- Included per-tenant OAuth create/get/update/delete.
- Included global OAuth create/get/update/delete.
- Custom OAuth create/get/update/delete.
- Microsoft tenant-specific update preservation.
- API-key MANAGED create/rotate/delete.
- API-key EXTERNAL create/update/delete with a temporary Secrets Manager secret.
- Workload identity return-URL create/update/clear/delete.
- Coinbase and Stripe/Privy payment create/get/update/delete behavior in the preview-capable deploy
  account and region; preview status is not a reason to omit or skip this matrix.
- Tag, list-tags, and untag on temporary resources.
- Page-token traversal with a deliberately small `maxResults`.
- Default token-vault read.

Every live test:

- Uses a unique `acci-` resource prefix.
- Owns any temporary Secrets Manager resources it creates.
- Cleans up in `finally`.
- Performs a final paginated sweep.
- Fails if prefixed resources or temporary secrets remain.
- Scans captured output for sentinel secrets.

Routine automation does not mutate the singleton token-vault CMK. Its request construction,
confirmation, and error behavior are exhaustively tested with fakes because a live CMK change affects
unrelated account resources.

## Upstream Service Improvements

These improvements are valuable but do not block the CLI:

- Payment update should preserve omitted managed secrets.
- OAuth update should preserve omitted managed secrets when the authentication method is unchanged.
- OAuth and payment updates should have service-side patch semantics.
- Microsoft OAuth output should return tenant ID.
- Create and update should use separate modeled input shapes where their requirements differ.
- The service model should document vendor-to-config compatibility and live-required fields.

The CLI does not hide current service behavior, but it also does not wait for these changes.

## Dependencies

No framework change is required. Expected direct dependencies are:

- Existing `@aws-sdk/client-bedrock-agentcore-control`.
- Existing `@aws-sdk/client-bedrock-agentcore`.
- Existing Commander, Ink, React Query, and Zod packages.
- `@aws-sdk/config` for supported runtime schema validation.
- `@smithy/core` for supported normalized schema traversal.

Dependency versions remain aligned with the installed AWS SDK generation.

## Acceptance Criteria

- Every command in the command surface is mounted and tested.
- Every common command has an Ink route and complete normal workflow.
- All 25 pinned OAuth vendors are supported.
- OAuth family and payment adapter contracts are exhaustive.
- Advanced SDK-native JSON is available without a generic deep merge.
- Omitted updates preserve existing state where possible.
- OAuth updates clearly collect a required MANAGED client secret again and preserve a reconstructable
  EXTERNAL reference.
- Payment updates clearly collect every required managed secret again.
- Unknown future providers render safely on reads and fail safely on writes.
- Pagination never silently truncates.
- Complete tag lifecycle works.
- No secret reaches output, error artifacts, fixture content, or fixture identity.
- Unit, router, action, screen, golden, and build checks pass.
- `bunx tsc --noEmit` introduces no diagnostics in Identity or other touched files and does not exceed
  the measured pre-implementation baseline of 29 diagnostics in `src/components/ui/**`. Repairing
  that unrelated baseline is not part of this feature.
- Live integration coverage passes against the deploy account and leaves no resources.
- Planning and implementation receive independent `gpt5.6-sol` reviews with no unresolved findings.
