import {
  type RunResult,
  hasAwsCredentials,
  parseJsonOutput,
  prereqs,
  spawnAndCollect,
} from '../src/test-utils/index.js';
import {
  BedrockAgentCoreControlClient,
  DeleteApiKeyCredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const baseCanRun = prereqs.npm && prereqs.git && prereqs.uv && hasAws;

/**
 * Run the globally installed `agentcore` CLI.
 * E2E tests use the packaged binary to validate the published artifact.
 */
async function runAgentCore(args: string[], cwd: string): Promise<RunResult> {
  return spawnAndCollect('agentcore', args, cwd);
}

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

      const result = await runAgentCore(createArgs, testDir);

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

      // Override @aws/agentcore-cdk with a local tarball if provided (for cross-package testing)
      if (process.env.CDK_TARBALL) {
        execSync(`npm install -f ${process.env.CDK_TARBALL}`, {
          cwd: join(projectPath, 'agentcore', 'cdk'),
          stdio: 'pipe',
        });
      }
    }, 300000);

    afterAll(async () => {
      if (projectPath && hasAws) {
        await runAgentCore(['remove', 'all', '--json'], projectPath);
        const result = await runAgentCore(['deploy', '--yes', '--json'], projectPath);

        if (result.exitCode !== 0) {
          console.log('Teardown stdout:', result.stdout);
          console.log('Teardown stderr:', result.stderr);
        }

        // Delete the API key credential provider from the account.
        // These are created as a pre-deploy step outside CDK and are not
        // cleaned up by stack teardown, so we must delete them explicitly.
        if (cfg.modelProvider !== 'Bedrock' && agentName) {
          const providerName = `${agentName}${cfg.modelProvider}`;
          const region = process.env.AWS_REGION ?? 'us-east-1';
          try {
            const client = new BedrockAgentCoreControlClient({ region });
            await client.send(new DeleteApiKeyCredentialProviderCommand({ name: providerName }));
          } catch {
            // Best-effort cleanup — don't fail the test if deletion fails
          }
        }
      }
      if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
    }, 600000);

    // Container builds go through CodeBuild which is slower and more prone to transient failures.
    const isContainerBuild = cfg.build === 'Container';
    const deployRetries = isContainerBuild ? 3 : 1;
    const deployTimeout = isContainerBuild ? 900000 : 600000;

    it.skipIf(!canRun)(
      'deploys to AWS successfully',
      async () => {
        expect(projectPath, 'Project should have been created').toBeTruthy();

        await retry(
          async () => {
            const result = await runAgentCore(['deploy', '--yes', '--json'], projectPath);

            if (result.exitCode !== 0) {
              console.log('Deploy stdout:', result.stdout);
              console.log('Deploy stderr:', result.stderr);
            }

            expect(result.exitCode, `Deploy failed (stderr: ${result.stderr}, stdout: ${result.stdout})`).toBe(0);

            const json = parseJsonOutput(result.stdout) as { success: boolean };
            expect(json.success, 'Deploy should report success').toBe(true);
          },
          deployRetries,
          30000
        );
      },
      deployTimeout
    );

    it.skipIf(!canRun)(
      'invokes the deployed agent',
      async () => {
        expect(projectPath, 'Project should have been created').toBeTruthy();

        // Retry invoke to handle cold-start / runtime initialization delays
        await retry(
          async () => {
            const result = await runAgentCore(
              ['invoke', '--prompt', 'Say hello', '--agent', agentName, '--json'],
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
  });
}
