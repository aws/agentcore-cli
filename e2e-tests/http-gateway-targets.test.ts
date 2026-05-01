import { parseJsonOutput, retry } from '../src/test-utils/index.js';
import {
  baseCanRun,
  hasAws,
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

const canRun = baseCanRun && hasAws;

describe.sequential('e2e: HTTP gateway with targets lifecycle', () => {
  let testDir: string;
  let projectPath: string;
  const agentName = `E2eGwTgt${String(Date.now()).slice(-8)}`;
  const gatewayName = 'e2e-target-gw';

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-gw-targets-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const result = await runAgentCoreCLI(
      [
        'create',
        '--name',
        agentName,
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
    projectPath = (parseJsonOutput(result.stdout) as { projectPath: string }).projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 300000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await teardownE2EProject(projectPath, agentName, 'Bedrock');
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  const run = (args: string[]) => runAgentCoreCLI(args, projectPath);

  it.skipIf(!canRun)(
    'adds runtime endpoints (prod, staging)',
    async () => {
      let result = await run([
        'add',
        'runtime-endpoint',
        '--runtime',
        agentName,
        '--endpoint',
        'prod',
        '--version',
        '1',
        '--json',
      ]);
      expect(result.exitCode, `Add prod endpoint failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'runtime-endpoint',
        '--runtime',
        agentName,
        '--endpoint',
        'staging',
        '--version',
        '1',
        '--json',
      ]);
      expect(result.exitCode, `Add staging endpoint failed: ${result.stdout}`).toBe(0);
    },
    60000
  );

  it.skipIf(!canRun)(
    'adds HTTP gateway with name',
    async () => {
      const result = await run(['add', 'gateway', '--name', gatewayName, '--json']);
      expect(result.exitCode, `Add gateway failed: ${result.stdout}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    60000
  );

  it.skipIf(!canRun)(
    'adds gateway targets for prod and staging endpoints',
    async () => {
      let result = await run([
        'add',
        'gateway-target',
        '--name',
        `${agentName}-prod`,
        '--type',
        'mcp-server',
        '--endpoint',
        'https://placeholder-prod.example.com',
        '--gateway',
        gatewayName,
        '--json',
      ]);
      expect(result.exitCode, `Add prod target failed: ${result.stdout}`).toBe(0);

      result = await run([
        'add',
        'gateway-target',
        '--name',
        `${agentName}-staging`,
        '--type',
        'mcp-server',
        '--endpoint',
        'https://placeholder-staging.example.com',
        '--gateway',
        gatewayName,
        '--json',
      ]);
      expect(result.exitCode, `Add staging target failed: ${result.stdout}`).toBe(0);
    },
    60000
  );

  it.skipIf(!canRun)(
    'deploys project with gateway and targets',
    async () => {
      await retry(
        async () => {
          const result = await run(['deploy', '--yes', '--json']);
          if (result.exitCode !== 0) {
            console.log('Deploy stdout:', result.stdout);
            console.log('Deploy stderr:', result.stderr);
          }
          expect(result.exitCode, `Deploy failed (stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success).toBe(true);
        },
        2,
        30000
      );
    },
    600000
  );

  it.skipIf(!canRun)(
    'status shows gateway deployed',
    async () => {
      await retry(
        async () => {
          const result = await run(['status', '--json']);
          expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

          const json = parseJsonOutput(result.stdout) as {
            success: boolean;
            resources: { resourceType: string; name: string; deploymentState: string; identifier?: string }[];
          };
          expect(json.success).toBe(true);

          // Agent should be deployed
          const agent = json.resources.find(r => r.resourceType === 'agent' && r.name === agentName);
          expect(agent, `Agent "${agentName}" should appear in status`).toBeDefined();
          expect(agent!.deploymentState).toBe('deployed');
        },
        3,
        15000
      );
    },
    120000
  );

  it.skipIf(!canRun)(
    'invokes the deployed agent directly',
    async () => {
      await retry(
        async () => {
          const result = await run(['invoke', '--prompt', 'Say hello', '--runtime', agentName, '--json']);
          expect(result.exitCode, `Invoke failed: ${result.stderr}`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success).toBe(true);
        },
        3,
        15000
      );
    },
    180000
  );

  it.skipIf(!canRun)(
    'removes gateway targets',
    async () => {
      let result = await run(['remove', 'gateway-target', '--name', `${agentName}-prod`, '--json']);
      expect(result.exitCode, `Remove prod target failed: ${result.stderr}`).toBe(0);

      result = await run(['remove', 'gateway-target', '--name', `${agentName}-staging`, '--json']);
      expect(result.exitCode, `Remove staging target failed: ${result.stderr}`).toBe(0);
    },
    60000
  );

  it.skipIf(!canRun)(
    'removes gateway',
    async () => {
      const result = await run(['remove', 'gateway', '--name', gatewayName, '--json']);
      expect(result.exitCode, `Remove gateway failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as { success: boolean };
      expect(json.success).toBe(true);
    },
    60000
  );
});
