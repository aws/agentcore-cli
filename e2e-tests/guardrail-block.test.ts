import { type RunResult, hasAwsCredentials, parseJsonOutput, prereqs, retry } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, writeAwsTargets } from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();

// The AWS::BedrockAgentCore::Policy CFN resource type is not yet generally
// released, so `agentcore deploy` cannot synth/provision the policy and this
// end-to-end suite cannot pass. Skip the whole suite until the resource type
// is released, then drop SUITE_DISABLED to re-enable.
const SUITE_DISABLED = true;
const canRun = !SUITE_DISABLED && prereqs.npm && prereqs.git && prereqs.uv && hasAws;

/**
 * e2e: policy engine blocks a gateway invoke via CFN-deployed forbid policy.
 *
 * This test manually wires what the (removed) "secure mode" used to do automatically:
 *   1. create a Strands/Bedrock project (agent runtime)
 *   2. add a Cedar policy engine
 *   3. add a gateway referencing the engine in ENFORCE mode (authorizer AWS_IAM)
 *   4. add an http-runtime gateway target pointing at the agent runtime
 *   5. add a blanket forbid policy scoped to AgentCore::Gateway
 *   6. deploy via CFN (runtime + gateway + engine + policy all provisioned)
 *   7. invoke through the gateway — assert the request is BLOCKED (403)
 *
 * The blanket `forbid(principal, action, resource is AgentCore::Gateway);` policy blocks ALL
 * requests through the gateway, proving the policy engine ENFORCE mechanism works end-to-end.
 */
describe.skipIf(!canRun).sequential('e2e: policy engine blocks gateway invoke', () => {
  const suffix = Date.now().toString().slice(-8);
  const agentName = `E2eGrd${suffix}`;
  const gatewayName = 'grdgw';
  const targetName = 'grdtarget';
  const engineName = 'grdengine';
  const policyName = 'denyall';

  let projectPath: string;
  let testDir: string;

  beforeAll(async () => {
    if (!canRun) return;

    testDir = join(tmpdir(), `agentcore-e2e-guardrail-${randomUUID()}`);
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
  }, 600_000);

  afterAll(async () => {
    if (projectPath && hasAws) {
      await runAgentCoreCLI(['remove', 'all', '--json'], projectPath);
      const deployResult = await runAgentCoreCLI(['deploy', '--yes', '--json'], projectPath);
      if (deployResult.exitCode !== 0) {
        console.warn('Teardown deploy failed:', deployResult.stderr);
      }
    }
    if (testDir) await rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
  }, 600_000);

  const run = (args: string[]): Promise<RunResult> => runAgentCoreCLI(args, projectPath);

  const assertSuccess = (result: RunResult, label: string): void => {
    expect(result.exitCode, `${label} failed: ${result.stderr}`).toBe(0);
    const json = parseJsonOutput(result.stdout) as { success: boolean };
    expect(json.success, `${label} should report success`).toBe(true);
  };

  // ── Manual wiring (the steps secure mode used to perform) ─────────────

  it.skipIf(!canRun)(
    'adds a policy engine',
    async () => {
      const result = await run(['add', 'policy-engine', '--name', engineName, '--json']);
      assertSuccess(result, 'add policy-engine');
    },
    60_000
  );

  it.skipIf(!canRun)(
    'adds a gateway referencing the policy engine in ENFORCE mode',
    async () => {
      const result = await run([
        'add',
        'gateway',
        '--name',
        gatewayName,
        '--protocol-type',
        'None',
        '--authorizer-type',
        'AWS_IAM',
        '--policy-engine',
        engineName,
        '--policy-engine-mode',
        'ENFORCE',
        '--json',
      ]);
      assertSuccess(result, 'add gateway');
    },
    60_000
  );

  it.skipIf(!canRun)(
    'adds an http-runtime target pointing at the agent runtime',
    async () => {
      const result = await run([
        'add',
        'gateway-target',
        '--name',
        targetName,
        '--gateway',
        gatewayName,
        '--type',
        'http-runtime',
        '--runtime',
        agentName,
        '--json',
      ]);
      assertSuccess(result, 'add gateway-target');
    },
    60_000
  );

  it.skipIf(!canRun)(
    'adds a forbid-all policy scoped to AgentCore::Gateway',
    async () => {
      const result = await run([
        'add',
        'policy',
        '--name',
        policyName,
        '--engine',
        engineName,
        '--statement',
        'forbid(principal, action, resource is AgentCore::Gateway);',
        '--validation-mode',
        'IGNORE_ALL_FINDINGS',
        '--json',
      ]);
      assertSuccess(result, 'add policy');
    },
    60_000
  );

  // ── Deploy via CFN ────────────────────────────────────────────────────

  it.skipIf(!canRun)(
    'deploys runtime + gateway + policy engine + policy via CFN',
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
          expect(json.success, 'Deploy should report success').toBe(true);
        },
        2,
        30_000
      );

      // Confirm the gateway is deployed
      const statePath = join(projectPath, 'agentcore', '.cli', 'deployed-state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as {
        targets: Record<string, { resources?: { gateways?: Record<string, { gatewayId?: string }> } }>;
      };
      const gateways = Object.values(state.targets).flatMap(t => Object.values(t.resources?.gateways ?? {}));
      expect(gateways.length, 'Gateway should be present in deployed state').toBeGreaterThan(0);
      expect(gateways[0]!.gatewayId, 'Gateway should have an ID').toBeTruthy();
    },
    600_000
  );

  // ── Invoke through the gateway ──────────────────────────────────────────

  it.skipIf(!canRun)(
    'invoke through the gateway is blocked by the forbid-all policy',
    async () => {
      await retry(
        async () => {
          const result = await run([
            'invoke',
            '--gateway',
            gatewayName,
            '--gateway-target-name',
            targetName,
            '--prompt',
            '{"message": "hello"}',
            '--json',
          ]);

          console.log('Policy-blocked invoke stdout:', result.stdout);
          console.log('Policy-blocked invoke stderr:', result.stderr);

          const json = parseJsonOutput(result.stdout) as { success: boolean; error?: string };
          expect(json.success, `Invoke should be blocked but got: ${JSON.stringify(json)}`).toBe(false);
          expect(json.error, 'Block error message should be present').toBeTruthy();
          expect(json.error!, `Error should indicate policy denial, got: ${json.error}`).toMatch(/denied|policy|403/i);
        },
        3,
        15_000
      );
    },
    180_000
  );
});
