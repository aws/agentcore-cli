import type { AgentCoreProjectSpec, DeployedResourceState, HttpGatewayDeployedState } from '../../../../schema';
import { deleteOrphanedHttpGateways, setupHttpGateways } from '../post-deploy-http-gateways.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockCreateHttpGateway,
  mockCreateHttpGatewayTarget,
  mockDeleteHttpGateway,
  mockDeleteHttpGatewayTarget,
  mockListAllHttpGateways,
  mockListHttpGatewayTargets,
  mockWaitForGatewayReady,
  mockWaitForTargetReady,
  mockGetCredentialProvider,
  mockIAMSend,
} = vi.hoisted(() => ({
  mockCreateHttpGateway: vi.fn(),
  mockCreateHttpGatewayTarget: vi.fn(),
  mockDeleteHttpGateway: vi.fn(),
  mockDeleteHttpGatewayTarget: vi.fn(),
  mockListAllHttpGateways: vi.fn(),
  mockListHttpGatewayTargets: vi.fn(),
  mockWaitForGatewayReady: vi.fn(),
  mockWaitForTargetReady: vi.fn(),
  mockGetCredentialProvider: vi.fn().mockReturnValue(undefined),
  mockIAMSend: vi.fn(),
}));

vi.mock('../../../aws/agentcore-http-gateways', () => ({
  createHttpGateway: mockCreateHttpGateway,
  createHttpGatewayTarget: mockCreateHttpGatewayTarget,
  deleteHttpGateway: mockDeleteHttpGateway,
  deleteHttpGatewayTarget: mockDeleteHttpGatewayTarget,
  listAllHttpGateways: mockListAllHttpGateways,
  listHttpGatewayTargets: mockListHttpGatewayTargets,
  waitForGatewayReady: mockWaitForGatewayReady,
  waitForTargetReady: mockWaitForTargetReady,
}));

vi.mock('../../../aws/account', () => ({
  getCredentialProvider: mockGetCredentialProvider,
}));

vi.mock('@aws-sdk/client-iam', () => ({
  IAMClient: class {
    send = mockIAMSend;
  },
  CreateRoleCommand: class {
    constructor(public input: unknown) {}
  },
  GetRoleCommand: class {
    constructor(public input: unknown) {}
  },
  PutRolePolicyCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteRolePolicyCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteRoleCommand: class {
    constructor(public input: unknown) {}
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProjectSpec(httpGateways: AgentCoreProjectSpec['httpGateways'] = []): AgentCoreProjectSpec {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    harnesses: [],
    configBundles: [],
    abTests: [],
    httpGateways,
  };
}

const sampleHttpGateway = {
  name: 'MyHttpGw',
  runtimeRef: 'my-agent',
  roleArn: 'arn:aws:iam::123456789012:role/ExistingRole',
};

const sampleDeployedResources = {
  runtimes: {
    'my-agent': {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-123',
      runtimeId: 'rt-123',
    },
  },
} as unknown as DeployedResourceState;

// ── Tests ──────────────────────────────────────────────────────────────────

describe('setupHttpGateways', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAllHttpGateways.mockResolvedValue([]);
    mockListHttpGatewayTargets.mockResolvedValue({ targets: [] });
    mockWaitForGatewayReady.mockResolvedValue({ gatewayId: 'gw-001', status: 'READY' });
    mockWaitForTargetReady.mockResolvedValue({});
  });

  describe('creation', () => {
    it('creates gateway + target for new spec entry', async () => {
      mockCreateHttpGateway.mockResolvedValue({
        gatewayId: 'gw-001',
        gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:httpgateway/gw-001',
      });
      mockCreateHttpGatewayTarget.mockResolvedValue({ targetId: 'tgt-001' });

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        deployedResources: sampleDeployedResources,
      });

      expect(result.hasErrors).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.status).toBe('created');
      expect(result.results[0]!.gatewayId).toBe('gw-001');
      expect(result.httpGateways.MyHttpGw).toEqual(
        expect.objectContaining({
          gatewayId: 'gw-001',
          gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:httpgateway/gw-001',
          targetId: 'tgt-001',
        })
      );

      expect(mockCreateHttpGateway).toHaveBeenCalledWith({
        region: 'us-east-1',
        name: 'TestProject-MyHttpGw',
        roleArn: 'arn:aws:iam::123456789012:role/ExistingRole',
      });
      expect(mockCreateHttpGatewayTarget).toHaveBeenCalledWith({
        region: 'us-east-1',
        gatewayId: 'gw-001',
        targetName: 'TestProject-my-agent',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/rt-123',
      });
    });

    it('skips existing gateway', async () => {
      const existingHttpGateways: Record<string, HttpGatewayDeployedState> = {
        MyHttpGw: {
          gatewayId: 'gw-existing',
          gatewayArn: 'arn:httpgw:existing',
          targetId: 'tgt-existing',
        },
      };

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        existingHttpGateways,
        deployedResources: sampleDeployedResources,
      });

      expect(result.results[0]!.status).toBe('skipped');
      expect(result.results[0]!.gatewayId).toBe('gw-existing');
      expect(mockCreateHttpGateway).not.toHaveBeenCalled();
      expect(mockCreateHttpGatewayTarget).not.toHaveBeenCalled();
    });

    it('finds gateway by name via list (state loss recovery)', async () => {
      mockListAllHttpGateways.mockResolvedValue([
        { name: 'TestProject-MyHttpGw', gatewayId: 'gw-api', gatewayArn: 'arn:httpgw:api' },
      ]);

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        deployedResources: sampleDeployedResources,
      });

      expect(result.results[0]!.status).toBe('skipped');
      expect(result.httpGateways.MyHttpGw!.gatewayId).toBe('gw-api');
      expect(mockCreateHttpGateway).not.toHaveBeenCalled();
    });

    it('recovers state using legacy (pre-migration) gateway name when prefixed name not found', async () => {
      // First call: prefixed name "TestProject-MyHttpGw" → not found
      // Second call: unprefixed legacy name "MyHttpGw" → found
      mockListAllHttpGateways
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ name: 'MyHttpGw', gatewayId: 'gw-legacy', gatewayArn: 'arn:httpgw:legacy' }]);

      const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        deployedResources: sampleDeployedResources,
      });

      // findHttpGatewayByName was called twice: once for prefixed, once for unprefixed name
      expect(mockListAllHttpGateways).toHaveBeenCalledTimes(2);

      // Gateway result is skipped (not created)
      expect(result.results[0]!.status).toBe('skipped');
      expect(result.results[0]!.gatewayId).toBe('gw-legacy');
      expect(result.httpGateways.MyHttpGw!.gatewayId).toBe('gw-legacy');

      // createHttpGateway was NOT called
      expect(mockCreateHttpGateway).not.toHaveBeenCalled();

      // console.warn was called with the pre-migration warning text
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pre-migration name'));

      warnSpy.mockRestore();
    });

    it('reports error on missing runtime ref', async () => {
      const emptyDeployedResources = {} as unknown as DeployedResourceState;

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        deployedResources: emptyDeployedResources,
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toContain('Runtime "my-agent" not found');
      expect(mockCreateHttpGateway).not.toHaveBeenCalled();
    });

    it('auto-creates IAM role when roleArn not provided', async () => {
      const gwWithoutRole = { ...sampleHttpGateway, roleArn: undefined };
      mockCreateHttpGateway.mockResolvedValue({
        gatewayId: 'gw-002',
        gatewayArn: 'arn:httpgw:002',
      });
      mockCreateHttpGatewayTarget.mockResolvedValue({ targetId: 'tgt-002' });
      mockIAMSend.mockResolvedValue({ Role: { Arn: 'arn:aws:iam::123:role/AutoRole' } });

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([gwWithoutRole]),
        deployedResources: sampleDeployedResources,
      });

      expect(result.results[0]!.status).toBe('created');
      expect(result.httpGateways.MyHttpGw!.roleCreatedByCli).toBe(true);
      expect(mockIAMSend).toHaveBeenCalled();

      // Verify CreateRoleCommand was sent with correct trust policy
      const createRoleCall = mockIAMSend.mock.calls[0]![0];
      const trustPolicy = JSON.parse(createRoleCall.input.AssumeRolePolicyDocument);
      expect(trustPolicy.Statement[0].Principal.Service).toBe('bedrock-agentcore.amazonaws.com');

      // Verify PutRolePolicyCommand was sent with correct inline policy actions
      const putPolicyCall = mockIAMSend.mock.calls[1]![0];
      const inlinePolicy = JSON.parse(putPolicyCall.input.PolicyDocument);
      const actions = inlinePolicy.Statement[0].Action;
      expect(actions).toContain('bedrock-agentcore:InvokeRuntime');
      expect(actions).toContain('bedrock-agentcore:InvokeAgent');
      expect(actions).toContain('bedrock-agentcore:InvokeAgentRuntime');
      expect(inlinePolicy.Statement[0].Resource).toBe('*');
    });

    it('rollback on target creation failure', async () => {
      mockCreateHttpGateway.mockResolvedValue({
        gatewayId: 'gw-rollback',
        gatewayArn: 'arn:httpgw:rollback',
      });
      mockCreateHttpGatewayTarget.mockRejectedValue(new Error('Target creation failed'));
      mockDeleteHttpGateway.mockResolvedValue({ success: true });

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        deployedResources: sampleDeployedResources,
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toContain('Target creation failed');
      expect(result.results[0]!.error).toContain('gateway rolled back');

      // Verify rollback: deleteHttpGateway was called
      expect(mockDeleteHttpGateway).toHaveBeenCalledWith({
        region: 'us-east-1',
        gatewayId: 'gw-rollback',
      });
    });
  });

  describe('deletion (reconciliation)', () => {
    it('deletes orphaned gateway not in project spec', async () => {
      mockDeleteHttpGateway.mockResolvedValue({ success: true });
      mockDeleteHttpGatewayTarget.mockResolvedValue({ success: true });

      const result = await deleteOrphanedHttpGateways({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingHttpGateways: {
          RemovedGw: {
            gatewayId: 'gw-old',
            gatewayArn: 'arn:httpgw:old',
            targetId: 'tgt-old',
          },
        },
      });

      expect(mockDeleteHttpGatewayTarget).toHaveBeenCalledWith({
        region: 'us-east-1',
        gatewayId: 'gw-old',
        targetId: 'tgt-old',
      });
      expect(mockDeleteHttpGateway).toHaveBeenCalledWith({
        region: 'us-east-1',
        gatewayId: 'gw-old',
      });
      expect(result.results[0]!.status).toBe('deleted');
    });

    it('cleans up auto-created IAM role on deletion', async () => {
      mockDeleteHttpGateway.mockResolvedValue({ success: true });
      mockIAMSend.mockResolvedValue({});

      await deleteOrphanedHttpGateways({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingHttpGateways: {
          RemovedGw: {
            gatewayId: 'gw-old',
            gatewayArn: 'arn:httpgw:old',
            roleArn: 'arn:aws:iam::123:role/AutoCreatedRole',
            roleCreatedByCli: true,
          },
        },
      });

      // Should have called delete policy + delete role
      expect(mockIAMSend).toHaveBeenCalledTimes(2);

      // Verify first call is DeleteRolePolicyCommand
      const firstCall = mockIAMSend.mock.calls[0]![0];
      expect(firstCall.input).toEqual(
        expect.objectContaining({ RoleName: 'AutoCreatedRole', PolicyName: expect.any(String) })
      );

      // Verify second call is DeleteRoleCommand
      const secondCall = mockIAMSend.mock.calls[1]![0];
      expect(secondCall.input).toEqual(expect.objectContaining({ RoleName: 'AutoCreatedRole' }));
    });

    it('reports error when deletion fails', async () => {
      mockDeleteHttpGateway.mockRejectedValue(new Error('delete failed'));

      const result = await deleteOrphanedHttpGateways({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingHttpGateways: {
          FailGw: { gatewayId: 'gw-fail', gatewayArn: 'arn:httpgw:fail' },
        },
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toBe('delete failed');
    });
  });

  describe('edge cases', () => {
    it('proceeds with creation when listHttpGateways fails', async () => {
      mockListAllHttpGateways.mockRejectedValue(new Error('API unavailable'));
      mockCreateHttpGateway.mockResolvedValue({
        gatewayId: 'gw-new',
        gatewayArn: 'arn:httpgw:new',
      });
      mockCreateHttpGatewayTarget.mockResolvedValue({ targetId: 'tgt-new' });

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        deployedResources: sampleDeployedResources,
      });

      expect(result.results[0]!.status).toBe('created');
      expect(mockCreateHttpGateway).toHaveBeenCalled();
    });

    it('uses provided roleArn without creating IAM role', async () => {
      mockCreateHttpGateway.mockResolvedValue({
        gatewayId: 'gw-003',
        gatewayArn: 'arn:httpgw:003',
      });
      mockCreateHttpGatewayTarget.mockResolvedValue({ targetId: 'tgt-003' });

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([sampleHttpGateway]),
        deployedResources: sampleDeployedResources,
      });

      expect(result.results[0]!.status).toBe('created');
      expect(result.httpGateways.MyHttpGw!.roleCreatedByCli).toBe(false);
      expect(mockIAMSend).not.toHaveBeenCalled();
    });
  });

  describe('mixed operations', () => {
    it('creates new and skips existing (orphan deletion is a separate pass)', async () => {
      const newGw = { ...sampleHttpGateway, name: 'NewGw' };
      const keptGw = { ...sampleHttpGateway, name: 'KeptGw' };

      mockCreateHttpGateway.mockResolvedValue({
        gatewayId: 'gw-new',
        gatewayArn: 'arn:httpgw:new',
      });
      mockCreateHttpGatewayTarget.mockResolvedValue({ targetId: 'tgt-new' });
      mockDeleteHttpGateway.mockResolvedValue({ success: true });

      const result = await setupHttpGateways({
        region: 'us-east-1',
        projectName: 'TestProject',
        projectSpec: makeProjectSpec([newGw, keptGw]),
        existingHttpGateways: {
          KeptGw: { gatewayId: 'gw-kept', gatewayArn: 'arn:httpgw:kept' },
          OrphanGw: { gatewayId: 'gw-orphan', gatewayArn: 'arn:httpgw:orphan' },
        },
        deployedResources: sampleDeployedResources,
      });

      expect(result.results).toHaveLength(2);
      const statuses = result.results.map(r => `${r.gatewayName}:${r.status}`);
      expect(statuses).toContain('NewGw:created');
      expect(statuses).toContain('KeptGw:skipped');
    });

    it('deleteOrphanedHttpGateways removes orphans separately', async () => {
      mockDeleteHttpGateway.mockResolvedValue({ success: true });

      const result = await deleteOrphanedHttpGateways({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([{ ...sampleHttpGateway, name: 'KeptGw' }]),
        existingHttpGateways: {
          KeptGw: { gatewayId: 'gw-kept', gatewayArn: 'arn:httpgw:kept' },
          OrphanGw: { gatewayId: 'gw-orphan', gatewayArn: 'arn:httpgw:orphan' },
        },
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.gatewayName).toBe('OrphanGw');
      expect(result.results[0]!.status).toBe('deleted');
    });
  });
});
