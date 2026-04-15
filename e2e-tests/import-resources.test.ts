import { DEFAULT_MODEL as DEFAULT_EVALUATOR_MODEL } from '../src/cli/tui/screens/evaluator/types.js';
import {
  type RunResult,
  hasAwsCredentials,
  hasCommand,
  parseJsonOutput,
  prereqs,
  retry,
  spawnAndCollect,
  stripAnsi,
} from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, writeAwsTargets } from './e2e-helper.js';
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

describe.sequential('e2e: import runtime/memory/evaluator/gateway', () => {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const fixtureDir = join(__dirname, 'fixtures', 'import');
  const appDir = join(fixtureDir, 'app');
  const suffix = Date.now().toString().slice(-8);
  const agentName = `E2eImp${suffix}`;

  let runtimeArn: string;
  let memoryArn: string;
  let evaluatorArn: string;
  let gatewayArn: string;
  let projectPath: string;
  let testDir: string;

  beforeAll(async () => {
    if (!canRun) return;

    // 1. Run Python setup scripts to create AWS resources via API.
    //    Each script creates a resource and saves its ARN/ID to bugbash-resources.json.
    //    Scripts run sequentially because save_resource() does a read-modify-write
    //    on a shared bugbash-resources.json file — parallel runs would race.
    for (const script of ['setup_runtime_basic.py', 'setup_memory_full.py', 'setup_evaluator.py', 'setup_gateway.py']) {
      const result = await spawnAndCollect('uv', ['run', '--with', 'boto3', 'python3', script], fixtureDir, {
        AWS_REGION: region,
        DEFAULT_EVALUATOR_MODEL,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `${script} failed (exit ${result.exitCode}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
        );
      }
    }

    // 2. Read resource ARNs from bugbash-resources.json
    const resourcesPath = join(fixtureDir, 'bugbash-resources.json');
    const resources = JSON.parse(await readFile(resourcesPath, 'utf-8')) as Record<string, { arn: string; id: string }>;
    runtimeArn = resources['runtime-basic']!.arn;
    memoryArn = resources['memory-full']!.arn;
    evaluatorArn = resources['evaluator-llm']!.arn;
    gatewayArn = resources.gateway!.arn;

    // 3. Create a destination CLI project (no agent — we'll import one)
    testDir = join(tmpdir(), `agentcore-e2e-import-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    const result = await runAgentCoreCLI(
      ['create', '--name', agentName, '--no-agent', '--defaults', '--skip-git', '--skip-python-setup', '--json'],
      testDir
    );
    expect(result.exitCode, `Create failed: ${result.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(result.stdout) as { projectPath: string }).projectPath;

    // 4. Configure deployment target + CDK
    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);
  }, 600_000);

  // Note: we don't use teardownE2EProject() here because import tests need
  // extra cleanup — the Python fallback script deletes resources that weren't
  // successfully imported into CloudFormation, and cleans up S3 code objects.
  afterAll(async () => {
    // 1. Tear down CFN stack created by import (this deletes all imported resources)
    if (projectPath && hasAws) {
      await runAgentCoreCLI(['remove', 'all', '--json'], projectPath);
      const deployResult = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
      if (deployResult.exitCode !== 0) {
        console.warn('Teardown deploy failed:', deployResult.stderr);
      }
    }

    // 2. Fallback: delete any resources that weren't imported into CFN
    try {
      await spawnAndCollect('uv', ['run', '--with', 'boto3', 'python3', 'cleanup_resources.py'], fixtureDir, {
        AWS_REGION: region,
      });
    } catch {
      /* ignore — resources may already be deleted by CFN teardown */
    }

    // 3. Clean up temp directory
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600_000);

  const run = (args: string[]): Promise<RunResult> => runAgentCoreCLI(args, projectPath);

  // ── Import tests ──────────────────────────────────────────────────

  it.skipIf(!canRun)(
    'imports a runtime by ARN',
    async () => {
      const result = await run(['import', 'runtime', '--arn', runtimeArn, '--code', appDir, '--name', agentName, '-y']);

      if (result.exitCode !== 0) {
        console.log('Import runtime stdout:', result.stdout);
        console.log('Import runtime stderr:', result.stderr);
      }

      expect(result.exitCode, `Import runtime failed: ${result.stderr}`).toBe(0);
      expect(stripAnsi(result.stdout).toLowerCase()).toContain('imported successfully');
    },
    600_000
  );

  it.skipIf(!canRun)(
    'imports a memory by ARN',
    async () => {
      const result = await run(['import', 'memory', '--arn', memoryArn, '-y']);

      if (result.exitCode !== 0) {
        console.log('Import memory stdout:', result.stdout);
        console.log('Import memory stderr:', result.stderr);
      }

      expect(result.exitCode, `Import memory failed: ${result.stderr}`).toBe(0);
      expect(stripAnsi(result.stdout).toLowerCase()).toContain('imported successfully');
    },
    600_000
  );

  it.skipIf(!canRun)(
    'imports an evaluator by ARN',
    async () => {
      const result = await run(['import', 'evaluator', '--arn', evaluatorArn]);

      if (result.exitCode !== 0) {
        console.log('Import evaluator stdout:', result.stdout);
        console.log('Import evaluator stderr:', result.stderr);
      }

      expect(result.exitCode, `Import evaluator failed: ${result.stderr}`).toBe(0);
      expect(stripAnsi(result.stdout).toLowerCase()).toContain('imported successfully');
    },
    600_000
  );

  it.skipIf(!canRun)(
    'imports a gateway by ARN',
    async () => {
      const result = await run(['import', 'gateway', '--arn', gatewayArn]);

      if (result.exitCode !== 0) {
        console.log('Import gateway stdout:', result.stdout);
        console.log('Import gateway stderr:', result.stderr);
      }

      expect(result.exitCode, `Import gateway failed: ${result.stderr}`).toBe(0);
      expect(stripAnsi(result.stdout).toLowerCase()).toContain('imported successfully');
    },
    600_000
  );

  // ── Verification tests ────────────────────────────────────────────

  it.skipIf(!canRun)(
    'status shows all imported resources as deployed',
    async () => {
      const result = await run(['status', '--json']);

      expect(result.exitCode, `Status failed: ${result.stderr}`).toBe(0);

      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);

      const agent = json.resources.find(r => r.resourceType === 'agent');
      expect(agent, 'Imported runtime should appear in status').toBeDefined();
      expect(agent!.deploymentState).toBe('deployed');

      const memory = json.resources.find(r => r.resourceType === 'memory');
      expect(memory, 'Imported memory should appear in status').toBeDefined();

      const evaluator = json.resources.find(r => r.resourceType === 'evaluator');
      expect(evaluator, 'Imported evaluator should appear in status').toBeDefined();

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

      // Gateway state is stored under targets.<targetName>.resources.mcp.gateways
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

  it.skipIf(!canRun)(
    'invokes the imported runtime',
    async () => {
      await retry(
        async () => {
          const result = await run(['invoke', '--prompt', 'Say hello', '--runtime', agentName, '--json']);

          if (result.exitCode !== 0) {
            console.log('Invoke stdout:', result.stdout);
            console.log('Invoke stderr:', result.stderr);
          }

          expect(result.exitCode, `Invoke failed: ${result.stderr}`).toBe(0);

          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success, 'Invoke should report success').toBe(true);
        },
        3,
        15_000
      );
    },
    180_000
  );
});
