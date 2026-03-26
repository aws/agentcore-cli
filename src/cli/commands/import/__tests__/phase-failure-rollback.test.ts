/**
 * Test: Config Rollback on Import Failure
 *
 * Verifies that when CDK build/synth or CloudFormation phases fail after
 * the merged config has been written to disk, the config is rolled back
 * to its pre-import state.
 */
import { handleImport } from '../actions';
import type { ParsedStarterToolkitConfig } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mock fns ────────────────────────────────────────────────────────

const {
  mockFindConfigRoot,
  mockConfigIOInstance,
  MockConfigIOClass,
  mockValidateAwsCredentials,
  mockBuildCdkProject,
  mockSynthesizeCdk,
  mockCheckBootstrapNeeded,
  mockBootstrapEnvironment,
  mockSetupPythonProject,
  mockExecutePhase1,
  mockGetDeployedTemplate,
  mockExecutePhase2,
  mockPublishCdkAssets,
  mockParseStarterToolkitYaml,
  mockExistsSync,
  mockMkdirSync,
  mockCopyFileSync,
  mockReaddirSync,
  mockReadFileSync,
  mockWriteFileSync,
} = vi.hoisted(() => {
  const inst = {
    readProjectSpec: vi.fn(),
    writeProjectSpec: vi.fn(),
    readAWSDeploymentTargets: vi.fn(),
    writeAWSDeploymentTargets: vi.fn(),
    readDeployedState: vi.fn(),
    writeDeployedState: vi.fn(),
  };
  return {
    mockFindConfigRoot: vi.fn(),
    mockConfigIOInstance: inst,
    MockConfigIOClass: vi.fn(function (this: any) {
      Object.assign(this, inst);
      return this;
    }),
    mockValidateAwsCredentials: vi.fn(),
    mockBuildCdkProject: vi.fn(),
    mockSynthesizeCdk: vi.fn(),
    mockSetupPythonProject: vi.fn(),
    mockExecutePhase1: vi.fn(),
    mockGetDeployedTemplate: vi.fn(),
    mockExecutePhase2: vi.fn(),
    mockCheckBootstrapNeeded: vi.fn(),
    mockBootstrapEnvironment: vi.fn(),
    mockPublishCdkAssets: vi.fn(),
    mockParseStarterToolkitYaml: vi.fn(),
    mockExistsSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockCopyFileSync: vi.fn(),
    mockReaddirSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: MockConfigIOClass,
  findConfigRoot: (...args: unknown[]) => mockFindConfigRoot(...args),
}));

vi.mock('../../../aws/account', () => ({
  validateAwsCredentials: (...args: unknown[]) => mockValidateAwsCredentials(...args),
}));

vi.mock('../../../operations/deploy', () => ({
  buildCdkProject: (...args: unknown[]) => mockBuildCdkProject(...args),
  synthesizeCdk: (...args: unknown[]) => mockSynthesizeCdk(...args),
  checkBootstrapNeeded: (...args: unknown[]) => mockCheckBootstrapNeeded(...args),
  bootstrapEnvironment: (...args: unknown[]) => mockBootstrapEnvironment(...args),
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

vi.mock('../../../operations/python/setup', () => ({
  setupPythonProject: (...args: unknown[]) => mockSetupPythonProject(...args),
}));

vi.mock('../phase1-update', () => ({
  executePhase1: (...args: unknown[]) => mockExecutePhase1(...args),
  getDeployedTemplate: (...args: unknown[]) => mockGetDeployedTemplate(...args),
}));

vi.mock('../phase2-import', () => ({
  executePhase2: (...args: unknown[]) => mockExecutePhase2(...args),
  publishCdkAssets: (...args: unknown[]) => mockPublishCdkAssets(...args),
}));

vi.mock('../yaml-parser', () => ({
  parseStarterToolkitYaml: (...args: unknown[]) => mockParseStarterToolkitYaml(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

// ── Test Fixtures ────────────────────────────────────────────────────────────

function makeParsedConfig(overrides?: Partial<ParsedStarterToolkitConfig>): ParsedStarterToolkitConfig {
  return {
    defaultAgent: 'my-agent',
    agents: [
      {
        name: 'my-agent',
        entrypoint: 'main.py',
        build: 'CodeZip' as const,
        runtimeVersion: 'PYTHON_3_12',
        language: 'python' as const,
        sourcePath: '/tmp/src/my-agent',
        networkMode: 'PUBLIC' as const,
        protocol: 'HTTP' as const,
        enableOtel: true,
        physicalAgentId: 'rt-abc123',
        physicalAgentArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc123',
      },
    ],
    memories: [],
    credentials: [],
    awsTarget: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  };
}

function makeProjectSpec() {
  return {
    name: 'TestProject',
    version: 1,
    agents: [],
    memories: [],
    credentials: [],
  };
}

const synthTemplate = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    MyAgentRuntime: {
      Type: 'AWS::BedrockAgentCore::Runtime',
      Properties: { AgentRuntimeName: 'TestProject_my-agent' },
    },
    MyRole: {
      Type: 'AWS::IAM::Role',
      Properties: { RoleName: 'my-role' },
    },
  },
};

const deployedTemplate = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    MyRole: {
      Type: 'AWS::IAM::Role',
      Properties: { RoleName: 'my-role' },
    },
  },
};

// ── Common setup ─────────────────────────────────────────────────────────────

function setupCommonMocks() {
  mockFindConfigRoot.mockReturnValue('/tmp/project/agentcore');

  mockConfigIOInstance.readAWSDeploymentTargets.mockResolvedValue([
    { name: 'default', account: '123456789012', region: 'us-east-1' },
  ]);

  mockValidateAwsCredentials.mockResolvedValue(undefined);
  mockSetupPythonProject.mockResolvedValue({ status: 'success' });

  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue([]);
  mockReadFileSync.mockReturnValue(JSON.stringify(synthTemplate));

  mockCheckBootstrapNeeded.mockResolvedValue({ needsBootstrap: false });
  mockBootstrapEnvironment.mockResolvedValue(undefined);
  mockBuildCdkProject.mockResolvedValue(undefined);
  mockSynthesizeCdk.mockResolvedValue({
    toolkitWrapper: {
      synth: vi.fn().mockResolvedValue({ assemblyDirectory: '/tmp/cdk.out' }),
      dispose: vi.fn(),
    },
  });

  mockExecutePhase1.mockResolvedValue({ success: true, stackExists: true });
  mockGetDeployedTemplate.mockResolvedValue(deployedTemplate);
  mockExecutePhase2.mockResolvedValue({ success: true });
  mockPublishCdkAssets.mockResolvedValue(undefined);

  mockConfigIOInstance.readDeployedState.mockResolvedValue({ targets: {} });
  mockConfigIOInstance.writeDeployedState.mockResolvedValue(undefined);
  mockConfigIOInstance.writeProjectSpec.mockResolvedValue(undefined);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Config Rollback on Import Failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back config when Phase 1 fails', async () => {
    mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
    mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
    mockExecutePhase1.mockResolvedValue({ success: false, error: 'stack update failed' });

    const result = await handleImport({ source: '/tmp/config.yaml' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Phase 1 failed');

    // First call = merge write, second call = rollback with original (empty) agents
    expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(2);
    const rollbackData = mockConfigIOInstance.writeProjectSpec.mock.calls[1]![0];
    expect(rollbackData.agents).toEqual([]);
  });

  it('rolls back config when Phase 2 fails', async () => {
    mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
    mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
    mockExecutePhase2.mockResolvedValue({ success: false, error: 'import changeset failed' });

    const result = await handleImport({ source: '/tmp/config.yaml' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Phase 2 failed');

    expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(2);
    const rollbackData = mockConfigIOInstance.writeProjectSpec.mock.calls[1]![0];
    expect(rollbackData.agents).toEqual([]);
  });

  it('rolls back config when CDK build throws', async () => {
    mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
    mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
    mockBuildCdkProject.mockRejectedValue(new Error('CDK build failed'));

    const result = await handleImport({ source: '/tmp/config.yaml' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('CDK build failed');

    expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(2);
    const rollbackData = mockConfigIOInstance.writeProjectSpec.mock.calls[1]![0];
    expect(rollbackData.agents).toEqual([]);
  });

  it('does not rollback on successful import', async () => {
    mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
    mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());

    const result = await handleImport({ source: '/tmp/config.yaml' });

    expect(result.success).toBe(true);
    // Only one write: the merge write
    expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(1);
  });

  it('does not rollback on early validation failure (no agents in YAML)', async () => {
    mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
    mockParseStarterToolkitYaml.mockReturnValue({
      defaultAgent: '',
      agents: [],
      memories: [],
      credentials: [],
      awsTarget: {},
    });

    const result = await handleImport({ source: '/tmp/config.yaml' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No agents found');
    // Config was never written, so no rollback
    expect(mockConfigIOInstance.writeProjectSpec).not.toHaveBeenCalled();
  });

  it('emits progress message during rollback', async () => {
    mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
    mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
    mockExecutePhase1.mockResolvedValue({ success: false, error: 'failed' });

    const progressMessages: string[] = [];
    await handleImport({
      source: '/tmp/config.yaml',
      onProgress: msg => progressMessages.push(msg),
    });

    expect(progressMessages.some(m => m.includes('Rolling back config changes'))).toBe(true);
  });

  it('rolls back config when getDeployedTemplate returns null', async () => {
    mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
    mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
    mockGetDeployedTemplate.mockResolvedValue(null);

    const result = await handleImport({ source: '/tmp/config.yaml' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not read deployed template');

    expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(2);
    const rollbackData = mockConfigIOInstance.writeProjectSpec.mock.calls[1]![0];
    expect(rollbackData.agents).toEqual([]);
  });
});
