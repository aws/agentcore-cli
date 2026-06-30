/**
 * Tests that the YAML import flow resolves vpcId via DescribeSubnets for Container+VPC agents
 * whose starter-toolkit YAML omits vpc_id (the normal case — the toolkit never emits it).
 *
 * Mirrors the mocking style used in import-no-deploy.test.ts and agentcore-control.test.ts.
 */
import { AgentEnvSpecSchema } from '../../../../schema/schemas/agent-env.js';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Hoisted mocks ----

const { mockResolveVpcId } = vi.hoisted(() => ({
  mockResolveVpcId: vi.fn(),
}));

vi.mock('../../../commands/shared/vpc-utils', () => ({
  resolveVpcIdFromSubnets: (...args: unknown[]) => mockResolveVpcId(...args),
}));

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockReadAWSDeploymentTargets = vi.fn();
const mockWriteAWSDeploymentTargets = vi.fn();
const mockReadDeployedState = vi.fn();
const mockWriteDeployedState = vi.fn();
const mockFindConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: class MockConfigIO {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    writeAWSDeploymentTargets = mockWriteAWSDeploymentTargets;
    readDeployedState = mockReadDeployedState;
    writeDeployedState = mockWriteDeployedState;
  },
  NoProjectError: class NoProjectError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'No agentcore project found');
      this.name = 'NoProjectError';
    }
  },
  ValidationError: class ValidationError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'Validation error');
      this.name = 'ValidationError';
    }
  },
  findConfigRoot: (...args: unknown[]) => mockFindConfigRoot(...args),
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

vi.mock('../../../aws/account', () => ({
  validateAwsCredentials: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../aws/partition', () => ({
  arnPrefix: vi.fn().mockReturnValue('arn:aws'),
}));

vi.mock('../../../cdk/local-cdk-project', () => ({
  LocalCdkProject: vi.fn(),
}));

vi.mock('../../../cdk/toolkit-lib', () => ({
  silentIoHost: {},
}));

vi.mock('../../../logging', () => ({
  ExecLogger: class MockExecLogger {
    startStep = vi.fn();
    endStep = vi.fn();
    log = vi.fn();
    finalize = vi.fn();
    getRelativeLogPath = vi.fn().mockReturnValue('agentcore/.cli/logs/import/import-mock.log');
    logFilePath = 'agentcore/.cli/logs/import/import-mock.log';
  },
}));

vi.mock('../../../operations/deploy', () => ({
  buildCdkProject: vi.fn(),
  synthesizeCdk: vi.fn(),
}));

vi.mock('../../../operations/python/setup', () => ({
  setupPythonProject: vi.fn().mockResolvedValue({ status: 'success' }),
}));

vi.mock('../phase1-update', () => ({
  executePhase1: vi.fn(),
  getDeployedTemplate: vi.fn(),
}));

vi.mock('../phase2-import', () => ({
  executePhase2: vi.fn(),
  publishCdkAssets: vi.fn(),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeProjectDir(tmpDir: string): string {
  const configDir = path.join(tmpDir, 'myproject', 'agentcore');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'agentcore.json'),
    JSON.stringify({ name: 'myproject', version: 1, runtimes: [], memories: [], knowledgeBases: [], credentials: [] })
  );
  return configDir;
}

function writeYaml(dir: string, content: string): string {
  const p = path.join(dir, '.bedrock_agentcore.yaml');
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

const CONTAINER_VPC_YAML = (agentId: string) => `
default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-0a1b2c3d4e5f6a7b8
            - subnet-0b2c3d4e5f6a7b8c9
          security_groups:
            - sg-0abcdef1234567890
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: ${agentId}
`;

const EMPTY_SPEC = {
  name: 'myproject',
  version: 1,
  runtimes: [],
  memories: [],
  knowledgeBases: [],
  credentials: [],
};

// ============================================================================
// 1. vpcId resolved via DescribeSubnets on YAML import (no-deploy path)
// ============================================================================

describe('handleImport: Container+VPC agent — vpcId resolved via DescribeSubnets', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpc-yaml-import-'));
    const configDir = makeProjectDir(tmpDir);
    mockFindConfigRoot.mockReturnValue(configDir);
    mockResolveVpcId.mockResolvedValue('vpc-0a1b2c3d4e5f60718');
    mockReadProjectSpec.mockResolvedValue(structuredClone(EMPTY_SPEC));
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '123456789012', region: 'us-west-2' }]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates networkConfig.vpcId from DescribeSubnets when YAML has no vpc_id', async () => {
    const yamlPath = writeYaml(tmpDir, CONTAINER_VPC_YAML('null'));
    const { handleImport } = await import('../actions.js');

    const result = await handleImport({ source: yamlPath });

    assert(result.success);
    expect(mockResolveVpcId).toHaveBeenCalledWith(
      ['subnet-0a1b2c3d4e5f6a7b8', 'subnet-0b2c3d4e5f6a7b8c9'],
      'us-west-2'
    );
    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    const agent = writtenSpec.runtimes[0];
    expect(agent.networkConfig.vpcId).toBe('vpc-0a1b2c3d4e5f60718');
  });

  it('written spec passes AgentEnvSpecSchema validation after vpcId is resolved', async () => {
    const yamlPath = writeYaml(tmpDir, CONTAINER_VPC_YAML('null'));
    const { handleImport } = await import('../actions.js');

    await handleImport({ source: yamlPath });

    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    const agentSpec = writtenSpec.runtimes[0];
    const parseResult = AgentEnvSpecSchema.safeParse(agentSpec);
    expect(parseResult.success).toBe(true);
  });

  it('does NOT call DescribeSubnets when YAML already carries vpc_id', async () => {
    const yamlWithVpcId = `
default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-0a1b2c3d4e5f6a7b8
          security_groups:
            - sg-0abcdef1234567890
          vpc_id: vpc-0existingvpcid0
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: null
`;
    const yamlPath = writeYaml(tmpDir, yamlWithVpcId);
    const { handleImport } = await import('../actions.js');

    await handleImport({ source: yamlPath });

    expect(mockResolveVpcId).not.toHaveBeenCalled();
    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    expect(writtenSpec.runtimes[0].networkConfig.vpcId).toBe('vpc-0existingvpcid0');
  });

  it('does NOT call DescribeSubnets for PUBLIC agents', async () => {
    const publicYaml = `
default_agent: public_agent
agents:
  public_agent:
    name: public_agent
    entrypoint: main.py
    deployment_type: container
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: PUBLIC
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: null
`;
    const yamlPath = writeYaml(tmpDir, publicYaml);
    const { handleImport } = await import('../actions.js');

    await handleImport({ source: yamlPath });

    expect(mockResolveVpcId).not.toHaveBeenCalled();
  });

  it('does NOT call DescribeSubnets for CodeZip VPC agents (only Container requires vpcId)', async () => {
    const codezipVpcYaml = `
default_agent: codzip_agent
agents:
  codzip_agent:
    name: codzip_agent
    entrypoint: main.py
    deployment_type: direct_code_deploy
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-0a1b2c3d4e5f6a7b8
          security_groups:
            - sg-0abcdef1234567890
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: null
`;
    const yamlPath = writeYaml(tmpDir, codezipVpcYaml);
    const { handleImport } = await import('../actions.js');

    await handleImport({ source: yamlPath });

    expect(mockResolveVpcId).not.toHaveBeenCalled();
  });

  it('throws (propagates) ec2:DescribeSubnets error when DescribeSubnets fails', async () => {
    mockResolveVpcId.mockRejectedValue(
      new Error(
        'Failed to resolve VPC ID from subnet subnet-0a1b2c3d4e5f6a7b8: ec2:DescribeSubnets permission is required. Cause: Access Denied'
      )
    );
    const yamlPath = writeYaml(tmpDir, CONTAINER_VPC_YAML('null'));
    const { handleImport } = await import('../actions.js');

    const result = await handleImport({ source: yamlPath });

    expect(result.success).toBe(false);
    assert(!result.success);
    expect(result.error.message).toContain('ec2:DescribeSubnets');
  });

  it('uses region from YAML aws.region when no deployment target exists', async () => {
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    const yamlPath = writeYaml(tmpDir, CONTAINER_VPC_YAML('null'));
    const { handleImport } = await import('../actions.js');

    await handleImport({ source: yamlPath });

    expect(mockResolveVpcId).toHaveBeenCalledWith(expect.any(Array), 'us-west-2');
  });
});
