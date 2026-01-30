import { runCLI } from '../src/test-utils/index.js';
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasNpm = hasCommand('npm');
const hasGit = hasCommand('git');
const hasUv = hasCommand('uv');

async function waitForServer(port: number, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/ping`);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

describe('integration: dev server', () => {
  let testDir: string;
  let projectPath: string;
  let devProcess: ChildProcess | null = null;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-dev-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create a project with agent for dev server
    const name = `DevTest${Date.now()}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir,
      false
    );

    if (result.exitCode === 0) {
      const json = JSON.parse(result.stdout);
      projectPath = json.projectPath;
    }
  }, 120000);

  afterEach(() => {
    // Kill dev server if running
    if (devProcess) {
      devProcess.kill('SIGTERM');
      devProcess = null;
    }
  });

  afterAll(async () => {
    if (devProcess) {
      devProcess.kill('SIGKILL');
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it.skipIf(!hasNpm || !hasGit || !hasUv)(
    'starts dev server and responds to health check',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      const cliPath = join(__dirname, '..', 'dist', 'cli', 'index.mjs');
      const port = 8000 + Math.floor(Math.random() * 1000);

      devProcess = spawn('node', [cliPath, 'dev', '--port', String(port), '--logs'], {
        cwd: projectPath,
        stdio: 'pipe',
        env: { ...process.env, INIT_CWD: undefined },
      });

      const serverReady = await waitForServer(port, 20000);
      expect(serverReady, 'Dev server should respond to ping within 20s').toBeTruthy();

      // Clean shutdown
      devProcess.kill('SIGTERM');
      devProcess = null;
    },
    30000
  );
});
