import { hasAwsCredentials, parseJsonOutput, prereqs, retry, spawnAndCollect } from '../src/test-utils/index.js';
import {
  cleanupStaleCredentialProviders,
  installCdkTarball,
  runAgentCoreCLI,
  teardownE2EProject,
  writeAwsTargets,
} from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const baseCanRun = prereqs.npm && prereqs.git && hasAws;

interface HarnessE2EConfig {
  modelProvider: 'bedrock' | 'open_ai' | 'gemini';
  requiredEnvVar?: string;
  skipMemory?: boolean;
}

export function createHarnessE2ESuite(cfg: HarnessE2EConfig) {
  const hasRequiredVar = !cfg.requiredEnvVar || !!process.env[cfg.requiredEnvVar];
  const canRun = baseCanRun && hasRequiredVar;

  const providerLabel =
    cfg.modelProvider === 'open_ai' ? 'OpenAI' : cfg.modelProvider === 'gemini' ? 'Gemini' : 'Bedrock';

  describe.sequential(`e2e: harness/${providerLabel} — create → deploy → invoke`, () => {
    let testDir: string;
    let projectPath: string;
    let harnessName: string;

    beforeAll(async () => {
      if (!canRun) return;

      await cleanupStaleCredentialProviders();

      testDir = join(tmpdir(), `agentcore-e2e-harness-${randomUUID()}`);
      await mkdir(testDir, { recursive: true });

      const providerSlug = cfg.modelProvider.replace('_', '').slice(0, 4);
      harnessName = `E2eHrns${providerSlug}${String(Date.now()).slice(-8)}`;

      const createArgs = [
        'create',
        '--name',
        harnessName,
        '--model-provider',
        cfg.modelProvider,
        '--json',
        '--skip-git',
      ];

      if (cfg.requiredEnvVar && process.env[cfg.requiredEnvVar]) {
        createArgs.push('--api-key-arn', process.env[cfg.requiredEnvVar]!);
      }

      if (cfg.skipMemory) {
        createArgs.push('--no-harness-memory');
      }

      const result = await runAgentCoreCLI(createArgs, testDir);

      expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { projectPath: string };
      projectPath = json.projectPath;

      await writeAwsTargets(projectPath);
      installCdkTarball(projectPath);
    }, 300000);

    afterAll(async () => {
      if (projectPath && hasAws) {
        await teardownE2EProject(projectPath, harnessName, cfg.modelProvider);
      }
      if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    }, 600000);

    it.skipIf(!canRun)(
      'deploys to AWS successfully',
      async () => {
        expect(projectPath, 'Project should have been created').toBeTruthy();

        await retry(
          async () => {
            const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);

            if (result.exitCode !== 0) {
              console.log('Deploy stdout:', result.stdout);
              console.log('Deploy stderr:', result.stderr);
            }

            expect(result.exitCode, `Deploy failed (stderr: ${result.stderr}, stdout: ${result.stdout})`).toBe(0);

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
      'invokes the deployed harness',
      async () => {
        expect(projectPath, 'Project should have been created').toBeTruthy();

        await retry(
          async () => {
            const result = await runAgentCoreCLI(
              ['invoke', '--harness', harnessName, '--prompt', 'Say hello', '--json'],
              projectPath
            );

            if (result.exitCode !== 0) {
              console.log('Invoke stdout:', result.stdout);
              console.log('Invoke stderr:', result.stderr);
            }

            expect(result.exitCode, `Invoke failed: ${result.stderr}`).toBe(0);

            const json = parseJsonOutput(result.stdout) as { success: boolean };
            expect(json.success, 'Invoke should report success').toBe(true);
          },
          3,
          15000
        );
      },
      180000
    );

    it.skipIf(!canRun)(
      'status shows the deployed harness',
      async () => {
        const statusResult = await spawnAndCollect('agentcore', ['status', '--json'], projectPath);

        expect(statusResult.exitCode, `Status failed: ${statusResult.stderr}`).toBe(0);

        const json = parseJsonOutput(statusResult.stdout) as {
          success: boolean;
          resources: {
            resourceType: string;
            name: string;
            deploymentState: string;
            identifier?: string;
          }[];
        };
        expect(json.success).toBe(true);

        const harness = json.resources.find(r => r.resourceType === 'harness' && r.name === harnessName);
        expect(harness, `Harness "${harnessName}" should appear in status`).toBeDefined();
        expect(harness!.deploymentState).toBe('deployed');
        expect(harness!.identifier, 'Deployed harness should have a harnessArn').toBeTruthy();
      },
      120000
    );
  });
}
