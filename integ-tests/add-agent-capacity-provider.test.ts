import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OPERATOR_ROLE_ARN = 'arn:aws:iam::123456789012:role/MyOperatorRole';

describe('integration: attach capacity provider to an agent (J2/J3) + delete-session (J4)', () => {
  let project: TestProject;
  const cpName = `IntegAttachCp${Date.now().toString().slice(-6)}`;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
    // A capacity provider with a named volume for the runtime to mount (J3).
    const cp = await runCLI(
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
        '--volume-name',
        'model-weights',
        '--volume-size',
        '100',
        '--json',
      ],
      project.projectPath
    );
    expect(cp.exitCode, `stdout: ${cp.stdout}, stderr: ${cp.stderr}`).toBe(0);
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('attaches a BYO agent to a sibling capacity provider by name and mounts a CP volume', async () => {
    const agentName = 'CpAttachAgent';
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentName,
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        `apps/${agentName}`,
        '--capacity-provider',
        cpName,
        '--cp-volume-name',
        'model-weights',
        '--cp-volume-mount-path',
        '/mnt/models',
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).success).toBe(true);

    const config = await readProjectConfig(project.projectPath);
    const agent = config.runtimes.find(a => a.name === agentName);
    expect(agent, `Agent "${agentName}" should be in config`).toBeTruthy();
    expect(agent!.capacityProviderConfiguration).toEqual({ capacityProviderName: cpName });
    expect(agent!.filesystemConfigurations).toContainEqual({
      capacityProviderVolume: { volumeName: 'model-weights', mountPath: '/mnt/models' },
    });
  });

  it('attaches a BYO agent to an external capacity provider by ARN', async () => {
    const agentName = 'CpArnAgent';
    const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/ext_pool-a1b2c3d4e5';
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentName,
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        `apps/${agentName}`,
        '--capacity-provider',
        arn,
        '--json',
      ],
      project.projectPath
    );

    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const config = await readProjectConfig(project.projectPath);
    const agent = config.runtimes.find(a => a.name === agentName);
    expect(agent!.capacityProviderConfiguration).toEqual({ capacityProviderArn: arn });
  });

  it('rejects a CP volume mount without a capacity provider attachment', async () => {
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'CpVolNoAttach',
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        'apps/CpVolNoAttach',
        '--cp-volume-name',
        'model-weights',
        '--cp-volume-mount-path',
        '/mnt/models',
        '--json',
      ],
      project.projectPath
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects attaching a capacity provider together with VPC networking', async () => {
    const result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'CpVpcAgent',
        '--type',
        'byo',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--code-location',
        'apps/CpVpcAgent',
        '--capacity-provider',
        cpName,
        '--network-mode',
        'VPC',
        '--subnets',
        'subnet-0123456789abcdef0',
        '--security-groups',
        'sg-0123456789abcdef0',
        '--json',
      ],
      project.projectPath
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('delete-session rejects an invalid session id', async () => {
    const result = await runCLI(
      [
        'capacity-provider',
        'delete-session',
        '--capacity-provider',
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/x_pool-a1b2c3d4e5',
        '--session-id',
        'bad session id',
        '--yes',
        '--json',
      ],
      project.projectPath
    );
    expect(result.exitCode).not.toBe(0);
  });
});
