/**
 * Tests for handleImportGateway — the main gateway import flow.
 *
 * Covers:
 * - Happy path: successful import with --arn
 * - Rollback on pipeline failure and noResources
 * - Duplicate detection (name + deployed state ID)
 * - Name validation (invalid name, --name override)
 * - Auto-select / multi-gateway / no gateways
 * - Skipped targets warning
 * - Non-READY gateway warning
 */
import { handleImportGateway } from '../import-gateway';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mock fns ────────────────────────────────────────────────────────

const {
  mockFindConfigRoot,
  mockConfigIOInstance,
  MockConfigIOClass,
  mockValidateAwsCredentials,
  mockDetectAccount,
  mockGetGatewayDetail,
  mockListAllGateways,
  mockListAllGatewayTargets,
  mockGetGatewayTargetDetail,
  mockExecuteCdkImportPipeline,
} = vi.hoisted(() => {
  const inst = {
    readProjectSpec: vi.fn(),
    writeProjectSpec: vi.fn(),
    readAWSDeploymentTargets: vi.fn(),
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
    mockDetectAccount: vi.fn(),
    mockGetGatewayDetail: vi.fn(),
    mockListAllGateways: vi.fn(),
    mockListAllGatewayTargets: vi.fn(),
    mockGetGatewayTargetDetail: vi.fn(),
    mockExecuteCdkImportPipeline: vi.fn(),
  };
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: MockConfigIOClass,
  NoProjectError: class NoProjectError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'No agentcore project found');
      this.name = 'NoProjectError';
    }
  },
  findConfigRoot: (...args: unknown[]) => mockFindConfigRoot(...args),
}));

vi.mock('../../../aws/account', () => ({
  validateAwsCredentials: (...args: unknown[]) => mockValidateAwsCredentials(...args),
  detectAccount: (...args: unknown[]) => mockDetectAccount(...args),
}));

vi.mock('../../../aws/agentcore-control', () => ({
  getGatewayDetail: (...args: unknown[]) => mockGetGatewayDetail(...args),
  listAllGateways: (...args: unknown[]) => mockListAllGateways(...args),
  listAllGatewayTargets: (...args: unknown[]) => mockListAllGatewayTargets(...args),
  getGatewayTargetDetail: (...args: unknown[]) => mockGetGatewayTargetDetail(...args),
}));

vi.mock('../../../logging', () => ({
  ExecLogger: class MockExecLogger {
    startStep = vi.fn();
    endStep = vi.fn();
    log = vi.fn();
    finalize = vi.fn();
    getRelativeLogPath = vi.fn().mockReturnValue('agentcore/.cli/logs/import/import-gateway-mock.log');
    logFilePath = 'agentcore/.cli/logs/import/import-gateway-mock.log';
  },
}));

vi.mock('../import-pipeline', () => ({
  executeCdkImportPipeline: (...args: unknown[]) => mockExecuteCdkImportPipeline(...args),
}));

// ── Test Fixtures ────────────────────────────────────────────────────────────

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const GATEWAY_ID = 'gw-abc123';
const GATEWAY_ARN = `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/${GATEWAY_ID}`;
const GATEWAY_NAME = 'MyGateway';

function makeProjectSpec(gateways: any[] = []) {
  return {
    name: 'TestProject',
    version: 1,
    runtimes: [],
    memories: [],
    credentials: [],
    agentCoreGateways: gateways,
  };
}

function makeGatewayDetail(overrides?: Record<string, any>) {
  return {
    gatewayId: GATEWAY_ID,
    gatewayArn: GATEWAY_ARN,
    name: GATEWAY_NAME,
    status: 'READY',
    authorizerType: 'NONE',
    ...overrides,
  };
}

function makeTargetSummary(id: string, name: string) {
  return { targetId: id, name, status: 'READY' };
}

function makeTargetDetail(id: string, name: string, endpoint: string) {
  return {
    targetId: id,
    name,
    status: 'READY',
    targetConfiguration: {
      mcp: {
        mcpServer: { endpoint },
      },
    },
  };
}

// ── Common setup ─────────────────────────────────────────────────────────────

function setupCommonMocks() {
  mockFindConfigRoot.mockReturnValue('/tmp/project/agentcore');

  mockConfigIOInstance.readAWSDeploymentTargets.mockResolvedValue([
    { name: 'default', account: ACCOUNT, region: REGION },
  ]);

  mockValidateAwsCredentials.mockResolvedValue(undefined);
  mockDetectAccount.mockResolvedValue(ACCOUNT);

  mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec());
  mockConfigIOInstance.writeProjectSpec.mockResolvedValue(undefined);
  mockConfigIOInstance.readDeployedState.mockResolvedValue({ targets: {} });

  mockGetGatewayDetail.mockResolvedValue(makeGatewayDetail());
  mockListAllGateways.mockResolvedValue([
    { gatewayId: GATEWAY_ID, name: GATEWAY_NAME, status: 'READY', authorizerType: 'NONE' },
  ]);
  mockListAllGatewayTargets.mockResolvedValue([makeTargetSummary('tgt-1', 'target1')]);
  mockGetGatewayTargetDetail.mockResolvedValue(makeTargetDetail('tgt-1', 'target1', 'https://example.com/mcp'));

  mockExecuteCdkImportPipeline.mockResolvedValue({ success: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('handleImportGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Happy path ──────────────────────────────────────────────────────────

  describe('Happy path', () => {
    it('successfully imports a gateway with --arn', async () => {
      const result = await handleImportGateway({ arn: GATEWAY_ARN });

      assert(result.success);
      expect(result.resourceId).toBe(GATEWAY_ID);
      expect(result.resourceType).toBe('gateway');
      expect(result.resourceName).toBe(GATEWAY_NAME);

      // writeProjectSpec called once with gateway added
      expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(1);
      const writtenSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.agentCoreGateways).toHaveLength(1);
      expect(writtenSpec.agentCoreGateways[0].name).toBe(GATEWAY_NAME);
      expect(writtenSpec.agentCoreGateways[0].targets).toHaveLength(1);
    });
  });

  // ── Rollback ────────────────────────────────────────────────────────────

  describe('Rollback', () => {
    it('rolls back config on pipeline failure', async () => {
      mockExecuteCdkImportPipeline.mockResolvedValue({ success: false, error: 'Phase 2 failed' });

      const result = await handleImportGateway({ arn: GATEWAY_ARN });

      assert(!result.success);
      expect(result.error.message).toBe('Phase 2 failed');

      // First call = write merged config, second call = rollback
      expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(2);
      const rollbackSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[1]![0];
      expect(rollbackSpec.agentCoreGateways).toEqual([]);
    });

    it('rolls back config on noResources (logical ID not found)', async () => {
      mockExecuteCdkImportPipeline.mockResolvedValue({ success: true, noResources: true });

      const result = await handleImportGateway({ arn: GATEWAY_ARN });

      assert(!result.success);
      expect(result.error.message).toContain('Could not find logical ID');

      // First call = write merged config, second call = rollback
      expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(2);
      const rollbackSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[1]![0];
      expect(rollbackSpec.agentCoreGateways).toEqual([]);
    });
  });

  // ── Duplicate detection ─────────────────────────────────────────────────

  describe('Duplicate detection', () => {
    it('rejects when gateway name already exists in project', async () => {
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec([{ name: GATEWAY_NAME, targets: [] }]));

      const result = await handleImportGateway({ arn: GATEWAY_ARN });

      assert(!result.success);
      expect(result.error.message).toContain('already exists');
      expect(mockConfigIOInstance.writeProjectSpec).not.toHaveBeenCalled();
    });

    it('re-imports gateway already in deployed state but missing from agentcore.json', async () => {
      mockConfigIOInstance.readDeployedState.mockResolvedValue({
        targets: {
          default: {
            resources: {
              mcp: {
                gateways: {
                  ExistingGateway: { gatewayId: GATEWAY_ID },
                },
              },
            },
          },
        },
      });
      mockExecuteCdkImportPipeline.mockResolvedValue({ success: true, noResources: true });

      const result = await handleImportGateway({ arn: GATEWAY_ARN });

      assert(result.success);
      expect(result.resourceName).toBe('ExistingGateway');
      expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(1);
      expect(mockExecuteCdkImportPipeline).toHaveBeenCalled();
    });

    it('re-import uses --name override instead of deployed-state name', async () => {
      mockConfigIOInstance.readDeployedState.mockResolvedValue({
        targets: {
          default: {
            resources: {
              mcp: {
                gateways: {
                  ExistingGateway: { gatewayId: GATEWAY_ID },
                },
              },
            },
          },
        },
      });
      mockExecuteCdkImportPipeline.mockResolvedValue({ success: true, noResources: true });

      const result = await handleImportGateway({ arn: GATEWAY_ARN, name: 'myCustomName' });

      assert(result.success);
      expect(result.resourceName).toBe('myCustomName');
      expect(mockConfigIOInstance.writeProjectSpec).toHaveBeenCalledTimes(1);
      expect(mockExecuteCdkImportPipeline).toHaveBeenCalled();
    });

    it('rejects when gateway name AND ID both already exist in project', async () => {
      mockConfigIOInstance.readProjectSpec.mockResolvedValue(makeProjectSpec([{ name: GATEWAY_NAME, targets: [] }]));
      mockConfigIOInstance.readDeployedState.mockResolvedValue({
        targets: {
          default: {
            resources: {
              mcp: {
                gateways: {
                  [GATEWAY_NAME]: { gatewayId: GATEWAY_ID },
                },
              },
            },
          },
        },
      });

      const result = await handleImportGateway({ arn: GATEWAY_ARN });

      assert(!result.success);
      expect(result.error.message).toContain('already exists');
    });
  });

  // ── Name validation ─────────────────────────────────────────────────────

  describe('Name validation', () => {
    it('rejects invalid name with special characters', async () => {
      mockGetGatewayDetail.mockResolvedValue(makeGatewayDetail({ name: 'gateway_with_underscores!' }));

      const result = await handleImportGateway({ arn: GATEWAY_ARN });

      assert(!result.success);
      expect(result.error.message).toContain('Invalid name');
      expect(mockConfigIOInstance.writeProjectSpec).not.toHaveBeenCalled();
    });

    it('uses --name override with original resourceName preserved', async () => {
      const result = await handleImportGateway({ arn: GATEWAY_ARN, name: 'myCustomName' });

      assert(result.success);
      expect(result.resourceName).toBe('myCustomName');

      const writtenSpec = mockConfigIOInstance.writeProjectSpec.mock.calls[0]![0];
      const addedGateway = writtenSpec.agentCoreGateways[0];
      expect(addedGateway.name).toBe('myCustomName');
      expect(addedGateway.resourceName).toBe(GATEWAY_NAME);
    });
  });

  // ── Auto-select / multi-gateway ─────────────────────────────────────────

  describe('Auto-select / multi-gateway', () => {
    it('auto-selects when only 1 gateway exists and no --arn', async () => {
      mockListAllGateways.mockResolvedValue([
        { gatewayId: GATEWAY_ID, name: GATEWAY_NAME, status: 'READY', authorizerType: 'NONE' },
      ]);

      const result = await handleImportGateway({});

      assert(result.success);
      expect(result.resourceId).toBe(GATEWAY_ID);
      expect(mockGetGatewayDetail).toHaveBeenCalledWith({ region: REGION, gatewayId: GATEWAY_ID });
    });

    it('fails when multiple gateways exist and no --arn', async () => {
      mockListAllGateways.mockResolvedValue([
        { gatewayId: 'gw-1', name: 'Gateway1', status: 'READY', authorizerType: 'NONE' },
        { gatewayId: 'gw-2', name: 'Gateway2', status: 'READY', authorizerType: 'NONE' },
      ]);

      const result = await handleImportGateway({});

      assert(!result.success);
      expect(result.error.message).toContain('Multiple gateways found');
    });

    it('fails when no gateways exist and no --arn', async () => {
      mockListAllGateways.mockResolvedValue([]);

      const result = await handleImportGateway({});

      assert(!result.success);
      expect(result.error.message).toContain('No gateways found');
    });
  });

  // ── Target mapping ──────────────────────────────────────────────────────

  describe('Target mapping', () => {
    it('emits warning when some targets cannot be mapped', async () => {
      // 2 target summaries, but one has no MCP config so it will be skipped
      mockListAllGatewayTargets.mockResolvedValue([
        makeTargetSummary('tgt-1', 'goodTarget'),
        makeTargetSummary('tgt-2', 'badTarget'),
      ]);

      mockGetGatewayTargetDetail.mockImplementation((opts: { targetId: string }) => {
        if (opts.targetId === 'tgt-1') {
          return Promise.resolve(makeTargetDetail('tgt-1', 'goodTarget', 'https://example.com/mcp'));
        }
        // No MCP config => will be skipped
        return Promise.resolve({
          targetId: 'tgt-2',
          name: 'badTarget',
          status: 'READY',
          targetConfiguration: {},
        });
      });

      const progressMessages: string[] = [];
      const result = await handleImportGateway({
        arn: GATEWAY_ARN,
        onProgress: (msg: string) => progressMessages.push(msg),
      });

      assert(result.success);

      // Verify warning about unmapped targets
      expect(progressMessages.some(m => m.includes('1 target(s) could not be mapped'))).toBe(true);
    });

    it('emits warning for non-READY gateway but continues', async () => {
      mockGetGatewayDetail.mockResolvedValue(makeGatewayDetail({ status: 'CREATING' }));

      const progressMessages: string[] = [];
      const result = await handleImportGateway({
        arn: GATEWAY_ARN,
        onProgress: (msg: string) => progressMessages.push(msg),
      });

      assert(result.success);
      expect(progressMessages.some(m => m.includes('CREATING') && m.includes('not READY'))).toBe(true);
    });
  });

  // ── Re-import into existing stack (logical-ID collision) ────────────────

  describe('buildResourcesToImport — excludes already-deployed logical IDs', () => {
    it('skips deployed targets with the same Name when importing a new gateway', async () => {
      await handleImportGateway({ arn: GATEWAY_ARN });

      const pipelineInput = mockExecuteCdkImportPipeline.mock.calls[0]![0];
      const build = pipelineInput.buildResourcesToImport;

      // Deployed template already contains a gateway + target (from a prior import)
      // whose target Name collides with the one being newly imported.
      const deployedTemplate = {
        Resources: {
          OldGatewayLogicalId: {
            Type: 'AWS::BedrockAgentCore::Gateway',
            Properties: { Name: `TestProject-${GATEWAY_NAME}` },
          },
          OldTargetLogicalId: {
            Type: 'AWS::BedrockAgentCore::GatewayTarget',
            Properties: { Name: 'target1' },
          },
        },
      };

      // Synth template contains both old and new resources (same names).
      const synthTemplate = {
        Resources: {
          OldGatewayLogicalId: {
            Type: 'AWS::BedrockAgentCore::Gateway',
            Properties: { Name: `TestProject-${GATEWAY_NAME}` },
          },
          OldTargetLogicalId: {
            Type: 'AWS::BedrockAgentCore::GatewayTarget',
            Properties: { Name: 'target1' },
          },
          NewGatewayLogicalId: {
            Type: 'AWS::BedrockAgentCore::Gateway',
            Properties: { Name: `TestProject-${GATEWAY_NAME}` },
          },
          NewTargetLogicalId: {
            Type: 'AWS::BedrockAgentCore::GatewayTarget',
            Properties: { Name: 'target1' },
          },
        },
      };

      const resources = build(synthTemplate, deployedTemplate);

      const logicalIds = resources.map((r: { logicalResourceId: string }) => r.logicalResourceId);
      expect(logicalIds).toContain('NewGatewayLogicalId');
      expect(logicalIds).toContain('NewTargetLogicalId');
      expect(logicalIds).not.toContain('OldGatewayLogicalId');
      expect(logicalIds).not.toContain('OldTargetLogicalId');
    });

    it('first-ever import (empty deployed template) still resolves resources', async () => {
      await handleImportGateway({ arn: GATEWAY_ARN });

      const pipelineInput = mockExecuteCdkImportPipeline.mock.calls[0]![0];
      const build = pipelineInput.buildResourcesToImport;

      const deployedTemplate = { Resources: {} };
      const synthTemplate = {
        Resources: {
          GatewayLogicalId: {
            Type: 'AWS::BedrockAgentCore::Gateway',
            Properties: { Name: `TestProject-${GATEWAY_NAME}` },
          },
          TargetLogicalId: {
            Type: 'AWS::BedrockAgentCore::GatewayTarget',
            Properties: { Name: 'target1' },
          },
        },
      };

      const resources = build(synthTemplate, deployedTemplate);
      const logicalIds = resources.map((r: { logicalResourceId: string }) => r.logicalResourceId);
      expect(logicalIds).toEqual(['GatewayLogicalId', 'TargetLogicalId']);
    });
  });
});
