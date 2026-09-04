# AgentCore CLI

`agentcore` is a command-line tool and interactive terminal UI (TUI) for managing
**[AWS Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)** — Amazon's
platform for building and running production AI agents.

It gives you two ways to work, from the same binary:

- **A scriptable CLI** — every operation is a flag-driven subcommand that emits
  JSON (`--json`), so it can be used by codeing agents and can drop cleanly into
  scripts, CI, and automation.
- **An interactive TUI** — bare Harness, Runtime, Memory, Identity, and Gateway
  branches and leaves open their corresponding menus and selection flows, and a
  bare `project create` opens a guided create wizard.

```bash
agentcore                      # launch the interactive TUI
agentcore harness list --json  # scriptable, machine-readable output
```

## What problem does it solve?

Bedrock AgentCore is administered through several AWS SDK APIs (a control plane,
a data plane, and IAM for execution roles). Driving those directly means writing
a lot of boilerplate, hand-managing IAM roles, and stitching together streaming
responses. `agentcore` wraps all of that behind one ergonomic tool.

## Command surface

Commands with operation flags run headlessly. Bare Harness, Runtime, Memory,
Identity, and Gateway branches and leaves open their interactive flows, as does
a bare `project create` in a terminal (any flag, `--json`, or a non-TTY stays
headless). A bare `project status` opens a Linked Resources view that groups
the project's resources by agent and forwards to each deployed resource's
detail page. The harness hub (`harness get`) ends with the same kind of Linked
Resources tree for the Runtime, Memory, Gateway, Browser, Code Interpreter and
credential providers wired to that harness, each opening in its own region; the
region then follows that resource through its actions, lists and detail views.

```
agentcore                          # interactive TUI
├── harness                        # manage agentcore harnesses
│   ├── create                     # create a harness (auto-provisions a role if none given)
│   ├── get                        # fetch a harness by id
│   ├── list                       # list harnesses (server-side paginated)
│   ├── update                     # update a harness
│   ├── delete                     # delete a harness
│   ├── invoke                     # chat with / prompt a harness (streams the reply)
│   ├── exec                       # run a shell command in a harness runtime
│   ├── version
│   │   ├── list                   # list a harness's versions
│   │   └── get                    # get a specific version
│   └── endpoint
│       ├── create
│       ├── get
│       ├── list
│       ├── update
│       └── delete
├── identity                       # manage AgentCore Identity resources
│   ├── api-key-credential-provider
│   │   ├── create                 # create an API key credential provider
│   │   ├── get                    # get an API key credential provider
│   │   ├── list                   # list API key credential providers
│   │   ├── update                 # update an API key credential provider
│   │   └── delete                 # delete an API key credential provider
│   └── oauth2-credential-provider
│       ├── create                 # create an OAuth2 credential provider
│       ├── get                    # get an OAuth2 credential provider
│       ├── list                   # list OAuth2 credential providers
│       ├── update                 # update an OAuth2 credential provider
│       └── delete                 # delete an OAuth2 credential provider
├── runtime                        # inspect deployed AgentCore Runtimes
│   ├── get                        # fetch a Runtime by id
│   ├── list                       # list Runtimes (server-side paginated)
│   ├── invoke                     # invoke a Runtime headlessly or in a persistent console
│   ├── shell                      # open a persistent interactive terminal in a Runtime
│   ├── logs                       # follow a Runtime's logs live, or search a time window
│   ├── traces
│   │   ├── list                   # list a Runtime's recent traces
│   │   └── get                    # download a trace's log records to a JSON file
│   ├── version
│   │   ├── get                    # get a specific Runtime version
│   │   └── list                   # list a Runtime's versions
│   └── endpoint
│       ├── get                    # get a Runtime endpoint by qualifier
│       └── list                   # list a Runtime's endpoints
├── memory                         # inspect AgentCore Memories
│   ├── get                        # fetch a Memory by id
│   ├── list                       # list Memories (server-side paginated)
│   ├── event
│   │   ├── get                    # get an Event from a Memory session
│   │   └── list                   # list Events from a Memory session
│   └── record
│       ├── get                    # get a long-term Memory record
│       └── list                   # list long-term Memory records
├── gateway                        # manage AgentCore Gateways
│   ├── get                        # get a Gateway by id
│   ├── list                       # list Gateways (server-side paginated)
│   ├── invoke                     # invoke a Gateway headlessly or in a persistent console
│   ├── target
│   │   ├── get                    # get a Target under a Gateway
│   │   └── list                   # list Targets under a Gateway
│   ├── connector
│   │   ├── get                    # get a connector-backed Target
│   │   └── list                   # list connector-backed Targets
│   ├── rule
│   │   ├── get                    # get a Rule under a Gateway
│   │   └── list                   # list Rules under a Gateway
│   └── policy
│       └── generate               # generate Cedar for a Gateway from a prompt (TUI when run bare)
├── eval                           # evaluate and optimize AgentCore agents
│   └── evaluator                  # manage AgentCore evaluators
│       ├── llm-as-a-judge         # LLM-as-a-Judge evaluators
│       │   ├── create             # create (instructions + rating scale + model)
│       │   └── update             # update (merged over the existing config)
│       ├── code-based             # code-based (Lambda-backed) evaluators
│       │   ├── create             # create (Lambda ARN + optional timeout)
│       │   └── update             # update (merged over the existing config)
│       ├── get                    # get an evaluator by id (type-agnostic)
│       ├── list                   # list evaluators (server-side paginated)
│       └── delete                 # delete an evaluator by id
├── project                        # manage an AgentCore project (scaffold → deploy)
│   ├── create                     # create a project: a managed harness by default,
│   │                              #   or scaffolded runtime code via --template;
│   │                              #   bare `project create` opens an interactive wizard
│   ├── add                        # add a resource to the project (runtime, harness, memory, …)
│   ├── export
│   │   └── harness                # convert a harness into an editable Strands runtime agent
│   ├── remove                     # remove a resource from the project spec (spec-level;
│   │                              #   code under app/ is kept). Resource types: harness,
│   │                              #   runtime, credential, config-bundle, online-eval,
│   │                              #   online-insight, memory, gateway, gateway-target,
│   │                              #   gateway-connector, policy-engine, policy,
│   │                              #   payment-manager, payment-connector — or `all`, which
│   │                              #   empties every resource collection (y/N prompt; --yes
│   │                              #   skips it for non-interactive use)
│   ├── dev                        # run the project locally
│   ├── deploy                     # deploy to AWS (auto-provisions the default target)
│   ├── invoke                     # invoke a deployed project resource
│   │   ├── runtime                # use the existing Runtime invoke experience
│   │   └── harness                # use the existing Harness invoke experience
│   ├── status                     # inspect deployed project resources (TUI when run bare)
│   └── build                      # synthesize the project's CloudFormation templates
└── config                         # read/write global config values
```

`project export harness` "ejects" a harness to code you own: it renders a
Python Strands agent under `app/<target-agent-name>/` mapping the harness spec
(model, system prompt, tools, skills, memory, execution limits), registers the
new runtime in `agentcore.json` (the harness entry stays), and writes an
`EXPORT_NOTES.md` in the agent directory listing anything that could not be
mapped mechanically. Pass `--name <harness>` for an in-project harness or
`--arn <harnessArn>` to fetch a deployed one (the fetch uses the region
embedded in the ARN); `--target-agent-name` overrides the default
`<harnessName>Agent`. The exported agent is always a `CodeZip` runtime: it
declares its own dependencies, so it needs no image build. If the harness used a
pre-built container image or a custom Dockerfile, that is reported in
`EXPORT_NOTES.md` rather than rebuilt. Path-based skills are not supported,
since the exported agent has no container filesystem to read them from.

Global flags (declared at the root, available on every command):

| Flag             | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `--region`       | AWS region (falls back to `AWS_REGION`, then the shared AWS config). |
| `--json`         | Emit machine-readable JSON instead of launching the TUI.             |
| `--debug`        | Debug logging.                                                       |
| `--endpoint-url` | Override the service endpoint URL (e.g. for testing against a stub). |

### Invoke a project resource

Run `agentcore project invoke` from inside a project to choose a deployed
Runtime or Harness interactively. Headless invocation keeps each resource's
existing input contract:

```bash
agentcore project invoke runtime \
  --name checkout \
  --payload '{"prompt":"Check order 123."}' \
  --content-type application/json

agentcore project invoke harness \
  --name support \
  --prompt "Help with my account."
```

Use `--target` to select a deployment target. When a project declares exactly
one resource of the requested type, `--name` may be omitted.

### Examples

```bash
# Create a project. The default is a harness project: a managed agent
# configured by spec, no model-loop code to maintain. Passing only --name
# scaffolds the default harness.
agentcore project create --name MyAssistant
cd MyAssistant && agentcore project deploy
# … or run `agentcore project create` bare in a terminal for the guided
# wizard (name → harness or template → confirm), which drives the same
# creation path.
agentcore harness invoke --id <id from the deploy outputs> --prompt "hello"

# Scaffold runtime code instead by selecting a template. Templates that support
# a model provider (agent-python-strands) accept --model-provider/--api-key;
# add the -container suffix for a container build, or use `empty` for a project
# with no runtime.
agentcore project create --name MyAgent --template agent-python-strands
# The same Strands agent built as a container image, with a Dockerfile.
agentcore project create --name MyAgent --template agent-python-strands-container
# A LangChain agent on Bedrock, built with create_agent.
agentcore project create --name MyAgent --template agent-python-langchain

# Translate an existing Amazon Bedrock Agent version into editable runtime code
# with `project add runtime --type import` from inside a project. The selected
# alias identifies the immutable source version; generated code invokes models
# and translated tools directly rather than proxying the alias. Use --framework
# strands (default) or langgraph. The alias must point at a prepared version,
# not the mutable DRAFT that the built-in test alias (TSTALIASID) routes to.
# Anything that could not be translated is listed in the generated IMPORT_NOTES.md.
agentcore project add runtime --name MyImportedAgent --type import \
  --agent-id A1B2C3D4E5 --agent-alias-id XYZ123ABC4 --region us-east-1 \
  --framework strands
```

```bash
# Create a harness; a default execution role is created for you.
agentcore harness create \
  --name my-agent \
  --system-prompt "You are a helpful assistant." \
  --model '{"bedrockModelConfig":{"modelId":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"}}' \
  --json

# List and inspect
agentcore harness list --json
agentcore harness get --id <harnessId> --json

# One-shot prompt (streams, then prints the full transcript as JSON)
agentcore harness invoke --id <harnessId> --prompt "Summarize this repo." --json

# Interactive chat (no --prompt): opens the TUI chat at that harness/session
agentcore harness invoke --id <harnessId>
agentcore harness invoke --id <harnessId> --session-id <session> --qualifier PROD

# Run a shell command inside the agent runtime
agentcore harness exec --id <harnessId> --command "ls -la" --json

# Inspect deployed Runtimes without project configuration or deployment
agentcore runtime get --id <runtimeId>
agentcore runtime list --max-results 20
agentcore runtime version get --id <runtimeId> --version <version>
agentcore runtime version list --id <runtimeId> --max-results 20
agentcore runtime endpoint get --id <runtimeId> --qualifier DEFAULT
agentcore runtime endpoint list --id <runtimeId> --max-results 20

# Follow a Runtime's logs live (Ctrl+C to stop); inside a project --id is optional
agentcore runtime logs --id <runtimeId>
agentcore runtime logs --id <runtimeId> --level error --query "database"

# Search a past window instead (--since/--until switch to search mode)
agentcore runtime logs --id <runtimeId> --since 1h --limit 100
agentcore runtime logs --id <runtimeId> --since 2026-08-30T12:00:00Z --until now --json

# List recent traces (they take 2-3 minutes to appear), then download one
agentcore runtime traces list --id <runtimeId> --since 30m
agentcore runtime traces get <traceId> --id <runtimeId> --output trace.json

# Inspect AgentCore Memories without project configuration or deployment
agentcore memory get --id <memoryId>
agentcore memory get --id <memoryId> --view without_decryption
agentcore memory list --max-results 20
agentcore memory event get --id <memoryId> --actor-id <actorId> --session-id <sessionId> --event-id <eventId>
agentcore memory event list --id <memoryId> --actor-id <actorId> --session-id <sessionId> --max-results 20
agentcore memory record get --id <memoryId> --record-id <recordId>
agentcore memory record list --id <memoryId> --namespace <namespace> --max-results 20

# Inspect Gateway resources without project configuration or deployment
agentcore gateway get --id <gatewayId>
agentcore gateway list --max-results 20
agentcore gateway invoke --id <gatewayId> --payload file://request.json
agentcore gateway invoke --id <gatewayId> # open the persistent JSON console
agentcore gateway target get --gateway-id <gatewayId> --target-id <targetId>
agentcore gateway target list --gateway-id <gatewayId> --max-results 20
agentcore gateway connector get --gateway-id <gatewayId> --id <targetId>
agentcore gateway connector list --gateway-id <gatewayId> --max-results 20
agentcore gateway rule get --gateway-id <gatewayId> --rule-id <ruleId>
agentcore gateway rule list --gateway-id <gatewayId> --max-results 20
agentcore gateway policy generate --gateway-id <gatewayId> --prompt "forbid IAM callers from every tool"
agentcore gateway policy generate --gateway-id <gatewayArn> --prompt file://policy.txt --json
# Pipe the generated Cedar into a project (run inside the project)
agentcore gateway policy generate --gateway-id <gatewayId> --prompt "..." \
  | agentcore project add policy --engine Guardrails --name Generated --statement -

# Manage API key credential providers
agentcore identity api-key-credential-provider create --name my-provider --api-key <key>
agentcore identity api-key-credential-provider get --name my-provider
agentcore identity api-key-credential-provider list --max-results 10
agentcore identity api-key-credential-provider update --name my-provider --api-key <new-key>
agentcore identity api-key-credential-provider delete --name my-provider

# Manage OAuth2 credential providers (guided Custom OAuth2, or --provider-configuration for other vendors)
agentcore identity oauth2-credential-provider create \
  --name my-oauth-provider \
  --vendor CustomOauth2 \
  --client-id <client-id> \
  --discovery-url https://issuer.example.com/.well-known/openid-configuration \
  --client-secret -
agentcore identity oauth2-credential-provider get --name my-oauth-provider
agentcore identity oauth2-credential-provider list --max-results 10
agentcore identity oauth2-credential-provider delete --name my-oauth-provider

# Manage evaluators
# Create an LLM-as-a-Judge evaluator with a rating-scale preset.
agentcore eval evaluator llm-as-a-judge create \
  --name order-support-quality \
  --level SESSION \
  --model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --instructions "Judge from {context} whether the order-support agent answered correctly." \
  --rating-scale 1-5-quality \
  --json

# Create a code-based (Lambda-backed) evaluator; timeout defaults to the service value.
agentcore eval evaluator code-based create \
  --name refund-policy-compliance \
  --level SESSION \
  --lambda-arn arn:aws:lambda:us-west-2:123456789012:function:refund-policy \
  --json

# Get, list, delete.
agentcore eval evaluator get --id <evaluatorId> --json
agentcore eval evaluator list --max-results 20 --json
agentcore eval evaluator delete --id <evaluatorId> --json

# Remove resources from a project's spec (run inside the project)
agentcore project remove memory --name recall
agentcore project remove credential --name svc-key   # also deletes its .env.local entries
agentcore project remove gateway-target --gateway tools --name search
agentcore project remove all                         # y/N prompt; empties every collection
agentcore project remove all --yes                   # non-interactive
```

Source-aware values: any field flag documented as such accepts the value inline,
`file://<path>` to read it from a file, or `-` to read it from stdin (the AWS CLI
`file://` convention). A command reads stdin from at most one flag. For example,
`--instructions file://order-quality.txt` or `--instructions -`.

### Invoke a Gateway

Gateway Invoke is a project-independent HTTP request command with headless and
interactive modes. It gets the Gateway by ID, uses the returned HTTPS origin,
selects authentication from the Gateway's authorizer, and preserves the request
and response bodies.

```bash
# MCP Gateway: use the exact gatewayUrl returned by GetGateway.
agentcore gateway invoke \
  --id <gatewayId> \
  --payload '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"agentcore-cli","version":"1"}}}' \
  --accept 'application/json, text/event-stream' \
  --mcp-protocol-version 2025-03-26

# HTTP target: --path is relative to the Gateway origin.
agentcore gateway invoke \
  --id <gatewayId> \
  --path support-agent/invocations \
  --payload file://request.json \
  --session-id <runtimeSessionId>

# Inference target.
agentcore gateway invoke \
  --id <gatewayId> \
  --path inference/v1/messages \
  --payload file://message.json \
  --json

# GET requests do not accept a payload.
agentcore gateway invoke \
  --id <gatewayId> \
  --method GET \
  --path inference/v1/models
```

`--path` replaces the path in the returned Gateway URL while retaining its
origin. It must remain relative to the selected Gateway and may include a query
string. Omitting it uses the returned `gatewayUrl` exactly. Supported methods
are `GET`, `POST` (the default), and `DELETE`. POST requires `--payload`; DELETE
may include one. Payloads accept inline bytes, `file://<path>`, or `-` for stdin.

Authentication follows `GetGateway.authorizerType`: `AWS_IAM` and
`AUTHENTICATE_ONLY` requests use SigV4, `CUSTOM_JWT` requires `--bearer-token`,
and `NONE` uses unsigned HTTPS. Bearer tokens accept inline, `file://`, or stdin
sources; payload and token cannot both read stdin.

Raw responses stream exact bytes to stdout. `--output-file` streams those bytes
to disk, while `--json` buffers one envelope containing status, selected session
and request metadata, body encoding, and body. Binary or unknown output requires
`--output-file` or `--json` when stdout is a terminal. Response metadata goes to
stderr in raw and file modes. Redirects are returned without being followed.
Non-2xx response bodies use the selected output mode before the command exits
with a failure status.

Without `--payload`, Gateway Invoke opens a persistent POST JSON console. Bare
invoke opens the Gateway picker, while `--id` opens the selected Gateway
directly. `--path`, `--session-id`, MCP session flags, `--header`, and
`--bearer-token` seed the console. Interactive bearer tokens may be inline or
`file://` sources, but not stdin. Explicit headless-only flags such as
`--method`, `--accept`, `--content-type`, `--output-file`, or `--json` keep the
command headless.

The console generates and displays a Runtime session ID, adopts returned Runtime
and MCP sessions, and streams textual responses as they arrive. An empty path
uses the exact `gatewayUrl`; `Ctrl+P` edits the raw Gateway-relative path and
`Ctrl+T` switches Gateways. Switching Gateways clears request context, while
changing paths preserves the draft and Gateway authentication but starts fresh
sessions.

| Shortcut      | Action                                       |
| ------------- | -------------------------------------------- |
| `Enter`       | Send the JSON request                        |
| `Shift+Enter` | Insert a newline                             |
| `Ctrl+P`      | Edit the Gateway-relative path               |
| `Ctrl+T`      | Change Gateway                               |
| `Ctrl+V`      | Toggle raw and pretty completed JSON         |
| `Esc`         | Interrupt an active request or navigate back |
| `↑`/`↓`       | Scroll response history                      |

Gateway Invoke V1 has no request-type selector, target/path discovery,
tool/model discovery command, authentication editor, or protocol-specific
payload builder. Callers provide the Gateway-relative route and protocol payload
directly. GET and DELETE remain available through headless invoke.

### Invoke a Runtime

Headless invocation accepts inline, file, or stdin payload bytes:

```bash
# Inline
agentcore runtime invoke \
  --id <runtimeId> \
  --payload '{"action":"status"}' \
  --content-type application/json \
  --accept text/event-stream

# File
agentcore runtime invoke --id <runtimeId> --payload file://request.json

# stdin
cat request.json | agentcore runtime invoke --id <runtimeId> --payload -
```

CUSTOM_JWT Runtimes require `--bearer-token`. The token accepts the same inline,
`file://`, or stdin sources as the payload; payload and token cannot both read
stdin.

```bash
agentcore runtime invoke \
  --id <runtimeId> \
  --payload file://request.json \
  --bearer-token file://$HOME/.config/agentcore/runtime-token
```

For MCP Runtimes, initialize first, then pass the returned Runtime and MCP
session IDs to later methods. MCP requests accept both JSON and SSE responses.

```bash
agentcore runtime invoke \
  --id <runtimeId> \
  --payload '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"agentcore-cli","version":"1"}}}' \
  --accept 'application/json, text/event-stream' \
  --mcp-protocol-version 2025-03-26 \
  --mcp-method initialize

agentcore runtime invoke \
  --id <runtimeId> \
  --payload '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  --accept 'application/json, text/event-stream' \
  --session-id <returnedRuntimeSessionId> \
  --mcp-session-id <returnedMcpSessionId> \
  --mcp-protocol-version 2025-03-26 \
  --mcp-method tools/list
```

Raw stdout always streams exact response bytes as they arrive, regardless of
content type. `--output-file` streams the same bytes directly to disk. Binary or
unknown responses require `--output-file` or `--json` when stdout is a terminal.
Response metadata is written to stderr.

`--json` buffers the complete response, including streaming representations, and
emits one metadata envelope without interpreting the customer body. If a raw or
file response fails, bytes already written remain available and the stderr
summary reports `complete=false`. A failed JSON response emits no partial
envelope.

```bash
agentcore runtime invoke \
  --id <runtimeId> \
  --payload file://request.bin \
  --content-type application/octet-stream \
  --accept application/octet-stream \
  --output-file response.bin

agentcore runtime invoke --id <runtimeId> --payload '{"action":"status"}' --json
# {"statusCode":200,"contentType":"application/json","bodyEncoding":"utf8","body":"{\"ok\":true}","complete":true}
```

Without `--payload`, Runtime Invoke opens a persistent JSON console for repeated
requests. The console sends inline `application/json` payloads and renders each
response according to its returned content type. Bare invoke opens the Runtime
and endpoint pickers; `--id` skips the Runtime picker, and `--id` plus
`--qualifier` opens the console directly. `--session-id` resumes that Runtime
session in the console. `--user-id`, `--header`, and `--bearer-token` seed
request context that persists across sends and endpoint changes within that
Runtime. The console never displays their values, and switching Runtimes clears
them. Interactive bearer tokens may be inline or `file://` sources, but not
stdin.

| Shortcut      | Action                                       |
| ------------- | -------------------------------------------- |
| `Enter`       | Send the JSON request                        |
| `Shift+Enter` | Insert a newline                             |
| `Ctrl+T`      | Change Runtime or endpoint                   |
| `Ctrl+V`      | Toggle raw and pretty completed JSON         |
| `Esc`         | Interrupt an active request or navigate back |
| `↑`/`↓`       | Scroll response history                      |

Runtime Invoke accepts Runtime IDs from the current account only. It does not
accept ARNs, `--version`, `--interactive`, cross-account targets, or custom
request paths. All requests use the Runtime `/invocations` route, including MCP
Runtimes.

### Open a Runtime shell

Runtime Shell opens a persistent interactive terminal in a Runtime session.
Bare shell opens the Runtime and endpoint pickers. `--id` skips the Runtime
picker, and `--id` plus `--qualifier` connects directly.

```bash
agentcore runtime shell
agentcore runtime shell --id <runtimeId>
agentcore runtime shell --id <runtimeId> --qualifier DEFAULT
```

Use `--session-id` to open the shell in a specific Runtime session/VM:

```bash
agentcore runtime shell \
  --id <runtimeId> \
  --qualifier DEFAULT \
  --session-id <runtimeSessionId>
```

CUSTOM_JWT Runtimes require `--bearer-token`. Interactive bearer tokens may be
inline or `file://` sources, but not stdin.

The shell forwards terminal input byte-for-byte, including `Ctrl+C`, `Ctrl+D`,
escape sequences, and full-screen terminal applications. Terminal resize events
update the remote PTY. Running `exit` or sending `Ctrl+D` terminates the remote
shell.

Runtime Shell requires TTY stdin and stdout and does not support `--json` or
`--endpoint-url`.

Bare Runtime branches and leaves, plus `memory`, `memory get`, and `memory list`,
require a TTY on stdin and stdout.
For Runtime Invoke, supplying a payload or headless-only request or output flags
runs headlessly; `--session-id` can instead seed the persistent console.
Supplying Memory operation flags runs those commands headlessly, and `--json`
always suppresses TUI rendering. The `memory event` and `memory record` groups
are headless: invoking a group without a leaf prints help, and their leaves
require resource selectors.

```bash
agentcore runtime
agentcore runtime list
agentcore runtime get
agentcore runtime version list
agentcore runtime endpoint list
agentcore memory
agentcore memory list
agentcore memory get
agentcore memory event
agentcore memory record
```

The Identity TUI is read-only: bare `identity` branches and the `get`/`list`
leaves open interactive menus and detail views. Mutations (`create`, `update`,
`delete`) remain available through the CLI and are omitted from the TUI menus.

```bash
agentcore identity
agentcore identity api-key-credential-provider list
agentcore identity api-key-credential-provider get
agentcore identity oauth2-credential-provider list
agentcore identity oauth2-credential-provider get
```

The Gateway TUI is read-only: bare Gateway, Target, Connector, and Rule
branches and their `get`/`list` leaves open command menus and scoped selection
flows. Connector is presented as a separate resource experience while using
Gateway Target operations internally.

```bash
agentcore gateway
agentcore gateway list
agentcore gateway get
agentcore gateway target list
agentcore gateway target get
agentcore gateway connector list
agentcore gateway connector get
agentcore gateway rule list
agentcore gateway rule get
```

---

# Architecture & patterns

This section documents the architectural conventions the codebase is built
around. They exist to keep the app modular, testable, and predictable as it
grows.

## The big picture

```
                         ┌───────────────────────────┐
   argv  ─────────────▶  │  Router / Handler tree    │   src/router, src/handlers
                         │  (flags, args, middleware)│
                         └────────────┬──────────────┘
                                      │
                    flags/args ?      │      bare command ?
                          │           │            │
                          ▼                        ▼
                 ┌─────────────────┐      ┌───────────────────┐
                 │ headless handler│      │  Ink/React TUI    │   src/tui, src/components
                 │  → JSON output  │      │  (same handlers)  │
                 └────────┬────────┘      └────────┬──────────┘
                          │                        │
                          └──────────┬─────────────┘
                                     ▼
                          ┌───────────────────────┐
                          │  Core (CoreClient)    │   src/core
                          │  feature sub-clients  │
                          └──────────┬────────────┘
                                     ▼
                     AWS SDK: Bedrock AgentCore (control + data) + IAM
```

The CLI and the TUI are two front-ends over the **same** handler tree and the
**same** `Core` clients. Dependencies are injected at the edge in the main entrypoint (`src/index.ts`),
which is what makes the whole thing testable end-to-end.

## The Router / Handler framework

The whole CLI is expressed as a tree of **`Handler`** nodes wired together by a
**`Router`** (`src/router/`). A `Router` is itself a mountable branch node, so
routers nest to form the command tree (`agentcore` → `harness` → `get`). Every
command — branch or leaf — is a `Handler`:

- **Branch nodes** (routers) host subcommands and may declare group-level
  ("global") flags and middleware that apply to everything beneath them. A
  branch can also register a **default handler** (`router.default(...)`) that
  runs when the branch is invoked with no subcommand (e.g. bare `agentcore` or
  `agentcore harness` — this is how the TUI launches).
- **Leaf nodes** (built with `createHandler(...)`) do the work. They declare
  their own flags/arguments (validated and coerced via zod schemas) and receive
  a typed object in `handle(ctx, flags, args)`.

Every node — branch or leaf — satisfies the `Handler` interface:

```ts
export interface Handler {
  name(): string;
  description(): string;
  flags(): Flag[];
  arguments(): Argument[];
  // At runtime `handle` receives the validated, coerced flags object. The precise
  // shape is supplied to authors via createHandler's generic; the interface keeps
  // it erased so middleware can forward it uniformly.
  handle: (ctx: Context, flags: any, args: any) => Promise<void>;
  children(): Handler[];
}
```

Under the hood the tree is compiled into a [Commander](https://github.com/tj/commander.js)
command tree (`src/router/router.tsx`), so `--help`, argument parsing, and error
handling come from a battle-tested parser while the authoring API stays small.

Cross-cutting values flow through a typed **`Context`**. Group-level flags
(`globalFlag(...)`) double as context keys, so a flag declared high in the tree
is read type-safely by any descendant via `ctx.value(key)` / `ctx.require(key)`.

```ts
export interface Context {
  // value returns the value previously stored under `key`, or undefined if absent.
  value<V>(key: ContextKey<V>): V | undefined;
  // require returns the value stored under `key`, throwing if it is absent.
  require<V>(key: ContextKey<V>): V;
  // withValue returns a new Context that carries `key`/`value` on top of this one.
  withValue<V>(key: ContextKey<V>, value: V): Context;
}
```

**Middleware** (`router.use(...)`) wraps handlers down the subtree in
ancestor-first order — for example `withRegion` resolves the effective AWS
region once at the root and pins it on the context for every command below. A
middleware is just a function that wraps one `Handler` in another:

```ts
export type Middleware = (handler: Handler) => Handler;
```

### Putting it all together

A minimal, self-contained example — a router with one piece of middleware and a
`greet` leaf handler:

```ts
import z from "zod";
import { Router, createHandler, flag, globalFlag, type Middleware } from "./router";

// A group-level flag that doubles as a typed context key.
const LoudKey = globalFlag("loud", "shout the greeting", z.boolean().default(false));

// Middleware wraps every handler beneath where it's mounted. Here it just logs.
const withLogging = (): Middleware => (h) => ({
  name: () => h.name(),
  description: () => h.description(),
  flags: () => h.flags(),
  arguments: () => h.arguments(),
  children: () => h.children(),
  handle: async (ctx, flags, args) => {
    console.error(`> running ${h.name()}`);
    await h.handle(ctx, flags, args);
  },
});

// A leaf handler. `flags` is precisely typed from the zod schemas, and the
// group-level LoudKey is read back off the context.
const greet = createHandler({
  name: "greet",
  description: "greet someone",
  flags: [flag("name", "who to greet", z.string().default("world"))] as const,
  handle: async (ctx, flags) => {
    const message = `hello, ${flags.name}!`;
    console.log(ctx.value(LoudKey) ? message.toUpperCase() : message);
  },
});

// Wire it together: flags + middleware live on the router, handlers mount under it.
const app = new Router("demo", "a tiny demo CLI")
  .groupFlags(LoudKey)
  .use(withLogging())
  .handler(greet);

await app.route(process.argv);
```

```bash
demo greet --name Ada          # hello, Ada!
demo greet --name Ada --loud   # HELLO, ADA!
```

## Adding a new handler

Each command lives in its own directory with a consistent file layout. Using
`harness` as the model:

```
src/handlers/harness/
├── index.tsx      # createHarnessHandler(core): builds the Router/Handler, wires
│                  #   subcommands, middleware, flags, and the default handler
├── screen.tsx     # the Ink/React screen(s) rendered for this command in the TUI
├── types.tsx      # the interface(s) this command consumes from Core (see below)
├── get/           # a subcommand, same layout recursively
│   ├── index.tsx
│   └── screen.tsx
└── list/
    ├── index.tsx
    └── screen.tsx
```

Conventions:

- **`index.tsx`** exports a `create<Name>Handler(core)` factory returning a
  `Handler`/`Router`. Dependencies (the `Core` client) are passed in, never
  imported as singletons. Re-export the command's `screen.tsx` from here.
- **`screen.tsx`** exports the React component(s) for the TUI. Screens receive
  `ScreenProps` (`{ ctx, core }`) threaded down from `Root`, and drive data
  fetching with react-query against `core`.
- **`types.tsx`** defines the interface(s) this command needs from Core.
- Shared helpers live in a sibling `utils.tsx` (e.g. `coreOptsFromCtx(ctx)`
  builds the standard `CoreOptions` from context values).
- Shared components live in `src/components/`: anything rendered by more than
  one screen belongs there (e.g. `Layout`, `RouterScreen`, `HarnessPicker`),
  with the vendored InkUI primitives under `src/components/ui/`. A handler
  directory contains only the screens for its own command.

Mount the new handler by adding `root.handler(create<Name>Handler(core))` in
`src/handlers/index.tsx` (or on the appropriate parent router).

## Core and dependency inversion

Business logic and all I/O (AWS SDK calls, etc.) live in **`src/core/`**, behind
a `CoreClient` that exposes feature-scoped sub-clients (e.g. `core.harness`).
`CoreClient` owns the underlying AWS clients — the Bedrock AgentCore
**control** plane (CRUD, versions, endpoints), the **data** plane (invoke, exec
streaming), **IAM** (default execution roles) — caching one per config.

The important rule: **interfaces are defined by their consumers, not by Core.**
The `CoreHarnessClient` interface lives in `src/handlers/harness/types.tsx` —
next to the handler that uses it — and `src/core/harness.tsx` provides the
implementation. Handlers depend on the interface they declare; Core depends on
nothing about the handlers. This is **dependency inversion**: the
high-level policy (handlers) owns the abstraction, and the low-level detail
(Core/SDK) conforms to it.

Construction is also inverted. `CoreClient` doesn't build SDK clients directly;
it takes **factory functions** (`(config) => new BedrockAgentCore...Client(...)`)
injected at the app edge in `src/index.ts`. That keeps the SDK swappable —
crucial for the testing strategy below.

## The TUI

The interactive UI is built with [Ink](https://github.com/vadimdemedes/ink)
(React for the terminal). `renderTui` mounts the `Root` component
(`src/components/Root.tsx`) — a MemoryRouter over the app's route table plus a
react-query client — seeded at the command's path. Because routes map to the
same handler paths as the CLI, deep-linking works: `harness invoke --id X` opens
the chat screen at that harness. Ink reads and writes through the injected IO
streams, so the TUI is fully testable without a real terminal.

## Testing

Tests sit next to the code they cover as `<file>.test.tsx` (e.g.
`src/router/router.test.ts`), run with `bun test`. Shared test infrastructure
lives in `src/testing/`.

The guiding principle is **test behavior, not implementation**: a good test lets
a maintainer refactor freely and only fails when observable behavior changes.
This is possible because the app injects every dependency at its edges, so a
test can build the whole CLI with test doubles at the boundary and drive a real
command flow — argument parsing, middleware, handler, Core, and (for the TUI)
rendering — as a single unit, asserting on the output a user would see.

We aim for **90% line coverage** (`bun test --coverage`).

### Injected IO

Nothing in the app reaches for `process.stdout`/`console.*` directly. An `AppIO`
(`{ stdin, stdout, stderr }`, defined in `src/handlers/types.tsx`) is passed to
`createRootHandler(core, io)` at the edge (`src/index.ts` passes the real process
streams) and threaded down to the TUI renderer and handlers. JSON output flows
through the context: a `withJsonRenderer` middleware pins a `JsonRenderer` wired
to the configured stdout, and leaf handlers emit via
`ctx.require(JsonRendererKey).renderJson(...)`. In tests, `testIO()` supplies an
in-memory `AppIO` with `stdout()`/`stderr()` accessors, so a command's output is
captured with no global patching.

### Golden files and record mode

Handler tests run the real `CoreClient` over fixture-backed SDK clients and
compare rendered output against committed **golden files**. The record/replay
seam sits at the SDK `.send()` boundary (the same seam `src/index.ts` wires the
real clients into), so replayed tests still exercise the real `CoreClient`,
`HarnessClient`, and option translation — only the network call is swapped out.

Two modes, selected by the `RECORD` env var:

```bash
RECORD=1 bun test   # hit the live AWS APIs and (re)write fixtures + golden files
bun test            # replay the saved fixtures; never touch the network
```

Recording lets the suite be fast, deterministic, and runnable offline/in CI.
Refresh the fixtures by re-running in record mode when the APIs or expected
output change. Fixtures are Date-safe (Dates round-trip via a tagged encoding)
and strip volatile transport metadata (`$metadata`, request IDs) so they stay
stable. Golden files are excluded from Prettier (`.prettierignore`) — they are
byte-for-byte recordings, not source to reformat.

See [this talk](https://www.youtube.com/watch?v=yszygk1cpEc&t=1s) for background
on the pattern.

### TUI tests

Screens are tested with
[`ink-testing-library`](https://github.com/vadimdemedes/ink-testing-library) via
the `renderScreen(path, { core })` helper (`src/testing/renderScreen.tsx`). It
mounts the real `Root` (MemoryRouter + the app's route table + react-query)
seeded at a command path — exactly how the CLI mounts a screen — so routing,
route params, data fetching, key input, and rendering are all exercised
together. Data comes from a `TestCoreClient` (a hand-controllable `Core` that
returns canned responses, forces errors, and records calls). Assertions read the
rendered frame (`waitForText`, `lastFrame`) and key presses drive navigation
between screens (`press`, `write`).

## Repository layout

```
src/
  index.ts        # app entry: wires real SDK factories + process IO into the root handler
  router/         # the Router/Handler framework (compiles to Commander)
  handlers/       # the command tree; one directory per command (index/screen/types)
  core/           # CoreClient + feature sub-clients; all AWS SDK I/O lives here
  middleware/     # cross-cutting middleware (withRegion, withJsonRenderer, ...)
  tui/            # Ink renderer entry (renderTui / renderTuiAt) + JSON renderer
  components/     # shared TUI components; ui/ holds vendored InkUI primitives
  testing/        # test doubles + helpers (testIO, renderScreen, fixtures, golden IO)
  runnable/       # top-level run/exit-code wrapper
```

---

# Development

Install [Bun](https://bun.com).

```bash
brew install oven-sh/bun/bun
```

Install dependencies:

```bash
bun install
```

Run from source:

```bash
bun run start
```

Run tests:

```bash
bun test
```

## Run Locally

Build, then symlink the `agentcore` command globally so it works from any directory:

```bash
bun run build
npm link
```

Re-run `bun run build` after changes; the linked command picks it up. Remove with:

```bash
npm unlink -g @aws/agentcore
```

To test the exact published artifact instead:

```bash
npm pack                          # builds via prepublishOnly, creates the .tgz
npm i -g ./aws-agentcore-0.28.1.tgz
```

## Windows notes

- **`agentcore.ps1 cannot be loaded because running scripts is disabled`**: the
  npm shim is a PowerShell script and Windows Server defaults to a `Restricted`
  execution policy. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
  once, or call `agentcore.cmd`. The compiled `.exe` has no shim.
- **The CLI looks frozen in a PowerShell window**: legacy conhost pauses all
  output while text is selected (the title bar shows `Select`). Press `Esc`.
  Windows Terminal does not do this.
- **`project create` refuses a long path**: Windows caps paths at 260 characters
  unless `LongPathsEnabled` is set, and the CDK app's `node_modules` needs about
  100 of them. Create the project higher in the tree or enable long paths.

# Build

Run `make` to verify bun is installed, build the Node bundle, and compile all native binaries:

```bash
make          # check-bun -> build -> compile (all platforms)
make bundle    # node bundle only (dist/index.js)
make compile  # native binaries only (dist/bin/)
make clean    # remove dist/
```

`make` errors out early if bun is not installed.

Bundle the CLI into `dist/` for distribution. The bundle targets Node.js and is the artifact published to npm (via the `bin` entry):

```bash
make bundle
```

The output (`dist/index.js`) can be run directly with Node:

```bash
node dist/index.js
```

## Native binaries

Compile standalone executables (Bun runtime embedded; no Node/Bun required to run) for all platforms into `dist/bin/`:

```bash
make compile
```

Targets (build individually with `bun run compile:<target>`):

| Script                  | Output                        |
| ----------------------- | ----------------------------- |
| `compile:darwin-x64`    | `agentcore-darwin-x64`        |
| `compile:darwin-arm64`  | `agentcore-darwin-arm64`      |
| `compile:linux-x64`     | `agentcore-linux-x64`         |
| `compile:linux-arm64`   | `agentcore-linux-arm64`       |
| `compile:windows-x64`   | `agentcore-windows-x64.exe`   |
| `compile:windows-arm64` | `agentcore-windows-arm64.exe` |

Each binary is ~60–95MB (embedded runtime).

# Formatting

Format all files with Prettier:

```bash
bun run format        # write changes
bun run format:check  # check only
```

A Husky pre-commit hook runs Prettier (via lint-staged) on staged files automatically. It installs on `bun install`.

# Next Steps

- **Cover more AgentCore resources.** The harness surface (CRUD, versions,
  endpoints, invoke, exec) is fully implemented in both the CLI and the TUI;
  the same patterns extend naturally to the remaining read-only Memory
  data-plane operations, browser profiles, and the other AgentCore resources.
- **Implement `config`.** The `config` command is currently a stub — it should
  read/write real global settings (telemetry, log level, ...) through an
  injected config accessor.
