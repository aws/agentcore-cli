import { CapacityProviderArnSchema, CapacityProviderSchema, isValidOperatorRoleArn } from '../capacity-provider';
import { describe, expect, it } from 'vitest';

const validCp = {
  name: 'myCp',
  operatorRoleArn: 'arn:aws:iam::123456789012:role/MyOperatorRole',
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

describe('CapacityProviderSchema', () => {
  it('accepts a minimal valid capacity provider', () => {
    expect(CapacityProviderSchema.safeParse(validCp).success).toBe(true);
  });

  it('rejects a name that does not start with a letter', () => {
    const result = CapacityProviderSchema.safeParse({ ...validCp, name: '1bad' });
    expect(result.success).toBe(false);
  });

  it('rejects a description over 4096 characters', () => {
    const result = CapacityProviderSchema.safeParse({ ...validCp, description: 'x'.repeat(4097) });
    expect(result.success).toBe(false);
  });

  it('accepts a 4096-character description', () => {
    const result = CapacityProviderSchema.safeParse({ ...validCp, description: 'x'.repeat(4096) });
    expect(result.success).toBe(true);
  });

  it('only accepts the two Linux operating systems', () => {
    for (const os of ['LINUX_X86_64', 'LINUX_ARM64']) {
      const cp = structuredClone(validCp);
      cp.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters.operatingSystem = os;
      expect(CapacityProviderSchema.safeParse(cp).success).toBe(true);
    }
    for (const os of ['MAC_ARM64', 'WINDOWS_X86_64']) {
      const cp = structuredClone(validCp);
      cp.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters.operatingSystem = os;
      expect(CapacityProviderSchema.safeParse(cp).success).toBe(false);
    }
  });

  it('requires 1-30 instance types', () => {
    const empty = structuredClone(validCp);
    empty.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters.instanceRequirements.allowedInstanceTypes =
      [];
    expect(CapacityProviderSchema.safeParse(empty).success).toBe(false);
  });

  it('rejects malformed subnet and security group IDs', () => {
    const badSubnet = structuredClone(validCp);
    badSubnet.computeConfiguration.ec2Configuration.vpcConfiguration.subnets = ['not-a-subnet'];
    expect(CapacityProviderSchema.safeParse(badSubnet).success).toBe(false);
  });

  it('accepts up to 5 volumes but rejects 6', () => {
    const mkVol = (i: number) => ({ ebsConfiguration: { name: `vol${i}`, sizeGiB: 10 } });
    const five = structuredClone(validCp) as Record<string, unknown> & typeof validCp;
    (five.computeConfiguration.ec2Configuration as Record<string, unknown>).volumes = [0, 1, 2, 3, 4].map(mkVol);
    expect(CapacityProviderSchema.safeParse(five).success).toBe(true);

    const six = structuredClone(validCp) as Record<string, unknown> & typeof validCp;
    (six.computeConfiguration.ec2Configuration as Record<string, unknown>).volumes = [0, 1, 2, 3, 4, 5].map(mkVol);
    expect(CapacityProviderSchema.safeParse(six).success).toBe(false);
  });

  it('passes through unknown launch parameters (long tail)', () => {
    const cp = structuredClone(validCp) as Record<string, unknown> & typeof validCp;
    (
      cp.computeConfiguration.ec2Configuration.launchTemplateSource.launchParameters as Record<string, unknown>
    ).sshKeyName = 'my-key';
    const result = CapacityProviderSchema.safeParse(cp);
    expect(result.success).toBe(true);
  });
});

describe('isValidOperatorRoleArn', () => {
  it('accepts standard and account-less role ARNs', () => {
    expect(isValidOperatorRoleArn('arn:aws:iam::123456789012:role/MyRole')).toBe(true);
    expect(isValidOperatorRoleArn('arn:aws:iam:::role/MyRole')).toBe(true);
    expect(isValidOperatorRoleArn('arn:aws-us-gov:iam::123456789012:role/MyRole')).toBe(true);
  });

  it('rejects non-role and malformed ARNs', () => {
    expect(isValidOperatorRoleArn('arn:aws:iam::123456789012:user/Bob')).toBe(false);
    expect(isValidOperatorRoleArn('not-an-arn')).toBe(false);
  });
});

describe('CapacityProviderArnSchema', () => {
  it('accepts an ARN whose resource is a full capacityProviderId ({name}-{10 alnum})', () => {
    expect(
      CapacityProviderArnSchema.safeParse(
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/my_pool-a1b2c3d4e5'
      ).success
    ).toBe(true);
    // Partition-agnostic.
    expect(
      CapacityProviderArnSchema.safeParse(
        'arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:123456789012:capacity-provider/Pool-AbCdEfGhIj'
      ).success
    ).toBe(true);
  });

  it('rejects a free-form resource segment (bad external ARN caught before deploy)', () => {
    // Missing the `-{10 alnum}` id suffix — the shape the service actually requires.
    expect(
      CapacityProviderArnSchema.safeParse('arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/x')
        .success
    ).toBe(false);
    // Suffix too short.
    expect(
      CapacityProviderArnSchema.safeParse(
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/pool-abc123'
      ).success
    ).toBe(false);
  });
});
