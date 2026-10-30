# AGENTS.md

`@aws/agentcore`: the AgentCore CLI (`agentcore`). TypeScript, React/Ink TUI, Commander under a
custom Router/Handler framework, AWS SDK v3, zod. Developed with Bun, **shipped to run under Node**
(npm bundle) and as Bun-compiled standalone binaries.

**Read `CONTRIBUTING.md` first** for architecture (Router/Handler tree, Context, middleware,
Core + dependency inversion, TUI, testing strategy, repo layout). This file only adds what is not
obvious from there or from the code.

## Commands

Use Bun for tooling (`bun install`, `bun run`, `bunx`). Lockfile is `bun.lock`; CI runs
`bun install --frozen-lockfile`.

| Task                            | Command                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Run from source                 | `bun run start <args>` (or `bun src/index.ts <args>`)                            |
| Unit tests                      | `bun test` (single file: `bun test path/to/file.test.tsx`)                       |
| Unit tests with coverage (CI)   | `bun test --coverage --coverage-reporter=lcov`                                   |
| Re-record fixtures/golden files | `RECORD=1 bun test <file>` (hits live AWS, needs credentials)                    |
| Typecheck                       | `bun run typecheck` (`tsc --noEmit`)                                             |
| Lint                            | `bun run lint:check` (oxlint; `bun run lint` auto-fixes)                         |
| Format                          | `bun run format:check` / `bun run format` (Prettier)                             |
| Secrets scan                    | `bun run secrets:check`                                                          |
| npm bundle                      | `bun run build` -> `dist/index.js`, `dist/main.js`, `dist/assets/`               |
| Native binary                   | `bun run compile:<darwin-arm64\|linux-x64\|windows-x64\|...>` -> `dist/bin/`     |
| E2E (real AWS)                  | `bun run build && AGENTCORE_CLI_PATH="node $PWD/dist/index.js" bun run test:e2e` |
| E2E by tag                      | `bun run test:e2e -- --tagsFilter='runtime \|\| canary'`                         |
| Regenerate `command.md`         | `bun scripts/generate-command-reference.mjs`                                     |

Before finishing a change run `bun test`, `bun run typecheck`, `bun run lint:check`,
`bun run format:check`, and ideally `bun run build`. These are CI gates in
`.github/workflows/verify.yml`, along with `bun audit` and `secrets:check`.

## Critical gotchas

- **No `Bun` global in `src/`.** oxlint's `no-restricted-globals` bans it because the npm bundle
  runs on Node (`engines.node >= 20.12`). Use `node:*` APIs in `src/`. `Bun.*` is allowed only in
  `scripts/**`, `src/testing/**`, `**/*.test.*`, and `**/*-test-support.ts`. Generic Bun advice
  (Bun.serve, Bun.file, bun:sqlite, Bun.$) does **not** apply to shipped code.
- **Two test runners.** Unit tests use `bun test` (`import { test, expect, describe } from "bun:test"`).
  E2E tests in `e2eTest/` use **vitest** (`vitest.e2e.config.ts`), deploy real resources, and are
  excluded from `bun test` via `pathIgnorePatterns` in `bunfig.toml`. Don't mix the imports.
- **Test preload.** `src/testing/setup.ts` sets `FORCE_COLOR=0`, `WT_SESSION`, and
  `AGENTCORE_TELEMETRY_DISABLED=1` so Ink frames are plain text and glyphs are Unicode. Frame
  assertions depend on this.
- **Global config keys.** Adding a global config key means updating `types.tsx`,
  `DEFAULT_GLOBAL_CONFIG`, and `applyOverrides` in `src/globalConfig/`. Retired keys in an existing
  `~/.agentcore/config.json` are dropped on read (the zod schema strips unknown keys).
- **TUI support is opt-in per router, at any depth**, via that router's `.supportedTuiCommands(...)`;
  `compile()` threads support down the tree, so a nested router hides its own leaves (24 routers under
  `src/handlers/` declare one). Omitting a leaf keeps it command-line only. A branch's _own_ support is
  not its decision: `Router.doesSupportTui()` always returns `true`, so whether a group launches the
  TUI depends entirely on whether its parent's list names it. A new group its parent does not list
  inherits no TUI dispatch; one the parent does list launches the TUI on a bare invocation even with no
  screen of its own, and its `.default(...)` runs only when the TUI is declined — `--json`, no TTY, or
  the parent leaving it out. Test a bare invocation of any new group for exactly this.
  Handler registration order is `--help` and menu order. Commands without TUI support
  are omitted from the TUI menu.
  `.menuSection(title)` draws a menu divider above the next registered handler (menu only).
- **Terminal size: use `useWindowSize` from `src/components/ui/useWindowSize.tsx`, not Ink's.**
  Ink's hook adds a stdout `resize` listener per call (every `Divider` calls it), so busy screens
  trip Node's `MaxListenersExceededWarning`; the local hook shares one listener per stream.
- **Fixture keys hash the SDK request input.** Fixtures are `__fixtures__/<CommandName>.<hash>.json`,
  hashed over the command `input` (top-level `clientToken` excluded). Any change to the request a
  handler sends (new field, different default, different region) makes replay fail with
  "Missing fixture ... Re-run with RECORD=1". Either re-record against live AWS or keep the request
  unchanged. The fixture path depends only on the request, so a request sent several times — a
  poll for a long-running job — records to one file, each call overwriting the last; replay serves
  the final recorded response to every call. A key whose value is `undefined` is dropped before hashing (the key is
  `JSON.stringify`'d), so a new optional field left unset keeps the old hash — a new optional flag is
  replay-safe whenever it is absent. It also means **a per-run value inside the request makes the command permanently
  unreplayable** — a `randomUUID()` session id or a timestamp rehashes every run. Inject the
  generator through `CoreClient`'s config (defaulting to the real one) so tests can pin it. A
  **streaming response** likewise cannot be recorded until `src/testing/fixtures.tsx` grows
  freeze/revive support for it. Tests pin `--region us-west-2` for stable recordings. Never hand-edit or reformat
  fixtures/golden files (`__fixtures__` and `*.snap` are Prettier-ignored). Use `settle()` and
  `uniquePerRecording()` from `src/testing/fixtures.tsx` for service state transitions and
  per-recording unique values.
- **`src/assets/` is data, not code.** Project templates (Python/TS agents), the CDK app, and
  evaluator Lambdas. Excluded from tsc, Prettier, oxlint, and `bun test`. The build embeds assets
  as raw bytes and fails on any non-UTF-8 file. `src/assets/agent-inspector/` is gitignored and
  staged at build time from `@aws/agent-inspector` (files get a `.asset` suffix);
  `AGENT_INSPECTOR_PATH` overrides it with a local build. `scripts/sync-vended-cdk.ts` pins
  `@aws/agentcore-cdk` in `src/assets/cdk/package.json` (release workflow; must not import `src/`).
- **`command.md` is generated, and not yours to regenerate.** `release-prepare.yml` runs
  `bun scripts/generate-command-reference.mjs` and commits the result in the release PR. Leave it
  out of a feature PR: regenerating on a branch pulls in every command change merged since the
  last release, and reviewers ask for it to be backed out. Generate locally to preview your
  `--help`, then revert. Section grouping lives in `DEFAULT_GROUPS` in that script.
- **Build quirks** (`scripts/build.ts`): `@aws-cdk/toolkit-lib` is external in the npm bundle but
  inlined in compiled binaries (so the bootstrap template is embedded explicitly); identifiers are
  never minified because stack traces and telemetry error names depend on them. `dist/index.js` is
  a loader that enables Node's compile cache then imports `dist/main.js`.
- **A context value a middleware resolves is never `undefined` below it.** `withRegion` at the
  root replaces `RegionKey` with the resolved region (flag → env → config → `DEFAULT_REGION`)
  before any handler runs, so `ctx.value(RegionKey)` is always set and a guard on its absence is
  dead code. To tell "the user passed `--flag`" from "something resolved a default", capture that
  before the middleware runs — don't infer it from the context value. **A zod `.default()` on a
  flag hides the same distinction**: by the time `handle` runs, a defaulted flag and a passed one are
  identical. If any rule depends on the user having passed it, declare the schema `.optional()` and
  apply the default in `handle`, and put the default's value in the flag description so `--help`
  still states it.
- **The e2e suite is not a PR gate.** `.github/workflows/e2e-test.yml` runs only on
  `workflow_call` / `workflow_dispatch` and checks caller authorization, so nothing runs it for a
  contributor automatically. Run it locally with credentials and say so in the PR.
- **A deploy-path field needs three things, in order**: the property published on the
  `AWS::BedrockAgentCore::*` resource (there is no `AwsCustomResource` escape hatch), the L3
  construct released from `aws/agentcore-l3-cdk-constructs`, then the `@aws/agentcore-cdk` pin in
  `src/assets/cdk/package.json` bumped. Check `src/core/project/backends/cdk.ts` for whether the
  resource is mapped at all.
- **Check emptiness, not presence, on optional collections.** `config.insights` existing as `[]`
  is not the same as the feature being configured; test `(x?.length ?? 0) > 0`.
- Line endings are LF (`.gitattributes`). The Husky pre-commit hook runs lint-staged
  (oxlint --fix + Prettier) on staged files.
- Root-level `.*.bun-build` files are compile leftovers (gitignored); ignore them.

## Conventions

- Prettier: double quotes, semicolons, trailing commas, width 100, 2-space indent.
- tsconfig is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type`
  for type-only imports). Relative imports often include the extension (`./harness/index.tsx`),
  and most files are `.tsx` even without JSX; follow the neighbouring files.
- Handler directories: `index.tsx` (`create<Name>Handler(core, io)` factory), `screen.tsx`
  (imported directly by the route table in `src/components/Root.tsx`), `types.tsx` (the Core interface the handler consumes; implemented in
  `src/core/`). Leaf handlers use `createHandler({ name, description, flags: [flag(...)], handle })`
  with zod-validated flags. Emit JSON via `ctx.require(JsonRendererKey).renderJson(...)` and write
  through the injected `AppIO`; never touch `process.stdout` directly in handlers.
- Build `CoreOptions` from context with `coreOptsFromCtx(ctx)` (`src/handlers/utils.tsx`).
- A leaf that prints human-readable output unless `--json` is passed reads `ctx.value(JsonKey)`
  (`src/handlers/keys.tsx`) to choose; 29 handlers do.
- Errors: throw `AgentCoreCLIError` subclasses (`src/errors/`), which carry `source`
  (user/service/internal), `exitCode`, and `meta` for logging and telemetry.
  `AgentCoreCLIError.fromError` maps Commander errors to exit code 2 and SDK 4xx to user errors.
  `SilentCLIError` (`src/errors/errors.tsx`) is the one to throw when the command has already
  written its own output and only needs to carry an exit code — a remote command's exit status, for
  instance — so the root handler does not print a second message over it.
  Error text is asserted behaviour: when you refactor an error path, keep everything the old
  message named. If it identified which item failed, the replacement must still identify it —
  moving the identity into a structured field does not excuse dropping it from the sentence the
  user reads.
- Runtime files: logs in `~/.agentcore/logs/`, global CLI settings in `~/.agentcore/config.json`.
- Commits and PR titles use conventional commits with scope: `feat(invoke): ...`,
  `fix(tui): ...`, `refactor(gateway): ...`, `test(cli): ...`. PRs must link an issue and follow
  `.github/pull_request_template.md`.

## Testing patterns

- Tests live beside code as `*.test.ts(x)`; name any test-support file `*.test-support.ts` so it
  is not mistaken for shipped code. Target is 90% line coverage, but coverage is a floor on
  behavior tested, not a quota to fill — a test asserting what the implementation plainly says
  gets removed in review. For a flag, the case worth testing is usually the one where it is
  **absent**, since that is the path a default or a middleware silently changes.
- `testIO().stdout()` / `.stderr()` return the captured text with the trailing newline trimmed, so
  assert `toBe("hello")`, not `toBe("hello\n")`. A new helper or constant in `src/testing/` is only
  visible to tests once it is re-exported from the `src/testing/index.tsx` barrel.
- **Client tests** go one layer lower, for assertions about the request a Core client builds:
  `new EvalClient({ data: () => ({ send: mock(fn) }) as never } as unknown as AwsClients)`, then assert
  the SDK command's `input`. No fixture, no recording — the right choice when the point is the request
  itself. Several `src/core/*.test.tsx` files use it.
- **Command-flow tests** build the real stack: `new CoreClient({ ...fixtureFactories(FIXTURES), logger: createSilentLogger() })`,
  then `createRootHandler(core, { io: testIO().io, ... })`, then
  `root.route(["node", "agentcore", ...args, "--region", REGION])`, asserting captured stdout with
  `matchGolden(FIXTURES, "name.golden.json", out)`. Model: `src/handlers/harness/harness.test.tsx`.
- Routers using `withTuiOnEmptyFlagsAndArgs` launch the TUI when a leaf gets no flags/args; pass
  `--json` in headless tests of such commands.
- **Screen tests** use `renderScreen(path, { core: new TestCoreClient(), globalConfig })` from
  `src/testing/renderScreen.tsx`, driving with `press`/`write` and asserting with
  `waitForText`/`lastFrame`.
- Pass `platform: "win32"` to `createRootHandler` or `renderScreen` to exercise Windows branches;
  CI runs unit tests on Linux, Windows, and macOS.
- Shared helpers are exported from `src/testing/index.tsx` (`testIO`, `expectError`,
  `createSilentLogger`, `TestGlobalConfigAccessor`, fixture helpers including `fixtureFetch` for
  non-SDK HTTP). `menuEntries` in `src/testing/renderScreen.tsx` reads a rendered TUI menu,
  split at its command-line-only divider.
