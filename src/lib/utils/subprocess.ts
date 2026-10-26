import {
  ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  type StdioOptions,
} from 'child_process';
import crossSpawn from 'cross-spawn';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

type WithoutShell<T> = Omit<T, 'shell'> & { shell?: false };
type SafeSpawnOptions = WithoutShell<SpawnOptions>;
type SafeSpawnSyncOptions = WithoutShell<SpawnSyncOptions>;
type SafeSpawnSyncOptionsWithBufferEncoding = WithoutShell<SpawnSyncOptionsWithBufferEncoding>;
type SafeSpawnSyncOptionsWithStringEncoding = WithoutShell<SpawnSyncOptionsWithStringEncoding>;

/**
 * Subprocess utilities for AgentCore.
 *
 * IMPORTANT: Async functions (runSubprocess, checkSubprocess, runSubprocessCapture)
 * are safe for TUI contexts and are exported from lib.
 *
 * Sync functions (runSubprocessCaptureSync, checkSubprocessSync) block the event loop
 * and are ONLY safe in CDK bundling contexts (which run in a subprocess). They are
 * intentionally NOT exported from the public API to prevent accidental UI freezes.
 *
 * Callers pass argument arrays and cannot request shell execution. On Windows, cross-spawn
 * invokes cmd.exe only when required for .cmd/.bat wrappers and escapes the command and each
 * argument before doing so.
 *
 * All spawning in the CLI must go through {@link spawn} / {@link spawnSync} (or the helpers
 * built on them). Windows searches the current directory before PATH when resolving a bare
 * command name, as do cross-spawn's resolver and cmd.exe. These wrappers instead resolve
 * commands against absolute PATH entries and spawn the resulting absolute path.
 */

export interface SubprocessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/** Tells cmd.exe (and CreateProcess-based lookups that honor it) not to search the current directory. */
export const NO_CWD_EXE_SEARCH_ENV = 'NoDefaultCurrentDirectoryInExePath';

const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const WINDOWS_ENOENT_ERRNO = -4058;
const POSIX_ENOENT_ERRNO = -2;

interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Overridable for tests; defaults to a filesystem check. */
  isExecutableFile?: (filePath: string, platform: NodeJS.Platform) => boolean;
}

function defaultIsExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (platform !== 'win32') accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Environment variable lookup that is case-insensitive on Windows (`Path` vs `PATH`). */
function getEnvValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  // With duplicate-case keys, child_process uses the lexicographically first one; match it.
  const key = Object.keys(env)
    .filter(k => k.toUpperCase() === name.toUpperCase())
    .sort()[0];
  return key === undefined ? undefined : env[key];
}

/**
 * Resolve a command name to an absolute executable path using only absolute PATH entries.
 *
 * Unlike Windows' native lookup (and the `which` package used by cross-spawn), this never
 * searches the current working directory, and it skips empty, `.` and other relative PATH
 * entries. Commands that already contain a path separator are returned unchanged.
 *
 * @returns The absolute path, or `null` if the command is not found on PATH.
 */
export function resolveExecutable(command: string, options: ResolveExecutableOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile;
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;

  if (command.length === 0) return null;
  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) return command;

  const dirs = (getEnvValue(env, 'PATH', platform) ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map(dir => (platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter(dir => dir.length > 0 && pathImpl.isAbsolute(dir));

  let candidates = [command];
  if (platform === 'win32') {
    const exts = (getEnvValue(env, 'PATHEXT', platform) ?? DEFAULT_WINDOWS_PATHEXT)
      .split(';')
      .map(ext => ext.trim())
      .filter(ext => ext.length > 0);
    const hasKnownExt = exts.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()));
    // Like Windows, a name that already has an extension is tried as-is first.
    candidates = hasKnownExt
      ? [command]
      : [...(pathImpl.extname(command) ? [command] : []), ...exts.map(ext => command + ext)];
  }

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const fullPath = pathImpl.join(dir, candidate);
      if (isExecutableFile(fullPath, platform)) return fullPath;
    }
  }
  return null;
}

/** Child environment with current-directory executable search disabled on Windows. */
function withSafeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (process.platform !== 'win32') return env;
  return { ...(env ?? process.env), [NO_CWD_EXE_SEARCH_ENV]: '1' };
}

function assertShellDisabled(options: { shell?: unknown }): void {
  if (options.shell !== undefined && options.shell !== false) {
    throw new TypeError('Shell execution is not supported by the subprocess wrapper.');
  }
}

/**
 * Disable current-directory executable search for this process and everything it spawns
 * (including third-party libraries such as the CDK toolkit, which spawn through a shell).
 * Call once at CLI startup. No-op off Windows.
 */
export function disableCwdExecutableSearch(): void {
  if (process.platform === 'win32') {
    process.env[NO_CWD_EXE_SEARCH_ENV] = '1';
  }
}

function makeEnoentError(syscall: 'spawn' | 'spawnSync', command: string, args: readonly string[]) {
  return Object.assign(new Error(`${syscall} ${command} ENOENT`), {
    code: 'ENOENT',
    errno: process.platform === 'win32' ? WINDOWS_ENOENT_ERRNO : POSIX_ENOENT_ERRNO,
    syscall: `${syscall} ${command}`,
    path: command,
    spawnargs: [...args],
  });
}

/** A ChildProcess that fails the way Node's spawn does for a missing command: 'error' then 'close'. */
function notFoundChildProcess(command: string, args: readonly string[]): ChildProcess {
  const child = new ChildProcess();
  // Never spawned: drop the native handle so kill()/ref()/unref() are no-ops instead of
  // acting on an uninitialized process handle.
  (child as unknown as { _handle: unknown })._handle = null;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(child, {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: stderr },
    stdio: { value: [stdin, stdout, stderr] },
  });
  const error = makeEnoentError('spawn', command, args);
  process.nextTick(() => {
    child.emit('error', error);
    stdout.end();
    stderr.end();
    child.emit('close', error.errno, null);
  });
  return child;
}

/**
 * Drop-in replacement for `child_process.spawn` that never runs an executable from the
 * current directory. See the module comment.
 */
export function spawn(command: string, args: readonly string[] = [], options: SafeSpawnOptions = {}): ChildProcess {
  assertShellDisabled(options);
  const resolved = resolveExecutable(command, { env: options.env });
  if (resolved === null && process.platform === 'win32') {
    return notFoundChildProcess(command, args);
  }
  return crossSpawn(resolved ?? command, args, {
    ...options,
    shell: false,
    env: withSafeEnv(options.env),
  });
}

/**
 * Drop-in replacement for `child_process.spawnSync` that never runs an executable from the
 * current directory. See the module comment.
 */
export function spawnSync(
  command: string,
  args: readonly string[],
  options: SafeSpawnSyncOptionsWithStringEncoding
): SpawnSyncReturns<string>;
export function spawnSync(
  command: string,
  args?: readonly string[],
  options?: SafeSpawnSyncOptionsWithBufferEncoding | SafeSpawnSyncOptions
): SpawnSyncReturns<Buffer>;
export function spawnSync(
  command: string,
  args: readonly string[] = [],
  options: SafeSpawnSyncOptions = {}
): SpawnSyncReturns<string | Buffer> {
  assertShellDisabled(options);
  const resolved = resolveExecutable(command, { env: options.env });
  if (resolved === null && process.platform === 'win32') {
    const empty = options.encoding && options.encoding !== 'buffer' ? '' : Buffer.alloc(0);
    return {
      pid: 0,
      output: [],
      stdout: empty,
      stderr: empty,
      status: null,
      signal: null,
      error: makeEnoentError('spawnSync', command, args),
    };
  }
  return crossSpawn.sync(resolved ?? command, args, {
    ...options,
    shell: false,
    env: withSafeEnv(options.env),
  }) as SpawnSyncReturns<string | Buffer>;
}

export async function runSubprocess(command: string, args: string[], options: SubprocessOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? 'inherit' });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = code !== null ? `code ${code}` : `signal ${String(signal)}`;
      reject(new Error(`${command} exited with ${reason}`));
    });
  });
}

export async function checkSubprocess(
  command: string,
  args: string[],
  options: SubprocessOptions = {}
): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? 'ignore' });

    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export async function runSubprocessCapture(
  command: string,
  args: string[],
  options: SubprocessOptions = {}
): Promise<SubprocessResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: 'pipe' });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: unknown) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    });

    child.stderr?.on('data', (chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    });

    child.on('close', (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });

    child.on('error', error => {
      resolve({ stdout, stderr: stderr || error.message, code: -1, signal: null });
    });
  });
}

export function runSubprocessCaptureSync(
  command: string,
  args: string[],
  options: SubprocessOptions = {}
): SubprocessResult {
  const result = spawnSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf-8' });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status,
    signal: result.signal,
  };
}

export function checkSubprocessSync(command: string, args: string[], options: SubprocessOptions = {}): boolean {
  try {
    const result = spawnSync(command, args, { ...options, stdio: options.stdio ?? 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}
