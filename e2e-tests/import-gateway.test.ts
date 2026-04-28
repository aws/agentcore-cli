import {
  type RunResult,
  hasAwsCredentials,
  hasCommand,
  parseJsonOutput,
  prereqs,
  spawnAndCollect,
  stripAnsi,
} from '../src/test-utils/index.js';
import { dumpImportDebugInfo, installCdkTarball, runAgentCoreCLI, writeAwsTargets } from './e2e-helper.js';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const hasPython =
  hasCommand('python3') &&
  (() => {
    try {
      execSync('uv run --with boto3 python3 -c "import boto3"', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
const canRun = prereqs.npm && prereqs.git && prereqs.uv && hasAws && hasPython;

describe.sequential('e2e: import gateway', () => {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const fixtureDir = join(__dirname, 'fixtures', 'import');
  const suffix = Date.now().toString().slice(-8);
  const agentName = `E2eGw${suffix}`;

  let gatewayArn: string;
  let projectPath: string;
  let testDir: string;

  beforeAll(async () => {
    if (!canRun) return;

    const result = await spawnAndCollect('uv', ['run', '--with', 'boto3', 'python3', 'setup_gateway.py'], fixtureDir, {
      AWS_REGION: region,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `setup_gateway.py failed (exit ${result.exitCode}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
      );
    }

    const resourcesPath = join(fixtureDir, 'bugbash-resources.json');
    const resources = JSON.parse(await readFile(resourcesPath, 'utf-8')) as Record<string, { arn: string; id: string }>;
    gatewayArn = resources.gateway!.arn;

    testDir = join(tmpdir(), `agentcore-e2e-import-gw-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const createResult = await runAgentCoreCLI(
      ['create', '--name', agentName, '--no-agent', '--defaults', '--skip-git', '--skip-python-setup', '--json'],
      testDir
    );
    expect(createResult.exitCode, `Create failed: ${createResult.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(createResult.stdout) as { projectPath: string }).projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 600_000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await runAgentCoreCLI(['remove', 'all', '--json'], projectPath);
      const deployResult = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
      if (deployResult.exitCode !== 0) {
        console.warn('Teardown deploy failed:', deployResult.stderr);
      }
    }

    try {
      await spawnAndCollect('uv', ['run', '--with', 'boto3', 'python3', 'cleanup_resources.py'], fixtureDir, {
        AWS_REGION: region,
      });
    } catch {
      /* ignore — resources may already be deleted by CFN teardown */
    }

    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600_000);

  const run = (args: string[]): Promise<RunResult> => runAgentCoreCLI(args, projectPath);
  const stackName = `AgentCore-${agentName}-default`;

  // ── Import test ───────────────────────────────────────────────────

  it.skipIf(!canRun)(
    'imports a gateway by ARN',
    async () => {
      const result = await run(['import', 'gateway', '--arn', gatewayArn]);

      if (result.exitCode !== 0) {
        await dumpImportDebugInfo('gateway', result, projectPath, stackName, region);
      }

      expect(result.exitCode, `Import gateway failed: ${result.stderr}`).toBe(0);
      expect(stripAnsi(result.stdout).toLowerCase()).toContain('imported successfully');
    },
    600_000
  );

  // ── Verification tests ────────────────────────────────────────────

  it.skipIf(!canRun)(
    'status shows imported gateway as deployed',
    async () => {
      const result = await run(['status', '--json']);

      expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      const gateway = json.resources.find(r => r.resourceType === 'gateway');
      expect(gateway, 'Imported gateway should appear in status').toBeDefined();
    },
    120_000
  );

  it.skipIf(!canRun)(
    'agentcore.json has correct gateway fields',
    async () => {
      const configPath = join(projectPath, 'agentcore', 'agentcore.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as {
        agentCoreGateways: {
          name: string;
          resourceName?: string;
          description?: string;
          authorizerType: string;
          enableSemanticSearch: boolean;
          exceptionLevel: string;
          executionRoleArn?: string;
          tags?: Record<string, string>;
          targets: { name: string; targetType: string; endpoint?: string }[];
        }[];
      };

      expect(config.agentCoreGateways.length, 'Should have one gateway').toBe(1);
      const gw = config.agentCoreGateways[0]!;

      expect(gw.name, 'Gateway name should be set').toBeTruthy();
      expect(gw.resourceName, 'resourceName should preserve AWS name').toBeTruthy();
      expect(gw.description).toBe('Bugbash gateway for import testing');
      expect(gw.authorizerType).toBe('NONE');
      expect(gw.enableSemanticSearch).toBe(true);
      expect(gw.exceptionLevel).toBe('DEBUG');
      expect(gw.tags).toEqual({ env: 'bugbash', team: 'agentcore-cli' });

      expect(gw.executionRoleArn, 'executionRoleArn should be preserved from AWS').toBeTruthy();
      expect(gw.executionRoleArn).toContain('bugbash-agentcore-role');

      expect(gw.targets.length, 'Should have one target').toBe(1);
      expect(gw.targets[0]!.name).toBe('mcpTarget');
      expect(gw.targets[0]!.targetType).toBe('mcpServer');
      expect(gw.targets[0]!.endpoint).toBe('https://mcp.exa.ai/mcp');
    },
    120_000
  );

  it.skipIf(!canRun)(
    'deployed-state.json has gateway entry',
    async () => {
      const statePath = join(projectPath, 'agentcore', '.cli', 'deployed-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;

      const targets = state.targets as Record<string, { resources?: { mcp?: { gateways?: Record<string, unknown> } } }>;
      const targetEntries = Object.values(targets);
      expect(targetEntries.length).toBeGreaterThan(0);

      const firstTarget = targetEntries[0]!;
      const gateways = firstTarget.resources?.mcp?.gateways;
      expect(gateways, 'deployed-state should have mcp.gateways entry').toBeDefined();

      const gatewayEntries = Object.values(gateways!);
      expect(gatewayEntries.length, 'Should have one gateway in deployed state').toBe(1);

      const gwState = gatewayEntries[0] as { gatewayId?: string; gatewayArn?: string };
      expect(gwState.gatewayId, 'Gateway ID should be recorded').toBeTruthy();
    },
    120_000
  );
});
