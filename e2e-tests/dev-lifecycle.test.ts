import { waitForServerReady } from '../src/cli/operations/dev/utils.js';
import { cleanSpawnEnv, parseJsonOutput, spawnAndCollect } from '../src/test-utils/index.js';
import { baseCanRun as canRun, runAgentCoreCLI } from './e2e-helper.js';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const DEV_SERVER_PORT = 18080;
const DEV_SERVER_PORT_STR = String(DEV_SERVER_PORT);

describe.sequential('e2e: dev server lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  let serverProcess: ChildProcess | null = null;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-dev-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const result = await runAgentCoreCLI(
      [
        'create',
        '--name',
        'DevTest',
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
      testDir
    );
    expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
    projectPath = z.object({ projectPath: z.string() }).parse(parseJsonOutput(result.stdout)).projectPath;
  }, 120000);

  afterAll(async () => {
    if (serverProcess?.pid) {
      try {
        process.kill(-serverProcess.pid, 'SIGTERM');
      } catch {
        // Process group already exited
      }
      await new Promise<void>(resolve => {
        serverProcess?.on('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
      serverProcess = null;
    }
    if (testDir) {
      await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    }
  }, 30000);

  it.skipIf(!canRun)(
    'dev --logs starts the server and accepts connections',
    async () => {
      serverProcess = spawn('agentcore', ['dev', '--logs', '--port', DEV_SERVER_PORT_STR], {
        cwd: projectPath,
        stdio: 'pipe',
        detached: true,
        env: cleanSpawnEnv(),
      });

      const ready = await waitForServerReady(DEV_SERVER_PORT, 90000);
      expect(ready, 'Dev server should accept connections').toBe(true);
    },
    120000
  );

  it.skipIf(!canRun)(
    'dev invokes the running server and returns a response',
    async () => {
      const result = await spawnAndCollect(
        'agentcore',
        ['dev', 'What is 2 plus 2? Reply with just the number.', '--port', DEV_SERVER_PORT_STR],
        projectPath
      );

      expect(result.exitCode, `Invoke failed (exit ${result.exitCode}): ${result.stderr}`).toBe(0);
      expect(result.stdout.length, 'Should produce a response').toBeGreaterThan(0);
    },
    60000
  );

  it.skipIf(!canRun)(
    'dev --stream returns a response',
    async () => {
      const result = await spawnAndCollect(
        'agentcore',
        ['dev', 'Say hello', '--stream', '--port', DEV_SERVER_PORT_STR],
        projectPath
      );

      expect(result.exitCode, `Stream invoke failed (exit ${result.exitCode}): ${result.stderr}`).toBe(0);
      expect(result.stdout.length, 'Should produce output').toBeGreaterThan(0);
    },
    60000
  );
});
