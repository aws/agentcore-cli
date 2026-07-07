import type { ConfigIO } from '../../../../lib';
import type { AgentCoreProjectSpec, HarnessSpec } from '../../../../schema';
import { backfillContainerVpcIds } from '../backfill-vpc-id';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockResolveVpcId } = vi.hoisted(() => ({ mockResolveVpcId: vi.fn() }));

vi.mock('../../../commands/shared/vpc-utils', async () => {
  const actual = await vi.importActual<typeof import('../../../commands/shared/vpc-utils')>(
    '../../../commands/shared/vpc-utils'
  );
  return { ...actual, resolveVpcIdFromSubnets: (...args: unknown[]) => mockResolveVpcId(...args) };
});

function makeConfigIO(overrides: Partial<ConfigIO> = {}): {
  configIO: ConfigIO;
  writeProjectSpec: ReturnType<typeof vi.fn>;
  writeHarnessSpec: ReturnType<typeof vi.fn>;
  harnessSpecs: Record<string, HarnessSpec>;
} {
  const harnessSpecs: Record<string, HarnessSpec> = {};
  const writeProjectSpec = vi.fn().mockResolvedValue(undefined);
  const writeHarnessSpec = vi.fn().mockImplementation((name: string, data: HarnessSpec) => {
    harnessSpecs[name] = data;
    return Promise.resolve();
  });
  const configIO = {
    writeProjectSpec,
    writeHarnessSpec,
    readHarnessSpec: (name: string) => Promise.resolve(harnessSpecs[name]),
    // Path getters are part of the real ConfigIO interface; snapshot() calls them on the preview
    // (persist=false) path. Stub them so the mock matches the interface even for persist=true tests.
    getAgentConfigPath: () => '/tmp/mock-agentcore.json',
    getHarnessConfigPath: (name: string) => `/tmp/mock-${name}.json`,
    ...overrides,
  } as unknown as ConfigIO;
  return { configIO, writeProjectSpec, writeHarnessSpec, harnessSpecs };
}

function containerVpcRuntime(overrides: Record<string, unknown> = {}) {
  return {
    name: 'agent1',
    build: 'Container',
    entrypoint: 'main.py',
    codeLocation: './agents/agent1',
    networkMode: 'VPC',
    networkConfig: { subnets: ['subnet-0000000000000000a'], securityGroups: ['sg-0000000000000000a'] },
    ...overrides,
  };
}

describe('backfillContainerVpcIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveVpcId.mockResolvedValue('vpc-0123456789abcdef0');
  });

  it('backfills + persists vpcId for a Container+VPC runtime missing it', async () => {
    const runtime = containerVpcRuntime();
    const spec = { name: 'proj', runtimes: [runtime], harnesses: [] } as unknown as AgentCoreProjectSpec;
    const { configIO, writeProjectSpec } = makeConfigIO();

    const result = await backfillContainerVpcIds(configIO, spec, 'us-east-1');

    expect(mockResolveVpcId).toHaveBeenCalledWith(['subnet-0000000000000000a'], 'us-east-1');
    expect((runtime.networkConfig as { vpcId?: string }).vpcId).toBe('vpc-0123456789abcdef0');
    expect(writeProjectSpec).toHaveBeenCalledOnce();
    expect(result.backfilled).toEqual(['agent1']);
  });

  it('is a no-op when vpcId is already present (fresh create)', async () => {
    const runtime = containerVpcRuntime({
      networkConfig: {
        subnets: ['subnet-0000000000000000a'],
        securityGroups: ['sg-0000000000000000a'],
        vpcId: 'vpc-aaaaaaaa',
      },
    });
    const spec = { name: 'proj', runtimes: [runtime], harnesses: [] } as unknown as AgentCoreProjectSpec;
    const { configIO, writeProjectSpec } = makeConfigIO();

    const result = await backfillContainerVpcIds(configIO, spec, 'us-east-1');

    expect(mockResolveVpcId).not.toHaveBeenCalled();
    expect(writeProjectSpec).not.toHaveBeenCalled();
    expect(result.backfilled).toEqual([]);
  });

  it('does not touch a CodeZip+VPC runtime (no CodeBuild → no vpcId needed)', async () => {
    const runtime = containerVpcRuntime({ build: 'CodeZip' });
    const spec = { name: 'proj', runtimes: [runtime], harnesses: [] } as unknown as AgentCoreProjectSpec;
    const { configIO, writeProjectSpec } = makeConfigIO();

    const result = await backfillContainerVpcIds(configIO, spec, 'us-east-1');

    expect(mockResolveVpcId).not.toHaveBeenCalled();
    expect(writeProjectSpec).not.toHaveBeenCalled();
    expect(result.backfilled).toEqual([]);
  });

  it('does not touch a PUBLIC-mode Container runtime', async () => {
    const runtime = containerVpcRuntime({ networkMode: 'PUBLIC', networkConfig: undefined });
    const spec = { name: 'proj', runtimes: [runtime], harnesses: [] } as unknown as AgentCoreProjectSpec;
    const { configIO, writeProjectSpec } = makeConfigIO();

    const result = await backfillContainerVpcIds(configIO, spec, 'us-east-1');

    expect(mockResolveVpcId).not.toHaveBeenCalled();
    expect(writeProjectSpec).not.toHaveBeenCalled();
    expect(result.backfilled).toEqual([]);
  });

  it('backfills + persists a dockerfile harness missing vpcId (via harness.json)', async () => {
    const spec = {
      name: 'proj',
      runtimes: [],
      harnesses: [{ name: 'h1' }],
    } as unknown as AgentCoreProjectSpec;
    const { configIO, writeHarnessSpec, harnessSpecs } = makeConfigIO();
    harnessSpecs.h1 = {
      name: 'h1',
      dockerfile: 'Dockerfile',
      networkMode: 'VPC',
      networkConfig: { subnets: ['subnet-0000000000000000b'], securityGroups: ['sg-0000000000000000b'] },
    } as unknown as HarnessSpec;

    const result = await backfillContainerVpcIds(configIO, spec, 'us-west-2');

    expect(mockResolveVpcId).toHaveBeenCalledWith(['subnet-0000000000000000b'], 'us-west-2');
    expect(writeHarnessSpec).toHaveBeenCalledOnce();
    expect(harnessSpecs.h1.networkConfig?.vpcId).toBe('vpc-0123456789abcdef0');
    expect(result.backfilled).toEqual(['h1']);
  });

  it('backfills a prebuilt-containerUri harness too (it still runs CodeBuild)', async () => {
    const spec = {
      name: 'proj',
      runtimes: [],
      harnesses: [{ name: 'h2' }],
    } as unknown as AgentCoreProjectSpec;
    const { configIO, harnessSpecs } = makeConfigIO();
    harnessSpecs.h2 = {
      name: 'h2',
      containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
      networkMode: 'VPC',
      networkConfig: { subnets: ['subnet-0000000000000000c'], securityGroups: ['sg-0000000000000000c'] },
    } as unknown as HarnessSpec;

    const result = await backfillContainerVpcIds(configIO, spec, 'us-east-1');

    expect(harnessSpecs.h2.networkConfig?.vpcId).toBe('vpc-0123456789abcdef0');
    expect(result.backfilled).toEqual(['h2']);
  });

  // BUG-2 regression: in preview mode (persist=false) the resolved vpcId is written to disk so the
  // synth subprocess can read it, but restore() must revert the file so a --dry-run/--diff preview
  // leaves the working tree untouched.
  describe('dry-run (persist=false) restore', () => {
    it('writes vpcId for synth then restore() reverts agentcore.json to its original bytes', async () => {
      const dir = mkdtempSync(join(tmpdir(), `backfill-${randomUUID()}-`));
      const agentPath = join(dir, 'agentcore.json');
      const original = JSON.stringify({ name: 'proj', runtimes: [{ name: 'a' }] }, null, 2);
      writeFileSync(agentPath, original, 'utf-8');

      const runtime = containerVpcRuntime();
      const spec = { name: 'proj', runtimes: [runtime], harnesses: [] } as unknown as AgentCoreProjectSpec;
      // ConfigIO stub whose writeProjectSpec writes the real file at agentPath (what CDK synth reads).
      const configIO = {
        getAgentConfigPath: () => agentPath,
        getHarnessConfigPath: (n: string) => join(dir, `${n}.json`),
        writeProjectSpec: (s: AgentCoreProjectSpec) => {
          writeFileSync(agentPath, JSON.stringify(s, null, 2), 'utf-8');
          return Promise.resolve();
        },
        readHarnessSpec: () => Promise.reject(new Error('no harness')),
      } as unknown as ConfigIO;

      const result = await backfillContainerVpcIds(configIO, spec, 'us-east-1', false);

      // While synth would run, the resolved vpcId is on disk...
      expect(readFileSync(agentPath, 'utf-8')).toContain('vpc-0123456789abcdef0');
      expect(result.backfilled).toEqual(['agent1']);

      // ...but after restore() the file is byte-for-byte what it was before the preview.
      await result.restore();
      expect(readFileSync(agentPath, 'utf-8')).toBe(original);
    });

    it('persist=true leaves the value on disk (no restore) — restore() is a no-op', async () => {
      const dir = mkdtempSync(join(tmpdir(), `backfill-${randomUUID()}-`));
      const agentPath = join(dir, 'agentcore.json');
      writeFileSync(agentPath, JSON.stringify({ name: 'proj', runtimes: [{ name: 'a' }] }, null, 2), 'utf-8');

      const runtime = containerVpcRuntime();
      const spec = { name: 'proj', runtimes: [runtime], harnesses: [] } as unknown as AgentCoreProjectSpec;
      const configIO = {
        getAgentConfigPath: () => agentPath,
        getHarnessConfigPath: (n: string) => join(dir, `${n}.json`),
        writeProjectSpec: (s: AgentCoreProjectSpec) => {
          writeFileSync(agentPath, JSON.stringify(s, null, 2), 'utf-8');
          return Promise.resolve();
        },
        readHarnessSpec: () => Promise.reject(new Error('no harness')),
      } as unknown as ConfigIO;

      const result = await backfillContainerVpcIds(configIO, spec, 'us-east-1', true);
      await result.restore(); // no-op on a real deploy
      expect(readFileSync(agentPath, 'utf-8')).toContain('vpc-0123456789abcdef0');
    });

    it('rolls back an already-written file when a LATER resource resolve throws (multi-resource preview)', async () => {
      // Runtime resolves + writes agentcore.json, THEN the harness resolve throws (e.g. DescribeSubnets
      // denied / subnets span VPCs). The function rejects before returning `restore`, so the caller
      // can't revert — the rollback must happen internally so the preview never leaves the tree dirty.
      const dir = mkdtempSync(join(tmpdir(), `backfill-${randomUUID()}-`));
      const agentPath = join(dir, 'agentcore.json');
      const original = JSON.stringify({ name: 'proj', runtimes: [{ name: 'a' }] }, null, 2);
      writeFileSync(agentPath, original, 'utf-8');

      const runtime = containerVpcRuntime();
      const harness = {
        name: 'h1',
        dockerfile: 'Dockerfile',
        networkMode: 'VPC',
        networkConfig: { subnets: ['subnet-0000000000000000b'], securityGroups: ['sg-0000000000000000b'] },
      } as unknown as HarnessSpec;
      const spec = {
        name: 'proj',
        runtimes: [runtime],
        harnesses: [{ name: 'h1' }],
      } as unknown as AgentCoreProjectSpec;

      const configIO = {
        getAgentConfigPath: () => agentPath,
        getHarnessConfigPath: (n: string) => join(dir, `${n}.json`),
        writeProjectSpec: (s: AgentCoreProjectSpec) => {
          writeFileSync(agentPath, JSON.stringify(s, null, 2), 'utf-8');
          return Promise.resolve();
        },
        readHarnessSpec: () => Promise.resolve(harness),
        writeHarnessSpec: () => Promise.resolve(),
      } as unknown as ConfigIO;

      // First subnet (runtime) resolves; second (harness) throws.
      mockResolveVpcId
        .mockResolvedValueOnce('vpc-0123456789abcdef0')
        .mockRejectedValueOnce(new Error('Subnets span multiple VPCs'));

      await expect(backfillContainerVpcIds(configIO, spec, 'us-east-1', false)).rejects.toThrow(/span multiple VPCs/);

      // The runtime write must have been rolled back — agentcore.json is byte-for-byte the original.
      expect(readFileSync(agentPath, 'utf-8')).toBe(original);
    });
  });
});
