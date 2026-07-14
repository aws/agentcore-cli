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
set. `--next-token` accepts only the exact versioned continuation token emitted by a preceding Identity
List response. The parser decodes that token before action invocation; a wrong version, malformed or
noncanonical payload, empty decoded token, or over-limit payload is a closed invalid-value error and
sends no AWS request. Raw SDK continuation tokens are never accepted as Commander input or rendered
directly.

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

The recursive root compiler applies one execution policy to every newly constructed root, branch,
default-handler host, and leaf in the complete AgentCore command tree before attaching it with
`addCommand`; this requirement is not limited to Identity descendants. Commander does not inherit
`configureOutput` or `exitOverride` through `addCommand`. Every compiled command therefore receives
injected stdout/stderr writers,
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
before settlement, or callback failure returns a closed `outputUnavailable` result. Cancellation is
effective only before the sink calls `write()`. Once the stream accepts a chunk, the supervisor owns
that callback and any required `drain`; later cancellation aborts the surrounding action but cannot
settle the write early. The supervisor retains its listeners until every accepted write has reached
callback-plus-drain success or terminal error/close, then issues a quiescence receipt before routing
finishes. The sink does not retry or split a JSON document. Static stderr writes use a serialized
awaited text sink under the same supervisor and are best-effort when reporting an output failure.

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

Ink retains its required `NodeJS.WriteStream` interface rather than pretending frame writes are one
JSON chunk. It receives supervisor-owned typed stream facades that delegate the pinned stream surface,
forward `isTTY`, dimensions, and `resize`, and serialize all write overloads through a state machine:

```text
open --underlying error/close/callback failure--> failed --all accepted callbacks settled--> quiesced
  \----------------normal Ink teardown-----------------------------------------------> quiesced
```

Every accepted callback is settled exactly once. While open, callback success and backpressure retain
their Node ordering. On the first terminal failure, the facade becomes observably unwritable, forwards
no later bytes, settles the active and queued callbacks with one CLI-owned synthetic error, and invokes
the presentation controller exactly once. A post-failure `write("", callback)` is still accepted as a
settlement write and invokes its callback asynchronously, so Ink 7.1's already-running unmount cannot hang after
capturing an earlier writable state. The supervisor consumes facade errors; raw stream errors never
reach Ink or application state. It keeps underlying and facade listeners until Ink's `waitUntilExit()`,
the active action, all accepted write callbacks, and the supervisor quiescence receipt settle.

Before invoking an authorized mutation, the root controller registers that exact `PreparedMutation` and
receives one opaque `MutationPresentationActionLease`. The lease is the presentation's only commit
entrypoint and links any later activation and settlement to that attempt before the first asynchronous
step. A duplicate or invalid registration returns a closed failure and invokes no commit. The controller
synchronously latches output unavailable, aborts the exact registered action lease, and requests
unmount exactly once. It classifies guidance only after that same lease either reports no activation or
its exact execution settles; it never searches for a current or `latest` lane scope. No presenter
receives or mutates certainty state. No new frame is forwarded after failure. Ordinary frames, final
frames, synchronized-output markers, alternate-screen teardown, and Ink's empty-write frame/exit
settlements all use this same state machine.

Successful JSON is completely serialized before the single awaited stdout write. The process entry
point assigns `process.exitCode` only after routing, awaited writes, and Ink teardown settle; it never
calls `process.exit`. The process composition root creates one invocation output supervisor and one
exclusive mutation lane before routing. The invocation supervisor remains alive until Commander
completion or the persistent Ink root exits. Independently, the mutation lane owns a fresh nominal
execution scope and presentation lease for each authorized commit, plus a read-only live certainty view
with exact monotonic states
`none -> outcomeUnknown -> committed`. Its writer is private to action and transport closures.

The per-mutation lifecycle is explicit and does not use whole-application exit as its normal receipt:

```text
idle --activate(workflow, capability)--> active(executionId)
active --settle(action outcome)--------> settled(executionId)
settled --begin exact presentation----> presenting(executionId)
presenting --matching receipt---------> idle
idle/active/settled/presenting --busy-> same state; no new execution
```

`activate` has the closed synchronous result `activated | busy`; it never throws or invokes caller code.
Commit verifies that the supplied capability/context pair matches and is presently claimable, then
activates before changing either ownership state. `busy` is a distinct `CommitAttempt` result, leaves
both objects unchanged and retryable, and performs no secret I/O, AWS call, state update, or output
write. It is never queued or retried automatically. Once activation succeeds, the coordinator claims
the still-matching pair in the same synchronous turn. Immediately before invoking the binding's
`mutate()` method, the action marks its active scope `outcomeUnknown`; no output or synchronous adapter
failure can occur in that interval while the view still says `none`. Transport may advance that same
scope to `committed` only after the operation's exact modeled success status and a bounded body with
normal completion. An alternate 2xx never establishes commit certainty.

`settle()` is synchronous, nonthrowing, and idempotent. Its first call changes `active` to `settled` and
returns one opaque execution-correlated `SettledMutationExecution`; later calls return that same token
and do not repeat work. Presentation begins with that exact token through `beginCommander` or
`beginInk` before serialization or before installing the corresponding Ink outcome/review state. The
lane rejects a foreign, stale, already-presenting, or same-workflow/different-execution token without
changing either execution. A supervisor/facade-minted receipt carries the exact presenting object
identity; `finish(receipt)` retires only its matching first receipt, and a stale, duplicate,
foreign-supervisor, or wrong-presentation receipt is ignored.

For Commander, `CommanderMutationOutputPort` accepts the presenting token before serialization and
returns a receipt only after complete JSON serialization, the one accepted write's callback, and any
required drain, or returns the same presentation's typed unavailable receipt when serialization or
delivery cannot complete. The scope retires before the handler returns. For normal Ink operation,
`openFrame` creates an execution-bound epoch before state installation. The installed state includes a
root-owned commit marker that can mint `InkFrameCommitEvidence` only for that exact React generation.
`flushFrame` requires the matching commit evidence, awaits pinned Ink's `waitUntilRenderFlush()`,
atomically closes the finite epoch, captures the typed stream facade's accepted-write high-water mark,
and awaits every callback and required drain through that mark. Only then can it mint
`inkFrame/flushed`; later animation or navigation writes belong to another epoch and cannot delay
retirement. An Ink unmount, exit, or output failure cannot mint frame evidence. It uses
`waitUntilExitFallback` and can mint only `inkExit/unavailable` after the exact action, unmount,
`waitUntilExit()`, all accepted callbacks, and supervisor quiescence settle. `waitUntilExit()` is not a
normal per-mutation retirement condition.

A `reprepareRequired`, cancellation, no-change, or pre-mutation failure settles and retires its scope
after its correlated review or terminal frame flushes and before Ink accepts another mutation. A second
confirmation registers a new action lease and activates a new scope while `waitUntilExit()` remains
pending; certainty from the prior attempt cannot leak into that sequential TUI operation. Commander
likewise retires before returning. `MutationPresentationActionLease.commit()` accepts only the matching
secret context and normal call options, never a caller-provided latch, execution scope, presentation
token, epoch, evidence, or receipt.

Any later JSON serialization, stdout write/drain, Ink frame, render, or presentation-state failure asks
the supervisor to classify the exactly correlated execution. If failure occurs while its action is
active, the controller aborts immediately but waits for that exact action to settle before reading the
final monotonic certainty. `outcomeUnknown` states that the mutation may have applied and requires a
fresh Get before another mutation. `committed` selects the same static
`committedOutputUnavailable` guidance used for an unusable modeled-success result: the mutation
committed, its output is unavailable, and the user must perform a fresh Get before considering another
mutation. Only `none` uses generic output-unavailable guidance. The action-boundary backstop maps an
escaped or contradictory result to `committedOutputUnavailable` only when the authoritative view is
`committed`; every other scope already marked `outcomeUnknown` becomes `mutationOutcomeUnknown`. An
`EPIPE` or closed stderr may prevent guidance from being delivered, but remains contained and produces
no stack or automatic retry. A failure with no correlated mutation uses generic output-unavailable
guidance. Ink never replaces the current presentation with a `busy` result, so a rejected second pair
cannot borrow the first execution's certainty. An impossible Commander `busy` is a static internal
failure; its invocation-owned prepared pair is disposed before return.

### Normalized V1 Output

Raw SDK command outputs never reach Commander renderers or Ink components. Actions convert them into
a workflow-branded JSON-only `SafeIdentityDocument` through centralized, operation-specific V1
allowlist schemas:

```text
SDK CommandOutput
  -> action-private raw response
  -> internal normalized state
  -> SafeIdentityDocument
  -> Commander JSON or Ink view model
```

The normalization module privately owns the brand and its assertion-free constructors:

```ts
declare const SAFE_IDENTITY_DOCUMENT: unique symbol;

type IdentityJsonScalar = null | boolean | number | string;

type DeepReadonly<T> = T extends IdentityJsonScalar
  ? T
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : never;

interface SafeIdentityDocument<W extends IdentityWorkflowId> extends WorkflowBranded<W> {
  readonly value: DeepReadonly<IdentityWorkflowDtoMap[W["key"]]>;
  readonly [SAFE_IDENTITY_DOCUMENT]: W;
}
```

`IdentityWorkflowDtoMap` is JSON-only: it contains no `Date`, function, symbol, collection, typed-array,
class instance, or `undefined` value. `DeepReadonly` therefore recursively preserves scalar values,
tuple positions, array order, object keys, and optionality while making every reachable container
readonly. The sanitized configuration and patch values that reuse this helper are constrained to the
same JSON-only algebra before construction; the helper is not a serializer or a coercion for arbitrary
class instances.

The internal `value` field is not a wire wrapper: the Commander serializer emits that frozen DTO as the
flat document defined below, and Ink projects the same DTO into view state. Only a workflow-specific
normalizer may construct this interface, after exact allowlist validation, terminal-safe encoding,
prototype-safe map construction, and deep freezing. The constructor installs both private brands in an
object literal owned by the symbol-defining module; adapters, actions, handlers, and presentations use
no assertion or brand value. A document for one workflow is not assignable to another workflow even
when their DTO structures are equal.

The contract is flat and preserves SDK field names; there is no `data` wrapper. Every operation omits
`$metadata`, undefined optional members, and unallowlisted fields recursively. A missing V1-required
member fails normalization with a static compatibility error rather than emitting a partial document.
Dates become ISO-8601 strings. Empty arrays and maps are preserved. Every ordinary dynamic string
crosses the terminal-safe encoder. A nonempty List `nextToken` instead crosses the separate reversible
production continuation-token codec, whose output is already terminal-safe ASCII.
`--all` concatenates the normal collection and omits `nextToken`. A semantic no-op Update projects the
fresh current state through that workflow's Update normalizer, not its Get normalizer; OAuth no-op
output therefore omits Get-only `failureReason`, and payment no-op output omits Get-only `tags`.
Delete, Tag, and Untag normalize to `{}`; List Tags always normalizes an absent map to
`{ "tags": {} }`.

For a mutation that resolves managed values, the claimed secret lease privately retains one opaque
complete-value matcher until response normalization, fixture encoding, and presentation classification
finish. The matcher is not part of an action port, intent, plan, review, DTO, fixture, or public result.
Immediately before a secret-bearing mutation dispatch, the operation-specific binding derives the
equivalent fixture-side matcher from the exact schema-registered sensitive leaves already present in
its private SDK input. This derivation and matcher remain inside the binding/recorder closure; no public
port accepts or returns a matcher.
The inner response classifier applies that matcher before Smithy coercion or logical translation to
every schema-registered response-derived scalar and dynamic key in the bounded raw response. The outer
pipeline repeats the check over the deserialized SDK value, capture's reconstructed SDK value, the
fixture algebra, safe error metadata, and final V1 value before terminal encoding or serialization.
Substring matching uses the complete original managed value against all of these exact textual
representations:

- Decoded raw and emitted strings, dynamic map keys, unknown-union member names, validated request IDs,
  physical and logical page tokens, and the encoded production continuation token.
- A raw JSON number's validated source lexeme and its canonical finite-number spelling; canonical
  `-0` is `0`.
- `true`, `false`, and `null` for response-derived boolean and null scalars.
- A valid deserialized `Date`'s pre-logical-clock `Date.prototype.toISOString()` result, in addition to
  its raw timestamp representation.
- `httpStatus` as unsigned base-10 ASCII without leading zeroes and every other emitted dynamic numeric
  error field in canonical finite-number form.

Static DTO property names, fixture-envelope keys/type tags, operation names, and allowlisted literal
service codes are schema constants rather than response-derived scalars and are not inspected. Invalid
dates, non-finite numbers, unsupported scalar types, or any matcher hit fails closed before a fixture
call is finalized or any output is rendered. A mutation with exact-status normal-EOF commit evidence
returns `committedOutputUnavailable`; every other post-authorization mutation response retains
`mutationOutcomeUnknown`. The matcher and all resolved values are released with the winning secret
lease.

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
C = EncodedIdentityContinuationTokenV1
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
| API-key List               | `credentialProviders:[{ name:S, credentialProviderArn:S, createdTime:D, lastUpdatedTime:D }]`, `nextToken?:C`                                                                                    |
| OAuth Create               | `clientSecretArn?:Secret`, `clientSecretJsonKey?:S`, `clientSecretSource?:SourceOut`, `name:S`, `credentialProviderArn:S`, `callbackUrl?:S`, `oauth2ProviderConfigOutput?:OAuthOut`, `status?:S` |
| OAuth Get                  | OAuth Create fields plus `credentialProviderVendor:S`, required `oauth2ProviderConfigOutput:OAuthOut`, `createdTime:D`, `lastUpdatedTime:D`, `failureReason?:SafeFailureGuidance`                |
| OAuth Update               | OAuth Get fields except `failureReason`                                                                                                                                                          |
| OAuth List                 | `credentialProviders:[{ name:S, credentialProviderVendor:S, credentialProviderArn:S, createdTime:D, lastUpdatedTime:D }]`, `nextToken?:C`                                                        |
| Payment Create             | `name:S`, `credentialProviderVendor:S`, `credentialProviderArn:S`, `providerConfigurationOutput:PaymentOut`                                                                                      |
| Payment Get                | Payment Create fields plus `createdTime:D`, `lastUpdatedTime:D`, `tags?:Record<K,S>`                                                                                                             |
| Payment Update             | Payment Create fields plus `createdTime:D`, `lastUpdatedTime:D`; no `tags`                                                                                                                       |
| Payment List               | `credentialProviders:[{ name:S, credentialProviderVendor:S, credentialProviderArn:S, createdTime:D, lastUpdatedTime:D }]`, `nextToken?:C`                                                        |
| Workload Create            | `name:S`, `workloadIdentityArn:S`, `allowedResourceOauth2ReturnUrls?:S[]`                                                                                                                        |
| Workload Get / Update      | Workload Create fields plus `createdTime:D`, `lastUpdatedTime:D`                                                                                                                                 |
| Workload List              | `workloadIdentities:[{ name:S, workloadIdentityArn:S }]`, `nextToken?:C`                                                                                                                         |
| All four Deletes / Tagging | Delete, Tag, and Untag: `{}`; List Tags: `{ tags: Record<K,S> }`                                                                                                                                 |
| Token Vault Get / Set CMK  | `tokenVaultId:S`, `kmsConfiguration:{ keyType:S, kmsKeyArn?:S }`, `lastModifiedDate:D`                                                                                                           |

`C` is `identity-token-v1.` followed by unpadded canonical Base64URL of the raw SDK token's
big-endian UTF-16 code units. Encoding UTF-16 code units rather than UTF-8 preserves every JavaScript
string exactly, including unpaired surrogates. Empty SDK tokens remain terminal and are omitted.
Decoding rejects a wrong version, padding, a non-Base64URL character, odd decoded byte length, an empty
decoded value, more than `MAX_IDENTITY_CONTINUATION_TOKEN_CODE_UNITS`, more than
`MAX_ENCODED_IDENTITY_CONTINUATION_TOKEN_BYTES`, or any text whose re-encoding is not byte-identical.
The output normalizer can emit only a branded encoded token and `ListIntent` can contain only the
branded decoded token. Therefore copying one Commander page's `nextToken` unchanged into the next
command recovers the exact original SDK string without treating terminal rendering escapes as wire
bytes.

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
|            |--> operation-specific IdentityBindingFactory ports
|            `--> MutationExecutionSupervisorPort
|-- correlated mutation output --> MutationPresentationSupervisorPort
`-- CommitSecretContextFactory port --> SecretSourceReader port

SDK adapter ---------------- supplies implementations to narrow factory constructors
secret-context adapter ------ implements CommitSecretContextFactory
process/filesystem adapter -- implements SecretSourceReader and awaited output
invocation supervisor ------- implements execution/presentation supervisor ports and output certainty
first-party native addon ---- supplies typed OS file, protected-root, lock, and Linux proof primitives
composition root ------------ injects adapters into actions and presentations
```

The domain does not depend on transport. Actions depend on the pure domain,
one operation-specific `IdentityBindingFactory`, and the opaque secret-context capability and
module-private coordinator. Mutating actions also depend on the consumer-owned
`MutationExecutionSupervisorPort`.
Commander and Ink depend on actions and `CommitSecretContextFactory`; the context factory depends on
`SecretSourceReader`. Their root controller also depends on the opaque
`MutationPresentationSupervisorPort`; leaf components do not. Adapters depend inward on these
consumer-owned interfaces. Neither presentation
depends on SDK request unions. The first-party native addon is private to process/filesystem adapters;
no domain, action, or presentation type exposes a native handle.

### Ports And Adapters

`src/core/identity.tsx` is a thin raw-SDK adapter that follows the repository's existing core-client
file convention. It creates operation-scoped bindings behind narrow consumer-owned facets that:

- Send typed SDK commands.
- Install the common exact-operation status/body classifier on every read and mutation before Smithy's
  permissive success handling.
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
- Wrap the mutation request handler to record whether handler invocation began and whether a complete
  HTTP response was observed. The approved action scope is already `outcomeUnknown` before `mutate()`
  enters the adapter, so this evidence can advance certainty to `committed` but cannot downgrade it.
  Validation and guard failures before mutation authorization remain distinct from every adapter or
  transport failure after authorization.
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

The narrow `IdentityBindingFactory` instances and their nominal constructors are consumer-owned in the
Identity handler boundary. Production and test adapters supply unbranded implementation closures to
those constructors. Normal, live, capture, and stale-reaper composition roots construct
operation-specific branded factories with their different endpoint policies; each action receives only
its exact operation/facet factory and cannot select another operation, read mode, or policy.

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

declare const IDENTITY_CONTINUATION_TOKEN: unique symbol;
declare const ENCODED_IDENTITY_CONTINUATION_TOKEN: unique symbol;

const MAX_IDENTITY_CONTINUATION_TOKEN_CODE_UNITS = 1_048_576 as const;
const MAX_ENCODED_IDENTITY_CONTINUATION_TOKEN_BYTES = 2_796_221 as const;

type IdentityContinuationToken = string & {
  readonly [IDENTITY_CONTINUATION_TOKEN]: never;
};

type EncodedIdentityContinuationTokenV1 = `identity-token-v1.${string}` & {
  readonly [ENCODED_IDENTITY_CONTINUATION_TOKEN]: never;
};

type ContinuationTokenDecodeOutcome =
  | { kind: "decoded"; token: IdentityContinuationToken }
  | { kind: "validationFailed"; error: UsageIdentityError };

interface ProductionContinuationTokenCodec {
  encode(token: IdentityContinuationToken): EncodedIdentityContinuationTokenV1;
  decode(text: string): ContinuationTokenDecodeOutcome;
}

type IdentityResourceFamily = "apiKey" | "oauth2" | "payment" | "workload" | "tokenVault";
type IdentitySelectorMode = "none" | "createName" | "name" | "resourceArn" | "tokenVaultId";
type IdentityBindingFacet =
  | "read"
  | "list"
  | "resolvedRead"
  | "directMutation"
  | "currentStateMutation"
  | "compatibilityGuardedUpdate";
type IdentityWorkflowPolicy = "query" | "direct" | "continuityGuarded" | "replacement";
type IdentityCrudFamily = Exclude<IdentityResourceFamily, "tokenVault">;
type IdentityCrudVerb = "create" | "get" | "list" | "update" | "delete";
type IdentityTagVerb = "tag" | "untag" | "listTags";
type IdentityTagSelector = "name" | "resourceArn";

type IdentityWorkflowName =
  | `${IdentityCrudFamily}.${IdentityCrudVerb}`
  | `${IdentityCrudFamily}.${IdentityTagVerb}.${IdentityTagSelector}`
  | "tokenVault.get"
  | "tokenVault.setCmk";

type IdentityCrudOperations = {
  apiKey: {
    create: "CreateApiKeyCredentialProvider";
    get: "GetApiKeyCredentialProvider";
    list: "ListApiKeyCredentialProviders";
    update: "UpdateApiKeyCredentialProvider";
    delete: "DeleteApiKeyCredentialProvider";
    updateFacet: "currentStateMutation";
  };
  oauth2: {
    create: "CreateOauth2CredentialProvider";
    get: "GetOauth2CredentialProvider";
    list: "ListOauth2CredentialProviders";
    update: "UpdateOauth2CredentialProvider";
    delete: "DeleteOauth2CredentialProvider";
    updateFacet: "compatibilityGuardedUpdate";
  };
  payment: {
    create: "CreatePaymentCredentialProvider";
    get: "GetPaymentCredentialProvider";
    list: "ListPaymentCredentialProviders";
    update: "UpdatePaymentCredentialProvider";
    delete: "DeletePaymentCredentialProvider";
    updateFacet: "compatibilityGuardedUpdate";
  };
  workload: {
    create: "CreateWorkloadIdentity";
    get: "GetWorkloadIdentity";
    list: "ListWorkloadIdentities";
    update: "UpdateWorkloadIdentity";
    delete: "DeleteWorkloadIdentity";
    updateFacet: "currentStateMutation";
  };
};

type WorkflowMetadata<Family, Selector, Primary, AuxiliaryGet, Facet, Policy> = Readonly<{
  family: Family;
  selector: Selector;
  primaryOperation: Primary;
  auxiliaryGet: AuxiliaryGet;
  facet: Facet;
  policy: Policy;
}>;

type IdentityWorkflowCompatibility<K extends IdentityWorkflowName> =
  K extends `${infer F extends IdentityCrudFamily}.create`
    ? WorkflowMetadata<
        F,
        "createName",
        IdentityCrudOperations[F]["create"],
        null,
        "directMutation",
        "direct"
      >
    : K extends `${infer F extends IdentityCrudFamily}.get`
      ? WorkflowMetadata<F, "name", IdentityCrudOperations[F]["get"], null, "read", "query">
      : K extends `${infer F extends IdentityCrudFamily}.list`
        ? WorkflowMetadata<F, "none", IdentityCrudOperations[F]["list"], null, "list", "query">
        : K extends `${infer F extends IdentityCrudFamily}.update`
          ? WorkflowMetadata<
              F,
              "name",
              IdentityCrudOperations[F]["update"],
              IdentityCrudOperations[F]["get"],
              IdentityCrudOperations[F]["updateFacet"],
              "replacement"
            >
          : K extends `${infer F extends IdentityCrudFamily}.delete`
            ? WorkflowMetadata<
                F,
                "name",
                IdentityCrudOperations[F]["delete"],
                IdentityCrudOperations[F]["get"],
                "currentStateMutation",
                "continuityGuarded"
              >
            : K extends `${infer F extends IdentityCrudFamily}.tag.name`
              ? WorkflowMetadata<
                  F,
                  "name",
                  "TagResource",
                  IdentityCrudOperations[F]["get"],
                  "currentStateMutation",
                  "continuityGuarded"
                >
              : K extends `${infer F extends IdentityCrudFamily}.tag.resourceArn`
                ? WorkflowMetadata<
                    F,
                    "resourceArn",
                    "TagResource",
                    null,
                    "directMutation",
                    "direct"
                  >
                : K extends `${infer F extends IdentityCrudFamily}.untag.name`
                  ? WorkflowMetadata<
                      F,
                      "name",
                      "UntagResource",
                      IdentityCrudOperations[F]["get"],
                      "currentStateMutation",
                      "continuityGuarded"
                    >
                  : K extends `${infer F extends IdentityCrudFamily}.untag.resourceArn`
                    ? WorkflowMetadata<
                        F,
                        "resourceArn",
                        "UntagResource",
                        null,
                        "directMutation",
                        "direct"
                      >
                    : K extends `${infer F extends IdentityCrudFamily}.listTags.name`
                      ? WorkflowMetadata<
                          F,
                          "name",
                          "ListTagsForResource",
                          IdentityCrudOperations[F]["get"],
                          "resolvedRead",
                          "query"
                        >
                      : K extends `${infer F extends IdentityCrudFamily}.listTags.resourceArn`
                        ? WorkflowMetadata<
                            F,
                            "resourceArn",
                            "ListTagsForResource",
                            null,
                            "read",
                            "query"
                          >
                        : K extends "tokenVault.get"
                          ? WorkflowMetadata<
                              "tokenVault",
                              "tokenVaultId",
                              "GetTokenVault",
                              null,
                              "read",
                              "query"
                            >
                          : K extends "tokenVault.setCmk"
                            ? WorkflowMetadata<
                                "tokenVault",
                                "tokenVaultId",
                                "SetTokenVaultCMK",
                                "GetTokenVault",
                                "currentStateMutation",
                                "replacement"
                              >
                            : never;

type IdentityWorkflowPayload<Intent, Dto> = Readonly<{ intent: Intent; dto: Dto }>;

interface IdentityWorkflowPayloads {
  // The exact 46 intent/DTO entries are specified under Input Model.
}

type IdentityWorkflowDefinition<K extends IdentityWorkflowName> = Readonly<
  IdentityWorkflowCompatibility<K> & IdentityWorkflowPayloads[K]
>;

type IdentityWorkflowDefinitions = {
  readonly [K in IdentityWorkflowName]: IdentityWorkflowDefinition<K>;
};

type IdentityWorkflowCompatibilityMap = {
  readonly [K in IdentityWorkflowName]: IdentityWorkflowCompatibility<K>;
};

declare const IDENTITY_WORKFLOW_ID: unique symbol;
declare const IDENTITY_WORKFLOW_OWNER: unique symbol;

type IdentityWorkflowId<K extends IdentityWorkflowName = IdentityWorkflowName> =
  K extends IdentityWorkflowName
    ? Readonly<{
        key: K;
        [IDENTITY_WORKFLOW_ID]: (key: K) => K;
      }>
    : never;

interface WorkflowBranded<W extends IdentityWorkflowId> {
  readonly workflowId: W;
  readonly [IDENTITY_WORKFLOW_OWNER]: (workflow: W) => W;
}

type WorkflowDefinitionOf<W extends IdentityWorkflowId> = IdentityWorkflowDefinitions[W["key"]];
type WorkflowIntentOf<W extends IdentityWorkflowId> = WorkflowDefinitionOf<W>["intent"];
type WorkflowDtoOf<W extends IdentityWorkflowId> = WorkflowDefinitionOf<W>["dto"];
type WorkflowPolicyOf<W extends IdentityWorkflowId> = WorkflowDefinitionOf<W>["policy"];
type WorkflowFacetOf<W extends IdentityWorkflowId> = WorkflowDefinitionOf<W>["facet"];
type PrimaryOperationOf<W extends IdentityWorkflowId> = WorkflowDefinitionOf<W>["primaryOperation"];
type AuxiliaryGetOf<W extends IdentityWorkflowId> = WorkflowDefinitionOf<W>["auxiliaryGet"];

type WorkflowForFacet<F extends IdentityBindingFacet> = {
  [K in IdentityWorkflowName]: IdentityWorkflowDefinitions[K]["facet"] extends F
    ? IdentityWorkflowId<K>
    : never;
}[IdentityWorkflowName];

type QueryWorkflowId = {
  [K in IdentityWorkflowName]: IdentityWorkflowDefinitions[K]["policy"] extends "query"
    ? IdentityWorkflowId<K>
    : never;
}[IdentityWorkflowName];

type MutationWorkflowId = {
  [K in IdentityWorkflowName]: IdentityWorkflowDefinitions[K]["policy"] extends "query"
    ? never
    : IdentityWorkflowId<K>;
}[IdentityWorkflowName];
type RepreparableWorkflowId = {
  [K in IdentityWorkflowName]: IdentityWorkflowDefinitions[K]["policy"] extends
    | "continuityGuarded"
    | "replacement"
    ? IdentityWorkflowId<K>
    : never;
}[IdentityWorkflowName];

type OperationInput<N extends IdentityOperationName> = N extends keyof IdentityReadOperations
  ? IdentityReadOperations[N]["input"]
  : N extends keyof IdentityMutationOperations
    ? IdentityMutationOperations[N]["input"]
    : never;

type OperationOutput<N extends IdentityOperationName> = N extends keyof IdentityReadOperations
  ? IdentityReadOperations[N]["output"]
  : N extends keyof IdentityMutationOperations
    ? IdentityMutationOperations[N]["output"]
    : never;

const MAX_IDENTITY_RESPONSE_BYTES = 1_048_576 as const;

type IdentityExpectedSuccessStatus = Readonly<{
  GetApiKeyCredentialProvider: 200;
  ListApiKeyCredentialProviders: 200;
  GetOauth2CredentialProvider: 200;
  ListOauth2CredentialProviders: 200;
  GetPaymentCredentialProvider: 200;
  ListPaymentCredentialProviders: 200;
  GetWorkloadIdentity: 200;
  ListWorkloadIdentities: 200;
  GetTokenVault: 200;
  ListTagsForResource: 200;
  CreateApiKeyCredentialProvider: 201;
  CreateOauth2CredentialProvider: 201;
  CreatePaymentCredentialProvider: 201;
  CreateWorkloadIdentity: 201;
  UpdateApiKeyCredentialProvider: 200;
  UpdateOauth2CredentialProvider: 200;
  UpdatePaymentCredentialProvider: 200;
  UpdateWorkloadIdentity: 200;
  SetTokenVaultCMK: 200;
  DeleteApiKeyCredentialProvider: 204;
  DeleteOauth2CredentialProvider: 204;
  DeletePaymentCredentialProvider: 204;
  DeleteWorkloadIdentity: 204;
  TagResource: 204;
  UntagResource: 204;
}>;

type IdentityExpectedMutationStatus = Pick<
  IdentityExpectedSuccessStatus,
  keyof IdentityMutationOperations
>;

const IDENTITY_EXPECTED_SUCCESS_STATUS = {
  // Exact entries matching IdentityExpectedSuccessStatus.
} as const satisfies IdentityExpectedSuccessStatus;

type MutationCertainty = "none" | "outcomeUnknown" | "committed";

declare const MUTATION_EXECUTION_SCOPE: unique symbol;
declare const MUTATION_PLAN_TOKEN: unique symbol;
declare const ACTIVE_MUTATION_EXECUTION: unique symbol;
declare const SETTLED_MUTATION_EXECUTION: unique symbol;
declare const PRESENTING_MUTATION_EXECUTION: unique symbol;
declare const MUTATION_PRESENTATION_RECEIPT: unique symbol;
declare const MUTATION_PRESENTATION_ACTION_LEASE: unique symbol;
declare const INK_FRAME_EPOCH: unique symbol;
declare const INK_FRAME_COMMIT_EVIDENCE: unique symbol;
declare const INK_FRAME_HIGH_WATER: unique symbol;

interface MutationCertaintyView<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly state: MutationCertainty;
}

interface MutationPlanToken<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly [MUTATION_PLAN_TOKEN]: never;
}

interface MutationExecutionScope<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly [MUTATION_EXECUTION_SCOPE]: never;
  readonly certainty: MutationCertaintyView<W>;
}

interface ActiveMutationExecution<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly [ACTIVE_MUTATION_EXECUTION]: never;
  readonly scope: MutationExecutionScope<W>;
  settle(): SettledMutationExecution<W>;
}

interface SettledMutationExecution<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly [SETTLED_MUTATION_EXECUTION]: never;
}

type MutationPresentationKind = "commander" | "ink";

interface PresentingMutationExecution<
  W extends MutationWorkflowId,
  K extends MutationPresentationKind,
> extends WorkflowBranded<W> {
  readonly kind: K;
  readonly [PRESENTING_MUTATION_EXECUTION]: (kind: K) => K;
}

interface MutationPresentationReceiptBase<
  W extends MutationWorkflowId,
  K extends MutationPresentationKind,
> extends WorkflowBranded<W> {
  readonly presentation: PresentingMutationExecution<W, K>;
  readonly [MUTATION_PRESENTATION_RECEIPT]: (
    presentation: PresentingMutationExecution<W, K>,
  ) => PresentingMutationExecution<W, K>;
}

interface CommanderPresentationReceipt<
  W extends MutationWorkflowId,
> extends MutationPresentationReceiptBase<W, "commander"> {
  readonly kind: "commander";
  readonly delivery: "flushed" | "unavailable";
}

interface InkFrameEpoch<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly presentation: PresentingMutationExecution<W, "ink">;
  readonly afterAcceptedWrite: number;
  readonly [INK_FRAME_EPOCH]: never;
}

interface InkFrameCommitEvidence<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly epoch: InkFrameEpoch<W>;
  readonly [INK_FRAME_COMMIT_EVIDENCE]: never;
}

interface InkFrameHighWaterEvidence<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly epoch: InkFrameEpoch<W>;
  readonly throughAcceptedWrite: number;
  readonly [INK_FRAME_HIGH_WATER]: never;
}

interface InkFramePresentationReceipt<
  W extends MutationWorkflowId,
> extends MutationPresentationReceiptBase<W, "ink"> {
  readonly kind: "inkFrame";
  readonly delivery: "flushed";
  readonly highWater: InkFrameHighWaterEvidence<W>;
}

interface InkExitPresentationReceipt<
  W extends MutationWorkflowId,
> extends MutationPresentationReceiptBase<W, "ink"> {
  readonly kind: "inkExit";
  readonly delivery: "unavailable";
}

type MutationPresentationReceipt<W extends MutationWorkflowId> =
  | CommanderPresentationReceipt<W>
  | InkFramePresentationReceipt<W>
  | InkExitPresentationReceipt<W>;

type MutationActivationOutcome<W extends MutationWorkflowId> =
  | { kind: "activated"; execution: ActiveMutationExecution<W> }
  | { kind: "busy" };

interface MutationExecutionSupervisorPort {
  activate<W extends MutationWorkflowId>(
    workflow: W,
    capability: MutationPlanToken<W>,
  ): MutationActivationOutcome<W>;
}

type MutationPresentationFailure =
  | { kind: "outputUnavailable" }
  | { kind: "mutationOutcomeUnknown" }
  | { kind: "committedOutputUnavailable" };

type MutationPresentationBeginOutcome<
  W extends MutationWorkflowId,
  K extends MutationPresentationKind,
> =
  | { kind: "begun"; presentation: PresentingMutationExecution<W, K> }
  | { kind: "invalid"; failure: MutationPresentationFailure };

type MutationPresentationFinishOutcome =
  | { kind: "retired" }
  | { kind: "retiredWithFailure"; failure: MutationPresentationFailure }
  | { kind: "ignored" };

interface MutationPresentationSupervisorPort {
  beginCommander<W extends MutationWorkflowId>(
    execution: SettledMutationExecution<W>,
  ): MutationPresentationBeginOutcome<W, "commander">;
  beginInk<W extends MutationWorkflowId>(
    execution: SettledMutationExecution<W>,
  ): MutationPresentationBeginOutcome<W, "ink">;
  finish<W extends MutationWorkflowId>(
    receipt: MutationPresentationReceipt<W>,
  ): MutationPresentationFinishOutcome;
}

interface MutationPresentationActionLease<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly [MUTATION_PRESENTATION_ACTION_LEASE]: never;
  commit(secrets: CommitSecretContext, options?: IdentityCallOptions): Promise<CommitAttempt<W>>;
  dispose(): void;
}

type MutationPresentationActionRegistration<W extends MutationWorkflowId> =
  | { kind: "registered"; lease: MutationPresentationActionLease<W> }
  | { kind: "invalid"; failure: MutationPresentationFailure };

interface MutationPresentationActionControllerPort {
  register<W extends MutationWorkflowId>(
    mutation: PreparedMutation<W>,
  ): MutationPresentationActionRegistration<W>;
}

interface CommanderMutationOutputPort {
  write<W extends MutationWorkflowId>(
    presentation: PresentingMutationExecution<W, "commander">,
    channel: "stdout" | "stderr",
    text: string,
    options?: IdentityCallOptions,
  ): Promise<CommanderPresentationReceipt<W>>;
  unavailable<W extends MutationWorkflowId>(
    presentation: PresentingMutationExecution<W, "commander">,
  ): CommanderPresentationReceipt<W> & { readonly delivery: "unavailable" };
}

type InkFrameFlushOutcome<W extends MutationWorkflowId> =
  | { kind: "flushed"; receipt: InkFramePresentationReceipt<W> }
  | { kind: "outputUnavailable" };

interface InkMutationOutputPort {
  openFrame<W extends MutationWorkflowId>(
    presentation: PresentingMutationExecution<W, "ink">,
  ): InkFrameEpoch<W>;
  flushFrame<W extends MutationWorkflowId>(
    epoch: InkFrameEpoch<W>,
    committed: Promise<InkFrameCommitEvidence<W>>,
    waitUntilRenderFlush: () => Promise<void>,
  ): Promise<InkFrameFlushOutcome<W>>;
  waitUntilExitFallback<W extends MutationWorkflowId>(
    presentation: PresentingMutationExecution<W, "ink">,
    waitUntilExit: () => Promise<unknown>,
  ): Promise<InkExitPresentationReceipt<W>>;
}

type ReadTransportFailure =
  | { kind: "notFound" }
  | { kind: "cancelled" }
  | { kind: "sdkCompatibilityRequired" }
  | { kind: "credentialRefreshRequired" }
  | { kind: "serviceFailed"; error: ServiceIdentityError }
  | { kind: "internalFailed"; error: InternalIdentityError };

type ReadTransportOutcome<Output> = { kind: "succeeded"; output: Output } | ReadTransportFailure;

type PaginationFailureReason =
  | "cycle"
  | "pageLimit"
  | "itemLimit"
  | "wireByteLimit"
  | "outputByteLimit";

declare const READ_PAGE_EVIDENCE: unique symbol;

interface ReadPageEvidence {
  readonly acceptedWireBytes: number;
  readonly [READ_PAGE_EVIDENCE]: never;
}

type ReadPageOutcome<Output> =
  | { kind: "page"; output: Output; evidence: ReadPageEvidence }
  | { kind: "done" }
  | { kind: "paginationFailed"; reason: PaginationFailureReason }
  | ReadTransportFailure;

interface IdentityReadPageCursor<Output> {
  next(): Promise<ReadPageOutcome<Output>>;
  dispose(): void;
}

type MutationTransportOutcome<Output> =
  | { kind: "succeeded"; output: Output }
  | { kind: "mutationOutcomeUnknown" }
  | { kind: "successfulResponseUnusable" };

interface IdentityBindingLifetime<W extends IdentityWorkflowId> extends WorkflowBranded<W> {
  readonly credentialExpiresAtEpochMs: number | undefined;
  dispose(): void;
}

declare const IDENTITY_READ_BINDING: unique symbol;
declare const IDENTITY_LIST_BINDING: unique symbol;
declare const IDENTITY_RESOLVED_READ_BINDING: unique symbol;
declare const IDENTITY_DIRECT_MUTATION_BINDING: unique symbol;
declare const IDENTITY_CURRENT_STATE_MUTATION_BINDING: unique symbol;
declare const IDENTITY_COMPATIBILITY_GUARDED_UPDATE_BINDING: unique symbol;

interface IdentityReadBinding<
  W extends WorkflowForFacet<"read">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_READ_BINDING]: true;
  read(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    options?: IdentityCallOptions,
  ): Promise<ReadTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
}

interface IdentityListBinding<
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

interface IdentityResolvedReadBinding<
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

interface IdentityDirectMutationBinding<
  W extends WorkflowForFacet<"directMutation">,
> extends IdentityBindingLifetime<W> {
  readonly [IDENTITY_DIRECT_MUTATION_BINDING]: true;
  mutate(
    input: Readonly<OperationInput<PrimaryOperationOf<W>>>,
    scope: MutationExecutionScope<W>,
    options?: IdentityCallOptions,
  ): Promise<MutationTransportOutcome<OperationOutput<PrimaryOperationOf<W>>>>;
}

interface IdentityCurrentStateMutationBinding<
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

interface IdentityCompatibilityGuardedUpdateBinding<
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

type BindingFor<W extends IdentityWorkflowId> =
  WorkflowFacetOf<W> extends "read"
    ? IdentityReadBinding<Extract<W, WorkflowForFacet<"read">>>
    : WorkflowFacetOf<W> extends "list"
      ? IdentityListBinding<Extract<W, WorkflowForFacet<"list">>>
      : WorkflowFacetOf<W> extends "resolvedRead"
        ? IdentityResolvedReadBinding<Extract<W, WorkflowForFacet<"resolvedRead">>>
        : WorkflowFacetOf<W> extends "directMutation"
          ? IdentityDirectMutationBinding<Extract<W, WorkflowForFacet<"directMutation">>>
          : WorkflowFacetOf<W> extends "currentStateMutation"
            ? IdentityCurrentStateMutationBinding<
                Extract<W, WorkflowForFacet<"currentStateMutation">>
              >
            : WorkflowFacetOf<W> extends "compatibilityGuardedUpdate"
              ? IdentityCompatibilityGuardedUpdateBinding<
                  Extract<W, WorkflowForFacet<"compatibilityGuardedUpdate">>
                >
              : never;

interface IdentityBindingFactory<W extends IdentityWorkflowId> extends WorkflowBranded<W> {
  create(options?: IdentityCallOptions): Promise<BindingCreationOutcome<W>>;
}

type BindingCreationOutcome<W extends IdentityWorkflowId> =
  | { kind: "created"; binding: BindingFor<W> }
  | { kind: "cancelled" }
  | { kind: "credentialRefreshRequired" }
  | { kind: "internalFailed"; error: InternalIdentityError };
```

`IdentityWorkflowDefinitions` and the private value catalog contain exactly 46 entries: 17 query and
29 mutation workflows. The four CRUD families each contribute Create, Get, List, Update, and Delete;
token vault contributes Get and Set CMK; and each of the four taggable families contributes distinct
name-selected and direct-ARN Tag, Untag, and List Tags workflows. There is no runtime wildcard
registration.

The CRUD catalog rows are:

| Suffix   | Selector     | Primary / auxiliary Get | Facet / policy                                    |
| -------- | ------------ | ----------------------- | ------------------------------------------------- |
| `create` | `createName` | family Create / none    | `directMutation` / `direct`                       |
| `get`    | `name`       | family Get / none       | `read` / `query`                                  |
| `list`   | `none`       | family List / none      | `list` / `query`                                  |
| `update` | `name`       | family Update / Get     | ordinary or compatibility-guarded / `replacement` |
| `delete` | `name`       | family Delete / Get     | `currentStateMutation` / `continuityGuarded`      |

OAuth and payment Update use `compatibilityGuardedUpdate`; API-key and workload Update use
`currentStateMutation`. Token-vault Get is `read/query`; Set CMK is
`currentStateMutation/replacement` with `GetTokenVault` as its auxiliary read.

For each taggable family and its exact Get operation, the catalog has:

| Suffix                 | Primary / auxiliary Get            | Facet / policy                               |
| ---------------------- | ---------------------------------- | -------------------------------------------- |
| `tag.name`             | `TagResource` / family Get         | `currentStateMutation` / `continuityGuarded` |
| `tag.resourceArn`      | `TagResource` / none               | `directMutation` / `direct`                  |
| `untag.name`           | `UntagResource` / family Get       | `currentStateMutation` / `continuityGuarded` |
| `untag.resourceArn`    | `UntagResource` / none             | `directMutation` / `direct`                  |
| `listTags.name`        | `ListTagsForResource` / family Get | `resolvedRead` / `query`                     |
| `listTags.resourceArn` | `ListTagsForResource` / none       | `read` / `query`                             |

The symbol-owning consumer boundary creates every `IdentityWorkflowId`, binding, factory, action,
review, prepared capability, replacement capability, and handler through workflow-specific
assertion-free constructors. The invariant function-valued brand prevents both narrowing and widening
assignments. The value catalog uses
`satisfies { [K in IdentityWorkflowName]: IdentityWorkflowId<K> }`, so missing or extra IDs fail
compilation. Every other fact, including primary operation, auxiliary Get, facet, policy, intent, and
DTO, is derived from the workflow; no constructor accepts an independently chosen generic for one of
those dimensions.

Every facet still has its own private nominal brand. The same boundary-owned wrapper pattern turns
adapter-private file locator values into `SecretFileLocator` shells. Context brands are constructed
beside their private coordinator. No required private brand crosses a module boundary without such a
construction path.

`dispose()` is synchronous and idempotent. Binding creation is total and never rejects. It maps caller
abort to `cancelled`, an initial credential snapshot inside the freshness window to
`credentialRefreshRequired`, and credential-provider, endpoint-resolution, client-construction,
handler-construction, native-resource, synchronous-throw, asynchronous-rejection, and every other
construction failure to the static `internalFailed`. A non-`created` result destroys every partial
client, handler, credential clone, and native resource before returning. If abort wins while a
constructor that cannot be cancelled later completes, the factory immediately destroys that late
resource and still returns `cancelled`; ownership never escapes through a rejected promise.

Every direct read call and every page-cursor `next()` is
total: the adapter catches synchronous and asynchronous SDK, middleware, stream, paginator, and
classification failures and returns one closed read outcome. A cursor emits zero or more `page`
outcomes followed by exactly one `done` or failure outcome; after that, `next()` repeats `done` and
performs no work. `pages()` constructs that cursor synchronously without invoking SDK or caller code;
all fallible work occurs behind total `next()`. The action owns and disposes the cursor in `try/finally`.
Cursor disposal is synchronous, nonthrowing, and idempotent; a later `next()` returns `done`.
Mutation adapters likewise catch every failure around the SDK call and return one
`MutationTransportOutcome`; an action-level catch remains as a conservative static-`internalFailed`
backstop. A binding exposes only numeric expiration metadata, its exact methods, and explicit disposal.
It never exposes credential values, a refresh function, an SDK operation selector, or the private broad
transport implementation.
Both mutation failure discriminants are payload-free. The binding adapter consumes and discards every
raw SDK, middleware, handler, stream, and classifier rejection inside its private closure; no `cause`,
message, stack, command input, response, or arbitrary object crosses the action port.

Each action constructor receives one `IdentityBindingFactory<W>` for its exact workflow. Ordinary Get
and direct-ARN List Tags use `IdentityReadBinding`; paginated List uses `IdentityListBinding`;
name-selected List Tags uses `IdentityResolvedReadBinding`; Creates and direct-ARN Tag/Untag use
`IdentityDirectMutationBinding`; API-key/workload Updates, Deletes, name-selected Tag/Untag, and Set
CMK use `IdentityCurrentStateMutationBinding`; and only OAuth/payment Updates use
`IdentityCompatibilityGuardedUpdateBinding`. The latter installs the raw-wire guard on
`readCompatibilityGuardedCurrent`; it has no `readCurrent` or tolerant `read` method. No other facet
has `readCompatibilityGuardedCurrent` or its private brand. A guarded or current-state mutation binding
is not assignable to a direct-mutation binding even when its public method signatures happen to match,
and factories for structurally similar workflows are not assignable even when they share operation,
facet, intent shape, and DTO. The SDK adapter may share a private transport utility internally, but no
broad binding is exported or injected.

The execution supervisor creates `MutationExecutionScope<W>` and exposes its view read-only. The
symbol-owning coordinator provides private mark functions only to the prepared action closure and the
binding facade; neither the raw adapter nor presentation code can construct a scope or obtain a writer.
The same coordinator alone constructs settled/presenting tokens, action leases, epochs, evidence, and
receipts. Registration, `beginCommander`, `beginInk`, and `finish` are synchronous, nonthrowing, and
invoke no caller code. Registration happens before the root invokes the lease's commit and binds all
later failure handling to that exact attempt. Each begin consumes exactly one valid settled token for
its presentation kind; an invalid token returns the certainty-derived closed failure without changing
another execution. `finish()` retires only a matching first receipt whose private presentation,
execution, supervisor, and facade identities agree; every stale, duplicate, foreign, or cross-kind
receipt returns `ignored`. A Commander or Ink-frame flushed receipt returns `retired`; an unavailable
Commander or Ink-exit receipt returns `retiredWithFailure` with guidance derived from that execution's
final certainty. Output and Ink adapters receive private receipt constructors only for observed
serialization, write, generation-commit, frame-flush, high-water, or exit completion. Application and
presentation components cannot mint any receipt or evidence.
The action marks `outcomeUnknown` synchronously before calling `mutate()`. From that point, any
synchronous rejection, handler rejection, incomplete response, unsupported body, overflow,
cancellation, non-success status, or alternate 2xx is `mutationOutcomeUnknown`. Validation, freshness,
and guarded reads that fail before this mark retain `none`.

Every Identity operation installs one common deserialize-step classifier middleware relative `after`
Smithy's `deserializerMiddleware`. Under the pinned resolver ordering, it receives the raw
`HttpResponse` first on the response path, enforces the operation's exact status and bounded completion,
then restores a fresh copied body for generated deserialization. An ordering contract test fails if a
Smithy upgrade changes that position. Compatibility-guarded OAuth/payment reads add their strict
`RawWireSchema` check inside this same common layer; ordinary reads remain additive-field tolerant after
the exact status/body gate.

One response-body normalizer protects every Identity response path, including ordinary reads,
mutations, compatibility guards, capture, and replay. It accepts only absent body, string,
`ArrayBuffer`, any `ArrayBufferView` including `Uint8Array`, `DataView`, typed arrays and Node `Buffer`,
Node `Readable` including HTTP/2 streams, or Web `ReadableStream`. `null`, `Blob`, async iterables that
are not one of those streams, and every other form are explicitly unsupported. Static bodies are
complete after exact byte-range copying and cap validation; strings are strict UTF-8 bytes and views
honor `byteOffset` and `byteLength`. Stream bodies are complete only at bounded normal EOF: Node
requires `end`, while `error`, `aborted`, or `close` before `end` is incomplete; Web requires a read
returning `{ done: true }`. Overflow, error, cancellation, or unsupported form destroys a Node stream
or cancels and releases a Web reader when one exists. `Content-Length` is never completion evidence.

Every path accepts at most `MAX_IDENTITY_RESPONSE_BYTES`; 1,048,576 bytes is accepted and the first
additional byte fails without retaining the overflow chunk. On acceptance the normalizer restores a
fresh copied `Uint8Array`, including zero bytes, before Smithy sees the body. This prevents Smithy's
unbounded collector from receiving an unclassified form and prevents later backing-store mutation.

The ordinary-read classifier enforces the operation registry before Smithy's permissive `< 300`
success rule can decide the result:

| Transport observation                                                                                                                                                       | Read outcome                                                                                        | Fixture disposition                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Exact expected `200`, bounded normal EOF, valid operation shape, successful map revival and SDK deserialization                                                             | `succeeded`                                                                                         | Stage a safe success; finalize only after the exact action/current-state normalizer accepts it |
| Informational status or alternate 2xx                                                                                                                                       | `sdkCompatibilityRequired`                                                                          | No stage or fixture                                                                            |
| Exact `200` with unsupported, incomplete, over-cap, malformed, structurally incomplete, or unrevivable body, or failed SDK deserialization/safe projection/V1 normalization | `sdkCompatibilityRequired`; destroy/cancel the body where applicable                                | Discard any stage; no fixture                                                                  |
| Complete bounded `300..599` allowlisted modeled not-found response                                                                                                          | `notFound`                                                                                          | Stage and finalize the allowlisted `modeledError` only after safe error mapping                |
| Other complete bounded `300..599` allowlisted modeled response                                                                                                              | `serviceFailed` with only allowlisted service code, status, and validated request ID                | Stage and finalize the allowlisted `modeledError` only after safe error mapping                |
| Complete bounded unmodeled `300..599` response                                                                                                                              | `serviceFailed/UnknownServiceError` with at most validated status/request-ID metadata; no body text | No stage or fixture                                                                            |
| Incomplete, unsupported, malformed, or over-cap `300..599` response                                                                                                         | `serviceFailed/UnknownServiceError` with at most validated status/request-ID metadata; no body text | No stage or fixture                                                                            |
| Retry-exhausted network/transport failure with no complete response                                                                                                         | `serviceFailed/UnknownServiceError` with no arbitrary transport text                                | No stage or fixture                                                                            |
| Caller cancellation before a successful normal EOF                                                                                                                          | `cancelled`                                                                                         | Discard any stage; no fixture                                                                  |
| Credentials entering the five-minute window before a send                                                                                                                   | `credentialRefreshRequired`                                                                         | No stage or fixture                                                                            |
| Unknown adapter rejection, impossible status metadata, or classifier invariant failure                                                                                      | `internalFailed` with the static internal error                                                     | Discard any stage; no fixture                                                                  |

This matrix applies unchanged to ordinary Get, one-page List, every paginator step, name resolution,
current-state reads, and compatibility-guarded reads. The latter additionally maps an exact-`200`
additive wire shape to `sdkCompatibilityRequired`. Production, capture, and replay therefore accept the
same operation/status/body pairs. A failed prerequisite read occurs before mutation authorization,
disposes any values already acquired for a second rebase, and leaves certainty `none`. A complete
allowlisted modeled error finalizes only after its closed safe classification; cancellation, expiry,
compatibility/body failure, unmodeled error, and internal failure finalize no fixture call. This rule
applies identically to ordinary, resolved, current-state, compatibility-guarded, and paginated reads.

Identity does not rely on Zod or the pinned AWS JSON map codec to preserve dynamic key sets. Zod 4.4.3
deliberately drops `__proto__`, while the SDK's map serializer/deserializer writes into ordinary `{}` and
therefore also loses that valid tag key. Every dynamic string map instead remains a frozen,
duplicate-free canonical entry list sorted by encoded raw key bytes through domain validation, review,
hashing, and fixture encoding. Parsing first observes source order for duplicate detection and then
canonicalizes; semantically equal maps do not differ because their input key order differed. Only a
boundary that explicitly needs an object materializes a null-prototype record with
`Object.defineProperty(..., { enumerable: true, writable: false, configurable: false })`.

One hand-reviewed `IdentityMapWireRegistry` enumerates every map-bearing Identity wire path:

- Create tags for API key, OAuth, payment, and workload requests.
- `TagResource.tags`.
- Managed-VPC tags in custom OAuth private endpoints and every private-endpoint override on Create and
  Update requests and responses.
- Payment Get top-level tags and every `ListTagsForResource.tags` response.

Request composition materializes those entry lists as null-prototype SDK input records. A structured
serialize-step middleware registered after the generated serializer but before content length and
signing parses the generated JSON with the pinned duplicate-aware parser, compares every registered
path with the original SDK input, replaces the generated map node from the ordered entries, and
serializes the complete structured value again. It never performs textual JSON substitution. Missing
registered paths, unexpected map shapes, inherited keys, duplicates, or a changed Smithy ordering fail
before the request handler.

On every registered map-bearing response, including ordinary Payment Get, List Tags, and managed-VPC
reads, an inner middleware uses the bounded original bytes and the same structured parser to capture
registered map paths as ordered entries before generated deserialization. An outer
post-deserialization middleware replaces each lossy SDK map with a frozen null-prototype record built
from those entries before normalization or fixture capture. The middleware stack is contract-tested in
this exact response order: request handler, bounded/raw map extraction and compatibility guard,
generated deserializer, map revival, fixture recorder, action. Unknown union bodies are never traversed.
A duplicate map key or mismatch between raw and SDK-known structure fails closed; on a mutation whose
exact-status body already completed, that is committed output unavailable rather than evidence of
rollback.

The exhaustive status registry is drift-tested against the pinned runtime command schemas. Every
Identity query expects `200`; Creates expect `201`; Updates and `SetTokenVaultCMK` expect `200`; and
Deletes, Tag, and Untag expect `204`. Only a mutation operation's exact expected status plus bounded
normal body completion may advance the private scope writer to `committed`. Every alternate status,
including another 2xx, remains `mutationOutcomeUnknown`. A nonempty exact `204` still establishes that
the modeled mutation committed, but violates the pinned no-content response shape, so the result is
`successfulResponseUnusable` and capture fails. A modeled success whose SDK deserialization, output
validation, or normalization fails becomes `committedOutputUnavailable`. The action-boundary backstop
consults the authoritative scope rather than trusting a returned discriminant. No post-mark error is
presented as proof that mutation did not occur.

Binding creation is itself transactional. The factory owns every partially resolved credential,
endpoint, client, handler, and native resource until it returns `created`; cancellation or any closed
failure destroys all partial resources. A late complete binding after cancellation is destroyed by the
factory and cannot reach the action. A returned binding is owned immediately by the awaiting action's
`try/finally`.

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
- Own bounded list-all traversal and opaque picker sessions, including raw wire-byte evidence and every
  cumulative limit.
- Return a renderable result or a structured local error.

There is no generic workflow engine. OAuth and payment share catalog machinery because their unions
justify it. API-key, workload identity, token vault, and tag actions remain direct resource-specific
functions.

### Presentation Layer

Commander handlers parse flags into typed intents and invoke actions. Ink screens collect the same
intents and invoke the same actions. Neither layer constructs SDK unions or implements update merge
logic. The root presentation controller registers each exact prepared mutation before invoking its
action lease and owns all execution-bound Commander/Ink receipts. Ink picker components receive frozen
normalized pages only; continuation tokens, cursor state, raw byte evidence, and traversal counters do
not cross the action port.

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
SDK List responses require their collection and optionally return an opaque raw `nextToken`. That raw
value remains internal and becomes `EncodedIdentityContinuationTokenV1` only at the V1 output boundary;
Commander input decodes it before SDK dispatch. Workload list items contain
only name and ARN; callers Get a selected item before an edit or detail view.

### Modeled Constraints

The implementation encodes these constraints in explicit Zod/domain schemas and pins semantic tests
to the generated documentation, TypeScript declarations, and retained live evidence:

| Shape                          | Constraint                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Credential provider name       | 1 to 128 characters; `^[a-zA-Z0-9\-_]+$`                                                                                                 |
| Workload identity name         | 3 to 255 characters; `^[A-Za-z0-9_.-]+$`                                                                                                 |
| Token-vault ID                 | 1 to 64 characters; `^[a-zA-Z0-9\-_]+$`                                                                                                  |
| API key                        | Sensitive; at most 65,536 characters                                                                                                     |
| Named/included OAuth client ID | 1 to 256 characters                                                                                                                      |
| Custom OAuth client ID         | At most 256 characters                                                                                                                   |
| OAuth client secret            | Sensitive; at most 2,048 characters                                                                                                      |
| Microsoft tenant ID            | 1 to 2,048 characters                                                                                                                    |
| Discovery URL                  | Must end in `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server`                                             |
| Workload return URL            | 1 to 2,048 characters; `^\w+:(\/?\/?)[^\s]+$`                                                                                            |
| External secret ID             | 1 to 2,048 characters                                                                                                                    |
| External secret JSON key       | 1 to 128 characters                                                                                                                      |
| Payment non-secret IDs         | 1 to 512 characters; `^[a-zA-Z0-9\-_]+$`                                                                                                 |
| Payment secrets                | Sensitive; at most 2,048 characters; base pattern `^[a-zA-Z0-9+/=\-_\s]*$`                                                               |
| Authorization private key      | Payment secret pattern with the modeled optional `wallet-auth:` prefix                                                                   |
| Private endpoint overrides     | At most five                                                                                                                             |
| KMS key ARN                    | 1 to 2,048; exact modeled pattern shown below; the model itself permits an empty region slot, arbitrary 36-character IDs, and `mrk-` IDs |
| Tags                           | At most 50 entries; key 1 to 128; value 0 to 256; characters `[a-zA-Z0-9\s._:/=+@-]`                                                     |

The exact generated KMS pattern is
`^arn:aws(|-cn|-us-gov):kms:[a-zA-Z0-9-]*:[0-9]{12}:key/[a-zA-Z0-9-]{36}$`.

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

Set CMK deliberately adds a stricter CLI-owned policy over the broad modeled KMS pattern: a customer
key must use a non-empty region and UUID-form single-region key ID, aliases and `mrk-` IDs are rejected,
and a service-managed key must omit the ARN. These are fail-fast product constraints, not claims about
generated requiredness or a retained service probe. The CLI does not add current-region, partition, or
account equality.

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
type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
type IdentityStringMapEntry = Readonly<{ key: string; value: string }>;
type IdentityStringMap = readonly IdentityStringMapEntry[];
type IdentityTags = IdentityStringMap;
type SecretReference = Readonly<{ secretId: string; jsonKey: string }>;

declare const SECRET_VALUE_MARKER: unique symbol;
declare const EXTRACTED_SECRET_SELECTIONS: unique symbol;

interface SecretValueMarker<Slot extends SecretSlotId> {
  readonly kind: "secretValue";
  readonly slot: Slot;
  readonly [SECRET_VALUE_MARKER]: never;
}

interface ExtractedSecretSelections {
  readonly [EXTRACTED_SECRET_SELECTIONS]: never;
  dispose(): void;
}

type SanitizedJsonExtraction<Configuration> =
  | Readonly<{
      kind: "extracted";
      configuration: DeepReadonly<Configuration>;
      selections: ExtractedSecretSelections;
    }>
  | Readonly<{ kind: "validationFailed"; error: UsageIdentityError }>
  | Readonly<{ kind: "internalFailed"; error: InternalIdentityError }>;

type SetPatch<Path extends IdentitySchemaPath, Value> = Readonly<{
  kind: "set";
  path: Path;
  value: DeepReadonly<Value>;
}>;

type ClearPatch<Path extends IdentitySchemaPath> = Readonly<{
  kind: "clear";
  path: Path;
}>;

type ReplacePatch<Path extends IdentitySchemaPath, Value> = Readonly<{
  kind: "replace";
  path: Path;
  value: DeepReadonly<Value>;
}>;

type SecretProvisionDirective<Slot extends SecretSlotId = SecretSlotId> =
  | Readonly<{ kind: "provideManaged"; slot: Slot }>
  | Readonly<{ kind: "useExternal"; slot: Slot; reference: SecretReference }>;

type CuratedUpdateChanges<Patch, Slot extends SecretSlotId> =
  | Readonly<{
      patches: NonEmptyReadonlyArray<Patch>;
      secrets: readonly SecretProvisionDirective<Slot>[];
    }>
  | Readonly<{
      patches: readonly [];
      secrets: NonEmptyReadonlyArray<SecretProvisionDirective<Slot>>;
    }>;

type OauthCuratedPatch =
  | SetPatch<"oauth.clientId", string>
  | ClearPatch<"oauth.clientId">
  | SetPatch<"oauth.tenantId", string>
  | ClearPatch<"oauth.tenantId">
  | ReplacePatch<"oauth.discovery", Discovery>
  | SetPatch<"oauth.clientAuthenticationMethod", ClientAuthenticationMethod>
  | ReplacePatch<"oauth.onBehalfOfTokenExchangeConfig", OnBehalfOf>
  | ClearPatch<"oauth.onBehalfOfTokenExchangeConfig">
  | ReplacePatch<"oauth.privateEndpoint", PrivateEndpoint>
  | ReplacePatch<"oauth.privateEndpointOverrides", NonEmptyReadonlyArray<PrivateEndpointOverride>>
  | ClearPatch<"oauth.clientSecret">;

type PaymentCuratedPatch =
  | SetPatch<"payment.coinbaseCdp.apiKeyId", string>
  | SetPatch<"payment.stripePrivy.appId", string>
  | SetPatch<"payment.stripePrivy.authorizationId", string>;

type WorkloadReturnUrlPatch =
  | ReplacePatch<"workload.allowedResourceOauth2ReturnUrls", NonEmptyReadonlyArray<string>>
  | ClearPatch<"workload.allowedResourceOauth2ReturnUrls">;

type CreateOauth2Intent =
  | Readonly<{
      mode: "curated";
      name: string;
      vendor: CredentialProviderVendorType;
      configuration: CuratedOauth2CreateConfiguration;
      secrets: readonly SecretProvisionDirective<"client-secret">[];
      tags?: IdentityTags;
    }>
  | Readonly<{
      mode: "raw";
      name: string;
      vendor: CredentialProviderVendorType;
      configuration: SanitizedOAuthInput;
      secrets: readonly SecretProvisionDirective<"client-secret">[];
      tags?: IdentityTags;
    }>;

type UpdateOauth2Intent =
  | (Readonly<{ mode: "curated"; name: string }> &
      CuratedUpdateChanges<OauthCuratedPatch, "client-secret">)
  | Readonly<{
      mode: "rawReplacement";
      name: string;
      replacement: SanitizedOAuthInput;
      secrets: readonly SecretProvisionDirective<"client-secret">[];
    }>;

type CreateApiKeyIntent = Readonly<{
  name: string;
  secret: SecretProvisionDirective<"api-key">;
  tags?: IdentityTags;
}>;

type UpdateApiKeyIntent = Readonly<{
  name: string;
  secret: SecretProvisionDirective<"api-key">;
}>;

type CreatePaymentIntent =
  | Readonly<{
      mode: "curated";
      name: string;
      vendor: PaymentCredentialProviderVendorType;
      configuration: CuratedPaymentCreateConfiguration;
      secrets: readonly SecretProvisionDirective<PaymentSecretSlotId>[];
      tags?: IdentityTags;
    }>
  | Readonly<{
      mode: "raw";
      name: string;
      vendor: PaymentCredentialProviderVendorType;
      configuration: SanitizedPaymentInput;
      secrets: readonly SecretProvisionDirective<PaymentSecretSlotId>[];
      tags?: IdentityTags;
    }>;

type UpdatePaymentIntent =
  | (Readonly<{ mode: "curated"; name: string }> &
      CuratedUpdateChanges<PaymentCuratedPatch, PaymentSecretSlotId>)
  | Readonly<{
      mode: "rawReplacement";
      name: string;
      replacement: SanitizedPaymentInput;
      secrets: readonly SecretProvisionDirective<PaymentSecretSlotId>[];
    }>;

type CreateWorkloadIdentityIntent = Readonly<{
  name: string;
  returnUrls: readonly string[];
  tags?: IdentityTags;
}>;

type UpdateWorkloadIdentityIntent = Readonly<{
  name: string;
  patch: WorkloadReturnUrlPatch;
}>;

type SetTokenVaultCmkIntent =
  | Readonly<{
      tokenVaultId: string;
      keyType: "ServiceManagedKey";
    }>
  | Readonly<{
      tokenVaultId: string;
      keyType: "CustomerManagedKey";
      kmsKeyArn: string;
    }>;

type GetByNameIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> = Readonly<{
  family: Family;
  name: string;
}>;

type DeleteByNameIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> =
  GetByNameIntent<Family>;

type ListIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> = Readonly<{
  family: Family;
  nextToken?: IdentityContinuationToken;
  maxResults: number;
  all: boolean;
}>;

type GetTokenVaultIntent = Readonly<{ tokenVaultId: string }>;

type TagByNameIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> = Readonly<{
  family: Family;
  selector: Readonly<{ kind: "name"; name: string }>;
  tags: IdentityTags;
}>;

type TagByResourceArnIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> =
  Readonly<{
    family: Family;
    selector: Readonly<{ kind: "resourceArn"; arn: string }>;
    tags: IdentityTags;
  }>;

type UntagByNameIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> = Readonly<{
  family: Family;
  selector: Readonly<{ kind: "name"; name: string }>;
  tagKeys: NonEmptyReadonlyArray<string>;
}>;

type UntagByResourceArnIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> =
  Readonly<{
    family: Family;
    selector: Readonly<{ kind: "resourceArn"; arn: string }>;
    tagKeys: NonEmptyReadonlyArray<string>;
  }>;

type ListTagsByNameIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> = Readonly<{
  family: Family;
  selector: Readonly<{ kind: "name"; name: string }>;
}>;

type ListTagsByResourceArnIntent<Family extends Exclude<IdentityResourceFamily, "tokenVault">> =
  Readonly<{
    family: Family;
    selector: Readonly<{ kind: "resourceArn"; arn: string }>;
  }>;
```

`ClientAuthenticationMethod`, `Discovery`, `OnBehalfOf`, `PrivateEndpoint`, the parser-boundary
`OAuthJsonInput` and `PaymentJsonInput`, and the action-boundary `SanitizedOAuthInput` and
`SanitizedPaymentInput` are the exact aliases below. `CuratedOauth2CreateConfiguration` and
`CuratedPaymentCreateConfiguration` are closed discriminated unions over the exhaustive provider
catalogs and the Create applicability table; they do not contain SDK request wrappers. The
`IdentitySchemaPath` catalog includes every literal path used by these unions.

Every Commander option and TUI field maps through a per-workflow `as const satisfies` option catalog
to exactly one member of its patch union. Missing and extra option mappings fail compilation.
`--replace-config-json` selects the raw-replacement intent and conflicts with every curated patch.
Duplicate paths and conflicting set/clear operations fail before Get. OAuth and payment curated Update
require at least one non-secret patch or one explicit secret provision/rotation directive; the
`CuratedUpdateChanges` union makes both-empty input uninhabitable. A secret-only plan has an empty
non-secret `changes` list, at least one `secretRequirements` entry with action `rotate`, and can never
return `noChange`. Input `remove` directives do not exist: OAuth secret removal derives only from the
explicit `--clear-client-secret` patch or a validated raw replacement whose authentication method has
no client secret. Workload Update accepts only one explicit non-empty replacement or clear patch; the
merge algorithm's internal notion of an omitted field is not an inhabitable command intent.

Intent types contain explicit non-secret patch operations, desired AgentCore storage modes, external
references, and nominal `SecretValueMarker` leaves at raw-JSON paths that originally held a managed
value. A string is not assignable to any sensitive member of an action intent. Managed-value acquisition
is carried separately by a one-use `CommitSecretContext`; actual values, environment names, file paths,
stdin markers, extracted-selection bundles, and prompt callbacks remain outside the intent and every
prepared plan.

The workflow type catalog is exact. DTO aliases below refer to the operation-specific allowlists in
Normalized V1 Output; `EmptyIdentityV1Dto` is exact `{}` and `ListTagsV1Dto` is exact
`{ tags: Record<K, S> }`.

```ts
interface IdentityWorkflowPayloads {
  readonly "apiKey.create": IdentityWorkflowPayload<CreateApiKeyIntent, ApiKeyCreateV1Dto>;
  readonly "apiKey.get": IdentityWorkflowPayload<GetByNameIntent<"apiKey">, ApiKeyGetV1Dto>;
  readonly "apiKey.list": IdentityWorkflowPayload<ListIntent<"apiKey">, ApiKeyListV1Dto>;
  readonly "apiKey.update": IdentityWorkflowPayload<UpdateApiKeyIntent, ApiKeyUpdateV1Dto>;
  readonly "apiKey.delete": IdentityWorkflowPayload<
    DeleteByNameIntent<"apiKey">,
    EmptyIdentityV1Dto
  >;

  readonly "oauth2.create": IdentityWorkflowPayload<CreateOauth2Intent, Oauth2CreateV1Dto>;
  readonly "oauth2.get": IdentityWorkflowPayload<GetByNameIntent<"oauth2">, Oauth2GetV1Dto>;
  readonly "oauth2.list": IdentityWorkflowPayload<ListIntent<"oauth2">, Oauth2ListV1Dto>;
  readonly "oauth2.update": IdentityWorkflowPayload<UpdateOauth2Intent, Oauth2UpdateV1Dto>;
  readonly "oauth2.delete": IdentityWorkflowPayload<
    DeleteByNameIntent<"oauth2">,
    EmptyIdentityV1Dto
  >;

  readonly "payment.create": IdentityWorkflowPayload<CreatePaymentIntent, PaymentCreateV1Dto>;
  readonly "payment.get": IdentityWorkflowPayload<GetByNameIntent<"payment">, PaymentGetV1Dto>;
  readonly "payment.list": IdentityWorkflowPayload<ListIntent<"payment">, PaymentListV1Dto>;
  readonly "payment.update": IdentityWorkflowPayload<UpdatePaymentIntent, PaymentUpdateV1Dto>;
  readonly "payment.delete": IdentityWorkflowPayload<
    DeleteByNameIntent<"payment">,
    EmptyIdentityV1Dto
  >;

  readonly "workload.create": IdentityWorkflowPayload<
    CreateWorkloadIdentityIntent,
    WorkloadCreateV1Dto
  >;
  readonly "workload.get": IdentityWorkflowPayload<GetByNameIntent<"workload">, WorkloadGetV1Dto>;
  readonly "workload.list": IdentityWorkflowPayload<ListIntent<"workload">, WorkloadListV1Dto>;
  readonly "workload.update": IdentityWorkflowPayload<
    UpdateWorkloadIdentityIntent,
    WorkloadUpdateV1Dto
  >;
  readonly "workload.delete": IdentityWorkflowPayload<
    DeleteByNameIntent<"workload">,
    EmptyIdentityV1Dto
  >;

  readonly "tokenVault.get": IdentityWorkflowPayload<GetTokenVaultIntent, TokenVaultGetV1Dto>;
  readonly "tokenVault.setCmk": IdentityWorkflowPayload<
    SetTokenVaultCmkIntent,
    TokenVaultSetCmkV1Dto
  >;

  readonly "apiKey.tag.name": IdentityWorkflowPayload<
    TagByNameIntent<"apiKey">,
    EmptyIdentityV1Dto
  >;
  readonly "apiKey.tag.resourceArn": IdentityWorkflowPayload<
    TagByResourceArnIntent<"apiKey">,
    EmptyIdentityV1Dto
  >;
  readonly "apiKey.untag.name": IdentityWorkflowPayload<
    UntagByNameIntent<"apiKey">,
    EmptyIdentityV1Dto
  >;
  readonly "apiKey.untag.resourceArn": IdentityWorkflowPayload<
    UntagByResourceArnIntent<"apiKey">,
    EmptyIdentityV1Dto
  >;
  readonly "apiKey.listTags.name": IdentityWorkflowPayload<
    ListTagsByNameIntent<"apiKey">,
    ListTagsV1Dto
  >;
  readonly "apiKey.listTags.resourceArn": IdentityWorkflowPayload<
    ListTagsByResourceArnIntent<"apiKey">,
    ListTagsV1Dto
  >;

  readonly "oauth2.tag.name": IdentityWorkflowPayload<
    TagByNameIntent<"oauth2">,
    EmptyIdentityV1Dto
  >;
  readonly "oauth2.tag.resourceArn": IdentityWorkflowPayload<
    TagByResourceArnIntent<"oauth2">,
    EmptyIdentityV1Dto
  >;
  readonly "oauth2.untag.name": IdentityWorkflowPayload<
    UntagByNameIntent<"oauth2">,
    EmptyIdentityV1Dto
  >;
  readonly "oauth2.untag.resourceArn": IdentityWorkflowPayload<
    UntagByResourceArnIntent<"oauth2">,
    EmptyIdentityV1Dto
  >;
  readonly "oauth2.listTags.name": IdentityWorkflowPayload<
    ListTagsByNameIntent<"oauth2">,
    ListTagsV1Dto
  >;
  readonly "oauth2.listTags.resourceArn": IdentityWorkflowPayload<
    ListTagsByResourceArnIntent<"oauth2">,
    ListTagsV1Dto
  >;

  readonly "payment.tag.name": IdentityWorkflowPayload<
    TagByNameIntent<"payment">,
    EmptyIdentityV1Dto
  >;
  readonly "payment.tag.resourceArn": IdentityWorkflowPayload<
    TagByResourceArnIntent<"payment">,
    EmptyIdentityV1Dto
  >;
  readonly "payment.untag.name": IdentityWorkflowPayload<
    UntagByNameIntent<"payment">,
    EmptyIdentityV1Dto
  >;
  readonly "payment.untag.resourceArn": IdentityWorkflowPayload<
    UntagByResourceArnIntent<"payment">,
    EmptyIdentityV1Dto
  >;
  readonly "payment.listTags.name": IdentityWorkflowPayload<
    ListTagsByNameIntent<"payment">,
    ListTagsV1Dto
  >;
  readonly "payment.listTags.resourceArn": IdentityWorkflowPayload<
    ListTagsByResourceArnIntent<"payment">,
    ListTagsV1Dto
  >;

  readonly "workload.tag.name": IdentityWorkflowPayload<
    TagByNameIntent<"workload">,
    EmptyIdentityV1Dto
  >;
  readonly "workload.tag.resourceArn": IdentityWorkflowPayload<
    TagByResourceArnIntent<"workload">,
    EmptyIdentityV1Dto
  >;
  readonly "workload.untag.name": IdentityWorkflowPayload<
    UntagByNameIntent<"workload">,
    EmptyIdentityV1Dto
  >;
  readonly "workload.untag.resourceArn": IdentityWorkflowPayload<
    UntagByResourceArnIntent<"workload">,
    EmptyIdentityV1Dto
  >;
  readonly "workload.listTags.name": IdentityWorkflowPayload<
    ListTagsByNameIntent<"workload">,
    ListTagsV1Dto
  >;
  readonly "workload.listTags.resourceArn": IdentityWorkflowPayload<
    ListTagsByResourceArnIntent<"workload">,
    ListTagsV1Dto
  >;
}

type IdentityWorkflowIntentMap = Readonly<{
  [K in IdentityWorkflowName]: IdentityWorkflowDefinitions[K]["intent"];
}>;

type IdentityWorkflowDtoMap = Readonly<{
  [K in IdentityWorkflowName]: IdentityWorkflowDefinitions[K]["dto"];
}>;
```

This payload catalog has exactly 46 properties and contains only intent and DTO types. Family, selector,
primary operation, auxiliary Get, facet, and policy derive from `IdentityWorkflowCompatibility<K>` and
cannot be selected independently. The private runtime metadata catalog has the same 46 keys and uses
`as const satisfies IdentityWorkflowCompatibilityMap`; a missing, extra, or semantically incompatible
row fails compilation. The symbol-owning constructor materializes one frozen `IdentityWorkflowId<K>`
for each key. These key-derived facts are the only source used by ports, actions, capabilities,
handlers, routes, review models, and DTO normalization.

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

All JSON options use `jsonc-parser@3.3.1` in strict JSON mode with comments and trailing commas
disabled. Its visitor builds a null-prototype structured tree, reports every property occurrence before
materialization, and rejects duplicate keys at every object depth. Modeled maps are converted directly
to frozen ordered entry lists; they never pass through `z.record` or an ordinary object. The parser
accepts sensitive strings only in the parser-boundary `OAuthJsonInput` or `PaymentJsonInput`, immediately
extracts them into an opaque creator-owned `ExtractedSecretSelections` bundle, and constructs the
corresponding `SanitizedOAuthInput` or `SanitizedPaymentInput` with nominal `SecretValueMarker` leaves.
`SanitizedJsonExtraction` is the only successful extraction result; no partially sanitized structure
escapes. The marker constructor and selection-bundle contents are module-private. The parser does not
retain the original JSON text or any sensitive string in an action intent or plan. Extraction adds the
corresponding `provideManaged` directive for each marker; a separate source targeting that same slot is
a closed conflict rather than an override. Extraction and
`CommitSecretContextFactory.create()` run under one creator-owned `try/finally`: until `prepare()`
returns a current, installed `prepared` pair, every partial selection, locator, context, and late
capability remains the creator's responsibility. Any later JSON-key, union, vendor, context-build,
prepare, cancellation, or unexpected-rejection path disposes the context and clears the extracted
references. Successful context construction atomically consumes the extracted bundle; failed
construction disposes it. It cannot be inspected, copied, reused, or passed to an action.

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

The V1 parser-boundary aliases below are exact recursive objects. Unknown keys are rejected at every
structure; unions require exactly one known member; input `$unknown` is rejected; arrays validate each
member; only modeled maps admit arbitrary keys. These aliases are untrusted user-input schemas and are
never action-intent types.

```text
Source = "MANAGED" | "EXTERNAL"
StringMap = exact JSON object parsed as duplicate-free canonical { key, value } entries
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
      tags?: StringMap,
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

`OAuthJsonInput` has exactly one of these nine members:

| Union member                                                                                      | Leaf        |
| ------------------------------------------------------------------------------------------------- | ----------- |
| `googleOauth2ProviderConfig`, `githubOauth2ProviderConfig`, `slackOauth2ProviderConfig`           | `Named`     |
| `salesforceOauth2ProviderConfig`, `atlassianOauth2ProviderConfig`, `linkedinOauth2ProviderConfig` | `Named`     |
| `microsoftOauth2ProviderConfig`                                                                   | `Microsoft` |
| `includedOauth2ProviderConfig`                                                                    | `Included`  |
| `customOauth2ProviderConfig`                                                                      | `Custom`    |

`PaymentJsonInput` has exactly one of these two members:

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

The sanitized action aliases have the identical exact union members and recursive non-secret members,
with only these substitutions:

| Parser-boundary sensitive path                     | Action-intent member type                        |
| -------------------------------------------------- | ------------------------------------------------ |
| Every OAuth member's `clientSecret`                | `SecretValueMarker<"client-secret">`             |
| `coinbaseCdpConfiguration.apiKeySecret`            | `SecretValueMarker<"api-key-secret">`            |
| `coinbaseCdpConfiguration.walletSecret`            | `SecretValueMarker<"wallet-secret">`             |
| `stripePrivyConfiguration.appSecret`               | `SecretValueMarker<"app-secret">`                |
| `stripePrivyConfiguration.authorizationPrivateKey` | `SecretValueMarker<"authorization-private-key">` |

Those substitutions define `SanitizedOAuthInput` and `SanitizedPaymentInput`; every other field,
requiredness rule, exact-object boundary, and union rule is the same as its parser-boundary counterpart.
The sensitive-path registry is an exhaustive `satisfies` record over these five path families. Adding,
removing, or renaming a sensitive SDK member fails compilation until both the user schema and markerized
action schema are reviewed.

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
  | "internalProtocol"
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
  | { kind: "validationFailed"; error: UsageIdentityError }
  | { kind: "secretFailed"; error: SecretIdentityError }
  | { kind: "internalFailed"; error: InternalIdentityError };

interface CommitSecretContextFactory {
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

interface CommitSecretContext {
  readonly [COMMIT_SECRET_CONTEXT]: never;
  dispose(): void;
}
```

The unique-symbol brands and all reserve/bind/claim methods are module-private. Every invocation of the
boundary-owned `defineSecretSourceReader<PrivateLocator>()` constructor creates a fresh private owner
token and `WeakMap`, wraps each adapter-private locator in an opaque `SecretFileLocator` shell, and
unwraps it only for that same reader instance's `readFile` and `disposeFile`; the process adapter never
constructs the private brand. The shared static TypeScript type prevents ordinary forgery but does not
claim compile-time separation between two runtime reader instances. Passing reader A's locator to
reader B is rejected by the wrapper as `internalProtocol` before either adapter is invoked; a foreign
`disposeFile` is an idempotent no-op and cannot close the rightful owner's handle.

The secret-context coordinator constructs `CommitSecretContext` shells beside
`COMMIT_SECRET_CONTEXT`. Both paths compile without assertions or exported brand values. Presentation
code can pass or dispose a context but cannot inspect a source, reserve preparation, resolve a value,
or claim a commit lease. `SecretReadOutcome` carries no path, variable name, raw value, or arbitrary
error. `create()` synchronously adopts an optional `ExtractedSecretSelections` bundle before its first
`await`, merges it with explicit slot sources under the same duplicate/conflict rules, and consumes or
disposes the bundle on every outcome. It catches every construction rejection and returns the closed
`SecretContextBuildOutcome`; it never rejects. The context maps normal failed reads to the selected slot and
closed `SecretIdentityError`, maps `internalProtocol` to the slotless static internal error, and maps
unknown adapter rejections to the same `internalFailed` outcome. `disposeFile`, extracted-bundle
disposal, and context disposal are synchronous, nonthrowing, and idempotent.

The process adapter uses one private typed N-API boundary. These declarations do not enter the domain
or action ports:

```ts
declare const NATIVE_SECURE_FILE_HANDLE: unique symbol;
declare const NATIVE_TRUSTED_PARENT_HANDLE: unique symbol;
declare const NATIVE_PROTECTED_ROOT_HANDLE: unique symbol;
declare const NATIVE_PERMANENT_LOCK_HANDLE: unique symbol;
declare const NATIVE_PUBLICATION_AUTHORITY_HANDLE: unique symbol;
declare const NATIVE_OPEN_CAPTURE_ROOT_HANDLE: unique symbol;
declare const NATIVE_SEALED_CAPTURE_ROOT_HANDLE: unique symbol;
declare const NATIVE_FIXTURE_TREE_HANDLE: unique symbol;
declare const CANONICAL_RUN_LEDGER_BYTES_V1: unique symbol;

type NativeFileCaptureFailureReason = "unavailable" | "unsafe";
type NativeFileReadFailureReason = "changed" | "limitExceeded" | "unavailable" | "unsafe";

type NativeOutcome<T, Reason extends string> =
  | { kind: "succeeded"; value: T }
  | { kind: "failed"; reason: Reason };

interface NativeSecureFileHandle {
  readonly [NATIVE_SECURE_FILE_HANDLE]: never;
}

interface NativeTrustedParentHandle {
  readonly [NATIVE_TRUSTED_PARENT_HANDLE]: never;
}

interface NativeProtectedRootHandle {
  readonly [NATIVE_PROTECTED_ROOT_HANDLE]: never;
}

interface NativePermanentLockHandle {
  readonly [NATIVE_PERMANENT_LOCK_HANDLE]: never;
}

interface NativePublicationAuthorityHandle {
  readonly [NATIVE_PUBLICATION_AUTHORITY_HANDLE]: never;
}

interface NativeOpenCaptureRootHandle {
  readonly [NATIVE_OPEN_CAPTURE_ROOT_HANDLE]: never;
}

interface NativeSealedCaptureRootHandle {
  readonly [NATIVE_SEALED_CAPTURE_ROOT_HANDLE]: never;
}

interface NativeFixtureTreeHandle {
  readonly [NATIVE_FIXTURE_TREE_HANDLE]: never;
}

interface CanonicalRunLedgerBytesV1 {
  readonly [CANONICAL_RUN_LEDGER_BYTES_V1]: never;
}

type NativeProtectedRootIdentity = Readonly<{
  protectedRootId: string;
}>;

interface NativeLinuxStaleCleanupProof {
  readonly platform: "linux";
  readonly bootSessionId: string;
  readonly uniqueMountId: string;
  readonly protectedRootId: string;
  readonly lockObjectId: string;
}

type FixtureIndexStateV1 = { kind: "absent" } | { kind: "sha256"; digest: string };

type FixtureSuiteIndexV1 = Readonly<{
  schema: "amazon.agentcore-cli.identity.fixture-suite-index";
  version: 1;
  flows: readonly Readonly<{ flowId: string; manifestDigest: string }>[];
}>;

type FixtureReadyV1 = Readonly<{
  schema: "amazon.agentcore-cli.identity.fixture-ready";
  version: 1;
  expectedBaseIndex: FixtureIndexStateV1;
  objects: readonly Readonly<{ digest: string; byteLength: number }>[];
  flows: readonly Readonly<{
    flowId: string;
    manifestDigest: string;
    manifestByteLength: number;
    callCount: number;
  }>[];
  nextIndex: FixtureSuiteIndexV1;
}>;

type FixtureIndexSnapshotV1 = Readonly<{
  state: FixtureIndexStateV1;
  index: FixtureSuiteIndexV1 | null;
}>;

type FixtureCaptureHandoffV1 = Readonly<{
  captureId: string;
  readyDigest: string;
  runId: string;
  runRootId: string;
  ledgerDigest: string;
  flowCount: number;
  callCount: number;
}>;

type NativeOpenedSealedCapture = Readonly<{
  capture: NativeSealedCaptureRootHandle;
  handoff: FixtureCaptureHandoffV1;
}>;

type FixtureCaptureDiscoveryV1 = Readonly<{
  captures: readonly FixtureCaptureHandoffV1[];
  busyCaptureCount: number;
  invalidCaptureCount: number;
}>;

const FIXTURE_DISCOVERY_MAX_CHILDREN = 1_024 as const;
const FIXTURE_DISCOVERY_MAX_HANDOFFS = 256 as const;

type NativeCaptureCreation = Readonly<{
  captureId: string;
  capture: NativeOpenCaptureRootHandle;
}>;

type NativeCaptureSealOutcome =
  | {
      kind: "invalidState";
    }
  | {
      kind: "notSealed";
      reason: "unavailable" | "unsafe" | "unsupported";
    }
  | {
      kind: "sealed";
      capture: NativeSealedCaptureRootHandle;
      durability: "directorySynced" | "processCrashOnly" | "unknownAfterSeal";
    };

type NativeFixturePublishOutcome =
  | {
      kind: "notPublished";
      reason:
        | "busy"
        | "invalidCapture"
        | "fixtureTreeMismatch"
        | "staleBase"
        | "unavailable"
        | "unsafe"
        | "unsupported";
    }
  | {
      kind: "published";
      durability: "directorySynced" | "processCrashOnly" | "unknownAfterCommit";
    };

type NativeRunLedgerExpectation = { kind: "absent" } | { kind: "sha256"; digest: string };

type NativeRunLedgerReplaceOutcome =
  | {
      kind: "committed";
      disposition: "installed" | "alreadyCurrent";
      digest: string;
    }
  | {
      kind: "notCommitted";
      reason: "expectedDigestMismatch" | "limitExceeded" | "unavailable" | "unsafe";
    }
  | {
      kind: "commitUnknown";
      nextDigest: string;
    };

interface AgentCoreNativeAdapter {
  captureTrustedFile(
    path: string,
  ): NativeOutcome<NativeSecureFileHandle, NativeFileCaptureFailureReason>;
  readVerifiedFile(
    handle: NativeSecureFileHandle,
    byteCap: number,
  ): NativeOutcome<Uint8Array, NativeFileReadFailureReason>;
  closeTrustedFile(handle: NativeSecureFileHandle): void;
  openTrustedParent(
    path: string,
  ): NativeOutcome<NativeTrustedParentHandle, "unavailable" | "unsafe">;
  createProtectedRootExclusive(
    parent: NativeTrustedParentHandle,
    basename: string,
  ): NativeOutcome<NativeProtectedRootHandle, "alreadyExists" | "unavailable" | "unsafe">;
  closeTrustedParent(handle: NativeTrustedParentHandle): void;
  openProtectedRoot(
    path: string,
  ): NativeOutcome<NativeProtectedRootHandle, "unavailable" | "unsafe">;
  identifyProtectedRoot(
    root: NativeProtectedRootHandle,
  ): NativeOutcome<NativeProtectedRootIdentity, "unavailable" | "unsafe" | "unsupported">;
  readRunLedger(
    root: NativeProtectedRootHandle,
  ): NativeOutcome<Uint8Array, "notFound" | "limitExceeded" | "unavailable" | "unsafe">;
  replaceRunLedgerAtomically(
    root: NativeProtectedRootHandle,
    expected: NativeRunLedgerExpectation,
    bytes: CanonicalRunLedgerBytesV1,
  ): NativeRunLedgerReplaceOutcome;
  closeProtectedRoot(handle: NativeProtectedRootHandle): void;
  openRunLock(
    root: NativeProtectedRootHandle,
  ): NativeOutcome<NativePermanentLockHandle, "unavailable" | "unsafe">;
  lockExclusive(handle: NativePermanentLockHandle): NativeOutcome<undefined, "unavailable">;
  tryLockExclusive(
    handle: NativePermanentLockHandle,
  ): NativeOutcome<"acquired" | "busy", "unavailable">;
  closePermanentLock(handle: NativePermanentLockHandle): void;
  identifyStaleCleanupProof(
    root: NativeProtectedRootHandle,
    lock: NativePermanentLockHandle,
  ): NativeOutcome<NativeLinuxStaleCleanupProof, "unavailable" | "unsafe" | "unsupported">;
  openOrCreatePublicationAuthority(): NativeOutcome<
    NativePublicationAuthorityHandle,
    "unavailable" | "unsafe" | "unsupported"
  >;
  closePublicationAuthority(handle: NativePublicationAuthorityHandle): void;
  openFixtureTree(
    path: string,
  ): NativeOutcome<NativeFixtureTreeHandle, "unavailable" | "unsafe" | "unsupported">;
  readFixtureSuiteIndex(
    fixtureTree: NativeFixtureTreeHandle,
  ): NativeOutcome<
    FixtureIndexSnapshotV1,
    "invalidIndex" | "limitExceeded" | "unavailable" | "unsafe" | "unsupported"
  >;
  createFixtureCaptureRoot(
    publicationAuthority: NativePublicationAuthorityHandle,
    fixtureTree: NativeFixtureTreeHandle,
  ): NativeOutcome<NativeCaptureCreation, "unavailable" | "unsafe" | "unsupported">;
  openSealedFixtureCaptureRoot(
    publicationAuthority: NativePublicationAuthorityHandle,
    captureId: string,
    readyDigest: string,
    runRoot: NativeProtectedRootHandle,
    expectedRunId: string,
    expectedLedgerDigest: string,
  ): NativeOutcome<
    NativeOpenedSealedCapture,
    "busy" | "invalidCapture" | "unavailable" | "unsafe" | "unsupported"
  >;
  listSealedFixtureCaptures(
    publicationAuthority: NativePublicationAuthorityHandle,
    fixtureTree: NativeFixtureTreeHandle,
  ): NativeOutcome<
    FixtureCaptureDiscoveryV1,
    "limitExceeded" | "unavailable" | "unsafe" | "unsupported"
  >;
  installCaptureArtifact(
    capture: NativeOpenCaptureRootHandle,
    components: readonly string[],
    bytes: Uint8Array,
    digest: string,
  ): NativeOutcome<
    undefined,
    "contentMismatch" | "invalidState" | "unavailable" | "unsafe" | "unsupported"
  >;
  sealFixtureCaptureRoot(
    capture: NativeOpenCaptureRootHandle,
    fixtureTree: NativeFixtureTreeHandle,
    runRoot: NativeProtectedRootHandle,
    runId: string,
    ledgerBytes: CanonicalRunLedgerBytesV1,
    ledgerDigest: string,
    readyBytes: Uint8Array,
    readyDigest: string,
  ): NativeCaptureSealOutcome;
  discardOpenFixtureCapture(
    capture: NativeOpenCaptureRootHandle,
  ): NativeOutcome<undefined, "busy" | "invalidState" | "unavailable" | "unsafe">;
  discardSealedFixtureCapture(
    capture: NativeSealedCaptureRootHandle,
  ): NativeOutcome<undefined, "busy" | "invalidState" | "unavailable" | "unsafe">;
  reapAbandonedFixtureCaptures(
    publicationAuthority: NativePublicationAuthorityHandle,
    olderThanEpochMs: number,
  ): NativeOutcome<number, "unavailable" | "unsafe" | "unsupported">;
  closeOpenFixtureCaptureRoot(handle: NativeOpenCaptureRootHandle): void;
  closeSealedFixtureCaptureRoot(handle: NativeSealedCaptureRootHandle): void;
  publishFixtureTransaction(
    publicationAuthority: NativePublicationAuthorityHandle,
    capture: NativeSealedCaptureRootHandle,
    fixtureTree: NativeFixtureTreeHandle,
    runRoot: NativeProtectedRootHandle,
  ): NativeFixturePublishOutcome;
  closeFixtureTree(handle: NativeFixtureTreeHandle): void;
}
```

The JavaScript loader validates every argument and result, catches all native exceptions, and maps
them to the closed outcomes above. Handles are owner-bound by kind and adapter instance and expose no
descriptor number, path, metadata, read method, or arbitrary native error. Cross-kind handles and
handles from another adapter instance fail before native dispatch. Close is synchronous, nonthrowing,
and idempotent. Digests are exactly 64 lowercase hexadecimal characters. Native code generates capture
IDs from 128 CSPRNG bits and renders exactly 32 lowercase hexadecimal characters; every operation that
accepts an ID independently rejects a noncanonical value. Scalar basenames and relative component
arrays are bounded and reject empty, `.`, `..`, slash, backslash, NUL, absolute or drive-qualified
forms, alternate-data-stream colons, trailing Windows dots/spaces, reserved DOS device names,
reserved-temporary components, and duplicate source or target identities before filesystem access.
The generic protected-root basename receives the same native validation even after the JavaScript
wrapper checks it. `readVerifiedFile`
performs the complete pre-read, bounded positional read, post-read, and path-identity transaction
inside the native boundary; JavaScript cannot accidentally separate those checks. Lock operations
use Linux OFD `fcntl`, macOS `flock`, and Windows `LockFileEx`. Run-lock and ledger basenames are fixed
inside their exact native methods; callers cannot pass a second path after root validation.
Protected-file replacement creates, protects, writes, syncs, verifies, and renames a unique
same-directory temporary entirely inside the native boundary. An unavailable or malformed OS
primitive fails closed.
The run ledger name is exactly `.run-ledger-v1.json`; native reads use the fixed
`RUN_LEDGER_MAX_BYTES` cap rather than a caller-selected value. Only the strict V1 encoder can construct
`CanonicalRunLedgerBytesV1`. Replacement compares the current absent-or-SHA-256 state with the supplied
expectation while the retained root is authoritative, accepts an already-current next digest
idempotently, and otherwise installs the protected temporary with file and parent-directory sync.
A failure known before rename is `notCommitted`; a post-rename uncertainty is `commitUnknown`. After
`commitUnknown`, the caller rereads and accepts only the exact old or next canonical digest; a missing
or third state aborts without another AWS mutation.
For fixture sealing, the loader accepts `runId`, `ledgerBytes`, and `ledgerDigest` only as one
strict-parser-produced tuple whose purpose is `fixtureCapture` and whose rows are all terminal. Native
code rereads the fixed ledger through the supplied retained run root, requires byte equality with
`ledgerBytes`, verifies `ledgerDigest`, derives the protected run-root identity itself, and installs
that complete recovery binding before `READY`. Caller-provided paths or unvalidated JSON can never
become a recovery binding.
Protected-root, mount, and lock-object identities are returned only as fixed lowercase-hex opaque
digests, never raw host, SID, volume, mount, or path data.
`identifyProtectedRoot` is available on every supported capture platform and hashes the validated
platform file identity plus local mount/volume identity. It is a correlation value, not stale-process
termination evidence; only `identifyStaleCleanupProof` can authorize Linux cleanup.
The process adapter maps `unavailable`, `unsafe`, `changed`, and `limitExceeded` only to
`fileUnavailable`, `fileUnsafe`, `fileChanged`, and `invalidValue`, respectively.

`createProtectedRootExclusive` is the only caller-directed creation path for a run root. It retains and
verifies a trusted parent, performs one no-follow descriptor-relative exclusive directory creation,
installs exact `0700` plus trivial ACL on POSIX or the protected DACL below on Windows before returning,
and reopens and verifies the created object by handle. `alreadyExists` never adopts the object; a
separate `openProtectedRoot` call must validate an existing run root from the beginning. Publication
authority creation is available only through the pathless `openOrCreatePublicationAuthority` operation
below, which performs the equivalent create-or-validate transaction internally. This prevents a
check/create/substitute gap during first use.

Mutating stale cleanup is supported only on Linux when the held root and lock return
`STATX_MNT_ID_UNIQUE`, not ordinary `STATX_MNT_ID`. The proof combines that non-reused-within-boot
mount ID with `/proc/sys/kernel/random/boot_id`, the protected root's device/inode, and the held lock's
device/inode. The platform hashes a length-delimited typed tuple, so component concatenation is
unambiguous. A same-boot remount changes the unique mount ID; a reboot changes the boot ID. Linux
without `STATX_MNT_ID_UNIQUE`, macOS filesystem IDs, and Windows volume GUIDs/serials cannot prove a
mount incarnation and therefore return `unsupported` for mutating stale cleanup. They retain live-run,
ordinary cleanup, dry-run audit, and descriptor-lock support. No confirmation flag overrides that
platform gate.

Fixture temporary reclamation does not use `NativeLinuxStaleCleanupProof`. Stable publication
temporaries are reclaimed only while both the publication-authority lock and the retained fixture
tree's co-located lock are held. Each capture has its own permanent `.capture.lock`, so failed-capture
discard and reap acquire that capture's lock without serializing unrelated active captures. The Linux
boot/mount proof remains exclusive to stale AWS-resource mutation.

The complete fixture lock discipline is operation-specific and closed:

| Operation                                      | Locks held, in acquisition order                                 |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Capture creation / abandoned-root scan         | Publication authority, then one newly created or scanned capture |
| Artifact install / seal / explicit discard     | One capture only                                                 |
| Publication, including stable-temp reclamation | One capture, publication authority, then retained fixture tree   |

Every acquisition after the first is nonblocking. Contention releases all locks already held in
reverse order and returns `busy`; no path waits while holding an earlier lock. The creation path's
capture is new and unobservable before authority-protected installation. The abandoned-root scan never
waits for a busy capture and never carries one capture lock to another child. The publication and scan
orders therefore intentionally differ but cannot deadlock. Tests cover every pairwise contention edge
and assert release order and absence of mutation on `busy`.

Every authority-bearing lock, capture root, run ledger, and ledger temporary lives below a retained
publication-authority or protected-run-root handle. POSIX roots must be exact-effective-user-owned
directories with mode `0700` and a trivial ACL;
the native adapter walks components with no-follow semantics, rejects links, ownership changes, and
untrusted-writable ancestors, and uses descriptor-relative opens. Authority files are owner-owned
regular files with exact `0600` mode and trivial ACL. Windows roots reject every reparse component,
require ownership by the current principal or Administrators, and require a protected DACL whose
effective data, delete, owner, and DACL-changing rights are limited to the current principal,
LocalSystem, and Administrators. Files and replacement temporaries receive and are verified against
the same protected DACL before they become visible. Windows data-write/delete exclusion also uses
restrictive sharing; protection from `WRITE_DAC` and `WRITE_OWNER` comes from the verified DACL and
ownership contract, not sharing flags.

Within one OS filesystem namespace, fixture capture and publication use exactly one native-selected
host-local authority root per effective UID or SID. `openOrCreatePublicationAuthority()` accepts no
path or environment override. Linux uses the fixed
`/tmp/amazon-agentcore-cli-identity-fixtures-<uid>` child and requires that namespace's `/tmp` itself to
be a local root-owned sticky directory; macOS uses `_CS_DARWIN_USER_TEMP_DIR` plus the fixed
`com.amazon.agentcore-cli/identity-fixtures` suffix; Windows uses the current token's
`FOLDERID_LocalAppData` plus fixed `Amazon\AgentCore CLI\identity-fixtures` components and requires a
local NTFS/ReFS volume. If the platform-selected parent is absent, redirected, nonlocal, or unsafe, the
operation returns `unsupported` or `unsafe`; there is no second location. Separate Linux mount
namespaces may legitimately resolve the fixed `/tmp` path to different authority roots, so this lock
alone is not the final serialization authority for a shared retained fixture tree.

The operation atomically creates or fully reopens and validates the one root and returns its separately
branded handle. The root contains one fixed permanent mode-`0600`/protected-DACL `.publish.lock` plus
`captures/`. The lock name and authority path are never keyed by fixture path or identity. It
serializes capture-authority cleanup and publication staging within that filesystem namespace and is
never unlinked or replaced.

The repository fixture tree has a separately branded retained `NativeFixtureTreeHandle` and must be
owner-controlled with no group, world, inherited, or foreign-principal write/delete authority. Every
publication revalidates both the original path and retained tree identity before cleanup or rename. A
writable parent, changed identity, nontrivial write ACL, unsafe DACL, bind-mount substitution, or
reparse point fails closed. JavaScript has no stable-tree mutation primitive other than
`publishFixtureTransaction`. Native publication opens or atomically creates one fixed
`.agentcore-identity-fixture-publish.lock` directly below that retained handle. Creation is
descriptor-relative, exclusive/no-replace, no-follow, and protected as mode `0600` with a trivial ACL or
the exact protected DACL before use. An existing file is opened descriptor-relative and fully
revalidated. The lock is never unlinked, renamed, or replaced. Because it is co-resident with the
retained tree inode, alternate lexical paths, bind-mount aliases, and separate `/tmp` mount namespaces
that share the tree contend on the same lock. The file is excluded from source control, canonical
fixture bytes, indexes, sentinel scans, source archives, and release packages.

Each capture is exclusively created as `captures/<32-lowercase-hex-id>` below the retained authority
handle with `0700`/the protected DACL and a permanent protected `.capture.lock`. Creation requires the
already-open retained fixture-tree handle and records that exact tree object's native identity in the
protected origin record before returning an open handle while holding the capture lock exclusively.
Capture reads the starting suite index only through `readFixtureSuiteIndex` on that retained handle.
Artifact installation accepts only the open brand. An exact existing digest object is idempotent
success only after full byte verification; a mismatch is `contentMismatch`. Sealing revalidates the
same retained tree object and the retained protected run root, validates canonical `FixtureReadyV1`
and the strict canonical run-ledger tuple, installs the protected noncanonical `RUN_BINDING` record,
installs `READY` last, syncs the directory, atomically consumes the open handle, and returns a sealed
handle that retains the same lock.
A closed, sealed, or consumed open handle returns `invalidState` at runtime; the type surface makes
ordinary cross-state calls unrepresentable. Opening an existing sealed capture requires its canonical
ID, expected `READY` digest, retained protected run root, expected run ID, and expected sealing-time
ledger digest. It acquires the capture lock nonblocking, rejects any digest, root-identity, run-ID,
ledger-digest, or metadata mismatch as `invalidCapture`, returns `busy` when another process owns it,
and returns the validated `FixtureCaptureHandoffV1` beside the sealed handle.

`listSealedFixtureCaptures` is read-only recovery discovery for a retained tree. It examines at most
`FIXTURE_DISCOVERY_MAX_CHILDREN` exact capture-ID children, attempts each capture lock nonblocking,
returns at most `FIXTURE_DISCOVERY_MAX_HANDOFFS` valid same-provenance, same-tree sealed handoffs sorted
by capture ID, and separately counts busy and invalid captures. Exceeding either cap returns
`limitExceeded` with no partial list. It never opens an arbitrary path, follows a link, deletes a
capture, reads AWS state, or treats an invalid root as a valid handoff.
Every returned handoff includes the protected `runId`, opaque `runRootId`, and sealing-time
`ledgerDigest`, so discovery output can be joined exactly with `test:identity:inspect`; counts or
fixture-tree equality alone never select a capture for publication.

`FixtureReadyV1` uses duplicate-aware strict canonical JSON. Object entries are sorted by digest and
unique. Flow entries are sorted by registered flow ID and unique. `nextIndex.flows` must equal exactly
the ordered flow-ID/manifest-digest projection of `flows`; every length and digest must match a fully
verified capture object. `readyDigest` is the SHA-256 of the complete canonical bytes. Capture target
identity and host provenance remain in the protected origin record, not `READY`, so two equivalent
logical recordings retain byte-identical canonical handoffs.

`READY` installation is the seal commit point. A valid open-handle call that fails before it returns
`notSealed` and leaves the open handle authoritative. A closed, sealed, or consumed handle instead
returns the separate `invalidState` outcome, which rejects the call without making a durability claim
about the capture. After `READY` is installed, no valid call returns `notSealed`: complete directory
sync is `sealed/directorySynced`, an unavailable directory-sync guarantee is
`sealed/processCrashOnly`, and a post-seal failure that prevents stronger proof is
`sealed/unknownAfterSeal`. The caller retains every sealed result for publication or explicit discard
and never retries sealing through the consumed open handle.

A protected version-1 origin record, created by native code and excluded from canonical fixture bytes,
contains the capture ID, random generation nonce, creation epoch, authority-root identity,
capture-directory file identity, bound fixture-tree identity, boot-session identity, and local
mount/volume identity as
length-delimited typed fields. Linux uses `/proc/sys/kernel/random/boot_id`,
`STATX_MNT_ID_UNIQUE`, and device/inode identities. macOS uses `gethostuuid`,
`kern.bootsessionuuid`, `ATTR_VOL_UUID`, and file IDs on APFS. Native code accepts
`kern.bootsessionuuid` only as a 37-byte sysctl string containing the standard 36-byte ASCII UUID plus
one terminal NUL after exact separator, case-insensitive hexadecimal, and nonzero validation, then
hashes its parsed 16 bytes;
wall-clock-derived `kern.boottime` is never boot identity. Windows reads the 64-bit
`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` `REG_SZ` as exactly 36 UTF-16 UUID code units plus
one terminal NUL, parses its ASCII subset and case-insensitive hex to 16 nonzero bytes, dynamically
resolves
`NtQuerySystemInformation` from `ntdll.dll`, requests
`SystemBootEnvironmentInformation` information class 90 into the reviewed 32-byte
`SYSTEM_BOOT_ENVIRONMENT_INFORMATION` layout, and accepts only its canonical nonzero
`BootIdentifier` GUID. It combines those values with the volume GUID and `FILE_ID_INFO` on NTFS/ReFS.
The private Windows information class is version-sensitive: symbol absence, status failure, size drift,
malformed GUIDs, or an unavailable machine identity returns `unsupported` without a weaker fallback.
Canonical `MachineGuid` is a CLI support predicate and continuity input, not a Windows guarantee that
the value is unique, immutable, or unclonable. Equality of the complete Windows tuple is not proof of
the same physical host.
Raw host, SID, mount, and volume values are hashed before entering the record. If any required primitive
is unavailable or malformed, capture/publication returns `unsupported`.

The separate protected version-1 `RUN_BINDING` record is also excluded from canonical fixture bytes.
It contains exactly the run ID, opaque protected run-root identity, sealing-time ledger digest, and a
digest binding those values to the origin record and `READY` digest. It is installed once immediately
before `READY`, is never rewritten, and is mandatory for every valid sealed capture. A missing,
duplicate, noncanonical, stale, or mismatched binding makes discovery, opening, and publication reject
the capture.

`openSealedFixtureCaptureRoot` accepts only observable provenance matching the protected origin record,
the same authority root, the same retained capture object at its canonical ID path, and a valid sealed
`READY` whose digest equals the supplied value. It also requires the retained run root, expected run
ID, current canonical ledger bytes, and current ledger digest to equal `RUN_BINDING`; sealing therefore
cannot be recovered by guessing from two same-base captures. Publication additionally requires the
currently opened fixture tree to be the exact object bound at capture creation; an alias to that object
is valid, while a byte-identical different object returns `fixtureTreeMismatch`. A copied,
reboot-stale, currently moved, cross-run, or cross-authority capture is unpublishable when any
observable identity differs. The design does not
guarantee detection when cloned Windows systems reproduce every observable identity component, or when
a trusted owner moves the same retained directory away and back without changing its identity. No
authenticated portable provenance is introduced. Publication accepts only the sealed handle opened
from a capture ID under the authority root, never an arbitrary staging path.

Explicit discard consumes an open or sealed handle while it owns the per-capture lock. The native
abandoned-capture reaper scans only exact capture-ID children, validates each root without following
links, and removes an old unsealed or reboot-stale capture only after acquiring its `.capture.lock`
nonblocking. It never removes a same-boot sealed `READY` capture automatically. A successfully
published capture with known `directorySynced` or `processCrashOnly` durability and a definitive
`staleBase` capture are discarded by their command owner; `unknownAfterCommit` and retryable failures
are retained for explicit retry or audit. All recursive deletion is descriptor-relative inside the
already validated capture root and never follows a child link.

Live `.run.lock`, ledger, and atomic ledger temporaries remain inside the run's separate protected
root.

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
  data write or delete. The verified owner/DACL contract, not sharing flags, excludes unauthorized
  security-descriptor mutation.
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
- On POSIX, symlinks in the originally supplied path are accepted only through the canonical regular
  file opened and retained at selection. Windows rejects every reparse component and target, including
  symlink, junction, mount-point, cloud, and unknown reparse tags; it has no accepted-reparse
  allowlist. Directories, devices, FIFOs, sockets, and later path replacements are rejected.
- Production file sources are supported only on local ext4, XFS, Btrfs, or tmpfs on Linux; local APFS
  on macOS; and local NTFS or ReFS on Windows. The adapter requires descriptor ACL APIs and
  nanosecond change metadata on POSIX, and file-ID, change-time, owner, and DACL APIs on Windows.
  HFS+, network, FUSE, overlay, DrvFS, unknown, or capability-deficient filesystems return
  `fileUnsafe`. HFS+ has only second-granularity content/change timestamps and cannot satisfy the
  same-size in-place-write detection contract.
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

After resolution, the commit lease constructs a private complete-value matcher over every managed value,
including values originating in raw JSON. It checks response-bound values without exposing enumeration,
lookup, serialization, or diagnostic methods and remains reachable only by the commit-local response,
fixture, and normalization closures. Matching uses the complete original value as a substring; it does
not rely on terminal escaping, hashing, entropy, field names, or service behavior. The matcher is
disposed with the lease and is never transferred into a replacement capability.

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

The `binding` transition has an explicit synchronous exception rollback. Until the final no-throw
ownership swap, a local transaction guard owns both the replacement binding and context reservation.
An unexpected exception while validating inventory or constructing the prepared shell disposes the
context reservation, destroys the binding, transitions the replacement to `disposed`, and is mapped to
the static internal error; it never restores a possibly corrupted capability for retry. The final swap
contains only field assignments and state transitions that cannot invoke caller or adapter code. Thus
every exit from `binding` has exactly one owner for both resources.

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
type PaymentSecretSlotId = Extract<
  SecretSlotId,
  "api-key-secret" | "wallet-secret" | "app-secret" | "authorization-private-key"
>;

type ReviewValue =
  | null
  | boolean
  | number
  | string
  | Readonly<{ kind: "array"; items: readonly ReviewValue[] }>
  | Readonly<{
      kind: "object";
      entries: readonly Readonly<{ key: string; value: ReviewValue }>[];
    }>;

type ReviewTarget<W extends MutationWorkflowId> =
  WorkflowDefinitionOf<W>["selector"] extends "createName"
    ? Readonly<{
        family: WorkflowDefinitionOf<W>["family"];
        selector: "createName";
        name: string;
      }>
    : WorkflowDefinitionOf<W>["selector"] extends "name"
      ? Readonly<{
          family: WorkflowDefinitionOf<W>["family"];
          selector: "name";
          name: string;
          arn: string;
        }>
      : WorkflowDefinitionOf<W>["selector"] extends "resourceArn"
        ? Readonly<{
            family: WorkflowDefinitionOf<W>["family"];
            selector: "resourceArn";
            arn: string;
          }>
        : WorkflowDefinitionOf<W>["selector"] extends "tokenVaultId"
          ? Readonly<{
              family: "tokenVault";
              selector: "tokenVaultId";
              tokenVaultId: string;
            }>
          : never;

interface IdentityReviewModel<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly operation: PrimaryOperationOf<W>;
  readonly target: ReviewTarget<W>;
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

type UsageIdentityError =
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
    };

type SecretIdentityError = {
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
};

type ServiceIdentityError = {
  category: "service";
  code: SafeServiceCode | "UnknownServiceError";
  httpStatus?: number;
  requestId?: string;
};

type InternalIdentityError = { category: "internal" };

type SafeIdentityError =
  | UsageIdentityError
  | SecretIdentityError
  | SecretContextError
  | ServiceIdentityError
  | InternalIdentityError;

type IdentityDiagnostic =
  | { kind: "safeError"; error: SafeIdentityError }
  | { kind: "notFound" }
  | { kind: "cancelled" }
  | { kind: "paginationFailed"; reason: PaginationFailureReason }
  | { kind: "sdkCompatibilityRequired" }
  | { kind: "credentialRefreshRequired" }
  | { kind: "unsupportedProvider" }
  | { kind: "unsupportedResourceStatus" }
  | { kind: "unknownCurrentSource"; slot: SecretSlotId }
  | { kind: "reprepareRequired" }
  | { kind: "mutationOutcomeUnknown" }
  | { kind: "committedOutputUnavailable" }
  | { kind: "outputUnavailable" }
  | { kind: "internalFailed" };

type QueryFailure =
  | { kind: "notFound" }
  | { kind: "cancelled" }
  | { kind: "paginationFailed"; reason: PaginationFailureReason }
  | { kind: "sdkCompatibilityRequired" }
  | { kind: "credentialRefreshRequired" }
  | { kind: "validationFailed"; error: UsageIdentityError }
  | { kind: "serviceFailed"; error: ServiceIdentityError }
  | { kind: "internalFailed"; error: InternalIdentityError };

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
  | { kind: "validationFailed"; error: UsageIdentityError }
  | { kind: "serviceFailed"; error: ServiceIdentityError }
  | { kind: "internalFailed"; error: InternalIdentityError }
  | PrepareSecretContextFailure;

type CommitFailure =
  | PrepareFailure
  | { kind: "secretContextFailed"; error: SecretContextError<"mismatch"> }
  | { kind: "secretResolutionFailed"; error: SecretIdentityError };

type QueryOutcome<W extends QueryWorkflowId> =
  | { kind: "succeeded"; value: SafeIdentityDocument<W> }
  | QueryFailure;

type MutationPolicy = Exclude<IdentityWorkflowPolicy, "query">;

type PrepareOutcome<W extends MutationWorkflowId> =
  | {
      kind: "prepared";
      mutation: PreparedMutation<W>;
      secrets: CommitSecretContext;
    }
  | (WorkflowPolicyOf<W> extends "replacement"
      ? { kind: "noChange"; value: SafeIdentityDocument<W> }
      : never)
  | PrepareFailure;

type CommonCommitOutcome<W extends MutationWorkflowId> =
  | { kind: "committed"; value: SafeIdentityDocument<W> }
  | { kind: "mutationOutcomeUnknown" }
  | { kind: "committedOutputUnavailable" }
  | { kind: "alreadyConsumed" }
  | CommitFailure;

type CommitOutcome<W extends MutationWorkflowId> =
  | CommonCommitOutcome<W>
  | (WorkflowPolicyOf<W> extends "replacement"
      ? { kind: "noChange"; value: SafeIdentityDocument<W> }
      : never)
  | (WorkflowPolicyOf<W> extends "direct"
      ? never
      : {
          kind: "reprepareRequired";
          replacement: ReplacementPreparation<Extract<W, RepreparableWorkflowId>>;
        });

type PreActivationCommitOutcome =
  | { kind: "alreadyConsumed" }
  | {
      kind: "secretContextFailed";
      error: SecretContextError<"mismatch" | "unavailable">;
    };

type ActivatedCommitOutcome<W extends MutationWorkflowId> = Exclude<
  CommitOutcome<W>,
  PreActivationCommitOutcome
>;

type CommitAttempt<W extends MutationWorkflowId> =
  | { kind: "notStarted"; outcome: PreActivationCommitOutcome }
  | { kind: "busy" }
  | {
      kind: "settled";
      outcome: ActivatedCommitOutcome<W>;
      execution: SettledMutationExecution<W>;
    };

type BindReplacementOutcome<W extends RepreparableWorkflowId> =
  | {
      kind: "prepared";
      mutation: PreparedMutation<W>;
      secrets: CommitSecretContext;
    }
  | { kind: "alreadyConsumed" }
  | { kind: "secretContextFailed"; error: SecretContextError<"unavailable"> }
  | { kind: "validationFailed"; error: UsageIdentityError }
  | { kind: "internalFailed"; error: InternalIdentityError };

interface IdentityQueryAction<W extends QueryWorkflowId> extends WorkflowBranded<W> {
  execute(
    input: Readonly<WorkflowIntentOf<W>>,
    options?: IdentityCallOptions,
  ): Promise<QueryOutcome<W>>;
}

type IdentityListWorkflowId = WorkflowForFacet<"list">;

type IdentityPickerIntent<W extends IdentityListWorkflowId> = W extends IdentityListWorkflowId
  ? Omit<WorkflowIntentOf<W>, "nextToken" | "all">
  : never;

interface IdentityPickerItemMap {
  readonly "apiKey.list": ApiKeyListV1Dto["credentialProviders"][number];
  readonly "oauth2.list": Oauth2ListV1Dto["credentialProviders"][number];
  readonly "payment.list": PaymentListV1Dto["credentialProviders"][number];
  readonly "workload.list": WorkloadListV1Dto["workloadIdentities"][number];
}

interface IdentityPickerPage<W extends IdentityListWorkflowId> extends WorkflowBranded<W> {
  readonly items: readonly DeepReadonly<IdentityPickerItemMap[W["key"]]>[];
  readonly hasNextPage: boolean;
}

type IdentityPickerPageOutcome<W extends IdentityListWorkflowId> =
  | { kind: "page"; page: IdentityPickerPage<W> }
  | { kind: "done" }
  | { kind: "busy" }
  | QueryFailure;

interface IdentityPickerSession<W extends IdentityListWorkflowId> extends WorkflowBranded<W> {
  next(options?: IdentityCallOptions): Promise<IdentityPickerPageOutcome<W>>;
  dispose(): void;
}

interface IdentityListQueryAction<W extends IdentityListWorkflowId> extends IdentityQueryAction<W> {
  openPicker(input: Readonly<IdentityPickerIntent<W>>): IdentityPickerSession<W>;
}

interface IdentityMutationAction<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  prepare(
    input: Readonly<WorkflowIntentOf<W>>,
    secrets: CommitSecretContext,
    options?: IdentityCallOptions,
  ): Promise<PrepareOutcome<W>>;
}

declare const PREPARED_MUTATION_COMMIT: unique symbol;

interface PreparedMutation<W extends MutationWorkflowId> extends WorkflowBranded<W> {
  readonly review: IdentityReviewModel<W>;
  [PREPARED_MUTATION_COMMIT](
    secrets: CommitSecretContext,
    options?: IdentityCallOptions,
  ): Promise<CommitAttempt<W>>;
  dispose(): void;
}

interface ReplacementPreparation<W extends RepreparableWorkflowId> extends WorkflowBranded<W> {
  readonly review: IdentityReviewModel<W>;
  bindContext(secrets: CommitSecretContext): BindReplacementOutcome<W>;
  dispose(): void;
}

declare const IDENTITY_HANDLER_WORKFLOWS: unique symbol;

type IdentityLeafCompletion =
  | { kind: "succeeded" }
  | { kind: "failed"; diagnostic: IdentityDiagnostic };

interface IdentityCommandHandler<
  Workflows extends readonly [IdentityWorkflowId, ...IdentityWorkflowId[]],
> {
  readonly workflows: Workflows;
  readonly [IDENTITY_HANDLER_WORKFLOWS]: (workflows: Workflows) => Workflows;
  invoke(options?: IdentityCallOptions): Promise<IdentityLeafCompletion>;
}
```

There is one separately constructed action for every catalog workflow: 17
`IdentityQueryAction<W>` values and 29 `IdentityMutationAction<W>` values. Their input, output,
operation, auxiliary Get, facet, and policy all derive from `W`; no action returns an SDK output type or
accepts independent input/output/policy generics. Mutations with no secret slots receive the same
one-use context in an empty state, keeping one ownership protocol instead of a second capability type.
The three input catalogs contain only CLI-authored option IDs, schema paths, and secret slot IDs.

Ordinary leaves receive an `IdentityCommandHandler<readonly [W]>`. Each Tag, Untag, and List Tags leaf
receives an exact two-ID handler ordered `[nameWorkflow, resourceArnWorkflow]`. Parsing first produces a
closed selector discriminant and then invokes one of two separately branded actions; no action accepts
a selector union or runtime-optional policy. The route registry maps command leaves to exact workflow
ID tuples, so its parity test understands that these leaves own two workflows. Identity's branded
handler wrapper is checked before the repository's broad router `Handler` type erases authoring detail.

The prepared capability closes over the `MutationExecutionSupervisorPort` injected into its action and
its private `MutationPlanToken`. Its symbol-keyed activation hook is callable only by the exact
root-created `MutationPresentationActionLease`; presentation code cannot invoke it directly. The
lease's `commit()` calls the port only after nonmutating pair/state verification and before
capability/context claim. `activated` returns an action-owned
`ActiveMutationExecution`; `busy` returns the distinct payload-free `CommitAttempt` branch, performs no
ownership transition, secret I/O, AWS call, state update, or output write, and leaves the pair retryable
after the earlier execution retires. A settled attempt carries its opaque execution token beside the
closed domain outcome solely for the root presentation controller. Callers pass only secret context and
cancellation. The action and transport receive private writer closures for the activated scope, while
the output supervisor sees only its read-only view. No presenter or caller can supply, replace, or
mutate certainty. Renderers select static guidance from the discriminants. Validation, service, secret,
and internal outcome payloads use disjoint category-specific types; no arbitrary message, option
spelling, schema key, environment name, file path, or service body can inhabit `SafeIdentityError`.

The operation-policy mapping is exact:

| Policy              | Operations                              | Prepare `noChange` | Commit `noChange` | `reprepareRequired` |
| ------------------- | --------------------------------------- | ------------------ | ----------------- | ------------------- |
| `direct`            | All Creates and direct-ARN Tag/Untag    | Impossible         | Impossible        | Impossible          |
| `continuityGuarded` | All Deletes and name-selected Tag/Untag | Impossible         | Impossible        | Allowed             |
| `replacement`       | All Updates and Set CMK                 | Allowed            | Allowed           | Allowed             |

Selector parsing chooses the Tag/Untag/List Tags workflow before action invocation, so a concrete
capability never has a runtime-optional policy. Conditional outcome types derive from the selected
workflow and make impossible `noChange` and `reprepareRequired` states uninhabitable instead of relying
on prose.

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
`AbortSignal` to every read and paginator send, consumes only closed `ReadTransportOutcome` and
`ReadPageOutcome` values, fully buffers and normalizes all requested pages inside the action, and
disposes the cursor and binding exactly once after success, validation failure, pagination failure,
cancellation, service failure, compatibility failure, or internal failure. A final action-level
`catch unknown` maps only an adapter contract violation to static `internalFailed`; it never renders the
rejection. No cursor, client, or binding escapes the action. The action returns no partial all-results
value after cancellation or pagination failure.
Before entering that binding-owning `try/finally`, the action exhaustively maps
`BindingCreationOutcome`: `created` transfers exactly one binding into the guard; the other three
variants return their matching closed query or preparation failure and own no binding.

A list action additionally exposes `openPicker()`, which synchronously creates an opaque
`IdentityPickerSession` without invoking SDK or caller code. The first `next()` creates the binding and
cursor; the session then owns them, the visited decoded-token set, accepted-body evidence, cumulative
page/item/wire/output counters, token-free aggregate serializer state, and normalized page cache until
terminal outcome or disposal. Ink receives no transport cursor, `ReadPageEvidence`, raw or encoded
continuation token, counter, or binding. A concurrent `next()` returns `busy` without advancing state.
Back navigation reads already delivered frozen pages and performs no SDK call or counter change.
Disposal, cancellation, and every terminal result close the cursor and binding exactly once.

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
8. It requests the action's exact operation-specific binding and exhaustively handles the total
   `BindingCreationOutcome`.
9. It produces canonical commit state and a review model derived from it.
10. It mints the private plan token, binds the context to that token and the ordered-requirement
    fingerprint, and returns the pair.

Update rejects local syntax errors, option conflicts, and provider-independent invalid values before
Get. At action entry it first reserves the context synchronously, then performs those local checks,
requests one exact current-state mutation binding, handles its closed creation outcome, performs its
initial Get, identifies the actual
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
rebase through `readCompatibilityGuardedCurrent`; no other call path has that method. Those operations
select the strict `RawWireSchema` branch of the common inner classifier middleware described above.

The inner middleware applies the common body normalizer to every guarded success or error while
`bodyBytes <= MAX_IDENTITY_RESPONSE_BYTES`; 1,048,576 bytes is accepted and the next byte fails. On
overflow it immediately destroys a Node-readable body or cancels a Web stream, without draining or
retaining additional chunks. For the exact expected `200` it parses the original copied bytes,
validates them with the operation-specific `RawWireSchema`, restores those same bytes as a fresh
`Uint8Array`, and only then permits generated deserialization. An informational status or alternate 2xx
is `sdkCompatibilityRequired` and never reaches Update reconstruction. For `300..599` it restores the
original copied bytes without success-schema validation and permits bounded SDK error deserialization.
An oversized error response becomes a closed static `serviceFailed` result carrying at most validated
status/request-ID metadata; its body is never passed to Smithy's collector.

Golden capture composes around, not instead of, that ordering. Its request-handler wrapper invokes the
live handler, bounds the body with the same normalizer, and restores a fresh byte-for-byte copy without
decoding, sanitizing, or writing a fixture. The guarded middleware therefore sees the original wire
bytes before generated deserialization. A separate outer middleware registered relative `before`
`deserializerMiddleware` observes only a normally deserialized SDK output or an allowlisted modeled
error after the inner guard has passed; it converts that value into the safe fixture algebra. A guard,
body, status, deserialization, or compatibility failure records nothing. Replay has the fixture request
handler synthesize safe wire bytes, then traverses the same inner guard, generated deserializer,
transport classifier, action normalizer, and outer verification middleware.

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

Both fingerprints use a CLI-owned canonical binary value codec, not ambient `JSON.stringify` order.
The closed algebra has distinct type tags for null, booleans, finite numbers, strings, arrays, and
objects; rejects unpaired UTF-16 surrogates; encodes strings as length-prefixed UTF-8; preserves array
order; and sorts object entries by their encoded key bytes before encoding a count and length-prefixed
key/value pairs. Numbers use one canonical finite IEEE-754 representation with `-0` normalized to
`0`. The hash preimage starts with a length-prefixed ASCII domain:
`agentcore-cli.identity.request-skeleton.v1` or
`agentcore-cli.identity.secret-requirements.v1`. This makes type, boundary, ordering, and cross-purpose
collisions unambiguous.

All plan data and nested values are frozen. The capability contains no literal, prompt, stdin, env, or
file secret value. The TUI renders its review model and confirms it. An explicit Commander mutation
authorizes its capability without an additional review prompt, except `token-vault set-cmk`.

Capability ownership uses this state machine:

```text
prepared --action lease commit()--> committing --> consumed
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
already-consumed replacement changes neither object. An unexpected synchronous exception follows the
terminal rollback above. Disposing or rebinding a consumed replacement is inert and cannot affect its
returned prepared pair.

### One-Shot Commit

The root registers a `MutationPresentationActionLease` before commit. Its `commit()` first synchronously
verifies the supplied context's private token and
requirement fingerprint without changing either object. A mismatch returns
`secretContextFailed/mismatch`; even an already-consumed or disposed old capability does not dispose a
foreign context. With a matching context, a capability not in `prepared` returns `alreadyConsumed` and
also leaves that context unchanged. A matching but unavailable context is detected before activation;
the coordinator consumes the unusable capability, destroys its binding, and returns
`secretContextFailed/unavailable`.

For a matching, prepared, presently claimable pair, commit calls
`MutationExecutionSupervisorPort.activate(workflow, planToken)` before changing either ownership state.
`busy` returns `{ kind: "busy" }`; the capability remains `prepared`, the context remains open-bound,
and the caller may retry only through a new explicit submit after the previous execution retires.
`activated` gives commit one
`ActiveMutationExecution`. In the same synchronous turn, with no caller code or `await` between
activation and claim, the shared coordinator atomically claims `prepared`, moves the binding into a
commit-local ownership lease, claims the context, and transitions the capability through `committing`
to terminal ownership. The post-activation claim consists only of no-throw state transitions already
validated in that turn. Commit calls `settle()` in `finally` for every activated execution, including
every pre-mutation failure, and returns its token in the `settled` attempt. The root controller then owns
the already-defined correlated begin/receipt/retire protocol around Commander output or one Ink frame;
none of those transitions is exposed through the action-facing activation port.

Every later call with the original matching context returns `alreadyConsumed` without reading secrets
or calling AWS, including concurrent calls made while the first is pending and calls made after
explicit capability disposal. Because the winning state transition, binding transfer, and secret
claim are one synchronous turn, a duplicate observes an inert claimed shell and cannot disrupt the
winner. An original matching context that is still open after capability disposal remains
presentation-owned and unchanged by the rejected commit. Ink submit handlers also use a synchronous
ref latch so buffered confirmation input cannot enter commit twice.

For Update, commit:

1. Verifies the matching pair, activates the supervisor, and claims capability, binding, and secret
   ownership synchronously as described above.
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

Commit attempts are a closed union separating pre-activation rejection, lane `busy`, and a settled
authorized execution. The settled branch's domain outcome remains a closed union.
`ReprepareRequired` contains an unbound replacement capability only
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

Validation, guard, credential, cancellation, and context failures that occur before mutation
authorization retain certainty `none` and map through their normal closed outcomes. Immediately before
calling `mutate()`, the action marks the scope `outcomeUnknown`. From that point, even a synchronous
command-construction failure or rejection before the underlying HTTP handler is conservatively
`mutationOutcomeUnknown`; handler evidence never downgrades the monotonic scope. Any missing or
incomplete response and every complete non-2xx response, including a modeled 4xx, has the same outcome.
A client-fault Smithy trait or HTTP status does not establish rollback. Static guidance states that the
mutation may have applied and requires a fresh Get before any user-directed retry. This remains true
when a service applied the mutation but failed while producing an error response.

Only the operation's exact modeled success status plus bounded normal body completion advances the
scope to `committed`. If generated deserialization, output validation, or normalization is then
unusable, commit returns `committedOutputUnavailable`; static guidance states that the mutation
committed but its response could not be represented. An alternate 2xx never advances certainty and
returns `mutationOutcomeUnknown`. Neither outcome is automatically retried, mapped to
`sdkCompatibilityRequired`, or presented as proof that no state changed.

Cancellation is phase-aware. Cancellation during preparation, guarded reads, source acquisition, or
before mutation authorization returns `cancelled`. Once the scope is marked and `mutate()` is invoked,
an abort or transport rejection without a complete exact-status response returns
`mutationOutcomeUnknown`, never `cancelled`.

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
action returns `NoChange` and makes no Update call. Commander emits the safe Update-normalized current
state as its one JSON document. The TUI reports that there are no changes. A secret input never takes
this path because equality is unknowable.

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

The service replaces the complete return-URL list. The Update merge has one omission state and two
explicit user intents:

- Omitted internal merge state: keep current URLs. A no-option Update is rejected before Get, so this
  state cannot by itself authorize a command.
- Replacement list: replace with the supplied URLs.
- Clear: send an empty list through an explicit clear option.

The TUI loads the current list and edits it as a complete collection. Replacement rejects duplicates
and more than five URLs.

### Token Vault

`get` defaults to the service's `default` vault. `set-cmk` calls `SetTokenVaultCMK` and validates:

- `CustomerManagedKey` first requires one full key ARN matching the broad generated pattern, then
  applies the CLI-owned non-empty-region and `key/<UUID-form-single-region-id>` restrictions. A bare
  key ID, alias name, alias ARN, non-key KMS ARN, and multi-Region `mrk-...` key ID are rejected before
  confirmation.
- `ServiceManagedKey` forbids `--kms-key-arn` and sends no `kmsKeyArn` member.

The key-type/ARN relation and single-region-key restriction are CLI-owned fail-fast validation over the
pinned public API shape. The CLI does not additionally require the ARN region, partition, or account to
equal the current AgentCore endpoint because no reviewed service contract establishes those relations;
the service and KMS authorization remain authoritative for usability.

The TUI requires destructive-change confirmation before sending `set-cmk`.
Commander also confirmation-gates `set-cmk`: an interactive terminal prompts unless `--yes` is
present, and noninteractive execution fails before the AWS call unless `--yes` is present. `--json`
does not imply consent.

## Pagination

The transport exposes distinct operations:

- `listPage`: one service page plus an encoded `nextToken`, used by paged Commander output.
- `listAll`: generated paginator consumption, used by Commander `--all`, cleanup, and completeness
  checks.
- `openPicker`: an action-owned session over one binding/cursor, used only by TUI pickers.

`--all` is mutually exclusive with `--next-token`. `--max-results` remains the service page size, not
an aggregate result limit. All-results JSON uses the normal response envelope with one concatenated
item array and no `nextToken`. No list method silently changes from page semantics to all-results
semantics. Tests cover both.

`listAll` uses the generated paginator for the selected operation and buffers pages before rendering.
The adapter and picker session compare decoded internal tokens, track every non-empty token, and reject
a repeated token, including same-token and multi-token cycles, before returning the violating result.
They do not rely only on the generated `stopOnSameToken` option because that option does not detect a
cycle such as A, B, A. Encoding happens only at the Commander V1 boundary; decoding happens before
request construction.

Aggregate traversal is bounded by:

```ts
const MAX_IDENTITY_ALL_PAGES = 1_000;
const MAX_IDENTITY_ALL_ITEMS = 10_000;
const MAX_IDENTITY_ALL_WIRE_BYTES = 16_777_216;
const MAX_IDENTITY_ALL_OUTPUT_BYTES = 16_777_216;
```

Equality is accepted. Page count includes the first and terminal pages; a nonempty continuation token
on page 1,000 returns `paginationFailed/pageLimit` without requesting page 1,001. Item count sums only
the operation registry's collection member. Wire bytes sum the accepted raw response-body lengths.
Output bytes are the exact UTF-8 bytes produced by the normal one-chunk V1 JSON serializer after
concatenation. The first excess returns the matching `pageLimit`, `itemLimit`, `wireByteLimit`, or
`outputByteLimit` reason, emits no partial all-results value, and discards the all-page fixture batch.
Picker sessions apply all four limits. Their output-byte counter is the exact UTF-8 serialization of
the cumulative token-free list DTO through the same V1 serializer; the service token is never retained
in presentation state. Checks run in deterministic order: cycle, page, item, wire bytes, output bytes.
Equality is accepted. A page that crosses any limit is never delivered, the session becomes terminal,
and capture poisons the flow; earlier valid frozen pages may remain visible for navigation but cannot be
submitted as a complete result.

Pinned Smithy paginators mutate the input object while advancing `nextToken` and page size. The
adapter therefore creates one shallow mutable clone of the already-validated list input and passes
only that clone to the generated paginator. Caller-owned and frozen inputs remain unchanged. The
query action passes its `AbortSignal` as the paginator's additional call option, consumes the entire
paginator inside its binding-owning `try/finally`, and returns `cancelled` or `paginationFailed`
without a partial result.

Production and fixture token transforms have one fixed order:

```text
normal response: raw SDK token -> production encode -> Commander V1 JSON
normal request: Commander token -> production decode -> SDK input
capture response: physical SDK token -> fixture logical token -> production encode
capture request: production decode -> logical fixture identity -> physical SDK token
```

Cycle detection compares the decoded internal token. The complete-value matcher inspects physical and
logical raw values before production encoding and the encoded representation before output.

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

Paged pickers consume only `IdentityPickerSession` pages. They cache frozen normalized pages for back
navigation and never store, display, decode, or resubmit a service or Commander continuation token.
Resizing can change layout but does not mutate the session's fixed service page size or reset any
traversal counter; starting a differently sized traversal disposes the old session and opens a new one.

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

Identity formatter tables are exhaustive and static:

| Usage reason                   | Guidance                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `conflictingInput`             | `Conflicting Identity options were provided. Run with --help for usage.`          |
| `inapplicableInput`            | `An option is not valid for the selected Identity provider or operation.`         |
| `invalidJson`                  | `An Identity JSON option is invalid. Review the documented schema and try again.` |
| `invalidValue`                 | `An Identity option value is invalid. Run with --help for accepted values.`       |
| `missingInput`                 | `A required Identity option is missing. Run with --help for usage.`               |
| `storageModeChangeUnsupported` | `Changing this secret storage mode is not supported for the existing resource.`   |
| `missingSecrets`               | `One or more required secret values were not provided.`                           |

| Secret reason            | Guidance                                                              |
| ------------------------ | --------------------------------------------------------------------- |
| `environmentUnavailable` | `A required secret environment value is unavailable.`                 |
| `fileChanged`            | `A secret file changed before it could be read. Rerun the command.`   |
| `fileUnavailable`        | `A required secret file is unavailable.`                              |
| `fileUnsafe`             | `A required secret file did not pass local safety checks.`            |
| `invalidValue`           | `A supplied secret value does not satisfy the provider requirements.` |
| `promptUnavailable`      | `A required hidden secret prompt is unavailable in this invocation.`  |
| `stdinUnavailable`       | `A required secret value could not be read from standard input.`      |

| Pagination reason | Guidance                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `cycle`           | `The service returned a repeated pagination token. No partial result was emitted.`         |
| `pageLimit`       | `The Identity pagination page limit was exceeded. No partial result was emitted.`          |
| `itemLimit`       | `The Identity pagination item limit was exceeded. No partial result was emitted.`          |
| `wireByteLimit`   | `The Identity pagination response-byte limit was exceeded. No partial result was emitted.` |
| `outputByteLimit` | `The Identity pagination output-byte limit was exceeded. No partial result was emitted.`   |

| Service code                                                      | Guidance                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AccessDeniedException`, `UnauthorizedException`                  | `AWS denied the Identity operation. Review credentials and permissions.`     |
| `ConcurrentModificationException`                                 | `The Identity resource changed concurrently. Read it again before retrying.` |
| `ConflictException`                                               | `The Identity operation conflicts with the resource's current state.`        |
| `DecryptionFailure`, `EncryptionFailure`                          | `AWS could not process the configured secret encryption.`                    |
| `InternalServerException`                                         | `The Identity service could not complete the operation. Try again.`          |
| `ResourceLimitExceededException`, `ServiceQuotaExceededException` | `An AWS resource or service quota prevented the Identity operation.`         |
| `ResourceNotFoundException`                                       | Normalized to the `notFound` diagnostic below.                               |
| `ThrottlingException`                                             | `The Identity service throttled the operation. Try again.`                   |
| `ValidationException`                                             | `AWS rejected the Identity request. Review the supplied configuration.`      |
| `UnknownServiceError`                                             | `The Identity service could not complete the operation.`                     |

Usage diagnostics may append only the CLI-owned display label for their optional `IdentityOptionId` or
`IdentitySchemaPath`; secret diagnostics may append only the catalog label for their `SecretSlotId`.
They never append raw values. Service diagnostics append validated metadata in exactly this order when
present: `code`, `httpStatus`, `requestId`. No other exception field participates.

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

Every Commander Identity leaf returns one closed `IdentityLeafCompletion`; the router monotonically
records failure and cannot later reset it to success. Normal leaves use only the repository's existing
exit codes `0` and `1`:

| Leaf outcome                                                                            | Exit and rendering                                                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `succeeded`, `committed`, or `noChange` with a flushed document                         | `0`; exactly one JSON document                                                                                    |
| `validationFailed`, `secretResolutionFailed`, or `serviceFailed`                        | `1`; the matching closed formatter entry on stderr                                                                |
| `notFound`                                                                              | `1`; `The requested Identity resource was not found.`                                                             |
| `cancelled`                                                                             | `1`; `The operation was cancelled.`                                                                               |
| `paginationFailed`                                                                      | `1`; the matching pagination guidance                                                                             |
| `sdkCompatibilityRequired`                                                              | `1`; `The installed AgentCore CLI and AWS service model are incompatible. Upgrade the CLI and rerun the command.` |
| `credentialRefreshRequired`                                                             | `1`; `AWS credentials must be refreshed. Refresh them and rerun the command.`                                     |
| `unsupportedProvider`                                                                   | `1`; `This provider can be read but is not supported for this write operation.`                                   |
| `unsupportedResourceStatus`                                                             | `1`; `The resource is not in a writable state. Read it before trying again.`                                      |
| `unknownCurrentSource`                                                                  | `1`; `The current secret source cannot be determined safely for <catalog slot>.`                                  |
| `reprepareRequired`                                                                     | `1`; `The resource changed after review. Rerun the command against the latest state.`                             |
| `mutationOutcomeUnknown`                                                                | `1`; `The mutation may have applied. Perform a fresh Get before another mutation.`                                |
| `committedOutputUnavailable`                                                            | `1`; `The mutation committed, but its output is unavailable. Perform a fresh Get before another mutation.`        |
| Generic output failure                                                                  | `1`; `Command output could not be written.`                                                                       |
| `busy`, `alreadyConsumed`, secret-context mismatch/unavailability, or unknown rejection | `1`; the static internal error                                                                                    |

A failed leaf emits no success document. If stderr is also unavailable, the diagnostic may be
undeliverable but the exit remains `1`. Commander parser failures use the closed table above and exit
`1`; help and version remain `0`. TUI cancellation/navigation is nonfatal to the process, action errors
remain renderable states, and `reprepareRequired` remains an interactive continuation. Only a fatal Ink
boundary or output-supervisor failure fixes the eventual process exit to `1`.

React error boundaries do not catch asynchronous callback or query failures. Every Identity query,
mutation, event handler, submit callback, and hidden-prompt continuation catches `unknown` at the
point where the rejection is observed and maps it to a closed `SafeIdentityError` union before
updating component state. The union contains only CLI-authored codes, static guidance, and separately
validated primitive metadata. Identity components never accept, store, interpolate, or render a raw
`Error`. For each authorized commit, the composition root gives the output supervisor, prepared action,
and exact mutation binding access to the same nominal `MutationExecutionScope`; presentation code sees
only its read-only `MutationCertaintyView`. The action advances it from `none` to `outcomeUnknown`
immediately before invoking `mutate()`. The binding can advance it to `committed` only after the
operation's exact expected status and bounded normal body completion. Presenters never reinforce,
downgrade, replace, or otherwise mutate certainty. A mutation action never throws after invoking
`mutate()`: adapter rejection, classification failure, and the action-boundary backstop all return a
closed outcome and leave the view at least `outcomeUnknown`. The outer runnable/Ink boundary therefore
preserves unknown-outcome or committed-output-unavailable guidance across async callbacks, state
updates, rendering, serialization, stdout, stderr, and teardown failures.

Safe response normalization also applies to successful reads:

- Raw `failureReason` is never inspected for rendering or printed. Its presence maps through the
  allowlisted OAuth status to the static V1 guidance above.
- Unknown union bodies are replaced with their sanitized member-name marker.
- Metadata outside the explicit safe response contract is omitted instead of passed through.

Malformed JSON and schema validation errors identify the option and a CLI-owned schema path. They do
not include JavaScript parser text, typecheck excerpts, raw values, or unknown keys copied from
untrusted input.

All dynamic strings destined for Ink or Commander output cross one injective terminal-safe rendering
boundary. Its security table is generated and checked in from Unicode 17.0.0
`DerivedCoreProperties.txt` and `UnicodeData.txt`, with reviewed source SHA-256 digests. The closed
interval table is the union of the `Default_Ignorable_Code_Point` derived property and every code point
whose general category is `Cf`. Runtime behavior never depends on the host ICU version, JavaScript
Unicode property escapes, locale, or an ambient regular-expression engine.

The encoder scans original UTF-16 code units, preserves valid surrogate pairs for code-point
classification, and replaces every unpaired surrogate with a visible ASCII escape before UTF-8
encoding. Thus a lone U+D800 cannot collapse to the same terminal bytes as U+FFFD. In the same pass it
replaces every literal backslash, C0 control, `DEL`, C1 control, ANSI/OSC introducer, U+2028 line
separator, U+2029 paragraph separator, bidi formatting/isolation control, and code point in the pinned
Unicode security table with `\u{...}` using uppercase hexadecimal and at least four digits. Coverage
therefore includes U+034F COMBINING GRAPHEME JOINER, U+061C, U+200B, U+200E, U+200F, U+202A through
U+202E, reserved default-ignorable U+2065, U+2066 through U+2069, U+FE0F, U+FEFF, and supplementary
variation selector U+E0100. The encoder never rescans escape text it generated. Therefore an actual
unsafe code point, backslash, or unpaired surrogate cannot collide with a different input containing
literal text such as `\u{001B}`, `\u{005C}`, or `\u{E0100}` in scalar fields, arrays, review values,
JSON, Ink, or map keys. Escaping an ESC or C1 introducer neutralizes the entire terminal sequence.
Every other code point is emitted verbatim, with no normalization, case folding, dropping, replacement,
or truncation; canonically equivalent but distinct inputs such as precomposed U+00E9 and
`U+0065 U+0301` remain distinct.

Semantic validation decodes code points and rejects the same control, separator, bidi, and generated
Unicode-security sets outright in user-supplied URLs and tag keys or values before applying any modeled
pattern. Safe rendering still applies to service-returned legacy data and every other dynamic field.

Static DTO property names bypass this transform. Dynamic records such as tags first validate an
ordered entry array, encode every key with the same `S` encoder, reject duplicates, and then install
properties with
`Object.defineProperty(target, key, { value, enumerable: true, writable: false, configurable: false })`
on an `Object.create(null)` target before freezing it. They never trust Zod record parsing, the stock
SDK map codec, inherited enumeration, or ordinary assignment for `__proto__`, `constructor`, or other
prototype-sensitive keys. Final `JSON.stringify` therefore includes each validated own key exactly
once.

`--debug` never relaxes these rules. Any future diagnostic rendering applies schema-sensitive
redaction and exact resolved-value redaction before serialization, but the default remains to omit
unknown text entirely.

## Secret-Safe Record and Replay

The current fixture recorder hashes the complete SDK input and stores service error messages
verbatim. Identity must not use that behavior unchanged.

An Identity fixture schema registry maps each supported operation name to its public SDK request
schema. Recording fails closed before filesystem access when the operation, schema member, union
member, or sensitive path is unknown.

Every logical capture or replay `Client.send()` owns one private one-use acceptance transaction. A
fixture initialize middleware creates it once and wraps the SDK `retryMiddleware`; request
handler dispatch and deserialize middleware execute once per pinned-stack attempt without creating
another transaction. The pinned stack serializes once before its retry loop; the transaction remains
correct if a future compatible Smithy stack also repeats serialization:

```text
open(optional replay reservation) -> terminalStaged -> finalized
                 \                    \-------------> discarded
                   \---------------------------------> discarded
```

Capture and replay share that logical-call transaction but have different flow consequences.
Capture discard poisons the unpublished capture flow. Replay owns a separate exact occurrence state:

```text
available -> reserved(callId) -> consumed
                              \-> poisoned(callId)
```

`callId` is an unforgeable object-identity token private to one logical `Client.send()`. Reservation is
synchronous and may select only the next expected operation/digest/occurrence. Finalization may move
only that call's reservation to `consumed`. Any transaction discard after reservation atomically moves
that reservation to `poisoned`; it is never released to `available`. A missing, extra, reordered, or
foreign call poisons the replay flow before returning its static failure. Once poisoned, every later
reservation and final flow-verification request fails without synthesizing another fixture response,
even when later calls would otherwise match the remaining manifest exactly.

Each retry attempt's outer deserialize middleware performs only a detached safe projection. It may
return immutable candidate evidence correlated to that exact SDK-shaped output or modeled exception,
but it never reserves or consumes a replay entry, changes the logical transaction, installs an object,
or appends a flow entry. The retry middleware alone selects the terminal returned output or rejection.
Only the wrapping initialize middleware may move the corresponding terminal candidate from `open` to
`terminalStaged`; every superseded attempt candidate becomes unreachable without changing fixture
state. A terminal transport failure, unmodeled error, projection failure, or call cancellation moves
directly from `open` to `discarded`.

Correlation uses one call-local private `WeakMap<object, DetachedFixtureCandidate>` keyed by the exact
reconstructed output or allowlisted modeled-exception object returned or thrown into retry middleware.
Writing or deleting that ephemeral correlation entry is not a fixture-state transition. The initialize
wrapper looks up only the exact terminal object, deletes the map, and either stages that one detached
candidate or discards the call. A primitive/foreign rejection cannot be a key and has no candidate.

`terminalStaged` is memory-only. It assigns no occurrence, installs no artifact, appends no flow entry,
and consumes no replay entry. The binding/recorder closure privately associates the reconstructed
terminal SDK output with its receipt; the exact workflow normalizer and safe error mapper receive the
matching acceptance callback through their constructor closure. No receipt, callback, retry-attempt
evidence, or fixture state enters an intent, public action port/result, plan, review, DTO, fixture, or
presentation type. Production injects the same logical-call coordinator shape with no-op
staging/finalization, keeping workflow logic identical. The workflow wrapper disposes the coordinator
in `finally`; every transaction not explicitly finalized is discarded.

For every Identity call, staging:

1. Traverses the registered request schema and replaces sensitive leaves with stable path/type
   markers.
2. Canonicalizes the redacted request with deterministic object-key order and existing date-safe
   scalar rules.
3. Computes a full lowercase SHA-256 digest over operation name plus canonical request.
4. Encodes the SDK-shaped response or modeled error through the operation's safe fixture codec.
5. Applies the commit lease's opaque complete-value matcher, when present, to every registered source
   and emitted scalar representation defined under Normalized V1 Output.
6. Translates only registered page tokens and service timestamp paths through the flow's logical maps.
7. Reconstructs and rechecks the equivalent sanitized SDK-shaped value.
8. Serializes the complete candidate bytes in memory, computes their content digest, and scans those
   bytes and the candidate basename for registered high-entropy sentinels.
9. Retains the detached terminal candidate only in the private transaction. A replay reservation
   remains owned separately by that same logical transaction.

No raw request body or service error message is stored. Error fixtures contain only an allowlisted
modeled code and fields needed to reproduce the safe classification. Existing non-Identity fixture
keys remain unchanged.

A successful candidate finalizes only after its operation-specific V1 or current-state normalizer
accepts the reconstructed SDK value. A prerequisite success may therefore finalize before a later safe
business outcome such as `noChange`, `reprepareRequired`, `unsupportedProvider`, or
`unsupportedResourceStatus`. A complete allowlisted modeled error, including prerequisite
`ResourceNotFoundException`, finalizes only after the adapter maps it to the closed safe error outcome.
Transport failures, unmodeled errors, malformed or incompatible responses, guard failures,
deserialization/map-revival failures, reflection failures, and normalization failures discard the
candidate.

Capture finalization atomically installs the immutable object and then appends its ordered in-memory
flow entry; failure of either step poisons the unpublished flow and prevents `READY`. Replay acquires
exactly one reservation before the first attempt, reuses that same immutable record for every retry
attempt, and consumes it exactly once only when the terminal staged value is finalized; logical-call
discard poisons that exact reservation and the entire replay flow. A retryable modeled fixture can
therefore be synthesized repeatedly by Smithy while
advancing its manifest occurrence only once. For `--all`, all page candidates remain one ordered batch
until every page and the concatenated V1 document pass normalization, cycle detection, and all
aggregate limits. A discarded candidate poisons its capture flow, and a poisoned flow cannot create
`READY` even if another candidate was already installed inside that unique, unpublished capture root.

| Observation                                                               | Fixture result                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Exact success accepted by its action/current-state normalizer             | Finalized `success`                                               |
| Accepted prerequisite success followed by a safe business outcome         | Finalized `success`                                               |
| Complete allowlisted modeled read error, including prerequisite not-found | Finalized `modeledError`                                          |
| Complete allowlisted modeled mutation error                               | Finalized `modeledError`; action remains `mutationOutcomeUnknown` |
| Exact mutation success followed by response normalization failure         | Discard; `committedOutputUnavailable`                             |
| Guard, status, body, decode, reflection, pagination-cap, or cycle failure | Discard; no fixture                                               |
| Capture finalization failure after exact mutation success                 | No `READY`; `committedOutputUnavailable`                          |
| Flow assertion or presentation/output failure before suite seal           | Capture is poisoned and creates no `READY`                        |
| Capture-result output failure after suite seal                            | Existing `READY` remains valid, retained, and discoverable        |

Fixture payloads are not V1 presentation DTOs. Capture and replay use real AWS SDK clients with three
ordered layers:

1. The capture request-handler wrapper invokes the live handler, bounds every response body under
   `MAX_IDENTITY_RESPONSE_BYTES`, and restores the original status, headers, and a fresh byte-for-byte
   body copy. It does not parse, sanitize, or record the response.
2. The normal inner compatibility/status middleware sees those original bytes first. Guarded
   OAuth/payment Gets reject additive or malformed successful wire data before generated
   deserialization. Mutation classification sees the exact status and normal-EOF evidence.
3. An outer per-attempt post-deserialization projector observes only a normal SDK-shaped output or an
   allowlisted modeled exception after all inner checks. It projects registered safe fields into the
   fixture algebra, rejects complete managed-value reflection through the private matcher, reconstructs
   the equivalent sanitized SDK-shaped value, rechecks that reconstructed value, and returns or throws
   only that reconstructed value plus private detached candidate evidence. It mutates no fixture
   transaction. After retry middleware selects that attempt as terminal, the logical-call initialize
   wrapper stages its evidence. The exact action normalizer or safe error mapper then finalizes the
   private receipt. Request IDs, arbitrary messages, raw unknown-union bodies, reflected secrets, and
   unregistered fields therefore cannot make capture output differ from replay. Unknown exceptions and
   every guard, status, body, deserialization, sanitization, reflection, normalization, or staging
   failure finalize no fixture call.

Replay invokes the same client, middleware ordering, dispatch tracker, deserializer, action normalizer,
and outer fixture verifier, but its request handler synthesizes the logical call's one reserved safe
wire response without network access on every retry attempt. The synthesized bytes must also fit
`MAX_IDENTITY_RESPONSE_BYTES` and traverse the body normalizer and, for a secret-bearing replayed
mutation, the same private complete-value matcher; replay does not inject an already-deserialized
output. The versioned fixture
algebra records the transport evidence required by the production classifier and is exact and
collision-free:

```text
FixtureRecordV1 =
  | exact {
      version: 1,
      kind: "success",
      operation: IdentityOperationName,
      transport: exact {
        requestHandlerInvoked: true,
        responseCompleted: true,
        httpStatus: IdentityExpectedSuccessStatus[operation]
      },
      output: FixtureValue,
      markers?: exact {
        oauthFailureReasonPresent: true
      }
    }
  | exact {
      version: 1,
      kind: "modeledError",
      operation: IdentityOperationName,
      transport: exact {
        requestHandlerInvoked: true,
        responseCompleted: true,
        httpStatus: integer 300..599
      },
      code: SafeServiceCode,
    }

FixtureValue =
  | exact { type: "null" }
  | exact { type: "boolean", value: boolean }
  | exact { type: "number", value: finite number }
  | exact { type: "string", value: registered non-sensitive string }
  | exact { type: "date", value: canonical ISO-8601 string }
  | exact { type: "pageToken", value: LogicalPageToken }
  | exact { type: "array", value: FixtureValue[] }
  | exact { type: "object", value: [registered object or map key, FixtureValue][] }
  | exact { type: "unknownUnion", member: SafeMemberName }
```

`LogicalPageToken` matches exactly `^fixture-token-v1-[0-9]{8}$` and is admitted only at an operation
registry's `nextToken` request or response path. Capture maintains a bijection per flow and list
operation. The first nonempty physical response token receives `fixture-token-v1-00000000`; each later
first appearance increments the ordinal, while a repeated physical token reuses its alias so
same-token and cyclic equality is preserved. Reflection inspection sees the physical token before
translation and the logical token afterward. The action and generated paginator receive only the
logical token. Immediately before a live continuation send, the interceptor reverses it to the physical
token after fixture identity has been computed from the logical request.

Capture rejects a nonempty continuation token that was not previously issued in the same flow and
operation before network access. Replay has no physical map and enforces the same logical issuance rule.
Absent or empty tokens remain terminal. Physical tokens never enter fixture bytes, basenames, request
identities, stdout, or stderr. Equivalent logical page sequences therefore produce byte-identical
fixtures even when the service emits different opaque tokens.

Object entries are sorted by their original modeled key and duplicate keys are rejected. The
operation registry enumerates the SDK output fields allowed to enter this algebra and omits raw
`failureReason`, request IDs, metadata outside the classifier allowlist, and every unregistered field.
For a secret-bearing call, every source and emitted scalar representation must also pass the
commit-local complete-value matcher before translation, terminal encoding, or serialization.
The success status is constrained by operation, not merely by HTTP class: every read is `200`, Creates
are `201`, Updates and Set CMK are `200`, and Deletes/Tag/Untag are `204`. Capture refuses an alternate
2xx, and replay rejects a fixture whose operation/status pair does not equal
`IDENTITY_EXPECTED_SUCCESS_STATUS` before synthesizing a response. A `204` fixture synthesizes an
absent body; a nonempty captured `204`, an over-cap encoded fixture response, or a success fixture that
cannot produce the pinned wire shape is invalid.
For an operation whose safe normalizer distinguishes only `failureReason` presence, capture records
the fixed `oauthFailureReasonPresent: true` marker and no text. Replay restores one fixed CLI-owned
placeholder solely to exercise the same presence branch; the placeholder is never rendered.

A captured SDK `$unknown: [name, body]` becomes `unknownUnion` after sanitizing only the name; the body
is never traversed. Replay revives dates through operation-specific synthetic wire encoders and lets the
real SDK create fresh `Date` instances and `$unknown` tuples. A modeled-error registry emits a complete
response with the recorded status, modeled code, one static CLI-owned message, deterministic safe
fields only, and a bounded body that reaches normal EOF. Capture's outer recorder projects the original
SDK exception into that same safe algebra and throws a fresh registry-constructed modeled exception
with the static message, validated status, and no request ID; the action maps it through its ordinary
safe error boundary. Successful capture likewise returns a fresh registry-constructed SDK-shaped
output containing only registered fields, fresh `Date` values, and safe unknown-union tuples. Unknown
errors, unknown fixture tags, invalid dates, unsupported scalar types, missing transport evidence,
abnormal body completion, over-cap synthesized bytes, or an operation/status/error mismatch fail
closed.

Capture/replay parity tests pass these responses through the real client request handler, raw guard, SDK
deserializer, dispatch classifier, and normal action/V1 normalization boundary. A captured guarded Get
containing an additive field must fail before the outer recorder, leave the capture call sequence
unchanged, and prevent the associated Update mutation. Separate synthetic transport tests cover
pre-authorization failures and incomplete responses; committed golden fixtures never encode those
nondeterministic failures.

Every golden flow declares a stable, repository-owned flow ID. The ID is part of its fixture namespace
and collision-manifest path. Redaction intentionally makes calls with different secret values
collide, so each flow manifest assigns a zero-based occurrence for every operation/digest pair and
records the exact ordered call sequence. Replay consumes every entry exactly once and fails on a
missing, extra, reordered, unconsumed, reserved, or poisoned call. A poisoned flow is terminal failure;
there is no rollback or retry API at the fixture-flow layer. SDK retries remain inside the one reserved
logical call and therefore do not poison the flow unless the logical call itself discards.

Flows may run in parallel because their namespaces are disjoint. Calls inside one flow are sequential;
the harness rejects a second in-flight SDK call for the same flow. A sorted suite index makes flow
discovery independent of worker scheduling. Repeated recordings with the same logical behavior must
produce byte-identical manifests and fixture content.

Each capture exclusively creates a cryptographically unique staging root and records the committed
suite-index state it read from the bound retained tree as exactly `{ kind: "absent" }` or
`{ kind: "sha256", digest }`. Capture acquires neither publication lock and never writes a stable
repository path. Every response blob and closed flow manifest is immutable and
content-addressed by the full SHA-256 of its canonical bytes. A manifest references only durable
blobs. Capture writes one canonical `FixtureReadyV1` last with the exact flow set, object digests,
byte lengths, canonical next index, schema version, and starting suite-index state; a root without
`READY` is unpublishable. The suite
index is a sorted mapping from stable flow IDs to immutable manifest digests and is the only stable
mutable fixture file. PID, host, capture ID, wall time, lock state, and commit SHA never enter
canonical artifact bytes.

The stable fixture-tree layout is closed:

```text
.agentcore-identity-fixture-publish.lock
identity/v1/objects/sha256/<first-2-hex>/<64-lowercase-hex-digest>
identity/v1/manifests/sha256/<first-2-hex>/<64-lowercase-hex-digest>
identity/v1/suite-index.json
```

The first line is protected native coordination state, not canonical fixture data, and is ignored by
Git and every package/source-archive manifest. It is the only additional stable-tree entry admitted
outside the versioned fixture namespace.

Capture roots mirror `objects/` and `manifests/` and add only protected native metadata,
`.capture.lock`, and `READY`. `CanonicalFixtureJsonV1` is UTF-8 without BOM or trailing newline,
contains no duplicate key, uses no insignificant whitespace, preserves array order, sorts object
members by encoded key bytes, normalizes `-0` to `0`, permits only finite JSON numbers, and uses one
reviewed JSON string-escape algorithm. The native transaction admits only this closed layout and
verifies every versioned artifact/index byte sequence with the same canonical codec before
installation; the lock is validated as protected coordination state instead.

Every immutable fixture object is installed inside the first-party native boundary; JavaScript has no
create, rename, unlink, or check-then-install fallback. `installCaptureArtifact` creates a
cryptographically unique same-directory
`.agentcore-capture-tmp-<32-lowercase-hex>` file with exclusive no-follow creation, installs the
capture-root protection, writes the complete in-memory bytes, verifies length and SHA-256, syncs and
uses the platform's atomic no-replace primitive to expose the digest path. Linux uses
`renameat2(RENAME_NOREPLACE)` and macOS uses `renamex_np(RENAME_EXCL)` after `fsync` and close. Windows
flushes the still-open handle and uses `SetFileInformationByHandle(FileRenameInfoEx)` with no-replace
semantics before closing that handle. A platform without the required primitive returns `unsupported`
rather than using an existence check followed by ordinary rename or a pathname reopen.

If the capture digest path already exists or the no-replace operation reports contention, native code
opens it descriptor-relative without following links and verifies regular-file identity, exact length,
full SHA-256, and canonical bytes before treating it as installed. An empty, truncated, mismatched,
non-regular, or unreadable object fails closed and is never replaced or used as a cache hit. Every
non-consumed temporary is closed and unlinked before a normal return, including valid cache hits.
Process-kill leftovers remain possible; readers ignore the exact reserved grammar, and sealing,
explicit discard, or the locked abandoned-capture reaper removes only matching temporaries inside that
retained capture handle. `READY` is installed last only after no temporary remains and the capture
directory has been synced. No digest path is ever opened for incremental writing.

Registered service timestamps are canonicalized from a fixed per-flow epoch with one-millisecond
ticks after physical-to-logical identity mapping. Calls are traversed in sequence and fields in
registered schema order; unordered collections are first sorted by logical identity. Each logical
resource/time role retains its assigned value while the raw service value is unchanged, and a changed
mutable timestamp allocates the next tick. Equal timestamps for one role remain equal, creation/update
ordering is preserved, and an immutable `createdTime` change fails capture. Only explicitly
registered timestamp paths are transformed, with `Date` revival preserved. An unknown date-bearing
or configured volatile response path fails capture instead of introducing nondeterministic bytes.

Publication is one short `publishFixtureTransaction` inside the native boundary. JavaScript may
prevalidate the closed capture, exact call consumption, digests, logical mappings, sentinel scans, and
base-index absent-or-digest state, but that does not authorize mutation and passes no artifact list,
path list, base state, or next-index bytes. It passes only the retained
`NativePublicationAuthorityHandle`, `NativeSealedCaptureRootHandle`, separately retained
`NativeFixtureTreeHandle`, and retained `NativeProtectedRootHandle`. The transaction rereads and
strictly parses canonical `READY` through the sealed handle, derives every source component, target
component, expected base, byte length, digest, and exact next-index bytes internally, then revalidates
all four handle identities, `RUN_BINDING`, observable capture provenance, bound fixture-tree identity,
component grammar, canonical layout, and fixture-tree security before touching a stable path. A copied,
currently moved, reboot-stale, cross-run, cross-authority, or no-longer-identical capture returns
`invalidCapture`; a different fixture-tree object returns `fixtureTreeMismatch`.

The sealed handle already owns `.capture.lock`. Native publication then attempts two permanent locks
nonblocking: first `.publish.lock` relative to the capture's publication authority, then
`.agentcore-identity-fixture-publish.lock` relative to the retained fixture-tree handle. Both use
exclusive Linux OFD `fcntl`, macOS `flock`, or Windows `LockFileEx` locking and remain held until the
transaction has a final outcome. Neither file is ever unlinked or replaced. The authority lock
protects capture provenance and authority-local cleanup; the fixture-tree lock is the serialization
authority for the exact stable tree. The complete cross-operation order and nonblocking release rule
are defined under the native adapter contract above. Kernel release on descriptor close or process
death eliminates stale-file reclamation, PID reuse, and check/remove/recreate races. Network
filesystems, unsupported no-replace/rename primitives, and trees writable or deletable by another
principal return `unsupported` or `unsafe`. Contention on either later lock returns
`notPublished/busy`, releases every earlier lock in reverse order, and performs no cleanup or
stable-tree mutation.

While holding all three locks, the native transaction performs the complete descriptor-relative
sequence:

1. Revalidate the publication authority, capture, original fixture-tree path, retained tree identity,
   and every known object/manifest/index directory without following links.
2. Scan only those known directories and unlink entries whose complete basenames match
   `.agentcore-publish-tmp-<32-lowercase-hex>` or
   `.agentcore-publish-index-tmp-<32-lowercase-hex>`. Never recurse through a temporary, follow it, or
   remove an unrecognized lookalike; fail before commit if an owned temporary cannot be removed.
3. Read and verify one current suite-index state. If its exact canonical bytes already equal
   the `FixtureReadyV1.nextIndex` bytes, verify every referenced object/manifest and treat the request as an idempotent
   already-published commit before continuing to durability sync. Otherwise require the current state
   to equal the capture's recorded absent-or-digest base state. Any third state is `staleBase`; it is
   never merged or overwritten.
4. For every immutable object and manifest, exclusively create and protect a same-directory temporary,
   write complete bytes, and verify length/digest/canonical encoding. POSIX syncs and closes before its
   no-replace rename; Windows flushes and renames the still-open handle with `FileRenameInfoEx` before
   close. If the target exists, verify its full bytes through a retained descriptor before accepting
   it. There is no JavaScript or native check-then-ordinary-rename or insecure Windows reopen path.
5. Exclusively create and protect the suite-index temporary, write the canonical next index, verify it,
   and atomically rename it over the old index. POSIX uses `fsync`, close, and same-directory
   rename-over; Windows flushes and uses handle-based `FileRenameInfoEx` with replace semantics before
   close. This rename-over is the publication commit point.
6. Sync every touched object/manifest directory and the suite-index parent where the platform provides
   a reliable directory-sync primitive, revalidate the committed index, clean any still-owned
   temporary, and release the fixture-tree lock followed by the publication-authority lock.

Before the index rename-over, any failure returns `notPublished` and the old index remains
authoritative. After that commit point, no path may return `notPublished`: complete directory sync
returns `published/directorySynced`; a platform with atomic process-crash behavior but no reliable
directory sync returns `published/processCrashOnly`; and any post-commit failure that prevents the
transaction from proving which durability step completed returns `published/unknownAfterCommit`.
An idempotent retry that finds the exact canonical `FixtureReadyV1.nextIndex` bytes is already
committed, never `staleBase`; it
performs the remaining verification/sync and returns the strongest `published` durability it can now
prove. Callers never retry automatically after `processCrashOnly` or `unknownAfterCommit`. Old
referenced objects are not deleted during publication. Replay reads one index snapshot, verifies every
referenced length and digest before decode, and ignores unreachable objects; a process kill at any
boundary exposes either the complete old index or the complete new index, never a mixed generation.
The claim is process-crash consistency, not power-loss or filesystem-corruption durability.

Fixture factories construct real AWS SDK clients with the operation middleware and concrete
capture/replay request handler. They do not replace bound `send` or return `{ send }` objects cast as
clients. This preserves `instanceof` checks required by generated paginators while ensuring replay
crosses the same request-handler dispatch and response-completion classifier as capture.

Golden recording uses a test-only logical-to-physical resource map. Tests and committed artifacts use
stable logical names. Immediately before a live SDK send, the interceptor maps registered modeled
name, ARN, and secret-ID fields to cryptographically random run-owned physical values and injects
run-ownership tags. It maps the corresponding response fields back to logical values before
sanitization, fixture serialization, or rendering, and removes injected ownership tags. Fixture
identity is computed from the logical request before physical mapping. Unregistered resource-bearing
paths fail closed. The separate per-flow page-token bijection reverses logical continuation tokens in
the same pre-send interceptor after request identity and maps physical response tokens before
sanitization. Replay never creates physical resource values or page tokens.

### Fixture Command Handoff

Routine live integration execution, golden capture, fixture recovery discovery, fixture publication,
explicit discard, and authority cleanup are separate test-only modules excluded from shipped
artifacts. Their `package.json` script metadata may remain in the npm package:

```text
AWS_PROFILE=deploy bun run test:identity:fixtures:capture -- \
  --fixture-tree <absolute-path> \
  --run-root <new-absolute-path> \
  --expected-account <12-digits> \
  --expected-region <region> \
  --expected-partition <partition> \
  --expected-owner agentcore-cli-identity-fixture-capture-v1 \
  --expected-family <family>... \
  --yes

bun run test:identity:fixtures:list -- \
  --fixture-tree <absolute-path>

bun run test:identity:fixtures:publish -- \
  --fixture-tree <absolute-path> \
  --run-root <existing-absolute-path> \
  --capture-id <32-lowercase-hex> \
  --ready-digest <64-lowercase-hex> \
  --expected-run-id <32-lowercase-hex> \
  --expected-ledger-digest <64-lowercase-hex>

bun run test:identity:fixtures:discard -- \
  --run-root <existing-absolute-path> \
  --capture-id <32-lowercase-hex> \
  --ready-digest <64-lowercase-hex> \
  --expected-run-id <32-lowercase-hex> \
  --expected-ledger-digest <64-lowercase-hex> \
  --yes

bun run test:identity:fixtures:reap -- \
  --minimum-age-seconds <86400..31536000>
```

These commands accept no positionals, authority-root/staging-path override, endpoint option, capture
flow subset, profile option, or unlisted flag. Scalar options occur exactly once. Fixture-tree and run
paths are absolute, NUL-free, at most 4,096 UTF-8 bytes, and pass their retained-handle validation.
Capture requires a nonexistent run root and the complete account/region/partition/owner/family scope
plus `--yes`. It rejects endpoint overrides, uses `AWS_PROFILE=deploy`, initializes and locks a
`RunLedgerV1` with purpose `fixtureCapture` before any AWS Create, and uses the same
`planned -> createOutcomeUnknown -> observed -> deleteOutcomeUnknown -> deleteAccepted -> deleted`
send gates, ownership tags, bounded polls, audit, and stale-reaper protocol as live testing.
`createNotSent` and `deleted` are the only terminal row states. Capture and publish read the exact
base/index at the fixture tree;
publication receives no artifact list or next-index bytes from the caller and derives both from sealed
`READY`.

After every flow, action/presentation assertion, sentinel scan, bounded AWS cleanup snapshot, and final
audit succeed, capture may seal only when the snapshot is `quiescent`, the audit is `completed` with
zero findings, and every ledger row is terminal `createNotSent` or `deleted`. A `planned`,
`createOutcomeUnknown`, `observed`, `deleteOutcomeUnknown`, or `deleteAccepted` row makes the result
`notSealed/cleanupIncomplete` even when bounded reads currently see no resource. Quiescence remains a
bounded current-state fact, while terminality comes only from local no-dispatch proof or the exact
service-accepted Delete plus absence and final zero-finding-audit transitions. This gate avoids
claiming a recoverable successful capture after its originating host has lost mutation authority. The
durable, now-terminal run ledger is retained as the capture's publication binding and audit record.
Capture then emits exactly one document:

```ts
type FixtureCaptureRootCleanupV1 =
  | { kind: "notCreated" }
  | { kind: "discarded" }
  | {
      kind: "retained";
      reason: "busy" | "unavailable" | "unsafe" | "unsupported" | "internalFailure";
    };

type FixtureCaptureCommandResultV1 =
  | {
      version: 1;
      kind: "sealed";
      captureId: string;
      readyDigest: string;
      flowCount: number;
      callCount: number;
      durability: "directorySynced" | "processCrashOnly" | "unknownAfterSeal";
      runId: string;
      runRootId: string;
      ledgerDigest: string;
      cleanupSnapshot: "quiescent";
      audit: RunAuditReportV1;
    }
  | {
      version: 1;
      kind: "notSealed";
      reason:
        | "captureFailed"
        | "cleanupIncomplete"
        | "auditOverflow"
        | "unavailable"
        | "unsafe"
        | "unsupported";
      captureId: string | null;
      readyDigest: null;
      runId: string | null;
      runRootId: string | null;
      ledgerDigest: string | null;
      cleanupSnapshot:
        | "notRun"
        | "quiescent"
        | "resourcesPresent"
        | "indeterminate"
        | "auditOverflow";
      audit: RunAuditReportV1;
      captureRootCleanup: FixtureCaptureRootCleanupV1;
    };

type FixtureListCommandResultV1 =
  | {
      version: 1;
      kind: "completed";
      captures: readonly FixtureCaptureHandoffV1[];
      busyCaptureCount: number;
      invalidCaptureCount: number;
    }
  | {
      version: 1;
      kind: "failed";
      reason: "limitExceeded" | "unavailable" | "unsafe" | "unsupported";
    };
```

The result fields are derived by phase. If capture-root creation never returned a handle,
`captureId`, `readyDigest`, and every run-binding field not yet established are null as applicable, and
`captureRootCleanup` is `notCreated`. Once a root exists, `captureId` is nonnull. Failure before
`READY` closes every handle and explicitly discards the open root in `finally`; successful discard is
`discarded`, and a failed discard is `retained` with its exact closed reason. A seal failure after a
successful zero-finding audit therefore returns `notSealed`, `cleanupSnapshot: "quiescent"`, the
completed audit, the established run fields, and the actual discard result. `readyDigest` is null for
every `notSealed` result because no valid handoff exists.

| Furthest completed capture phase                  | Capture/run fields                                                   | Cleanup/audit fields                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| No canonical run ledger                           | `captureId`, `runId`, `runRootId`, `ledgerDigest` null               | `notCreated`, `notRun`, `audit.notRun`                                    |
| Canonical run ledger, no capture root             | Run fields nonnull; `captureId` null                                 | `notCreated`, `notRun`, `audit.notRun`                                    |
| Open capture root, before final audit             | Run fields and `captureId` nonnull; `readyDigest` null               | Exact snapshot/audit reached; root is `discarded` or closed `retained`    |
| Zero-finding audit, unresolved row or failed seal | Run fields and `captureId` nonnull; `readyDigest` null               | `quiescent`, completed audit; root is `discarded` or closed `retained`    |
| `READY` installed                                 | Every sealed field nonnull and equal to native handoff/`RUN_BINDING` | `quiescent`, completed zero-finding audit; no `captureRootCleanup` member |

`notSealed.reason` is `auditOverflow` for an overflow audit; `cleanupIncomplete` for
`resourcesPresent`, `indeterminate`, or any nonterminal row after a quiescent audit; the matching
`unavailable`, `unsafe`, or `unsupported` for a closed native prerequisite/seal failure; and
`captureFailed` for poisoned flows, assertion/presentation failure, invalid seal state, or another
closed capture-internal failure. The first irreversible failure wins; final root-discard failure changes
only `captureRootCleanup`.

Every sealed outcome closes its handle but retains the root for publish, explicit discard, or audit.
If the final sealed-result stdout write fails, the stream may already have exposed a prefix, but the
command never classifies delivery as success, retains the sealed root and durable run ledger, and exits
`2`. `fixtures:list` recovers the exact capture ID, READY digest, run ID, opaque run-root ID, and ledger
digest for that bound tree, while `test:identity:inspect -- --run-root <known-path>` recovers the same
run identity and ledger binding. Discovery and inspection are read-only and never substitute for AWS
cleanup. A sealed result's audit is necessarily `completed` with zero findings and all rows terminal;
every other audit or row-state combination is `notSealed`.

Publication independently opens the canonical capture ID under the native-selected authority, verifies
the supplied `readyDigest` against `READY`, opens the explicit fixture tree and protected run root,
requires the expected run ID and current ledger digest to equal `RUN_BINDING`, and emits:

```ts
type FixturePublishCommandResultV1 =
  | {
      version: 1;
      kind: "published";
      captureId: string;
      readyDigest: string;
      runId: string;
      runRootId: string;
      ledgerDigest: string;
      durability: "directorySynced" | "processCrashOnly" | "unknownAfterCommit";
      captureDisposition: "discarded" | "retained";
    }
  | {
      version: 1;
      kind: "notPublished";
      captureId: string;
      readyDigest: string;
      runId: string;
      runRootId: string | null;
      ledgerDigest: string;
      reason:
        | "busy"
        | "invalidCapture"
        | "fixtureTreeMismatch"
        | "staleBase"
        | "unavailable"
        | "unsafe"
        | "unsupported";
      captureDisposition: "discarded" | "retained";
    };

type FixtureDiscardCommandResultV1 =
  | { version: 1; kind: "discarded"; captureId: string }
  | {
      version: 1;
      kind: "notDiscarded";
      captureId: string;
      reason: "busy" | "invalidCapture" | "unavailable" | "unsafe" | "unsupported";
    };

type FixtureReapCommandResultV1 =
  | { version: 1; kind: "completed"; removed: number }
  | {
      version: 1;
      kind: "failed";
      reason: "unavailable" | "unsafe" | "unsupported";
    };
```

The `notPublished` run ID and ledger digest are the validated expected command inputs; `runRootId` is
nonnull only after the supplied protected root opens and native identity derivation succeeds.
`published` fields come from the verified `RUN_BINDING`, not input echo.

Known `directorySynced` or `processCrashOnly` publication is definitive and automatically discards the
sealed root. `staleBase` is definitively unpublishable and is also discarded. `unknownAfterCommit`,
`busy`, `invalidCapture`, `fixtureTreeMismatch`, `unavailable`, `unsafe`, `unsupported`, or any cleanup
failure retains it for explicit retry/audit. `busy` is handled/retryable and exits `1`; no command
automatically retries publication. Explicit discard reopens the exact ID/digest/run binding through
the retained protected run root, requires `--yes`, consumes the sealed handle, and emits the exact
discard result above.

The abandoned-capture reaper runs before capture and publication and is also directly callable. It
removes only unlocked unsealed captures older than the supplied cutoff and unlocked reboot-stale
captures; it never automatically removes a same-boot sealed `READY` root. Busy, malformed,
unrecognized, and same-boot sealed roots are retained without following child links; the command emits
only the aggregate removed count or its closed failure. Every command closes authority, capture, and
fixture-tree handles in `finally`. Complete success exits
`0`, a definitive handled failure exits `1`, and an unknown durability or required cleanup failure exits
`2`; parser failure emits no result document and exits `2`.

Live integration results are never fixtures. A golden capture writes only its unique staging tree, and
the single-writer publication command is the only operation allowed to change the committed fixture
index. Failed, poisoned, incomplete, pre-seal presentation-failed, resources-present, indeterminate, or
audit-overflow captures cannot create `READY` or update committed fixtures. A post-seal output failure
does not invalidate already sealed canonical artifacts and is recoverable through discovery.

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
- OAuth and payment curated Update accept a secret-only rotation with an empty non-secret change list,
  reject a request with neither kind of change, and never classify a secret-only plan as `noChange`.
  Tests cover managed reprovision, same-mode external reference rotation, all four payment slots, and
  the additional unchanged managed slots that replacement Update requires to be supplied again.
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
- Fault injection at every synchronous `binding` step proves expected inventory failures restore
  `awaiting-context`, while unexpected exceptions dispose the context reservation and binding exactly
  once, leave the replacement terminally disposed, and expose only the static internal error.
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
- Compile-time negative fixtures reject a string at every OAuth and payment sensitive path in
  `SanitizedOAuthInput` and `SanitizedPaymentInput`. Runtime vectors cover every corresponding
  parser-boundary path, prove one nominal marker and one context-owned selection are produced, and prove
  no sensitive string survives in the action intent, frozen plan, review, guard hash, or error.
- Extraction failure before and after every sensitive leaf disposes the opaque selection bundle; context
  creation consumes it exactly once and rejects duplicate/conflicting explicit sources without exposing
  bundle contents.
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
- Token-vault key validation accepts only the two exact key-type values, requires a full
  single-region `key/` ARN for `CustomerManagedKey`, rejects bare IDs, aliases, alias ARNs, `mrk-`
  IDs, and malformed partition/region/account/resource forms, and forbids an ARN for
  `ServiceManagedKey`. It does not invent current-region/account equality.
- Every supported explicit clear is distinct from omission, and prohibited clears are rejected.
- Workload unchanged, replace, and clear intents are distinct.
- Semantic no-ops and opaque secret rotations are distinguished.
- Unknown vendors and union members expose only sanitized names on reads and fail on writes.
- Commit-guard codec vectors prove domain separation, type and length boundaries, object-order
  canonicalization, ordered arrays, finite-number normalization, and rejection of unpaired
  surrogates; distinct typed values never share a preimage before SHA-256.
- The generated Unicode 17.0.0 interval table matches the checked-in source digests and exactly covers
  `Default_Ignorable_Code_Point` union general category `Cf` without ambient ICU/property-regex
  behavior. Boundary vectors include U+034F, U+2065, U+FE0F, and U+E0100.
- Terminal-safe rendering visibly escapes literal backslashes, unpaired UTF-16 surrogates, C0, `DEL`,
  C1, ANSI/OSC introducers, every generated Unicode-security code point, U+2028, U+2029, and bidi
  controls.
- Scalar, array, review, JSON, Ink, and map-key encoding distinguish an actual control, backslash, or
  lone surrogate from literal `\u{XXXX}` text and from U+FFFD. Node and Bun byte-level tests cover
  every surrogate boundary, precomposed U+00E9 versus `U+0065 U+0301`, and actual U+E0100 versus the
  literal text `\u{E0100}`. Every distinct tag key, including `__proto__` and `constructor`, is
  preserved as an enumerable own property in a null-prototype object and survives final
  `JSON.stringify`.
- Strict JSON visitor tests reject duplicate static and map keys before materialization, ignore no
  inherited property, and preserve ordered entries for top-level tags and every nested managed-VPC map.
- URL and tag validation rejects every terminal, generated default-ignorable/format,
  line/paragraph-separator, or bidi control accepted by JavaScript strings.
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
  paths or OS text. Platform CI covers Linux ext4/XFS/Btrfs/tmpfs ACLs, macOS APFS ACLs, explicit HFS+
  rejection, Windows NTFS/ReFS owner/DACL and reparse behavior, exact byte-cap boundaries, and no
  JavaScript fallback.
- Protected-root tests reject wrong owner, mode other than `0700`, nontrivial/write-capable ACLs or
  DACLs, reparse/symlink components, path replacement, foreign-principal writable fixture trees, and
  authority temporaries whose `0600`/DACL protection was not installed before rename.
- Native scalar-path tests reject empty/dot/dot-dot, separators, NUL, drive/absolute forms,
  alternate-data-stream syntax, trailing Windows dots/spaces, reserved DOS names, malformed capture
  IDs, and reserved temporary aliases in both the JavaScript wrapper and native layer.
- Publication-authority tests prove repeated processes for one UID/SID open the same OS-selected root
  and lock within one filesystem namespace without accepting a caller path or environment redirect;
  unsafe, nonlocal, or unavailable platform parents return a closed failure. Retained-tree tests prove
  alternate paths and bind mounts open the same protected co-located lock.
- Retained-tree lock tests race first creation, require exclusive no-follow/no-replace behavior, retain
  one file identity across later transactions, and reject a symlink, reparse point, directory,
  non-regular file, wrong owner, wrong mode, nontrivial ACL, or unsafe DACL. No successful path unlinks,
  renames, or replaces the lock.
- Environment, file, stdin, prompt, and literal values preserve content and pass through the same
  character validator.

### Transport and Action Tests

- Every SDK operation selects the correct command.
- Map-wire tests prove every registered request path, including `__proto__`, reaches the exact signed
  JSON body once, and every registered response path is revived from original bounded bytes before
  normalization. They cover top-level and nested maps, inherited-key attempts, duplicate keys,
  generated-serializer drift, ordinary reads, guarded reads, capture, replay, and final V1 JSON.
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
- Production continuation-token codec vectors round-trip every UTF-16 code-unit boundary, paired and
  unpaired surrogates, NUL, controls, and the exact maximum through canonical unpadded Base64URL.
  They reject empty payloads, wrong versions, padding, noncanonical aliases, odd byte lengths, invalid
  alphabet, decoded NUL-free and NUL-containing over-cap values alike, and encoded byte cap `N + 1`.
  Re-encoding every accepted token is byte-identical.
- Every query binding is disposed exactly once after one-page success, all-page success, normalization
  failure, service failure, token cycle, and cancellation. The same `AbortSignal` reaches direct reads
  and paginator sends, and no partial all-results value escapes.
- Every workflow factory is total under synchronous throw, asynchronous provider rejection, endpoint
  rejection, handler/client/native construction failure, initial credential expiry, abort before
  construction, abort during construction, and late completion after abort. It returns the exact
  closed `BindingCreationOutcome`, destroys every partial or late resource once, never rejects, and
  transfers a binding only through `created`.
- Ordinary query, resolved-read, current-state, guarded-read, and page-cursor matrices cover
  informational statuses, every alternate 2xx, exact `200` with absent, malformed, incomplete,
  unsupported, over-cap, or map-unrevivable bodies, bounded and unbounded modeled/unmodeled errors,
  cancellation, credential expiry, paginator rejection, and internal classifier rejection. Every call
  returns its exact closed outcome without throwing; capture and replay classify the same vectors and
  record only exact-status normal-EOF successes or allowlisted complete modeled errors.
- Prepared plans are frozen, canonical, and contain no secret bytes.
- Cancellation and terminal outcomes destroy the operation binding; reprepare transfers it exactly
  once to the replacement capability, and Commander disposes an unaccepted replacement.
- `PreparedMutation.dispose()` races the registered action lease's commit through the same ownership
  state machine: exactly one path obtains the binding, repeated disposal is inert, and disposal after
  commit cannot destroy the commit-local or replacement lease.
- A prepared capability reached through its registered action lease rejects sequential and concurrent
  second commits before secret I/O or AWS calls. No presenter has a direct capability commit method.
- While one distinct capability remains active, a matching commit on another prepared pair receives
  the distinct supervisor `busy` attempt, leaves both objects unchanged, and performs no secret I/O,
  AWS call, state update, or output write. After the first execution has settled, its correlated Ink
  frame has flushed while `waitUntilExit()` remains pending, accepted writes through that frame's
  high-water mark have quiesced, and the scope has retired, an explicit resubmit of the same second pair
  activates and commits normally. Scope certainty never crosses between the two.
- The lane remains busy after action settlement and until the exact Commander or Ink presentation
  receipt retires it. Begin/finish tests reject foreign, stale, duplicate, cross-kind, and
  same-workflow/different-execution tokens without changing either scope. A certainty matrix over
  `none`, `outcomeUnknown`, and `committed` proves a busy or stale attempt never inherits the active
  execution's guidance.
- Update preparation Gets once; commit Gets before and after secret acquisition.
- The same additive OAuth/payment raw response succeeds through tolerant ordinary Get and returns
  `sdkCompatibilityRequired` through Update preparation and both commit
  `readCompatibilityGuardedCurrent` calls. No other operation facet has that method.
- Assertion-free compile fixtures construct production and fake adapters only through the
  consumer-owned facet constructors. For all 46 workflow keys, positive fixtures derive family,
  selector, primary operation, auxiliary Get, facet, policy, intent, and DTO from that key. Negative
  fixtures independently substitute every one of those eight dimensions and reject each assignment,
  including cross-facet bindings, primary or auxiliary cross-operation factories, guarded/current-state
  bindings to direct mutation, structurally equal command inputs/outputs, and foreign secret locators.
  Missing, extra, or independently generic runtime-metadata rows fail compilation.
- OAuth/payment Update preparation and both commit Gets reject additive raw response fields before
  generated deserialization. Preparation and the first commit Get fail before secret I/O; an
  incompatible second Get disposes acquired values before returning.
- Capture-handler ordering tests prove it restores original bounded bytes unchanged, the raw
  compatibility schema observes those originals before generated deserialization, and only the outer
  per-attempt post-deserialization projector can produce detached candidate evidence; only its wrapping
  logical-call initialize middleware can stage the retry-selected terminal candidate. An additive
  guarded response finalizes no call and sends no mutation.
- Successful and non-success compatibility bodies of 1,048,575 and 1,048,576 bytes are accepted;
  1,048,577 bytes destroys/cancels the Node or Web stream before Smithy collection. Valid OAuth
  responses without `clientSecretArn` pass; missing genuinely required members, wrong scalar wire
  types, nulls, truncation, and unknown keys/arms fail closed.
- Body-normalizer vectors cover absent body, string, `ArrayBuffer`, offset `DataView`, every typed-array
  view including Node `Buffer`, Node `Readable`/HTTP2, and Web `ReadableStream`; they reject `null`,
  `Blob`, unrecognized async iterables, premature close/error, and backing-store mutation.
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
- Mutation transport tests cover failure after authorization but before handler invocation, timeout
  after dispatch with no response, headers followed by body truncation/error, every complete non-2xx
  class, a service-applied mutation followed by 4xx or 5xx, every alternate 2xx, malformed exact-status
  response, SDK output normalization failure after exact-status normal EOF, nonempty exact `204`, and a
  valid exact-status output. They assert `mutationOutcomeUnknown` for every post-authorization failure
  that lacks exact-status normal completion, `committedOutputUnavailable` for unusable established
  commits, and no automatic retry.
- Fake service responses reflect each resolved managed value in turn through an allowlisted top-level
  scalar, nested scalar, array member, dynamic map key, unknown-member name, and modeled-error safe
  metadata. Complete and substring-containing reflections fail before terminal encoding, append no
  fixture call, and release the matcher; exact-status normal-EOF mutations return
  `committedOutputUnavailable`, while all other post-authorization responses retain
  `mutationOutcomeUnknown`.
- Fault injection before dispatch, after dispatch, after status receipt, during body EOF tracking, and
  during classification proves `mutate()` is total. Any escaped rejection after action invocation
  leaves certainty at least `outcomeUnknown`; only validation, guard, context, credential, or
  cancellation failures before mutation authorization leave certainty `none`.
- Compile-time transport fixtures prove neither mutation failure discriminant has a `cause` or other
  payload. Runtime middleware and request-handler rejections retain a sentinel-bearing command input,
  response, message, stack, and nested cause; the adapter returns only the closed discriminant and no
  sentinel reaches action state, output, diagnostics, or fixtures.
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
- Subprocesses close stdout before a query result, before mutation dispatch, after dispatch while the
  action is pending, after `mutationOutcomeUnknown`, and after known commit. Synchronous write failure,
  callback failure, `EPIPE`, `close`, and false-without-drain are contained without an unhandled event
  or stack. Unknown and committed cases select their corresponding static fresh-Get guidance and never
  retry the mutation; a simultaneously closed stderr remains stack-free.
- Cancelling after `write()` accepted a false-returning chunk does not settle routing early. A later
  callback plus `drain`, callback error, stream error, or close settles the owned write exactly once,
  crosses quiescence, and leaves no output listener behind.
- Injected serialization failure before dispatch, after an unknown outcome, and after a known commit
  selects generic, unknown-outcome, and committed-output-unavailable guidance respectively, queues no
  partial JSON, and leaves no output-listener leak after invocation teardown.
- Explicit Delete executes without `--yes`.
- Noninteractive `token-vault set-cmk` requires `--yes`.
- Commander exits on `ReprepareRequired` and never authorizes its replacement capability.
- An injected impossible Commander `busy` attempt emits only static internal guidance, disposes the
  invocation-owned pair, performs no output or mutation retry, and cannot classify against a foreign
  scope.
- A runnable-level sentinel-bearing unknown rejection emits only the static internal error to stderr
  and emits nothing to stdout.
- A reflected managed value in an otherwise allowlisted committed response emits no success JSON or
  secret bytes, returns committed-output-unavailable guidance, and records no golden call.

### Ink Screen Tests

- Commander/Ink route parity covers every Identity leaf and rejects orphaned routes.
- Every resource and verb route mounts from the feature-owned registry.
- OAuth fields change with provider family.
- Microsoft tenant input appears only where applicable.
- Secret storage mode changes the visible controls.
- Payment update asks again for all managed secret slots.
- External references are preserved without requesting their values.
- Workload return URL controls support add, remove, replace, and clear.
- Pickers consume only action-owned `IdentityPickerSession` pages. The first `next()` lazily creates one
  binding/cursor; concurrent `next()` returns `busy`; forward navigation advances once; back navigation
  uses frozen cached pages without AWS; and cancellation, disposal, every cap, token cycle, service
  failure, and terminal page close the binding exactly once. Components never receive, render, decode,
  or resubmit raw, logical, or production continuation tokens.
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
- Ink receives no result model or frame containing a reflected managed value; it renders only static
  committed-output-unavailable guidance after exact-status commit evidence and cannot resubmit.
- Render/state failures while a mutation is dispatched, after Ink observes
  `mutationOutcomeUnknown`, and after a committed result select unknown-outcome,
  unknown-outcome, and committed-output-unavailable guidance respectively and never permit a second
  submit.
- Output failure while an exact registered action lease is active aborts it, waits for that same
  action's settlement,
  then classifies its final monotonic certainty. Navigation or unmount cannot orphan a settled token;
  the root-owned controller either completes its frame receipt or completes the correlated
  `inkExit/unavailable` fallback before listener teardown.
- The typed Ink facade is exercised with every write overload, backpressure, callback failure,
  `error`, and `close` during ordinary frames, final frames, synchronized-output markers,
  alternate-screen teardown, and empty-write frame/exit settlements. Each accepted callback settles once.
  Two sequential mutations retire on separate execution-bound `inkFrame/flushed` receipts while
  `waitUntilExit()` remains pending; stale and foreign receipts cannot retire either scope. On root
  shutdown, `waitUntilExit()` and the exact active action settle, dimensions/TTY/resize remain
  functional while open, and invocation-supervisor listeners detach only after quiescence.
- Frame-epoch tests cover throttled writes, synchronized markers, callbacks and drains through the
  captured high-water mark, writes accepted after that mark, facade failure, and the post-failure empty
  callback. Only writes in the exact finite epoch delay that mutation's retirement.
- Dynamic fields containing literal backslashes, unpaired surrogates, C0, C1, ANSI, OSC, and bidi
  controls render as distinct visible ASCII escapes and cannot alter terminal state or reviewed layout.

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

Acceptance-transaction tests fail V1 and current-state normalization after candidate staging and prove
capture finalizes no call and creates no `READY`, while replay atomically changes its exact reservation
to `poisoned`. Cancellation, projection failure, malformed revival, and safe-normalization failure are
each followed by an otherwise matching logical call and final verification; both must fail because a
poisoned occurrence is never released or consumed. Every
prerequisite phase finalizes complete allowlisted modeled errors after safe mapping but finalizes no
guard, decode, body, compatibility, reflection, cancellation, expiry, unmodeled, or internal failure.
All-page batches finalize atomically only after aggregate normalization and limits pass.

Retry tests instrument the pinned middleware stack and prove one initialize transaction wraps every
retry attempt. A retryable `500 -> 200` read records only the terminal `200` candidate. Exhausting an
allowlisted retryable modeled error stages/finalizes one terminal call; replay synthesizes the same
reserved fixture for every attempt and consumes that reservation exactly once. Retry exhaustion from
network failure, an unmodeled error, cancellation, or projection failure finalizes no call and poisons
the one replay reservation. Intermediate attempt candidates never install objects, append
occurrences, poison a flow, or advance replay, and mutation clients still make only their separately
specified single HTTP attempt.

Fixture-codec tests capture and replay dates, nested `$unknown` tuples with discarded bodies, and each
allowlisted modeled exception through a real SDK client instance and concrete request handler. They
omit request IDs, preserve a fixed OAuth failure-reason presence marker, require recorded
dispatch/status/normal-EOF evidence, and produce identical capture/replay transport classification and
normalization. Every success fixture must carry the operation's exact expected status and synthesize at
most 1,048,576 response bytes; an alternate-2xx operation/status pair, oversized synthesis, nonempty
`204`, or malformed success wire shape is rejected. Complete 4xx and 5xx mutation fixtures both replay
as `mutationOutcomeUnknown`; exact-status fixtures replay as committed. Matcher tests place complete
resolved values and containing strings in raw/canonical strings, number lexemes and canonical numbers,
booleans, null, pre-clock Dates, arrays, object values, dynamic keys, unknown names, physical/logical
tokens, request IDs, and `httpStatus`. Capture finalizes no call and replay rejects a malicious prebuilt
fixture before returning an SDK-shaped value.
Token tests use different physical token sequences for the same logical pages, prove byte-identical
fixtures and correct reverse mapping before each live continuation send, preserve repeated-token/cycle
equality, and reject a token not issued by the same flow/operation. Pagination boundaries cover
999/1,000/1,001 pages, 9,999/10,000/10,001 items, and exact/N+1 cumulative wire and final-output bytes
without rendering or finalizing partial results.
Capture-command output feeds publication directly. Tests reject a wrong ID, digest, tree, run root,
run ID, ledger digest, or option;
exercise interrupted capture, stale base, `unknownAfterSeal`, `unknownAfterCommit`, and cleanup failure;
and assert the exact exit/result contracts. Definitive publication and stale base discard the capture,
unknown/retryable outcomes retain it, explicit discard requires `--yes`, and automatic reap never
removes a same-boot sealed `READY` root.
An action assertion or presentation/output failure before seal poisons capture and creates no `READY`.
A final result write failure after `READY` retains a discoverable sealed capture; `fixtures:list`
recovers its capture handoff, including run ID, opaque run-root ID, and sealing ledger digest. Run
inspection recovers those same three values from the known run root without AWS or mutation. With two
same-base sealed captures present, only the exact three-field join opens for publication; selecting the
other capture fails before either publication lock or stable-tree mutation.
Atomic-object tests kill before and after temp-file `fsync` and rename, retry abandoned installs,
exercise native no-replace contention and valid existing-object cache hits, assert every unconsumed
temporary is removed, reject platforms without the required primitive, and reject a pre-existing empty,
truncated, wrong-digest, or non-canonical digest-path object. Publication tests kill with object,
manifest, and suite-index temporaries present; the next native transaction removes only exact reserved
stable-directory names while holding both the authority `.publish.lock` and retained-tree
`.agentcore-identity-fixture-publish.lock`, then exposes a complete old or new index. Lookalike names and
symlinks outside the exact grammar are never traversed or deleted. Alternate lexical fixture paths and
bind-mount aliases contend on the co-located tree lock. A Linux integration test runs two same-UID
publishers with private `/tmp` mount namespaces and one shared retained fixture-tree inode. Starting
from one base and proposing divergent indexes, exactly one returns `published`, the other returns
`{ kind: "notPublished", reason: "staleBase" }`, and the final index and all references equal the winner
without lost updates.
Copied, currently moved, cross-host, reboot-stale, and cross-authority captures are rejected.
Open/sealed handle compile tests and runtime stale-handle tests reject cross-state
install/seal/publish calls. Per-capture locks exclude same-capture publish/discard/reap without
serializing independent captures; explicit discard and aged unsealed/reboot-stale reap remove no
same-boot sealed `READY` root. Linux, macOS, and Windows provenance fixtures exercise the exact boot and
mount/volume APIs and unsupported paths. macOS fixtures prove a wall-clock change leaves the canonical
`kern.bootsessionuuid` valid while a changed boot-session UUID is rejected. Windows fixtures cover
dynamic symbol absence, private-structure size drift, malformed or zero boot GUIDs, malformed
`MachineGuid`, and exact supported values. Faults before index rename return `notPublished`; faults after
rename can return only one of the three `published` durability states. A retry whose old base is stale
but whose exact next index is already committed verifies/syncs that generation and returns `published`,
never `staleBase`.
Authority-root and fixture-tree ownership/ACL changes before lock, cleanup, temporary creation, and
rename each fail closed; ledger and index replacement temporaries are verified protected before
installation. Platform tests exercise Linux `renameat2`, macOS `renamex_np`, and handle-based Windows
`FileRenameInfoEx` ordering without an existence-check or pathname-reopen fallback.

### Release and Packaging Tests

- Toolchain checks require Node `22.22.1`, Bun and `@types/bun` `1.3.14`, TypeScript `5.9.3`,
  `@types/node@22.20.1`, `node-addon-api@8.9.0`, and `node-gyp@12.4.0`; the package engine floor is
  `>=22.22.1`.
- Reviewed direct dependencies are exact-pinned, `bun ci` is lockfile-frozen, and
  `@inkui-cli/data-table` is absent. Every source, npm, and standalone distribution preserves the
  required upstream MIT notice for the local derivative in `THIRD_PARTY_NOTICES.md`.
- `package.json.files` explicitly contains both `"dist"` and `"THIRD_PARTY_NOTICES.md"`; reliance on
  npm's implicit README/LICENSE inclusion is forbidden because npm does not implicitly include the
  third-party notice. `npm pack` contains the production `dist` tree, `THIRD_PARTY_NOTICES.md`, and all six native
  prebuilds, while excluding test command modules, test sources, fixtures, capture roots, run roots,
  and review artifacts. Test-script metadata may remain in `package.json`. An empty project installs
  and executes the tarball under Node `22.22.1`; all six standalone Bun targets execute their
  corresponding smoke suite.
- Node `20.20.1` loads only the N-API v8 addon directly. A guard test proves no CLI package import or
  dependency installation occurs in that compatibility job.
- Release-policy unit vectors reject wrong repository, tag ref, source or signer digest, workflow path,
  OIDC issuer, predicate type, self-hosted runner, public-good trust, trusted-root digest, artifact
  name/digest, zero or multiple attestations/subjects, and empty verified timestamps.
- A hermetic verifier fixture exercises exact `gh 2.96.0` JSON output. Release workflow tests prove
  every matrix input is verified before assembly and every final artifact is independently attested
  and verified.

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

#### Run Ledger And Command Boundary

The live runner and stale reaper share one exact authorization artifact:

```ts
const RUN_LEDGER_BASENAME = ".run-ledger-v1.json";
const RUN_LOCK_BASENAME = ".run.lock";
const RUN_LEDGER_MAX_BYTES = 1_048_576;
const RUN_LEDGER_MAX_ROWS = 256;
const RUN_LEDGER_MAX_DEPTH = 8;
const RUN_LEDGER_MAX_NODES = 16_384;
const CREATE_SEND_DEADLINE_MS = 300_000;
const SERVICE_CLOCK_SKEW_MS = 300_000;
const RUN_POLL_OFFSETS_MS = [
  0, 250, 750, 1_750, 3_750, 7_750, 15_750, 31_750, 61_750, 91_750, 121_750,
] as const;
const RUN_POLL_DEADLINE_MS = 150_000;
const RUN_READ_ATTEMPT_TIMEOUT_MS = 15_000;
const RUN_AUDIT_DEADLINE_MS = 300_000;
const RUN_AUDIT_MAX_PAGES = 512;
const RUN_AUDIT_MAX_ITEMS = 8_192;
const RUN_AUDIT_MAX_FINDINGS = 256;

type LiveResourceKindV1 =
  | "api-key-provider"
  | "oauth2-provider"
  | "payment-provider"
  | "workload-identity"
  | "secrets-manager-secret";

type RunPurposeV1 = "live" | "fixtureCapture";

type RunObservationV1 = Readonly<{
  arn: string;
  serviceCreatedAtEpochMs: number;
}>;

type RunRowStateV1 =
  | Readonly<{ kind: "planned" }>
  | Readonly<{
      kind: "createOutcomeUnknown";
      createDispatchRecordedAtEpochMs: number;
    }>
  | Readonly<{
      kind: "createNotSent";
      createDispatchRecordedAtEpochMs: number | null;
      createNotSentAtEpochMs: number;
    }>
  | Readonly<{
      kind: "observed";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
    }>
  | Readonly<{
      kind: "deleteOutcomeUnknown";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
      deleteDispatchRecordedAtEpochMs: number;
    }>
  | Readonly<{
      kind: "deleteAccepted";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
      deleteDispatchRecordedAtEpochMs: number;
      deleteAcceptedAtEpochMs: number;
      absenceConfirmedAtEpochMs: number;
    }>
  | Readonly<{
      kind: "deleted";
      createDispatchRecordedAtEpochMs: number;
      observedAtEpochMs: number;
      observation: RunObservationV1;
      deleteDispatchRecordedAtEpochMs: number;
      deleteAcceptedAtEpochMs: number;
      absenceConfirmedAtEpochMs: number;
      deletionConfirmedAtEpochMs: number;
    }>;

type RunLedgerRowV1 = Readonly<{
  candidateId: string;
  resourceKind: LiveResourceKindV1;
  physicalName: string;
  plannedAtEpochMs: number;
  createNotBeforeEpochMs: number;
  createNotAfterEpochMs: number;
  state: RunRowStateV1;
}>;

type StaleCleanupAuthorityV1 =
  | Readonly<{
      kind: "linuxSameBoot";
      bootSessionId: string;
      uniqueMountId: string;
      protectedRootId: string;
      lockObjectId: string;
    }>
  | Readonly<{ kind: "auditOnly" }>;

type RunLedgerV1 = Readonly<{
  schema: "amazon.agentcore-cli.identity.run-ledger";
  version: 1;
  generation: number;
  purpose: RunPurposeV1;
  runId: string;
  ownerTagValue: string;
  createdAtEpochMs: number;
  scope: Readonly<{
    partition: string;
    accountId: string;
    region: string;
    families: readonly LiveResourceKindV1[];
  }>;
  staleCleanupAuthority: StaleCleanupAuthorityV1;
  rows: readonly RunLedgerRowV1[];
}>;
```

`runId` and every `candidateId` are exactly 32 lowercase hexadecimal characters generated from
independent 128-bit CSPRNG values. Native proof values and SHA-256 digests are exactly 64 lowercase
hexadecimal characters. Account IDs are 12 decimal digits; partition matches
`^[a-z0-9-]{1,32}$`; region is 1 through 64 lowercase ASCII letters, digits, or hyphens and must resolve
inside the expected partition; `ownerTagValue` matches `^[A-Za-z0-9_.:/=+@-]{1,128}$`. Every timestamp
and generation is a nonnegative safe integer.

Every physical name starts with `acci-<runId>-` and passes its existing family-specific name validator.
Secret names additionally pass the Secrets Manager 1-through-512-character validator. Identity ARNs
pass the existing structured family parser and exactly match ledger partition, region, account, family,
and physical name. A secret ARN must match those same scope fields, its physical name, and the service's
six-character Secrets Manager ARN suffix.

`scope.families` is nonempty, contains no duplicate, and follows the `LiveResourceKindV1` declaration
order; rows are sorted by `candidateId`. Candidate IDs, physical names, and every observed ARN are
globally unique. Every row kind belongs to `scope.families`. The attempt bounds are exact:
`createNotBeforeEpochMs = plannedAtEpochMs - SERVICE_CLOCK_SKEW_MS` and
`createNotAfterEpochMs = plannedAtEpochMs + CREATE_SEND_DEADLINE_MS +
SERVICE_CLOCK_SKEW_MS`, with underflow/overflow rejected.

Timestamp order is part of canonical validation. Ledger `createdAtEpochMs` is no later than every
`plannedAtEpochMs`. A non-null `createDispatchRecordedAtEpochMs` is at least `plannedAtEpochMs` and at
most `plannedAtEpochMs + CREATE_SEND_DEADLINE_MS`. `createNotSentAtEpochMs` is no earlier than planning
and no earlier than its optional dispatch-record timestamp. `observedAtEpochMs` is no earlier than the
create-dispatch record. `serviceCreatedAtEpochMs` falls inclusively inside the row's
`createNotBeforeEpochMs..createNotAfterEpochMs` window; it is not ordered against local observation time
because service and runner clocks may differ within the declared skew. `deleteDispatchRecordedAtEpochMs`
is no earlier than `observedAtEpochMs`; `deleteAcceptedAtEpochMs` is no earlier than that dispatch
record; and `absenceConfirmedAtEpochMs` is no earlier than acceptance. All additions and comparisons
reject overflow. `deletionConfirmedAtEpochMs` is no earlier than absence confirmation.

`generation` equals the sum of current row-state weights: `planned` is `1`,
`createOutcomeUnknown` is `2`, `createNotSent` is `3`, `observed` is `3`, and
`deleteOutcomeUnknown` is `4`, `deleteAccepted` is `5`, and `deleted` is `6`. An empty initialized
ledger therefore has generation `0`; replacing one row state changes generation by exactly the
difference between old and new weights, while the audited terminalization batch changes it by the sum
of those per-row differences.

The four ownership tags are derived rather than stored redundantly:

```ts
{
  "agentcore-cli:test-owner": ledger.ownerTagValue,
  "agentcore-cli:test-run": ledger.runId,
  "agentcore-cli:test-candidate": row.candidateId,
  "agentcore-cli:test-created-at": String(row.plannedAtEpochMs),
}
```

Additional remote tags are permitted, but a test request that tries to supply a reserved key is
rejected. The ledger parser performs the fixed capped read before allocation, strict UTF-8 decoding
without BOM, duplicate-aware JSON parsing, depth/node caps, exact-key validation, and full schema
validation. It rejects comments, trailing commas or bytes, unknown/missing keys, non-safe or
noncanonical numbers, malformed unions, unsorted arrays, duplicate identities, and inconsistent
generation or scope. The canonical encoder emits UTF-8 without BOM or trailing newline, fixed schema
key order, ASCII JSON escapes, no insignificant whitespace, and canonical integers. Parsed bytes must
equal their canonical re-encoding byte-for-byte; only that encoder mints
`CanonicalRunLedgerBytesV1`.

The JSON root has depth `1`. Every object member value and every array element has its container's depth
plus one; a member name has the same depth as its value. Each object, array, scalar value, and member
name counts as one node, including the root and names in empty-valued members. Equality at both caps is
accepted; depth `9` or node `16,385` is rejected before semantic construction. The node cap admits 256
rows in their largest `deleted` state with all terminal evidence.

The only legal transitions are:

```text
absent -> initialized empty ledger
ledger -> ledger plus one planned row
planned -> createOutcomeUnknown
planned -> createNotSent
createOutcomeUnknown -> createNotSent
createOutcomeUnknown -> observed
observed -> deleteOutcomeUnknown
deleteOutcomeUnknown -> deleteAccepted
one or more deleteAccepted rows -> deleted in one audited terminalization batch
```

Scope, purpose, authority, creation facts, row identity, attempt window, dispatch facts, and an existing
observation never change; V1 never removes a row. `createNotSent` and `deleted` are the only terminal
states. The direct
`planned -> createNotSent` transition is allowed only while the command still owns process-local proof
that no Create dispatch was authorized. `createOutcomeUnknown -> createNotSent` additionally requires
the exact in-process request-handler tracker to prove that the handler was never invoked; a restart,
timeout, response, or missing tracker can never establish it.

Planning captures both `plannedAtEpochMs + CREATE_SEND_DEADLINE_MS` and the equivalent deadline on one
process-local monotonic clock. The Create request-handler wrapper, not an outer action, owns dispatch
authorization. At its exact `handle()` entry it reads both clocks. If either is past its inclusive
deadline, it atomically installs `planned -> createNotSent` and never invokes the underlying handler.
Otherwise it atomically installs and durably syncs `createOutcomeUnknown`, then reads both clocks again
immediately before underlying-handler invocation. Expiry during ledger synchronization installs
`createOutcomeUnknown -> createNotSent` using the still-local handler-not-invoked proof. A ledger
failure or expiry invokes no handler. At equality dispatch remains allowed; one millisecond past either
clock is expired. After the final check, setting the tracker to invoked and calling the underlying handler
are one synchronous block with no hook, timer, promise, middleware callback, or caller code between
them. The wall clock catches suspend intervals omitted by a platform monotonic clock; the monotonic
clock prevents a backward wall-clock adjustment from extending authorization.
If client construction, serialization, middleware, cancellation, or validation fails before the
request-handler wrapper is entered, the same tracker proves that the row is still `planned` and permits
only `planned -> createNotSent`. If the first transition committed but the wrapper never invoked the
underlying handler, it permits only `createOutcomeUnknown -> createNotSent`. No other layer may mint
either proof.

A successful Create response does not supply the creation time required for ownership, so it does not
advance the row. A fresh family Get plus `ListTagsForResource` for API-key, OAuth, payment, and
workload resources, or Secrets Manager Describe with its returned tags, must read the full ARN and
service creation time and verify the complete scope, name, four-tag, and attempt-window conjunction
before atomically installing `observed`. Before every Delete dispatch, the runner/reaper first rereads
and verifies that same complete ownership conjunction. An `observed` row must then atomically install
and durably sync `deleteOutcomeUnknown` immediately before its first Delete dispatch; an
already-`deleteOutcomeUnknown` row retains that state before every later guarded attempt. Secrets use
the full observed ARN, `ForceDeleteWithoutRecovery: true`, and no `RecoveryWindowInDays`.

`deleteOutcomeUnknown -> deleteAccepted` is legal only in the same process that observed the exact
Delete receipt bound to the action lease, candidate ID, operation, previously observed target ARN/name,
and persisted dispatch, then completed that row's full scheduled absence poll with no failed read. The
expected response is the operation registry's exact status and shape, not any 2xx. AgentCore Delete
operations require `204` with zero-byte normal EOF. Secrets Manager `DeleteSecret` requires `200`,
normal EOF, and a valid modeled result whose ARN and name equal the observed target; force deletion
remains asynchronous until polling and audit prove disappearance. OAuth `DELETING` remains pending and
`DELETE_FAILED` prevents acceptance. A timeout, alternate status, malformed/nonempty AgentCore body,
abnormal EOF, mismatched Secrets Manager result, restart before receipt correlation, or absence without
that exact receipt can never produce `deleteAccepted`.

The public
[`DeleteSecret` API reference](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html)
retrieved July 14, 2026 is explicit that
`ForceDeleteWithoutRecovery` returns HTTP `200`, performs physical deletion asynchronously, and removes
the opportunity to recover the secret; its response contains `ARN`, `Name`, and `DeletionDate`.
Therefore response acceptance alone is insufficient, but response-plus-final-absence-plus-audit can be
the terminal service-contract boundary. The pinned AgentCore operation schemas similarly define exact
`204` Delete success, while OAuth's modeled lifecycle provides the additional failure-state check.

`deleteAccepted -> deleted` requires a complete final audit performed after the last AWS mutation. The
audit must have zero findings, every row-specific absence poll must still be clean, and the command
must reread the exact ledger digest audited before atomically replacing all current `deleteAccepted`
rows with `deleted` in one CAS/sync. Every row preserves its prior evidence and receives the same
terminal audit-completion timestamp. After that batch transition, the command rereads one all-terminal
canonical ledger before fixture sealing.
Pending Secrets Manager deletion, OAuth failure/pending state, audit cycle/overflow, pagination/read
failure, any finding, a ledger digest change, or any AWS mutation after audit start prevents
terminalization. This design treats an exact service-accepted Delete followed by completed absence and
zero-finding audit as the service contract's irreversible deletion boundary. A service violation that
recreates the same accepted resource after that boundary is outside the CLI's local cleanup trust
model and is reported as a terminal-row contract violation, never silently reauthorized.

`planned`, `createOutcomeUnknown`, `observed`, `deleteOutcomeUnknown`, and `deleteAccepted` remain
eligible for bounded inspection on every later run. A bounded NotFound poll, an empty complete audit,
or an exact-success Delete response by itself never advances or removes one of those rows: absence is a
cleanup snapshot, and acceptance without the complete correlated absence poll and final audit remains
nonterminal. `deleteOutcomeUnknown` remains reaper-eligible until exact acceptance;
`deleteAccepted` remains audit/finalization-eligible until the global proof commits and authorizes no
additional Delete. Terminal rows are never deletion candidates. If a later audit observes ownership
matching a `deleteAccepted` or `deleted` row, it reports a contract-violation finding and refuses
mutation rather than silently reopening the accepted or terminal state.

Every state/readiness/absence poll captures one monotonic start and uses exactly
`RUN_POLL_OFFSETS_MS`. Attempt `i` starts no earlier than `start + offset[i]` and after the prior attempt
has settled. Each read receives a separate `RUN_READ_ATTEMPT_TIMEOUT_MS` abort and may not start at or
after the overall deadline. The entire poll aborts at `start + RUN_POLL_DEADLINE_MS`; timers never extend
either deadline. A verified desired present/readiness state may finish early. An absence result requires
the last scheduled attempt to return the modeled NotFound response, no read attempt to end in an
unclassified failure, and the later complete audit to agree. Earlier present states are expected during
Delete convergence and do not invalidate that final absence result. A timeout, credential-freshness
failure, malformed result, pagination failure, or other read failure makes the poll `indeterminate`,
even if a later request reports NotFound.

The final audit is one bounded, read-only sweep over every `scope.families` entry in declaration order.
It starts one monotonic `RUN_AUDIT_DEADLINE_MS` deadline shared by all list pages, follow-up Get/Describe
calls, and tag reads; each individual read also has the smaller read-attempt timeout. Page and item
counts are global across families, while continuation-token sets are separate per family and compare
the exact decoded SDK token. The same token text in two families is valid; a token repeated within one
family is a cycle.

Before every page request, the audit checks deadline and then the global page counter. If 512 pages
have already completed, it returns `overflow/pageLimit` without sending another request. Therefore, if
page 512 terminates one family, the next family's first page is not requested. A page increments
`pages` only after its List response is successfully received and structurally accepted. Items are then
visited in service order. Before accepting each item, the audit checks whether 8,192 items have already
been accepted; an additional item returns `overflow/itemLimit` with `items: 8192`. An accepted item
increments `items` before its follow-up Get/Describe/tag reads and classification. Discovering a 257th
finding returns `overflow/findingLimit`, retains exactly the first 256 findings, and includes the
triggering item in `items`.

After all items on a page are accepted, the audit handles its token in this order: an empty token
terminates that family; a token already in that family's set returns `overflow/cycle`; a new token is
inserted; and if `pages === 512`, needing the next page returns `overflow/pageLimit`. Deadline is
checked before each item, each follow-up read, token handling, and each page request. Expiry returns
`overflow/deadline`. Thus the first check reached in service traversal order determines the reason,
and every counter/finding reflects only work accepted before that check. A service/shape failure
remains `indeterminate`, not overflow. Every Secrets Manager list sweep sets
`IncludePlannedDeletion: true`; a secret pending deletion remains visible and is a finding. Sweeps
never promote an unledgered resource into a deletion candidate.

Audit output is closed and bounded:

```ts
type RunRowStateKindV1 = RunRowStateV1["kind"];

type RunAuditFindingV1 = Readonly<{
  resourceKind: LiveResourceKindV1;
  physicalName: string;
  arn: string;
  candidateId: string | null;
  relation: "ledgered" | "unledgered" | "ownershipMalformed";
  ledgerState: RunRowStateKindV1 | null;
  visibility: "visible" | "pendingDeletion";
}>;

type RunAuditReportV1 =
  | Readonly<{ kind: "notRun" }>
  | Readonly<{
      kind: "completed";
      pages: number;
      items: number;
      findings: readonly RunAuditFindingV1[];
    }>
  | Readonly<{
      kind: "overflow";
      reason: "deadline" | "pageLimit" | "itemLimit" | "findingLimit" | "cycle";
      pages: number;
      items: number;
      findings: readonly RunAuditFindingV1[];
    }>
  | Readonly<{
      kind: "indeterminate";
      reason:
        | "credentialRefreshRequired"
        | "paginationFailure"
        | "serviceFailure"
        | "internalFailure";
      pages: number;
      items: number;
      findings: readonly RunAuditFindingV1[];
    }>;

type RunCleanupSnapshotV1 =
  | "notRun"
  | "quiescent"
  | "resourcesPresent"
  | "indeterminate"
  | "auditOverflow";
```

A finding is evidence, not deletion authorization. The audit emits one for any resource with the exact
run prefix or exact owner/run tags. `ledgered` requires the complete valid candidate/tag/name/ARN
conjunction, `unledgered` has a complete valid ownership tuple but no matching row, and
`ownershipMalformed` covers a missing, malformed, or contradictory reserved ownership field and uses a
null candidate ID when no valid one is available. Only `ledgered` can ever nominate the corresponding
`createOutcomeUnknown`, `observed`, or `deleteOutcomeUnknown` row for the separately guarded deletion
path; `deleteAccepted` and `deleted` findings are service-contract violations and authorize no
mutation. Findings preserve resource-family declaration
order, then service page order and item order. A completed audit contains at most 256 findings.
Discovery of a 257th finding stops the sweep; the overflow report retains exactly the first 256 in that
order and sets `findingLimit`. Page/item/cycle/deadline overflow and indeterminate reports retain only
the findings safely established before the stop, still capped and in discovery order. No partial
report can produce `quiescent`.

`cleanupSnapshot` is derived, never caller-selected. It is `quiescent` only when every eligible ledger
row has a clean bounded final absence result and the complete audit has zero findings. A complete audit
with any finding is `resourcesPresent`; a row mismatch, read failure, or incomplete audit is
`indeterminate`; any audit cap produces `auditOverflow`; and a skipped cleanup is `notRun`. A
`fixtureCapture` run may seal only with `quiescent` and no nonterminal ledger row. A quiescent capture
with any unresolved row is `notSealed/cleanupIncomplete` and retains its ledger for same-authority
inspection and cleanup.

Every transition calls `replaceRunLedgerAtomically` with expected absence or the exact current digest.
`expectedDigestMismatch` aborts. An exact next digest is idempotent `alreadyCurrent`. After
`commitUnknown`, one reread accepts only the exact old or next canonical digest; old means no transition,
next means committed, and absence or a third digest aborts without repeating an AWS mutation.

The executable surfaces are exactly:

```text
AWS_PROFILE=deploy bun run test:identity:live -- \
  --run-root <new-absolute-path> \
  --expected-account <12-digits> \
  --expected-region <region> \
  --expected-partition <partition> \
  --expected-owner <owner> \
  --expected-family <family>... \
  --yes

AWS_PROFILE=deploy bun run test:identity:reap -- \
  --run-root <existing-absolute-path> \
  --expected-run-id <32-lowercase-hex> \
  --expected-account <12-digits> \
  --expected-region <region> \
  --expected-partition <partition> \
  --expected-owner <owner> \
  --expected-family <family>... \
  --minimum-age-seconds <1800..31536000> \
  [--yes]

bun run test:identity:inspect -- \
  --run-root <existing-absolute-path>
```

These test-only command modules are excluded from shipped artifacts, although their `package.json`
script metadata may remain in the npm tarball. They accept no positional, endpoint, ledger-path, prefix,
force, all-resources, or profile option. Unknown flags, duplicate scalar flags, duplicate or
out-of-declaration-order families, missing values, noncanonical numbers, relative/NUL/over-4,096-byte
paths, and any environment/argument/ledger scope mismatch fail before AWS. Live requires a nonexistent
root and `--yes`, initializes purpose `live`, and generates and reports the run ID. Reap requires an
existing root of either purpose and defaults to dry-run. The configured owner for repository live
automation is exactly `agentcore-cli-identity-live-v1`; fixture capture uses exactly
`agentcore-cli-identity-fixture-capture-v1`.

Inspect accepts only `--run-root`. It performs no AWS, credential, profile, endpoint, lock-reclamation,
or ledger mutation. Through one retained protected-root handle it reads one atomically installed ledger
snapshot, applies the full capped canonical parser, hashes those exact bytes, closes the handle, and
reports the run ID, opaque root ID, and digest needed after a live/reap stdout failure. Concurrent
replacement can make the result immediately stale but cannot produce a mixed generation.

Command results contain no native/AWS error text:

```ts
type RunCurrentResourceReportV1 =
  | Readonly<{ kind: "notChecked" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      kind: "owned";
      observation: RunObservationV1;
      visibility: "visible" | "pendingDeletion";
    }>
  | Readonly<{
      kind: "ownershipMismatch";
      reason: "name" | "arn" | "scope" | "ownershipTags" | "creationTime" | "shape";
      arn: string | null;
    }>
  | Readonly<{
      kind: "indeterminate";
      reason: "credentialRefreshRequired" | "serviceFailure" | "internalFailure";
    }>;

type RunSendAttemptReportV1 =
  | "notAttempted"
  | "handlerNotInvoked"
  | "handlerInvokedExactSuccess"
  | "handlerInvokedOutcomeUnknown";

type RunRowReportV1 = Readonly<{
  candidateId: string;
  resourceKind: LiveResourceKindV1;
  physicalName: string;
  ledgerStateBefore: RunRowStateKindV1;
  ledgerStateAfter: RunRowStateKindV1;
  ledgerObservation: RunObservationV1 | null;
  current: RunCurrentResourceReportV1;
  createSendAttempt: RunSendAttemptReportV1;
  deleteSendAttempt: RunSendAttemptReportV1;
}>;

type IdentityRunCommandResultV1 = Readonly<{
  version: 1;
  command: "live" | "reap";
  mode: "mutate" | "dryRun";
  outcome: "completed" | "active" | "refused" | "partial";
  stopReason:
    | "lockBusy"
    | "scopeMismatch"
    | "proofUnavailable"
    | "proofMismatch"
    | "credentialRefreshRequired"
    | "serviceFailure"
    | "ledgerFailure"
    | "testFailure"
    | "auditOverflow"
    | "internalFailure"
    | "cleanupIncomplete"
    | null;
  purpose: RunPurposeV1 | null;
  runId: string | null;
  runRootId: string | null;
  ledgerDigest: string | null;
  cutoffEpochMs: number | null;
  cleanupSnapshot: RunCleanupSnapshotV1;
  audit: RunAuditReportV1;
  reports: readonly RunRowReportV1[];
  counts: Readonly<{
    examined: number;
    createSends: number;
    deleteSends: number;
    retained: number;
    unexamined: number;
  }>;
}>;

type IdentityRunInspectCommandResultV1 =
  | Readonly<{
      version: 1;
      command: "inspect";
      kind: "inspected";
      purpose: RunPurposeV1;
      runId: string;
      runRootId: string;
      ledgerDigest: string;
      generation: number;
      createdAtEpochMs: number;
      scope: RunLedgerV1["scope"];
      rowCount: number;
    }>
  | Readonly<{
      version: 1;
      command: "inspect";
      kind: "failed";
      reason: "invalidLedger" | "unavailable" | "unsafe" | "unsupported";
    }>;
```

`IdentityRunCommandResultV1` is derived by one closed command-phase machine. `live` always has
`mode: "mutate"`; `reap` has `mode: "mutate"` only with `--yes`, otherwise `dryRun`. Parser and usage
failure happen before this machine, emit no result document, and exit `2`.

The metadata nullability rules are exact:

| Field                           | Derivation                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `purpose`, `runId`, `runRootId` | Nonnull together after one protected root and canonical ledger snapshot are validated; null before  |
| `ledgerDigest`                  | Digest of the latest exactly verified canonical snapshot; null before the first valid snapshot      |
| `cutoffEpochMs`                 | Nonnull only for `reap` after post-lock scope/account validation and cutoff capture                 |
| `reports`                       | One entry for each row whose row processor started; no synthetic entries for unexamined rows        |
| `audit`                         | `notRun` until the final audit starts; thereafter its exact completed/overflow/indeterminate result |
| `cleanupSnapshot`               | `notRun` until cleanup evidence exists; otherwise the precedence table below                        |

A later ledger-write uncertainty never guesses a next digest. If readback proves the previous bytes,
`ledgerDigest` remains the previous digest; if it proves the next bytes, it becomes the next digest; a
missing or third state stops with `ledgerFailure` and reports the last exactly verified digest. The
opaque `runRootId` is derived by native code from the retained root and is the same value used by
fixture `RUN_BINDING`.

Pre-lock and authorization results are total:

| Condition                                                      | `outcome` | `stopReason`       | AWS / audit behavior                                             |
| -------------------------------------------------------------- | --------- | ------------------ | ---------------------------------------------------------------- |
| Existing `.run.lock` is busy                                   | `active`  | `lockBusy`         | No AWS; `audit: notRun`; all validated rows are unexamined       |
| Arguments and canonical ledger scope disagree                  | `refused` | `scopeMismatch`    | No AWS; no audit                                                 |
| Mutating reap lacks supported proof                            | `refused` | `proofUnavailable` | No mutation; run the bounded read-only audit when scope is valid |
| Supplied root/lock/boot/mount proof differs                    | `refused` | `proofMismatch`    | No mutation; run the bounded read-only audit when scope is valid |
| Root or ledger cannot produce a first valid canonical snapshot | `refused` | `ledgerFailure`    | No AWS; all metadata fields remain null unless already proven    |
| Closed internal failure before a valid snapshot                | `refused` | `internalFailure`  | No AWS                                                           |

For a proof refusal, the primary `stopReason` remains the proof reason even if the best-effort audit
overflows or is indeterminate; the exact audit union still exposes that secondary result. Scope
mismatch never supplies a remote scope to audit. Dry-run reap does not require mutation proof, but it
still requires the protected root, lock exclusion, canonical ledger, scope, account, endpoint, and
credential binding.

After row processing begins, the first applicable reason in this fixed precedence is selected:

1. `ledgerFailure`
2. `credentialRefreshRequired`
3. `internalFailure`
4. `serviceFailure`
5. `auditOverflow`
6. `cleanupIncomplete`
7. `testFailure`
8. `null`

`auditOverflow` applies to every audit `overflow`, including `cycle`. `cleanupIncomplete` applies to a
mutating `live` or `reap` result when the cleanup snapshot is not `quiescent` or any nonterminal ledger
row remains after cleanup. It intentionally outranks `testFailure`, because cleanup state is the
operator's first recovery action. A complete dry-run with visible resources has `outcome: "completed"`
and `stopReason: null`; observation is the command's purpose and no cleanup was promised. Any nonnull
post-authorization reason produces `outcome: "partial"`. Otherwise the outcome is `completed`.

Cleanup snapshots use this precedence:

1. No cleanup or audit started: `notRun`.
2. Any audit overflow: `auditOverflow`.
3. Any row read/ownership mismatch, failed required read, contradictory row/audit evidence, or
   indeterminate audit: `indeterminate`.
4. A completed audit with one or more findings, or a verified owned row still present:
   `resourcesPresent`.
5. Every eligible nonterminal row has a complete final absence poll and the completed audit has zero
   findings: `quiescent`.

Terminal `createNotSent` and `deleted` rows need no per-row absence read to satisfy step 5, but remain
covered by the complete audit. A completed zero-finding audit that contradicts a row's `owned` result
is `indeterminate`, never `quiescent`. Fixture capture adds the stricter all-rows-terminal seal gate
defined above.

Each row report describes only work in this invocation. Reports are sorted by candidate ID after
processing and bounded by `RUN_LEDGER_MAX_ROWS`. `ledgerStateBefore` is the first valid snapshot's
state; `ledgerStateAfter` is the last exactly committed state. `ledgerObservation` equals the
observation carried by `ledgerStateAfter` for `observed`, `deleteOutcomeUnknown`, `deleteAccepted`, and
`deleted`, and is null for the other three states. `current` is the final complete row-specific
observation:

| Starting state         | Permitted processing and final state                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `planned`              | Original live process may prove no dispatch and commit `createNotSent`; reap retains it and performs no deletion  |
| `createOutcomeUnknown` | Fresh owned observation may commit `observed`; mutate may then delete; clean absence retains the uncertain state  |
| `createNotSent`        | Terminal; no AWS row read or send; `current: notChecked`                                                          |
| `observed`             | Fresh ownership match is required before Delete; mismatch/indeterminate sends nothing                             |
| `deleteOutcomeUnknown` | Fresh ownership match may authorize another Delete; clean absence alone retains the uncertain state               |
| `deleteAccepted`       | Repeat the clean absence poll and final audit without Delete; absence alone cannot make the row terminal          |
| `deleted`              | Terminal; no AWS row read or send; `current: notChecked`; the global audit detects any service-contract violation |

One report may span several legal durable transitions, but every adjacent committed transition must
be one of the V1 edges. There is no regression or shortcut. `current: absent` requires the complete
scheduled absence poll; `owned` requires the full ownership conjunction; `ownershipMismatch` and
`indeterminate` authorize no later send for that row. `notChecked` is valid only for a terminal row or
a row stopped before its first remote read.

Send-attempt values obey these equations:

- `notAttempted` means the underlying handler was never authorized and no invocation-specific
  no-handler transition was needed. Both fields are `notAttempted` in dry-run; reap never sends Create.
- `handlerNotInvoked` requires the exact process-local tracker. For Create it must end in
  `createNotSent`; it is never reconstructed after restart.
- `handlerInvokedExactSuccess` requires exact expected status and normal EOF. Create still needs a
  separate owned observation. Delete reaches `deleteAccepted` only after its correlated complete
  absence poll and reaches `deleted` only after the later complete zero-finding audit.
- `handlerInvokedOutcomeUnknown` means invocation occurred without exact-success proof and leaves the
  corresponding outcome-unknown state nonterminal.

The count equations are exact:

```text
examined    = reports.length
createSends = count(reports.createSendAttempt in
                    {handlerInvokedExactSuccess, handlerInvokedOutcomeUnknown})
deleteSends = count(reports.deleteSendAttempt in
                    {handlerInvokedExactSuccess, handlerInvokedOutcomeUnknown})
retained    = count(reports where ledgerStateAfter is nonterminal
                    or current is owned, ownershipMismatch, or indeterminate)
unexamined  = validFinalLedger ? validFinalLedger.rows.length - examined : 0
```

All counts are nonnegative and at most `RUN_LEDGER_MAX_ROWS`; `examined + unexamined` equals the final
valid row count. A refusal after validating a ledger has zero reports, zero sends/retained, and every
row unexamined. A mid-row stop includes that row with its last proven state/current/send values; later
rows are unexamined.

Inspect has a separate exact mapping and never opens `.run.lock`:

| Native/parser result                                                       | Inspect result         |
| -------------------------------------------------------------------------- | ---------------------- |
| Root opened, ledger bytes canonical, digest/root identity derived          | `inspected`            |
| Fixed ledger is `notFound` or `limitExceeded`                              | `failed/invalidLedger` |
| UTF-8, duplicate-key, canonical, schema, generation, or semantic rejection | `failed/invalidLedger` |
| Root/ledger ownership, ACL, link, reparse, or identity rejection           | `failed/unsafe`        |
| Required native operation or supported-platform implementation absent      | `failed/unsupported`   |
| Other closed native read/hash failure                                      | `failed/unavailable`   |

Usage/parser failure emits no stdout and exits `2`. Any `active`, `refused`, or `partial` run result
exits `1`; `completed` exits `0`, including a completed dry-run with findings. Inspect exits `0` only
for `inspected`, `1` for its closed failure, and `2` for usage/parser failure.

Each live run:

- Uses a cryptographically random, run-unique `acci-<run-id>-` prefix.
- Exclusively creates one protected run root before any AWS call. It opens a permanent mode-`0600`
  `.run.lock` relative to that retained root and holds its OS descriptor lock for the runner lifetime.
  The lock file is never unlinked or atomically replaced. On supported Linux, the ledger records the
  root identity and native adapter's opaque lock-object, boot-session, and
  `STATX_MNT_ID_UNIQUE` values. If that proof is unavailable or the platform is macOS/Windows, the run
  remains testable but stale cleanup for it is permanently audit-only.
- Creates a separate mode-`0600` durable run ledger before the first AWS call. Before each create
  request, it atomically appends and syncs the planned physical name, partition, family, account,
  region, wall-clock create-attempt window, random 128-bit candidate ID, and exact ownership tags. At
  the same planning instant it retains the corresponding process-local monotonic deadline. The exact
  request-handler wrapper checks both deadlines, atomically installs
  and syncs `createOutcomeUnknown`, rechecks both deadlines, and only then invokes the underlying
  handler. Only the exact in-process no-handler proof may install `createNotSent`; every other response
  or failure leaves outcome unknown until a fresh Get/Describe plus required tag read verifies the
  exact ARN, service creation time, and tags and atomically installs `observed`. Ledger temporaries are
  created and verified relative to the protected root before rename. Ledger replacement never changes
  the inode/file ID that carries the active-run lock because they are different files.
- Adds `agentcore-cli:test-owner`, `agentcore-cli:test-run`,
  `agentcore-cli:test-candidate`, and `agentcore-cli:test-created-at` tags in the original Create call
  for every Identity resource and temporary Secrets Manager secret. No post-create tagging gap is
  accepted.
- Treats only valid rows from the explicitly supplied ledger as deletion candidates. Before every
  deletion it verifies the caller account/region/partition and allowlisted family, re-reads the
  current resource and tags, and requires the exact recorded physical name and prefix, parsed ARN
  account/region/type, owner tag, run-ID tag, candidate-ID tag, and creation tag. If the Create
  observation was persisted, the ARN and service `createdTime` must equal the ledger exactly. For a
  `createOutcomeUnknown` row found before observation, the fresh service time must fall inside the
  pre-recorded bounded attempt window before the row can become `observed`. A `planned` or
  `createNotSent` row never authorizes deletion. A missing or malformed row, failed Get or tag read,
  recreated name, mismatch, or unverifiable predicate retains and reports the resource.
- Refuses broad cleanup by the shared `acci-` prefix.
- For OAuth, polls each successful Create and Update with bounded exponential backoff until `READY`
  and fails immediately on `CREATE_FAILED` or `UPDATE_FAILED`, using only safe normalized failure
  guidance. For API-key, payment, and workload resources, whose Get outputs have no lifecycle status,
  it polls until Get returns the expected created or updated state.
- After Delete, polls Get until `NotFound`. OAuth `DELETING` remains pending and `DELETE_FAILED` fails
  the run; the other three families expose no deletion status and continue polling until absence. It
  durably installs `deleteOutcomeUnknown` before the Delete dispatch. Only a correlated exact modeled
  success with normal EOF followed by the complete clean absence poll atomically installs
  `deleteAccepted`; only the later complete zero-finding audit installs `deleted`. Bounded absence
  without that response proof never advances either state.
- Cleans up in `finally` with the same bounded state polling.
- Deletes test-owned Secrets Manager secrets with `ForceDeleteWithoutRecovery` and polls until they
  are absent.
- Performs final paginated sweeps across all four Identity resource families and Secrets Manager.
  Secrets Manager always sets `IncludePlannedDeletion: true`. Sweeps use the shared global deadline and
  caps, are audit-only, report ledgered, unledgered, and malformed-ownership findings, and never promote
  them to deletion candidates.
- Emits the bounded exact remaining names and ARNs when current-run resources or temporary secrets
  remain; any overflow or incomplete sweep is explicitly non-quiescent.
- Scans captured output for sentinel secrets.

A separate stale-run reaper handles process and OOM failure. It requires the exact persisted ledger,
run ID, expected account, region, partition, resource family set, owner tag value, and minimum age.
Mutation cleanup is supported only from the original protected run root on Linux with a current
`STATX_MNT_ID_UNIQUE` proof. It opens and validates the protected root, opens the exact permanent
`.run.lock` relative to that handle, verifies protected-root and lock-object IDs, and requires the
current boot-session and unique mount IDs to equal the ledger before it first acquires the descriptor
lock non-blocking. After acquisition it rereads the complete ledger through the retained root, repeats
schema, run-ID, root/lock, boot/mount, account/region/partition, and candidate validation
against that new snapshot, requires its canonical digest to equal the pre-lock digest, and fails closed
if any pre-lock fact changed. It then holds `.run.lock`
continuously through every STS/AgentCore/Secrets Manager read, deletion, poll, and final ledger update.
The post-lock comparison happens before any AWS mutation. This prevents a filesystem-only snapshot,
copied run root, same-boot remount, host reboot, or pre-lock ledger replacement from converting absence
of the original kernel lock into termination evidence. It never locks the atomically replaced ledger
inode. Network filesystems, Linux without the unique mount primitive, macOS, and Windows are
audit-only.

After post-lock validation and STS account verification, the reaper captures one cutoff as
`nowEpochMs - minimumAgeSeconds * 1_000`. Ledger creation, each candidate's
`createNotAfterEpochMs`, its creation-tag timestamp, and every available service creation time must be
at or before that cutoff; a found `createOutcomeUnknown` candidate's service time must also fall inside
its recorded attempt window. All normal deletion predicates still apply. It never deletes an
unledgered, untagged, tag-mismatched, recreated, young, active, copied-artifact, `planned`,
`createNotSent`, `deleteAccepted`, `deleted`, or out-of-scope resource. Any failed ownership or
lock-identity read fails closed.
Dry-run is the default and performs reads only: it sends no Delete and writes no ledger generation.
`--yes` permits verified `createOutcomeUnknown -> observed`,
`observed -> deleteOutcomeUnknown -> deleteAccepted`, and `deleteAccepted -> deleted` transitions plus
guarded Delete attempts, but cannot bypass any proof, age, scope, identity, or ownership predicate.
Dry-run writes no transition. Mutating reap writes `deleteAccepted` only from its own correlated exact
Delete success and complete absence poll, and writes `deleted` only after the later complete
zero-finding audit; an absence poll or audit without that response proof cannot skip either state.

The stale reaper uses the same hardened invocation binding as live execution and capture. It rejects
`--endpoint-url`, bypasses every environment/profile endpoint override, resolves official HTTPS
AgentCore, STS, and Secrets Manager endpoints before its account check, resolves credentials exactly
once, and gives all three services non-refreshing providers over that one snapshot. It checks the
immutable expiration epoch before every read and mutation send. Entering the five-minute window aborts
the reaper without refreshing or issuing a later request.

A local ledger, exact lock object, protected root, and matching Linux boot/unique-mount proof survive
process failure, not loss or restart of their host or mount. CI may persist the mode-`0600` ledger and
lock metadata as a restricted audit artifact, but a copied artifact, a different boot session, an
unproved platform, and a different mount incarnation are audit-only because locking that object cannot
prove that the original process terminated. Mutation after reboot, host loss, filesystem remount, or
from a copied artifact would require a separate machine-verifiable external run-termination attestation
bound to the recorded run ID; no such verifier is in this implementation, so confirmation cannot
override the refusal. A full hypervisor snapshot that clones active kernel state is outside the local
reaper's trust model and likewise requires external attestation; the design does not claim a local lock
can distinguish two such kernels. Without the exact ledger and Linux same-session proof, cleanup reports
audit sweep results but refuses mutation.

Ledger tests reject empty, BOM, invalid UTF-8, 1,048,577-byte, depth `9`, node `16,385`, duplicate-key,
unknown-key, missing-key, empty/duplicate/out-of-order families, unsorted rows, noncanonical numbers,
malformed states, timestamp-order violations, duplicate rows, bad names/ARNs/proofs,
purpose/scope-inconsistent data, and every incorrect weighted generation. Boundaries at depth `8`,
node `16,384`, a 256-row all-`deleted` ledger, and all other exact caps pass. Tests exercise every legal
transition and illegal edge,
expected absence/digest mismatch, idempotent next bytes, and old/next/third/missing readback after
`commitUnknown`.

Reaper tests cover every rejection predicate, protected-root substitution, copied lock/ledger artifacts,
network filesystems, boot-session mismatch, unique-mount mismatch, macOS/Windows audit-only behavior,
same-name recreation, unledgered sweep results, partial reruns, dry-run zero mutation/write behavior,
and exact-run Linux same-session local cleanup. A privileged Linux integration job performs a real
same-boot unmount/remount and proves the unique mount ID changes and mutation remains disabled; kernels
without the primitive prove audit-only. Kill-point tests stop before and after planned-row rename/sync,
the first Create deadline check, `createOutcomeUnknown` rename/sync, the second deadline check,
request-handler invocation, service acceptance, fresh observation, `observed` rename/sync,
`deleteOutcomeUnknown` rename/sync, Delete send, exact Delete response, every NotFound poll,
`deleteAccepted` rename/sync, final audit, `deleted` rename/sync, all-terminal ledger reread, `READY`,
and final directory sync. Deterministic deadline tests expire before the
first transition, while ledger sync is pending, after sync, at exact equality, and one unit before
underlying-handler invocation; every expired path proves no handler call and commits `createNotSent`.
Every surviving ledger is exactly the old or next canonical generation; bounded absence without
correlated Delete success never changes it; handler-not-invoked proof can create only
`createNotSent`; and both pre-observation recovery paths require the candidate ID and full ownership
conjunction. Reaper binding
tests also replace the ledger between the initial proof check and lock acquisition and require the
post-lock digest/reread to fail before AWS. They prove the lock remains held through all service reads,
mutations, polls, audits, and final ledger writes; endpoint overrides are ignored; one credential
snapshot spans STS/AgentCore/Secrets Manager; freshness is checked before every send; and the permanent
original run lock survives ledger replacement while excluding active-run cleanup.

Deterministic-clock poll tests assert every offset
`[0,250,750,1750,3750,7750,15750,31750,61750,91750,121750]`, the per-read 15-second timeout, the
150-second overall deadline, no overlapping attempt, early verified-present success, final-NotFound
absence, and indeterminate mapping for any failed read. Final NotFound and an empty audit never mutate a
nonterminal ledger state without the exact correlated Delete-success evidence.

Audit tests cover page/item limits at `N` and `N + 1`, the shared 300-second deadline, repeated tokens,
all family-order permutations, 256 and 257 findings, malformed ownership, unledgered resources, and
partial safe findings on failure. Every Secrets Manager page asserts
`IncludePlannedDeletion: true`, and a pending-deletion secret prevents quiescence. The complete matrix
uses independent token sets per family, maps a repeated family-local token to `overflow/cycle`, permits
the same token text across families, includes the triggering item but not a 257th finding, and proves
that after a terminal global page 512 no next-family request is sent. Counter and retained-finding
assertions cover every pre-request, post-page, per-item, per-finding, token, and deadline boundary.
The complete matrix
derives only the specified `notRun`, `quiescent`, `resourcesPresent`, `indeterminate`, and
`auditOverflow` snapshots. Fixture capture seals only when every row is terminal and the snapshot is
clean quiescent; a nonterminal row blocks `READY` even with zero findings. Seal failure after a
completed zero-finding audit returns `notSealed` with `cleanupSnapshot: quiescent` and the exact
`notCreated`/`discarded`/`retained` root disposition.

Result-contract tests instantiate every command/mode/pre-lock row in the derivation tables, every legal
and illegal row-state/current-state/send-attempt combination, every stop-reason precedence collision,
all metadata nullability boundaries, the five count equations, report inclusion/order after a mid-row
stop, dry-run findings, and row-mismatch versus audit precedence. They assert exact `0`/`1`/`2` exits.
Inspect tests read active and inactive atomic generations without locking or AWS, return the root ID
and digest of the exact parsed bytes, map native `notFound` and `limitExceeded` to `invalidLedger`,
exercise every closed native/parser mapping, reject malformed or unsafe roots, and recover the exact
run ID/root ID/digest after a simulated final stdout failure.

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

No application-framework change is required. The current `bun.lock` resolves the reviewed versions
already present in its dependency graph, but does not yet contain every required direct, test, or
native-build dependency below. The pre-implementation `package.json` still contains caret ranges and
`@inkui-cli/data-table`. Implementation updates that manifest so the required post-implementation
dependencies are:

- Existing `@aws-sdk/client-bedrock-agentcore-control` and
  `@aws-sdk/client-bedrock-agentcore`, both exact-pinned at `3.1079.0`.
- Existing `commander@15.0.0`, `ink@7.1.0`, `react@19.2.7`,
  `@tanstack/react-query@5.101.2`, and `zod@4.4.3`.
- Direct `jsonc-parser@3.3.1` for strict duplicate-aware JSON visitation and structured map revival; it
  is configured to reject comments and trailing commas.
- Direct `@smithy/core@3.29.1`, aligned with the pinned clients, for normalized structure, union, and
  sensitive-path traversal only.
- Test-only `@aws-sdk/client-sts@3.1079.0` for live account verification.
- Test-only `@aws-sdk/client-secrets-manager@3.1079.0` for run-owned EXTERNAL fixtures and cleanup.
- Build-only `node-addon-api@8.9.0` and `node-gyp@12.4.0` for one first-party N-API v8 C++ addon. There
  is no third-party runtime native dependency and no subprocess ACL parser.
- Build-only `typescript@5.9.3`, `@types/bun@1.3.14`, and `@types/node@22.20.1`.
- Vendored Unicode 17.0.0 `DerivedCoreProperties.txt` and `UnicodeData.txt` as generator inputs only,
  with their source digests and Unicode data-files license; runtime ships the reviewed generated
  interval table, not a Unicode parsing dependency.

Implementation exact-pins reviewed Identity, AWS/Smithy, native-build, and release-tool dependencies in
`package.json`, without `latest`, caret, or tilde ranges, and refreshes `bun.lock` under frozen
verification. SHA-256 uses the platform crypto implementation. Implementation also removes the unused
`@inkui-cli/data-table@0.2.0` dependency: it declares Ink 6 while the application uses Ink 7.1.0, and all
current imports resolve to the local
`src/components/ui/data-table` implementation. Its history and source comparison establish that it is
a modified derivative of the package's `DataTable.tsx`. The upstream
`Copyright (c) 2024 Kamlesh Yadav` MIT notice is therefore retained in checked-in
`THIRD_PARTY_NOTICES.md`, the npm tarball, source distributions, and every standalone release bundle
rather than erased with the dependency.

Implementation adds `.node-version` containing exactly `22.22.1` and `.bun-version` containing exactly
`1.3.14`, declares `"engines": { "node": ">=22.22.1" }` and
`"packageManager": "bun@1.3.14"`, and makes release jobs reject any Node, Bun, npm, or compiler version
that differs from the reviewed release toolchain. Node `22.22.1` is the floor because
`lint-staged@17.0.8` requires it; this also satisfies Commander 15, Ink 7.1, and React Router 8.1.
GitHub setup reads both version files explicitly; all action references use reviewed full commit SHAs;
dependency installation uses `bun ci` against the committed `bun.lock`.

The Node-targeted release is built and tested under Node `22.22.1`. CI runs `npm pack`, inspects the
tarball, installs that exact tarball into an empty temporary project under Node `22.22.1`, and executes
its binary/help plus network-free production smoke tests from the installed package. The tarball
contains `dist`, all six `dist/native/<target>/agentcore_cli_native.node` prebuilds, and
`THIRD_PARTY_NOTICES.md`; `package.json.files` names the notice explicitly. It excludes test modules and
data even when `package.json` retains test-script metadata. Node `20.20.1` is not a supported CLI runtime
and never installs or executes the package
dependency graph. It appears only in an isolated N-API v8 compatibility job that loads the native
`.node` binary directly and exercises its closed safe self-test surface.

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
cross-platform npm and standalone artifacts. CI smoke-tests each prebuild under Node `22.22.1` and Bun
`1.3.14`, exercises a safe/unsafe file, descriptor-lock exclusion/process-death release, capture
publication primitives, and Linux unique-mount proof or the platform's explicit audit-only result, and
runs the corresponding standalone binary. The isolated Node `20.20.1` addon-load check is separate.
`npm pack` inspection and installed-tarball execution must prove every Node prebuild is present. File
secrets, fixture publication, and mutating live-run cleanup remain disabled on a target until these
gates pass; there is no weaker runtime fallback.

A reviewed `release-toolchain.json` allowlists the exact hosted-runner image version, architecture,
Node, Bun, C/C++ compiler, linker, platform SDK, and native dependency versions for each target. A
mutable runner label may schedule the job but cannot authorize release when its reported image version
differs. Every matrix artifact carries a signed build-provenance attestation binding those values,
source commit/tree, workflow commit, lockfile digest, target manifest, and artifact digest. Final
assembly verifies the attestations and rejects a missing, mismatched, or self-reported-only artifact
before packaging.

Release provenance is closed and repository-specific:

- The source repository is exactly `aws/agentcore-cli`; the protected release ref is exactly
  `refs/tags/<release-tag>`, and the tag's resolved source commit is recorded before any build.
- The signer is exactly
  `github.com/aws/agentcore-cli/.github/workflows/release.yml` at that reviewed source commit. If the
  workflow is later factored through a reusable trusted builder, changing this identity or digest is a
  reviewed policy change, not a wildcard.
- Release and matrix jobs must report GitHub-hosted runner identity. Self-hosted attestations are
  rejected even when every other field matches.
- The certificate OIDC issuer is exactly `https://token.actions.githubusercontent.com`, and the
  predicate type is exactly `https://slsa.dev/provenance/v1`.
- Release verification uses exact `gh` CLI `2.96.0`, whose binary digest is pinned in
  `release-toolchain.json`. It uses a checked-in GitHub-Sigstore-only
  `scripts/release/trust/github-trusted-root.jsonl`; the file's SHA-256 is pinned in
  `release-policy.json` and checked before invocation. Sigstore Public Good signatures are disabled.

Each matrix artifact and final npm/standalone artifact has one downloaded JSONL attestation bundle and
is verified offline with the equivalent of:

```text
gh attestation verify <artifact> \
  --bundle <artifact>.sigstore.jsonl \
  --repo aws/agentcore-cli \
  --signer-workflow github.com/aws/agentcore-cli/.github/workflows/release.yml \
  --signer-digest <source-commit> \
  --source-digest <source-commit> \
  --source-ref refs/tags/<release-tag> \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --predicate-type https://slsa.dev/provenance/v1 \
  --deny-self-hosted-runners \
  --digest-alg sha256 \
  --custom-trusted-root scripts/release/trust/github-trusted-root.jsonl \
  --no-public-good \
  --format json
```

A checked-in verifier parses the JSON structurally. It requires exactly one verified attestation
result, exactly one statement subject, the expected artifact name, exactly one SHA-256 digest equal to
freshly hashed artifact bytes, the exact predicate type, and a nonempty `verifiedTimestamps` array. It
also rechecks the source repository/ref/commit, signer workflow/digest, OIDC issuer, and hosted-runner
decision represented by the verified certificate result. Zero or multiple matching attestations,
subjects, digests, or an empty timestamp set fail the release. Predicate-carried toolchain fields are
trusted only because the exact verified signer workflow performs and checks those measurements; an
otherwise matching self-reported predicate from another workflow is never accepted.

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
- Parser-boundary raw JSON may accept warned literal secrets, but every action intent uses the
  markerized sanitized aliases and cannot structurally contain a sensitive string.
- Curated omitted updates preserve every readable field required by the replacement-style service
  APIs; raw replacement omissions follow the explicit custom OAuth rules.
- Curated OAuth/payment Updates accept secret-only provision/rotation directives, require no invented
  non-secret change, and can never erase or classify that opaque change as `noChange`.
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
  Supervisor `busy` is a distinct attempt, leaves a verified pair unchanged and explicitly retryable
  without secret I/O, AWS, state, or output work, and never borrows another scope's certainty. Normal
  Ink retirement uses an execution-correlated frame-commit/flush/write-quiescence receipt rather than
  whole-root exit.
- One immutable numeric credential snapshot and eagerly resolved endpoints bind every operation;
  SDK clients receive isolated mutable clones and no operation refreshes midway.
- Every binding factory is total across abort, expiry, provider/endpoint rejection, synchronous throw,
  asynchronous rejection, and late completion; it transfers one binding only through `created` and
  destroys every partial or late resource otherwise.
- File secret acquisition uses the shipped typed native adapter, retains and reads a trusted no-follow
  handle, requires owner-private permissions and ACL/DACL access, and detects pathname substitution or
  observable content change before and after the bounded read. Unsupported targets/filesystems fail
  closed without a weaker fallback.
- Async Commander and Ink failures expose only `SafeIdentityError` output, and untrusted terminal
  controls, Unicode 17.0 default-ignorables/format characters, or encoding collisions cannot affect
  rendering.
- Operation-specific type facets make tolerant reads, ordinary guarded mutations, compatibility-
  guarded OAuth/payment Updates, and direct mutations mutually unavailable at incorrect call sites.
- All workflow family, selector, primary/auxiliary operation, facet, policy, intent, and DTO metadata
  derive from the closed workflow key and are independently compile-tested against substitution.
- Every read facet is total and enforces exact operation status/body completion before Smithy's broad
  2xx handling; production, capture, and replay share one closed outcome matrix.
- Query bindings are abortable and always disposed; pagination clones caller input and never silently
  truncates, loops, mutates caller state, emits partial all-results output, or exposes a rejecting read
  port. Page, item, cumulative wire-byte, and final-output-byte caps return one closed reason before
  rendering. TUI pickers receive only frozen pages through bounded action-owned sessions and never
  receive a continuation token or transport cursor.
- Production continuation tokens use the canonical reversible `identity-token-v1` Base64URL codec and
  round-trip every bounded JavaScript UTF-16 string without conflating terminal escaping with wire data.
- Mutation outcomes distinguish failures before mutation authorization, every indeterminate failure
  after authorization including non-2xx, alternate-2xx, and incomplete responses,
  committed-but-unavailable output, and valid exact-status committed output. Adapter and presentation
  failures preserve the monotonic unknown/committed certainty.
- Complete tag lifecycle works.
- No secret reaches output, error artifacts, fixture content, or fixture identity, including when a
  service reflects a complete resolved managed value through an otherwise allowlisted string, key,
  number, boolean, null, date, page token, request ID, or HTTP-status representation.
- Golden recordings are deterministic across worker schedules and process-safe, and incomplete
  captures, truncated objects, or interrupted installation cannot modify or poison the committed
  fixture set. Request IDs are omitted, safe failure-reason presence is preserved, and no
  unconsumed temporary survives a completed installation attempt; abandoned stable publication
  temporaries are swept by the next native publisher holding both permanent locks. Raw guarded bytes
  are validated before capture recording, fixture statuses are exact per operation, and capture/replay
  bodies are capped at one MiB. Calls remain uncommitted until the real action normalizer accepts them,
  and opaque paginator tokens use reversible per-flow logical aliases. One logical fixture transaction
  wraps every SDK retry: intermediate attempts mutate no fixture state, replay reuses one reservation,
  only the terminal accepted attempt can consume it once, and logical-call discard irreversibly poisons
  the reservation and flow.
- Fixture publication has no JavaScript mutation or check-then-rename fallback. One native transaction
  owns the per-capture, namespace-local publication-authority, and co-located retained-tree locks,
  descriptor-relative cleanup/install/index commit, existing-object verification, and post-commit
  durability result; copied captures, alternate paths, bind mounts, and separate `/tmp` mount
  namespaces cannot bypass the tree serialization authority. Capture, publish, discard, and reap have
  closed command handoffs and definitive-versus-retryable retention rules. Capture seals only after a
  bounded quiescent cleanup snapshot and terminal ledger, binds its exact run root/ID/digest outside
  canonical fixture bytes, and remains unambiguously discoverable if final result output fails.
- The supported Node runtime is `>=22.22.1`; release uses exact Node `22.22.1`, Bun `1.3.14`,
  TypeScript `5.9.3`, and reviewed direct dependency pins. Packed npm and Bun artifacts execute on
  their declared targets; the npm tarball contains `dist`, all six native prebuilds, and
  `THIRD_PARTY_NOTICES.md` while excluding test modules; Node 20 is limited to an isolated N-API v8
  load check.
- Every release artifact has exactly one accepted GitHub-hosted SLSA provenance attestation for
  `aws/agentcore-cli`, the exact release workflow/source commit and tag ref, GitHub's OIDC issuer, the
  artifact digest, and a verified timestamp under the pinned GitHub-only trusted root.
- Unit, router, action, screen, golden, and build checks pass.
- `bunx tsc --noEmit` matches the exact checked-in pre-implementation diagnostic allowlist and has
  zero diagnostics in every touched file.
- Live integration coverage passes against the deploy account, proves readiness and deletion, and
  leaves no current-run resources or Secrets Manager secrets. The exact-run stale reaper mutates only
  on Linux with the original protected root, boot identity, lock object, and
  `STATX_MNT_ID_UNIQUE` proof; all other platforms are audit-only. Its fixed-cap canonical
  `RunLedgerV1` records purpose and only the legal `planned`, `createOutcomeUnknown`,
  `createNotSent`, `observed`, `deleteOutcomeUnknown`, `deleteAccepted`, and `deleted` transitions;
  dual deadlines guard the exact Create handler invocation, uncertainty is persisted before
  Create/Delete, exact acceptance plus absence remains nonterminal, and only the later complete
  zero-finding audit terminalizes deletion. Deletion-unknown rows remain reaper-eligible. Exact
  poll/audit deadlines, per-family token-cycle detection, global
  caps, Secrets Manager planned-deletion sweeps, expected-digest replacement, total
  row/current/send/result derivation, read-only inspection, dry-run behavior, and kill-point recovery
  are exhaustive.
- Design, planning, and implementation receive independent `gpt5.6-sol` architecture, factual,
  security, and implementation-readiness reviews with no unresolved findings and reproducible
  evidence checked into the repository.
