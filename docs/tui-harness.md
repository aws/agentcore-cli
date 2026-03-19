# TUI Harness

The TUI harness provides MCP tools for programmatically driving the AgentCore CLI terminal UI. The MCP server lives at
`src/mcp-harness/` and the underlying library is at `src/test-utils/tui-harness/`.

## Running in HTTP Mode (Recommended)

The TUI harness supports two transport modes: **HTTP** and **stdio**. HTTP mode is the recommended way to run the server
when using it from Claude Code.

**Why HTTP mode?** In stdio mode, the MCP server runs inside Claude Code's sandbox, which blocks `posix_spawnp` -- the
system call that `node-pty` needs to spawn PTY processes. This means `tui_launch` will fail when the server is connected
via stdio. HTTP mode runs the server as an independent process outside the sandbox, so PTY spawning works normally.

### Quick Start

```bash
# Build the harness
npm run build:harness

# Start the MCP server in HTTP mode (runs on port 24100)
node dist/mcp-harness/index.mjs --http

# Or use the convenience script
./scripts/start-tui-harness.sh
```

### Configure Claude Code

Add the HTTP server as an MCP source in Claude Code:

```bash
# Add via CLI
claude mcp add --transport http -s project tui-harness http://127.0.0.1:24100/mcp
```

Or add directly to `.mcp.json`:

```json
{
  "mcpServers": {
    "tui-harness": {
      "type": "http",
      "url": "http://127.0.0.1:24100/mcp"
    }
  }
}
```

### Custom Port

The default port is `24100`. Override it with the `--port` flag or the `MCP_HARNESS_PORT` environment variable:

```bash
node dist/mcp-harness/index.mjs --http --port 3456

# Or via environment variable
MCP_HARNESS_PORT=3456 node dist/mcp-harness/index.mjs --http
```

### Verifying the Connection

After starting the server and configuring Claude Code, verify the connection:

```bash
claude mcp list
```

The output should show `tui-harness` with a connected status.

### Note on Stdio Mode

Stdio transport is still supported for backward compatibility. However, PTY process spawning will not work inside Claude
Code's sandbox -- `tui_launch` calls will fail with a spawn error. Stdio mode is useful for automated test pipelines
where the test runner directly communicates with the server and no sandbox restrictions apply.

## Getting Started

1. Run `npm run build:harness` to compile both the CLI and the MCP harness binary. The harness is dev-only tooling and
   is not included in the standard `npm run build`.
2. Call `tui_launch` to start a TUI session. It returns a `sessionId` that all subsequent tool calls require.
   - `tui_launch({})` with no arguments defaults to `command="node"`, `args=["dist/cli/index.mjs"]` (the AgentCore CLI).
   - The `cwd` parameter determines what the TUI sees: if `cwd` is a directory with an `agentcore.config.json`, the TUI
     opens to the HelpScreen (command list). If `cwd` has no project, it opens to the HomeScreen ("No AgentCore project
     found").
3. Common workflow: **launch** -> **navigate** -> **verify** -> **close**.

## MCP Tools

- `tui_launch` -- Start a TUI session (defaults to AgentCore CLI if no command specified). Returns a `sessionId` used by
  all other tools.
- `tui_send_keys` -- Send text or special keys (enter, tab, escape, arrow keys, ctrl+c, etc.).
- `tui_read_screen` -- Read current screen content. Options: `numbered: true` adds line numbers (useful for referencing
  specific UI elements), `includeScrollback: true` includes lines scrolled above the viewport.
- `tui_wait_for` -- Wait for text or a regex pattern to appear on screen. Returns `{found: false}` on timeout, NOT an
  error.
- `tui_screenshot` -- Capture a screenshot. Supports `format: 'text'` (bordered text with line numbers, the default) or
  `format: 'svg'` (visual SVG render). Optional `savePath` to write to disk, `theme` to select color scheme.
- `tui_close` -- Close a session and terminate the underlying process.
- `tui_list_sessions` -- List all active sessions.

## Screenshot Format

`tui_screenshot` returns a bordered capture with line numbers:

```
┌─ TUI Screenshot (120x40) ────────────────────────────────────────┐
  1 |
  2 |   >_ AgentCore                         v0.3.0-preview.5.0
  3 |
  4 |   >
  5 |
  6 |   No AgentCore project found in this directory.
  7 |
  8 |   You can:
  9 |     create - Create a new AgentCore project here
 10 |     or cd into an existing project directory
 11 |
 12 |   Press Enter to create a new project
 ...
└──────────────────────────────────────────────────────────────────┘
```

The response also includes metadata: cursor position, terminal dimensions, buffer type, and timestamp. Use line numbers
when referencing specific UI elements in your reasoning.

## SVG Screenshots

`tui_screenshot` can render the terminal buffer as a visual SVG image. SVGs are self-contained (all fonts and styles are
inlined) with no external dependencies, making them safe to embed anywhere.

### MCP Tool Usage

```
tui_screenshot({ sessionId: "abc", format: "svg", savePath: "./screenshot.svg" })
tui_screenshot({ sessionId: "abc", format: "svg", theme: "light" })
```

### Library Usage

```typescript
const svg = session.screenshot();
fs.writeFileSync('docs/screenshots/home-screen.svg', svg);
```

### Themes

- **dark** (default) -- VS Code Dark+ colors. Best for terminal-style presentation.
- **light** -- GitHub-friendly palette. Best for docs and PR descriptions where the page background is white.

### Embedding in Markdown

SVG files render natively in GitHub markdown:

```markdown
![Home Screen](docs/screenshots/home-screen.svg)
```

## Screen Identification Markers

Use these stable text patterns with `tui_wait_for` to identify which screen is currently displayed.

| Screen                          | Stable Text Marker                                                         | Notes                                                       |
| ------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------- |
| HomeScreen (no project)         | `No AgentCore project found`                                               | Only shown when no project exists                           |
| HelpScreen (command list)       | `Commands` or `Type to filter`                                             | Main command list with project                              |
| CreateScreen (name input)       | `Project name`                                                             | Text input for project name                                 |
| CreateScreen (add agent prompt) | `add an agent`                                                             | "Would you like to add an agent now?" Yes/No                |
| AddAgent (name)                 | `Agent name`                                                               | Text input with default "MyAgent"                           |
| AddAgent (type)                 | `agent type`                                                               | "Create new agent" vs "Bring my own code"                   |
| AddAgent (language)             | `Python`                                                                   | Language selection (TypeScript is "coming soon" / disabled) |
| AddAgent (build type)           | `Direct Code Deploy`                                                       | "Direct Code Deploy" vs "Container"                         |
| AddAgent (framework)            | `Strands Agents SDK`                                                       | Strands, LangChain, Google ADK, OpenAI Agents               |
| AddAgent (model provider)       | `Amazon Bedrock`                                                           | Bedrock, Anthropic, OpenAI, Google Gemini                   |
| AddAgent (memory)               | `No memory`                                                                | None, Short-term, Long-term (only for Strands)              |
| AddAgent (confirm)              | `Review Configuration`                                                     | Summary of all selections before creating                   |
| CreateScreen (running)          | `[done]`                                                                   | Progress steps. Use `tui_wait_for("created successfully")`  |
| CreateScreen (complete)         | `created successfully`                                                     | Stable end state                                            |
| AddScreen (resource types)      | `Add Resource`                                                             | Agent, Memory, Identity, Gateway, Gateway Target            |
| DeployScreen (confirm)          | `Deploy` + `confirm`                                                       | Confirmation prompt                                         |
| DeployScreen (loading)          | Spinner (unstable)                                                         | Use `tui_wait_for` for specific completion text             |
| Error state                     | `Error` or `failed`                                                        | Error messages                                              |
| Selected list item              | `>` cursor                                                                 | Cursor indicator in any selection list                      |
| Text input active               | `>` prompt                                                                 | Input cursor in any text input field                        |
| Commands list items             | `add`, `dev`, `deploy`, `create`, `invoke`, `remove`, `status`, `validate` | Individual command names visible in HelpScreen list         |
| Exit prompt                     | `Press Esc again to exit`                                                  | Shown after first Escape on HelpScreen with no search query |

## Example: Create Project with Agent (Full Wizard)

The create wizard embeds the full AddAgent flow. Here is every step captured from a real TUI session:

```
 1. tui_launch({cwd: "/path/to/empty/dir"})
    -> Returns sessionId. Screen shows HomeScreen.

 2. tui_wait_for({sessionId, pattern: "No AgentCore project found", timeoutMs: 10000})
    -> Confirms HomeScreen loaded.

 3. tui_send_keys({sessionId, specialKey: "enter"})
    -> Navigates to CreateScreen.

 4. tui_wait_for({sessionId, pattern: "Project name"})
    -> CreateScreen: name input.

 5. tui_send_keys({sessionId, keys: "my-agent"})
    -> Types the project name.

 6. tui_send_keys({sessionId, specialKey: "enter"})
    -> Submits name. Moves to "add an agent?" prompt.

 7. tui_wait_for({sessionId, pattern: "add an agent"})
    -> "Would you like to add an agent now?" with Yes/No options.

 8. tui_send_keys({sessionId, specialKey: "enter"})
    -> Selects "Yes". Moves to Agent name input.

 9. tui_wait_for({sessionId, pattern: "Agent name"})
    -> Agent name input (default: "MyAgent").

10. tui_send_keys({sessionId, specialKey: "enter"})
    -> Accepts default name. Moves to agent type selection.

11. tui_wait_for({sessionId, pattern: "agent type"})
    -> "Create new agent" vs "Bring my own code".

12. tui_send_keys({sessionId, specialKey: "enter"})
    -> Selects "Create new agent". Moves to language.

13. tui_wait_for({sessionId, pattern: "Python"})
    -> Language selection. Note: "TypeScript (coming soon)" is disabled.

14. tui_send_keys({sessionId, specialKey: "enter"})
    -> Selects Python. Moves to build type.

15. tui_wait_for({sessionId, pattern: "Direct Code Deploy"})
    -> "Direct Code Deploy" vs "Container".

16. tui_send_keys({sessionId, specialKey: "enter"})
    -> Selects Direct Code Deploy. Moves to framework.

17. tui_wait_for({sessionId, pattern: "Strands Agents SDK"})
    -> Framework: Strands, LangChain, Google ADK, OpenAI Agents.

18. tui_send_keys({sessionId, specialKey: "enter"})
    -> Selects Strands. Moves to model provider.

19. tui_wait_for({sessionId, pattern: "Amazon Bedrock"})
    -> Model: Bedrock, Anthropic, OpenAI, Google Gemini.

20. tui_send_keys({sessionId, specialKey: "enter"})
    -> Selects Bedrock. Skips API key (Bedrock uses IAM). Moves to memory.

21. tui_wait_for({sessionId, pattern: "No memory"})
    -> Memory: None, Short-term, Long-term (Strands-only step).

22. tui_send_keys({sessionId, specialKey: "enter"})
    -> Selects None. Moves to review.

23. tui_wait_for({sessionId, pattern: "Review Configuration"})
    -> Summary panel showing all selections.

24. tui_send_keys({sessionId, specialKey: "enter"})
    -> Confirms. Project creation begins (~25 seconds).

25. tui_wait_for({sessionId, pattern: "created successfully", timeoutMs: 60000})
    -> Wait for completion. Use a long timeout (creation runs uv sync).

26. tui_screenshot({sessionId})
    -> Capture success screen showing created file structure.

27. tui_close({sessionId})
    -> Clean shutdown. Returns exitCode: 0.
```

Notes:

- Step 20: If you select a non-Bedrock provider (Anthropic, OpenAI, Gemini), an API key input step appears between model
  selection and memory.
- Step 21: The memory step only appears when Strands SDK is selected as the framework.
- Step 25: Project creation takes ~25 seconds due to `uv sync`. The `timeoutMs` cap for `tui_wait_for` is 30000, so use
  30000 or call it in a loop.

## Example: Navigate to Add Resource

```
1. tui_launch({cwd: "/path/to/existing/project"})
   -> HelpScreen with command list.

2. tui_wait_for({sessionId, pattern: "Commands"})
   -> Confirms HelpScreen loaded.

3. tui_send_keys({sessionId, keys: "add"})
   -> Filters command list to "add".

4. tui_send_keys({sessionId, specialKey: "enter"})
   -> Navigates to AddScreen.

5. tui_wait_for({sessionId, pattern: "Add Resource"})
   -> Shows: Agent, Memory, Identity, Gateway, Gateway Target.
```

## Known Limitations

1. **Disabled items are invisible**: In selection lists, disabled items are shown only with dimmed color (ANSI). The
   harness strips ANSI codes and returns plain text, so disabled items look identical to enabled ones. If pressing Enter
   on a list item does not navigate to a new screen, the item may be disabled -- try a different item.
2. **Spinner screens do not settle**: Screens with spinners (deploy progress, create running) continuously change text
   content. Do not wait for the screen to "settle" -- use `tui_wait_for` with the specific text that indicates
   completion (e.g., `"created successfully"`, `"Deploy complete"`).
3. **Max 10 concurrent sessions**: The harness allows up to 10 simultaneous TUI sessions. Close sessions when done.

## Navigation Patterns

- **Navigate to a command**: From HelpScreen, type the command name to filter, then press Enter. Or use arrow keys to
  reach it, then Enter.
- **Fill text input**: Type characters with `tui_send_keys({keys: "..."})`, then press Enter to submit.
- **Select from list**: Arrow down to the target item, then press Enter.
- **Go back**: Press Escape.
- **Exit app**: Press Escape until at HelpScreen, then Escape twice (or Ctrl+C from anywhere).
- **Slow-rendering screens**: If a screen takes time to fully render, pass `waitMs: 1000` (or higher) to `tui_send_keys`
  to give the screen more time to settle before reading it.

## Error Recovery

When `tui_wait_for` returns `{found: false}`:

1. Call `tui_screenshot` to see what's actually on screen.
2. Check if the screen has an error message (look for "Error" or "failed").
3. If the screen is still loading (spinner), increase `timeoutMs` and retry.
4. If you're on the wrong screen, use `tui_send_keys({specialKey: "escape"})` to go back and try a different navigation
   path.

When `tui_send_keys` doesn't change the screen:

1. Call `tui_read_screen` to check the current state.
2. The selected item may be disabled (see Known Limitations).
3. Try pressing Escape and navigating to a different item.

When `tui_launch` returns an error:

1. Ensure `npm run build:harness` was run recently -- both the CLI binary and the MCP harness must be up to date.
2. Check that `cwd` points to a valid directory.
3. The error response includes the screen content at time of failure -- use it to diagnose.
