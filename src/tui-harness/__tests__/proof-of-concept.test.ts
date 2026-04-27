/**
 * Proof-of-concept tests for @xterm/headless and node-pty integration.
 *
 * CRITICAL GATE: All subsequent TUI harness work depends on these imports
 * and patterns working correctly under agentcore-cli's TypeScript config
 * (module: "Preserve", moduleResolution: "bundler", verbatimModuleSyntax: true).
 *
 * --- Import patterns that work ---
 *
 * @xterm/headless (CJS bundle, no ESM exports map):
 *   import xtermHeadless from '@xterm/headless';
 *   const { Terminal } = xtermHeadless;
 *
 *   Why: The package's "main" is a CJS bundle. With verbatimModuleSyntax + bundler
 *   resolution, a default import gets the module.exports object. Named imports
 *   like `import { Terminal } from '@xterm/headless'` fail because the CJS bundle
 *   does not have a static "Terminal" export visible to the TypeScript compiler.
 *
 * node-pty (CJS native addon):
 *   import * as pty from 'node-pty';
 *
 *   Why: node-pty uses module.exports with named properties (spawn, fork, etc.).
 *   A namespace import (`import * as`) maps cleanly to the CJS exports object.
 *
 * --- xterm.write() is ASYNC ---
 *
 * terminal.write(data) does not synchronously update the buffer. You must use
 * the callback form or wrap in a promise:
 *   await new Promise<void>(resolve => terminal.write('hello', resolve));
 *
 * Only then is it safe to read from terminal.buffer.active.
 *
 * --- allowProposedApi: true is REQUIRED ---
 *
 * Accessing terminal.buffer and terminal.parser requires allowProposedApi: true.
 * Without it, xterm throws "You must set the allowProposedApi option to true
 * to use proposed API". Always set this when creating Terminal instances.
 *
 * --- node-pty spawn requires real executables ---
 *
 * node-pty uses posix_spawnp under the hood. Shell built-ins like `echo` are
 * not standalone executables and will cause "posix_spawnp failed". Use full
 * paths like `/bin/echo` instead.
 */
import { createMinimalProjectDir } from '../helpers.js';
import xtermHeadless from '@xterm/headless';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as pty from 'node-pty';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const { Terminal } = xtermHeadless;

let ptyAvailable = true;
try {
  const p = pty.spawn('/bin/echo', ['test'], { cols: 80, rows: 24 });
  p.kill();
} catch {
  ptyAvailable = false;
}

// ---------------------------------------------------------------------------
// Test A: xterm standalone
// ---------------------------------------------------------------------------
describe('xterm standalone', () => {
  let terminal: InstanceType<typeof Terminal>;

  afterEach(() => {
    terminal?.dispose();
  });

  it('creates a terminal and reads back written text', async () => {
    // allowProposedApi is required to access terminal.buffer
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

    // terminal.write is async -- use the callback form wrapped in a promise
    await new Promise<void>(resolve => terminal.write('hello', resolve));

    const line = terminal.buffer.active.getLine(0)?.translateToString(true);
    expect(line).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// Test B: PTY + xterm wiring
// ---------------------------------------------------------------------------
describe.skipIf(!ptyAvailable)('PTY + xterm wiring', () => {
  let terminal: InstanceType<typeof Terminal>;
  let ptyProcess: ReturnType<typeof pty.spawn> | undefined;

  afterEach(() => {
    ptyProcess?.kill();
    ptyProcess = undefined;
    terminal?.dispose();
  });

  it('pipes PTY output through xterm and reads the buffer', async () => {
    terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

    // Use /bin/echo (absolute path) because node-pty uses posix_spawnp which
    // cannot resolve shell built-ins like bare `echo`.
    ptyProcess = pty.spawn('/bin/echo', ['hello'], {
      cols: 80,
      rows: 24,
    });

    // Wire PTY output into the terminal, accumulating a promise that
    // resolves once the PTY process exits.
    const exitPromise = new Promise<void>(resolve => {
      ptyProcess!.onData((data: string) => {
        terminal.write(data);
      });
      ptyProcess!.onExit(() => resolve());
    });

    await exitPromise;

    // Give xterm a moment to finish parsing any remaining buffered writes.
    await new Promise<void>(resolve => terminal.write('', resolve));

    const line = terminal.buffer.active.getLine(0)?.translateToString(true);
    expect(line).toContain('hello');
  });
});

// ---------------------------------------------------------------------------
// Test C: DSR/CPR handler
// ---------------------------------------------------------------------------
describe.skipIf(!ptyAvailable)('DSR/CPR handler', () => {
  let terminal: InstanceType<typeof Terminal>;
  let ptyProcess: ReturnType<typeof pty.spawn> | undefined;

  afterEach(() => {
    ptyProcess?.kill();
    ptyProcess = undefined;
    terminal?.dispose();
  });

  it('responds to DSR (\\x1b[6n]) with a cursor position report (standalone)', async () => {
    terminal = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    });

    // Capture the response our handler would send back to the PTY.
    let dsrResponse = '';

    terminal.parser.registerCsiHandler({ final: 'n' }, params => {
      if (params[0] === 6) {
        // CPR: report cursor position as \x1b[{row};{col}R (1-indexed)
        const buf = terminal.buffer.active;
        dsrResponse = `\x1b[${buf.cursorY + 1};${buf.cursorX + 1}R`;
        return true;
      }
      if (params[0] === 5) {
        // Device status: report OK
        dsrResponse = '\x1b[0n';
        return true;
      }
      return false;
    });

    // Write the DSR request as if a TUI app emitted it through stdout.
    await new Promise<void>(resolve => terminal.write('\x1b[6n', resolve));

    // The cursor is at row 1, col 1 (1-indexed) since nothing else was written.
    expect(dsrResponse).toBe('\x1b[1;1R');
  });

  it('DSR round-trip through PTY', async () => {
    terminal = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    });

    // Spawn /bin/cat via node-pty. cat echoes anything written to its stdin
    // back to stdout. We use stty raw -echo so the PTY does not mangle
    // escape sequences or double-echo input.
    ptyProcess = pty.spawn('/bin/sh', ['-c', 'stty raw -echo; cat'], {
      cols: 80,
      rows: 24,
    });

    // Buffer that accumulates all raw data coming out of the PTY.
    let ptyOutput = '';

    // Wire PTY output into xterm AND capture the raw bytes.
    ptyProcess.onData((data: string) => {
      ptyOutput += data;
      terminal.write(data);
    });

    // Register the CSI handler that responds to DSR by writing the CPR
    // response back into the PTY (completing the round-trip).
    //
    // The REAL DSR flow in TuiSession is:
    //   1. The TUI app (inside PTY) writes \x1b[6n to its stdout
    //   2. ptyProcess.onData delivers it to us
    //   3. We call terminal.write(data) -- xterm parses the CSI sequence
    //   4. Our CSI handler fires, calls ptyProcess.write('\x1b[row;colR')
    //   5. The response goes to the PTY's slave stdin -- the app reads it
    terminal.parser.registerCsiHandler({ final: 'n' }, params => {
      if (params[0] === 6) {
        const buf = terminal.buffer.active;
        ptyProcess!.write(`\x1b[${buf.cursorY + 1};${buf.cursorX + 1}R`);
        return true;
      }
      if (params[0] === 5) {
        ptyProcess!.write('\x1b[0n');
        return true;
      }
      return false;
    });

    // Wait briefly for stty to take effect.
    await new Promise<void>(resolve => setTimeout(resolve, 200));

    // Write the DSR request DIRECTLY to terminal.write(), simulating
    // steps 2-3 of the real flow: as if the TUI app emitted \x1b[6n
    // to its stdout and onData delivered it to us. This avoids sending
    // the escape sequence through the PTY line discipline (which would
    // mangle it -- the original bug).
    //
    // The round-trip from here:
    //   1. terminal.write('\x1b[6n') -- xterm parses the CSI sequence
    //   2. CSI handler fires, writes '\x1b[1;1R' to ptyProcess
    //   3. cat receives '\x1b[1;1R' on its stdin and echoes it to stdout
    //   4. onData captures the CPR response in ptyOutput
    await new Promise<void>(resolve => terminal.write('\x1b[6n', resolve));

    // Poll until the CPR response pattern appears in the captured output.
    // Each iteration flushes xterm's internal write buffer so queued data
    // gets fully processed and CSI handlers fire.
    // eslint-disable-next-line no-control-regex
    const cprPattern = /\x1b\[\d+;\d+R/;
    const deadline = Date.now() + 5000;
    while (!cprPattern.test(ptyOutput) && Date.now() < deadline) {
      // Flush xterm's write buffer so any enqueued data gets processed.
      await new Promise<void>(resolve => terminal.write('', resolve));
      // Yield to the event loop so PTY I/O callbacks can fire.
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }

    expect(ptyOutput).toMatch(cprPattern);
  });
});

// ---------------------------------------------------------------------------
// Test D: createMinimalProjectDir
// ---------------------------------------------------------------------------
describe('createMinimalProjectDir', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('creates and cleans up a minimal agentcore project directory', async () => {
    const result = await createMinimalProjectDir();
    cleanup = result.cleanup;

    // The directory should exist
    expect(existsSync(result.dir)).toBe(true);

    // agentcore/agentcore.json should be present
    const configPath = join(result.dir, 'agentcore', 'agentcore.json');
    expect(existsSync(configPath)).toBe(true);

    // Parse the config and verify it has a name field
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config).toHaveProperty('name');
    expect(typeof config.name).toBe('string');

    // Clean up and verify removal
    await result.cleanup();
    cleanup = undefined; // prevent double cleanup in afterEach
    expect(existsSync(result.dir)).toBe(false);
  });
});
