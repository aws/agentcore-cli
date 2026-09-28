# AGENTS.md

`@aws/agentcore`: the AgentCore CLI (`agentcore`). TypeScript, React/Ink TUI, Commander under a
custom Router/Handler framework, AWS SDK v3, zod. Developed with Bun, **shipped to run under Node**
(npm bundle) and as Bun-compiled standalone binaries.

**Read `CONTRIBUTING.md` first** for architecture (Router/Handler tree, Context, middleware,
Core + dependency inversion, TUI, testing strategy, repo layout). This file only adds what is not
obvious from there or from the code. `CLAUDE.md` is a symlink to this file.

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
- **Standalone resource commands are gated.** `harness`, `identity`, `runtime`, `memory`, `gateway`,
  and `payment` are only mounted when global config `"imperative-commands"` is true (default false;
  see `src/handlers/index.tsx`, `src/globalConfig/config.tsx`). Tests for those commands must pass
  `IMPERATIVE_GLOBAL_CONFIG` (from `src/testing`) as `globalConfig` and as the
  `TestGlobalConfigAccessor` initial data, or to `renderScreen(..., { globalConfig })`. Adding a
  global config key means updating `types.tsx`, `DEFAULT_GLOBAL_CONFIG`, and `applyOverrides`.
- **TUI support is opt-in per top-level command** via the root's `.supportedTuiCommands(...)`.
  Handler registration order is `--help` and menu order, but the menu moves commands without a
  screen under a "command line only" divider unless the router names them in `.listInMenu(...)`.
  `.menuSection(title)` draws a menu divider above the next registered handler (menu only).
- **Fixture keys hash the SDK request input.** Fixtures are `__fixtures__/<CommandName>.<hash>.json`,
  hashed over the command `input` (top-level `clientToken` excluded). Any change to the request a
  handler sends (new field, different default, different region) makes replay fail with
  "Missing fixture ... Re-run with RECORD=1". Either re-record against live AWS or keep the request
  unchanged. Tests pin `--region us-west-2` for stable recordings. Never hand-edit or reformat
  fixtures/golden files (`__fixtures__` and `*.snap` are Prettier-ignored). Use `settle()` and
  `uniquePerRecording()` from `src/testing/fixtures.tsx` for service state transitions and
  per-recording unique values.
- **`src/assets/` is data, not code.** Project templates (Python/TS agents), the CDK app, and
  evaluator Lambdas. Excluded from tsc, Prettier, oxlint, and `bun test`. The build embeds assets
  as raw bytes and fails on any non-UTF-8 file. `src/assets/agent-inspector/` is gitignored and
  staged at build time from `@aws/agent-inspector` (files get a `.asset` suffix);
  `AGENT_INSPECTOR_PATH` overrides it with a local build. `scripts/sync-vended-cdk.ts` pins
  `@aws/agentcore-cdk` in `src/assets/cdk/package.json` (release workflow; must not import `src/`).
- **`command.md` is generated** from `agentcore --help` ("Do not edit directly"). Regenerate it
  after changing command names, flags, or descriptions. Section grouping lives in
  `DEFAULT_GROUPS` in `scripts/generate-command-reference.mjs`.
- **Build quirks** (`scripts/build.ts`): `@aws-cdk/toolkit-lib` is external in the npm bundle but
  inlined in compiled binaries (so the bootstrap template is embedded explicitly); identifiers are
  never minified because stack traces and telemetry error names depend on them. `dist/index.js` is
  a loader that enables Node's compile cache then imports `dist/main.js`.
- Line endings are LF (`.gitattributes`). The Husky pre-commit hook runs lint-staged
  (oxlint --fix + Prettier) on staged files.
- Root-level `.*.bun-build` files are compile leftovers (gitignored); ignore them.

## Conventions

- Prettier: double quotes, semicolons, trailing commas, width 100, 2-space indent.
- tsconfig is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (use `import type`
  for type-only imports). Relative imports often include the extension (`./harness/index.tsx`),
  and most files are `.tsx` even without JSX; follow the neighbouring files.
- Handler directories: `index.tsx` (`create<Name>Handler(core, io)` factory, re-exports the
  screen), `screen.tsx`, `types.tsx` (the Core interface the handler consumes; implemented in
  `src/core/`). Leaf handlers use `createHandler({ name, description, flags: [flag(...)], handle })`
  with zod-validated flags. Emit JSON via `ctx.require(JsonRendererKey).renderJson(...)` and write
  through the injected `AppIO`; never touch `process.stdout` directly in handlers.
- Build `CoreOptions` from context with `coreOptsFromCtx(ctx)` (`src/handlers/utils.tsx`).
- Errors: throw `AgentCoreCLIError` subclasses (`src/errors/`), which carry `source`
  (user/service/internal), `exitCode`, and `meta` for logging and telemetry.
  `AgentCoreCLIError.fromError` maps Commander errors to exit code 2 and SDK 4xx to user errors.
- Runtime files: logs in `~/.agentcore/logs/`, global CLI settings in `~/.agentcore/config.json`.
- Commits and PR titles use conventional commits with scope: `feat(invoke): ...`,
  `fix(tui): ...`, `refactor(gateway): ...`, `test(cli): ...`. PRs must link an issue and follow
  `.github/pull_request_template.md`.

## Testing patterns

- Tests live beside code as `*.test.ts(x)`; target is 90% line coverage.
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
  `createSilentLogger`, `TestGlobalConfigAccessor`, fixture helpers).
