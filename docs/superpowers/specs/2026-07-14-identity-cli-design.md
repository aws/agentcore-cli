# AgentCore Identity CLI and TUI Design

**Date:** 2026-07-14

**Status:** Design approved, pending implementation planning

## Summary

Add a first-class `agentcore identity` command group to the redesigned AgentCore CLI. The feature
manages OAuth2, API-key, and payment credential providers, workload identities, and the default token
vault through the public AgentCore control-plane SDK. It includes a complete curated Ink TUI and a
complete scriptable command surface.

Identity resources are standalone control-plane resources. They do not use `agentcore.json`, project
state, reconciliation, CDK, or persisted local secrets.

The implementation targets the installed and locked
`@aws-sdk/client-bedrock-agentcore-control@3.1079.0`. Runtime schemas, generated types, generated
paginators, and enums from that version define the public SDK contract. Confirmed service behavior
supplements the model where the model is incomplete.

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
- The TUI follows the Harness approach: complete for normal resource management and intentionally
  omits a visual editor for recursive SDK members.
- Advanced nested structures use one-shot SDK-native JSON arguments.
- Omitted update fields mean unchanged. Clearing requires an explicit clear option.
- Pagination follows the Harness model and never silently truncates results.
- Literal secret flags remain available for compatibility and automation, but emit a warning.
- Prompt, stdin, environment, file, and external Secrets Manager references are preferred.
- Mutation review plans are immutable and contain no secret values.
- Update commits re-read current state and stop without mutation if guarded resource identity,
  effective mutation state, or secret requirements change.
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

### Common Command Contract

All provider and workload Get, Update, and Delete operations select resources with `--name`. Create
also uses `--name`. Token-vault commands use optional `--token-vault-id` and default to `default` when
it is omitted.

Tag commands accept exactly one selector:

- `--name <name>` resolves the resource through its Get operation and extracts its ARN. Tag and Untag
  re-run that Get immediately before mutation and require target-identity continuity.
- `--resource-arn <arn>` validates the ARN locally and sends that exact ARN directly to Tag, Untag, or
  List Tags. It does not issue Get or STS calls first; AWS authorization decides whether a
  syntactically valid cross-account request is allowed.

Direct ARN validation uses a structured parser, not substring matching:

| Resource family   | Required resource component                                           |
| ----------------- | --------------------------------------------------------------------- |
| OAuth2 provider   | `token-vault/<vault-id>/oauth2credentialprovider/<name>`              |
| API-key provider  | `token-vault/<vault-id>/apikeycredentialprovider/<name>`              |
| Payment provider  | `token-vault/<vault-id>/paymentcredentialprovider/<name>`             |
| Workload identity | `workload-identity-directory/<directory-id>/workload-identity/<name>` |

The complete ARN must be
`arn:<partition>:bedrock-agentcore:<region>:<12-digit-account>:<resource-component>`.
`<partition>` must match `[a-z0-9-]+`; the service must be exactly `bedrock-agentcore`; the ARN region
must equal the resolved CLI region; and vault, directory, and resource names must pass their modeled
syntax. Workload Identity direct ARNs currently require `<directory-id>` to be exactly `default`
because the public Get and mutation APIs do not expose a directory selector. Normal commands do not
call STS only to compare the account segment, so a syntactically valid cross-account ARN reaches
normal AWS authorization. The parser is partition-agnostic and does not claim that AgentCore is
deployed in every syntactically valid partition.

The common leaf contracts are:

| Verb        | Required options                                 | Optional options                         | Commander behavior                                          |
| ----------- | ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| `create`    | Resource-specific                                | Resource-specific, `--tags <json>`       | Emits the normalized create response                        |
| `get`       | `--name`                                         | None                                     | Emits the normalized get response                           |
| `list`      | None                                             | `--next-token`, `--max-results`, `--all` | One page by default; all pages with `--all`                 |
| `update`    | `--name` and one mutation option                 | Resource-specific                        | Emits update response or current state for a semantic no-op |
| `delete`    | `--name`                                         | None                                     | Deletes immediately and emits `{}`                          |
| `tag`       | Exactly one selector, `--tags <json>`            | None                                     | Adds or replaces supplied keys and emits `{}`               |
| `untag`     | Exactly one selector, `--tag-keys <tag-keys...>` | None                                     | Removes supplied keys and emits `{}`                        |
| `list-tags` | Exactly one selector                             | None                                     | Emits `{ "tags": { ... } }`                                 |

`--tags` follows the existing Harness spelling and accepts one JSON object. Create and `tag` reject an
empty object and each accepts at most 50 entries in its request. `tag` preserves keys absent from the
request and replaces values for keys present in the request. `untag` requires one to 200 unique,
non-empty keys. Tag keys contain one to 128 characters and values contain zero to 256 characters.
Update does not accept `--tags`; callers use `tag` and `untag`.

Live probes on July 14, 2026 confirmed Tag, Untag, and List Tags against real OAuth2, API-key,
payment, and workload Identity ARNs. Generated Tag documentation that lists only older AgentCore
resource families is stale.

List page sizes use the modeled ranges. The CLI sends a default of 10 so behavior does not depend on
the service's unmodeled omission behavior:

| Resource          | `--max-results` range | CLI default sent |
| ----------------- | --------------------: | ---------------: |
| API-key provider  |              1 to 100 |               10 |
| OAuth2 provider   |               1 to 20 |               10 |
| Payment provider  |               1 to 20 |               10 |
| Workload identity |               1 to 20 |               10 |

`--all` conflicts with `--next-token`. `--max-results` remains the service page size when `--all` is
set.

### Resource Options

OAuth2 provider commands use these non-secret options:

| Command         | Options                                                                            |
| --------------- | ---------------------------------------------------------------------------------- |
| `create`        | `--name`, `--vendor`, curated config options or `--config-json`, optional `--tags` |
| `update`        | `--name`, curated patch and clear options or `--replace-config-json`               |
| `get`, `delete` | `--name`                                                                           |
| `list`          | Common list options                                                                |

The stable OAuth vendor slugs are `atlassian`, `auth0`, `cognito`, `custom`, `cyberark`, `dropbox`,
`facebook`, `fusionauth`, `github`, `google`, `hubspot`, `linkedin`, `microsoft`, `notion`, `okta`,
`onelogin`, `pingone`, `reddit`, `salesforce`, `slack`, `spotify`, `twitch`, `x`, `yandex`, and
`zoom`.

Curated OAuth options are:

- `--client-id`
- `--tenant-id`
- `--issuer`
- `--authorization-endpoint`
- `--token-endpoint`
- `--discovery-url`
- `--discovery-json`
- `--client-authentication-method`
- `--on-behalf-of-json`
- `--private-endpoint-json`
- `--private-endpoint-overrides-json`

OAuth update also supports `--clear-tenant-id`, `--clear-client-id`, `--clear-client-secret`,
and `--clear-on-behalf-of` under the validity rules in Update Semantics. Curated mode does not expose
an unverified clear for client authentication method, private endpoint, or private endpoint
overrides. The replacement JSON surface remains available for SDK-native configurations. There is no
Identity-level `--grant-type`; grant values occur only inside custom OAuth `--on-behalf-of-json`.

Create applicability is exact. `R` means required, `O` means optional, `A` means one complete
discovery alternative is required, `C` means conditionally required as described below, and `F`
means rejected for that family:

| Curated Create option               | Named except Microsoft | Microsoft | Included per-tenant | Included global | Custom |
| ----------------------------------- | ---------------------- | --------- | ------------------- | --------------- | ------ |
| `--client-id`                       | R                      | R         | R                   | R               | O      |
| `--tenant-id`                       | F                      | O         | F                   | F               | F      |
| `--issuer`                          | F                      | F         | R                   | F               | A      |
| `--authorization-endpoint`          | F                      | F         | R                   | F               | A      |
| `--token-endpoint`                  | F                      | F         | R                   | F               | A      |
| `--discovery-url`                   | F                      | F         | F                   | F               | A      |
| `--discovery-json`                  | F                      | F         | F                   | F               | A      |
| `--client-authentication-method`    | F                      | F         | F                   | F               | C      |
| `--on-behalf-of-json`               | F                      | F         | F                   | F               | O      |
| `--private-endpoint-json`           | F                      | F         | F                   | F               | O      |
| `--private-endpoint-overrides-json` | F                      | F         | F                   | F               | O      |

For custom Create, the discovery alternatives are exactly one of `--discovery-url`,
`--discovery-json`, or the complete three-option issuer/authorization/token tuple. Partial tuples and
multiple alternatives fail. Curated Create requires `--client-authentication-method` unless
`--discovery-json` supplies
`authorizationServerMetadata.tokenEndpointAuthMethods`; supplying both is a local conflict. Raw
custom Create may omit both mechanisms because the pinned model permits it; the CLI treats that
service-defined default as secret-bearing and requires a client secret whenever `clientId` is
present.

Curated Update accepts an explicit patch only where the Create table contains `R`, `O`, or `A`.
Omission preserves the current value. Updating per-tenant endpoints requires the complete
issuer/authorization/token tuple. Updating custom discovery requires one complete discovery
alternative. Syntax and cross-option conflicts fail before Get; family-inapplicable options fail after
the current vendor is read and before secret acquisition. `--replace-config-json` is the alternative
for every family, must contain the member for the current vendor, and conflicts with every curated
non-secret and clear option.

Custom OAuth has two mutually exclusive authentication-mechanism surfaces: the preferred
`clientAuthenticationMethod` and legacy
`authorizationServerMetadata.tokenEndpointAuthMethods`. Current AWS documentation states that a
request containing both fails validation. Curated Update preserves the current mechanism when neither
surface is supplied. Supplying either mechanism explicitly replaces the other: an explicit
`--client-authentication-method` removes a preserved legacy method list, while an explicit
`--discovery-json` method list omits the current preferred method. The changed effective discovery and
mechanism appear in the review model. Raw custom Update requires exactly one of the two mechanisms so
a complete replacement cannot silently preserve or reset authentication behavior. These conflicts
are validated on the effective request before any secret acquisition.

If a current legacy method list is preserved while metadata endpoints change, the list is rehydrated
into the replacement metadata even when the new JSON omitted it. A legacy list cannot be represented
with a `discoveryUrl`; changing a legacy provider to URL discovery therefore also requires an explicit
preferred `--client-authentication-method`. If a current provider exposes neither mechanism, curated
Update likewise requires an explicit preferred method instead of guessing the service default.

API-key provider commands use:

| Command         | Options                                                    |
| --------------- | ---------------------------------------------------------- |
| `create`        | `--name`, API-key secret source options, optional `--tags` |
| `update`        | `--name`, API-key secret source options                    |
| `get`, `delete` | `--name`                                                   |
| `list`          | Common list options                                        |

API-key Create requires one managed value source or one complete external reference.

Payment provider commands use:

| Command         | Options                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `create`        | `--name`, `--vendor`, vendor fields or `--config-json`, optional `--tags` |
| `update`        | `--name`, vendor patch fields or `--replace-config-json`                  |
| `get`, `delete` | `--name`                                                                  |
| `list`          | Common list options                                                       |

Payment vendor slugs are `coinbase-cdp` and `stripe-privy`. Coinbase uses `--api-key-id` plus API-key
secret and wallet-secret slots. Stripe/Privy uses `--app-id`, `--authorization-id`, app-secret, and
authorization-private-key slots. Update obtains the immutable vendor from Get; it does not expose a
vendor-change option.

Payment Create requires both secret slots for the chosen vendor. OAuth named and included-family
Create requires a client secret in MANAGED or EXTERNAL mode. Custom OAuth follows the authentication
method rules in Update Semantics.

Retained July 14, 2026 negative Create probes independently confirmed missing-value rejection for API
key, Google OAuth, both Coinbase slots, and both Stripe/Privy slots. These are live service
requirements supplementing the structurally optional generated members.

Workload identity commands use:

| Command         | Options                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `create`        | `--name`, optional `--return-url <url...>`, optional `--tags`             |
| `update`        | `--name`, exactly one of `--return-url <url...>` or `--clear-return-urls` |
| `get`, `delete` | `--name`                                                                  |
| `list`          | Common list options                                                       |

Create accepts zero to five return URLs. Update replacement accepts one to five. The service enforces
the five-URL limit even though the pinned public model omits the list cardinality constraint.

Token-vault commands use:

| Command   | Options                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `get`     | Optional `--token-vault-id`                                                                       |
| `set-cmk` | Optional `--token-vault-id`, required `--key-type`, conditional `--kms-key-arn`, optional `--yes` |

CLI key-type values are `customer-managed` and `service-managed`; the adapter maps them to
`CustomerManagedKey` and `ServiceManagedKey`.

### Output And Invocation

Every successfully executed Commander leaf emits exactly one JSON document to stdout, whether or not
`--json` is present. Empty Delete, Tag, and Untag SDK responses normalize to `{}`. A failed leaf emits
no success document. Warnings and static actionable errors use stderr and never corrupt stdout.
Execution is successful only after the complete stdout write settles; queuing bytes is not treated as
delivery.

`--json` selects noninteractive Commander execution. It disables TUI mounting, hidden
prompts, and confirmation prompts. It does not imply consent for `token-vault set-cmk`; that command
still requires `--yes` in noninteractive mode. Bare groups with `--json` retain the repository's
existing help behavior and are not executed leaves.

A bare Identity group, resource group, or leaf opens its Ink route when the user supplied no
leaf-specific option or positional argument and did not supply `--json`. Routing checks Commander's
option value source, not the parsed value, so boolean default values such as `false` do not count as
explicit input. A CLI-sourced leaf option, including a value equal to its default, selects Commander
mode. Global `--region`, `--endpoint-url`, and `--debug` alone do not; the TUI opens with those
settings. Global `--json` always selects Commander mode.

Explicit Commander Delete commands match Harness and do not accept or require `--yes`. TUI Delete
flows always confirm. `token-vault set-cmk` confirms in both presentations as described above.

The root router applies one execution policy to every compiled command, including every child added
with `addCommand`: injected stdout/stderr writers,
`configureOutput({ writeOut, writeErr, outputError: () => {} })`, default throwing `exitOverride()`,
and closed mapping of `CommanderError`. The override callback must not return, because Commander
otherwise falls through to `process.exit`. Suppressing `outputError` is required because Commander
writes raw parser text before invoking the exit override. Help and version exits with code zero remain
successful.

The process composition root installs one output supervisor before routing. It owns stdout/stderr
`error` and `close` listeners for the complete invocation lifetime, so no asynchronous stream failure
can become an unhandled event. Commander writes through an awaited document sink that permits one
in-flight chunk, catches synchronous write failures, and settles only after its callback reports
success and, when `write()` returned `false`, the corresponding `drain` event occurs. `error`, `close`
before settlement, callback failure, or caller cancellation while waiting for drain returns a closed
`outputUnavailable` result. The sink does not retry or split a JSON document. Static stderr writes
use a serialized awaited text sink under the same supervisor and are best-effort when reporting an
output failure.

The awaited writer surface is closed:

```ts
type OutputWriteOutcome = { kind: "written" } | { kind: "outputUnavailable" };

interface AwaitedOutputSink {
  writeUtf8(text: string, options?: IdentityCallOptions): Promise<OutputWriteOutcome>;
}
```

It never returns or throws the underlying stream error. The document sink accepts exactly one call per
Commander leaf; the diagnostic sink serializes calls. Serialization occurs before `writeUtf8`, and its
closed failure mapping is owned by the caller because no bytes were queued.

Ink retains its required terminal stream interface rather than pretending frame writes are one JSON
chunk. It receives supervisor-owned stream proxies that preserve write/backpressure behavior, suppress
raw `error` propagation, and notify the mounted presentation controller exactly once on terminal
failure. The controller synchronously latches output unavailable, unmounts, waits for Ink teardown,
and selects generic or known-commit static guidance for best-effort stderr. No new frame is accepted
after failure.

Successful JSON is completely serialized before the single awaited stdout write. The process entry
point assigns `process.exitCode` only after routing, awaited writes, and Ink teardown settle; it never
calls `process.exit`. If a mutation is already known committed, any later JSON serialization, stdout
write/drain, Ink frame, render, or presentation-state failure selects the same static
`committedOutputUnavailable` guidance used for an unusable 2xx result: the mutation committed, its
output is unavailable, and the user must perform a fresh Get before considering another mutation.
Query output failures use a static output-unavailable error without commit guidance. An `EPIPE` or
closed stderr may prevent guidance from being delivered, but remains contained and produces no stack
or automatic retry.

### Normalized V1 Output

Raw SDK command outputs never reach Commander renderers or Ink components. Actions convert them into
a branded JSON-only `SafeIdentityDocument` through centralized, operation-specific V1 allowlist
schemas:

```text
SDK CommandOutput
  -> action-private raw response
  -> internal normalized state
  -> SafeIdentityDocument
  -> Commander JSON or Ink view model
```

The contract is flat and preserves SDK field names; there is no `data` wrapper. Every operation omits
`$metadata`, undefined optional members, and unallowlisted fields recursively. A missing V1-required
member fails normalization with a static compatibility error rather than emitting a partial document.
Dates become ISO-8601 strings. Empty arrays and maps are preserved. Every dynamic string crosses the
terminal-safe encoder.
`--all` concatenates the normal collection and omits `nextToken`. A semantic no-op Update uses that
resource's Get normalizer. Delete, Tag, and Untag normalize to `{}`; List Tags always normalizes an
absent map to `{ "tags": {} }`.

Unknown output union members use exactly:

```json
{ "$unknown": "SafeMemberName" }
```

`SafeMemberName` permits ASCII letters, digits, period, underscore, colon, and hyphen, is capped at
128 characters, and falls back to `UNKNOWN`. The SDK `$unknown` tuple body is never traversed.

The output aliases are:

```text
S = injective terminal-safe dynamic string
K = S installed as a prototype-safe dynamic map key
D = ISO-8601 date string
Secret = exact { secretArn: S }
UnknownV1 = exact { $unknown: SafeMemberName }
SourceOut = S

AuthorizationServerMetadataOut = exact {
  issuer: S,
  authorizationEndpoint: S,
  tokenEndpoint: S,
  responseTypes?: S[],
  tokenEndpointAuthMethods?: S[]
}

DiscoveryOut =
  | exact { discoveryUrl: S }
  | exact { authorizationServerMetadata: AuthorizationServerMetadataOut }
  | UnknownV1

TokenExchangeGrantOut = exact {
  actorTokenContent: S,
  actorTokenScopes?: S[]
}

OnBehalfOfOut = exact {
  grantType: S,
  tokenExchangeGrantTypeConfig?: TokenExchangeGrantOut
}

SelfManagedLatticeResourceOut =
  | exact { resourceConfigurationIdentifier: S }
  | UnknownV1

ManagedVpcResourceOut = exact {
  vpcIdentifier: S,
  subnetIds: S[],
  endpointIpAddressType: S,
  securityGroupIds?: S[],
  tags?: Record<K,S>,
  routingDomain?: S
}

PrivateEndpointOut =
  | exact { selfManagedLatticeResource: SelfManagedLatticeResourceOut }
  | exact { managedVpcResource: ManagedVpcResourceOut }
  | UnknownV1

PrivateEndpointOverrideOut = exact {
  domain: S,
  privateEndpoint: PrivateEndpointOut
}

OAuthOut =
  | oneOf(the same nine known OAuth member names)
  | UnknownV1

OAuthOut named/included member = exact {
  oauthDiscovery: DiscoveryOut,
  clientId?: S
}

OAuthOut custom member = exact {
  oauthDiscovery: DiscoveryOut,
  clientId?: S,
  privateEndpoint?: PrivateEndpointOut,
  privateEndpointOverrides?: PrivateEndpointOverrideOut[],
  onBehalfOfTokenExchangeConfig?: OnBehalfOfOut,
  clientAuthenticationMethod?: S
}

PaymentOut =
  | exact {
      coinbaseCdpConfiguration: exact {
        apiKeyId: S,
        apiKeySecretArn: Secret,
        apiKeySecretJsonKey?: S,
        apiKeySecretSource?: SourceOut,
        walletSecretArn: Secret,
        walletSecretJsonKey?: S,
        walletSecretSource?: SourceOut
      }
    }
  | exact {
      stripePrivyConfiguration: exact {
        appId: S,
        appSecretArn: Secret,
        appSecretJsonKey?: S,
        appSecretSource?: SourceOut,
        authorizationPrivateKeyArn: Secret,
        authorizationPrivateKeyJsonKey?: S,
        authorizationPrivateKeySource?: SourceOut,
        authorizationId: S
      }
    }
  | UnknownV1
```

Input aliases are never reused as output aliases. Every output enum-like scalar is a terminal-safe
`S`, every dynamic map key uses injective `K`, and every union node, including nested discovery,
private-endpoint, and self-managed Lattice unions, admits `UnknownV1`. Input-only secret members are
never present. This keeps ordinary reads forward-compatible without weakening any write schema. In
particular, a service-returned `PRIVATE_KEY_JWT` authentication method survives as `S` even though
the pinned write enum and serializer do not model it; its unknown companion configuration remains
unallowlisted and omitted.

The exact top-level operation allowlists are:

| Operation                  | V1 fields                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API-key Create             | `apiKeySecretArn:Secret`, `apiKeySecretJsonKey?:S`, `apiKeySecretSource?:SourceOut`, `name:S`, `credentialProviderArn:S`                                                                         |
| API-key Get / Update       | API-key Create fields plus `createdTime:D`, `lastUpdatedTime:D`                                                                                                                                  |
| API-key List               | `credentialProviders:[{ name:S, credentialProviderArn:S, createdTime:D, lastUpdatedTime:D }]`, `nextToken?:S`                                                                                    |
| OAuth Create               | `clientSecretArn?:Secret`, `clientSecretJsonKey?:S`, `clientSecretSource?:SourceOut`, `name:S`, `credentialProviderArn:S`, `callbackUrl?:S`, `oauth2ProviderConfigOutput?:OAuthOut`, `status?:S` |
| OAuth Get                  | OAuth Create fields plus `credentialProviderVendor:S`, required `oauth2ProviderConfigOutput:OAuthOut`, `createdTime:D`, `lastUpdatedTime:D`, `failureReason?:SafeFailureGuidance`                |
| OAuth Update               | OAuth Get fields except `failureReason`                                                                                                                                                          |
| OAuth List                 | `credentialProviders:[{ name:S, credentialProviderVendor:S, credentialProviderArn:S, createdTime:D, lastUpdatedTime:D }]`, `nextToken?:S`                                                        |
| Payment Create             | `name:S`, `credentialProviderVendor:S`, `credentialProviderArn:S`, `providerConfigurationOutput:PaymentOut`                                                                                      |
| Payment Get                | Payment Create fields plus `createdTime:D`, `lastUpdatedTime:D`, `tags?:Record<K,S>`                                                                                                             |
| Payment Update             | Payment Create fields plus `createdTime:D`, `lastUpdatedTime:D`; no `tags`                                                                                                                       |
| Payment List               | `credentialProviders:[{ name:S, credentialProviderVendor:S, credentialProviderArn:S, createdTime:D, lastUpdatedTime:D }]`, `nextToken?:S`                                                        |
| Workload Create            | `name:S`, `workloadIdentityArn:S`, `allowedResourceOauth2ReturnUrls?:S[]`                                                                                                                        |
| Workload Get / Update      | Workload Create fields plus `createdTime:D`, `lastUpdatedTime:D`                                                                                                                                 |
| Workload List              | `workloadIdentities:[{ name:S, workloadIdentityArn:S }]`, `nextToken?:S`                                                                                                                         |
| All four Deletes / Tagging | Delete, Tag, and Untag: `{}`; List Tags: `{ tags: Record<K,S> }`                                                                                                                                 |
| Token Vault Get / Set CMK  | `tokenVaultId:S`, `kmsConfiguration:{ keyType:S, kmsKeyArn?:S }`, `lastModifiedDate:D`                                                                                                           |

`SafeFailureGuidance` is chosen only from OAuth status, never from raw `failureReason` text:

| Status          | Guidance                                                                           |
| --------------- | ---------------------------------------------------------------------------------- |
| `CREATE_FAILED` | `Provider creation failed. Review the provider configuration and create it again.` |
| `UPDATE_FAILED` | `Provider update failed. Review the provider configuration and retry the update.`  |
| `DELETE_FAILED` | `Provider deletion failed. Retry deletion.`                                        |
| Any other value | `The provider reported a failure. Review the provider configuration and retry.`    |

V1 output schemas and the pinned runtime output schemas are fingerprinted together in drift tests.
A newly modeled field does not silently enter V1; it requires an explicit allowlist and compatibility
review. Drift tests also inject unknown members at every nested union and a custom provider containing
`clientAuthenticationMethod: "PRIVATE_KEY_JWT"` plus an SDK-unknown `privateKeyJwtConfig`; the method
survives as a safe string, the unknown structure does not enter V1, and writes remain fail closed.
Output normalization never relies on SDK `CommandOutput` TypeScript types as a runtime security
boundary.

## Architecture

Identity uses one-way dependencies and consumer-owned ports:

```text
Presentation (Commander / Ink)
|-- application actions --> pure Identity domain
|            |
|            `--> operation-specific IdentityBindingFactory ports
`-- CommitSecretContextFactory port --> SecretSourceReader port

SDK adapter ---------------- implements the narrow binding factories
secret-context adapter ------ implements CommitSecretContextFactory
process/filesystem adapter -- implements SecretSourceReader and awaited output
first-party native addon ---- supplies typed OS file, lock, and boot-session primitives
composition root ------------ injects adapters into actions and presentations
```

The domain does not depend on transport. Actions depend on the pure domain,
one operation-specific `IdentityBindingFactory`, and the opaque secret-context capability and
module-private coordinator.
Commander and Ink depend on actions and `CommitSecretContextFactory`; the context factory depends on
`SecretSourceReader`. Adapters depend inward on these consumer-owned interfaces. Neither presentation
depends on SDK request unions. The first-party native addon is private to process/filesystem adapters;
no domain, action, or presentation type exposes a native handle.

### Ports And Adapters

`src/core/identity.tsx` is a thin raw-SDK adapter that follows the repository's existing core-client
file convention. It creates operation-scoped bindings behind narrow consumer-owned facets that:

- Send typed SDK commands.
- Expose compatibility-guarded current-state reads only on OAuth and payment Update bindings. Ordinary
  query and mutation facets have neither that method nor its private brand, while guarded Update
  facets have no tolerant current-state method.
- Invoke the configured credential provider exactly once and copy only its documented identity
  fields into a private frozen snapshot. Expiration is validated once and stored as immutable epoch
  milliseconds, never as a mutable `Date`.
- Eagerly resolve region, FIPS/dual-stack inputs, configured endpoints, and the resulting complete
  `EndpointV2` values before the first operation call.
- Construct a read client with normal retries and a mutation client with `maxAttempts: 1`, both using
  the pinned AgentCore endpoint and non-refreshing credential-provider closures over the same private
  snapshot. Each provider invocation returns a new mutable plain credential object and, when present,
  a new `Date` cloned from the stored epoch. The frozen snapshot itself is never passed to an SDK
  client because AWS SDK v3 may attach `$source` feature metadata to credential objects. In AWS SDK
  v3, `maxAttempts` includes the initial request.
- Expose page-oriented list operations.
- Expose generated-paginator all-results operations for every paginated Identity list.
- Wrap the mutation request handler to record whether dispatch began and whether a complete HTTP
  response was observed. This preserves the distinction between a pre-dispatch rejection, an
  indeterminate post-dispatch rejection, a non-success service response, and an unusable successful
  response.
- Contain no provider classification, secret prompting, update merging, or UI policy.

One binding is created for a mutation before its preparation Get and remains private to that prepared
capability. Its exact read facet and mutation use the same client pair. The pair is never placed in the
process-wide `{ region, endpoint }` cache and is never shared with another operation. This prevents
independently memoized credential providers from validating one account and mutating another after
credential refresh or profile changes. A later independent operation resolves a new snapshot and may
therefore observe new credentials or endpoint configuration.

Normal CLI execution honors the SDK endpoint precedence independently for each service:

```text
explicit client endpoint
> AWS_ENDPOINT_URL_<SERVICE>
> AWS_ENDPOINT_URL
> profile services-section endpoint
> profile endpoint_url
> modeled endpoint
```

`--endpoint-url` is an explicit AgentCore control-plane endpoint only. It never leaks to STS or
Secrets Manager. The binding eagerly resolves service endpoints through the SDK endpoint providers
so changes to environment or profile files during review or secret acquisition cannot split one
operation. AgentCore uses `AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL` and profile service key
`bedrock_agentcore_control`; STS uses `AWS_ENDPOINT_URL_STS` and `sts`; Secrets Manager uses
`AWS_ENDPOINT_URL_SECRETS_MANAGER` and `secrets_manager`. The global environment and profile
fallbacks still apply to each service under the normal precedence.

In the installed Smithy generation, configured-endpoint loading selects the active profile from the
standard AWS profile environment rather than forwarding a client `profile` value. A future
`--profile` option must explicitly plumb profile selection through every credential and endpoint
config loader; merely setting a client field is not an accepted implementation.

Live integration and golden-capture commands are security-sensitive test entry points. Supplying
`--endpoint-url` is an error. Their binding bypasses environment/profile endpoint loading, resolves
modeled official HTTPS endpoints for AgentCore, STS, and Secrets Manager before the STS account check,
and rejects a non-HTTPS result. It constructs AgentCore read and `maxAttempts: 1` mutation clients, an
STS read client, and Secrets Manager read and `maxAttempts: 1` mutation clients, all from the same
immutable credential snapshot. This prevents test secrets and administrative credentials from being
redirected to a configured local or third-party endpoint or split across accounts during one run
operation.

The narrow `IdentityBindingFactory` instances are consumer-owned interfaces in the Identity handler
boundary. Production and test adapters both implement them. Normal, live, capture, and stale-reaper
composition roots construct operation-specific factories with their different endpoint policies;
each action receives only its exact factory and cannot select another operation, read mode, or policy.

The port surface is exact:

```ts
type OperationSpec<Input, Output> = Readonly<{
  input: Input;
  output: Output;
}>;

interface IdentityReadOperations {
  GetApiKeyCredentialProvider: OperationSpec<
    GetApiKeyCredentialProviderCommandInput,
    GetApiKeyCredentialProviderCommandOutput
  >;
  ListApiKeyCredentialProviders: OperationSpec<
    ListApiKeyCredentialProvidersCommandInput,
    ListApiKeyCredentialProvidersCommandOutput
  >;
  GetOauth2CredentialProvider: OperationSpec<
    GetOauth2CredentialProviderCommandInput,
    GetOauth2CredentialProviderCommandOutput
  >;
  ListOauth2CredentialProviders: OperationSpec<
    ListOauth2CredentialProvidersCommandInput,
    ListOauth2CredentialProvidersCommandOutput
  >;
  GetPaymentCredentialProvider: OperationSpec<
    GetPaymentCredentialProviderCommandInput,
    GetPaymentCredentialProviderCommandOutput
  >;
  ListPaymentCredentialProviders: OperationSpec<
    ListPaymentCredentialProvidersCommandInput,
    ListPaymentCredentialProvidersCommandOutput
  >;
  GetWorkloadIdentity: OperationSpec<
    GetWorkloadIdentityCommandInput,
    GetWorkloadIdentityCommandOutput
  >;
  ListWorkloadIdentities: OperationSpec<
    ListWorkloadIdentitiesCommandInput,
    ListWorkloadIdentitiesCommandOutput
  >;
  GetTokenVault: OperationSpec<GetTokenVaultCommandInput, GetTokenVaultCommandOutput>;
  ListTagsForResource: OperationSpec<
    ListTagsForResourceCommandInput,
    ListTagsForResourceCommandOutput
  >;
}

interface IdentityMutationOperations {
  CreateApiKeyCredentialProvider: OperationSpec<
    CreateApiKeyCredentialProviderCommandInput,
    CreateApiKeyCredentialProviderCommandOutput
  >;
  UpdateApiKeyCredentialProvider: OperationSpec<
    UpdateApiKeyCredentialProviderCommandInput,
    UpdateApiKeyCredentialProviderCommandOutput
  >;
  DeleteApiKeyCredentialProvider: OperationSpec<
    DeleteApiKeyCredentialProviderCommandInput,
    DeleteApiKeyCredentialProviderCommandOutput
  >;
  CreateOauth2CredentialProvider: OperationSpec<
    CreateOauth2CredentialProviderCommandInput,
    CreateOauth2CredentialProviderCommandOutput
  >;
  UpdateOauth2CredentialProvider: OperationSpec<
    UpdateOauth2CredentialProviderCommandInput,
    UpdateOauth2CredentialProviderCommandOutput
  >;
  DeleteOauth2CredentialProvider: OperationSpec<
    DeleteOauth2CredentialProviderCommandInput,
    DeleteOauth2CredentialProviderCommandOutput
  >;
  CreatePaymentCredentialProvider: OperationSpec<
    CreatePaymentCredentialProviderCommandInput,
    CreatePaymentCredentialProviderCommandOutput
  >;
  UpdatePaymentCredentialProvider: OperationSpec<
    UpdatePaymentCredentialProviderCommandInput,
    UpdatePaymentCredentialProviderCommandOutput
  >;
  DeletePaymentCredentialProvider: OperationSpec<
    DeletePaymentCredentialProviderCommandInput,
    DeletePaymentCredentialProviderCommandOutput
  >;
  CreateWorkloadIdentity: OperationSpec<
    CreateWorkloadIdentityCommandInput,
    CreateWorkloadIdentityCommandOutput
  >;
  UpdateWorkloadIdentity: OperationSpec<
    UpdateWorkloadIdentityCommandInput,
    UpdateWorkloadIdentityCommandOutput
  >;
  DeleteWorkloadIdentity: OperationSpec<
    DeleteWorkloadIdentityCommandInput,
    DeleteWorkloadIdentityCommandOutput
  >;
  SetTokenVaultCMK: OperationSpec<SetTokenVaultCMKCommandInput, SetTokenVaultCMKCommandOutput>;
  TagResource: OperationSpec<TagResourceCommandInput, TagResourceCommandOutput>;
  UntagResource: OperationSpec<UntagResourceCommandInput, UntagResourceCommandOutput>;
}

type IdentityOperationName = keyof IdentityReadOperations | keyof IdentityMutationOperations;

type IdentityListOperation =
  | "ListApiKeyCredentialProviders"
  | "ListOauth2CredentialProviders"
  | "ListPaymentCredentialProviders"
  | "ListWorkloadIdentities";

type IdentityCallOptions = Readonly<{
  abortSignal?: AbortSignal;
}>;

type MutationTransportOutcome<Output> =
  | { kind: "succeeded"; output: Output }
  | { kind: "rejectedBeforeDispatch"; cause: unknown }
  | { kind: "serviceRejected"; cause: unknown }
  | { kind: "mutationOutcomeUnknown"; cause: unknown }
  | { kind: "successfulResponseUnusable"; cause: unknown };

interface IdentityBindingLifetime {
  readonly credentialExpiresAtEpochMs: number | undefined;
  dispose(): void;
}

interface IdentityReadBinding<Input, Output> extends IdentityBindingLifetime {
  read(input: Readonly<Input>, options?: IdentityCallOptions): Promise<Output>;
}

interface IdentityListBinding<Input, Output> extends IdentityBindingLifetime {
  page(input: Readonly<Input>, options?: IdentityCallOptions): Promise<Output>;
  pages(input: Readonly<Input>, options?: IdentityCallOptions): AsyncIterable<Output>;
}

interface IdentityResolvedReadBinding<
  ResolveInput,
  ResolveOutput,
  Input,
  Output,
> extends IdentityBindingLifetime {
  resolve(input: Readonly<ResolveInput>, options?: IdentityCallOptions): Promise<ResolveOutput>;
  read(input: Readonly<Input>, options?: IdentityCallOptions): Promise<Output>;
}

interface IdentityDirectMutationBinding<Input, Output> extends IdentityBindingLifetime {
  mutate(
    input: Readonly<Input>,
    options?: IdentityCallOptions,
  ): Promise<MutationTransportOutcome<Output>>;
}

declare const ORDINARY_CURRENT_STATE_BINDING: unique symbol;
declare const COMPATIBILITY_GUARDED_UPDATE_BINDING: unique symbol;

interface IdentityCurrentStateMutationBinding<
  ReadInput,
  ReadOutput,
  MutationInput,
  MutationOutput,
> extends IdentityBindingLifetime {
  readonly [ORDINARY_CURRENT_STATE_BINDING]: true;
  readCurrent(input: Readonly<ReadInput>, options?: IdentityCallOptions): Promise<ReadOutput>;
  mutate(
    input: Readonly<MutationInput>,
    options?: IdentityCallOptions,
  ): Promise<MutationTransportOutcome<MutationOutput>>;
}

interface IdentityCompatibilityGuardedUpdateBinding<
  ReadInput,
  ReadOutput,
  MutationInput,
  MutationOutput,
> extends IdentityBindingLifetime {
  readonly [COMPATIBILITY_GUARDED_UPDATE_BINDING]: true;
  readCompatibilityGuardedCurrent(
    input: Readonly<ReadInput>,
    options?: IdentityCallOptions,
  ): Promise<ReadOutput>;
  mutate(
    input: Readonly<MutationInput>,
    options?: IdentityCallOptions,
  ): Promise<MutationTransportOutcome<MutationOutput>>;
}

interface IdentityBindingFactory<Binding extends IdentityBindingLifetime> {
  create(options?: IdentityCallOptions): Promise<Binding>;
}
```

`dispose()` is synchronous and idempotent. Port calls may reject with `unknown`; the application
boundary catches every rejection and maps it to a closed action outcome before presentation code sees
it. A binding exposes only numeric expiration metadata, its exact methods, and explicit disposal. It
never exposes credential values, a refresh function, an SDK operation selector, or the private broad
transport implementation.

Each action constructor receives one `IdentityBindingFactory` instantiated with concrete command
input/output types. Ordinary Get and List use `IdentityReadBinding` or `IdentityListBinding`;
name-selected List Tags uses `IdentityResolvedReadBinding`; Creates and direct-ARN Tag/Untag use
`IdentityDirectMutationBinding`; API-key/workload Updates, Deletes, name-selected Tag/Untag, and Set
CMK use `IdentityCurrentStateMutationBinding`; and only OAuth/payment Updates use
`IdentityCompatibilityGuardedUpdateBinding`. The latter installs the raw-wire guard on
`readCompatibilityGuardedCurrent`; it has no `readCurrent` or tolerant `read` method. No other facet
has `readCompatibilityGuardedCurrent` or its private brand. The SDK adapter may share a private
transport utility internally, but no broad binding is exported or injected.

The mutation adapter wraps the concrete HTTP handler, marking dispatch immediately before invoking
the handler. A rejection before that point is `rejectedBeforeDispatch`. Once the handler is invoked,
absence of a complete HTTP response, every complete 5xx response, and any complete status outside 2xx
or 4xx are conservatively `mutationOutcomeUnknown`. A complete 4xx response is `serviceRejected`; the
service's modeled Identity 4xx errors are evidence that the request was rejected. A 2xx response that
cannot be deserialized is `successfulResponseUnusable`. The action additionally maps failure to
validate or normalize an SDK output returned from a 2xx response to
`committedOutputUnavailable`. Unexpected adapter bugs may still reject and are contained by the outer
safe boundary. No post-dispatch 5xx is presented as proof that mutation did not occur.

Binding creation is itself transactional. The factory owns every partially resolved credential,
endpoint, client, handler, and native resource until it returns a complete binding; rejection or
cancellation destroys all partial clients and handlers. A late complete binding is owned immediately
by the awaiting action's `try/finally`.

Temporary credentials are accepted only when an absent expiration or a finite expiration epoch was
captured. They are fresh exactly when expiration is absent or that epoch is more than `300_000`
milliseconds in the future. Exactly five minutes remaining fails closed. The binding checks freshness
at creation and immediately before every AWS send, including both commit Gets and the final mutation.
If the snapshot enters the window during a retrying read, the post-read check prevents the next send.
Failure disposes the current secret owner, whether a preparation reservation or commit lease, and
returns `credentialRefreshRequired` without a later Get or mutation. It never transparently refreshes
inside an existing capability because a refreshed identity would invalidate the reviewed account and
state.

`SecretSourceReader` and `CommitSecretContextFactory` are the other consumer-owned ports. Their exact
contracts are defined under Secret Handling. The production adapter captures opaque file handles and
reads named environment variables, bounded files, and bounded non-TTY stdin. It does not prompt.
Commander and Ink own hidden-prompt rendering and pass that capability into context construction
without making actions depend on either presentation library.

The composition root constructs adapters and injects them. Tests inject fakes at the same ports.

### Domain Layer

`src/handlers/identity/domain/` contains pure modules for:

- OAuth provider descriptors and family adapters.
- Payment provider descriptors and adapters.
- Secret-slot definitions and secret input types.
- Request construction.
- Update planning and response normalization.
- Explicit Zod request validation.
- Identity semantic validation.
- Schema-sensitive redaction.
- Canonical review and fixture representations.
- Safe error classification.

These modules import only SDK types/runtime schemas and other pure domain modules. They do not import
Commander, Ink, React, AWS client implementations, or filesystem/process implementations.

### Application Action Layer

`src/handlers/identity/actions/` contains resource-specific workflows shared by CLI and TUI:

- Prepare immutable, secret-free mutation plans.
- Fetch and normalize current state for updates.
- Determine unmet secret requirements.
- Rebase update intent before secret acquisition and revalidate it again after acquisition.
- Resolve secret values only after the first rebase remains commit-guard equivalent.
- Construct and validate the exact SDK request.
- Send at most one mutation command per prepared capability.
- Return a renderable result or a structured local error.

There is no generic workflow engine. OAuth and payment share catalog machinery because their unions
justify it. API-key, workload identity, token vault, and tag actions remain direct resource-specific
functions.

### Presentation Layer

Commander handlers parse flags into typed intents and invoke actions. Ink screens collect the same
intents and invoke the same actions. Neither layer constructs SDK unions or implements update merge
logic.

Identity owns its TUI route registry in `src/handlers/identity/routes.tsx`. The root Ink router mounts
that registry instead of duplicating each Identity route inline. A parity test compares the registry
to the Identity Commander tree and fails when a supported leaf lacks its required Ink route.

Resource directories follow the existing repository organization:

```text
src/handlers/identity/
|-- index.tsx
|-- screen.tsx
|-- types.ts
|-- routes.tsx
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
- Generated command documentation and TypeScript requiredness.
- Runtime structure, union membership, and sensitive traits that are present in generated schemas.
- Generated paginators.

The installed SDK does not provide `@aws-sdk/config/typecheck`. The supported `NormalizedSchema`
traversal and trait API does not expose requiredness or the length, range, pattern, and enum
constraints needed here. Underlying static tuples encode required-member prefixes, but production code
deliberately does not consume tuple indexes. The CLI therefore defines strict Zod schemas for every
Identity intent and final SDK request. Those schemas encode required members, enums, scalar
constraints, union cardinality, and conditional rules explicitly.

`NormalizedSchema` from `@smithy/core/schema` is used only for structure, union, and sensitive-path
traversal. The fixture boundary accesses each pinned command instance's runtime schema through one
isolated, drift-tested adapter and never reads static schema tuple indexes. Production request
validity never depends on undocumented trait data or Smithy's internal `schemaLogFilter`.

CLI validation enforces:

- Exactly one union member.
- Known enum values.
- Regex and length constraints needed for fast feedback.
- Vendor-to-config-member compatibility.
- Live service requirements missing from the model.
- Conditional secret requirements.
- Cross-member rules such as secret source/config pairing.

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

| SDK enum           | CLI slug     | Config union member              |
| ------------------ | ------------ | -------------------------------- |
| `AtlassianOauth2`  | `atlassian`  | `atlassianOauth2ProviderConfig`  |
| `GithubOauth2`     | `github`     | `githubOauth2ProviderConfig`     |
| `GoogleOauth2`     | `google`     | `googleOauth2ProviderConfig`     |
| `LinkedinOauth2`   | `linkedin`   | `linkedinOauth2ProviderConfig`   |
| `MicrosoftOauth2`  | `microsoft`  | `microsoftOauth2ProviderConfig`  |
| `SalesforceOauth2` | `salesforce` | `salesforceOauth2ProviderConfig` |
| `SlackOauth2`      | `slack`      | `slackOauth2ProviderConfig`      |

Common fields are client ID and client secret configuration. Microsoft additionally accepts an
optional tenant ID. Live probes confirmed that omitted tenant ID uses `common` and that an update
which omits an existing tenant-specific ID resets it to `common`. The CLI never relies on that
destructive omission accidentally: `--clear-tenant-id` maps to the explicit tenant value `common`.
The canonical discovery URL is
`https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`.

#### Included Per-Tenant

These providers use `includedOauth2ProviderConfig` and require issuer, authorization endpoint, and
token endpoint:

| SDK enum           | CLI slug     |
| ------------------ | ------------ |
| `Auth0Oauth2`      | `auth0`      |
| `CognitoOauth2`    | `cognito`    |
| `CyberArkOauth2`   | `cyberark`   |
| `FusionAuthOauth2` | `fusionauth` |
| `OktaOauth2`       | `okta`       |
| `OneLoginOauth2`   | `onelogin`   |
| `PingOneOauth2`    | `pingone`    |

#### Included Global

These providers use `includedOauth2ProviderConfig` and service-known discovery:

| SDK enum         | CLI slug   |
| ---------------- | ---------- |
| `DropboxOauth2`  | `dropbox`  |
| `FacebookOauth2` | `facebook` |
| `HubspotOauth2`  | `hubspot`  |
| `NotionOauth2`   | `notion`   |
| `RedditOauth2`   | `reddit`   |
| `SpotifyOauth2`  | `spotify`  |
| `TwitchOauth2`   | `twitch`   |
| `XOauth2`        | `x`        |
| `YandexOauth2`   | `yandex`   |
| `ZoomOauth2`     | `zoom`     |

#### Custom

Custom OAuth supports:

- Discovery URL or authorization-server metadata.
- Client ID and conditional client secret.
- Client authentication method.
- On-behalf-of token exchange configuration.
- Private endpoint and override configuration.
- Other SDK-native nested members available in the pinned public model.

Rare nested structures remain SDK-native JSON inputs.

The pinned client-authentication enum contains exactly `CLIENT_SECRET_BASIC`, `CLIENT_SECRET_POST`,
and `AWS_IAM_ID_TOKEN_JWT`. It does not contain `PRIVATE_KEY_JWT`. Discovery metadata's
`tokenEndpointAuthMethods` strings are a separate surface and use values such as
`client_secret_basic` and `client_secret_post`.

OAuth `callbackUrl` is response-only and optional on Create, Get, and Update. It is absent from List.
The CLI and TUI display it after create and on detail/update results for registration with the
provider. No callback URL input option exists.

### Payment Providers

Payment has two exhaustive vendor adapters:

| SDK enum      | CLI slug       | Config union member        | Required non-secret fields | Secret slots                          |
| ------------- | -------------- | -------------------------- | -------------------------- | ------------------------------------- |
| `CoinbaseCDP` | `coinbase-cdp` | `coinbaseCdpConfiguration` | API key ID                 | API key secret, wallet secret         |
| `StripePrivy` | `stripe-privy` | `stripePrivyConfiguration` | App ID, authorization ID   | App secret, authorization private key |

Each vendor has exactly two secret slots. Authorization ID is a non-secret field.

The payment catalog uses
`satisfies Record<PaymentCredentialProviderVendorType, PaymentProviderDescriptor>` so an SDK enum
addition fails compilation until it is classified.

### Pinned API Contract

The SDK operation is named `SetTokenVaultCMK`. Provider and workload Get, Update, and Delete
operations take `name`; tag operations take `resourceArn`; token-vault operations take optional
`tokenVaultId`.

OAuth and payment Update requests structurally require their immutable vendor and complete config
union. The action layer reconstructs those fields after Get. API-key and workload Update requests
structurally require only `name`.

Response fields named `apiKeySecretArn`, `clientSecretArn`, and payment `*SecretArn`, when present,
are `Secret` objects shaped `{ secretArn: string }`, not strings. API-key and payment secret ARN
members are required by their V1 operations. OAuth `clientSecretArn` is deliberately optional because
valid no-secret IAM-JWT providers omit it despite stale requiredness in the pinned generated output
type. External secret inputs use `SecretReference`, which requires `{ secretId, jsonKey }`.

| Operation family   | Required request fields                                          | Optional request fields                |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------- |
| API-key Create     | `name`                                                           | API-key value/reference/source, `tags` |
| API-key Update     | `name`                                                           | API-key value/reference/source         |
| OAuth Create       | `name`, `credentialProviderVendor`, `oauth2ProviderConfigInput`  | `tags`                                 |
| OAuth Update       | `name`, `credentialProviderVendor`, `oauth2ProviderConfigInput`  | None                                   |
| Payment Create     | `name`, `credentialProviderVendor`, `providerConfigurationInput` | `tags`                                 |
| Payment Update     | `name`, `credentialProviderVendor`, `providerConfigurationInput` | None                                   |
| Workload Create    | `name`                                                           | Return URLs, `tags`                    |
| Workload Update    | `name`                                                           | Replacement return URLs                |
| Token-vault Get    | None                                                             | `tokenVaultId`                         |
| `SetTokenVaultCMK` | `kmsConfiguration`                                               | `tokenVaultId`                         |

All four Delete operations return an empty response. Tag and Untag also return an empty response.
List responses require their collection and optionally return `nextToken`. Workload list items contain
only name and ARN; callers Get a selected item before an edit or detail view.

### Modeled Constraints

The implementation encodes these constraints in explicit Zod/domain schemas and pins semantic tests
to the generated documentation, TypeScript declarations, and retained live evidence:

| Shape                          | Constraint                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Credential provider name       | 1 to 128 characters; `^[a-zA-Z0-9\-_]+$`                                                                                               |
| Workload identity name         | 3 to 255 characters; `^[A-Za-z0-9_.-]+$`                                                                                               |
| Token-vault ID                 | 1 to 64 characters; `^[a-zA-Z0-9\-_]+$`                                                                                                |
| API key                        | Sensitive; at most 65,536 characters                                                                                                   |
| Named/included OAuth client ID | 1 to 256 characters                                                                                                                    |
| Custom OAuth client ID         | At most 256 characters                                                                                                                 |
| OAuth client secret            | Sensitive; at most 2,048 characters                                                                                                    |
| Microsoft tenant ID            | 1 to 2,048 characters                                                                                                                  |
| Discovery URL                  | Must end in `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server`                                           |
| Workload return URL            | 1 to 2,048 characters; `^\w+:(\/?\/?)[^\s]+$`                                                                                          |
| External secret ID             | 1 to 2,048 characters                                                                                                                  |
| External secret JSON key       | 1 to 128 characters                                                                                                                    |
| Payment non-secret IDs         | 1 to 512 characters; `^[a-zA-Z0-9\-_]+$`                                                                                               |
| Payment secrets                | Sensitive; at most 2,048 characters; base pattern `^[a-zA-Z0-9+/=\-_\s]*$`                                                             |
| Authorization private key      | Payment secret pattern with the modeled optional `wallet-auth:` prefix                                                                 |
| Private endpoint overrides     | At most five                                                                                                                           |
| Customer-managed KMS ARN       | 1 to 2,048; partition `aws`, `aws-cn`, or `aws-us-gov`; KMS region; 12-digit account; `key/` plus 36 alphanumeric-or-hyphen characters |
| Tags                           | At most 50 entries; key 1 to 128; value 0 to 256; characters `[a-zA-Z0-9\s._:/=+@-]`                                                   |

Nested advanced JSON uses these additional exact constraints:

| Shape/member                    | Constraint                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery metadata              | `issuer`, `authorizationEndpoint`, and `tokenEndpoint` are required strings. `responseTypes` has no modeled cardinality.                                                              |
| `tokenEndpointAuthMethods`      | Optional one or two items; each is exactly `client_secret_post` or `client_secret_basic`.                                                                                             |
| OBO `grantType`                 | Required; `TOKEN_EXCHANGE` or `JWT_AUTHORIZATION_GRANT`.                                                                                                                              |
| `tokenExchangeGrantTypeConfig`  | Structurally optional for either grant. The generated docs call it token-exchange-specific but do not define required/forbidden presence, so that relation remains service-validated. |
| `actorTokenContent`             | Required when token-exchange config is present; `NONE`, `M2M`, or `AWS_IAM_ID_TOKEN_JWT`.                                                                                             |
| `actorTokenScopes`              | Optional with no list cardinality or uniqueness constraint; each item is 1 to 128 characters and is accepted only when actor content is `M2M`. It is not required for `M2M`.          |
| Self-managed Lattice identifier | 20 to 2,048; either `rcfg-[0-9a-z]{17}` or a partition/region/account Lattice resource-configuration ARN ending in that ID.                                                           |
| Managed VPC ID                  | `^vpc-[0-9a-z]{8}([0-9a-z]{9})?$`.                                                                                                                                                    |
| Managed VPC subnet IDs          | Each matches `^subnet-[0-9a-zA-Z]{8,17}$`; no modeled list cardinality or uniqueness constraint.                                                                                      |
| Managed VPC IP type             | Required; `IPV4` or `IPV6`.                                                                                                                                                           |
| Managed VPC security groups     | Optional, at most five; each matches `^sg-[0-9a-z]{8}([0-9a-z]{9})?$`.                                                                                                                |
| Managed VPC routing domain      | Optional, 3 to 255 characters.                                                                                                                                                        |
| Private endpoint override       | Required `domain` of 1 to 253 characters plus one exact private endpoint; list maximum five.                                                                                          |
| Payment secret strings          | Zero to 2,048 characters structurally. Managed-value CLI acquisition separately requires at least one character.                                                                      |

The separate SDK `VpcConfig` shape is not an OAuth `PrivateEndpoint` arm and is rejected there. The
CLI does not invent grant/config presence rules, endpoint reachability checks, payment key semantics,
or undocumented secret value/source/reference combinations. It enforces the documented
`EXTERNAL => SecretReference` implication and otherwise lets the service validate conditions not
established by the model or retained probes.

The AWS service guide adds one cross-surface rule not represented by the generated model:
`authorizationServerMetadata.tokenEndpointAuthMethods` and custom
`clientAuthenticationMethod` are mutually exclusive in the effective Create or Update request.
Provider-independent validation applies this rule before secret acquisition. Curated Update first
reconstructs the preserved current mechanism as described above and then applies the same rule, so a
legacy provider can be updated without forcing an invalid mixed request.

The service-only maximum of five workload return URLs supplements the pinned model. Per-operation Zod
schemas also encode the complete private-endpoint, override, VPC, subnet, security-group, ARN, and
nested OAuth constraints. Runtime schema traversal verifies member names and union structure but does
not substitute for those validators.

The payment string patterns are transport constraints, not proof that key material is usable. A July
14, 2026 live probe established that Coinbase accepts Base64 encoding of a raw 64-byte value for
`apiKeySecret` and rejects Base64 encoding of a PKCS#8 Ed25519 DER object. The CLI validates the
modeled syntax and length but does not parse, transform, or claim cryptographic validity for payment
keys; the provider and service remain authoritative for semantic key format.

## Input Model

Commander and TUI produce typed domain intents and separate ephemeral secret bindings, not SDK
requests:

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

Intent types contain explicit non-secret patch operations, desired AgentCore storage modes, and
external references. Managed-value acquisition is carried separately by a one-use
`CommitSecretContext`; actual values, environment names, file paths, stdin markers, and prompt
callbacks remain outside the intent and every prepared plan.

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
- `--tags`

Payment options are slot-specific so independent secret sources cannot be confused.
Curated custom OAuth Create requires `--client-authentication-method` unless the selected discovery
metadata supplies the mutually exclusive legacy `tokenEndpointAuthMethods`. Raw Create retains the
modeled ability to omit both.

Scoped OAuth JSON flags accept exactly these roots:

| Flag                                | Exact JSON root             | Composed request path                                      | Create omission                                          | Curated Update omission                     |
| ----------------------------------- | --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `--discovery-json`                  | `Discovery`                 | `customOauth2ProviderConfig.oauthDiscovery`                | Invalid unless another discovery alternative is supplied | Preserve current discovery                  |
| `--on-behalf-of-json`               | `OnBehalfOf`                | `customOauth2ProviderConfig.onBehalfOfTokenExchangeConfig` | Member absent                                            | Preserve; `--clear-on-behalf-of` removes it |
| `--private-endpoint-json`           | `PrivateEndpoint`           | `customOauth2ProviderConfig.privateEndpoint`               | Member absent                                            | Preserve; no curated clear                  |
| `--private-endpoint-overrides-json` | `PrivateEndpointOverride[]` | `customOauth2ProviderConfig.privateEndpointOverrides`      | Member absent                                            | Preserve; non-empty input replaces the list |

The aliases are the exact definitions in Advanced JSON Contract. `--discovery-json` therefore
includes one `discoveryUrl` or `authorizationServerMetadata` union wrapper; it does not accept a bare
metadata leaf. `--private-endpoint-json` likewise includes one `selfManagedLatticeResource` or
`managedVpcResource` union wrapper. `--on-behalf-of-json` is the member value and does not include an
outer `onBehalfOfTokenExchangeConfig` key. Overrides accept the array itself, not an object containing
`privateEndpointOverrides`. Unknown outer or nested keys fail. An explicit empty override array follows
the fail-closed Update rule below; it is not a curated clear.

### Raw Mode

OAuth and payment Create commands use `--config-json` for a complete SDK-native provider config
union. Their Update commands use the deliberately different `--replace-config-json` name. It replaces
the complete provider configuration represented by that union; it is not a generic deep patch.
Omitted optional custom `clientId` and `onBehalfOfTokenExchangeConfig` members are removals. The only
retention exceptions are the existing custom private-endpoint members whose omission semantics have
not been proven safe.

Both options are mutually exclusive with curated non-secret provider options and clear options.
Secret slots remain under the shared secret resolver: existing EXTERNAL references are preserved when
omitted, while service-required MANAGED values must be supplied again. Known secret inputs fill
sensitive paths omitted from raw JSON. If raw JSON and a secret input both target the same path, the
command fails with a conflict error. Sensitive values embedded directly in JSON are accepted as
literal input with the same warning and redaction guarantees as literal secret flags.

Raw custom OAuth Update requires exactly one authentication mechanism in the effective replacement:
either `clientAuthenticationMethod` or
`oauthDiscovery.authorizationServerMetadata.tokenEndpointAuthMethods`. When the current custom
provider has a private endpoint, the effective replacement must also contain a private endpoint: an
explicitly supplied replacement is used, while omission rehydrates the exact current value. The CLI
does not treat omission as an unverified private-endpoint clear. An explicit
`privateEndpointOverrides` array replaces the collection when non-empty; omission preserves the
current collection. An explicit empty array is rejected when the current collection is non-empty
because service removal semantics have not been established. It is only a semantic no-op when the
current collection is already empty.

The parser immediately extracts sensitive values from raw JSON into creator-owned source selections
and replaces their paths with source markers before planning, review, hashing, or error handling. It
does not retain the original JSON text in a plan. Extraction and
`CommitSecretContextFactory.create()` run under one creator-owned `try/finally`: until `prepare()`
returns a current, installed `prepared` pair, every partial selection, locator, context, and late
capability remains the creator's responsibility. Any later JSON-key, union, vendor, context-build,
prepare, cancellation, or unexpected-rejection path disposes the context and clears the extracted
references.

The implementation performs adapter-owned composition at known secret paths; it does not implement a
generic deep-merge engine.

The chosen vendor must match the supplied union member. Unknown keys and multiple union members fail
before an AWS call. Create vendor mismatches also fail locally; Update compares the member with the
current vendor after Get and before secret acquisition or mutation. Malformed JSON errors identify
only the option, such as `Invalid JSON for option '--config-json'`; they never include parser text or
an input excerpt.

#### Advanced JSON Contract

The flag value is the provider configuration union itself, not a whole SDK request wrapper:

| Command        | Flag                    | Payload composed into request                    |
| -------------- | ----------------------- | ------------------------------------------------ |
| OAuth Create   | `--config-json`         | `oauth2ProviderConfigInput`                      |
| OAuth Update   | `--replace-config-json` | `oauth2ProviderConfigInput` with current vendor  |
| Payment Create | `--config-json`         | `providerConfigurationInput`                     |
| Payment Update | `--replace-config-json` | `providerConfigurationInput` with current vendor |

The V1 aliases below are exact recursive objects. Unknown keys are rejected at every structure;
unions require exactly one known member; input `$unknown` is rejected; arrays validate each member;
only modeled maps admit arbitrary keys.

```text
Source = "MANAGED" | "EXTERNAL"
Ref = exact {
  secretId: string,
  jsonKey: string
}

Named = exact {
  clientId: string,
  clientSecret?: string,
  clientSecretConfig?: Ref,
  clientSecretSource?: Source
}

Microsoft = exact {
  ...Named,
  tenantId?: string
}

Included = exact {
  ...Named,
  issuer?: string,
  authorizationEndpoint?: string,
  tokenEndpoint?: string
}

Discovery = oneOf(
  exact { discoveryUrl: string },
  exact {
    authorizationServerMetadata: exact {
      issuer: string,
      authorizationEndpoint: string,
      tokenEndpoint: string,
      responseTypes?: string[],
      tokenEndpointAuthMethods?: string[]
    }
  }
)

TokenExchangeGrant = exact {
  actorTokenContent: "NONE" | "M2M" | "AWS_IAM_ID_TOKEN_JWT",
  actorTokenScopes?: string[]
}

OnBehalfOf = exact {
  grantType: "TOKEN_EXCHANGE" | "JWT_AUTHORIZATION_GRANT",
  tokenExchangeGrantTypeConfig?: TokenExchangeGrant
}

PrivateEndpoint = oneOf(
  exact {
    selfManagedLatticeResource: oneOf(
      exact { resourceConfigurationIdentifier: string }
    )
  },
  exact {
    managedVpcResource: exact {
      vpcIdentifier: string,
      subnetIds: string[],
      endpointIpAddressType: "IPV4" | "IPV6",
      securityGroupIds?: string[],
      tags?: Record<string, string>,
      routingDomain?: string
    }
  }
)

PrivateEndpointOverride = exact {
  domain: string,
  privateEndpoint: PrivateEndpoint
}

Custom = exact {
  oauthDiscovery: Discovery,
  clientId?: string,
  clientSecret?: string,
  clientSecretConfig?: Ref,
  clientSecretSource?: Source,
  onBehalfOfTokenExchangeConfig?: OnBehalfOf,
  clientAuthenticationMethod?:
    | "CLIENT_SECRET_BASIC"
    | "CLIENT_SECRET_POST"
    | "AWS_IAM_ID_TOKEN_JWT",
  privateEndpoint?: PrivateEndpoint,
  privateEndpointOverrides?: PrivateEndpointOverride[]
}
```

`OAuthInput` has exactly one of these nine members:

| Union member                                                                                      | Leaf        |
| ------------------------------------------------------------------------------------------------- | ----------- |
| `googleOauth2ProviderConfig`, `githubOauth2ProviderConfig`, `slackOauth2ProviderConfig`           | `Named`     |
| `salesforceOauth2ProviderConfig`, `atlassianOauth2ProviderConfig`, `linkedinOauth2ProviderConfig` | `Named`     |
| `microsoftOauth2ProviderConfig`                                                                   | `Microsoft` |
| `includedOauth2ProviderConfig`                                                                    | `Included`  |
| `customOauth2ProviderConfig`                                                                      | `Custom`    |

`PaymentInput` has exactly one of these two members:

```text
coinbaseCdpConfiguration: exact {
  apiKeyId: string,
  apiKeySecret?: string,
  apiKeySecretSource?: Source,
  apiKeySecretConfig?: Ref,
  walletSecret?: string,
  walletSecretSource?: Source,
  walletSecretConfig?: Ref
}

stripePrivyConfiguration: exact {
  appId: string,
  appSecret?: string,
  appSecretSource?: Source,
  appSecretConfig?: Ref,
  authorizationPrivateKey?: string,
  authorizationPrivateKeySource?: Source,
  authorizationPrivateKeyConfig?: Ref,
  authorizationId: string
}
```

The vendor/member mapping is exact. Included per-tenant vendors require all three endpoint members;
included global vendors forbid them. Create requires every effective secret slot, whether embedded or
provided through a separate slot option. A direct secret, reference, and explicit source must agree
and cannot conflict. Update cannot switch storage mode, preserves reconstructable EXTERNAL
references, and requires MANAGED re-entry. Raw custom Update requires
exactly one preferred or legacy authentication mechanism; both together are rejected.
`PRIVATE_KEY_JWT` is rejected on writes because it is not modeled by the pinned SDK. Omitted custom
`clientId` and OBO remove them, while the private-endpoint retention rules above remain mandatory.
Payment replacement always rebuilds the complete current-vendor configuration.

## Secret Handling

Secret handling separates value acquisition from AgentCore storage mode.

### CLI Value Acquisition

The reusable slot prefixes are:

| Resource and secret                    | Prefix                      |
| -------------------------------------- | --------------------------- |
| OAuth client secret                    | `client-secret`             |
| API-key provider API key               | `api-key`                   |
| Coinbase API key secret                | `api-key-secret`            |
| Coinbase wallet secret                 | `wallet-secret`             |
| Stripe/Privy app secret                | `app-secret`                |
| Stripe/Privy authorization private key | `authorization-private-key` |

For a prefix `<slot>`, managed values use exactly one of:

- `--<slot> <literal>`
- `--<slot>-stdin`
- `--<slot>-env <variable-name>`
- `--<slot>-file <path>`
- A hidden prompt when the presentation is interactive and no source was supplied

External references use both:

- `--<slot>-external-secret-id <secret-id>`
- `--<slot>-external-json-key <json-key>`

`--<slot>-source <managed|external>` is an optional declaration of the desired source. A managed
input implies `managed`; an external pair implies `external`; an explicit declaration must agree. It
never serves as evidence of the current source.

Every value source and external pair for the same slot is mutually exclusive. At most one slot in a
command uses stdin. `--json` and non-TTY execution disable fallback hidden prompts and instead return
a structured missing-secret error that lists the accepted flags for each missing slot. TUI
cancellation exits without committing.

Literal values are accepted for compatibility and emit one static warning per command because shell
history, CI logs, and process inspection expose argv. Help text also explains that the current
account, child processes, and CI configuration expose environment values. The warning never includes
the value, variable name, or file path.

The acquisition port and context-construction contract are exact:

```ts
declare const SECRET_FILE_LOCATOR: unique symbol;
declare const COMMIT_SECRET_CONTEXT: unique symbol;

interface SecretFileLocator {
  readonly [SECRET_FILE_LOCATOR]: never;
}

type SecretSourceReadFailureReason =
  | "environmentUnavailable"
  | "fileChanged"
  | "fileUnavailable"
  | "fileUnsafe"
  | "invalidValue"
  | "stdinUnavailable";

type SecretPromptFailureReason = "invalidValue" | "promptUnavailable";

type SecretAcquisitionFailureReason = SecretSourceReadFailureReason | SecretPromptFailureReason;

type SecretReadOutcome<T, Reason extends SecretAcquisitionFailureReason> =
  | { kind: "succeeded"; value: T }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: Reason };

type SecretValueLimits = Readonly<{
  byteCap: number;
  characterMaximum: number;
  requireNonEmpty: true;
}>;

interface SecretSourceReader {
  captureFile(
    path: string,
    options?: IdentityCallOptions,
  ): Promise<SecretReadOutcome<SecretFileLocator, SecretSourceReadFailureReason>>;
  readEnvironment(
    variableName: string,
    limits: SecretValueLimits,
    options?: IdentityCallOptions,
  ): Promise<SecretReadOutcome<string, SecretSourceReadFailureReason>>;
  readFile(
    locator: SecretFileLocator,
    limits: SecretValueLimits,
    options?: IdentityCallOptions,
  ): Promise<SecretReadOutcome<string, SecretSourceReadFailureReason>>;
  readStdin(
    limits: SecretValueLimits,
    options?: IdentityCallOptions,
  ): Promise<SecretReadOutcome<string, SecretSourceReadFailureReason>>;
  disposeFile(locator: SecretFileLocator): void;
}

type SecretSourceSelection =
  | Readonly<{ kind: "literal"; value: string }>
  | Readonly<{ kind: "environment"; variableName: string }>
  | Readonly<{ kind: "file"; path: string }>
  | Readonly<{ kind: "stdin" }>
  | Readonly<{ kind: "prompt" }>;

type HiddenSecretPrompt = (
  slot: SecretSlotId,
  limits: SecretValueLimits,
  options?: IdentityCallOptions,
) => Promise<SecretReadOutcome<string, SecretPromptFailureReason>>;

type SecretContextBuildOutcome =
  | { kind: "created"; context: CommitSecretContext }
  | { kind: "cancelled" }
  | { kind: "failed"; error: SafeIdentityError };

interface CommitSecretContextFactory {
  create(
    selections: readonly Readonly<{
      slot: SecretSlotId;
      source: SecretSourceSelection;
    }>[],
    prompt?: HiddenSecretPrompt,
    options?: IdentityCallOptions,
  ): Promise<SecretContextBuildOutcome>;
}

interface CommitSecretContext {
  readonly [COMMIT_SECRET_CONTEXT]: never;
  dispose(): void;
}
```

The unique-symbol brands and all reserve/bind/claim methods are module-private. Presentation code can
pass or dispose a context but cannot inspect a source, reserve preparation, resolve a value, or claim a
commit lease. `SecretReadOutcome` carries no path, variable name, raw value, or arbitrary error. The
context maps a failed read to the selected slot and closed `SafeIdentityError`; unknown adapter
rejections become the static internal error at the action boundary. `disposeFile` and context disposal
are synchronous, nonthrowing, and idempotent.

The process adapter uses one private typed N-API boundary. These declarations do not enter the domain
or action ports:

```ts
declare const NATIVE_SECURE_FILE_HANDLE: unique symbol;
declare const NATIVE_PERMANENT_LOCK_HANDLE: unique symbol;

type NativeFileCaptureFailureReason = "unavailable" | "unsafe";
type NativeFileReadFailureReason = "changed" | "limitExceeded" | "unavailable" | "unsafe";

type NativeOutcome<T, Reason extends string> =
  | { kind: "succeeded"; value: T }
  | { kind: "failed"; reason: Reason };

interface NativeSecureFileHandle {
  readonly [NATIVE_SECURE_FILE_HANDLE]: never;
}

interface NativePermanentLockHandle {
  readonly [NATIVE_PERMANENT_LOCK_HANDLE]: never;
}

interface NativeRunRootIdentity {
  readonly bootSessionId: string;
  readonly mountSessionId: string;
  readonly lockObjectId: string;
}

interface AgentCoreNativeAdapter {
  captureTrustedFile(
    path: string,
  ): NativeOutcome<NativeSecureFileHandle, NativeFileCaptureFailureReason>;
  readVerifiedFile(
    handle: NativeSecureFileHandle,
    byteCap: number,
  ): NativeOutcome<Uint8Array, NativeFileReadFailureReason>;
  closeTrustedFile(handle: NativeSecureFileHandle): void;
  openPermanentLock(
    path: string,
  ): NativeOutcome<NativePermanentLockHandle, "unavailable" | "unsafe">;
  lockExclusive(handle: NativePermanentLockHandle): NativeOutcome<undefined, "unavailable">;
  tryLockExclusive(
    handle: NativePermanentLockHandle,
  ): NativeOutcome<"acquired" | "busy", "unavailable">;
  closePermanentLock(handle: NativePermanentLockHandle): void;
  identifyRunRoot(
    path: string,
    lock: NativePermanentLockHandle,
  ): NativeOutcome<NativeRunRootIdentity, "unavailable" | "unsafe">;
}
```

The JavaScript loader validates every argument and result, catches all native exceptions, and maps
them to the closed outcomes above. Handles expose no descriptor number, path, metadata, read method,
or arbitrary native error. Close is synchronous, nonthrowing, and idempotent. `readVerifiedFile`
performs the complete pre-read, bounded positional read, post-read, and path-identity transaction
inside the native boundary; JavaScript cannot accidentally separate those checks. Lock operations
use Linux OFD `fcntl`, macOS `flock`, and Windows `LockFileEx`. The addon also returns the
kernel-provided boot-session and current mount-instance identities used by the stale reaper. An
unavailable or malformed OS primitive fails closed. Run-root and lock-object identities are returned
only as fixed lowercase-hex opaque digests, never raw host, SID, volume, mount, or path data.
The process adapter maps `unavailable`, `unsafe`, `changed`, and `limitExceeded` only to
`fileUnavailable`, `fileUnsafe`, `fileChanged`, and `invalidValue`, respectively.

Linux derives those identities from `/proc/sys/kernel/random/boot_id`, `statx` mount ID, and the held
lock's device/inode; macOS uses `kern.bootsessionuuid`, `statfs` filesystem ID, and the held lock's
file ID; Windows uses `SystemBootEnvironmentInformation.BootIdentifier`, volume GUID/serial, and
`FILE_ID_INFO` from the held lock. Each platform hashes a length-delimited typed tuple, so component
concatenation is unambiguous. If the documented primitive or required field is unavailable, mutation
cleanup is audit-only.

The context factory owns construction transactionally. It captures file locators in selection order;
if any later selection, validation, cancellation, or adapter call fails, it disposes every locator and
drops every literal/reference before returning. The caller similarly owns the selections and any
created context in `try/finally` until a successful preparation handoff. Raw JSON extraction,
selection construction, context construction, and `prepare()` therefore form one creator-owned
transaction rather than a sequence with unowned secret-bearing intermediates.

`SecretSourceReader` applies these safeguards:

- Reject stdin when it is a TTY. Interactive users use the hidden prompt instead.
- Read stdin as a bounded stream and stop once the slot's byte cap is exceeded.
- When a file source is selected, the native adapter resolves the originally supplied path to its
  canonical target without reading content, opens that target read-only and nonblocking with
  final-component no-follow and non-inheritable semantics, and retains the open descriptor or handle
  inside the opaque locator until context disposal. On POSIX this uses
  `O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC`. Windows uses `CreateFileW` with a
  non-inheritable handle, reparse inspection, and sharing that permits reads but denies concurrent
  write, delete, or security-descriptor mutation.
- Capture the original and canonical path identities, device/inode or volume/file ID, mount instance,
  regular-file mode, owner, ACL/DACL, size, and the strongest stable generation/change metadata
  available from the held descriptor. POSIX accepts only an effective-user-owned regular file whose
  permission bits are exactly `0400` or `0600` and whose descriptor ACL is trivial. A root process
  therefore accepts only UID-0 ownership. Windows accepts only a current-principal- or
  Administrators-owned regular file whose effective DACL grants any read, write, append, delete,
  owner, or DACL-changing access solely to the current principal, LocalSystem, or Administrators.
  Unknown, object-specific, or unmappable allow entries fail closed; inherited entries are evaluated
  by their effective principal and rights rather than trusted by inheritance alone. This prevents the
  CLI from labeling a group/world-readable secret file as safe, not merely from accepting a writable
  one.
- At acquisition, open the current canonical path again with no-follow semantics only to compare its
  identity and mode with the held handle, then close the check handle. Re-resolve the originally
  supplied path and require it to reach the same held object, so accepted selection-time symlinks
  cannot be silently retargeted. Read from byte zero through the original held handle using bounded
  positional reads, never through the pathname or check handle. Holding the original object prevents
  unlink-and-inode-reuse substitution.
- Compare identity, mount, mode, owner, permissions, ACL/DACL, size, and generation/change metadata
  immediately before and after the bounded read, and recheck that both original and canonical paths
  still name the held object. Different-inode replacement, symlink retargeting, in-place writes that
  alter available change metadata, permission changes, and changes during the read fail with
  `fileChanged`.
- Symlinks in the originally supplied path are accepted only through the canonical regular file opened
  and retained at selection. Directories, devices, FIFOs, sockets, reparse targets, and later path
  replacements are rejected.
- Production file sources are supported only on local ext4, XFS, Btrfs, or tmpfs on Linux; local APFS
  or HFS+ on macOS; and local NTFS or ReFS on Windows. The adapter requires descriptor ACL APIs and
  nanosecond change metadata on POSIX, and file-ID, change-time, owner, and DACL APIs on Windows.
  Network, FUSE, overlay, DrvFS, unknown, or capability-deficient filesystems return `fileUnsafe`.
  These checks do not claim to detect an adversarial same-inode rewrite by the already-trusted owner
  on a filesystem that fails to expose a corresponding metadata change; such a filesystem is outside
  the allowlist.
- Decode as strict UTF-8 and preserve whitespace and newlines.
- Enforce both the byte cap before decoding and the modeled character constraint after decoding.

The native implementation uses descriptor APIs, not subprocess output or pathname-only checks:
Linux uses `open`, `fstat`/`statx`, `fstatfs`, and libacl; macOS uses `open`, `fstat`/`statfs`, and
descriptor ACL APIs; Windows uses `CreateFileW`, `GetFileInformationByHandleEx`, `GetSecurityInfo`,
and explicit ACE inspection after generic-rights expansion. POSIX accepts only ACLs equivalent to the
mode bits. Windows rejects a null/unprotected/unverifiable DACL and any allowed principal outside the
three listed above. Unsupported builds keep prompt, stdin, environment, and warned literal sources
available but reject `--*-file` with static `fileUnsafe` guidance; there is no JavaScript fallback that
weakens the contract.

The byte cap is four times the modeled maximum character count:

| Secret family             | Modeled character maximum | Reader byte cap |
| ------------------------- | ------------------------: | --------------: |
| API key                   |                    65,536 |         262,144 |
| OAuth and payment secrets |                     2,048 |           8,192 |

Environment, file, stdin, prompt, and literal values all pass through the same character validation.
Managed values must contain at least one character. Public-client custom OAuth uses a no-secret
authentication configuration instead of an empty secret.

### AgentCore Storage Mode

Each secret slot resolves to one of:

- `MANAGED`: send the resolved value to AgentCore.
- `EXTERNAL`: send a Secrets Manager `SecretReference`; the CLI does not read the external value.

The resolver enforces mutual exclusivity between managed values and external references.

Current source normalization produces `KnownManaged`, `KnownExternal`, `KnownAbsent`, or
`UnknownCurrentSource`. Absence is known only when both the source and secret ARN/reference are absent
and the effective authentication method permits no secret. If a populated slot's source is omitted or
contradictory, Update returns the exact slot-bearing `unknownCurrentSource` outcome before reading a
replacement secret or sending Update. The CLI never infers current source from the desired source, a
secret ARN, or user assertion.

Live probes confirmed that the current service rejects switching between `MANAGED` and `EXTERNAL`
during update in both directions for API keys, OAuth client secrets, and all four payment secret
slots. The CLI detects a requested switch after `Get` and fails before mutation. It explains that the
user must create a replacement provider, update its consumers, and then delete the old provider. It
never automates a non-atomic delete and recreate.

A separate retained verification probe confirmed same-mode EXTERNAL rotation to a new secret ARN and
JSON key for API key, OAuth, Coinbase API-key/wallet, and Stripe/Privy app/private-key slots. The CLI
therefore permits EXTERNAL-to-EXTERNAL reference replacement while preserving the storage mode.

Secret values:

- Exist only in transient action state.
- Are never written to project or user configuration.
- Are never included in review models.
- Are never emitted to stdout or stderr.
- Are value-redacted from any optional diagnostic rendering.

Every mutation commit receives a `CommitSecretContext` distinct from its `PreparedMutation`. The
context state owns all literal values, managed-value acquisition locators, the `SecretSourceReader`,
the optional hidden-prompt callback, and any resolved values. Its public shell and module-private
reservation, binding, and claim machinery have a synchronous one-use lifecycle:

```text
open-unbound --reserve preparation--> preparing --bind(plan token, fingerprint)--> open-bound
      |                                  |                                           |
      |                                  `--preparation reservation.dispose()-------> disposed
      |                                                                              |
      `----------------context.dispose()--------------------------------------------> disposed

open-bound --claim matching pair--> claimed shell + commit lease
      |                                      |
      `--context.dispose()--> disposed        `--commit lease.dispose()--> disposed
```

At `prepare()` entry, the action synchronously reserves an `open-unbound` context before its first
`await`. The opaque module-private preparation reservation owns the context state while preparation is
pending. A context already preparing, bound, claimed, or disposed returns
`secretContextFailed/unavailable` without an AWS call and without consuming or disposing that foreign
state. This makes concurrent or stale reuse of one context fail before either preparation can split
ownership.

An unbound replacement capability uses the same coordinator through its synchronous
`bindContext()` method. It atomically reserves both an `open-unbound` context and the replacement's
`awaiting-context` state before any other caller can intervene, validates the context's
slot/source-kind inventory against the replacement's ordered requirements, and binds the
replacement's existing private token and fingerprint. It performs no AWS call and has no `await`.
A context that is not open leaves both objects unchanged with
`secretContextFailed/unavailable`; a consumed or disposed replacement leaves the context unchanged
with `alreadyConsumed`.

On a successful preparation, the action mints a new frozen object-identity token and computes the
SHA-256 fingerprint of the ordered secret requirements. The preparation reservation stores both
privately in the capability and atomically binds the same pair into the context before returning it to
`open-bound`. The token is never serialized, rendered, returned independently, or accepted from
caller data. Equal requirement fingerprints from two plans do not make their distinct object tokens
interchangeable.

Before binding, the preparation reservation may inspect only the context's module-private
slot/source-kind inventory, never a literal value, environment value, file content, stdin, or prompt.
Duplicate, conflicting, or extra selections return closed validation errors. In noninteractive mode,
absent required selections return one `missingSecrets` error whose slots follow catalog order;
interactive fallback prompt selections satisfy inventory without invoking the prompt.

Replacement binding applies the identical inventory rules. On an inventory failure it disposes the
reserved context state, restores the still-secret-free replacement to `awaiting-context`, and returns
`validationFailed`; Ink may construct a corrected fresh context and try again. On success it
atomically transfers the binding and plan state into a normal `PreparedMutation`, consumes the
unbound replacement shell, and returns the newly bound pair. No old context, locator, literal, prompt,
stdin, environment selection, or acquired value participates in this transfer.

Commit verifies token identity and fingerprint equality before changing either ownership state. A
cross-plan context, stale context from a replacement plan, or duplicate call with a foreign context
returns `secretContextFailed/mismatch` and leaves both supplied objects exactly as they were. Only a
matching pair can enter the coordinator's atomic capability/context claim. Claim moves all
context-owned state
into an opaque internal `CommitSecretLease` and leaves the context shell inert. Presentation code has
no `claim` or `resolve` method in its type or runtime surface.

`context.dispose()` is idempotent and can consume `open-unbound` or `open-bound`. It is a no-op while a
preparation reservation owns the state or after a successful commit claim, so presentation cleanup
cannot disrupt either in-flight owner. The preparation reservation disposes on every non-`prepared`
outcome and unexpected rejection. `lease.dispose()` is idempotent and runs in the winning commit's
`finally`. If the matching context was already disposed or otherwise cannot be claimed, commit
consumes and destroys that capability's binding and returns `secretContextFailed/unavailable`; no slot
is invented for this context-level failure.

The parser or TUI creates the context and initially owns it. A preparation action or replacement
binder synchronously moves its state into a reservation without reading secret content. A `prepared`
outcome returns the rebound open context beside, but not inside, the immutable capability. The action
or replacement binds it only after the capability is complete. The reservation disposes the state
before returning `noChange` or any later failure. A failure to reserve leaves the unavailable foreign
context unchanged. Until a prepared pair is installed in presentation state, the creator retains a
`try/finally` disposal guard around its own selections, context shell, and returned capability.

After a prepared review, the presentation owns the matching pair. Commit synchronously transfers the
context into a lease; cancellation, abandoned review, screen unmount, or an error boundary disposes
the still-open context and prepared capability. A duplicate using the matching claimed shell returns
`alreadyConsumed`; a foreign context is never disposed by the old capability. Every success, error,
cancellation, credential-expiry, uncertain mutation outcome, unavailable committed output, and
reprepare path disposes the winning lease.

Ink preparation owns an `AbortController` and monotonically increasing request generation. Unmount or
superseding input aborts the pending action and marks that generation unowned. A completion handler
installs a prepared pair only when the screen is still mounted and the generation is current;
otherwise it immediately disposes both the late capability and context. This late-result rule is
mandatory even when the underlying credential or endpoint provider cannot be aborted. Commander uses
the same ownership handoff in a lexical `try/finally`.

Disposal removes all references the CLI controls; it does not claim JavaScript zeroization. A
`ReplacementPreparation` never carries a context or acquired/literal values. Commander exits and
requires a rerun. Ink may retain non-secret form choices, but after reviewing the replacement it must
construct a new context, bind it through the replacement capability, and reacquire or re-prompt every
managed value before committing the returned prepared plan.

JavaScript does not provide reliable memory zeroization for immutable strings or copies made by the
runtime and SDK. The implementation minimizes lifetime and references, drops bindings immediately
after the send settles, and does not claim cryptographic erasure.

## Request Flow

Mutation preparation returns an opaque, single-use `PreparedMutation` capability. Preparation never
reads environment values, file contents, stdin, or hidden prompts and never creates an SDK request
containing secret bytes. Capturing regular-file identity for an opaque file locator is metadata
validation, not secret-content acquisition.

The safe error and action result contracts are exact:

```ts
type IdentityOptionId = keyof typeof IDENTITY_OPTION_CATALOG;
type IdentitySchemaPath = keyof typeof IDENTITY_SCHEMA_PATH_CATALOG;
type SecretSlotId = keyof typeof IDENTITY_SECRET_SLOT_CATALOG;
type IdentityResourceFamily = "apiKey" | "oauth2" | "payment" | "workload" | "tokenVault" | "tags";

type ReviewValue =
  | null
  | boolean
  | number
  | string
  | readonly ReviewValue[]
  | readonly Readonly<{ key: string; value: ReviewValue }>[];

interface IdentityReviewModel {
  readonly operation: keyof IdentityMutationOperations;
  readonly target: Readonly<{
    family: IdentityResourceFamily;
    name?: string;
    arn?: string;
  }>;
  readonly changes: readonly Readonly<{
    path: IdentitySchemaPath;
    action: "set" | "clear" | "replace" | "preserve";
    before?: ReviewValue;
    after?: ReviewValue;
  }>[];
  readonly secretRequirements: readonly Readonly<{
    slot: SecretSlotId;
    source: "MANAGED" | "EXTERNAL";
    action: "provide" | "preserve" | "rotate" | "remove";
  }>[];
}

type SafeServiceCode =
  | "AccessDeniedException"
  | "ConcurrentModificationException"
  | "ConflictException"
  | "DecryptionFailure"
  | "EncryptionFailure"
  | "InternalServerException"
  | "ResourceLimitExceededException"
  | "ResourceNotFoundException"
  | "ServiceQuotaExceededException"
  | "ThrottlingException"
  | "UnauthorizedException"
  | "ValidationException";

type SecretContextErrorReason = "mismatch" | "unavailable";

type SecretContextError<Reason extends SecretContextErrorReason = SecretContextErrorReason> =
  Readonly<{
    category: "secretContext";
    reason: Reason;
  }>;

type SafeIdentityError =
  | {
      category: "usage";
      reason:
        | "conflictingInput"
        | "inapplicableInput"
        | "invalidJson"
        | "invalidValue"
        | "missingInput"
        | "storageModeChangeUnsupported";
      option?: IdentityOptionId;
      path?: IdentitySchemaPath;
    }
  | {
      category: "usage";
      reason: "missingSecrets";
      slots: readonly [SecretSlotId, ...SecretSlotId[]];
    }
  | {
      category: "secret";
      reason:
        | "environmentUnavailable"
        | "fileChanged"
        | "fileUnavailable"
        | "fileUnsafe"
        | "invalidValue"
        | "promptUnavailable"
        | "stdinUnavailable";
      slot: SecretSlotId;
    }
  | SecretContextError
  | {
      category: "service";
      code: SafeServiceCode | "UnknownServiceError";
      httpStatus?: number;
      requestId?: string;
    }
  | { category: "internal" };

type QueryFailure =
  | { kind: "notFound" }
  | { kind: "cancelled" }
  | { kind: "paginationFailed" }
  | { kind: "sdkCompatibilityRequired" }
  | { kind: "credentialRefreshRequired" }
  | { kind: "validationFailed"; error: SafeIdentityError }
  | { kind: "serviceFailed"; error: SafeIdentityError };

type PrepareSecretContextFailure = {
  kind: "secretContextFailed";
  error: SecretContextError<"unavailable">;
};

type PrepareFailure =
  | { kind: "notFound" }
  | { kind: "cancelled" }
  | { kind: "sdkCompatibilityRequired" }
  | { kind: "unsupportedProvider" }
  | { kind: "unsupportedResourceStatus" }
  | { kind: "unknownCurrentSource"; slot: SecretSlotId }
  | { kind: "credentialRefreshRequired" }
  | { kind: "validationFailed"; error: SafeIdentityError }
  | { kind: "serviceFailed"; error: SafeIdentityError }
  | PrepareSecretContextFailure;

type CommitFailure =
  | PrepareFailure
  | { kind: "secretContextFailed"; error: SecretContextError<"mismatch"> }
  | { kind: "secretResolutionFailed"; error: SafeIdentityError };

type QueryOutcome<T> = { kind: "succeeded"; value: T } | QueryFailure;

type MutationPolicy = "direct" | "continuityGuarded" | "replacement";
type RepreparableMutationPolicy = Exclude<MutationPolicy, "direct">;

type PrepareOutcome<P extends MutationPolicy, T> =
  | {
      kind: "prepared";
      mutation: PreparedMutation<P, T>;
      secrets: CommitSecretContext;
    }
  | (P extends "replacement" ? { kind: "noChange"; value: T } : never)
  | PrepareFailure;

type CommonCommitOutcome<T> =
  | { kind: "committed"; value: T }
  | { kind: "mutationOutcomeUnknown" }
  | { kind: "committedOutputUnavailable" }
  | { kind: "alreadyConsumed" }
  | CommitFailure;

type CommitOutcome<P extends MutationPolicy, T> =
  | CommonCommitOutcome<T>
  | (P extends "replacement" ? { kind: "noChange"; value: T } : never)
  | (P extends "direct"
      ? never
      : {
          kind: "reprepareRequired";
          replacement: ReplacementPreparation<Extract<P, RepreparableMutationPolicy>, T>;
        });

type BindReplacementOutcome<P extends RepreparableMutationPolicy, T> =
  | {
      kind: "prepared";
      mutation: PreparedMutation<P, T>;
      secrets: CommitSecretContext;
    }
  | { kind: "alreadyConsumed" }
  | { kind: "secretContextFailed"; error: SecretContextError<"unavailable"> }
  | { kind: "validationFailed"; error: SafeIdentityError };

interface IdentityQueryAction<Input, Output> {
  execute(input: Readonly<Input>, options?: IdentityCallOptions): Promise<QueryOutcome<Output>>;
}

interface IdentityMutationAction<P extends MutationPolicy, Input, Output> {
  prepare(
    input: Readonly<Input>,
    secrets: CommitSecretContext,
    options?: IdentityCallOptions,
  ): Promise<PrepareOutcome<P, Output>>;
}

interface PreparedMutation<P extends MutationPolicy, T> {
  readonly review: IdentityReviewModel;
  commit(secrets: CommitSecretContext, options?: IdentityCallOptions): Promise<CommitOutcome<P, T>>;
  dispose(): void;
}

interface ReplacementPreparation<P extends RepreparableMutationPolicy, T> {
  readonly review: IdentityReviewModel;
  bindContext(secrets: CommitSecretContext): BindReplacementOutcome<P, T>;
  dispose(): void;
}
```

There is one `IdentityQueryAction` instance for every Get, List, and List Tags command and one
`IdentityMutationAction` instance for every Create, Update, Delete, Tag, Untag, and Set CMK command.
Their concrete input and output types are the command-specific intent and V1 DTO types; no action
returns an SDK output type. Mutations with no secret slots receive the same one-use context in an
empty state, keeping one ownership protocol instead of a second capability type. The three
compile-time catalogs contain only CLI-authored option IDs, schema paths, and secret slot IDs.
Renderers select static guidance from the discriminants. No arbitrary message, option spelling,
schema key, environment name, file path, or service body can inhabit `SafeIdentityError`.

The operation-policy mapping is exact:

| Policy              | Operations                              | Prepare `noChange` | Commit `noChange` | `reprepareRequired` |
| ------------------- | --------------------------------------- | ------------------ | ----------------- | ------------------- |
| `direct`            | All Creates and direct-ARN Tag/Untag    | Impossible         | Impossible        | Impossible          |
| `continuityGuarded` | All Deletes and name-selected Tag/Untag | Impossible         | Impossible        | Allowed             |
| `replacement`       | All Updates and Set CMK                 | Allowed            | Allowed           | Allowed             |

Selector parsing chooses the Tag/Untag policy before preparation, so a concrete capability never has
a runtime-optional policy. Conditional outcome types make impossible `noChange` and
`reprepareRequired` states uninhabitable instead of relying on prose.

Only `reprepareRequired` carries an unbound `ReplacementPreparation`, and only `prepared` carries an
open bound context. The replacement has review, bind, and dispose operations but no commit operation.
Commit checks context pairing before capability consumption. A mismatched foreign context returns
`secretContextFailed/mismatch` without disposing either object. `alreadyConsumed` applies to the
original matching context shell after a prepared capability left `prepared`, and to a replacement
shell after successful bind or explicit disposal. All error members carry only closed safe data.
PascalCase outcome labels in the surrounding prose refer to these exact lower-camel `kind`
discriminants.

Commit-time `noChange` is defined only for a guarded replacement mutation whose fresh rebase already
equals the requested effective state and has no remaining opaque secret rotation/removal, including
the case where another actor applied the non-secret state after review. It returns the normalized
fresh Get value and sends no mutation. It can be detected before secret acquisition or after the
second Get; the latter path first disposes the acquired lease.

Once preparation reserves a context and creates a binding, only a `prepared` outcome transfers both
back as a bound pair; every other outcome destroys the binding and disposes the preparation
reservation. A failed reservation leaves the foreign context unchanged and creates no binding. Once a
matching commit claim creates a binding lease, commit destroys that lease for every outcome except
successful transfer through `reprepareRequired`. The returned `ReplacementPreparation` then owns that
binding in `awaiting-context`; successful `bindContext()` transfers it exactly once to a new prepared
capability, while replacement disposal destroys it. Pairing mismatch and `alreadyConsumed` create no
lease and leave the supplied context unchanged.

Each query action creates and owns one binding inside `try/finally`. It passes the caller's
`AbortSignal` to every read and paginator send, catches cancellation as `cancelled`, fully buffers and
normalizes all requested pages inside the action, and disposes the binding exactly once after success,
validation failure, pagination failure, cancellation, or an unexpected rejection. No
`AsyncIterable`, client, or binding escapes the action. The action returns no partial all-results
value after cancellation or pagination failure.

### Preparation

End-to-end Create preparation:

1. The presentation parses scalar and JSON syntax.
2. The presentation transactionally extracts secret selections and creates a presentation-owned
   `CommitSecretContext`.
3. The action synchronously reserves the unbound context before its first `await`.
4. The action rejects option conflicts and validates all provider-independent structure.
5. It resolves and validates the provider descriptor.
6. It validates family-specific non-secret semantics.
7. It determines the exact secret slots required at commit.
8. It creates the action's exact operation-specific binding.
9. It produces canonical commit state and a review model derived from it.
10. It mints the private plan token, binds the context to that token and the ordered-requirement
    fingerprint, and returns the pair.

Update rejects local syntax errors, option conflicts, and provider-independent invalid values before
Get. At action entry it first reserves the context synchronously, then performs those local checks,
creates one exact current-state mutation binding, performs its initial Get, identifies the actual
vendor/family, applies family-specific validation, checks the operation-specific writable-state
policy, normalizes current state, applies only explicit patch intent, and derives the same state and
secret requirements.
It preserves the original explicit intent so commit can rebase instead of replaying a prebuilt
request. Options whose validity depends on the current vendor are deliberately validated after Get;
user-supplied vendor or config assertions are never trusted as current-state evidence.

The action owns the preparation reservation and any newly created binding in `try/finally` until it
atomically returns a complete bound pair. The presentation creator independently retains its
context-shell/selection disposal guard until it installs that pair. Cancellation or an unexpected
rejection closes both ownership paths without one disposer racing the other. A TUI generation that
becomes stale before completion aborts its action and immediately disposes a late pair as described
under Secret Handling.

OAuth Update permits only an absent status, `READY`, or `UPDATE_FAILED`. Any other known or future
status returns `UnsupportedResourceStatus` before secret acquisition. This allowlist reflects current
Update service behavior and is not shared by other operations. Delete uses its own service workflow
checks and does not impose a persisted-status allowlist. Tag and Untag are existence/authorization
operations and do not inherit an Update readiness gate.

OAuth and payment Updates use a compatibility-guarded Get for preparation and every commit-time
rebase through `readCompatibilityGuardedCurrent`; no other call path has that method. Middleware is
registered relative `after` `deserializerMiddleware`, which places it on the response path before the
generated deserializer consumes the body. It bounds every raw response, success or error, while
`bodyBytes <= 1_048_576`; 1,048,576 bytes is accepted and the next byte fails. On overflow it
immediately destroys a Node-readable body or cancels a Web stream, without draining or retaining
additional chunks. For an accepted 2xx response it parses the bytes, validates them with an explicit
operation-specific `RawWireSchema`, restores the exact bytes as a new `Uint8Array`, and permits normal
SDK deserialization. For an accepted non-2xx response it restores the exact bytes without schema
validation and permits bounded SDK error deserialization. An oversized non-2xx response becomes a
closed static `serviceFailed` result carrying at most validated status/request-ID metadata; its body is
never passed to Smithy's collector.

`RawWireSchema` is a separate hand-reviewed registry for the JSON protocol representation of OAuth
and payment Get responses. It does not reuse V1 DTO schemas, SDK TypeScript output types, or
`NormalizedSchema`. Every structure has an exact wire-key allowlist and explicit required/optional
members; every known union requires exactly one member; lists recurse; maps admit arbitrary keys but
validate their value wire type; strings, booleans, finite JSON numbers, timestamp numbers, arrays, and
objects are checked according to their pinned protocol shape; and `null` is rejected where the model
does not admit it. The registry deliberately treats OAuth `clientSecretArn` as optional for valid
no-secret IAM-JWT providers, while retaining the generated required members for names, ARNs, vendors,
provider configuration, dates, and required payment secret references. It performs structural drift
detection only, not length, pattern, endpoint, or business-rule validation.

An oversized, malformed, truncated, or structurally unknown successful body returns
`sdkCompatibilityRequired` using static text. The unknown name, value, or body is not logged,
rendered, retained, or included in fixtures.

This guarded path exists because SDK `3.1079.0` silently drops additive members inside known OAuth
and payment structures on both deserialize and serialize. Internal service-model mainline already
contains `PRIVATE_KEY_JWT` and `privateKeyJwtConfig`, which this pinned SDK does not model. Attempting
to rehydrate an Update through the old model could therefore omit configuration the CLI cannot see.
Ordinary Get/List reads remain tolerant and render only the normalized V1 allowlist; API-key,
workload, Delete, Tag, Untag, and List Tags do not reconstruct these provider unions and do not use
the compatibility guard.

The private frozen plan behind a `PreparedMutation` or unbound `ReplacementPreparation` contains only:

- Operation, resource selector, and immutable provider identity.
- Explicit non-secret intent, desired storage modes, and external references.
- A `CommitGuard`.
- A canonical review model derived from guarded state.
- Its private unforgeable plan token and ordered secret-requirement fingerprint.
- Its private operation-scoped binding.

The `CommitGuard` is presentation-independent and contains:

- Resource family, canonical ARN, and `createdTime` for provider and workload resources.
- Immutable vendor identity where applicable.
- `lastUpdatedTime` for provider and workload updates.
- A SHA-256 fingerprint of the complete secret-free effective request skeleton.
- A SHA-256 fingerprint of ordered secret-slot requirements.

The request-skeleton fingerprint includes every non-secret field that the mutation will send, every
preserved EXTERNAL secret ARN/ID and JSON key, each current secret-source state, workload return URLs,
and operation-specific tag changes. It excludes secret bytes, env names, file paths, prompt state,
callback URL, status, failure reason, transport metadata, and tags for operations that do not mutate
tags. Timestamps are compared as explicit guard fields instead of being hidden in the fingerprint.
Token-vault guards use vault ID, canonical KMS configuration, and `lastModifiedDate`.

All plan data and nested values are frozen. The capability contains no literal, prompt, stdin, env, or
file secret value. The TUI renders its review model and confirms it. An explicit Commander mutation
authorizes its capability without an additional review prompt, except `token-vault set-cmk`.

Capability ownership uses this state machine:

```text
prepared --commit()--> committing --> consumed
    \-----dispose()-----------------> disposed

replacement awaiting-context --bindContext()--> binding --> consumed + prepared pair
            \--------dispose()----------------------------> disposed
```

`PreparedMutation.dispose()` is synchronous and idempotent. It can consume only `prepared`, atomically
detaches and destroys that capability's binding, and then transitions to `disposed`. It is a no-op in
`committing` or `consumed` because commit has already moved binding ownership into a commit-local
lease, and a no-op in `disposed` because disposal already destroyed it. This makes
cancellation/unmount safe even when it races a submit.

`ReplacementPreparation.dispose()` is likewise synchronous and idempotent. It can consume only
`awaiting-context`, detach and destroy the binding, and transition to `disposed`. `bindContext()` and
`dispose()` reserve that state in one synchronous turn, so exactly one can obtain the binding. A
successful bind transfers ownership into the returned prepared capability before marking the
replacement consumed. A validation failure occurs wholly inside `binding`, disposes the rejected
context reservation, and restores `awaiting-context`; an unavailable foreign context or
already-consumed replacement changes neither object. Disposing or rebinding a consumed replacement is
inert and cannot affect its returned prepared pair.

### One-Shot Commit

`PreparedMutation.commit()` first synchronously verifies the supplied context's private token and
requirement fingerprint without changing either object. A mismatch returns
`secretContextFailed/mismatch`; even an already-consumed or disposed old capability does not dispose a
foreign context. With a matching context, a capability not in `prepared` returns `alreadyConsumed` and
also leaves that context unchanged. Otherwise the shared coordinator atomically claims `prepared`,
moves the binding into a commit-local ownership lease, claims the context, and transitions the
capability through `committing` to terminal ownership before its first `await`. If that matching
context is unavailable, the capability remains consumed, its binding lease is destroyed, and commit
returns `secretContextFailed/unavailable`.

Every later call with the original matching context returns `alreadyConsumed` without reading secrets
or calling AWS, including concurrent calls made while the first is pending and calls made after
explicit capability disposal. Because the winning state transition, binding transfer, and secret
claim are one synchronous turn, a duplicate observes an inert claimed shell and cannot disrupt the
winner. An original matching context that is still open after capability disposal remains
presentation-owned and unchanged by the rejected commit. Ink submit handlers also use a synchronous
ref latch so buffered confirmation input cannot enter commit twice.

For Update, commit:

1. Claims capability, binding, and secret ownership synchronously as described above.
2. Verifies that the binding's immutable credential snapshot remains outside the refresh window.
3. Performs a fresh Get with the binding's read client and compatibility guard where required.
4. Rechecks provider support and operation-specific status, then rebases the original explicit intent
   on that normalized state.
5. Returns commit-time `noChange` if the fresh effective state already equals the requested state;
   otherwise recomputes and compares the complete `CommitGuard` before reading any secret source.
6. Resolves env, file, and stdin through the context's `SecretSourceReader` and prompt values through
   its hidden-prompt callback, all through the claimed secret lease.
7. Rechecks credential expiration without refreshing.
8. Performs a second Get with the same read client and compatibility guard.
9. Rechecks provider support and status, then rebases and compares the complete guard again
   immediately before request construction; a newly reached no-op returns the normalized fresh state
   after disposing acquired values.
10. Rechecks credential expiration after the retrying read and immediately before any mutation send.
11. Composes one exact SDK union from the second state at adapter-owned secret paths.
12. Runs strict Zod request and semantic validation.
13. Sends one mutation command through the binding's `maxAttempts: 1` mutation client and classifies
    the exact `MutationTransportOutcome`.
14. Disposes the secret lease in `finally`; destroys the binding lease on terminal outcomes.

Commit outcomes are a closed union. `ReprepareRequired` contains an unbound replacement capability only
when the current resource is known, its provider and response shape are supported, its status is
writable for this operation, and the original explicit intent can be reconstructed completely against
the new state. `NotFound`, `SdkCompatibilityRequired`, `UnsupportedProvider`,
`UnsupportedResourceStatus`, `CredentialRefreshRequired`, and validation failures are separate
outcomes and never carry a replacement capability. A mismatch after secret acquisition disposes all
resolved and literal values before returning. Ink renders the replacement review and requires a new
confirmation. Only then does it construct a new context and call `bindContext()` to obtain the pair it
may commit. Commander returns a typed state-changed error and requires the user to rerun the command;
it never binds or authorizes a replacement plan on the original invocation. When a replacement is
returned, ownership of the same immutable operation binding transfers atomically from the commit-local
lease to `awaiting-context` before it is returned; the old capability cannot destroy or reuse it.
Commander disposes the unaccepted replacement before exiting. Commit never loops or auto-approves.

A pre-dispatch rejection maps through the normal closed safe-error classifier and means no mutation
request reached the HTTP handler. A complete 4xx response maps to `serviceFailed`; the modeled
Identity 4xx status is rejection evidence. If dispatch began but no complete response was observed, a
complete 5xx response was observed, or the complete status is outside the classified 2xx/4xx sets,
commit returns `mutationOutcomeUnknown`. Static guidance states that the mutation may have applied and
requires a fresh Get before any user-directed retry. This remains true when a service applied the
mutation but failed while producing a 500 response. If a complete 2xx response was observed but
deserialization, output validation, or normalization is unusable, commit returns
`committedOutputUnavailable`; static guidance states that the mutation committed but its response
could not be represented. Neither outcome is automatically retried, mapped to
`sdkCompatibilityRequired`, or presented as proof that no state changed.

Cancellation is phase-aware. Cancellation during preparation, guarded reads, source acquisition, or
before mutation dispatch returns `cancelled`. Once the mutation handler has been invoked, an abort or
transport rejection without a complete response returns `mutationOutcomeUnknown`, never `cancelled`.

Create has no current-resource guard but uses one operation binding and one secret context. Delete
preparation records ARN, family, and creation time, then commit Gets by name with the same binding and
compares identity immediately before deletion. A missing target returns `NotFound`; a reused name can
return `ReprepareRequired` only when the replacement is fully supported. Name-selected Tag and Untag
use the same Get-backed target continuity. Direct-ARN Tag and Untag deliberately issue no Get or STS:
after local family/region validation, commit sends the exact ARN once and lets AWS authorization
decide. Direct-ARN mode therefore retains an unavoidable target-lifecycle race. Set CMK compares
vault ID, KMS configuration, and `lastModifiedDate` from a final Get before sending. Read-only Get,
List, and List Tags do not use mutation capabilities; name-selected List Tags resolves through Get,
while direct-ARN List Tags sends the exact ARN without Get or STS.

The mutation client performs one SDK HTTP attempt because its `maxAttempts` is 1. The CLI does not
automatically retry an Identity mutation. Dispatch tracking distinguishes failures known to occur
before the handler from timeouts and disconnects after dispatch; the latter return
`mutationOutcomeUnknown`. Read clients retain the SDK's normal retry policy.

Final guard comparison reduces accidental lost updates but cannot make mutation atomic. The service
does not expose a customer-visible version token or conditional update, so a narrow Get-to-send race
remains and is documented as residual risk.

## Update Semantics

### Common Rules

- Omitted curated update fields remain unchanged; raw replacement follows its explicit omission and
  retention rules.
- Empty strings never implicitly mean clear.
- Clear operations are explicit.
- Immutable names and vendor types cannot change.
- Provider secret storage mode cannot change.
- Update with no mutation option fails before Get.
- An explicit secret input always counts as a rotation because the CLI cannot compare secret values.

Curated mode exposes only service-valid clear operations:

- OAuth `--clear-tenant-id` sends the explicit Microsoft tenant value `common`.
- Custom OAuth `--clear-client-id` and `--clear-on-behalf-of` omit those members from the complete
  replacement configuration. Live probes confirmed that the service removes both values.
- Custom OAuth `--clear-client-secret` omits secret material only when the explicit effective
  authentication method is `AWS_IAM_ID_TOKEN_JWT`. A live probe confirmed that transition.
- Workload identity `--clear-return-urls` sends an empty return-URL list.

JSON options are replacement units except where an unverified destructive transition is explicitly
blocked. Clear options are mutually exclusive with the corresponding value or JSON option. The CLI
does not offer clears for names, vendors, required discovery or per-tenant endpoints, authentication
method, API keys, payment secrets, private endpoints, or private endpoint overrides.
Private-endpoint removal semantics have not been established, so an existing private endpoint must be
retained and a non-empty override collection cannot be replaced by an empty array.

If explicit non-secret intent produces the same effective state and no secret input is present, the
action returns `NoChange` and makes no Update call. Commander emits the safe normalized Get response
as its one JSON document. The TUI reports that there are no changes. A secret input never takes this
path because equality is unknowable.

### OAuth

The service rebuilds OAuth configuration from the update request. It does not provide a general
preserve-on-omission contract for client secrets: omission fails validation for a secret-bearing
authentication method, and changing to a no-secret method removes an existing managed secret.
The CLI therefore:

- Fetches the current provider.
- Rehydrates all readable non-secret configuration.
- Applies the explicit patch.
- Preserves an EXTERNAL client-secret reference by reconstructing it from `Get`.
- Requires secure re-entry of a MANAGED client secret whenever the effective authentication method
  still requires one.
- In curated mode, never removes a client secret unless the user supplied `--clear-client-secret` and
  the resulting custom OAuth authentication configuration permits no secret. In raw replacement mode,
  the explicit no-secret authentication method is itself the removal intent.
- Resends required private endpoint and per-tenant endpoint fields.

For custom OAuth, the effective authentication mechanism drives secret behavior:

| Effective mechanism                                          | Create                                                                                    | Update without a new secret                                               | Transition behavior                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CLIENT_SECRET_BASIC`                                        | Requires client ID and a managed value or external reference                              | Preserves a reconstructable EXTERNAL reference; requires MANAGED re-entry | Transition from IAM-JWT requires a source and value/reference                                   |
| `CLIENT_SECRET_POST`                                         | Requires client ID and a managed value or external reference                              | Preserves a reconstructable EXTERNAL reference; requires MANAGED re-entry | Transition from IAM-JWT requires a source and value/reference                                   |
| Legacy metadata `client_secret_basic` / `client_secret_post` | Requires client ID and a managed value or external reference                              | Preserves a reconstructable EXTERNAL reference; requires MANAGED re-entry | Explicitly replaces, and is replaced by, the preferred method surface                           |
| `AWS_IAM_ID_TOKEN_JWT`                                       | Does not require a client secret                                                          | Does not request a client secret                                          | Curated transition requires `--clear-client-secret`; raw replacement is explicit removal intent |
| No explicit mechanism                                        | Raw Create only: requires a managed value or external reference when client ID is present | Rejected for Update because replacement semantics would be ambiguous      | Never accepted as an Update transition                                                          |

Supplying `--clear-client-secret` while the effective method is `CLIENT_SECRET_BASIC` or
`CLIENT_SECRET_POST` fails validation. A curated change to `AWS_IAM_ID_TOKEN_JWT` without the clear
also fails, so curated mode never removes a secret as an implicit side effect. Raw custom Update
always carries exactly one preferred or legacy mechanism, and selecting `AWS_IAM_ID_TOKEN_JWT` in the
replacement is explicit secret-removal intent. Omitted optional `clientId` and
`onBehalfOfTokenExchangeConfig` members in raw replacement mode are intentional removals. An explicit
`privateEndpoint` replaces the current value; omission retains an existing endpoint.
`privateEndpointOverrides` may be replaced with an explicit
non-empty array, but omission preserves the current overrides. An explicit empty array is allowed
only when it does not remove current entries; otherwise Update fails before secret acquisition until
private-endpoint removal semantics are proven.

Microsoft `Get` output does not return tenant ID. For an existing tenant-specific provider, the CLI
recovers it only from the exact canonical Microsoft discovery URL pattern. If the URL is not
recognized, curated Update requires explicit `--tenant-id` and raw replacement requires an explicit
`tenantId` in `microsoftOauth2ProviderConfig`; neither path silently resets to `common`.

The pinned SDK deserializes a future union member as `$unknown: [name, body]`. Reads expose only the
sanitized member name and never traverse the body. Update cannot safely reconstruct an unknown
replacement configuration and therefore fails closed without reading secrets or sending Update. SDK
drift tests reduce the support window, but service-side patch semantics remain the permanent
forward-compatibility improvement.

### Payment

The service currently requires every managed secret in a payment update, including when only a
non-secret identifier changes.

The CLI handles this without blocking the feature:

- Rehydrate all non-secret fields from `Get`.
- Preserve each reconstructable EXTERNAL reference from its `{ secretArn }` object, source, and JSON
  key.
- Require the user to supply every MANAGED secret slot again.
- Return slot-bearing `unknownCurrentSource` if `Get` does not identify a populated slot's current
  source; a desired source declaration is not evidence of current state.
- Reject a storage-mode switch for either slot.
- Build the complete vendor configuration.

For Coinbase this means API key secret and wallet secret. For Stripe/Privy this means app secret and
authorization private key.

### API Key

API-key update is credential rotation. It always requires a new managed value or a valid external
reference in the provider's existing storage mode. A same-mode EXTERNAL update supports a new secret
ID and JSON key.

### Workload Identity

The service replaces the complete return-URL list. The CLI supports three explicit intents:

- Omitted: keep current URLs.
- Replacement list: replace with the supplied URLs.
- Clear: send an empty list through an explicit clear option.

The TUI loads the current list and edits it as a complete collection. Replacement rejects duplicates
and more than five URLs.

### Token Vault

`get` defaults to the service's `default` vault. `set-cmk` calls `SetTokenVaultCMK` and validates:

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

`listAll` uses the generated paginator for the selected operation and buffers pages before rendering.
The adapter tracks every non-empty token and rejects a repeated token, including same-token and
multi-token cycles, before returning any result. It does not rely only on the generated
`stopOnSameToken` option because that option does not detect a cycle such as A, B, A. TUI pickers track
their visited token chain and stop with the same static `paginationFailed` outcome.

Pinned Smithy paginators mutate the input object while advancing `nextToken` and page size. The
adapter therefore creates one shallow mutable clone of the already-validated list input and passes
only that clone to the generated paginator. Caller-owned and frozen inputs remain unchanged. The
query action passes its `AbortSignal` as the paginator's additional call option, consumes the entire
paginator inside its binding-owning `try/finally`, and returns `cancelled` or `paginationFailed`
without a partial result.

Generated paginators require a real `BedrockAgentCoreControlClient` instance. Production, fake, and
fixture wiring preserve that instance requirement as described in Secret-Safe Record and Replay.

## Unknown Future Providers

Reads are forward-compatible:

- Unknown vendor values display only a sanitized vendor name.
- Unknown union members display only a sanitized config-member name.
- Unknown member bodies are never traversed or rendered.
- List and get do not crash because a catalog entry is absent.

Sanitized names allow ASCII letters, digits, period, underscore, colon, and hyphen, are capped at 128
characters, and fall back to `UNKNOWN` when empty or invalid. `$unknown` values and unrecognized
provider configuration objects are treated as untrusted response bodies.

Writes are fail-closed:

- Create and update require a known descriptor.
- A newly generated SDK vendor breaks compile-time exhaustiveness.
- A newly generated union member breaks schema contract tests.
- Raw mode rejects unknown operation members even when the SDK type carries `$unknown`.

## TUI Design

Bare Identity and resource commands mount Ink screens using the existing
`withTuiOnEmptyFlagsAndArgs` pattern after that middleware is corrected to use Commander option value
sources. The feature-owned route registry is the source for all Identity routes mounted in Root.

The TUI includes:

- Identity resource menu.
- Paged resource pickers.
- OAuth create and update wizard driven by family descriptors.
- API-key create and rotate flows.
- Payment create and update flows with independent secret prompts.
- Workload identity create and return-URL editing.
- Token-vault inspection and confirmed CMK change.
- Detail screens with status and safe normalized failure guidance.
- OAuth callback URL display on create, get, and update results.
- Delete confirmation.
- Tag list, add, and remove workflows.
- Redacted review steps before mutations.
- A `ReprepareRequired` state that displays the changed plan and requires a new confirmation.
- Loading, empty, error, cancellation, and success states.

The TUI does not expose a visual editor for every recursive SDK structure. Advanced nested OAuth and
payment configuration remains available through CLI JSON options. This matches Harness: common
workflows are ergonomic without reducing command completeness.

Payment menus and screens are present unconditionally and carry a visible `Preview` label. Preview
status never substitutes for a missing screen or workflow.

Every command in the command tree has an intentional TUI classification in the route registry:
interactive route or Commander-only. All Get, List, Create, Update, Delete, Tag, Untag, List Tags,
Token Vault Get, and Set CMK workflows in this design are interactive routes. The parity test rejects
missing and orphaned routes.

## Errors

One Identity error formatter handles local and service failures.

Local errors:

- Identify the option, secret slot, or schema path.
- Explain conflicting input.
- List accepted ways to supply missing secrets.
- Fail before mutation.

Commander parse failures use a closed mapping and never interpolate `CommanderError.message`,
`nestedError`, option spelling, or rejected input:

| Commander code                                                                      | Safe output                                                     |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `commander.help`, `commander.helpDisplayed`, `commander.version` with exit code `0` | Success; use configured help/version output                     |
| `commander.missingArgument`                                                         | `A required argument is missing. Run with --help for usage.`    |
| `commander.optionMissingArgument`                                                   | `An option value is missing. Run with --help for usage.`        |
| `commander.missingMandatoryOptionValue`                                             | `A required option is missing. Run with --help for usage.`      |
| `commander.conflictingOption`                                                       | `Conflicting options were provided. Run with --help for usage.` |
| `commander.unknownOption`                                                           | `An unknown option was provided. Run with --help for usage.`    |
| `commander.excessArguments`                                                         | `Too many arguments were provided. Run with --help for usage.`  |
| `commander.unknownCommand`                                                          | `An unknown command was provided. Run with --help for usage.`   |
| `commander.invalidArgument`, `commander.error`                                      | `An option or argument is invalid. Run with --help for usage.`  |
| Any unrecognized code or non-Commander failure                                      | Static internal error                                           |

Router argument and option validators throw a closed CLI-owned usage-error type rather than
`TypeError` containing arbitrary parser or input text.

Service errors:

- Include an allowlisted modeled error code.
- Include HTTP status only when it is an integer from 100 through 599. Include request ID only when it
  matches `^[A-Za-z0-9][A-Za-z0-9-]{0,127}$`.
- Map known cases to static actionable guidance.
- Do not serialize the entire exception.
- Do not print arbitrary raw HTTP response bodies.
- Do not trust an unknown service message to be free of echoed input.

An outer boundary wraps root Commander execution, and an Ink error boundary wraps Identity screens.
They catch unknown thrown values and emit a static internal-error message. They never print an
unknown exception's `message`, `stack`, `cause`, object inspection, or raw body.

`runWithExitCode` receives injected stderr and never calls `console.error`. Successful JSON is
serialized completely and passed to the one-chunk awaited stdout sink. The process entry point uses
`process.exitCode`, not `process.exit`, and does not complete routing until callback, backpressure,
`drain`, close, and error state have settled as defined under Output And Invocation.

React error boundaries do not catch asynchronous callback or query failures. Every Identity query,
mutation, event handler, submit callback, and hidden-prompt continuation catches `unknown` at the
point where the rejection is observed and maps it to a closed `SafeIdentityError` union before
updating component state. The union contains only CLI-authored codes, static guidance, and separately
validated primitive metadata. Identity components never accept, store, interpolate, or render a raw
`Error`. Commander and Ink mutation presenters set a monotonic `mutationCommitted` latch immediately
when they observe `committed` or `committedOutputUnavailable`, before serialization, state update, or
render. The outer runnable/Ink output boundary consults that latch so every subsequent presentation
failure uses committed-output-unavailable guidance rather than a generic retryable error.

Safe response normalization also applies to successful reads:

- Raw `failureReason` is never inspected for rendering or printed. Its presence maps through the
  allowlisted OAuth status to the static V1 guidance above.
- Unknown union bodies are replaced with their sanitized member-name marker.
- Metadata outside the explicit safe response contract is omitted instead of passed through.

Malformed JSON and schema validation errors identify the option and a CLI-owned schema path. They do
not include JavaScript parser text, typecheck excerpts, raw values, or unknown keys copied from
untrusted input.

All dynamic strings destined for Ink or Commander output cross one injective terminal-safe rendering
boundary. In one pass over the original code points, it replaces every literal backslash with visible
ASCII `\u{005C}` and every C0 control, `DEL`, C1 control, ANSI/OSC introducer, Unicode `Cf` format
character, U+2028 line separator, U+2029 paragraph separator, and bidirectional formatting or
isolation control with a visible ASCII `\u{XXXX}` escape. This includes U+061C, U+200B, U+200E,
U+200F, U+202A through U+202E, U+2066 through U+2069, and U+FEFF. The encoder never rescans escape
text it generated. Therefore an actual control or backslash cannot collide with a different input
containing literal text such as `\u{001B}` or `\u{005C}` in scalar fields, arrays, review values,
JSON, Ink, or map keys. Escaping an ESC or C1 introducer neutralizes the entire terminal sequence.
Semantic validation rejects these controls outright in user-supplied URLs and tag keys or values
before applying any modeled pattern; safe rendering still applies to service-returned legacy data and
every other dynamic field.

Static DTO property names bypass this transform. Dynamic records such as tags first validate an
ordered entry array, encode every key with the same `S` encoder, reject duplicates, and then install
properties with `Object.defineProperty` on an `Object.create(null)` target. They never trust record
parsing or ordinary assignment for `__proto__`, `constructor`, or other prototype-sensitive keys.

`--debug` never relaxes these rules. Any future diagnostic rendering applies schema-sensitive
redaction and exact resolved-value redaction before serialization, but the default remains to omit
unknown text entirely.

## Secret-Safe Record and Replay

The current fixture recorder hashes the complete SDK input and stores service error messages
verbatim. Identity must not use that behavior unchanged.

An Identity fixture schema registry maps each supported operation name to its public SDK request
schema. Recording fails closed before filesystem access when the operation, schema member, union
member, or sensitive path is unknown.

For every Identity call, the recorder:

1. Traverses the registered request schema and replaces sensitive leaves with stable path/type
   markers.
2. Canonicalizes the redacted request with deterministic object-key order and existing date-safe
   scalar rules.
3. Computes a full lowercase SHA-256 digest over operation name plus canonical request.
4. Encodes the SDK-shaped response or modeled error through the operation's safe fixture codec.
5. Canonicalizes only registered service timestamp paths through the flow's logical clock.
6. Serializes the complete fixture bytes in memory and computes their content digest.
7. Scans those bytes and the staged basename for registered high-entropy sentinels.
8. Only then atomically installs the content-addressed staged response blob referenced by the flow
   transaction.

No raw request body or service error message is stored. Error fixtures contain only an allowlisted
modeled code and fields needed to reproduce the safe classification. Existing non-Identity fixture
keys remain unchanged.

Fixture payloads are not V1 presentation DTOs. Record/replay intercepts a real client's bound `send`
method, so replay must return the same safe SDK-level shape that a live `send` would return and allow
the action normalizer to run normally. The versioned fixture algebra is exact and collision-free:

```text
FixtureRecordV1 =
  | exact {
      version: 1,
      kind: "success",
      operation: IdentityOperationName,
      output: FixtureValue,
      markers?: exact {
        oauthFailureReasonPresent: true
      }
    }
  | exact {
      version: 1,
      kind: "modeledError",
      operation: IdentityOperationName,
      code: SafeServiceCode,
      httpStatus?: integer 100..599
    }

FixtureValue =
  | exact { type: "null" }
  | exact { type: "boolean", value: boolean }
  | exact { type: "number", value: finite number }
  | exact { type: "string", value: registered non-sensitive string }
  | exact { type: "date", value: canonical ISO-8601 string }
  | exact { type: "array", value: FixtureValue[] }
  | exact { type: "object", value: [registered object or map key, FixtureValue][] }
  | exact { type: "unknownUnion", member: SafeMemberName }
```

Object entries are sorted by their original modeled key and duplicate keys are rejected. The
operation registry enumerates the SDK output fields allowed to enter this algebra and omits raw
`failureReason`, request IDs, metadata outside the classifier allowlist, and every unregistered field.
For an operation whose safe normalizer distinguishes only `failureReason` presence, capture records
the fixed `oauthFailureReasonPresent: true` marker and no text. Replay restores one fixed CLI-owned
placeholder solely to exercise the same presence branch; the placeholder is never rendered.

A captured SDK `$unknown: [name, body]` becomes `unknownUnion` after sanitizing only the name; the body
is never traversed. Replay revives dates as fresh `Date` instances and unknown unions as
`{ $unknown: [safeName, {}] }`. A modeled-error registry constructs the pinned SDK exception class
with a static message and only deterministic recorded safe metadata, then throws it. Capture also
passes the sanitized reconstructed exception to the action rather than rethrowing the original
request-ID-bearing instance, so capture and replay normalize identically. Unknown errors, unknown
fixture tags, invalid dates, unsupported scalar types, or an operation/error mismatch fail replay
closed. Capture/replay parity tests pass these revived values through the real client instance and
the normal action/V1 normalization boundary.

Every golden flow declares a stable, repository-owned flow ID. The ID is part of its fixture namespace
and collision-manifest path. Redaction intentionally makes calls with different secret values
collide, so each flow manifest assigns a zero-based occurrence for every operation/digest pair and
records the exact ordered call sequence. Replay consumes every entry exactly once and fails on a
missing, extra, reordered, or unconsumed call.

Flows may run in parallel because their namespaces are disjoint. Calls inside one flow are sequential;
the harness rejects a second in-flight SDK call for the same flow. A sorted suite index makes flow
discovery independent of worker scheduling. Repeated recordings with the same logical behavior must
produce byte-identical manifests and fixture content.

Each capture exclusively creates a cryptographically unique staging root and records the digest of
the committed suite index it started from. Capture never acquires a global lock and never writes a
stable repository path. Every response blob and closed flow manifest is immutable and
content-addressed by the full SHA-256 of its canonical bytes. A manifest references only durable
blobs. Capture writes one canonical `READY` manifest last with the exact flow set, object digests,
schema version, and starting suite-index digest; a root without `READY` is unpublishable. The suite
index is a sorted mapping from stable flow IDs to immutable manifest digests and is the only stable
mutable fixture file. PID, host, capture ID, wall time, lock state, and commit SHA never enter
canonical artifact bytes.

Every immutable fixture object, in capture staging and publication, uses one atomic installation
helper. The helper serializes and hashes complete bytes in memory, writes them to a cryptographically
unique same-directory `O_EXCL` temporary file, writes all bytes, `fsync`s and closes the descriptor,
checks whether the digest path already exists, and atomically renames the temporary file only when it
is absent. Capture staging uses reserved names
`.agentcore-capture-tmp-<32-lowercase-hex>` inside its unique staging root. Stable publication
directories use `.agentcore-publish-tmp-<32-lowercase-hex>` for object/manifest installation and
`.agentcore-publish-index-tmp-<32-lowercase-hex>` beside the suite index. No stable artifact may use
those prefixes. A platform no-replace primitive is used when available. Capture object paths are
flow-namespaced and same-flow calls are sequential; publication holds the suite lock, so the fallback
path still has exactly one authorized installer per target. If a digest path exists, including after a
competing no-replace result, the helper reads it and verifies exact length, full SHA-256, and canonical
bytes before treating it as installed. An empty, truncated, mismatched, non-regular, or unreadable
existing object fails closed and is never replaced or used as a cache hit. The helper tracks whether
rename consumed its temporary and uses `finally` to close and unlink every unconsumed temporary,
including a valid existing-object cache hit or no-replace contention result. Only `ENOENT` after a
confirmed consuming rename is ignored; any other cleanup failure fails the capture/publication.
Process-kill leftovers remain possible and readers ignore every reserved temporary prefix. Capture
root cleanup removes capture temporaries. Publication recovery owns stable-directory temporaries as
described below. No digest path is ever opened for incremental writing.

Registered service timestamps are canonicalized from a fixed per-flow epoch with one-millisecond
ticks after physical-to-logical identity mapping. Calls are traversed in sequence and fields in
registered schema order; unordered collections are first sorted by logical identity. Each logical
resource/time role retains its assigned value while the raw service value is unchanged, and a changed
mutable timestamp allocates the next tick. Equal timestamps for one role remain equal, creation/update
ordering is preserved, and an immutable `createdTime` change fails capture. Only explicitly
registered timestamp paths are transformed, with `Date` revival preserved. An unknown date-bearing
or configured volatile response path fails capture instead of introducing nondeterministic bytes.

Publication is a separate short transaction. It validates the closed capture, exact call consumption,
all content digests, logical mappings, sentinel scans, and its base-index digest before entering the
critical section. It opens a permanent `.publish.lock` file and holds an exclusive operating-system
descriptor lock for the entire transaction. The file is never unlinked or replaced. The direct,
typed first-party native adapter supplies Linux OFD `fcntl`, macOS `flock`, and Windows
`LockFileEx`; its Node and Bun behavior is gated in Linux, macOS, and Windows CI before adoption.
Kernel release on descriptor close or process death eliminates stale-file reclamation, PID reuse, and
check/remove/recreate races. Network filesystems are unsupported for fixture publication.

While holding the lock, publication first scans only the known object, manifest, and suite-index
directories, using `lstat` without following links, and unlinks every entry whose complete basename
matches one of the two reserved publication-temporary grammars. It never recurses through a temporary,
treats an unrecognized lookalike as an ordinary entry, and fails publication if an owned temporary
cannot be removed. Because the permanent lock excludes a live publisher, every matching
stable-directory temporary is abandoned. Publication then rechecks that the current suite-index
digest equals the capture's base digest. A stale publisher fails instead of merging or overwriting a
newer generation. It atomically installs and verifies every missing immutable blob and manifest with
the helper above, writes the canonical next index to an exclusive same-directory temporary file,
`fsync`s it, and renames it over the suite index. It syncs the parent directory where the platform
supports directory handles. Old referenced objects are not deleted during publication. The portable
guarantee is process-crash consistency through atomic same-filesystem rename, not power-loss or
filesystem-corruption durability. Replay reads one index snapshot, verifies every referenced length
and digest before decode, and ignores unreachable objects; a process kill at any boundary exposes
either the complete old index or the complete new index, never a mixed generation.

Fixture factories construct real AWS SDK clients and intercept the instance's bound `send` method.
They do not return `{ send }` objects cast as clients. This preserves `instanceof` checks required by
generated paginators while keeping record/replay at the existing SDK send seam.

Golden recording uses a test-only logical-to-physical resource map. Tests and committed artifacts use
stable logical names. Immediately before a live SDK send, the interceptor maps registered modeled
name, ARN, and secret-ID fields to cryptographically random run-owned physical values and injects
run-ownership tags. It maps the corresponding response fields back to logical values before
sanitization, fixture serialization, or rendering, and removes injected ownership tags. Fixture
identity is computed from the logical request before physical mapping. Unregistered resource-bearing
paths fail closed. Replay never creates physical values.

Routine live integration execution, golden capture, and fixture publication are separate commands.
Live integration results are never fixtures. A golden capture writes only its unique staging tree,
and the single-writer publication command is the only operation allowed to change the committed
fixture index. Failed or incomplete captures cannot update committed fixtures.

Tests use high-entropy sentinel values and recursively scan:

- stdout
- stderr
- golden files
- SDK fixtures
- filenames
- serialized errors

No artifact contains the sentinel. Sentinel validation runs before each write and over the complete
fixture/golden tree after the test run.

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
- Custom OAuth validates every Create/Update combination of preferred
  `clientAuthenticationMethod`, legacy metadata `tokenEndpointAuthMethods`, both, and neither.
  Curated Update tests preservation of a legacy-only provider and explicit migration in both
  directions before secret acquisition.
- Every secret acquisition and storage-mode combination is covered.
- The module-private coordinator synchronously reserves one unbound context for preparation, rejects
  concurrent or stale preparation reuse before AWS, binds it to one completed capability, obtains one
  opaque commit lease from the matching pair, and rejects a second claim. The same tests cover
  replacement `bindContext()` reservation before any await.
- Preparation reservations and winning commit leases collectively dispose literal, acquired, locator,
  reader, and prompt references on preparation failure/no-change, cancellation, abandoned review,
  unmount, every terminal commit outcome, and reprepare. Duplicate commits never own or dispose the
  winner's lease.
- Every prepared pair has a distinct unforgeable token even when its ordered secret requirements are
  identical. Same-slot cross-pairs, stale-reprepare pairs, and duplicate calls with foreign contexts
  return `secretContextFailed/mismatch` and consume or dispose neither supplied object.
- An unbound replacement has no commit method. Successful slotless and multi-slot `bindContext()`
  calls validate ordered requirements and return a fresh bound pair that reaches a second review and
  successful second commit. Missing/extra/duplicate inventory disposes the rejected context while
  leaving the replacement retryable; foreign/unavailable contexts and consumed replacements change
  neither object.
- Replacement bind/dispose races transfer or destroy the binding exactly once. A replacement can
  itself commit to a later replacement without carrying state from either prior secret context.
- A matching disposed/unclaimable context returns slotless `secretContextFailed/unavailable`; claim
  and every disposal path are nonthrowing and idempotent.
- Disposing a claimed context shell cannot affect its active lease, and duplicate commits dispose
  no foreign context.
- A matching commit after explicit capability disposal returns `alreadyConsumed` and leaves an open
  matching context presentation-owned and unchanged.
- Noninteractive missing-secret failures contain every missing slot once in catalog order and render
  accepted source flags from the static slot catalog.
- Raw extraction and context construction fail after each possible step without retaining prior
  literals or locators; unexpected `prepare()` rejection remains covered by creator `try/finally`.
- Multiple stdin consumers are rejected.
- All sensitive paths are redacted.
- Every populated slot with omitted or contradictory current-source metadata returns the exact
  slot-bearing `unknownCurrentSource` outcome without reading a replacement secret.
- MANAGED-to-EXTERNAL and EXTERNAL-to-MANAGED updates fail before mutation for every secret slot.
- Payment update requirements distinguish managed and external slots.
- Payment key validation enforces the modeled transport constraints without transforming or
  misclassifying raw-key and PKCS#8 encodings.
- Every custom OAuth authentication-method transition follows the transition matrix.
- OAuth Update accepts only absent, `READY`, and `UPDATE_FAILED` status; Delete and Tag/Untag do not
  inherit that allowlist.
- Raw custom Create permits the modeled omitted method, while raw custom Update requires one.
- Every supported explicit clear is distinct from omission, and prohibited clears are rejected.
- Workload unchanged, replace, and clear intents are distinct.
- Semantic no-ops and opaque secret rotations are distinguished.
- Unknown vendors and union members expose only sanitized names on reads and fail on writes.
- Terminal-safe rendering visibly escapes literal backslashes, C0, `DEL`, C1, ANSI/OSC introducers,
  every Unicode `Cf` character, U+2028, U+2029, and bidi controls.
- Scalar, array, review, JSON, Ink, and map-key encoding distinguish an actual control or backslash
  from literal `\u{XXXX}` text. Every distinct tag key, including `__proto__` and `constructor`, is
  preserved in a null-prototype object.
- URL and tag validation rejects every terminal, format, line/paragraph separator, or bidi control
  accepted by JavaScript strings.
- ARN parsing accepts the live-observed, CLI-owned family templates across representative `aws`,
  `aws-us-gov`, and `aws-cn` partitions; rejects wrong service, family, resource shape, account
  syntax, and resolved region; requires workload direct ARNs to use directory `default`; and
  deliberately permits a syntactically valid cross-account ARN to reach AWS authorization.

### Secret Source Adapter Tests

- TTY stdin, non-regular files, invalid UTF-8, and over-limit byte and character counts are rejected.
- Bounded stdin stops reading at the configured byte cap.
- File selection retains a non-inheritable no-follow descriptor/handle, and context disposal closes it
  exactly once on success, cancellation, construction failure, or abandoned review.
- Acquisition reads through the held handle and rejects pathname replacement, attempted inode/file-ID
  reuse, symlink retargeting, mode/owner/permission changes, in-place size or change-metadata updates,
  changes during a bounded read, reparse points, and non-regular replacements.
- POSIX modes other than `0400`/`0600`, nontrivial ACLs, untrusted owners, unsafe Windows DACLs,
  group/world-readable or writable files, unsupported filesystems, and platforms without equivalent
  identity/change guarantees fail with `fileUnsafe`.
- Native-boundary contract tests reject malformed results and thrown native errors without exposing
  paths or OS text. Platform CI covers Linux ext4/XFS/Btrfs/tmpfs ACLs, macOS APFS/HFS+ ACLs,
  Windows NTFS/ReFS owner/DACL and reparse behavior, exact byte-cap boundaries, and no JavaScript
  fallback.
- Environment, file, stdin, prompt, and literal values preserve content and pass through the same
  character validator.

### Transport and Action Tests

- Every SDK operation selects the correct command.
- Region and endpoint options propagate with independent AgentCore, STS, and Secrets Manager
  precedence; `--endpoint-url` affects AgentCore only.
- One operation resolves credentials once and pins one AgentCore endpoint. A provider that returns
  account A and then account B is invoked exactly once and proves both Gets and the mutation use A,
  while a subsequent operation may bind B.
- SDK clients receive non-refreshing providers that return isolated mutable credential clones; a
  pinned-SDK feature-attribution probe may add `$source` without mutating the private snapshot or a
  clone used by another client/send. Expiration clones are fresh `Date` objects derived from one
  immutable finite epoch.
- Environment or profile endpoint changes during secret acquisition cannot split one operation.
- Live/capture rejects explicit `--endpoint-url`, bypasses environment/profile endpoint overrides,
  and requires official HTTPS service endpoints.
- Temporary credentials that expire or enter the five-minute refresh window before or after secret
  acquisition dispose the secret context and make no subsequent Get or mutation.
- Credential freshness boundary tests cover `299_999`, `300_000`, and `300_001` milliseconds before
  every AWS send, including immediately after a retrying second Get.
- Page operations preserve `nextToken`.
- All-results operations consume generated paginators with real client instances using an
  adapter-owned mutable clone. Frozen caller input traverses multiple pages and remains byte-for-byte
  unchanged.
- Same-token and cyclic pagination return `paginationFailed` before results render.
- Every query binding is disposed exactly once after one-page success, all-page success, normalization
  failure, service failure, token cycle, and cancellation. The same `AbortSignal` reaches direct reads
  and paginator sends, and no partial all-results value escapes.
- Prepared plans are frozen, canonical, and contain no secret bytes.
- Cancellation and terminal outcomes destroy the operation binding; reprepare transfers it exactly
  once to the replacement capability, and Commander disposes an unaccepted replacement.
- `PreparedMutation.dispose()` races commit through the same ownership state machine: exactly one
  path obtains the binding, repeated disposal is inert, and disposal after commit cannot destroy the
  commit-local or replacement lease.
- A prepared capability rejects sequential and concurrent second commits before secret I/O or AWS
  calls.
- Update preparation Gets once; commit Gets before and after secret acquisition.
- The same additive OAuth/payment raw response succeeds through tolerant ordinary Get and returns
  `sdkCompatibilityRequired` through Update preparation and both commit
  `readCompatibilityGuardedCurrent` calls. No other operation facet has that method.
- Compile-time negative tests prove query, list, resolved-query, direct-mutation, and ordinary
  current-state bindings cannot select a compatibility guard, while OAuth/payment guarded Update
  bindings cannot perform a tolerant current-state read or select another SDK operation.
- OAuth/payment Update preparation and both commit Gets reject additive raw response fields before
  generated deserialization. Preparation and the first commit Get fail before secret I/O; an
  incompatible second Get disposes acquired values before returning.
- Successful and non-success compatibility bodies of 1,048,575 and 1,048,576 bytes are accepted;
  1,048,577 bytes destroys/cancels the Node or Web stream before Smithy collection. Valid OAuth
  responses without `clientSecretArn` pass; missing genuinely required members, wrong scalar wire
  types, nulls, truncation, and unknown keys/arms fail closed.
- A changed pre-acquisition guard returns an unbound `ReplacementPreparation` without reading secrets
  or mutating.
- A changed post-acquisition guard discards resolved values and returns a replacement capability
  without mutating.
- Reprepare never carries literal or acquired values into the replacement; a second commit requires a
  newly constructed `CommitSecretContext` and successful synchronous replacement binding.
- Unsupported shapes, providers, statuses, and NotFound return their own typed outcomes and never
  carry a replacement capability.
- An equivalent pair of fresh rebases resolves secrets only at commit and sends one mutation command.
- Delete, name-selected Tag/Untag, and Set CMK reject changed target identity or guarded state.
- Direct-ARN Tag, Untag, and List Tags make zero Get and STS calls and send the exact locally
  validated ARN; same-name local resources cannot affect direct mode.
- A request-handler-level retry test proves every mutation makes at most one HTTP attempt while reads
  retain their configured retry policy.
- Mutation transport tests cover rejection before handler dispatch, timeout after dispatch with no
  response, every complete 4xx/5xx class, unclassified complete statuses, a service-applied mutation
  followed by 500, malformed 2xx response, SDK output normalization failure after 2xx, and valid 2xx
  output. They assert `serviceFailed` only for complete 4xx,
  `mutationOutcomeUnknown` for every post-dispatch 5xx/unclassified status, and
  `committedOutputUnavailable` for unusable 2xx exactly, and prove no automatic retry.
- Compile-time policy tests reject `noChange` and `reprepareRequired` for direct operations and reject
  `noChange` for continuity-guarded operations.
- Actions do not fetch unnecessarily for direct mutations.
- Tag actions resolve and use the resource ARN.
- Syntactic and semantic no-ops make no Update call.
- Error mapping does not expose exception messages, bodies, stacks, causes, or raw failure reasons.

### Commander Tests

- Every verb parses required and optional flags.
- Every successfully executed leaf emits exactly one JSON document, including empty mutation
  responses.
- Failed leaves emit no success document.
- Missing and conflicting inputs fail with actionable messages.
- Literal secret values warn without echoing the value.
- Every slot prefix supports literal, stdin, env, file, and external reference forms.
- `--json` disables hidden prompts and never implies Set CMK consent.
- Advanced JSON accepts valid SDK-native structures and rejects invalid structures.
- Provider-independent syntax/conflict failures occur before Update Get; current-vendor and
  family-specific validation occurs after Get.
- Malformed JSON output contains no parser message or input excerpt.
- Omitted update fields remain absent from intent.
- List defaults to one page; `--all` traverses all pages and conflicts with `--next-token`.
- `--max-results` enforces the resource-specific ranges.
- Tag selectors enforce exactly one of `--name` and `--resource-arn`.
- Bare-leaf routing ignores parser defaults and honors CLI-sourced default-valued options.
- Global `--region`, `--endpoint-url`, and `--debug` alone retain TUI routing, while `--json`, a
  CLI-sourced leaf option, or a positional argument selects Commander.
- Every compiled child command uses injected output, `configureOutput`, and `exitOverride`; malformed
  nested input containing terminal controls emits only static safe text and never calls
  `process.exit`.
- Help and version paths write once and return success through the same execution policy.
- Parser tests assert the exact pinned codes, including `commander.unknownOption`, `commander.help`,
  `commander.helpDisplayed`, and `commander.version`; the `help <command>` subcommand returns success,
  and unprefixed lookalikes take the unknown-code path.
- A subprocess writing a multi-megabyte normalized JSON document through a slow pipe exits naturally
  only after the callback/drain contract settles with a complete parseable document.
- Subprocesses close stdout before a query result, before mutation dispatch, and after known commit.
  Synchronous write failure, callback failure, `EPIPE`, `close`, and false-without-drain are contained
  without an unhandled event or stack. The post-commit cases attempt only static
  committed-output-unavailable guidance on stderr and never retry the mutation; a simultaneously
  closed stderr remains stack-free.
- Injected serialization failure before and after a known commit selects generic and committed-output-
  unavailable guidance respectively, queues no partial JSON, and leaves no output-listener leak after
  invocation teardown.
- Explicit Delete executes without `--yes`.
- Noninteractive `token-vault set-cmk` requires `--yes`.
- Commander exits on `ReprepareRequired` and never authorizes its replacement capability.
- A runnable-level sentinel-bearing unknown rejection emits only the static internal error to stderr
  and emits nothing to stdout.

### Ink Screen Tests

- Commander/Ink route parity covers every Identity leaf and rejects orphaned routes.
- Every resource and verb route mounts from the feature-owned registry.
- OAuth fields change with provider family.
- Microsoft tenant input appears only where applicable.
- Secret storage mode changes the visible controls.
- Payment update asks again for all managed secret slots.
- External references are preserved without requesting their values.
- Workload return URL controls support add, remove, replace, and clear.
- Pickers navigate service page tokens.
- Review screens contain no secrets.
- Hidden prompts occur after review and the first fresh rebase; a second fresh rebase occurs after
  prompting and before request construction.
- A changed rebase returns to review before any secret prompt.
- A change during secret prompting discards the entered values and returns to review.
- Reprepare renders an unbound replacement, confirms again, constructs a fresh context, binds it, and
  successfully commits slotless and multi-slot replacements. Missing inventory returns to secret
  entry without discarding the replacement; unmount disposes an unbound replacement.
- OAuth callback URLs are displayed on create, get, and update result screens.
- Cancellation makes no mutation call.
- Unmount or superseding input aborts pending preparation. If binding creation or Get ignores abort
  and later returns a prepared pair, the stale-generation completion immediately disposes its
  capability and context and never installs UI state.
- Delete and CMK changes require confirmation.
- Empty, loading, failure, and success states render correctly.
- Buffered confirmation input and repeated submits cannot commit one capability twice.
- Query, mutation, event-handler, and prompt-continuation rejections become `SafeIdentityError`
  values; components never render a raw `Error`.
- Ink error-boundary and async-callback tests use sentinel-bearing messages and assert that no frame,
  stdout, stderr, stack, cause, golden, or fixture contains the sentinel.
- A render/state failure after Ink has observed a committed result selects static
  committed-output-unavailable guidance and never permits a second submit.
- Dynamic fields containing literal backslashes, C0, C1, ANSI, OSC, and bidi controls render as
  distinct visible ASCII escapes and cannot alter terminal state or reviewed layout.

### SDK Drift Tests

- Runtime SDK enum values equal catalog keys.
- Runtime OAuth and payment union member names equal reviewed expectations.
- Raw-response compatibility tests cover additive fields at every known OAuth/payment structure,
  unknown union arms, malformed and boundary-sized success bodies, bounded non-2xx restoration and
  overflow, stream replay, no-secret OAuth, and the known `privateKeyJwtConfig` model drift.
- Every Identity operation used by fixtures has an explicit public request schema.
- SDK-sensitive paths are either automatically redacted or covered by explicit secret slots.
- Unknown response union members at top-level and every nested discovery/private-endpoint union
  deserialize to `$unknown: [name, body]` and only the sanitized name reaches normalized output.
- A fake-handler custom response containing `PRIVATE_KEY_JWT` and `privateKeyJwtConfig` preserves the
  authentication-method string in V1, omits the unknown structure, and remains blocked from Update.
- Compile-time exhaustive records fail on a new enum value.

### Golden Tests

Record/replay tests exercise the real root router, middleware, action, transport, and renderer seams.
Sensitive write fixtures use schema-redacted keys. Read and mutation output fixtures contain only
service-safe response data.

Golden coverage includes stable flow namespaces, repeated redacted-key collisions, exact manifest
consumption, deterministic parallel-flow recording, unique capture roots, OS descriptor-lock
exclusion and process-death release, stale-base rejection, exclusive temporary creation, kill-point
publication recovery, replay during publication, logical-clock determinism, logical-to-physical name
mapping, pre-write and whole-tree sentinel rejection, modeled safe errors, runnable and Ink boundary
errors, unknown member sanitization, and generated paginator execution. Recording the same logical
suite twice under shuffled worker schedules produces byte-identical committed artifacts.

Fixture-codec tests capture and replay dates, nested `$unknown` tuples with discarded bodies, and each
allowlisted modeled exception through a real SDK client instance. They omit request IDs, preserve a
fixed OAuth failure-reason presence marker, and produce identical capture/replay normalization.
Atomic-object tests kill before and after temp-file `fsync` and rename, retry abandoned installs,
exercise no-replace contention and valid existing-object cache hits, assert every unconsumed
temporary is removed, and reject a pre-existing empty, truncated, wrong-digest, or non-canonical
digest-path object. Publication tests kill with object, manifest, and suite-index temporaries present;
the next publisher removes only exact reserved stable-directory names while holding `.publish.lock`
and then exposes a complete old or new index. Lookalike names and symlinks outside the exact grammar
are never traversed or deleted.

### TypeScript Diagnostics

Before implementation, the exact existing `bunx tsc --noEmit` diagnostics are captured in a
version-controlled allowlist as normalized tuples of repository-relative path, line, column,
diagnostic code, and message. Validation compares the complete multiset, not a count:

- The allowlist records the exact TypeScript version and command line; a compiler-version mismatch
  fails before comparison.
- Every Identity and otherwise touched TypeScript file must have zero diagnostics.
- A new, changed, moved, duplicated, or missing baseline diagnostic fails the check.
- Removing an unrelated baseline diagnostic is accepted only by updating the allowlist in an
  intentional, reviewed change.

### Live Tests

Live tests run only with explicit integration configuration and:

```text
AWS_PROFILE=deploy
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=603141041947
```

The live runner obtains the caller identity before creating resources and aborts unless the account
and region exactly match these values.

The test matrix includes:

- Named OAuth create/get/update/delete.
- Included per-tenant OAuth create/get/update/delete.
- Included global OAuth create/get/update/delete.
- Custom OAuth create/get/update/delete, OBO replacement/removal, secret-method transitions, and raw
  Create with omitted authentication method.
- Microsoft tenant-specific update preservation and explicit reset to `common`.
- API-key MANAGED create/rotate/delete.
- API-key EXTERNAL create/update/delete with a temporary Secrets Manager secret.
- Workload identity return-URL create/update/clear/delete and service rejection of six URLs.
- Coinbase and Stripe/Privy MANAGED and EXTERNAL create/get/update/delete behavior, required managed
  secret re-entry, key-format evidence, and both source-switch directions for all four payment slots
  in the preview-capable deploy account and region. An unsupported preview response fails the run
  instead of silently skipping it.
- Tag, list-tags, and untag on temporary resources from all four taggable families.
- Page-token traversal with a deliberately small `maxResults`.
- Default token-vault read.
- Confirmed rejection of both MANAGED/EXTERNAL source-switch directions for API-key, OAuth, and every
  payment secret slot without deleting the original resource.

Each live run:

- Uses a cryptographically random, run-unique `acci-<run-id>-` prefix.
- Creates a permanent mode-`0600` per-run `.run.lock` file, opens it once, and holds its OS descriptor
  lock for the runner lifetime. The lock file is never unlinked or atomically replaced. The ledger
  records its canonical local path and the native adapter's opaque lock-object, kernel boot-session,
  and mount-instance IDs before any AWS call. If any identity is unavailable, the run remains testable
  but stale cleanup for it is permanently audit-only.
- Creates a separate mode-`0600` durable run ledger before the first AWS call. Before each create
  request, it atomically records and syncs the planned physical name, partition, family, account,
  region, create-attempt window, random 128-bit candidate ID, and exact ownership tags; after a
  response, it atomically adds the exact ARN, service `createdTime`, and observed state. Ledger
  replacement never changes the inode/file ID that carries the active-run lock because they are
  different files.
- Adds `agentcore-cli:test-owner`, `agentcore-cli:test-run`,
  `agentcore-cli:test-candidate`, and `agentcore-cli:test-created-at` tags in the original Create call
  for every Identity resource and temporary Secrets Manager secret. No post-create tagging gap is
  accepted.
- Treats only valid rows from the explicitly supplied ledger as deletion candidates. Before every
  deletion it verifies the caller account/region/partition and allowlisted family, re-reads the
  current resource and tags, and requires the exact recorded physical name and prefix, parsed ARN
  account/region/type, owner tag, run-ID tag, candidate-ID tag, and creation tag. If the Create
  response was persisted, the ARN and service `createdTime` must equal the ledger exactly. If the
  process died after Create but before observation, the fresh service time must fall inside the
  pre-recorded bounded attempt window. A missing or malformed row, failed Get or tag read, recreated
  name, mismatch, or unverifiable predicate retains and reports the resource.
- Refuses broad cleanup by the shared `acci-` prefix.
- For OAuth, polls each successful Create and Update with bounded exponential backoff until `READY`
  and fails immediately on `CREATE_FAILED` or `UPDATE_FAILED`, using only safe normalized failure
  guidance. For API-key, payment, and workload resources, whose Get outputs have no lifecycle status,
  it polls until Get returns the expected created or updated state.
- After Delete, polls Get until `NotFound`. OAuth `DELETING` remains pending and `DELETE_FAILED` fails
  the run; the other three families expose no deletion status and continue polling until absence.
- Cleans up in `finally` with the same bounded state polling.
- Deletes test-owned Secrets Manager secrets with `ForceDeleteWithoutRecovery` and polls until they
  are absent.
- Performs final paginated sweeps across all four Identity resource families and Secrets Manager.
  Sweeps are audit-only: they report unledgered resources but never promote them to deletion
  candidates.
- Fails with the exact remaining names and ARNs if current-run resources or temporary secrets remain.
- Scans captured output for sentinel secrets.

A separate stale-run reaper handles process and OOM failure. It requires the exact persisted ledger,
run ID, expected account, region, partition, resource family set, owner tag value, and minimum age.
Mutation cleanup is supported only from the original run root on a supported local filesystem. It
opens the exact permanent per-run `.run.lock`, verifies its canonical path and native lock-object ID,
and requires the current native boot-session and mount-instance IDs to equal the ledger before it
first acquires the descriptor lock non-blocking. The session comparison happens
before any AWS mutation. This prevents a filesystem-only snapshot, copied run root, remount, or host
reboot from converting absence of the original kernel lock into termination evidence. It never locks
the atomically replaced ledger inode. Network filesystems are unsupported.

Every mandatory ledger, tag, and available service time must predate the cutoff, and all normal
deletion predicates still apply. It never deletes an unledgered, untagged, tag-mismatched, recreated,
young, active, copied-artifact, or out-of-scope resource. Any failed ownership or lock-identity read
fails closed. Dry-run output is the default; local mutation requires an explicit confirmation flag.

The stale reaper uses the same hardened invocation binding as live execution and capture. It rejects
`--endpoint-url`, bypasses every environment/profile endpoint override, resolves official HTTPS
AgentCore, STS, and Secrets Manager endpoints before its account check, resolves credentials exactly
once, and gives all three services non-refreshing providers over that one snapshot. It checks the
immutable expiration epoch before every read and mutation send. Entering the five-minute window aborts
the reaper without refreshing or issuing a later request.

A local ledger, exact lock object, and matching live kernel/mount session survive process failure, not
loss or restart of their host or mount. CI may persist the mode-`0600` ledger and lock metadata as a
restricted audit artifact, but a copied artifact, a different boot session, and a different mount
session are audit-only because locking that object cannot prove that the original process terminated.
Mutation after reboot, host loss, filesystem remount, or from a copied artifact would require a
separate machine-verifiable external run-termination attestation bound to the recorded run ID; no such
verifier is in this implementation, so confirmation cannot override the refusal. A full hypervisor
snapshot that clones active kernel state is outside the local reaper's trust model and likewise
requires external attestation; the design does not claim a local lock can distinguish two such
kernels. Without the exact ledger and same-session identity, cleanup reports audit sweep results but
refuses mutation.

Reaper tests cover every rejection predicate, copied lock/ledger artifacts, network filesystems,
boot-session mismatch, mount-instance mismatch, same-name recreation, unledgered sweep results,
partial reruns, and exact-run same-session local cleanup.
Kill-point tests stop after planned-row sync and after service acceptance but before ARN persistence;
both paths remain recoverable only through the candidate-ID and full ownership conjunction. Reaper
binding tests also prove endpoint overrides are ignored, one credential snapshot spans
STS/AgentCore/Secrets Manager, freshness is checked before every send, and the permanent original run
lock survives ledger replacement while excluding active-run cleanup.

Routine automation does not mutate the singleton token-vault CMK. Its request construction,
confirmation, and error behavior are exhaustively tested with fakes because a live CMK change affects
unrelated account resources.

## Upstream Service Improvements

These improvements are valuable but do not block the CLI:

- Preserve omitted managed secrets during Payment update.
- Preserve omitted managed secrets during OAuth update when authentication method is unchanged.
- Add service-side patch semantics for OAuth and Payment.
- Return Microsoft tenant ID in OAuth output.
- Model Create and Update with separate input shapes where their requirements differ.
- Document vendor-to-config compatibility and live-required fields in the service model.

The CLI does not hide current service behavior, but it also does not wait for these changes.

## Dependencies

No application-framework change is required. Expected direct dependencies are:

- Existing `@aws-sdk/client-bedrock-agentcore-control`, locked at `3.1079.0` for this implementation.
- Existing `@aws-sdk/client-bedrock-agentcore`.
- Existing Commander, Ink, React Query, and Zod packages.
- Direct `@smithy/core`, aligned with the pinned clients, for normalized structure, union, and
  sensitive-path traversal only.
- Test-only `@aws-sdk/client-sts` for live account verification.
- Test-only `@aws-sdk/client-secrets-manager` for run-owned EXTERNAL fixtures and cleanup.
- Build-only `node-addon-api` and `node-gyp` for one first-party N-API v8 C++ addon. There is no
  third-party runtime native dependency and no subprocess ACL parser.

Dependency versions remain aligned with the pinned AWS SDK generation. SHA-256 uses the platform
crypto implementation.

The native addon has common N-API ownership/error glue plus separate Linux, macOS, and Windows source
files. Release CI builds and tests exactly six prebuilds from the same commit:
`linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`, and
`win32-arm64-msvc`. Linux builders install libacl headers; macOS links system ACL APIs; Windows links
Advapi32 and the required kernel libraries. The Node-targeted npm bundle ships all six under
`dist/native/<target>/agentcore_cli_native.node` and selects by an exact platform/architecture table.
Each Bun standalone target directly requires and embeds only its matching `.node` file, as supported
by Bun's executable bundler. Unknown platforms and missing/mismatched prebuilds fail native capability
loading closed without breaking secret sources that do not need the addon.

Normal host development builds compile and test only the host addon. The release workflow first
collects all six matrix artifacts, verifies their target manifest and SHA-256 digests, then builds the
cross-platform npm and standalone artifacts. CI smoke-tests each prebuild under Node 20 and the pinned
Bun version, exercises a safe/unsafe file, descriptor-lock exclusion/process-death release, and
boot/mount identity stability, and runs the corresponding standalone binary. `npm pack` inspection
must prove every Node prebuild is present. File secrets, fixture publication, and mutating live-run
cleanup remain disabled on a target until these gates pass; there is no weaker runtime fallback.

## Reproducible Review Evidence

The final review-evidence commit places design, implementation-plan, and implementation reviews under
`docs/superpowers/reviews/identity-cli/`. Review artifacts intentionally follow the immutable design
or implementation commit they evaluate, so adding a report cannot change the reviewed blob. Each
review records:

- The exact prompt.
- Reviewer model and session identifier.
- Reviewed commit SHA and SDK version.
- Complete findings.
- One adjudication per finding with accepted/rejected status and repository or service evidence.
- The verification rerun proving no unresolved findings remain.

The final directory contains an index plus separate prompt, report, and adjudication files for
architecture, factual/API, security, and implementation-readiness reviews. A review is not complete
when its report exists; every finding must have a recorded disposition, accepted findings must be
reflected in a later immutable commit, and that correction must pass independent verification.

## Acceptance Criteria

- Every command in the command surface is mounted and tested.
- Every command classified as interactive has an Ink route and complete workflow.
- All 25 pinned OAuth vendors are supported.
- OAuth family and payment adapter contracts are exhaustive.
- Advanced SDK-native JSON is available without a generic deep merge.
- Curated omitted updates preserve every readable field required by the replacement-style service
  APIs; raw replacement omissions follow the explicit custom OAuth rules.
- Any guarded state change prevents mutation. A pre-acquisition change triggers review before secret
  resolution; a later change discards acquired values and triggers review again.
- OAuth updates clearly collect a required MANAGED client secret again and preserve a reconstructable
  EXTERNAL reference.
- Payment updates clearly collect every required managed secret again.
- Unknown future providers render safely on reads and fail safely on writes.
- Preferred and legacy custom OAuth authentication mechanisms are never sent together; legacy
  providers remain updateable and explicit migrations are reviewable.
- Prepared capability, binding, and secret-context ownership is total across commit, duplicate
  submit, cross-plan pairing, dispose, cancellation, late unmount completion, no-change, failure, and
  reprepare. An unbound replacement can synchronously bind a fresh context and transfer its binding
  exactly once. A private token and requirement fingerprint bind each context to exactly one plan.
- One immutable numeric credential snapshot and eagerly resolved endpoints bind every operation;
  SDK clients receive isolated mutable clones and no operation refreshes midway.
- File secret acquisition uses the shipped typed native adapter, retains and reads a trusted no-follow
  handle, requires owner-private permissions and ACL/DACL access, and detects pathname substitution or
  observable content change before and after the bounded read. Unsupported targets/filesystems fail
  closed without a weaker fallback.
- Async Commander and Ink failures expose only `SafeIdentityError` output, and untrusted terminal
  controls or encoding collisions cannot affect rendering.
- Operation-specific type facets make tolerant reads, ordinary guarded mutations, compatibility-
  guarded OAuth/payment Updates, and direct mutations mutually unavailable at incorrect call sites.
- Query bindings are abortable and always disposed; pagination clones caller input and never silently
  truncates, loops, mutates caller state, or emits partial all-results output.
- Mutation outcomes distinguish known pre-dispatch failure, complete 4xx service rejection,
  indeterminate post-dispatch failure including every 5xx, committed-but-unavailable output, and valid
  committed output. Awaited output failures after commit preserve that certainty.
- Complete tag lifecycle works.
- No secret reaches output, error artifacts, fixture content, or fixture identity.
- Golden recordings are deterministic across worker schedules and process-safe, and incomplete
  captures, truncated objects, or interrupted installation cannot modify or poison the committed
  fixture set. Request IDs are omitted, safe failure-reason presence is preserved, and no
  unconsumed temporary survives a completed installation attempt; abandoned stable publication
  temporaries are swept by the next locked publisher.
- Unit, router, action, screen, golden, and build checks pass.
- `bunx tsc --noEmit` matches the exact checked-in pre-implementation diagnostic allowlist and has
  zero diagnostics in every touched file.
- Live integration coverage passes against the deploy account, proves readiness and deletion, and
  leaves no current-run resources or Secrets Manager secrets. The exact-run stale reaper mutates only
  with the original boot/mount identity and is tested.
- Design, planning, and implementation receive independent `gpt5.6-sol` architecture, factual,
  security, and implementation-readiness reviews with no unresolved findings and reproducible
  evidence checked into the repository.
