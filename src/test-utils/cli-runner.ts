import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Result from running a CLI command.
 */
export interface RunResult {
  /** Stdout output with ANSI codes stripped */
  stdout: string;
  /** Stderr output */
  stderr: string;
  /** Process exit code */
  exitCode: number;
}

/**
 * Get the path to the CLI entry point.
 * Uses the built bundle - run `npm run build` before tests.
 */
function getCLIPath(): string {
  // Navigate from src/test-utils to dist/cli/index.mjs
  return join(__dirname, '..', '..', 'dist', 'cli', 'index.mjs');
}

/**
 * Run the AgentCore CLI with the given arguments.
 *
 * @param args - CLI arguments to pass
 * @param cwd - Working directory to run the command in
 * @returns Promise resolving to the command result
 *
 * @example
 * ```ts
 * const result = await runCLI(['create', '--name', 'MyProject', '--json'], testDir);
 * assert.strictEqual(result.exitCode, 0);
 * ```
 */
export async function runCLI(args: string[], cwd: string, skipInstall = true): Promise<RunResult> {
  const cliPath = getCLIPath();

  return new Promise(resolve => {
    const proc = spawn('node', [cliPath, ...args], {
      cwd,
      env: { ...process.env, INIT_CWD: undefined, ...(skipInstall ? { AGENTCORE_SKIP_INSTALL: '1' } : {}) },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', code => {
      // Strip ANSI escape codes from stdout
      // eslint-disable-next-line no-control-regex
      stdout = stdout.replace(/\x1B\[\??\d*[a-zA-Z]/g, '').trim();
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
