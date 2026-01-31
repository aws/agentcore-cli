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

## Testing UI changes E2E

At the top level `web-harness/` directory a shim over Ink, as well as a mock of Node API and CLI business logic is
defined. By running the vite local host dev server, a web app based on the same visual source of truth as the terminal
is hosted. Always launch a web-harness web server and use the browser MCP tool to test changes E2E. Create mocks as
appropriate to test the relevant surface area.

If start up issues are encountered, read the console error to troubleshoot bugs and update the harness.

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
