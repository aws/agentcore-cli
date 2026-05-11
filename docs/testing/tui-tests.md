# TUI Integration Tests

TUI integration tests run the full CLI binary inside a pseudo-terminal (PTY) and verify screen output, keyboard
navigation, and end-to-end wizard flows.

> **Note:** TUI tests require `node-pty` (native addon). If node-pty is not installed, TUI tests are automatically
> skipped.

## Running

```bash
npm run test:tui              # Builds first, then runs TUI tests
npx vitest run --project tui  # Skip build (use when build is fresh)
```

## Test Organization

```
integ-tests/tui/
├── setup.ts              # Global setup: availability check, afterAll cleanup
├── helpers.ts            # createMinimalProjectDir, common test setup
├── harness.test.ts       # TuiSession self-tests (spawn, send, read)
├── navigation.test.ts    # Screen navigation flows
├── create-flow.test.ts   # Create wizard end-to-end
├── add-flow.test.ts      # Add resource flows
└── deploy-screen.test.ts # Deploy screen rendering
```

## Writing a TUI Flow Test

Below is a complete example showing the typical pattern for a TUI flow test:

```typescript
import { isAvailable } from '../../src/test-utils/tui-harness/index.js';
import { TuiSession } from '../../src/test-utils/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

describe.skipIf(!isAvailable)('my TUI flow', () => {
  let session: TuiSession;

  afterEach(async () => {
    await session?.close();
  });

  it('navigates to the add screen', async () => {
    // createMinimalProjectDir makes a temp dir with agentcore config (~10ms)
    const { dir, cleanup } = await createMinimalProjectDir({ hasAgents: true });

    try {
      // Launch the CLI TUI in the project directory
      session = await TuiSession.launch({
        command: 'node',
        args: ['../../dist/cli/index.mjs'],
        cwd: dir,
      });

      // Wait for the HelpScreen to render
      await session.waitFor('Commands');

      // Navigate: type 'add' to filter, then Enter
      await session.sendKeys('add');
      await session.sendSpecialKey('enter');

      // Verify we reached the AddScreen
      await session.waitFor('agent');
      const screen = session.readScreen();
      expect(screen.lines.join('\n')).toContain('agent');
    } finally {
      await cleanup();
    }
  });
});
```

Key points:

- **`describe.skipIf(!isAvailable)`** -- gracefully skips when `node-pty` is missing.
- **`afterEach` with `session?.close()`** -- always clean up PTY processes.
- **`createMinimalProjectDir`** -- fast temp directory setup (no `npm install`).
- **`try/finally` with `cleanup()`** -- always remove temp directories.

## TuiSession API Quick Reference

| Method                                 | Returns                | Description                                                                                  |
| -------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `TuiSession.launch(options)`           | `Promise<TuiSession>`  | Spawn CLI in PTY. Throws `LaunchError` if process exits during startup.                      |
| `session.sendKeys(text, waitMs?)`      | `Promise<ScreenState>` | Type text, wait for screen to settle, return screen.                                         |
| `session.sendSpecialKey(key, waitMs?)` | `Promise<ScreenState>` | Send special key (enter, tab, escape, etc.), wait, return screen.                            |
| `session.readScreen(options?)`         | `ScreenState`          | Read current screen (synchronous). Options: `{ includeScrollback?, numbered? }`.             |
| `session.waitFor(pattern, timeoutMs?)` | `Promise<ScreenState>` | Wait for text/regex on screen. **Throws `WaitForTimeoutError` on timeout** (default 5000ms). |
| `session.close(signal?)`               | `Promise<CloseResult>` | Close session. Returns exit code, signal, final screen.                                      |
| `session.info`                         | `SessionInfo`          | Session metadata: sessionId, pid, dimensions, alive status.                                  |
| `session.alive`                        | `boolean`              | Whether the PTY process is still running.                                                    |

## ScreenState Shape

```typescript
interface ScreenState {
  lines: string[]; // Each line of terminal text
  cursor: { x: number; y: number }; // Cursor position
  dimensions: { cols: number; rows: number }; // Terminal size
  bufferType: 'normal' | 'alternate'; // Active buffer
}
```

## Special Keys

The following special keys can be passed to `session.sendSpecialKey()`:

`enter`, `tab`, `escape`, `backspace`, `delete`, `space`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`,
`pagedown`, `ctrl+c`, `ctrl+d`, `ctrl+q`, `ctrl+g`, `ctrl+a`, `ctrl+e`, `ctrl+w`, `ctrl+u`, `ctrl+k`, `f1` through
`f12`.

## Key Concepts

### waitFor vs Settling

- **Settling** (automatic after `sendKeys`/`sendSpecialKey`): Waits for screen text to stop changing. Good for most
  screens. Fails on spinner/animation screens because text changes continuously.
- **waitFor**: Polls for a specific text pattern. Use for: (a) async operations with spinners, (b) confirming you
  reached the right screen, (c) any case where you need a specific pattern before proceeding.
- **Rule of thumb**: Use `waitFor` when waiting for an async result (project creation, deployment). Use
  `sendKeys`/`sendSpecialKey` (which auto-settle) for navigating between static screens.

### waitFor Throws on Timeout

`waitFor()` throws `WaitForTimeoutError` when the pattern is not found within the timeout. The error includes:

- The pattern that was not found
- How long it waited
- The full screen content at timeout

This means tests fail fast with useful diagnostics. You do not need to check a `found` boolean.

### WaitForTimeoutError Output

When `waitFor()` times out, the thrown `WaitForTimeoutError` produces a message like this:

```
WaitForTimeoutError: waitFor("created successfully") timed out after 5000ms.
Screen content:
AgentCore Create

Creating project...
⠋ Installing dependencies
```

The error message includes the full non-blank screen content at the time of the timeout. This makes it straightforward
to diagnose why the expected pattern was not found -- was the screen still loading? Did the test land on the wrong
screen? Was there a typo in the pattern?

If you need to inspect the error properties programmatically (for example, to log additional context or make assertions
on the screen state), you can catch the error directly:

```typescript
import { WaitForTimeoutError } from '../../src/test-utils/tui-harness/index.js';

try {
  await session.waitFor('expected text', 3000);
} catch (err) {
  if (err instanceof WaitForTimeoutError) {
    console.log(err.pattern); // 'expected text'
    console.log(err.elapsed); // ~3000
    console.log(err.screen); // ScreenState with full content
  }
  throw err;
}
```

### createMinimalProjectDir

Creates a temp directory that AgentCore recognizes as a project in ~10ms (no npm install). Use it when your test needs a
project context:

```typescript
const { dir, cleanup } = await createMinimalProjectDir({
  projectName: 'mytest', // optional, defaults to 'testproject'
  hasAgents: true, // optional, adds a sample agent
});
```

Always call `cleanup()` when done (in `finally` or `afterEach`).

### LaunchError

`TuiSession.launch()` throws `LaunchError` when the spawned process exits before the screen settles. Common causes
include a missing binary, a crash on startup, or an invalid working directory.

The error includes the following diagnostic properties:

- `command` -- the executable that was launched
- `args` -- the arguments passed to the command
- `cwd` -- the working directory used for the spawned process
- `exitCode` -- the process exit code (or `null` if terminated by signal)
- `screen` -- the `ScreenState` captured at the time of exit

You can assert that a launch fails with `LaunchError`:

```typescript
import { LaunchError, TuiSession } from '../../src/test-utils/tui-harness/index.js';

it('throws LaunchError for missing binary', async () => {
  await expect(TuiSession.launch({ command: 'nonexistent-binary' })).rejects.toThrow(LaunchError);
});

// Or if you need to inspect the error:
it('provides diagnostics in LaunchError', async () => {
  try {
    await TuiSession.launch({ command: 'node', args: ['missing-file.js'] });
  } catch (err) {
    if (err instanceof LaunchError) {
      console.log(err.command); // 'node'
      console.log(err.exitCode); // 1
      console.log(err.screen); // ScreenState at time of crash
    }
    throw err;
  }
});
```
