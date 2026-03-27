/**
 * Test helpers for TUI harness tests and integration tests.
 *
 * Provides utilities for creating minimal project directories that the
 * AgentCore CLI recognizes as valid projects, without the overhead of
 * running the full create wizard or npm/uv installs.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a minimal project directory.
 *
 * @property projectName - Name used in agentcore.json. Defaults to 'testproject'.
 * @property hasAgents - When true, includes a sample agent in the config.
 *   Defaults to false.
 */
export interface CreateMinimalProjectDirOptions {
  projectName?: string;
  hasAgents?: boolean;
}

/**
 * Result of creating a minimal project directory.
 *
 * @property dir - Absolute path to the created temporary directory.
 * @property cleanup - Async function that removes the directory and all its
 *   contents. Call this in `afterEach` or a `finally` block.
 */
export interface MinimalProjectDirResult {
  dir: string;
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory that AgentCore recognizes as a valid project.
 *
 * The directory contains the minimum file structure needed for the CLI to
 * detect a project and open to the HelpScreen (command list) rather than
 * the HomeScreen ("No AgentCore project found"):
 *
 * ```
 * <tmpdir>/
 *   agentcore/
 *     agentcore.json   # minimal valid config
 * ```
 *
 * When `hasAgents` is true, the config includes a sample agent entry
 * pointing to a placeholder code directory.
 *
 * This function is intentionally fast (~10ms) -- it writes only the config
 * files, with no `npm install` or `uv sync`.
 *
 * @param options - Optional configuration for the project directory.
 * @returns An object with `dir` (the path) and `cleanup` (removal function).
 *
 * @example
 * ```ts
 * const { dir, cleanup } = await createMinimalProjectDir();
 * try {
 *   // Use dir as cwd for TuiSession.launch()
 * } finally {
 *   await cleanup();
 * }
 * ```
 */
export async function createMinimalProjectDir(
  options: CreateMinimalProjectDirOptions = {}
): Promise<MinimalProjectDirResult> {
  const { projectName = 'testproject', hasAgents = false } = options;

  // Create the temp directory with a recognizable prefix for debugging.
  // mkdtemp always returns the created path as a string (unlike mkdir).
  const dir = await mkdtemp(join(tmpdir(), 'agentcore-test-'));

  // Create the agentcore config directory.
  const agentcoreDir = join(dir, 'agentcore');
  await mkdir(agentcoreDir, { recursive: true });

  // Build the minimal config object.
  const config: Record<string, unknown> = {
    name: projectName,
    version: 1,
    managedBy: 'CDK',
    agents: [] as unknown[],
    memories: [],
    credentials: [],
  };

  // Optionally add a sample agent.
  if (hasAgents) {
    (config.agents as unknown[]).push({
      type: 'AgentCoreRuntime',
      name: 'TestAgent',
      build: 'CodeZip',
      entrypoint: 'main.py:handler',
      codeLocation: 'app/TestAgent',
      runtimeVersion: 'PYTHON_3_12',
    });

    // Create the agent code directory so the CLI does not complain.
    await mkdir(join(dir, 'app', 'TestAgent'), { recursive: true });
  }

  // Write the config file.
  await writeFile(join(agentcoreDir, 'agentcore.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // Return the path and a cleanup function.
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}
