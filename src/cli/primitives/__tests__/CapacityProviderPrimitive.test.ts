import type { AgentCoreProjectSpec, CapacityProvider } from '../../../schema';
import type { AddCapacityProviderOptions } from '../CapacityProviderPrimitive';
import { CapacityProviderPrimitive } from '../CapacityProviderPrimitive';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();

vi.mock('../../../lib', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib')>();
  return {
    ...actual,
    ConfigIO: class {
      readProjectSpec = mockReadProjectSpec;
      writeProjectSpec = mockWriteProjectSpec;
    },
    findConfigRoot: vi.fn().mockReturnValue(null),
  };
});

function makeProject(overrides: Partial<AgentCoreProjectSpec> = {}): AgentCoreProjectSpec {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    knowledgeBases: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    configBundles: [],
    abTests: [],
    httpGateways: [],
    harnesses: [],
    datasets: [],
    payments: [],
    ...overrides,
  };
}

const OPERATOR_ROLE_ARN = 'arn:aws:iam::123456789012:role/MyOperatorRole';

function baseOptions(overrides: Partial<AddCapacityProviderOptions> = {}): AddCapacityProviderOptions {
  return {
    name: 'myCp',
    operatorRoleArn: OPERATOR_ROLE_ARN,
    subnets: 'subnet-0123456789abcdef0',
    securityGroups: 'sg-0123456789abcdef0',
    instanceTypes: 'c6a.large',
    ...overrides,
  };
}

function makeCapacityProvider(name: string): CapacityProvider {
  return {
    name,
    operatorRoleArn: OPERATOR_ROLE_ARN,
    computeConfiguration: {
      ec2Configuration: {
        launchTemplateSource: {
          launchParameters: {
            operatingSystem: 'LINUX_X86_64',
            instanceRequirements: { allowedInstanceTypes: ['c6a.large'] },
          },
        },
        vpcConfiguration: { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'] },
      },
    },
  };
}

const primitive = new CapacityProviderPrimitive();

describe('CapacityProviderPrimitive', () => {
  afterEach(() => vi.clearAllMocks());

  describe('add()', () => {
    it('happy path — adds a capacity provider to spec and returns success', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add(baseOptions());

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('capacityProviderName', 'myCp');

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.capacityProviders).toHaveLength(1);
      const cp = written.capacityProviders![0]!;
      expect(cp.name).toBe('myCp');
      expect(cp.operatorRoleArn).toBe(OPERATOR_ROLE_ARN);
      const ec2 = cp.computeConfiguration.ec2Configuration;
      expect(ec2.launchTemplateSource.launchParameters.operatingSystem).toBe('LINUX_X86_64');
      expect(ec2.launchTemplateSource.launchParameters.instanceRequirements.allowedInstanceTypes).toEqual([
        'c6a.large',
      ]);
      expect(ec2.vpcConfiguration.subnets).toEqual(['subnet-0123456789abcdef0']);
      expect(ec2.vpcConfiguration.securityGroups).toEqual(['sg-0123456789abcdef0']);
    });

    it('omitting the operator role ARN succeeds — the role is created at deploy time', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add(baseOptions({ operatorRoleArn: undefined }));

      expect(result.success).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      const cp = written.capacityProviders![0]!;
      // The field is omitted entirely (not written as undefined) so the construct auto-creates the role.
      expect(cp).not.toHaveProperty('operatorRoleArn');
    });

    it('parses multi-value flags, volumes, and lifecycle', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add(
        baseOptions({
          os: 'LINUX_ARM64',
          description: 'my cp',
          instanceTypes: 'c7g.large, c7g.xlarge',
          subnets: 'subnet-0123456789abcdef0,subnet-0fedcba9876543210',
          securityGroups: 'sg-0123456789abcdef0',
          volume: ['data:20'],
          volumeEncrypted: true,
          idleInstanceTimeout: '3600',
          maxLifetime: '28800',
        })
      );

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      const ec2 = written.capacityProviders![0]!.computeConfiguration.ec2Configuration;
      expect(ec2.launchTemplateSource.launchParameters.operatingSystem).toBe('LINUX_ARM64');
      expect(ec2.launchTemplateSource.launchParameters.instanceRequirements.allowedInstanceTypes).toEqual([
        'c7g.large',
        'c7g.xlarge',
      ]);
      expect(ec2.vpcConfiguration.subnets).toHaveLength(2);
      expect(ec2.volumes).toEqual([{ ebsConfiguration: { name: 'data', sizeGiB: 20, encrypted: true } }]);
      expect(ec2.lifecycleConfiguration).toEqual({ idleInstanceTimeout: 3600, maxLifetime: 28800 });
      expect(written.capacityProviders![0]!.description).toBe('my cp');
    });

    it('duplicate name — returns error without writing', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject({ capacityProviders: [makeCapacityProvider('myCp')] }));

      const result = await primitive.add(baseOptions());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('myCp');
        expect(result.error.message).toContain('already exists');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('rejects an operator role ARN with a malformed shape', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.add(baseOptions({ operatorRoleArn: 'not-an-arn' }));

      expect(result.success).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('accepts an operator role ARN without an account id (account segment optional)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add(baseOptions({ operatorRoleArn: 'arn:aws:iam:::role/MyRole' }));

      expect(result.success).toBe(true);
    });

    it('rejects an unsupported operating system value', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.add(baseOptions({ os: 'WINDOWS_X86_64' }));

      expect(result.success).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('rejects a malformed --volume value', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.add(baseOptions({ volume: ['data-no-size'] }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('name:sizeGiB');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    // A plain split(':') + Number() silently accepted all of these before the fix:
    // extra segments were dropped, and hex/exponent notation coerced to a number.
    it.each([
      ['extra segment', 'data:20:gp3'],
      ['hex size', 'data:0x14'],
      ['exponent size', 'data:2e1'],
      ['decimal size', 'data:20.5'],
      ['empty size', 'data:'],
    ])('rejects a --volume with %s (%s)', async (_label, value) => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.add(baseOptions({ volume: [value] }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('name:sizeGiB');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('remove()', () => {
    it('removes a capacity provider from spec', async () => {
      const project = makeProject({
        capacityProviders: [makeCapacityProvider('cpA'), makeCapacityProvider('cpB')],
      });
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('cpA');

      expect(result.success).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.capacityProviders).toHaveLength(1);
      expect(written.capacityProviders![0]!.name).toBe('cpB');
    });

    it('drops the array to undefined when removing the last capacity provider', async () => {
      const project = makeProject({ capacityProviders: [makeCapacityProvider('only')] });
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.remove('only');

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.capacityProviders).toBeUndefined();
    });

    it('non-existent name — returns error without writing', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.remove('missing');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('missing');
        expect(result.error.message).toContain('not found');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('getRemovable()', () => {
    it('returns capacity provider names from spec', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({ capacityProviders: [makeCapacityProvider('alpha'), makeCapacityProvider('beta')] })
      );

      expect(await primitive.getRemovable()).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
    });

    it('returns empty array when none exist', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      expect(await primitive.getRemovable()).toEqual([]);
    });
  });

  describe('previewRemove()', () => {
    it('returns summary and schema changes', async () => {
      const project = makeProject({ capacityProviders: [makeCapacityProvider('previewCp')] });
      mockReadProjectSpec.mockResolvedValue(project);

      const preview = await primitive.previewRemove('previewCp');

      expect(preview.summary[0]).toContain('previewCp');
      expect(preview.schemaChanges).toHaveLength(1);
      expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
      const after = preview.schemaChanges[0]!.after as AgentCoreProjectSpec;
      expect(after.capacityProviders).toBeUndefined();
    });

    it('throws when not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      await expect(primitive.previewRemove('missing')).rejects.toThrow('not found');
    });
  });
});
