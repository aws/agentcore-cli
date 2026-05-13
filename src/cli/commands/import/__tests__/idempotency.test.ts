/**
 * Test Group 7: Import Idempotency
 *
 * Verifies that running `agentcore import` twice with the same source is safe:
 * - No duplicate agents/memories in the config
 * - Second import skips already-existing resources
 * - Phase 1/Phase 2 are NOT re-run for already-imported resources
 * - Deployed state is not corrupted
 */
// ── Import the function under test AFTER mocks ────────────────────────────────
import { handleImport } from '../actions';
import type { ParsedStarterToolkitConfig } from '../types';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mock fns (available inside vi.mock factories) ─────────────────────

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

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: MockConfigIOClass,
  NoProjectError: class NoProjectError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'No agentcore project found');
      this.name = 'NoProjectError';
    }
  },
  ValidationError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ValidationError';
    }
  },
  findConfigRoot: (...args: unknown[]) => mockFindConfigRoot(...args),
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
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

// ── Test Fixtures ─────────────────────────────────────────────────────────────

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
    memories: [
      {
        name: 'my-memory',
        mode: 'STM_ONLY' as const,
        eventExpiryDays: 30,
        physicalMemoryId: 'mem-xyz789',
        physicalMemoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-xyz789',
      },
    ],
    credentials: [],
    awsTarget: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  };
}

function makeProjectSpec(agents: { name: string }[] = [], memories: { name: string }[] = []) {
  return {
    name: 'TestProject',
    version: 1,
    runtimes: agents.map(a => ({
      name: a.name,
      build: 'CodeZip',
      entrypoint: 'main.py',
      codeLocation: `app/${a.name}`,
      runtimeVersion: 'PYTHON_3_12',
      protocol: 'HTTP',
      networkMode: 'PUBLIC',
      instrumentation: { enableOtel: true },
    })),
    memories: memories.map(m => ({
      name: m.name,
      eventExpiryDuration: 30,
      strategies: [{ type: 'SEMANTIC' }],
    })),
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
    MyMemory: {
      Type: 'AWS::BedrockAgentCore::Memory',
      Properties: { Name: 'my-memory' },
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

// ── Common setup ──────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Import Idempotency (Test Group 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── First Import: Normal Flow ──────────────────────────────────────────────

  describe('first import (clean project)', () => {
    it('adds agents and memories to a project with no existing agents', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());

      const result = await handleImport({ source: '/tmp/config.yaml' });

      assert(result.success);
      expect(result.importedAgents).toContain('my-agent');
      expect(result.importedMemories).toContain('my-memory');

      expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(1);
      const writtenSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.runtimes).toHaveLength(1);
      expect(writtenSpec.runtimes[0].name).toBe('my-agent');
      expect(writtenSpec.memories).toHaveLength(1);
      expect(writtenSpec.memories[0].name).toBe('my-memory');
    });

    it('calls Phase 1 and Phase 2 on first import', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());

      const result = await handleImport({ source: '/tmp/config.yaml' });

      expect(result.success).toBe(true);
      expect(mockExecutePhase1).toHaveBeenCalledTimes(1);
      expect(mockExecutePhase2).toHaveBeenCalledTimes(1);
    });

    it('builds resourcesToImport from agents with physical IDs', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());

      await handleImport({ source: '/tmp/config.yaml' });

      expect(mockExecutePhase2).toHaveBeenCalledTimes(1);
      const phase2Options = mockExecutePhase2.mock.calls[0]![0];
      expect(phase2Options.resourcesToImport).toHaveLength(2);
      expect(phase2Options.resourcesToImport[0].resourceType).toBe('AWS::BedrockAgentCore::Runtime');
      expect(phase2Options.resourcesToImport[0].resourceIdentifier).toEqual({ AgentRuntimeId: 'rt-abc123' });
      expect(phase2Options.resourcesToImport[1].resourceType).toBe('AWS::BedrockAgentCore::Memory');
      expect(phase2Options.resourcesToImport[1].resourceIdentifier).toEqual({ MemoryId: 'mem-xyz789' });
    });

    it('writes deployed state after successful import', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());

      await handleImport({ source: '/tmp/config.yaml' });

      expect(mockConfigIOInstance.writeDeployedState).toHaveBeenCalledTimes(1);
      const state = mockConfigIOInstance.writeDeployedState.mock.calls[0]![0];
      expect(state.targets.default.resources.runtimes['my-agent']).toBeDefined();
      expect(state.targets.default.resources.runtimes['my-agent'].runtimeId).toBe('rt-abc123');
      expect(state.targets.default.resources.memories['my-memory']).toBeDefined();
      expect(state.targets.default.resources.memories['my-memory'].memoryId).toBe('mem-xyz789');
    });
  });

  // ── Second Import: Idempotency ─────────────────────────────────────────────

  describe('second import (agents already exist in project)', () => {
    it('skips agents that already exist in the project config', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(
        makeProjectSpec([{ name: 'my-agent' }], [{ name: 'my-memory' }])
      );

      const progressMessages: string[] = [];
      const result = await handleImport({
        source: '/tmp/config.yaml',
        onProgress: msg => progressMessages.push(msg),
      });

      expect(result.success).toBe(true);
      expect(progressMessages.some(m => m.includes('Skipping agent "my-agent"'))).toBe(true);
      expect(progressMessages.some(m => m.includes('already exists in project'))).toBe(true);
      expect(progressMessages.some(m => m.includes('Skipping memory "my-memory"'))).toBe(true);
    });

    it('does not duplicate agents in the config on second import', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(
        makeProjectSpec([{ name: 'my-agent' }], [{ name: 'my-memory' }])
      );

      await handleImport({ source: '/tmp/config.yaml' });

      expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(1);
      const writtenSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.runtimes).toHaveLength(1);
      expect(writtenSpec.memories).toHaveLength(1);
    });

    it('does NOT re-run Phase 2 for already-imported resources (bug fix)', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(
        makeProjectSpec([{ name: 'my-agent' }], [{ name: 'my-memory' }])
      );

      const result = await handleImport({ source: '/tmp/config.yaml' });
      expect(result.success).toBe(true);

      // After the fix: when all agents/memories already exist in the project,
      // newlyAddedAgentNames and newlyAddedMemoryNames are empty, so
      // agentsToImport and memoriesToImport are empty.
      // The early return at "agentsToImport.length === 0 && memoriesToImport.length === 0"
      // fires and Phase 2 is never called.
      expect(mockExecutePhase2).not.toHaveBeenCalled();
      expect(mockExecutePhase1).not.toHaveBeenCalled();
    });

    it('returns empty import lists when all resources already exist', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(
        makeProjectSpec([{ name: 'my-agent' }], [{ name: 'my-memory' }])
      );

      const result = await handleImport({ source: '/tmp/config.yaml' });

      assert(result.success);
      expect(result.importedAgents).toEqual([]);
      expect(result.importedMemories).toEqual([]);
    });

    it('does not corrupt deployed state on second import', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      const existingDeployedState = {
        targets: {
          default: {
            resources: {
              stackName: 'AgentCore-TestProject-default',
              runtimes: {
                'my-agent': {
                  runtimeId: 'rt-abc123',
                  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-abc123',
                  roleArn: 'imported',
                },
              },
              memories: {
                'my-memory': {
                  memoryId: 'mem-xyz789',
                  memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-xyz789',
                },
              },
            },
          },
        },
      };
      mockConfigIOInstance.readDeployedState.mockResolvedValue(existingDeployedState);
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(
        makeProjectSpec([{ name: 'my-agent' }], [{ name: 'my-memory' }])
      );

      const result = await handleImport({ source: '/tmp/config.yaml' });
      expect(result.success).toBe(true);

      // No Phase 2 was run, so writeDeployedState should NOT be called
      // (the early return fires before the deployed state update).
      expect(mockConfigIOInstance.writeDeployedState).not.toHaveBeenCalled();
    });
  });

  // ── Partial Overlap ────────────────────────────────────────────────────────

  describe('partial overlap (some agents new, some existing)', () => {
    it('imports only new agents and skips existing ones', async () => {
      const parsed: ParsedStarterToolkitConfig = {
        defaultAgent: 'agent-a',
        agents: [
          {
            name: 'agent-a',
            entrypoint: 'main.py',
            build: 'CodeZip' as const,
            runtimeVersion: 'PYTHON_3_12',
            language: 'python' as const,
            networkMode: 'PUBLIC' as const,
            protocol: 'HTTP' as const,
            enableOtel: true,
            physicalAgentId: 'rt-aaa',
          },
          {
            name: 'agent-b',
            entrypoint: 'main.py',
            build: 'CodeZip' as const,
            runtimeVersion: 'PYTHON_3_12',
            language: 'python' as const,
            networkMode: 'PUBLIC' as const,
            protocol: 'HTTP' as const,
            enableOtel: true,
            physicalAgentId: 'rt-bbb',
          },
        ],
        memories: [],
        credentials: [],
        awsTarget: { account: '123456789012', region: 'us-east-1' },
      };
      mockParseStarterToolkitYaml.mockReturnValue(parsed);

      // agent-a already exists, agent-b is new
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec([{ name: 'agent-a' }]));

      const multiAgentSynthTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          AgentARuntime: {
            Type: 'AWS::BedrockAgentCore::Runtime',
            Properties: { AgentRuntimeName: 'TestProject_agent-a' },
          },
          AgentBRuntime: {
            Type: 'AWS::BedrockAgentCore::Runtime',
            Properties: { AgentRuntimeName: 'TestProject_agent-b' },
          },
          MyRole: {
            Type: 'AWS::IAM::Role',
            Properties: { RoleName: 'my-role' },
          },
        },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(multiAgentSynthTemplate));

      const progressMessages: string[] = [];
      const result = await handleImport({
        source: '/tmp/config.yaml',
        onProgress: msg => progressMessages.push(msg),
      });

      expect(result.success).toBe(true);
      expect(progressMessages.some(m => m.includes('Skipping agent "agent-a"'))).toBe(true);

      const writtenSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.runtimes).toHaveLength(2);
      expect(writtenSpec.runtimes.map((a: { name: string }) => a.name)).toContain('agent-b');

      // Phase 2 should only import agent-b, not agent-a
      expect(mockExecutePhase2).toHaveBeenCalledTimes(1);
      const phase2Options = mockExecutePhase2.mock.calls[0]![0];
      const importedIds = phase2Options.resourcesToImport.map(
        (r: { resourceIdentifier: Record<string, string> }) => r.resourceIdentifier.AgentRuntimeId
      );
      expect(importedIds).toContain('rt-bbb');
      expect(importedIds).not.toContain('rt-aaa');
    });
  });

  // ── Credential Idempotency ─────────────────────────────────────────────────

  describe('credential idempotency', () => {
    it('skips credentials that already exist', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(
        makeParsedConfig({ credentials: [{ name: 'my-cred', providerType: 'api_key' as const }] })
      );

      const existingSpec = makeProjectSpec();
      (existingSpec as any).credentials = [{ authorizerType: 'ApiKeyCredentialProvider', name: 'my-cred' }];
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(existingSpec);

      const progressMessages: string[] = [];
      await handleImport({
        source: '/tmp/config.yaml',
        onProgress: msg => progressMessages.push(msg),
      });

      expect(progressMessages.some(m => m.includes('Skipping credential "my-cred"'))).toBe(true);
      const writtenSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.credentials).toHaveLength(1);
    });
  });

  // ── Source Code Copy Behavior ──────────────────────────────────────────────

  describe('source code copy on re-import', () => {
    it('copies source files for new agents during first import', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([{ name: 'main.py', isDirectory: () => false, isSymbolicLink: () => false }]);

      await handleImport({ source: '/tmp/config.yaml' });

      // On first import, the agent is new so source copy runs
      expect(mockCopyFileSync).toHaveBeenCalled();
    });

    it('runs python setup for new agents during first import', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());

      await handleImport({ source: '/tmp/config.yaml' });

      expect(mockSetupPythonProject).toHaveBeenCalledTimes(1);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles agents with no physical IDs on second import (no CFN phases)', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(
        makeParsedConfig({
          agents: [
            {
              name: 'my-agent',
              entrypoint: 'main.py',
              build: 'CodeZip' as const,
              runtimeVersion: 'PYTHON_3_12',
              language: 'python' as const,
              networkMode: 'PUBLIC' as const,
              protocol: 'HTTP' as const,
              enableOtel: true,
              // No physicalAgentId
            },
          ],
          memories: [],
        })
      );
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec([{ name: 'my-agent' }]));

      const result = await handleImport({ source: '/tmp/config.yaml' });

      expect(result.success).toBe(true);
      expect(mockExecutePhase1).not.toHaveBeenCalled();
      expect(mockExecutePhase2).not.toHaveBeenCalled();
    });

    it('returns early when no agents in YAML', async () => {
      mockParseStarterToolkitYaml.mockReturnValue({
        agents: [],
        memories: [],
        credentials: [],
        awsTarget: {},
      });
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());

      const result = await handleImport({ source: '/tmp/config.yaml' });

      assert(!result.success);
      expect(result.error.message).toContain('No agents found');
    });

    it('returns error when no project found', async () => {
      mockFindConfigRoot.mockReturnValue(null);

      const result = await handleImport({ source: '/tmp/config.yaml' });

      assert(!result.success);
      expect(result.error.message).toContain('No agentcore project found');
    });
  });

  // ── Deployment target idempotency ──────────────────────────────────────────

  describe('deployment target idempotency', () => {
    it('uses existing target on second import without creating a new one', async () => {
      mockParseStarterToolkitYaml.mockReturnValue(makeParsedConfig());
      mockConfigIOInstance.readAWSDeploymentTargets.mockResolvedValue([
        { name: 'default', account: '123456789012', region: 'us-east-1' },
      ]);
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(
        makeProjectSpec([{ name: 'my-agent' }], [{ name: 'my-memory' }])
      );

      await handleImport({ source: '/tmp/config.yaml' });

      expect(mockConfigIOInstance.writeAWSDeploymentTargets).not.toHaveBeenCalled();
    });
  });
});
