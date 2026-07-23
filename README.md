# AgentCore CLI

`agentcore` is a command-line tool and interactive terminal UI (TUI) for managing
**[AWS Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)** — Amazon's
platform for building and running production AI agents.

It gives you two ways to work, from the same binary:

- **A scriptable CLI** — every operation is a flag-driven subcommand that emits
  JSON (`--json`), so it can be used by codeing agents and can drop cleanly into
  scripts, CI, and automation.
- **An interactive TUI** — run a command with no arguments and it opens a
  full-screen terminal app for browsing resources, filling in wizards, and
  chatting with a live agent.

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

Every leaf command runs headless with flags, or opens the matching TUI screen
when invoked bare.

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
│   └── api-key-credential-provider
│       ├── create                 # create an API key credential provider
│       ├── get                    # get an API key credential provider
│       ├── list                   # list API key credential providers
│       ├── update                 # update an API key credential provider
│       └── delete                 # delete an API key credential provider
├── runtime                        # inspect deployed AgentCore Runtimes
│   ├── get                        # fetch a Runtime by id
│   ├── list                       # list Runtimes (server-side paginated)
│   ├── version
│   │   ├── get                    # get a specific Runtime version
│   │   └── list                   # list a Runtime's versions
│   └── endpoint
│       ├── get                    # get a Runtime endpoint by qualifier
│       └── list                   # list a Runtime's endpoints
└── config                         # read/write global config values
```

Global flags (declared at the root, available on every command):

| Flag             | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `--region`       | AWS region (falls back to `AWS_REGION`, then the shared AWS config). |
| `--json`         | Emit machine-readable JSON instead of launching the TUI.             |
| `--debug`        | Debug logging.                                                       |
| `--endpoint-url` | Override the service endpoint URL (e.g. for testing against a stub). |

### Examples

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

# Manage API key credential providers
agentcore identity api-key-credential-provider create --name my-provider --api-key <key>
agentcore identity api-key-credential-provider get --name my-provider
agentcore identity api-key-credential-provider list --max-results 10
agentcore identity api-key-credential-provider update --name my-provider --api-key <new-key>
agentcore identity api-key-credential-provider delete --name my-provider
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
npm unlink -g agentcore
```

To test the exact published artifact instead:

```bash
npm pack                          # builds via prepublishOnly, creates the .tgz
npm i -g ./agentcore-1.0.0.tgz
```

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
  the same patterns extend naturally to gateways, memory, browser profiles,
  and the other control-plane resources.
- **Implement `config`.** The `config` command is currently a stub — it should
  read/write real global settings (telemetry, log level, ...) through an
  injected config accessor.
