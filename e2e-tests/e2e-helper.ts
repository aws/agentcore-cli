import { hasAwsCredentials, parseJsonOutput, prereqs, runCLI } from '../src/test-utils/index.js';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const baseCanRun = prereqs.npm && prereqs.git && prereqs.uv && hasAws;

interface E2EConfig {
  framework: string;
  modelProvider: string;
  requiredEnvVar?: string;
  build?: string;
}

/**
 * Retry an async function up to `times` attempts with a delay between retries.
 */
async function retry<T>(fn: () => Promise<T>, times: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < times - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export function createE2ESuite(cfg: E2EConfig) {
  const hasApiKey = !cfg.requiredEnvVar || !!process.env[cfg.requiredEnvVar];
  const canRun = baseCanRun && hasApiKey;

  describe.sequential(`e2e: ${cfg.framework}/${cfg.modelProvider} — create → deploy → invoke`, () => {
    let testDir: string;
    let projectPath: string;
    let agentName: string;

    beforeAll(async () => {
      if (!canRun) return;

      testDir = join(tmpdir(), `agentcore-e2e-${randomUUID()}`);
      await mkdir(testDir, { recursive: true });

      agentName = `E2e${cfg.framework.slice(0, 4)}${cfg.modelProvider.slice(0, 4)}${String(Date.now()).slice(-8)}`;
      const createArgs = [
        'create',
        '--name',
        agentName,
        '--language',
        'Python',
        '--framework',
        cfg.framework,
        '--model-provider',
        cfg.modelProvider,
        '--memory',
        'none',
        '--json',
      ];

      if (cfg.build) {
        createArgs.push('--build', cfg.build);
      }

      // Pass API key so the credential is registered in the project and .env.local
      const apiKey = cfg.requiredEnvVar ? process.env[cfg.requiredEnvVar] : undefined;
      if (apiKey) {
        createArgs.push('--api-key', apiKey);
      }

      const result = await runCLI(createArgs, testDir, false);

      expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { projectPath: string };
      projectPath = json.projectPath;

      // TODO: Replace with `agentcore add target` once the CLI command is re-introduced
      const account =
        process.env.AWS_ACCOUNT_ID ??
        execSync('aws sts get-caller-identity --query Account --output text').toString().trim();
      const region = process.env.AWS_REGION ?? 'us-east-1';
      const awsTargetsPath = join(projectPath, 'agentcore', 'aws-targets.json');
      await writeFile(awsTargetsPath, JSON.stringify([{ name: 'default', account, region }]));
    }, 300000);

    afterAll(async () => {
      if (projectPath && hasAws) {
        await runCLI(['remove', 'all', '--json'], projectPath, false);
        const result = await runCLI(['deploy', '--yes', '--json'], projectPath, false);

        if (result.exitCode !== 0) {
          console.log('Teardown stdout:', result.stdout);
          console.log('Teardown stderr:', result.stderr);
        }
      }
      if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    }, 600000);

    it.skipIf(!canRun)(
      'deploys to AWS successfully',
      async () => {
        expect(projectPath, 'Project should have been created').toBeTruthy();

        const result = await runCLI(['deploy', '--yes', '--json'], projectPath, false);

        if (result.exitCode !== 0) {
          console.log('Deploy stdout:', result.stdout);
          console.log('Deploy stderr:', result.stderr);
        }

        expect(result.exitCode, `Deploy failed: ${result.stderr}`).toBe(0);

        const json = parseJsonOutput(result.stdout) as { success: boolean };
        expect(json.success, 'Deploy should report success').toBe(true);
      },
      600000
    );

    it.skipIf(!canRun)(
      'invokes the deployed agent',
      async () => {
        expect(projectPath, 'Project should have been created').toBeTruthy();

        // Retry invoke to handle cold-start / runtime initialization delays
        await retry(
          async () => {
            const result = await runCLI(
              ['invoke', '--prompt', 'Say hello', '--agent', agentName, '--json'],
              projectPath,
              false
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
  });
}
