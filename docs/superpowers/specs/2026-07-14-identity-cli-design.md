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
- Update commits re-read current state and stop without mutation if that read changes the reviewed
  plan or its secret requirements.
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

- `--name <name>` resolves the resource through its Get operation and extracts its ARN.
- `--resource-arn <arn>` uses the ARN directly after validating that it belongs to the selected
  Identity resource family.

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
empty object. `tag` preserves keys absent from the request and replaces values for keys present in the
request. `untag` requires one to 200 unique, non-empty keys. Create supports at most 50 tags, with keys
of one to 128 characters and values of zero to 256 characters. Update does not accept `--tags`;
callers use `tag` and `untag`.

Live probes confirmed that the generic Tag, Untag, and List Tags operations accept all four Identity
ARN families. Generated Tag documentation that lists only older AgentCore resource families is stale.

List page sizes use the modeled ranges and defaults:

| Resource          | `--max-results` range | Service default |
| ----------------- | --------------------: | --------------: |
| API-key provider  |              1 to 100 |              10 |
| OAuth2 provider   |               1 to 20 |              10 |
| Payment provider  |               1 to 20 |              10 |
| Workload identity |               1 to 20 |              10 |

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
`--clear-client-authentication-method`, `--clear-on-behalf-of`, and
`--clear-private-endpoint-overrides` under the validity rules in Update Semantics. There is no
Identity-level `--grant-type`; grant values occur only inside custom OAuth
`--on-behalf-of-json`.

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

Every executed Commander leaf emits exactly one JSON document to stdout, whether or not `--json` is
present. Empty Delete, Tag, and Untag SDK responses normalize to `{}`. Warnings and static actionable
errors use stderr and never corrupt stdout.

`--json` selects noninteractive Commander execution. It disables TUI mounting, hidden
prompts, and confirmation prompts. It does not imply consent for `token-vault set-cmk`; that command
still requires `--yes` in noninteractive mode. Bare groups with `--json` retain the repository's
existing help behavior and are not executed leaves.

A bare Identity group, resource group, or leaf opens its Ink route when the user supplied no
leaf-specific option or argument and did not supply `--json`. Routing checks Commander's option value
source, not the parsed value, so boolean default values such as `false` do not count as explicit
input. Any CLI-sourced option, including a value equal to its default, selects Commander mode.

Explicit Commander Delete commands match Harness and do not accept or require `--yes`. TUI Delete
flows always confirm. `token-vault set-cmk` confirms in both presentations as described above.

## Architecture

Identity uses one-way dependencies and consumer-owned ports:

```text
Commander handlers ----\
                        +--> application actions --> pure Identity domain
Ink screens -----------/             |
                                     +--> CoreIdentityClient port
                                     +--> SecretSourceReader port

SDK adapter ---------------- implements CoreIdentityClient
process/filesystem adapter -- implements SecretSourceReader
composition root ------------ injects adapters into actions and presentations
```

The domain does not depend on transport. Actions depend on the pure domain and the two port
interfaces. Adapters depend inward on those interfaces. Commander and Ink depend on actions, never
on SDK request unions.

### Ports And Adapters

`src/core/identity.tsx` is a thin raw-SDK adapter that follows the repository's existing core-client
file convention. It:

- Sends typed SDK commands.
- Applies the shared region and endpoint configuration.
- Exposes page-oriented list operations.
- Exposes generated-paginator all-results operations for every paginated Identity list.
- Contains no provider classification, secret prompting, update merging, or UI policy.

`CoreIdentityClient` is the consumer-owned interface in the Identity handler boundary. The production
client and test client both implement it.

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
- SDK schema validation.
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
- Rebase update intent on a fresh Get immediately before commit.
- Resolve secret values only after the rebase remains review-equivalent.
- Construct and validate the exact SDK request.
- Invoke `CoreIdentityClient` at most once per commit.
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
- Runtime structure and union schemas.
- Required-member metadata present in the installed SDK.
- Sensitive traits.
- Generated paginators.

The CLI uses the official `@aws-sdk/config/typecheck` validator for structural request validation and
`NormalizedSchema` from `@smithy/core/schema` for supported schema traversal. Both are direct
dependencies. The implementation does not use Smithy's internal `schemaLogFilter` or read static
schema tuple indexes directly.

SDK runtime validation is not treated as complete. CLI validation additionally enforces:

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
optional tenant ID. On create, omitted tenant ID uses `common`. The canonical discovery URL is
`https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration`. Resetting an
existing tenant-specific provider to `common` requires `--clear-tenant-id`.

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

Required response fields named `apiKeySecretArn`, `clientSecretArn`, and payment `*SecretArn` are
`Secret` objects shaped `{ secretArn: string }`, not strings. External secret inputs use
`SecretReference`, which requires `{ secretId, jsonKey }`.

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

The implementation derives structural validators from public runtime schemas and pins explicit
semantic tests for these constraints:

| Shape                          | Constraint                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| Credential provider name       | 1 to 128 characters; `^[a-zA-Z0-9\-_]+$`                                                     |
| Workload identity name         | 3 to 255 characters; `^[A-Za-z0-9_.-]+$`                                                     |
| Token-vault ID                 | 1 to 64 characters; `^[a-zA-Z0-9\-_]+$`                                                      |
| API key                        | Sensitive; at most 65,536 characters                                                         |
| Named/included OAuth client ID | 1 to 256 characters                                                                          |
| Custom OAuth client ID         | At most 256 characters                                                                       |
| OAuth client secret            | Sensitive; at most 2,048 characters                                                          |
| Microsoft tenant ID            | 1 to 2,048 characters                                                                        |
| Discovery URL                  | Must end in `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server` |
| Workload return URL            | 1 to 2,048 characters; `^\w+:(\/?\/?)[^\s]+$`                                                |
| External secret ID             | 1 to 2,048 characters                                                                        |
| External secret JSON key       | 1 to 128 characters                                                                          |
| Payment non-secret IDs         | 1 to 512 characters; `^[a-zA-Z0-9\-_]+$`                                                     |
| Payment secrets                | Sensitive; at most 2,048 characters; base pattern `^[a-zA-Z0-9+/=\-_\s]*$`                   |
| Authorization private key      | Payment secret pattern with the modeled optional `wallet-auth:` prefix                       |
| Private endpoint overrides     | At most five                                                                                 |
| Customer-managed KMS ARN       | 1 to 2,048 characters and the modeled partition, account, and key UUID pattern               |
| Tags                           | At most 50 entries; key 1 to 128; value 0 to 256                                             |

The service-only maximum of five workload return URLs supplements the pinned model. The complete
private-endpoint, override, VPC, subnet, security-group, ARN, and nested OAuth constraints remain
enforced by runtime schema validation instead of being duplicated in this table.

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

Intent types contain explicit non-secret patch operations and secret source descriptions. Actual
secret bytes remain outside the intent and every prepared plan.

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
Curated custom OAuth Create requires `--client-authentication-method`; raw mode retains the modeled
ability to omit it.

### Raw Mode

OAuth and payment Create commands use `--config-json` for a complete SDK-native provider config
union. Their Update commands use the deliberately different `--replace-config-json` name. It replaces
all non-secret provider configuration represented by that union; it is not a patch and does not
inherit omitted non-secret members from the current resource.

Both options are mutually exclusive with curated non-secret provider options and clear options.
Secret slots remain under the shared secret resolver: existing EXTERNAL references are preserved when
omitted, while service-required MANAGED values must be supplied again. Known secret inputs fill
sensitive paths omitted from raw JSON. If raw JSON and a secret input both target the same path, the
command fails with a conflict error. Sensitive values embedded directly in JSON are accepted as
literal input with the same warning and redaction guarantees as literal secret flags.

The parser immediately extracts sensitive values from raw JSON into ephemeral secret bindings and
replaces their paths with source markers before planning, review, hashing, or error handling. It does
not retain the original JSON text in a plan.

The implementation performs adapter-owned composition at known secret paths; it does not implement a
generic deep-merge engine.

The chosen vendor must match the supplied union member. Unknown keys, multiple union members, and
vendor mismatches fail before an AWS call. Malformed JSON errors identify only the option, such as
`Invalid JSON for option '--config-json'`; they never include parser text or an input excerpt.

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

`--<slot>-source <managed|external>` is an optional explicit declaration. A managed input implies
`managed`; an external pair implies `external`; an explicit declaration must agree. Update requires
the declaration only when Get omits the current slot's source and the CLI cannot infer it safely.

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
- Accept a file only when its resolved target is a regular file. Symlinks are accepted only when the
  final target is regular; directories, devices, FIFOs, and sockets are rejected.
- Verify the opened file descriptor is still a regular file before reading.
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

JavaScript does not provide reliable memory zeroization for immutable strings or copies made by the
runtime and SDK. The implementation minimizes lifetime and references, drops bindings immediately
after the send settles, and does not claim cryptographic erasure.

## Request Flow

Mutation preparation and commit are separate. Preparation never reads env, files, stdin, or hidden
prompts and never creates an SDK request containing secret bytes.

### Preparation

Create preparation:

1. Resolves the provider descriptor.
2. Parses scalar and JSON input.
3. Moves any literal secret values into ephemeral bindings.
4. Rejects conflicts and validates non-secret structure and semantics.
5. Determines the exact secret slots required at commit.
6. Produces a canonical, immutable review model.

Update preparation performs an initial Get, normalizes the current resource, applies only explicit
patch intent, and derives the same review model and secret requirement set. It preserves the
unmodified explicit intent to support rebasing instead of replaying a prebuilt SDK request.

A prepared plan contains only:

- Operation, resource selector, and immutable provider identity.
- Explicit non-secret intent and secret source descriptions.
- Canonical normalized baseline facts needed for rebase.
- Canonical review model.
- Secret requirement signature.

Plans and nested values are frozen. They contain no literal, prompt, stdin, env, or file secret value.
The TUI renders the plan and confirms it. An explicit Commander mutation authorizes its plan without
an additional review prompt, except `token-vault set-cmk`.

### One-Shot Commit

Commit accepts the prepared plan, separate ephemeral secret bindings, and a presentation-owned hidden
prompt callback. For Update it:

1. Performs a fresh Get.
2. Rebases the original explicit intent on that fresh normalized state.
3. Recomputes the canonical review model and secret requirement signature.
4. Compares both to the reviewed plan before reading any secret source.

If either value changed, commit returns `ReprepareRequired` with a static explanation and makes no
mutation call. The presentation shows the new plan and asks for review again. Commit does not loop or
auto-approve the changed plan.

After the equivalence check, commit:

1. Resolves env, file, and stdin through `SecretSourceReader` and prompt values through the supplied
   hidden-prompt callback.
2. Composes the exact SDK union at adapter-owned secret paths.
3. Runs SDK structural validation and CLI semantic validation.
4. Sends exactly one mutation through `CoreIdentityClient`.
5. Drops all secret bindings after success or failure.

Create, Delete, Tag, Untag, and Set CMK use the same plan/commit contract without an update rebase.
Name-based tag actions resolve the ARN during preparation and resolve it again at commit. A changed
ARN returns `ReprepareRequired`. No commit automatically retries a mutation because a timeout leaves
the service outcome unknown.

The fresh Get reduces accidental lost updates but cannot make the operation atomic. The service does
not expose a customer-visible version token or conditional update.

## Update Semantics

### Common Rules

- Omitted update fields remain unchanged.
- Empty strings never implicitly mean clear.
- Clear operations are explicit.
- Immutable names and vendor types cannot change.
- Provider secret storage mode cannot change.
- Update with no mutation option fails before Get.
- An explicit secret input always counts as a rotation because the CLI cannot compare secret values.

Curated mode exposes only service-valid clear operations:

- OAuth `--clear-tenant-id` resets Microsoft discovery to the `common` tenant.
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
- Never removes a client secret unless the user supplied `--clear-client-secret` and the resulting
  custom OAuth authentication configuration permits no secret.
- Resends required private endpoint and per-tenant endpoint fields.

For custom OAuth, the effective client-authentication method drives secret behavior:

| Effective method                      | Create                                                                   | Update without a new secret                                                                                                        | Transition behavior                                                               |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `CLIENT_SECRET_BASIC`                 | Requires client ID and a managed value or external reference             | Preserves a reconstructable EXTERNAL reference; requires MANAGED re-entry                                                          | Transition from IAM-JWT requires a source and value/reference                     |
| `CLIENT_SECRET_POST`                  | Requires client ID and a managed value or external reference             | Preserves a reconstructable EXTERNAL reference; requires MANAGED re-entry                                                          | Transition from IAM-JWT requires a source and value/reference                     |
| `AWS_IAM_ID_TOKEN_JWT`                | Does not require a client secret                                         | Does not request a client secret                                                                                                   | Transition from a secret-bearing method requires explicit `--clear-client-secret` |
| Omitted custom method (raw mode only) | Requires a managed value or external reference when client ID is present | Preserves the current method and existing source; MANAGED re-entry is required when the effective service method is secret-bearing | Never implies a method change or secret removal                                   |

Supplying `--clear-client-secret` while the effective method is `CLIENT_SECRET_BASIC` or
`CLIENT_SECRET_POST` fails validation. Changing to `AWS_IAM_ID_TOKEN_JWT` without the clear also fails
so the CLI never removes a secret as an implicit side effect.

Microsoft `Get` output does not return tenant ID. For an existing tenant-specific provider, the CLI
recovers it only from the exact canonical Microsoft discovery URL pattern. If the URL is not
recognized, update requires explicit `--tenant-id`; it never silently resets to `common`.

An older SDK fails to deserialize a future output member it does not recognize. This is a residual
limitation of the service's replacement semantics. SDK drift tests reduce the window but cannot
provide atomic forward compatibility. Service-side patch semantics remain the permanent improvement.

### Payment

The service currently requires every managed secret in a payment update, including when only a
non-secret identifier changes.

The CLI handles this without blocking the feature:

- Rehydrate all non-secret fields from `Get`.
- Preserve each reconstructable EXTERNAL reference from its `{ secretArn }` object, source, and JSON
  key.
- Require the user to supply every MANAGED secret slot again.
- Require explicit storage mode if `Get` does not identify it.
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

Service errors:

- Include an allowlisted modeled error code.
- Include HTTP status and request ID only when those fields have the expected primitive types.
- Map known cases to static actionable guidance.
- Do not serialize the entire exception.
- Do not print arbitrary raw HTTP response bodies.
- Do not trust an unknown service message to be free of echoed input.

An outer boundary wraps root Commander execution, and an Ink error boundary wraps Identity screens.
They catch unknown thrown values and emit a static internal-error message. They never print an
unknown exception's `message`, `stack`, `cause`, object inspection, or raw body.

Safe response normalization also applies to successful reads:

- Raw `failureReason` is never printed. A known exact reason maps to static allowlisted guidance;
  every other value maps to a static "provider reported a failure" message.
- Unknown union bodies are replaced with their sanitized member-name marker.
- Metadata outside the explicit safe response contract is omitted instead of passed through.

Malformed JSON and schema validation errors identify the option and a CLI-owned schema path. They do
not include JavaScript parser text, typecheck excerpts, raw values, or unknown keys copied from
untrusted input.

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
4. Sanitizes the response or modeled error through the same safe output contract.
5. Serializes the complete fixture bytes in memory.
6. Scans those bytes and the destination basename for registered high-entropy sentinels.
7. Only then creates a same-directory temporary file and atomically renames it to the destination.

No raw request body or service error message is stored. Error fixtures contain only an allowlisted
modeled code and fields needed to reproduce the safe classification. Existing non-Identity fixture
keys remain unchanged.

Redaction intentionally makes calls with different secret values collide. Each test fixture flow owns
an ordered collision manifest. For every operation/digest pair, it assigns a zero-based occurrence
and records the exact ordered fixture sequence. Replay must consume every manifest entry exactly
once, in order, and fails on missing, extra, reordered, or unconsumed calls. Writes for a colliding
operation/digest pair are serialized through a per-key queue so parallel tests cannot choose the same
occurrence.

Fixture factories construct real AWS SDK clients and intercept the instance's bound `send` method.
They do not return `{ send }` objects cast as clients. This preserves `instanceof` checks required by
generated paginators while keeping record/replay at the existing SDK send seam.

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
- Every secret acquisition and storage-mode combination is covered.
- Multiple stdin consumers are rejected.
- TTY stdin, non-regular files, invalid UTF-8, and over-limit byte and character counts are rejected.
- All sensitive paths are redacted.
- MANAGED-to-EXTERNAL and EXTERNAL-to-MANAGED updates fail before mutation for every secret slot.
- Payment update requirements distinguish managed and external slots.
- Every custom OAuth authentication-method transition follows the transition matrix.
- Every supported explicit clear is distinct from omission, and prohibited clears are rejected.
- Workload unchanged, replace, and clear intents are distinct.
- Semantic no-ops and opaque secret rotations are distinguished.
- Unknown vendors and union members expose only sanitized names on reads and fail on writes.

### Transport and Action Tests

- Every SDK operation selects the correct command.
- Region and endpoint options propagate.
- Page operations preserve `nextToken`.
- All-results operations consume generated paginators with real client instances.
- Same-token and cyclic pagination fail before results render.
- Prepared plans are frozen, canonical, and contain no secret bytes.
- Update preparation Gets once and commit Gets again.
- A changed review or requirement signature returns `ReprepareRequired` without reading secrets or
  mutating.
- An equivalent fresh rebase resolves secrets only at commit and makes one mutation call.
- Actions do not fetch unnecessarily for direct mutations.
- Tag actions resolve and use the resource ARN.
- Syntactic and semantic no-ops make no Update call.
- Error mapping does not expose exception messages, bodies, stacks, causes, or raw failure reasons.

### Commander Tests

- Every verb parses required and optional flags.
- Every executed leaf emits exactly one JSON document, including empty mutation responses.
- Missing and conflicting inputs fail with actionable messages.
- Literal secret values warn without echoing the value.
- Every slot prefix supports literal, stdin, env, file, and external reference forms.
- `--json` disables hidden prompts and never implies Set CMK consent.
- Advanced JSON accepts valid SDK-native structures and rejects invalid structures.
- Malformed JSON output contains no parser message or input excerpt.
- Omitted update fields remain absent from intent.
- List defaults to one page; `--all` traverses all pages and conflicts with `--next-token`.
- `--max-results` enforces the resource-specific ranges.
- Tag selectors enforce exactly one of `--name` and `--resource-arn`.
- Bare-leaf routing ignores parser defaults and honors CLI-sourced default-valued options.
- Explicit Delete executes without `--yes`.
- Noninteractive `token-vault set-cmk` requires `--yes`.

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
- Hidden prompts occur after review and fresh rebase.
- A changed rebase returns to review before any secret prompt.
- OAuth callback URLs are displayed on create, get, and update result screens.
- Cancellation makes no mutation call.
- Delete and CMK changes require confirmation.
- Empty, loading, failure, and success states render correctly.

### SDK Drift Tests

- Runtime SDK enum values equal catalog keys.
- Runtime OAuth and payment union member names equal reviewed expectations.
- Every Identity operation used by fixtures has an explicit public request schema.
- SDK-sensitive paths are either automatically redacted or covered by explicit secret slots.
- Compile-time exhaustive records fail on a new enum value.

### Golden Tests

Record/replay tests exercise the real root router, middleware, action, transport, and renderer seams.
Sensitive write fixtures use schema-redacted keys. Read and mutation output fixtures contain only
service-safe response data.

Golden coverage includes repeated redacted-key collisions, exact manifest consumption, concurrent
collision serialization, pre-write sentinel rejection, atomic replacement, modeled safe errors,
unknown member sanitization, and generated paginator execution.

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

Live tests run only with explicit recording/integration configuration and:

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
- Custom OAuth create/get/update/delete.
- Microsoft tenant-specific update preservation.
- API-key MANAGED create/rotate/delete.
- API-key EXTERNAL create/update/delete with a temporary Secrets Manager secret.
- Workload identity return-URL create/update/clear/delete.
- Coinbase and Stripe/Privy payment create/get/update/delete behavior in the preview-capable deploy
  account and region; an unsupported preview response fails the run instead of silently skipping it.
- Tag, list-tags, and untag on temporary resources.
- Page-token traversal with a deliberately small `maxResults`.
- Default token-vault read.
- Confirmed rejection of MANAGED/EXTERNAL source switching without deleting the original resource.

Every live test:

- Uses a cryptographically random, run-unique `acci-<run-id>-` prefix.
- Records exact created names, ARNs, resource families, account, and region in an in-memory ownership
  ledger.
- Tags temporary Secrets Manager resources with the same run ID.
- Deletes only ledger-owned resources or resources that exactly match the current run prefix and
  expected account, region, and resource family.
- Refuses broad cleanup by the shared `acci-` prefix.
- Cleans up in `finally` with bounded retries for eventual consistency.
- Performs final paginated sweeps across all four Identity resource families and Secrets Manager.
- Fails with the exact remaining names and ARNs if current-run resources or temporary secrets remain.
- Scans captured output for sentinel secrets.

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
- `@aws-sdk/config` for supported runtime schema validation.
- `@smithy/core` for supported normalized schema traversal.
- Test-only `@aws-sdk/client-sts` for live account verification.
- Test-only `@aws-sdk/client-secrets-manager` for run-owned EXTERNAL fixtures and cleanup.

Dependency versions remain aligned with the pinned AWS SDK generation. SHA-256 uses the platform
crypto implementation and adds no package.

## Reproducible Review Evidence

Design, implementation-plan, and implementation reviews live under
`docs/superpowers/reviews/identity-cli/`. Each review records:

- The exact prompt.
- Reviewer model and session identifier.
- Reviewed commit SHA and SDK version.
- Complete findings.
- One adjudication per finding with accepted/rejected status and repository or service evidence.
- The verification rerun proving no unresolved findings remain.

The directory contains an index plus separate prompt, report, and adjudication files for architecture,
factual/API, security, and implementation-readiness reviews. A review is not complete when its report
exists; every finding must have a recorded disposition and accepted findings must be reflected in the
reviewed commit.

## Acceptance Criteria

- Every command in the command surface is mounted and tested.
- Every command classified as interactive has an Ink route and complete workflow.
- All 25 pinned OAuth vendors are supported.
- OAuth family and payment adapter contracts are exhaustive.
- Advanced SDK-native JSON is available without a generic deep merge.
- Omitted updates preserve every readable field required by the replacement-style service APIs.
- Changed update state triggers review again before secret resolution or mutation.
- OAuth updates clearly collect a required MANAGED client secret again and preserve a reconstructable
  EXTERNAL reference.
- Payment updates clearly collect every required managed secret again.
- Unknown future providers render safely on reads and fail safely on writes.
- Pagination never silently truncates, loops, or emits partial all-results output.
- Complete tag lifecycle works.
- No secret reaches output, error artifacts, fixture content, or fixture identity.
- Unit, router, action, screen, golden, and build checks pass.
- `bunx tsc --noEmit` matches the exact checked-in pre-implementation diagnostic allowlist and has
  zero diagnostics in every touched file.
- Live integration coverage passes against the deploy account and leaves no resources.
- Design, planning, and implementation receive independent `gpt5.6-sol` architecture, factual,
  security, and implementation-readiness reviews with no unresolved findings and reproducible
  evidence checked into the repository.
