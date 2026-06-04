import { getHarness } from '../src/cli/aws/agentcore-harness.js';
import { hasAwsCredentials, parseJsonOutput, prereqs, retry, spawnAndCollect } from '../src/test-utils/index.js';
import {
  cleanupStaleCredentialProviders,
  installCdkTarball,
  runAgentCoreCLI,
  teardownE2EProject,
  writeAwsTargets,
} from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
// Harness features are only available in preview builds (BUILD_PREVIEW=1).
const isPreviewBuild = process.env.BUILD_PREVIEW === '1';
const baseCanRun = prereqs.npm && prereqs.git && hasAws && isPreviewBuild;

interface HarnessE2EConfig {
  modelProvider: 'bedrock' | 'open_ai' | 'gemini';
  apiKeyEnvVar?: string;
  skipMemory?: boolean;
  skipInvoke?: boolean;
}

export function createHarnessE2ESuite(cfg: HarnessE2EConfig) {
  const hasRequiredVar = !cfg.apiKeyEnvVar || !!process.env[cfg.apiKeyEnvVar];
  const canRun = baseCanRun && hasRequiredVar;

  const providerLabel =
    cfg.modelProvider === 'open_ai' ? 'OpenAI' : cfg.modelProvider === 'gemini' ? 'Gemini' : 'Bedrock';

  describe.sequential(`e2e: harness/${providerLabel} — create → deploy → invoke → teardown`, () => {
    let testDir: string;
    let projectPath: string;
    let harnessName: string;
    let harnessId: string;

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

      if (cfg.apiKeyEnvVar && process.env[cfg.apiKeyEnvVar]) {
        createArgs.push('--api-key-arn', process.env[cfg.apiKeyEnvVar]!);
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
        // Teardown is tested as a step; this is a safety net in case earlier steps fail
        await teardownE2EProject(projectPath, harnessName, cfg.modelProvider).catch((_: unknown) => undefined);
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

    it.skipIf(!canRun || !!cfg.skipInvoke)(
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

        // Capture harnessId for teardown verification
        const statePath = join(projectPath, 'agentcore', '.cli', 'deployed-state.json');
        const stateJson = JSON.parse(await readFile(statePath, 'utf-8')) as {
          targets?: { default?: { resources?: { harnesses?: Record<string, { harnessId: string }> } } };
        };
        const harnessEntry = stateJson.targets?.default?.resources?.harnesses?.[harnessName];
        if (harnessEntry) {
          harnessId = harnessEntry.harnessId;
        }
      },
      120000
    );

    it.skipIf(!canRun)(
      'remove all and deploy tears down harness',
      async () => {
        const removeResult = await runAgentCoreCLI(['remove', 'all', '--yes', '--json'], projectPath);
        expect(removeResult.exitCode, `Remove all failed: ${removeResult.stderr}`).toBe(0);

        const removeJson = parseJsonOutput(removeResult.stdout) as { success: boolean };
        expect(removeJson.success).toBe(true);

        const deployResult = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
        expect(deployResult.exitCode, `Teardown deploy failed: ${deployResult.stderr}`).toBe(0);

        const deployJson = parseJsonOutput(deployResult.stdout) as { success: boolean };
        expect(deployJson.success).toBe(true);
      },
      600000
    );

    it.skipIf(!canRun)(
      'verifies harness is deleted from AWS',
      async () => {
        expect(harnessId, 'harnessId should have been captured').toBeTruthy();

        const region = process.env.AWS_REGION ?? 'us-east-1';
        await retry(
          async () => {
            try {
              const result = await getHarness({ region, harnessId });
              expect(['DELETING', 'DELETED'], `Expected DELETING or DELETED, got ${result.harness.status}`).toContain(
                result.harness.status
              );
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              expect(
                message.includes('not found') || message.includes('ResourceNotFoundException'),
                `Expected ResourceNotFound, got: ${message}`
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
}
