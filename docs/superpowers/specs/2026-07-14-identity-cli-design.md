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
successful. The process entry point assigns `process.exitCode` after routing and allows queued output
to drain naturally.

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
S = terminal-safe string
K = injective terminal-safe dynamic map-key string
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
Commander handlers ----\
                        +--> application actions --> pure Identity domain
Ink screens -----------/             |
                                     +--> IdentityOperationFactory port
                                     +--> SecretSourceReader port

SDK adapter ---------------- implements IdentityOperationFactory
process/filesystem adapter -- implements SecretSourceReader
composition root ------------ injects adapters into actions and presentations
```

The domain does not depend on transport. Actions depend on the pure domain and the two port
interfaces. Adapters depend inward on those interfaces. Commander and Ink depend on actions, never
on SDK request unions.

### Ports And Adapters

`src/core/identity.tsx` is a thin raw-SDK adapter that follows the repository's existing core-client
file convention. It creates an operation-scoped `IdentityOperationBinding` that:

- Sends typed SDK commands.
- Invokes the configured credential provider exactly once and copies only its documented identity
  fields into a private frozen snapshot. Expiration is validated once and stored as immutable epoch
  milliseconds, never as a mutable `Date`.
- Eagerly resolves region, FIPS/dual-stack inputs, configured endpoints, and the resulting complete
  `EndpointV2` values before the first operation call.
- Constructs a read client with normal retries and a mutation client with `maxAttempts: 1`, both using
  the pinned AgentCore endpoint and non-refreshing credential-provider closures over the same private
  snapshot. Each provider invocation returns a new mutable plain credential object and, when present,
  a new `Date` cloned from the stored epoch. The frozen snapshot itself is never passed to an SDK
  client because AWS SDK v3 may attach `$source` feature metadata to credential objects. In AWS SDK
  v3, `maxAttempts` includes the initial request.
- Exposes page-oriented list operations.
- Exposes generated-paginator all-results operations for every paginated Identity list.
- Contains no provider classification, secret prompting, update merging, or UI policy.

The binding is created once for a mutation before its preparation Get and remains private to that
prepared capability. Both guarded Gets and the mutation use its client pair. The pair is never placed
in the process-wide `{ region, endpoint }` cache and is never shared with another operation. This
prevents independently memoized credential providers from validating one account and mutating
another after credential refresh or profile changes. A later independent operation resolves a new
snapshot and may therefore observe new credentials or endpoint configuration.

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

`IdentityOperationFactory` is the consumer-owned interface in the Identity handler boundary. The
production factory and test factory both implement it. Normal, live, capture, and stale-reaper
composition roots construct factories with their different endpoint policies; actions cannot select
or weaken that policy.

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

interface IdentityOperationBinding {
  readonly credentialExpiresAtEpochMs: number | undefined;
  sendRead<K extends keyof IdentityReadOperations>(
    operation: K,
    input: Readonly<IdentityReadOperations[K]["input"]>,
  ): Promise<IdentityReadOperations[K]["output"]>;
  pages<K extends IdentityListOperation>(
    operation: K,
    input: Readonly<IdentityReadOperations[K]["input"]>,
  ): AsyncIterable<IdentityReadOperations[K]["output"]>;
  sendMutation<K extends keyof IdentityMutationOperations>(
    operation: K,
    input: Readonly<IdentityMutationOperations[K]["input"]>,
  ): Promise<IdentityMutationOperations[K]["output"]>;
  dispose(): void;
}

interface IdentityOperationFactory {
  createBinding(): Promise<IdentityOperationBinding>;
}
```

`dispose()` is synchronous and idempotent. Port calls may reject with `unknown`; the application
boundary catches every rejection and maps it to a closed action outcome before presentation code sees
it. A binding exposes only numeric expiration metadata and explicit disposal. It never exposes the
credential values or a refresh function.

Temporary credentials are accepted only when an absent expiration or a finite expiration epoch was
captured. They are fresh exactly when expiration is absent or that epoch is more than `300_000`
milliseconds in the future. Exactly five minutes remaining fails closed. The binding checks freshness
at creation and immediately before every AWS send, including both commit Gets and the final mutation.
If the snapshot enters the window during a retrying read, the post-read check prevents the next send.
Failure disposes the secret lease and returns `credentialRefreshRequired` without a later Get or
mutation. It never transparently refreshes inside an existing capability because a refreshed identity
would invalidate the reviewed account and state.

`SecretSourceReader` is a second consumer-owned interface. Its production adapter reads named
environment variables, bounded files, and bounded non-TTY stdin. It does not prompt. Commander and
Ink own hidden-prompt rendering and pass that capability into commit without making actions depend
on either presentation library.

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

The installed SDK does not provide `@aws-sdk/config/typecheck`, and its normalized runtime schemas do
not carry the length, range, pattern, enum, or requiredness constraints needed here. The CLI therefore
defines strict Zod schemas for every Identity intent and final SDK request. Those schemas encode
required members, enums, scalar constraints, union cardinality, and conditional rules explicitly.

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

The parser immediately extracts sensitive values from raw JSON into the presentation-owned
`CommitSecretContext` and replaces their paths with source markers before planning, review, hashing,
or error handling. It does not retain the original JSON text in a plan.

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

`SecretSourceReader` applies these safeguards:

- Reject stdin when it is a TTY. Interactive users use the hidden prompt instead.
- Read stdin as a bounded stream and stop once the slot's byte cap is exceeded.
- When a file source is selected, resolve its canonical target without reading its contents and
  capture a platform file identity plus regular-file mode in an opaque locator. On POSIX this identity
  is canonical path, device, and inode; on Windows it is the equivalent volume/file ID and
  non-reparse regular-file state.
- At acquisition, open the captured canonical target with final-component no-follow behavior, then
  compare descriptor identity and mode with the captured locator before reading. Symlinks in the
  originally supplied path are accepted only through their captured canonical regular-file target;
  replacement of either the link or target cannot redirect the read. Directories, devices, FIFOs,
  sockets, reparse targets, and changed files are rejected.
- Read only through the verified descriptor. A platform on which the adapter cannot enforce the
  no-follow and stable-identity checks rejects file secret sources rather than weakening the contract.
- Decode as strict UTF-8 and preserve whitespace and newlines.
- Enforce both the byte cap before decoding and the modeled character constraint after decoding.

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
contradictory, Update fails closed with `UnknownCurrentSource` before reading a replacement secret or
sending Update. The CLI never infers current source from the desired source, a secret ARN, or user
assertion.

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
context owns all literal values, managed-value acquisition locators, the `SecretSourceReader`, the
optional hidden-prompt callback, and any resolved values. Its public shell and private claim lease
have a synchronous one-use lifecycle:

```text
open --claim()--> leased --lease.dispose()--> disposed
  \--context.dispose()----------------------> disposed
```

`claim()` atomically moves all owned state into an opaque `CommitSecretLease` and leaves the context
shell inert. Only that lease can resolve sources or dispose leased state. `context.dispose()` is
idempotent and can consume only `open`; it is a no-op after a successful claim, so a rejected duplicate
commit cannot dispose another in-flight commit's lease. `lease.dispose()` is idempotent and runs in
the winning commit's `finally`.

The parser or TUI creates the context and initially owns it. A preparation action borrows it without
claiming or reading secret content. A `prepared` outcome returns the still-open context beside, but
not inside, the immutable capability. Preparation disposes it before returning `noChange` or any
failure. After a prepared review, the presentation owns both objects: commit synchronously transfers
the context into a lease; cancellation, abandoned review, screen unmount, or an error boundary
disposes the still-open context and the prepared capability. A duplicate commit disposes only its
supplied context when that context is still open. Every success, error, cancellation,
credential-expiry, and reprepare path disposes the winning lease.

Disposal removes all references the CLI controls; it does not claim JavaScript zeroization. A
replacement `PreparedMutation` never carries a context or acquired/literal values. Commander exits
and requires a rerun. Ink may retain non-secret form choices, but it must construct a new context and
reacquire or re-prompt every managed value before committing the replacement plan.

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
  | "InternalServerException"
  | "ResourceNotFoundException"
  | "ServiceQuotaExceededException"
  | "ThrottlingException"
  | "ValidationException";

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
      slot?: SecretSlotId;
    }
  | {
      category: "secret";
      reason:
        | "alreadyConsumed"
        | "environmentUnavailable"
        | "fileChanged"
        | "fileUnavailable"
        | "invalidValue"
        | "promptUnavailable"
        | "stdinUnavailable";
      slot: SecretSlotId;
    }
  | {
      category: "service";
      code: SafeServiceCode | "UnknownServiceError";
      httpStatus?: number;
      requestId?: string;
    }
  | { category: "internal" };

type QueryFailure =
  | { kind: "notFound" }
  | { kind: "sdkCompatibilityRequired" }
  | { kind: "credentialRefreshRequired" }
  | { kind: "validationFailed"; error: SafeIdentityError }
  | { kind: "serviceFailed"; error: SafeIdentityError };

type PrepareFailure =
  | { kind: "notFound" }
  | { kind: "sdkCompatibilityRequired" }
  | { kind: "unsupportedProvider" }
  | { kind: "unsupportedResourceStatus" }
  | { kind: "credentialRefreshRequired" }
  | { kind: "validationFailed"; error: SafeIdentityError }
  | { kind: "serviceFailed"; error: SafeIdentityError };

type CommitFailure =
  | PrepareFailure
  | { kind: "cancelled" }
  | { kind: "secretResolutionFailed"; error: SafeIdentityError };

type QueryOutcome<T> = { kind: "succeeded"; value: T } | QueryFailure;

type PrepareOutcome<T> =
  | {
      kind: "prepared";
      mutation: PreparedMutation<T>;
      secrets: CommitSecretContext;
    }
  | { kind: "noChange"; value: T }
  | PrepareFailure;

type CommitOutcome<T> =
  | { kind: "committed"; value: T }
  | { kind: "noChange"; value: T }
  | { kind: "reprepareRequired"; replacement: PreparedMutation<T> }
  | { kind: "alreadyConsumed" }
  | CommitFailure;

interface IdentityQueryAction<Input, Output> {
  execute(input: Readonly<Input>): Promise<QueryOutcome<Output>>;
}

interface IdentityMutationAction<Input, Output> {
  prepare(input: Readonly<Input>, secrets: CommitSecretContext): Promise<PrepareOutcome<Output>>;
}

interface CommitSecretContext {
  claim(): CommitSecretLease | undefined;
  dispose(): void;
}

interface CommitSecretLease {
  resolve(slot: SecretSlotId): Promise<string>;
  dispose(): void;
}

interface PreparedMutation<T> {
  readonly review: IdentityReviewModel;
  commit(secrets: CommitSecretContext): Promise<CommitOutcome<T>>;
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

Only `reprepareRequired` carries a replacement capability, and only `prepared` carries an open
context. `alreadyConsumed` is decided before source resolution, then calls `dispose()` on the supplied
context; because disposal can consume only `open`, it cannot affect the winning commit's lease. All
error members carry only closed safe data. PascalCase outcome labels in the surrounding prose refer
to these exact lower-camel `kind` discriminants.

Commit-time `noChange` is defined only for a guarded replacement mutation whose fresh rebase already
equals the requested effective state and has no remaining opaque secret rotation/removal, including
the case where another actor applied the non-secret state after review. It returns the normalized
fresh Get value and sends no mutation. It can be detected before secret acquisition or after the
second Get; the latter path first disposes the acquired lease.

Once preparation creates a binding, only a `prepared` outcome transfers it to the capability; every
other preparation outcome destroys the binding and disposes the context. Commit destroys its binding
lease for every outcome except successful transfer through `reprepareRequired`.

### Preparation

Create preparation:

1. Parses scalar and JSON syntax.
2. Moves literal secret values into a presentation-owned `CommitSecretContext`.
3. Rejects option conflicts and validates all provider-independent structure.
4. Resolves and validates the provider descriptor.
5. Validates family-specific non-secret semantics.
6. Determines the exact secret slots required at commit.
7. Creates an `IdentityOperationBinding`.
8. Produces canonical commit state and a review model derived from it.

Update rejects local syntax errors, option conflicts, and provider-independent invalid values before
Get. It then creates one `IdentityOperationBinding`, performs its initial Get, identifies the actual
vendor/family, applies family-specific validation, checks the operation-specific writable-state
policy, normalizes current state, applies only explicit patch intent, and derives the same state and
secret requirements. It preserves the original explicit intent so commit can rebase instead of
replaying a prebuilt request. Options whose validity depends on the current vendor are deliberately
validated after Get; user-supplied vendor or config assertions are never trusted as current-state
evidence.

OAuth Update permits only an absent status, `READY`, or `UPDATE_FAILED`. Any other known or future
status returns `UnsupportedResourceStatus` before secret acquisition. This allowlist reflects current
Update service behavior and is not shared by other operations. Delete uses its own service workflow
checks and does not impose a persisted-status allowlist. Tag and Untag are existence/authorization
operations and do not inherit an Update readiness gate.

OAuth and payment Updates use a compatibility-guarded Get for preparation and every commit-time
rebase. Middleware is registered relative `after` `deserializerMiddleware`, which places it on the
response path before the generated deserializer consumes the body. It buffers a successful raw
response only while `bodyBytes <= 1_048_576`; 1,048,576 bytes is accepted and the next byte fails.
On overflow it immediately destroys a Node-readable body or cancels a Web stream, without draining or
retaining additional chunks. It parses accepted bytes, validates them with an explicit
operation-specific `RawWireSchema`, restores the exact bytes as a new `Uint8Array` for normal SDK
deserialization, and passes non-success responses through untouched.

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

The private frozen plan behind a `PreparedMutation` contains only:

- Operation, resource selector, and immutable provider identity.
- Explicit non-secret intent, desired storage modes, and external references.
- A `CommitGuard`.
- A canonical review model derived from guarded state.
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
```

`PreparedMutation.dispose()` is synchronous and idempotent. It can consume only `prepared`, atomically
detaches and destroys that capability's binding, and then transitions to `disposed`. It is a no-op in
`committing`, `consumed`, or `disposed`, because commit has already moved binding ownership into a
commit-local lease. This makes cancellation/unmount safe even when it races a submit.

### One-Shot Commit

`PreparedMutation.commit()` synchronously and atomically claims `prepared`, moves the binding into a
commit-local ownership lease, claims the supplied `CommitSecretContext`, and transitions the
capability through `committing` to terminal ownership before its first `await`. If the context cannot
be claimed, the capability remains consumed, its binding lease is destroyed, and commit returns a
closed `secretResolutionFailed` outcome. Every later call disposes only its own still-open supplied
context and returns `alreadyConsumed` without reading secrets or calling AWS, including concurrent
calls made while the first is pending. Because the winning state transition, binding transfer, and
secret claim are one synchronous turn, a duplicate call using the same context observes an inert
claimed shell and cannot disrupt the winner. A shared commit coordinator owns this transition; Ink
submit handlers also use a synchronous ref latch so buffered confirmation input cannot enter commit
twice.

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
13. Sends one mutation command through the binding's `maxAttempts: 1` mutation client.
14. Disposes the secret lease in `finally`; destroys the binding lease on terminal outcomes.

Commit outcomes are a closed union. `ReprepareRequired` contains a replacement frozen capability only
when the current resource is known, its provider and response shape are supported, its status is
writable for this operation, and the original explicit intent can be reconstructed completely against
the new state. `NotFound`, `SdkCompatibilityRequired`, `UnsupportedProvider`,
`UnsupportedResourceStatus`, `CredentialRefreshRequired`, and validation failures are separate
outcomes and never carry a replacement capability. A mismatch after secret acquisition disposes all
resolved and literal values before returning. Ink renders an available replacement plan and requires
a new confirmation plus a newly constructed secret context. Commander returns a typed state-changed
error and requires the user to rerun the command; it never authorizes a replacement plan on the
original invocation. When a replacement is returned, ownership of the same immutable operation
binding transfers atomically from the commit-local lease to the replacement before it is returned;
the old capability cannot destroy or reuse it. Commander disposes the unaccepted replacement before
exiting. Commit never loops or auto-approves.

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
automatically retry an Identity mutation: a timeout leaves the service outcome unknown. Read clients
retain the SDK's normal retry policy.

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
- Fail closed with `UnknownCurrentSource` if `Get` does not identify a populated slot's current
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
their visited token chain and stop with the same static pagination error.

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

| Commander code                                                    | Safe output                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `commander.helpDisplayed`, `commander.version` with exit code `0` | Success; use configured help/version output                     |
| `commander.missingArgument`                                       | `A required argument is missing. Run with --help for usage.`    |
| `commander.optionMissingArgument`                                 | `An option value is missing. Run with --help for usage.`        |
| `commander.missingMandatoryOptionValue`                           | `A required option is missing. Run with --help for usage.`      |
| `commander.conflictingOption`                                     | `Conflicting options were provided. Run with --help for usage.` |
| `commander.unknownOption`                                         | `An unknown option was provided. Run with --help for usage.`    |
| `commander.excessArguments`                                       | `Too many arguments were provided. Run with --help for usage.`  |
| `commander.unknownCommand`                                        | `An unknown command was provided. Run with --help for usage.`   |
| `commander.invalidArgument`, `commander.error`                    | `An option or argument is invalid. Run with --help for usage.`  |
| Any unrecognized code or non-Commander failure                    | Static internal error                                           |

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
serialized completely and queued in one stdout write. The process entry point uses
`process.exitCode`, not `process.exit`, so pipe backpressure can drain before natural termination.

React error boundaries do not catch asynchronous callback or query failures. Every Identity query,
mutation, event handler, submit callback, and hidden-prompt continuation catches `unknown` at the
point where the rejection is observed and maps it to a closed `SafeIdentityError` union before
updating component state. The union contains only CLI-authored codes, static guidance, and separately
validated primitive metadata. Identity components never accept, store, interpolate, or render a raw
`Error`.

Safe response normalization also applies to successful reads:

- Raw `failureReason` is never inspected for rendering or printed. Its presence maps through the
  allowlisted OAuth status to the static V1 guidance above.
- Unknown union bodies are replaced with their sanitized member-name marker.
- Metadata outside the explicit safe response contract is omitted instead of passed through.

Malformed JSON and schema validation errors identify the option and a CLI-owned schema path. They do
not include JavaScript parser text, typecheck excerpts, raw values, or unknown keys copied from
untrusted input.

All dynamic strings destined for Ink or Commander output cross one terminal-safe rendering boundary.
It replaces every C0 control, `DEL`, C1 control, ANSI/OSC introducer, and bidirectional formatting or
isolation control with a visible ASCII `\u{XXXX}` escape. This includes U+061C, U+200E, U+200F,
U+202A through U+202E, and U+2066 through U+2069. Escaping an ESC or C1 introducer neutralizes the
entire terminal sequence. Semantic validation rejects these controls outright in user-supplied URLs
and tag keys or values; safe rendering still applies to service-returned legacy data and every other
dynamic field.

Dynamic map keys use an injective key variant of the encoder. It also encodes every literal backslash
as `\u{005C}` before encoding unsafe code points, so a key containing an actual control cannot collide
with a different key containing literal text such as `\u{001B}`. Static DTO property names bypass
this transform; dynamic records such as tags encode keys before object construction and fail closed
on any duplicate, even though the injective transform makes a well-formed collision impossible.

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
      output: FixtureValue
    }
  | exact {
      version: 1,
      kind: "modeledError",
      operation: IdentityOperationName,
      code: SafeServiceCode,
      httpStatus?: integer 100..599,
      requestId?: validated request ID
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
`failureReason`, metadata outside the classifier allowlist, and every unregistered field. A captured
SDK `$unknown: [name, body]` becomes `unknownUnion` after sanitizing only the name; the body is never
traversed. Replay revives dates as fresh `Date` instances and unknown unions as
`{ $unknown: [safeName, {}] }`. A modeled-error registry constructs the pinned SDK exception class
with a static message and only the recorded safe metadata, then throws it. Unknown errors, unknown
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
is absent. A platform no-replace primitive is used when available. Capture object paths are
flow-namespaced and same-flow calls are sequential; publication holds the suite lock, so the fallback
path still has exactly one authorized installer per target. If a digest path exists, including after a
competing no-replace result, the helper reads it and verifies exact length, full SHA-256, and canonical
bytes before treating it as installed. An empty, truncated, mismatched, non-regular, or unreadable
existing object fails closed and is never replaced or used as a cache hit. Temporary files are
ignored by readers and removed best-effort after failure. No digest path is ever opened for
incremental writing.

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
test-only `fs-native-extensions@1.4.4` dependency supplies Linux OFD `fcntl`, macOS `flock`, and
Windows `LockFileEx`; its Bun behavior is gated in Linux, macOS, and Windows CI before adoption.
Kernel release on descriptor close or process death eliminates stale-file reclamation, PID reuse, and
check/remove/recreate races. Network filesystems are unsupported for fixture publication.

While holding the lock, publication rechecks that the current suite-index digest equals the capture's
base digest. A stale publisher fails instead of merging or overwriting a newer generation. It
atomically installs and verifies every missing immutable blob and manifest with the helper above,
writes the canonical next index to an exclusive same-directory temporary file, `fsync`s it, and
renames it over the suite index. It syncs the parent directory where the platform supports directory
handles. Old referenced objects are not deleted during publication. The portable guarantee is
process-crash consistency through atomic same-filesystem rename, not power-loss or
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
- `CommitSecretContext` returns one opaque lease, rejects a second claim, and disposes literal,
  acquired, locator, reader, and prompt references on preparation failure/no-change, cancellation,
  abandoned review, unmount, duplicate commit, every terminal commit outcome, and reprepare.
- Disposing a claimed context shell cannot affect its active lease, and duplicate commits dispose
  only their own still-open context.
- Multiple stdin consumers are rejected.
- All sensitive paths are redacted.
- Every populated slot with omitted or contradictory current-source metadata normalizes to
  `UnknownCurrentSource` and fails without reading a replacement secret.
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
- Terminal-safe rendering visibly escapes C0, `DEL`, C1, ANSI/OSC introducers, and bidi controls.
- Dynamic map-key encoding distinguishes an actual control from a literal `\u{XXXX}` sequence and
  preserves every distinct tag key.
- URL and tag validation rejects every terminal or bidi control accepted by JavaScript strings.
- ARN parsing accepts the live-observed, CLI-owned family templates across representative `aws`,
  `aws-us-gov`, and `aws-cn` partitions; rejects wrong service, family, resource shape, account
  syntax, and resolved region; requires workload direct ARNs to use directory `default`; and
  deliberately permits a syntactically valid cross-account ARN to reach AWS authorization.

### Secret Source Adapter Tests

- TTY stdin, non-regular files, invalid UTF-8, and over-limit byte and character counts are rejected.
- Bounded stdin stops reading at the configured byte cap.
- File acquisition uses final-component no-follow open and rejects regular-to-regular inode/file-ID
  substitution, symlink retargeting, mode changes, reparse points, and non-regular replacements after
  locator capture.
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
- All-results operations consume generated paginators with real client instances.
- Same-token and cyclic pagination fail before results render.
- Prepared plans are frozen, canonical, and contain no secret bytes.
- Cancellation and terminal outcomes destroy the operation binding; reprepare transfers it exactly
  once to the replacement capability, and Commander disposes an unaccepted replacement.
- `PreparedMutation.dispose()` races commit through the same ownership state machine: exactly one
  path obtains the binding, repeated disposal is inert, and disposal after commit cannot destroy the
  commit-local or replacement lease.
- A prepared capability rejects sequential and concurrent second commits before secret I/O or AWS
  calls.
- Update preparation Gets once; commit Gets before and after secret acquisition.
- OAuth/payment Update preparation and both commit Gets reject additive raw response fields before
  generated deserialization. Preparation and the first commit Get fail before secret I/O; an
  incompatible second Get disposes acquired values before returning.
- Raw compatibility bodies of 1,048,575 and 1,048,576 bytes are accepted, 1,048,577 bytes are
  rejected, and an oversized Node or Web stream is destroyed/cancelled. Valid OAuth responses without
  `clientSecretArn` pass; missing genuinely required members, wrong scalar wire types, nulls,
  truncation, and unknown keys/arms fail closed.
- A changed pre-acquisition guard returns a replacement `PreparedMutation` without reading secrets or
  mutating.
- A changed post-acquisition guard discards resolved values and returns a replacement capability
  without mutating.
- Reprepare never carries literal or acquired values into the replacement; a second commit requires a
  newly constructed `CommitSecretContext`.
- Unsupported shapes, providers, statuses, and NotFound return their own typed outcomes and never
  carry a replacement capability.
- An equivalent pair of fresh rebases resolves secrets only at commit and sends one mutation command.
- Delete, name-selected Tag/Untag, and Set CMK reject changed target identity or guarded state.
- Direct-ARN Tag, Untag, and List Tags make zero Get and STS calls and send the exact locally
  validated ARN; same-name local resources cannot affect direct mode.
- A request-handler-level retry test proves every mutation makes at most one HTTP attempt while reads
  retain their configured retry policy.
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
- Parser tests assert the exact pinned codes, including `commander.unknownOption`,
  `commander.helpDisplayed`, and `commander.version`; unprefixed lookalikes take the unknown-code path.
- A subprocess writing a multi-megabyte normalized JSON document through a slow pipe exits naturally
  with a complete parseable document.
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
- OAuth callback URLs are displayed on create, get, and update result screens.
- Cancellation makes no mutation call.
- Delete and CMK changes require confirmation.
- Empty, loading, failure, and success states render correctly.
- Buffered confirmation input and repeated submits cannot commit one capability twice.
- Query, mutation, event-handler, and prompt-continuation rejections become `SafeIdentityError`
  values; components never render a raw `Error`.
- Ink error-boundary and async-callback tests use sentinel-bearing messages and assert that no frame,
  stdout, stderr, stack, cause, golden, or fixture contains the sentinel.
- Dynamic fields containing C0, C1, ANSI, OSC, and bidi controls render as visible ASCII escapes and
  cannot alter terminal state or reviewed layout.

### SDK Drift Tests

- Runtime SDK enum values equal catalog keys.
- Runtime OAuth and payment union member names equal reviewed expectations.
- Raw-response compatibility tests cover additive fields at every known OAuth/payment structure,
  unknown union arms, malformed and boundary-sized success bodies, non-2xx pass-through, stream
  replay, no-secret OAuth, and the known `privateKeyJwtConfig` model drift.
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
allowlisted modeled exception through a real SDK client instance. Atomic-object tests kill before and
after temp-file `fsync` and rename, retry abandoned installs, exercise no-replace contention, and
reject a pre-existing empty, truncated, wrong-digest, or non-canonical digest-path object.

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
  lock for the runner lifetime. The lock file is never unlinked or atomically replaced.
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
Mutation cleanup opens the permanent per-run `.run.lock` and first acquires its descriptor lock
non-blocking, so it cannot reap a current run; it never locks the atomically replaced ledger inode.
Every mandatory ledger, tag, and available service time must predate the cutoff, and all normal
deletion predicates still apply. It never deletes an unledgered, untagged, tag-mismatched, recreated,
young, active, or out-of-scope resource. Any failed ownership read fails closed. Dry-run output is the
default; mutation requires an explicit confirmation flag.

The stale reaper uses the same hardened invocation binding as live execution and capture. It rejects
`--endpoint-url`, bypasses every environment/profile endpoint override, resolves official HTTPS
AgentCore, STS, and Secrets Manager endpoints before its account check, resolves credentials exactly
once, and gives all three services non-refreshing providers over that one snapshot. It checks the
immutable expiration epoch before every read and mutation send. Entering the five-minute window aborts
the reaper without refreshing or issuing a later request.

A local ledger survives process failure, not loss of its host or filesystem. CI capture persists the
mode-`0600` ledger as a restricted cleanup artifact. Without the exact ledger, host-loss cleanup may
report audit sweep results but must refuse mutation. Reaper tests cover every rejection predicate,
same-name recreation, unledgered sweep results, partial reruns, and exact-run cleanup. Kill-point
tests stop after planned-row sync and after service acceptance but before ARN persistence; both paths
remain recoverable only through the candidate-ID and full ownership conjunction. Reaper binding tests
also prove endpoint overrides are ignored, one credential snapshot spans STS/AgentCore/Secrets
Manager, freshness is checked before every send, and the permanent run lock survives ledger
replacement while excluding active-run cleanup.

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

No framework change is required. Expected direct dependencies are:

- Existing `@aws-sdk/client-bedrock-agentcore-control`, locked at `3.1079.0` for this implementation.
- Existing `@aws-sdk/client-bedrock-agentcore`.
- Existing Commander, Ink, React Query, and Zod packages.
- Direct `@smithy/core`, aligned with the pinned clients, for normalized structure, union, and
  sensitive-path traversal only.
- Test-only `@aws-sdk/client-sts` for live account verification.
- Test-only `@aws-sdk/client-secrets-manager` for run-owned EXTERNAL fixtures and cleanup.
- Direct test-only `fs-native-extensions@1.4.4` for permanent-file OS descriptor fixture-publication
  and live-run liveness locks.

Dependency versions remain aligned with the pinned AWS SDK generation. SHA-256 uses the platform
crypto implementation. Native lock support must pass Bun CI on every compiled Linux, macOS, and
Windows target before fixture publication or live-run cleanup is enabled on that target.

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
  submit, dispose, cancellation, unmount, no-change, failure, and reprepare.
- One immutable numeric credential snapshot and eagerly resolved endpoints bind every operation;
  SDK clients receive isolated mutable clones and no operation refreshes midway.
- File secret acquisition detects symlink and regular-file substitution before reading content.
- Async Commander and Ink failures expose only `SafeIdentityError` output, and untrusted terminal
  controls cannot affect rendering.
- Pagination never silently truncates, loops, or emits partial all-results output.
- Complete tag lifecycle works.
- No secret reaches output, error artifacts, fixture content, or fixture identity.
- Golden recordings are deterministic across worker schedules and process-safe, and incomplete
  captures, truncated objects, or interrupted installation cannot modify or poison the committed
  fixture set.
- Unit, router, action, screen, golden, and build checks pass.
- `bunx tsc --noEmit` matches the exact checked-in pre-implementation diagnostic allowlist and has
  zero diagnostics in every touched file.
- Live integration coverage passes against the deploy account, proves readiness and deletion, and
  leaves no current-run resources or Secrets Manager secrets. The exact-run stale reaper is tested.
- Design, planning, and implementation receive independent `gpt5.6-sol` architecture, factual,
  security, and implementation-readiness reviews with no unresolved findings and reproducible
  evidence checked into the repository.
