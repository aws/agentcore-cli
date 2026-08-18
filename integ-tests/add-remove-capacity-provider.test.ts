import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OPERATOR_ROLE_ARN = 'arn:aws:iam::123456789012:role/MyOperatorRole';

describe('integration: add and remove capacity providers', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('capacity provider lifecycle', () => {
    const cpName = `IntegCp${Date.now().toString().slice(-6)}`;

    it('adds a capacity provider', async () => {
      const result = await runCLI(
        [
          'add',
          'capacity-provider',
          '--name',
          cpName,
          '--operator-role-arn',
          OPERATOR_ROLE_ARN,
          '--subnets',
          'subnet-0123456789abcdef0',
          '--security-groups',
          'sg-0123456789abcdef0',
          '--os',
          'LINUX_X86_64',
          '--instance-types',
          'c6a.large',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.capacityProviderName).toBe(cpName);

      const config = await readProjectConfig(project.projectPath);
      const cp = config.capacityProviders?.find((c: Record<string, unknown>) => c.name === cpName);
      expect(cp, `Capacity provider "${cpName}" should be in config`).toBeTruthy();
      expect(cp!.operatorRoleArn).toBe(OPERATOR_ROLE_ARN);
      const ec2 = (cp as any).computeConfiguration.ec2Configuration;
      expect(ec2.launchTemplateSource.launchParameters.operatingSystem).toBe('LINUX_X86_64');
      expect(ec2.launchTemplateSource.launchParameters.instanceRequirements.allowedInstanceTypes).toEqual([
        'c6a.large',
      ]);
      expect(ec2.vpcConfiguration.subnets).toEqual(['subnet-0123456789abcdef0']);
      expect(ec2.vpcConfiguration.securityGroups).toEqual(['sg-0123456789abcdef0']);
    });

    it('adds a capacity provider with volumes, lifecycle, and description', async () => {
      const richName = `${cpName}Rich`;
      const result = await runCLI(
        [
          'add',
          'capacity-provider',
          '--name',
          richName,
          '--operator-role-arn',
          OPERATOR_ROLE_ARN,
          '--description',
          'my rich capacity provider',
          '--subnets',
          'subnet-0123456789abcdef0,subnet-0fedcba9876543210',
          '--security-groups',
          'sg-0123456789abcdef0',
          '--os',
          'LINUX_ARM64',
          '--instance-types',
          'c7g.large,c7g.xlarge',
          '--volume',
          'data:20',
          '--volume-encrypted',
          '--idle-instance-timeout',
          '3600',
          '--max-lifetime',
          '28800',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const cp = config.capacityProviders?.find((c: Record<string, unknown>) => c.name === richName);
      expect(cp).toBeTruthy();
      expect(cp!.description).toBe('my rich capacity provider');
      const ec2 = (cp as any).computeConfiguration.ec2Configuration;
      expect(ec2.launchTemplateSource.launchParameters.operatingSystem).toBe('LINUX_ARM64');
      expect(ec2.vpcConfiguration.subnets).toHaveLength(2);
      expect(ec2.volumes).toEqual([{ ebsConfiguration: { name: 'data', sizeGiB: 20, encrypted: true } }]);
      expect(ec2.lifecycleConfiguration).toEqual({ idleInstanceTimeout: 3600, maxLifetime: 28800 });

      await runCLI(['remove', 'capacity-provider', '--name', richName, '--yes'], project.projectPath);
    });

    it('rejects a duplicate capacity provider name', async () => {
      const result = await runCLI(
        [
          'add',
          'capacity-provider',
          '--name',
          cpName,
          '--operator-role-arn',
          OPERATOR_ROLE_ARN,
          '--subnets',
          'subnet-0123456789abcdef0',
          '--security-groups',
          'sg-0123456789abcdef0',
          '--instance-types',
          'c6a.large',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });

    it('removes the capacity provider', async () => {
      const result = await runCLI(
        ['remove', 'capacity-provider', '--name', cpName, '--yes', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      const found = config.capacityProviders?.some((c: Record<string, unknown>) => c.name === cpName);
      expect(found, `Capacity provider "${cpName}" should be removed`).toBeFalsy();
    });
  });

  describe('validation', () => {
    it('rejects a missing required option', async () => {
      const result = await runCLI(['add', 'capacity-provider', '--name', 'noRole', '--json'], project.projectPath);
      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
    });

    it('rejects an unsupported operating system', async () => {
      const result = await runCLI(
        [
          'add',
          'capacity-provider',
          '--name',
          'badOs',
          '--operator-role-arn',
          OPERATOR_ROLE_ARN,
          '--subnets',
          'subnet-0123456789abcdef0',
          '--security-groups',
          'sg-0123456789abcdef0',
          '--os',
          'WINDOWS_X86_64',
          '--instance-types',
          'c6a.large',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
    });

    it('rejects a malformed operator role ARN', async () => {
      const result = await runCLI(
        [
          'add',
          'capacity-provider',
          '--name',
          'badArn',
          '--operator-role-arn',
          'not-an-arn',
          '--subnets',
          'subnet-0123456789abcdef0',
          '--security-groups',
          'sg-0123456789abcdef0',
          '--instance-types',
          'c6a.large',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
    });

    it('passes agentcore validate after add/remove lifecycle', async () => {
      const result = await runCLI(['validate'], project.projectPath);
      expect(result.exitCode).toBe(0);
    });
  });
});
