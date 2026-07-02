import type { ConfigIO } from '../../../../lib';
import type { AgentCoreProjectSpec, HarnessSpec } from '../../../../schema';
import { backfillContainerVpcIds } from '../backfill-vpc-id';
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
});
