# CLI Module

The `cli` module defines the terminal interface for Amazon AgentCore. Some functionalities are specifically tied to
resource management, which is modeled in schemas and then implemented in CDK.

Other functionalities are generic utilities like project template creation of application code and local development
tooling are self-contained within the CLI.

## UX Philosophy

The TUI should feel streamlined, cohesive, and smooth. The important information should be highlighted and visual
clutter should be avoided. Do not add descriptions which take up screen real-estate without offering critical
information. Transitions should never be jumpy. When implementing a feature such as a nested decision tree, model that
within a single screen/flow. Do not unnecessarily introduce a new screen for a branched input.

Controls, inputs, colors, and the like should feel consistent throughout. Navigation is heavily modeled around keyboard
and arrow key input.

UIs which model processes which require work and time should communicate that through minimal animations (such as a
gradient over text). In a higher level action that requires a series of steps, enforce a satisfying minimum amount of
time per step (~.15ms) to avoid jumpiness.

When units of work have the possibility of generating an error which would help the user, surface the meaningful segment
of the error directly to the user. Over-generalized try-catch blocks can lead to the user entering an un-recoverable
state.

## Invoking Commands Directly From the Command Line

Although the primary design of this CLI is an immersive TUI experience, all commands can be invoked directly from the
command line. The `<>Screen` Ink components should be re-used when accommodating direct invocation. Sensible options and
defaults need to be surfaced to encapsulate the user-choice in the full TUI.

## Top Level Lifecycle

`init`: Initialize `agentcore/` project directory enabling all other CLI commands `add`: Model resources and generate
application code `plan`: Synthesize underlying CDK project and visualize modeled resources `deploy`: Use configuration
from aws-targets and deploy project to AWS

## Programmatic CDK interactions

`toolkit-lib` is a tool to programmatically run idiomatic CDK commands.

This CLI uses the CDK `toolkit-lib` package to programmatically run commands like `cdk synth` and `cdk deploy` on a CDK
project. During `agentcore init` `toolkit-lib` is the mechanism to run `cdk bootstrap` for the environment.

`toolkit-lib` implementations are entirely contained in the CLI and not surfaced to users. Since the user has the full
CDK app at hand, they have full control to make updates.

While using `toolkit-lib` it is important to keep track of and dispose of cloud assembly resources. Failure to dispose
of cloud assembly (even in unexpected outcomes like quitting the app) can result in stale lock files that leave the user
in a challenging state.

## UI

The TUI is defined using ink, a library that converts React definitions to terminal renderings.

Ink supports a subset of React features and components should be directly imported from ink.

The `dev` command uses a strategy pattern with a `DevServer` base class and two implementations:

- **CodeZipDevServer**: Runs uvicorn locally with Python venv hot-reload
- **ContainerDevServer**: Builds and runs a Docker container with volume mount for hot-reload. Detects
  Docker/Podman/Finch via the `detectContainerRuntime()` utility.

The server selection is based on `agent.build` (`CodeZip` or `Container`).

## Primitives Architecture

All resource types are modeled as **primitives** in `primitives/`. Each primitive is a self-contained class that owns
the full add/remove lifecycle for one resource type. CLI commands and TUI flows consume primitives polymorphically.

### Directory Structure

```
primitives/
├── BasePrimitive.ts           # Abstract base class with shared helpers
├── AgentPrimitive.tsx         # Agent add/remove (template + BYO paths)
├── MemoryPrimitive.tsx        # Memory add/remove
├── CredentialPrimitive.tsx    # Credential/identity add/remove + .env management
├── GatewayPrimitive.ts        # MCP gateway add/remove (hidden, coming soon)
├── GatewayTargetPrimitive.ts  # MCP tool add/remove + code gen (hidden, coming soon)
├── registry.ts                # Singleton instances + ALL_PRIMITIVES array
├── credential-utils.ts        # Shared credential env var name computation
├── constants.ts               # SOURCE_CODE_NOTE and other shared constants
├── types.ts                   # RemovableResource, AddScreenComponent, etc.
└── index.ts                   # Barrel exports
```

### BasePrimitive Contract

Every primitive extends `BasePrimitive<TAddOptions, TRemovable>` and implements:

- `kind` — resource identifier (`'agent'`, `'memory'`, `'identity'`, `'gateway'`, `'mcp-tool'`)
- `label` — human-readable name (`'Agent'`, `'Memory'`, `'Identity'`)
- `add(options)` — create a resource, returns `Result<T>`
- `remove(name)` — remove a resource, returns `Result`
- `previewRemove(name)` — preview what removal will do
- `getRemovable()` — list resources available for removal
- `registerCommands(addCmd, removeCmd)` — register CLI subcommands

BasePrimitive provides shared helpers:

- `configIO` — shared ConfigIO instance for agentcore.json
- `readProjectSpec()` / `writeProjectSpec()` — read/write agentcore.json
- `checkDuplicate()` — validate name uniqueness
- `article` — indefinite article for grammar (`'a'` or `'an'`)
- `registerRemoveSubcommand(removeCmd)` — standard remove CLI handler (CLI mode + TUI fallback)

### Adding a New Primitive

1. Create `src/cli/primitives/NewPrimitive.ts` extending `BasePrimitive`
2. Implement all abstract methods (`add`, `remove`, `previewRemove`, `getRemovable`, `registerCommands`, `addScreen`)
3. Add a singleton to `registry.ts` and include it in `ALL_PRIMITIVES`
4. Export from `index.ts`
5. The primitive auto-registers its CLI subcommands via the loop in `cli.ts`

### Key Design Rules

- **Absorb, don't wrap.** Each primitive owns its logic directly. Do not create facade files that delegate to
  primitives.
- **No backward-compatibility shims.** This is a CLI, not a library. If the CLI functions the same, delete old files.
- **Use the discriminated `Result<T, E>` union** from `src/lib/result.ts` throughout. See typed error classes in
  `src/lib/errors/types.ts`.
- **Dynamic imports for ink/React only.** TUI components (ink, react, screen components) must be dynamically imported
  inside Commander action handlers to prevent esbuild async module propagation issues. All other imports go at the top
  of the file. See the esbuild section below.

### esbuild Async Module Constraint

ink uses top-level `await` (via yoga-wasm). Any module that imports ink at the top level becomes async in esbuild's ESM
bundle. If the async propagation fails (e.g., through circular dependencies), esbuild generates `await` inside non-async
functions, causing a runtime `SyntaxError`. To prevent this:

- **Never import ink, react, or TUI screen components at the top of primitive files.**
- Use `await Promise.all([import('ink'), import('react'), import('...')])` inside Commander `.action()` handlers.
- This is the one exception to the "no inline imports" rule in the root AGENTS.md.
- `registry.ts` imports all primitive classes — if any primitive pulls in ink at the top level, all modules that import
  from registry become async, causing cascading failures.

### Registry and Wiring

`registry.ts` creates singleton instances of all primitives:

```typescript
export const agentPrimitive = new AgentPrimitive();
export const memoryPrimitive = new MemoryPrimitive();
// ...
export const ALL_PRIMITIVES = [agentPrimitive, memoryPrimitive, ...];
```

`cli.ts` wires them into Commander:

```typescript
for (const primitive of ALL_PRIMITIVES) {
  primitive.registerCommands(addCmd, removeCmd);
}
```

### TUI Hooks

TUI remove hooks in `tui/hooks/useRemove.ts` use generic helpers:

- `useRemovableResources<T>(loader)` — generic hook for loading removable resources from any primitive
- `useRemoveResource<TIdentifier>(removeFn, resourceType, getName)` — generic hook for removing any resource with
  logging

Each resource-specific hook (e.g., `useRemovableAgents`, `useRemoveMemory`) is a thin wrapper around the generic.

## Commands Directory Structure

Commands live in `commands/`. Each command has its own directory with an `index.ts` barrel file and a file called
`commands/<command>.ts` which is a thin commander definition.

The `commands/<command>/action.ts` file contains more significant imperative logic if its needed.

There should not be significant logic defined in the `commands/` directory.

## Placeholders and Initial Values

Bias towards initial values over placeholders. Unless a field is optional, the initial value allows the user to just
accept the value and keep moving. For something like an AWS accountID, an initial value would be inappropriate.

## Cross-Platform Development

The CLI is designed to work seamlessly on both Windows and Unix-like systems (Linux, macOS). All code should be
cross-platform compatible.

### Platform Abstraction

Use utilities from `lib/utils/platform.ts` to handle platform differences:

```typescript
import { getVenvExecutable, isWindows } from '../../lib/utils/platform';

// Get correct path to Python venv executables
const uvicorn = getVenvExecutable('.venv', 'uvicorn');
// Unix: .venv/bin/uvicorn
// Windows: .venv\Scripts\uvicorn.exe
```

### Cross-Platform Guidelines

1. **Never hardcode Unix-specific paths or commands**
   - ❌ `.venv/bin/python`, `rm -rf`, `rsync`
   - ✅ Use `getVenvExecutable()`, Node.js `fs` APIs, or cross-platform npm packages

2. **Use platform utilities instead of direct checks**
   - ❌ `process.platform === 'win32'`
   - ✅ `import { isWindows } from '../../lib/utils/platform'`

3. **Test on both platforms**
   - Windows has different path separators, executable extensions, and shell commands
   - Python venv structure differs (bin/ vs Scripts/)
   - PTY/terminal features may not be available on Windows

4. **Handle platform-specific features gracefully**
   - Example: PTY via `script` command is Unix-only, fall back to one-shot execution on Windows
   - Document platform limitations in code comments

5. **Use Node.js built-ins for file operations**
   - Prefer `fs`, `path`, `child_process` over shell commands
   - These are cross-platform by design

See `src/lib/AGENTS.md` for detailed documentation on platform utilities and examples.
