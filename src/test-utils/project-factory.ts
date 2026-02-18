import { runCLI } from './cli-runner.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestProject {
  /** Absolute path to the created project root */
  projectPath: string;
  /** Name of the agent (if one was created) */
  agentName: string;
  /** Absolute path to the temp directory containing the project */
  testDir: string;
  /** Remove the temp directory and all contents */
  cleanup: () => Promise<void>;
}

export interface CreateTestProjectOptions {
  name?: string;
  language?: string;
  framework?: string;
  modelProvider?: string;
  memory?: string;
  noAgent?: boolean;
  /** Defaults to true (skip npm install and uv sync for speed) */
  skipInstall?: boolean;
  /** Parent directory — defaults to os.tmpdir() */
  parentDir?: string;
}

/**
 * Create an AgentCore project in a temp directory for testing.
 * Returns project metadata and a cleanup function.
 *
 * @throws Error if the create command fails
 */
export async function createTestProject(options: CreateTestProjectOptions = {}): Promise<TestProject> {
  const {
    name = `IntegTest${Date.now().toString().slice(-6)}`,
    language,
    framework,
    modelProvider,
    memory,
    noAgent = false,
    skipInstall = true,
    parentDir,
  } = options;

  const testDir = join(parentDir ?? tmpdir(), `agentcore-integ-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });

  const args: string[] = ['create', '--name', name];

  if (noAgent) {
    args.push('--no-agent');
  } else {
    if (language) args.push('--language', language);
    if (framework) args.push('--framework', framework);
    if (modelProvider) args.push('--model-provider', modelProvider);
    if (memory) args.push('--memory', memory);
  }

  args.push('--json');

  const result = await runCLI(args, testDir, skipInstall);

  if (result.exitCode !== 0) {
    // Clean up on failure
    await rm(testDir, { recursive: true, force: true });
    throw new Error(`createTestProject failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  const json = JSON.parse(result.stdout);

  return {
    projectPath: json.projectPath,
    agentName: json.agentName || name,
    testDir,
    cleanup: () => rm(testDir, { recursive: true, force: true }),
  };
}
