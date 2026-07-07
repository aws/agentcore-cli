/**
 * E2E test for an HTTP-runtime gateway hosting every deployable target type.
 *
 * A `protocolType: None` (HTTP) gateway is a superset — it can host MCP targets
 * AND the HTTP-only target types — so one gateway carries all targets:
 *
 *   http-runtime, mcp-server, lambda-function-arn, api-gateway,
 *   open-api-schema, smithy-model, connector (web-search), passthrough
 *
 * Flow: create project → ensure external prereqs (Lambda, REST API via a boto3
 *       fixture) → add gateway + credential → add every target → deploy ONE
 *       CloudFormation stack → assert the gateway and all targets are deployed →
 *       teardown.
 *
 * External resources that can't be created by `agentcore deploy` are provisioned
 * idempotently by fixtures/gateway-targets/setup_target_prereqs.py (mirrors the
 * import-resources.test.ts fixture pattern).
 *
 * `passthrough` is gated behind ENABLE_GATED_FEATURES, so the add/deploy steps
 * run with that env var set. Omits `connector` (Bedrock FMKB), a private-beta
 * CloudFormation resource type.
 *
 * Prerequisites: AWS credentials, npm, git, uv, python3 + boto3.
 */
import { hasAwsCredentials, hasCommand, parseJsonOutput, prereqs, spawnAndCollect } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, writeAwsTargets } from './e2e-helper.js';
import { deleteCredentialProvider } from './utils/credential-provider-cleanup.js';
import { getLogger } from './utils/logger.js';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'gateway-targets');

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

interface Prereqs {
  // null when the IAM role lacks permission to create the resource (restricted
  // CI roles may lack lambda:*/apigateway:*); the dependent target is then skipped.
  lambdaArn: string | null;
  restApiId: string | null;
  restApiStage: string | null;
}

describe.sequential('e2e: HTTP gateway with all target types', () => {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const suffix = Date.now().toString().slice(-8);
  const agentName = `E2eGwAll${suffix}`;
  const gatewayName = 'allgw';
  const credName = 'E2eGwCred';

  let testDir: string;
  let projectPath: string;
  let prereqsData: Prereqs;

  const run = (args: string[]) => runAgentCoreCLI(args, projectPath);
  // passthrough is gated; run add/deploy with ENABLE_GATED_FEATURES on (harmless for the others).
  const runGated = (args: string[]) => spawnAndCollect('agentcore', args, projectPath, { ENABLE_GATED_FEATURES: '1' });

  const assertAddTarget = async (args: string[], targetName: string): Promise<void> => {
    const result = await runGated(['add', 'gateway-target', '--gateway', gatewayName, '--json', ...args]);
    expect(result.exitCode, `add target ${targetName} failed: ${result.stdout}\n${result.stderr}`).toBe(0);
    const json = parseJsonOutput(result.stdout) as { success: boolean; toolName: string };
    expect(json.success, `add target ${targetName} should succeed`).toBe(true);
    expect(json.toolName).toBe(targetName);
  };

  beforeAll(async () => {
    if (!canRun) return;

    // 1. Provision external AWS resources (idempotent) and read their identifiers.
    const setup = await spawnAndCollect(
      'uv',
      ['run', '--with', 'boto3', 'python3', 'setup_target_prereqs.py'],
      fixtureDir,
      {
        AWS_REGION: region,
        RESOURCE_SUFFIX: suffix,
      }
    );
    if (setup.exitCode !== 0) {
      throw new Error(`prereq setup failed (exit ${setup.exitCode}):\n${setup.stdout}\n${setup.stderr}`);
    }
    prereqsData = JSON.parse(
      await readFile(join(fixtureDir, `gateway-target-prereqs-${suffix}.json`), 'utf-8')
    ) as Prereqs;

    // 2. Create the CLI project.
    testDir = join(tmpdir(), `agentcore-e2e-gw-all-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    const createResult = await runAgentCoreCLI(
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
    expect(createResult.exitCode, `Create failed: ${createResult.stderr}`).toBe(0);
    projectPath = (parseJsonOutput(createResult.stdout) as { projectPath: string }).projectPath;

    await writeAwsTargets(projectPath);
    installCdkTarball(projectPath);

    // 3. Copy schema fixtures into the project (add validates schema paths relative to project root).
    for (const f of ['openapi.json', 'smithy.json', 'lambda-tools.json']) {
      await copyFile(join(fixtureDir, f), join(projectPath, f));
    }
  }, 600000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await runAgentCoreCLI(['remove', 'all', '--json'], projectPath);
      const deploy = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
      if (deploy.exitCode !== 0) console.warn('Teardown deploy failed:', deploy.stderr);
      // The api-key credential provider is created by a pre-deploy SDK call, not
      // CloudFormation, so stack teardown does not reap it — delete it explicitly.
      const client = new BedrockAgentCoreControlClient({ region });
      await deleteCredentialProvider(client, getLogger('teardown-gw-all'), credName);
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600000);

  // ── Gateway + supporting resources ──────────────────────────────────────

  it.skipIf(!canRun)(
    'adds an HTTP (protocolType None) gateway',
    async () => {
      const result = await run(['add', 'gateway', '--name', gatewayName, '--protocol-type', 'None', '--json']);
      expect(result.exitCode, `add gateway failed: ${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
    },
    60000
  );

  it.skipIf(!canRun)(
    'adds an API-key credential for auth-requiring targets',
    async () => {
      const result = await run([
        'add',
        'credential',
        '--name',
        credName,
        '--type',
        'api-key',
        '--api-key',
        'e2e-dummy-key',
        '--json',
      ]);
      expect(result.exitCode, `add credential failed: ${result.stdout}`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);
    },
    60000
  );

  // ── One target of every deployable type ──────────────────────────────────

  it.skipIf(!canRun)('adds an http-runtime target', () =>
    assertAddTarget(['--name', 'tHttpRuntime', '--type', 'http-runtime', '--runtime', agentName], 'tHttpRuntime')
  );

  it.skipIf(!canRun)('adds an mcp-server target', () =>
    assertAddTarget(
      ['--name', 'tMcpServer', '--type', 'mcp-server', '--endpoint', 'https://mcp.exa.ai/mcp'],
      'tMcpServer'
    )
  );

  // Lambda + API Gateway depend on resources the fixture may not be able to create
  // under a restricted IAM role; skip the target when its prereq is absent.
  it.skipIf(!canRun)('adds a lambda-function-arn target', async ctx => {
    if (!prereqsData.lambdaArn) return ctx.skip();
    await assertAddTarget(
      [
        '--name',
        'tLambda',
        '--type',
        'lambda-function-arn',
        '--lambda-arn',
        prereqsData.lambdaArn,
        '--tool-schema-file',
        'lambda-tools.json',
      ],
      'tLambda'
    );
  });

  it.skipIf(!canRun)('adds an api-gateway target', async ctx => {
    if (!prereqsData.restApiId || !prereqsData.restApiStage) return ctx.skip();
    await assertAddTarget(
      [
        '--name',
        'tApiGw',
        '--type',
        'api-gateway',
        '--rest-api-id',
        prereqsData.restApiId,
        '--stage',
        prereqsData.restApiStage,
      ],
      'tApiGw'
    );
  });

  it.skipIf(!canRun)('adds an open-api-schema target (api-key outbound auth)', () =>
    assertAddTarget(
      [
        '--name',
        'tOpenApi',
        '--type',
        'open-api-schema',
        '--schema',
        'openapi.json',
        '--outbound-auth',
        'api-key',
        '--credential-name',
        credName,
      ],
      'tOpenApi'
    )
  );

  it.skipIf(!canRun)('adds a smithy-model target', () =>
    assertAddTarget(['--name', 'tSmithy', '--type', 'smithy-model', '--schema', 'smithy.json'], 'tSmithy')
  );

  it.skipIf(!canRun)('adds a web-search connector target', () =>
    assertAddTarget(['--name', 'tWebSearch', '--type', 'connector', '--connector', 'web-search'], 'tWebSearch')
  );

  it.skipIf(!canRun)('adds a passthrough target (gated; gateway-iam-role auth)', () =>
    assertAddTarget(
      [
        '--name',
        'tPassthrough',
        '--type',
        'passthrough',
        '--passthrough-endpoint',
        'https://example.com/mcp',
        '--passthrough-protocol',
        'MCP',
        '--outbound-auth',
        'gateway-iam-role',
        '--signing-service',
        'execute-api',
        '--signing-region',
        region,
      ],
      'tPassthrough'
    )
  );

  // ── Config sanity: every target landed in agentcore.json ─────────────────

  it.skipIf(!canRun)(
    'agentcore.json contains all added targets',
    async () => {
      const config = JSON.parse(await readFile(join(projectPath, 'agentcore', 'agentcore.json'), 'utf-8')) as {
        agentCoreGateways: { name: string; targets: { name: string; targetType: string }[] }[];
      };
      const gw = config.agentCoreGateways.find(g => g.name === gatewayName);
      expect(gw, `gateway ${gatewayName} should be in config`).toBeDefined();
      const types = new Set(gw!.targets.map(t => t.targetType));
      const expected = ['httpRuntime', 'mcpServer', 'openApiSchema', 'smithyModel', 'connector', 'passthrough'];
      // Only expected when the fixture could provision their external prereqs.
      if (prereqsData.lambdaArn) expected.push('lambdaFunctionArn');
      if (prereqsData.restApiId) expected.push('apiGateway');
      for (const t of expected) {
        expect(types.has(t), `config should contain a ${t} target`).toBe(true);
      }
    },
    30000
  );

  // ── Deploy the whole stack and verify the gateway is live ────────────────

  it.skipIf(!canRun)(
    'deploys the gateway and all targets in one stack',
    async () => {
      // No retry: a failed deploy can leave the CFN stack mid-rollback /
      // REVIEW_IN_PROGRESS, and an immediate second deploy fails differently
      // (masking the real error). One deploy, long timeout, surface the failure.
      const result = await runGated(['deploy', '--yes', '--json']);
      if (result.exitCode !== 0) {
        console.log('Deploy stdout:', result.stdout);
        console.log('Deploy stderr:', result.stderr);
      }
      expect(result.exitCode, `Deploy failed (stderr: ${result.stderr})`).toBe(0);
      expect((parseJsonOutput(result.stdout) as { success: boolean }).success).toBe(true);

      // deployed-state.json should record a gateway with an id.
      const state = JSON.parse(
        await readFile(join(projectPath, 'agentcore', '.cli', 'deployed-state.json'), 'utf-8')
      ) as {
        targets: Record<
          string,
          {
            resources?: {
              gateways?: Record<string, { gatewayId?: string }>;
              mcp?: { gateways?: Record<string, { gatewayId?: string }> };
            };
          }
        >;
      };
      const gateways = Object.values(state.targets).flatMap(t => [
        ...Object.values(t.resources?.gateways ?? {}),
        ...Object.values(t.resources?.mcp?.gateways ?? {}),
      ]);
      expect(gateways.length, 'a gateway should be in deployed state').toBeGreaterThan(0);
      expect(gateways[0]!.gatewayId, 'deployed gateway should have an id').toBeTruthy();
    },
    900000
  );

  it.skipIf(!canRun)(
    'status reports the gateway as deployed',
    async () => {
      const result = await run(['status', '--json']);
      expect(result.exitCode, `status failed: ${result.stderr}`).toBe(0);
      const json = parseJsonOutput(result.stdout) as {
        success: boolean;
        resources: { resourceType: string; name: string; deploymentState: string }[];
      };
      expect(json.success).toBe(true);
      const gw = json.resources.find(r => r.resourceType === 'gateway' && r.name === gatewayName);
      expect(gw, `gateway ${gatewayName} should appear in status`).toBeDefined();
      expect(gw!.deploymentState).toBe('deployed');
    },
    120000
  );
});
