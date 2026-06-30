import { HarnessPrimitive } from '../HarnessPrimitive';
import { Command } from '@commander-js/extra-typings';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Part B (Task 16): `agentcore add harness --vpc-id` parity for dockerfile+VPC harnesses. The TUI
// already collects a VPC ID; the non-interactive flag path could not. These tests pin the flag
// registration (--vpc-id, distinct from --private-endpoint-vpc-id) and that add() threads vpcId
// into the written harness spec's networkConfig.

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockWriteHarnessSpec = vi.fn();

vi.mock('../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    writeHarnessSpec = mockWriteHarnessSpec;
    getPathResolver = () => ({ getHarnessDir: (name: string) => `/fake/root/app/${name}` });
  },
  findConfigRoot: () => '/fake/root',
}));

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

function baseProject() {
  return { name: 'proj', harnesses: [], memories: [], runtimes: [] };
}

/** Runs add() with the given options and returns the networkConfig written to harness.json. */
async function networkConfigWrittenFor(options: Record<string, unknown>) {
  mockReadProjectSpec.mockResolvedValue(baseProject());
  const primitive = new HarnessPrimitive();
  const result = await primitive.add({
    name: 'support',
    modelProvider: 'bedrock',
    modelId: 'anthropic.claude-3',
    configBaseDir: '/fake/root',
    ...options,
  } as never);
  expect(result.success).toBe(true);
  const [, spec] = mockWriteHarnessSpec.mock.calls.at(-1)!;
  return (spec as { networkConfig?: { subnets: string[]; securityGroups: string[]; vpcId?: string } }).networkConfig;
}

describe('HarnessPrimitive.add — --vpc-id threading', () => {
  afterEach(() => vi.clearAllMocks());

  it('threads vpcId into networkConfig for a dockerfile+VPC harness', async () => {
    const networkConfig = await networkConfigWrittenFor({
      dockerfilePath: 'Dockerfile',
      networkMode: 'VPC',
      subnets: ['subnet-0123456789abcdef0'],
      securityGroups: ['sg-0123456789abcdef0'],
      vpcId: 'vpc-0123456789abcdef0',
    });
    expect(networkConfig).toEqual({
      subnets: ['subnet-0123456789abcdef0'],
      securityGroups: ['sg-0123456789abcdef0'],
      vpcId: 'vpc-0123456789abcdef0',
    });
  });

  it('omits vpcId from networkConfig when not provided', async () => {
    const networkConfig = await networkConfigWrittenFor({
      networkMode: 'VPC',
      subnets: ['subnet-0123456789abcdef0'],
      securityGroups: ['sg-0123456789abcdef0'],
    });
    expect(networkConfig).toEqual({
      subnets: ['subnet-0123456789abcdef0'],
      securityGroups: ['sg-0123456789abcdef0'],
    });
  });
});

describe('HarnessPrimitive add command — --vpc-id flag registration', () => {
  it('registers --vpc-id, distinct from --private-endpoint-vpc-id', () => {
    const primitive = new HarnessPrimitive();
    const addCmd = new Command('add');
    const removeCmd = new Command('remove');
    primitive.registerCommands(addCmd, removeCmd);

    const harnessCmd = addCmd.commands.find(c => c.name() === 'harness');
    expect(harnessCmd).toBeDefined();

    const flags = harnessCmd!.options.map(o => o.long).filter((f): f is string => Boolean(f));
    expect(flags).toContain('--vpc-id');
    expect(flags).toContain('--private-endpoint-vpc-id');
  });
});
