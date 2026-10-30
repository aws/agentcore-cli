# Contributing

[Back to README](README.md)

[Contribution requirements](#before-opening-a-pull-request) | [Development](#development) | [Build](#build) | [Architecture](#architecture--patterns) | [Testing](#testing)

Run development commands from the repository root.

## Before Opening a Pull Request

- **Link an issue.** Every PR needs a related [GitHub issue](https://github.com/aws/agentcore-cli/issues).
  Open one if none exists, and discuss larger changes with the maintainers before implementing them.
- **Use the PR template.** Complete the repository's
  [pull request template](.github/pull_request_template.md),
  including the issue, a description of the change, and your test results.
- **Keep the change focused.** Work on a feature branch in your fork and keep unrelated fixes
  out of the PR. Use conventional commit messages such as `fix:`, `feat:`, or `docs:`.
- **Add or update tests.** Cover behavior changes and add a regression test for bug fixes.
  Update affected fixtures and snapshots. Do not disable tests or remove assertions to make checks pass.
  Test observable behavior, not implementation detail: a test that only restates what the code
  does adds maintenance cost without catching a regression, and reviewers will ask for it to go.
- **Run the checks.** Unit tests, typechecking, linting, formatting, the dependency and secret
  scans, and the build must pass: `bun test`, `bun run typecheck`, `bun run lint:check`,
  `bun run format:check`, `bun run audit`, `bun run secrets:check`, and `bun run build`.
  Run the relevant [end-to-end tests](e2eTest/README.md) for changes to deployment or AWS interactions.
  All required CI checks must pass before merge.
- **Keep the documentation current.** Update affected commands, examples, and configuration
  guidance in `README.md` and `docs/`. Call out breaking changes and any migration steps in the PR.
  Do not regenerate `command.md` — see [Generated files](#generated-files).
- **Comment why, not what.** A comment earns its place by adding what the code cannot say for
  itself: the reason behind a non-obvious choice, a constraint, or why an alternative was rejected.
  Delete comments that restate the line below them, and prefer a clearer name over an explanation.
- **Report what you verified.** List the checks you ran and their results. State explicitly
  when a test could not be run and why. Do not include credentials or customer data in code,
  fixtures, or logs.

## Generated files

Two files in the tree are generated. Neither is hand-edited, and they are refreshed at
different times:

- **`command.md`** is generated from `agentcore --help`. The release workflow
  (`.github/workflows/release-prepare.yml`) regenerates it and commits it in the release PR,
  so **leave it out of a feature PR.** Regenerating it on a feature branch picks up every
  other command change merged since the last release, which buries your diff in unrelated
  churn. Run `bun scripts/generate-command-reference.mjs` locally if you want to preview how
  your `--help` will read, then revert the file before committing.
- **Fixtures and golden files** under `src/handlers/**/__fixtures__/` are recordings. Refresh
  them with `RECORD=1 bun test <file>` — see [Golden files and record mode](#golden-files-and-record-mode).

## Changes that span repositories

The CLI vends CDK projects built from [`@aws/agentcore-cdk`](https://github.com/aws/agentcore-l3-cdk-constructs),
pinned in `src/assets/cdk/package.json`. A change that has to reach a deployed resource lands in
three steps, in order:

1. The CloudFormation resource must publish the property. The CLI deploys the control plane
   only through CloudFormation and has no escape hatch, so a property absent from the resource
   schema is one the CLI cannot set.
2. The L3 construct change merges and is released in `aws/agentcore-l3-cdk-constructs`.
3. The pin in `src/assets/cdk/package.json` is bumped to that release.

Link the companion PR from this one, and expect the pin bump to be a follow-up rather than part
of the same change.

## Development

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

### Run Locally

Build, then symlink the `agentcore` command globally so it works from any directory:

```bash
bun run build
npm link
```

Re-run `bun run build` after changes; the linked command picks it up. Remove with:

```bash
npm unlink -g @aws/agentcore
```

To test the locally packed distribution instead:

```bash
bun run build
TARBALL=$(npm pack --silent)
npm i -g "./$TARBALL"
```

### Windows notes

- **`agentcore.ps1 cannot be loaded because running scripts is disabled`**: the
  npm shim is a PowerShell script and Windows Server defaults to a `Restricted`
  execution policy. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
  once, or call `agentcore.cmd`. The compiled `.exe` has no shim.
- **The CLI looks frozen in a PowerShell window**: legacy conhost pauses all
  output while text is selected (the title bar shows `Select`). Press `Esc`.
  Windows Terminal does not do this.
- **`agentcore create` refuses a long path**: Windows caps paths at 260 characters
  unless `LongPathsEnabled` is set, and the CDK app's `node_modules` puts its
  deepest file 155 characters below the project root (aws-cdk-lib's own shipped
  fixtures), so the project root must be at most 104 characters. Create the
  project higher in the tree or enable long paths.

## Build

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

### Native binaries

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

## Formatting

Format all files with Prettier:

```bash
bun run format        # write changes
bun run format:check  # check only
```

A Husky pre-commit hook runs `oxlint --fix` and then Prettier (via lint-staged) on staged files
automatically. It installs on `bun install`.

## Architecture & patterns

This section documents the architectural conventions the codebase is built
around. They exist to keep the app modular, testable, and predictable as it
grows.

### The big picture

```
                         ┌───────────────────────────┐
   argv  ─────────────▶  │  Router / Handler tree    │   src/router, src/handlers
                         │  (flags, args, middleware)│
                         └────────────┬──────────────┘
                                      │
                    headless mode     │      interactive mode
                          │           │            │
                          ▼                        ▼
                 ┌─────────────────┐      ┌───────────────────┐
                 │ headless handler│      │  Ink/React TUI    │   src/tui, src/components
                 │  → JSON or bytes│      │  (same handlers)  │
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

### The Router / Handler framework

The whole CLI is expressed as a tree of **`Handler`** nodes wired together by a
**`Router`** (`src/router/`). A `Router` is itself a mountable branch node, so
routers nest to form the command tree (`agentcore` → `harness` → `get`). Every
command — branch or leaf — is a `Handler`:

- **Branch nodes** (routers) host subcommands and may declare group-level
  ("global") flags and middleware that apply to everything beneath them. A
  branch can also register a **default handler** (`router.default(...)`) that
  runs when the branch is invoked with no subcommand (e.g. bare `agentcore` or
  `agentcore add` — this is how the TUI launches).
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
  doesSupportTui(): boolean;
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

#### Putting it all together

A minimal, self-contained example — a router with one piece of middleware and a
`greet` leaf handler. Its relative imports assume the example is under `src/`:

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
  doesSupportTui: () => h.doesSupportTui(),
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

### Adding a new handler

Each command lives in its own directory with a consistent file layout. Using
`harness` as the model:

```
src/handlers/harness/
├── index.tsx      # createHarnessHandler(core, io): builds the Router/Handler, wires
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

- **`index.tsx`** exports a `create<Name>Handler(...)` factory returning a
  `Handler`/`Router`. Dependencies (such as `Core` and `AppIO`) are passed in,
  never imported as singletons. Re-export the command's `screen.tsx` from here.
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

Mount the new handler in `src/handlers/index.tsx` (or on the appropriate parent
router), passing its dependencies, as in `root.handler(createHarnessHandler(core, io))`.

`flag(name, description, schema, { group, help })` takes two optional extras that shape `--help`:
`group` is the heading the flag is listed under, and `help` is long-form text printed in a
`Parameter details:` section. Keep long `help` in a sibling file named for what it documents —
`src/handlers/eval/online-eval/filtersHelp.tsx` and `harness/parameterHelp.tsx` are the models — and
follow their house style: a one-line summary, the JSON shape with `// [required]` annotations, a link
to the API reference, and two worked examples. A flag taking tags goes through `parseTags`
(`src/handlers/utils.tsx`), which accepts one JSON object or repeated `key=value` entries and
validates both against `TagsSchema`; do not hand-roll tag parsing.

### What a change touches beyond its handler

Work this out before editing anything. Missing one of these is the most common reason a PR
needs a second review round.

**A new flag, field or output value on an existing command:**

| File                                     | Change                                                    | When                                      |
| ---------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| `src/handlers/<domain>/<leaf>/index.tsx` | add to the `flags: [flag(...)]` array with its zod schema | always                                    |
| `src/handlers/<domain>/types.tsx`        | widen the Core interface the handler consumes             | if the value reaches the SDK              |
| `src/core/<domain>.tsx`                  | put the value into the SDK request                        | if the value reaches the SDK              |
| `src/projectSchemas/<resource>.ts`       | add the field to the zod project schema                   | only on an `agentcore add` path           |
| `src/core/project/backends/cdk.ts`       | map it to the deployed resource                           | only if it must reach a deployed resource |
| `src/testing/TestCoreClient.tsx`         | add the new method to the matching test sub-client        | if a Core interface gained a method       |
| the handler's `*.test.tsx`               | a command-flow case covering the new value                | always                                    |
| `__fixtures__/` and `*.golden.json`      | re-record with `RECORD=1`                                 | if the SDK request changed                |
| `README.md`, `docs/`                     | update the guidance that covers it                        | if it exists                              |

**A new leaf** adds its own directory (`index.tsx`, `screen.tsx` if it has a TUI screen),
and must be mounted on its parent router — registration order is `--help` order. Add it to
the parent's `.supportedTuiCommands(...)` only if it has a screen; mutation leaves ship
headless first, and the TUI menu lists them under its command-line-only divider. The
domain's test suite usually asserts the router's exact child list and menu entries (and
`src/handlers/root.test.tsx` does for top-level commands), so update those assertions too.

**A new Core sub-client** — a domain Core did not talk to before — is declared on the `Core`
type in `src/handlers/types.tsx`, constructed in `CoreClient` (`src/core/index.tsx`), and
mirrored by a test sub-client in `src/testing/TestCoreClient.tsx`, which implements `Core`
and so fails typecheck until it matches.

**A new resource with a project collection** also needs its `src/projectSchemas/<resource>.ts`
schema registered in `project.ts` with `.superRefine(uniqueNames("<resource>"))`, a Core
sub-client, a deploy mapping in `src/core/project/backends/cdk.ts`, and the companion L3
construct (see [Changes that span repositories](#changes-that-span-repositories)). Add a
`type: z.literal(...)` discriminator only if the sibling schemas have one — most do not.

**A new TUI screen** must also be routed: add its `<Route>` entries to the route table in
`src/components/Root.tsx` and import it there, or the screen is unreachable however correct it is.
A bare parent path (`…/get` with no id) gets a `Navigate` to the list, which is what
`withTuiOnEmptyFlagsAndArgs` lands on. The screen uses `useWindowSize` from
`src/components/ui/useWindowSize.tsx`, puts a wrapper shared by more than one screen in
`src/components/`, and needs a screen test through `renderScreen`. A new primitive under `src/components/ui/` is a larger change than it looks;
raise it before building one.

### Core and dependency inversion

AWS operations and project orchestration live in **`src/core/`**, behind
a `CoreClient` that exposes feature-scoped sub-clients (e.g. `core.harness`).
Reusable file, process, stream, and terminal I/O utilities live in **`src/io/`**.
`CoreClient` owns the underlying AWS clients — the Bedrock AgentCore
**control** plane (CRUD, versions, endpoints), the **data** plane (invoke, exec
streaming), **IAM** (default execution roles) — caching one per config.

The important rule: **interfaces are defined by their consumers, not by Core.**
The `CoreHarnessClient` interface lives in `src/handlers/harness/types.tsx` —
next to the handler that uses it — and `src/core/harness.tsx` provides the
implementation. Handlers depend on the interface they declare; Core implements
that contract without depending on command routing or screens. This is
**dependency inversion**: the high-level policy (handlers) owns the abstraction,
and the low-level detail (Core/SDK) conforms to it.

Construction is also inverted. `CoreClient` doesn't build SDK clients directly;
it takes **factory functions** (`(config) => new BedrockAgentCore...Client(...)`)
injected at the app edge in `src/index.ts`. That keeps the SDK swappable —
crucial for the testing strategy below.

The import direction follows from this. **Core imports the contracts the handlers declare
— the types in `src/handlers/<domain>/types.tsx` — and nothing that presents.** It never
imports a screen, a component, a router, or user-facing text. When something in Core needs
presentation — an error hint, a suggested next command — it belongs in the handler instead. Put it where every caller reaches it, though: a hint
added only to a screen is missing from the headless path, which is where most users hit the
error.

Loose helper functions that all operate on the same state belong on the type that owns it
(`ProjectManager`, `SourceResolver`) rather than as a module of free functions passed the
same argument. Reserve free functions for genuinely stateless utilities.

### The TUI

The interactive UI is built with [Ink](https://github.com/vadimdemedes/ink)
(React for the terminal). `renderTui` mounts the `Root` component
(`src/components/Root.tsx`) — a MemoryRouter over the app's route table plus a
react-query client — seeded at the command's path. Because routes map to the
same handler paths as the CLI, deep-linking works: `harness invoke --id X` opens
the chat screen at that harness. Ink reads and writes through the injected IO
streams, so the TUI is fully testable without a real terminal.

### Testing

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

#### Injected IO

A command with live output does not go through the JSON renderer: it writes the bytes to
`io.stdout` as they arrive and keeps progress, banners and session metadata on `io.stderr`, so a
caller can redirect one without the other. `--json` suppresses the streaming and emits one folded
object instead.

Handlers and screens use injected streams for user-facing output. An `AppIO`
(`{ stdin, stdout, stderr }`, defined in `src/io/types.ts`) is passed in the
configuration object to `createRootHandler(core, { io, logger, globalConfigAccessor })`
at the edge (`src/index.ts` passes the real process streams) and threaded down to
the TUI renderer and handlers. JSON output flows
through the context: a `withJsonRenderer` middleware pins a `JsonRenderer` wired
to the configured stdout, and leaf handlers emit via
`ctx.require(JsonRendererKey).renderJson(...)`. In tests, `testIO()` supplies an
in-memory `AppIO` with `stdout()`/`stderr()` accessors, so a command's output is
captured with no global patching.

#### Golden files and record mode

Handler tests run the real `CoreClient` over fixture-backed SDK clients and
compare rendered output against committed **golden files**. The record/replay
seam sits at the SDK `.send()` boundary (the same seam `src/index.ts` wires the
real clients into), so replayed tests still exercise the real `CoreClient`,
`HarnessClient`, and option translation — only the network call is swapped out.
Calls that are not AWS SDK operations — a presigned URL, a non-AWS HTTP service — go
through the `fetch` injected into `CoreClient`, and record and replay the same way through
`fixtureFetch(dir)`. `src/handlers/feedback/feedback.fixture.test.tsx` is the model.

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

Four things to know before you record one:

- **Scrub account-specific values out of the recording.** `matchGolden` strips presigned
  URLs and normalizes JSON, but nothing else. An account ID, an ARN, or a generated
  resource name recorded from your own account is committed verbatim and will not
  reproduce on anyone else's, so the next person to re-record sees a diff with no
  behavior change behind it. Use `uniquePerRecording` (`src/testing/fixtures.tsx`) for
  values that must stay stable across re-records, and keep account-derived identifiers
  out of asserted output.
- **The two failure messages mean different things.** `Missing fixture …` means the SDK
  request your handler sends has changed, because fixture keys hash that request — either
  re-record or leave the request alone. `Missing golden file …` just means this assertion
  has never been recorded; record it.
- **Build a fresh `CoreClient` per run.** It carries per-run caches, so sharing one across
  tests leaks state between them. See the `createFixtureCore()` helper in
  `src/handlers/harness/harness.test.tsx`.
- **A new AWS client needs a new fixture factory.** `fixtureFactories` returns one factory
  per client the CLI talks to (CloudFormation, AgentCore control and data, IAM, CloudWatch
  Logs, X-Ray, Application Signals). A handler reaching a service that is not in that list
  cannot replay until the factory is added.

A golden file records what a user sees, so review it like output, not like a blob: if the
diff is not explainable by your change, something else moved.

A test that hand-builds part of an SDK response casts it `as unknown as <ResponseType>`, the idiom
across the suite. A bare `as <ResponseType>` on a partial literal compiles only until the literal
contains a nested optional, then fails comparability in both directions with TS2352.

### Two things that make a command unrecordable until the harness is extended

Check both against the operation you are adding **before** writing the handler. Finding out
afterwards means reworking `CoreClient`'s constructor or the test harness, not just your
command.

- **A value generated per run inside the SDK request.** Fixture keys hash the request, so a
  fresh `randomUUID()` session id, timestamp, or generated name produces a fresh hash on
  every run and the fixture can never be found again. Inject the generator at the Core edge
  — `CoreClient` takes it as config, defaulting to the real implementation — so a test can
  pin it. A handler that calls the generator directly cannot be replayed at all.
- **A streaming response.** `makeRecordingSend` cannot serialise a stream, so there is
  nothing to record. The operation needs freeze-on-record / revive-on-replay support in
  `src/testing/fixtures.tsx` before a test over it can exist.

### Which test to write

Prefer a fixture-backed command-flow test over a unit test when the command's value is its
rendered output. A unit test over a Core helper asserts the shape you just wrote; the
command-flow test asserts what the customer sees, through the real parser, middleware, Core
and renderer. When you add command-flow coverage, delete the unit test it replaces rather
than keeping both.

See [this talk](https://www.youtube.com/watch?v=yszygk1cpEc&t=1s) for background
on the pattern.

#### TUI tests

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

### Repository layout

```
src/
  index.ts        # app entry: wires real SDK factories + process IO into the root handler
  router/         # the Router/Handler framework (compiles to Commander)
  handlers/       # the command tree; one directory per command (index/screen/types)
  core/           # CoreClient + feature sub-clients; all AWS SDK I/O lives here
  io/             # shared file, process, stream, and terminal I/O utilities
  projectSchemas/ # project configuration schemas and validation
  globalConfig/   # persistent CLI settings and defaults
  logging/        # structured file logging
  telemetry/      # CLI usage metrics
  errors/         # typed CLI errors and exit-code handling
  secrets/        # at-rest encryption and sensitive-key redaction for project state
  cliVersionManager/ # update checks against the npm registry + the update notice
  assets/         # generated project, runtime, harness, and CDK assets
  middleware/     # cross-cutting middleware (withRegion, withJsonRenderer, ...)
  tui/            # Ink renderer entry (renderTui / renderTuiAt) + JSON renderer
  components/     # shared TUI components; ui/ holds vendored InkUI primitives
  testing/        # test doubles + helpers (testIO, renderScreen, fixtures, golden IO)
  runnable/       # top-level run/exit-code wrapper
```
