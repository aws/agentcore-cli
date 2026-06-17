import { promoteABTestConfig } from '../src/cli/operations/jobs/ab-test/promote.js';
import type { ABTestJobRecord } from '../src/cli/operations/jobs/shared/types.js';
import { ConfigIO } from '../src/lib';
import { type TestProject, createTestProject } from '../src/test-utils/index.js';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration coverage for A/B-test promotion against a REAL on-disk agentcore.json.
 *
 * Unit tests mock ConfigIO; here promote does the genuine read → mutate → write → re-validate
 * round-trip through ConfigIO + the Zod schema, so a malformed write (e.g. an httpRuntime shape the
 * schema rejects) would surface as a real failure. Covers the "promote everything" paths:
 *   - version-bump (same runtime, named endpoints)
 *   - repoint to a different runtime
 *   - repoint when the default (unnamed) endpoint is used
 *
 * promoteABTestConfig() constructs `new ConfigIO()` internally, which discovers the project via
 * INIT_CWD/cwd — so each test points INIT_CWD at the temp project before calling it.
 */
describe('integration: ab-test promote (real config round-trip)', () => {
  let project: TestProject;
  let configIO: ConfigIO;
  const originalInitCwd = process.env.INIT_CWD;

  beforeAll(async () => {
    project = await createTestProject({
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
    // promote()'s internal `new ConfigIO()` resolves the project from INIT_CWD (walks up to the
    // agentcore/ dir). The explicit ConfigIO below needs the agentcore/ dir as its baseDir.
    process.env.INIT_CWD = project.projectPath;
    configIO = new ConfigIO({ baseDir: join(project.projectPath, 'agentcore') });
  });

  afterAll(async () => {
    if (originalInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = originalInitCwd;
    await project.cleanup();
  });

  // Build N schema-valid runtimes by cloning the project's real runtime (so build/entrypoint/etc.
  // satisfy the Zod schema) and overriding name + endpoints.
  async function makeRuntimes(
    specs: { name: string; endpoints: Record<string, { version: number }> }[]
  ): Promise<unknown[]> {
    const spec = await configIO.readProjectSpec();
    const base = spec.runtimes[0];
    return specs.map(s => ({ ...base, name: s.name, endpoints: s.endpoints }));
  }

  // Each test rewrites the runtimes + gateway from scratch so cases don't bleed into each other.
  // httpRuntime targets require the gateway to have protocolType: "None".
  async function seedProject(runtimes: unknown[], targets: unknown[]): Promise<void> {
    const spec = await configIO.readProjectSpec();
    const next = {
      ...spec,
      runtimes,
      agentCoreGateways: [{ name: 'my-gw', protocolType: 'None', targets }],
    };
    await configIO.writeProjectSpec(next as never);
  }

  function record(): ABTestJobRecord {
    return {
      type: 'ab-test',
      id: 'ab-integ',
      arn: 'arn:aws:bedrock-agentcore:us-east-1:1:ab-test/ab-integ',
      status: 'STOPPED',
      lifecycleStatus: 'STOPPED',
      createdAt: '2026-01-01T00:00:00Z',
      agent: 'my-agent',
      name: 'integTest',
      mode: 'target-based',
      gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:1:gateway/my-gw',
      gatewayName: 'my-gw',
      variants: [
        { name: 'C', weight: 50, targetName: 'ctrl-target' },
        { name: 'T1', weight: 50, targetName: 'treat-target' },
      ],
      evaluationConfig: { onlineEvaluationConfigArn: 'arn:aws:eval:config' },
    };
  }

  it('version-bumps control to the treatment endpoint version (same runtime)', async () => {
    await seedProject(
      await makeRuntimes([{ name: 'my_runtime', endpoints: { control: { version: 1 }, treatment: { version: 7 } } }]),
      [
        {
          name: 'ctrl-target',
          targetType: 'httpRuntime',
          httpRuntime: { runtime: 'my_runtime', runtimeEndpoint: 'control' },
        },
        {
          name: 'treat-target',
          targetType: 'httpRuntime',
          httpRuntime: { runtime: 'my_runtime', runtimeEndpoint: 'treatment' },
        },
      ]
    );

    const result = await promoteABTestConfig(record());
    expect(result.promoted).toBe(true);

    const after = await configIO.readProjectSpec();
    const rt = after.runtimes.find(r => r.name === 'my_runtime')!;
    expect(rt.endpoints?.control?.version).toBe(7);
  });

  it('repoints control to a different treatment runtime', async () => {
    await seedProject(
      await makeRuntimes([
        { name: 'runtime_a', endpoints: { prod: { version: 1 } } },
        { name: 'runtime_b', endpoints: { prod: { version: 5 } } },
      ]),
      [
        {
          name: 'ctrl-target',
          targetType: 'httpRuntime',
          httpRuntime: { runtime: 'runtime_a', runtimeEndpoint: 'prod' },
        },
        {
          name: 'treat-target',
          targetType: 'httpRuntime',
          httpRuntime: { runtime: 'runtime_b', runtimeEndpoint: 'prod' },
        },
      ]
    );

    const result = await promoteABTestConfig(record());
    expect(result.promoted).toBe(true);

    const after = await configIO.readProjectSpec();
    const ctrl = after.agentCoreGateways!.find(g => g.name === 'my-gw')!.targets!.find(t => t.name === 'ctrl-target')!;
    expect(ctrl.httpRuntime!.runtime).toBe('runtime_b');
    expect(ctrl.httpRuntime!.runtimeEndpoint).toBe('prod');
  });

  it('repoints control when variants use the default (unnamed) endpoint', async () => {
    await seedProject(
      await makeRuntimes([
        { name: 'runtime_a', endpoints: {} },
        { name: 'runtime_b', endpoints: {} },
      ]),
      [
        { name: 'ctrl-target', targetType: 'httpRuntime', httpRuntime: { runtime: 'runtime_a' } },
        { name: 'treat-target', targetType: 'httpRuntime', httpRuntime: { runtime: 'runtime_b' } },
      ]
    );

    const result = await promoteABTestConfig(record());
    expect(result.promoted).toBe(true);

    const after = await configIO.readProjectSpec();
    const ctrl = after.agentCoreGateways!.find(g => g.name === 'my-gw')!.targets!.find(t => t.name === 'ctrl-target')!;
    expect(ctrl.httpRuntime!.runtime).toBe('runtime_b');
  });
});
