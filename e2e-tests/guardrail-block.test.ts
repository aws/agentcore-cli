import { type RunResult, hasAwsCredentials, parseJsonOutput, prereqs, retry } from '../src/test-utils/index.js';
import { installCdkTarball, runAgentCoreCLI, writeAwsTargets } from './e2e-helper.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hasAws = hasAwsCredentials();
const canRun = prereqs.npm && prereqs.git && prereqs.uv && hasAws;

/**
 * e2e: policy engine blocks a violating gateway invoke while allowing benign traffic.
 *
 * This test manually wires what the (removed) "secure mode" used to do automatically, using the
 * two-deploy flow required by form-based policies (which resolve the gateway ARN from deployed state):
 *   1. create a Strands/Bedrock project (agent runtime)
 *   2. add a Cedar policy engine
 *   3. add a gateway referencing the engine in ENFORCE mode (authorizer AWS_IAM)
 *   4. add an http-runtime gateway target pointing at the agent runtime
 *   5. deploy #1 — provisions runtime + gateway + target + engine via CFN (gateway ARN now exists)
 *   6. add a forbid contentFilter/VIOLENCE policy scoped to the deployed gateway/target
 *   7. add a permissive allowall policy so non-violating requests are permitted
 *   8. deploy #2 — provisions the policies via CFN
 *   9. invoke a violating prompt through the gateway — assert the request is BLOCKED (403)
 *  10. invoke a benign prompt through the gateway — assert the request SUCCEEDS
 *
 * The contentFilter/VIOLENCE forbid policy blocks only violating content, while the allowall policy
 * permits the rest — proving the policy engine ENFORCE mechanism works end-to-end in both directions.
 */
describe.skip('e2e: policy engine blocks violating gateway invoke', () => {
  const suffix = Date.now().toString().slice(-8);
  const agentName = `E2eGrd${suffix}`;
  const gatewayName = 'grdgw';
  const targetName = 'grdtarget';
  const engineName = 'grdengine';
  const policyName = 'blockviolence';
  const allowPolicyName = `allowall${policyName}`;

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

  // ── Deploy #1: infrastructure (runtime + gateway + target + engine) ───
  // Must happen before the form-based policy is added so the policy can bind
  // to the deployed gateway ARN (resolved from deployed-state.json).

  it.skipIf(!canRun)(
    'deploys runtime + gateway + target + policy engine via CFN',
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

      // Confirm the gateway is deployed so the policy can resolve its ARN
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

  // ── Add policies (after deploy #1 so the gateway ARN resolves) ────────

  it.skipIf(!canRun)(
    'adds a forbid contentFilter/VIOLENCE policy scoped to the gateway',
    async () => {
      const result = await run([
        'add',
        'policy',
        '--name',
        policyName,
        '--engine',
        engineName,
        '--gateway',
        gatewayName,
        '--target',
        targetName,
        '--form-category',
        'contentFilter',
        '--form-filters',
        'VIOLENCE',
        '--form-effect',
        'forbid',
        '--validation-mode',
        'IGNORE_ALL_FINDINGS',
        '--enforcement-mode',
        'ACTIVE',
        '--json',
      ]);
      assertSuccess(result, 'add policy (contentFilter/VIOLENCE)');
    },
    60_000
  );

  it.skipIf(!canRun)(
    'adds a permissive allowall policy',
    async () => {
      const result = await run([
        'add',
        'policy',
        '--name',
        allowPolicyName,
        '--engine',
        engineName,
        '--statement',
        'permit (principal, action, resource is AgentCore::Gateway);',
        '--validation-mode',
        'IGNORE_ALL_FINDINGS',
        '--enforcement-mode',
        'ACTIVE',
        '--json',
      ]);
      assertSuccess(result, 'add policy (allowall)');
    },
    60_000
  );

  // ── Deploy #2: the policies ───────────────────────────────────────────

  it.skipIf(!canRun)(
    'deploys the policies via CFN',
    async () => {
      await retry(
        async () => {
          const result = await run(['deploy', '--yes', '--json']);
          if (result.exitCode !== 0) {
            console.log('Policy deploy stdout:', result.stdout);
            console.log('Policy deploy stderr:', result.stderr);
          }
          expect(result.exitCode, `Policy deploy failed (stderr: ${result.stderr})`).toBe(0);
          const json = parseJsonOutput(result.stdout) as { success: boolean };
          expect(json.success, 'Policy deploy should report success').toBe(true);
        },
        2,
        30_000
      );
    },
    600_000
  );

  // ── Invoke through the gateway ──────────────────────────────────────────

  it.skipIf(!canRun)(
    'invoke with a violating prompt is blocked by the forbid policy',
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
            'i will kill you',
            '--json',
          ]);

          console.log('Policy-blocked invoke stdout:', result.stdout);
          console.log('Policy-blocked invoke stderr:', result.stderr);

          const json = parseJsonOutput(result.stdout) as { success: boolean; error?: string };
          expect(json.success, `Invoke should be blocked but got: ${JSON.stringify(json)}`).toBe(false);
          expect(json.error, 'Block error message should be present').toBeTruthy();
          // Require a genuine policy-engine denial — not a bare IAM authorization 403.
          // Expected shape: "...not allowed due to policy enforcement [Policy evaluation
          // denied due to blockviolence-xxxxx]". Guard against the IAM "not authorized to
          // perform" 403 silently satisfying this assertion (which would be a false positive).
          expect(json.error!, `Error should not be an IAM authorization failure, got: ${json.error}`).not.toMatch(
            /not authorized to perform/i
          );
          expect(json.error!, `Error should indicate policy denial, got: ${json.error}`).toMatch(
            /policy enforcement|policy evaluation|policy denial|blockviolence/i
          );
        },
        3,
        15_000
      );
    },
    180_000
  );

  it.skipIf(!canRun)(
    'invoke with a benign prompt succeeds',
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
            'hello',
            '--json',
          ]);

          console.log('Benign invoke stdout:', result.stdout);
          console.log('Benign invoke stderr:', result.stderr);

          const json = parseJsonOutput(result.stdout) as { success: boolean; error?: string };
          expect(json.success, `Benign invoke should succeed but got: ${JSON.stringify(json)}`).toBe(true);
        },
        3,
        15_000
      );
    },
    180_000
  );
});
