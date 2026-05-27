import { getHarness } from '../src/cli/aws/agentcore-harness.js';
import { hasAwsCredentials, parseJsonOutput, prereqs, retry } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, writeAwsTargets } from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const isPreviewBuild = process.env.BUILD_PREVIEW === '1';
const canRun = prereqs.npm && prereqs.git && hasAws && isPreviewBuild;

describe.sequential('e2e: harness remove-all teardown — create → deploy → remove all → deploy → verify deleted', () => {
  let testDir: string;
  let projectPath: string;
  let harnessName: string;
  let harnessId: string;
  let region: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-harness-teardown-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    harnessName = `E2eTrdn${String(Date.now()).slice(-8)}`;
    region = process.env.AWS_REGION ?? 'us-east-1';

    const createArgs = [
      'create',
      '--name',
      harnessName,
      '--model-provider',
      'bedrock',
      '--json',
      '--skip-git',
      '--no-harness-memory',
    ];

    const result = await runAgentCoreCLI(createArgs, testDir);
    expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);

    const json = parseJsonOutput(result.stdout) as { projectPath: string };
    projectPath = json.projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 60000);

  it.skipIf(!canRun)(
    'deploys harness to AWS successfully',
    async () => {
      expect(projectPath, 'Project should have been created').toBeTruthy();

      await retry(
        async () => {
          const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);

          if (result.exitCode !== 0) {
            console.log('Deploy stdout:', result.stdout);
            console.log('Deploy stderr:', result.stderr);
          }

          expect(result.exitCode, `Deploy failed: ${result.stderr}`).toBe(0);

          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success, 'Deploy should report success').toBe(true);
        },
        1,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'verifies harness exists in AWS with READY status',
    async () => {
      const statePath = join(projectPath, 'agentcore', '.cli', 'deployed-state.json');
      const stateJson = JSON.parse(await readFile(statePath, 'utf-8'));
      const harnesses = stateJson.targets?.default?.resources?.harnesses;

      expect(harnesses, 'deployed-state.json should have harnesses').toBeDefined();
      expect(harnesses[harnessName], `Harness "${harnessName}" should be in deployed state`).toBeDefined();

      harnessId = harnesses[harnessName].harnessId;
      expect(harnessId, 'harnessId should be set').toBeTruthy();

      await retry(
        async () => {
          const result = await getHarness({ region, harnessId });
          expect(result.harness.status).toBe('READY');
        },
        3,
        5000
      );
    },
    120000
  );

  it.skipIf(!canRun)(
    'runs remove all successfully',
    async () => {
      const result = await runAgentCoreCLI(['remove', 'all', '--yes', '--json'], projectPath);
      expect(result.exitCode, `Remove all failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);

      const configPath = join(projectPath, 'agentcore', 'agentcore.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8'));
      expect(config.harnesses).toEqual([]);
    },
    60000
  );

  it.skipIf(!canRun)(
    'deploys (teardown) successfully',
    async () => {
      const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);

      if (result.exitCode !== 0) {
        console.log('Teardown deploy stdout:', result.stdout);
        console.log('Teardown deploy stderr:', result.stderr);
      }

      expect(result.exitCode, `Teardown deploy failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success, 'Teardown deploy should report success').toBe(true);
    },
    600000
  );

  it.skipIf(!canRun)(
    'verifies harness is deleted from AWS',
    async () => {
      expect(harnessId, 'harnessId should have been captured from deploy step').toBeTruthy();

      await retry(
        async () => {
          try {
            const result = await getHarness({ region, harnessId });
            expect(
              ['DELETING', 'DELETED'],
              `Expected harness status to be DELETING or DELETED, got ${result.harness.status}`
            ).toContain(result.harness.status);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            expect(
              message.includes('not found') || message.includes('ResourceNotFoundException'),
              `Expected ResourceNotFound error, got: ${message}`
            ).toBe(true);
          }
        },
        5,
        10000
      );
    },
    120000
  );
});
