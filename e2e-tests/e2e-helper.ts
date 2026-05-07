import {
  type RunResult,
  hasAwsCredentials,
  parseJsonOutput,
  prereqs,
  retry,
  spawnAndCollect,
} from '../src/test-utils/index.js';
import {
  BedrockAgentCoreControlClient,
  DeleteApiKeyCredentialProviderCommand,
  GetAgentRuntimeCommand,
  ListApiKeyCredentialProvidersCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  memory?: string;
  /** Lifecycle configuration to pass via --idle-timeout / --max-lifetime flags. */
  lifecycleConfig?: {
    idleTimeout?: number;
    maxLifetime?: number;
  };
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

      await cleanupStaleCredentialProviders();

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
        cfg.memory ?? 'none',
        '--json',
      ];

      if (cfg.build) {
        createArgs.push('--build', cfg.build);
      }

      if (cfg.lifecycleConfig?.idleTimeout !== undefined) {
        createArgs.push('--idle-timeout', String(cfg.lifecycleConfig.idleTimeout));
      }
      if (cfg.lifecycleConfig?.maxLifetime !== undefined) {
        createArgs.push('--max-lifetime', String(cfg.lifecycleConfig.maxLifetime));
      }

      // Pass API key so the credential is registered in the project and .env.local
      const apiKey = cfg.requiredEnvVar ? process.env[cfg.requiredEnvVar] : undefined;
      if (apiKey) {
        createArgs.push('--api-key', apiKey);
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
        await teardownE2EProject(projectPath, agentName, cfg.modelProvider);
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
            const result = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);

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
            const result = await runAgentCoreCLI(
              ['invoke', '--prompt', 'Say hello', '--runtime', agentName, '--json'],
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

    // ── Post-deploy observability tests ──────────────────────────────
    // Use spawnAndCollect directly to avoid TypeScript inference depth limits
    // in the describe.sequential callback.
    const run = (args: string[]) => spawnAndCollect('agentcore', args, projectPath);

    // Track the runtime ID across status tests
    let runtimeId: string;

    it.skipIf(!canRun)(
      'status shows the deployed agent',
      async () => {
        const result = await run(['status', '--json']);

        expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

        const json = parseJsonOutput(result.stdout) as {
          success: boolean;
          resources: {
            resourceType: string;
            name: string;
            deploymentState: string;
            identifier?: string;
          }[];
        };
        expect(json.success).toBe(true);

        const agent = json.resources.find(r => r.resourceType === 'agent' && r.name === agentName);
        expect(agent, `Agent "${agentName}" should appear in status`).toBeDefined();
        expect(agent!.deploymentState).toBe('deployed');
        expect(agent!.identifier, 'Deployed agent should have a runtime ARN').toBeTruthy();

        // Extract runtime ID from ARN (e.g. arn:aws:...:agent-runtime/XXXXX → XXXXX)
        runtimeId = agent!.identifier!.split('/').pop()!;
      },
      120000
    );

    it.skipIf(!canRun)(
      'status looks up agent runtime by ID',
      async () => {
        expect(runtimeId, 'Runtime ID should have been extracted from status').toBeTruthy();

        const result = await run(['status', '--runtime-id', runtimeId, '--json']);

        expect(result.exitCode, `Runtime lookup failed: ${result.stderr}`).toBe(0);

        const json = parseJsonOutput(result.stdout) as {
          success: boolean;
          runtimeId?: string;
          runtimeStatus?: string;
        };
        expect(json.success).toBe(true);
        expect(json.runtimeId).toBe(runtimeId);
        expect(json.runtimeStatus).toBeTruthy();
      },
      120000
    );

    it.skipIf(!canRun)(
      'logs returns entries from the invocation',
      async () => {
        await retry(
          async () => {
            // --since 1h triggers search mode (avoids live tail)
            const result = await run(['logs', '--runtime', agentName, '--since', '1h', '--json']);

            expect(result.exitCode, `Logs failed: ${result.stderr}`).toBe(0);

            // logs --json outputs JSON Lines (one {timestamp, message} per line)
            const lines: { timestamp: string; message: string }[] = result.stdout
              .split('\n')
              .filter((l: string) => l.trim())
              .map((l: string) => JSON.parse(l) as { timestamp: string; message: string });

            expect(lines.length, 'Should have at least one log entry').toBeGreaterThan(0);
            for (const line of lines) {
              expect(line.timestamp, 'Each log entry should have a timestamp').toBeTruthy();
              expect(line.message, 'Each log entry should have a message').toBeTruthy();
            }
          },
          3,
          15000
        );
      },
      120000
    );

    it.skipIf(!canRun)(
      'logs supports level filtering',
      async () => {
        // --level error should succeed even if no error-level logs exist
        const result = await run(['logs', '--runtime', agentName, '--since', '1h', '--level', 'error', '--json']);

        expect(result.exitCode, `Logs --level failed: ${result.stderr}`).toBe(0);
      },
      120000
    );

    it.skipIf(!canRun)(
      'traces list succeeds after invocation',
      async () => {
        // traces list has no --json flag — verify exit code and non-empty output
        await retry(
          async () => {
            const result = await run(['traces', 'list', '--runtime', agentName, '--since', '1h']);

            expect(result.exitCode, `Traces list failed (stderr: ${result.stderr})`).toBe(0);
            expect(result.stdout.length, 'Traces list should produce output').toBeGreaterThan(0);
          },
          3,
          15000
        );
      },
      120000
    );

    // ── Lifecycle configuration verification ─────────────────────────
    if (cfg.lifecycleConfig) {
      it.skipIf(!canRun)(
        'runtime has lifecycle configuration set via AWS API',
        async () => {
          expect(runtimeId, 'Runtime ID should have been extracted from status').toBeTruthy();

          // Query the runtime via AWS API to verify lifecycle config
          const region = process.env.AWS_REGION ?? 'us-east-1';
          const client = new BedrockAgentCoreControlClient({ region });
          const response = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));

          expect(response.lifecycleConfiguration).toBeDefined();
          if (cfg.lifecycleConfig!.idleTimeout !== undefined) {
            expect(response.lifecycleConfiguration!.idleRuntimeSessionTimeout).toBe(cfg.lifecycleConfig!.idleTimeout);
          }
          if (cfg.lifecycleConfig!.maxLifetime !== undefined) {
            expect(response.lifecycleConfiguration!.maxLifetime).toBe(cfg.lifecycleConfig!.maxLifetime);
          }
        },
        180000
      );
    }
  });
}

export { hasAws, baseCanRun };

export function runAgentCoreCLI(args: string[], cwd: string): Promise<RunResult> {
  return spawnAndCollect('agentcore', args, cwd);
}

// TODO: Replace with `agentcore add target` once the CLI command is re-introduced
export async function writeAwsTargets(projectPath: string): Promise<void> {
  const account =
    process.env.AWS_ACCOUNT_ID ??
    execSync('aws sts get-caller-identity --query Account --output text').toString().trim();
  const region = process.env.AWS_REGION ?? 'us-east-1';
  await writeFile(
    join(projectPath, 'agentcore', 'aws-targets.json'),
    JSON.stringify([{ name: 'default', account, region }])
  );
}

export function installCdkTarball(projectPath: string): void {
  if (process.env.CDK_TARBALL) {
    execSync(`npm install -f ${process.env.CDK_TARBALL}`, {
      cwd: join(projectPath, 'agentcore', 'cdk'),
      stdio: 'pipe',
    });
  }
}

async function deleteCredentialProvider(client: BedrockAgentCoreControlClient, name: string): Promise<void> {
  try {
    await client.send(new DeleteApiKeyCredentialProviderCommand({ name }));
    console.log(`Deleted credential provider: ${name}`);
  } catch (error) {
    const code = (error as { name?: string }).name ?? 'Unknown';
    console.warn(`Failed to delete credential provider ${name}: [${code}]`);
  }
}

/**
 * Delete stale E2e* credential providers older than the given max age.
 * Runs in beforeAll to prevent accumulation from previous runs that
 * crashed or timed out before their afterAll teardown could execute.
 */
export async function cleanupStaleCredentialProviders(maxAgeMs: number = 30 * 60 * 1000): Promise<void> {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const client = new BedrockAgentCoreControlClient({ region });
  const cutoff = new Date(Date.now() - maxAgeMs);

  let nextToken: string | undefined;
  do {
    const response = await client.send(new ListApiKeyCredentialProvidersCommand({ nextToken }));
    const providers = response.credentialProviders ?? [];
    const stale = providers.filter(p => p.name?.startsWith('E2e') && p.createdTime && p.createdTime < cutoff);

    await Promise.all(stale.map(p => deleteCredentialProvider(client, p.name!)));

    nextToken = response.nextToken;
  } while (nextToken);
}

export async function teardownE2EProject(projectPath: string, agentName: string, modelProvider: string): Promise<void> {
  await spawnAndCollect('agentcore', ['remove', 'all', '--json'], projectPath);
  const result = await spawnAndCollect('agentcore', ['deploy', '--yes', '--json'], projectPath);
  if (result.exitCode !== 0) {
    console.log('Teardown stdout:', result.stdout);
    console.log('Teardown stderr:', result.stderr);
  }
  if (modelProvider !== 'Bedrock' && agentName) {
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const client = new BedrockAgentCoreControlClient({ region });
    await deleteCredentialProvider(client, `${agentName}${modelProvider}`);
  }
}

export async function dumpImportDebugInfo(
  label: string,
  result: RunResult,
  projectPath: string,
  stackName: string,
  region: string
): Promise<void> {
  console.log(`Import ${label} stdout:`, result.stdout);
  console.log(`Import ${label} stderr:`, result.stderr);

  const logMatch = /Log: (.+)/.exec(result.stderr);
  if (logMatch) {
    try {
      const logContents = await readFile(join(projectPath, logMatch[1]!), 'utf-8');
      console.log(`Import ${label} log:\n`, logContents);
    } catch {
      /* log file may not exist */
    }
  }

  const cfnEvents = await spawnAndCollect(
    'aws',
    [
      'cloudformation',
      'describe-stack-events',
      '--stack-name',
      stackName,
      '--query',
      'StackEvents[?ResourceStatus==`IMPORT_FAILED` || ResourceStatus==`IMPORT_ROLLBACK_IN_PROGRESS`]',
      '--output',
      'json',
      '--region',
      region,
    ],
    projectPath
  );
  if (cfnEvents.exitCode === 0 && cfnEvents.stdout.trim() !== '[]') {
    console.log(`CloudFormation failed events for ${label}:`, cfnEvents.stdout);
  }
}
