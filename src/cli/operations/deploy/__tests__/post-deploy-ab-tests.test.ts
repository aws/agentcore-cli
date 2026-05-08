import type { AgentCoreProjectSpec, DeployedResourceState } from '../../../../schema';
import { deleteOrphanedABTests, setupABTests } from '../post-deploy-ab-tests.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockCreateABTest,
  mockDeleteABTest,
  mockGetABTest,
  mockUpdateABTest,
  mockListABTests,
  mockGetCredentialProvider,
  mockIAMSend,
} = vi.hoisted(() => ({
  mockCreateABTest: vi.fn(),
  mockDeleteABTest: vi.fn(),
  mockGetABTest: vi.fn(),
  mockUpdateABTest: vi.fn(),
  mockListABTests: vi.fn(),
  mockGetCredentialProvider: vi.fn().mockReturnValue(undefined),
  mockIAMSend: vi.fn(),
}));

vi.mock('../../../aws/agentcore-ab-tests', () => ({
  createABTest: mockCreateABTest,
  deleteABTest: mockDeleteABTest,
  getABTest: mockGetABTest,
  updateABTest: mockUpdateABTest,
  listABTests: mockListABTests,
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

function makeProjectSpec(abTests: AgentCoreProjectSpec['abTests'] = []): AgentCoreProjectSpec {
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
    configBundles: [],
    httpGateways: [],
    abTests,
  };
}

const sampleABTest = {
  name: 'TestOne',
  mode: 'config-bundle' as const,
  gatewayRef: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw-123',
  variants: [
    {
      name: 'C' as const,
      weight: 80,
      variantConfiguration: { configurationBundle: { bundleArn: 'arn:bundle:control', bundleVersion: 'v1' } },
    },
    {
      name: 'T1' as const,
      weight: 20,
      variantConfiguration: { configurationBundle: { bundleArn: 'arn:bundle:treatment', bundleVersion: 'v1' } },
    },
  ],
  evaluationConfig: { onlineEvaluationConfigArn: 'arn:eval:config' },
  roleArn: 'arn:aws:iam::123456789012:role/ExistingRole',
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('setupABTests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListABTests.mockResolvedValue({ abTests: [] });
    mockUpdateABTest.mockResolvedValue({});
    mockGetABTest.mockResolvedValue({ status: 'ACTIVE', executionStatus: 'STOPPED' });
  });

  describe('creation', () => {
    it('creates new AB test when not in deployed state', async () => {
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-001', abTestArn: 'arn:abt:001' });

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([sampleABTest]),
      });

      expect(result.hasErrors).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.status).toBe('created');
      expect(result.results[0]!.abTestId).toBe('abt-001');
      expect(result.abTests.TestOne).toEqual(
        expect.objectContaining({ abTestId: 'abt-001', abTestArn: 'arn:abt:001' })
      );
    });

    it('updates already-deployed test', async () => {
      mockUpdateABTest.mockResolvedValue({ abTestId: 'abt-existing', abTestArn: 'arn:abt:existing' });

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([sampleABTest]),
        existingABTests: {
          TestOne: { abTestId: 'abt-existing', abTestArn: 'arn:abt:existing' },
        },
      });

      expect(result.results[0]!.status).toBe('updated');
      expect(mockCreateABTest).not.toHaveBeenCalled();
      expect(mockUpdateABTest).toHaveBeenCalled();
    });

    it('updates test found via API list (state loss recovery)', async () => {
      mockListABTests.mockResolvedValue({
        abTests: [{ name: 'TestOne', abTestId: 'abt-api', abTestArn: 'arn:abt:api' }],
      });
      mockUpdateABTest.mockResolvedValue({ abTestId: 'abt-api', abTestArn: 'arn:abt:api' });

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([sampleABTest]),
      });

      expect(result.results[0]!.status).toBe('updated');
      expect(result.abTests.TestOne!.abTestId).toBe('abt-api');
      expect(mockCreateABTest).not.toHaveBeenCalled();
      expect(mockUpdateABTest).toHaveBeenCalled();
    });

    it('auto-creates IAM role when roleArn not provided', async () => {
      const testWithoutRole = { ...sampleABTest, roleArn: undefined };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-002', abTestArn: 'arn:abt:002' });
      mockIAMSend.mockResolvedValue({ Role: { Arn: 'arn:aws:iam::123:role/AutoRole' } });

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([testWithoutRole]),
      });

      expect(result.results[0]!.status).toBe('created');
      expect(result.abTests.TestOne!.roleCreatedByCli).toBe(true);
      expect(mockIAMSend).toHaveBeenCalled();
    });

    it('uses provided roleArn without creating IAM role', async () => {
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-003', abTestArn: 'arn:abt:003' });

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([sampleABTest]),
      });

      expect(result.results[0]!.status).toBe('created');
      expect(result.abTests.TestOne!.roleCreatedByCli).toBe(false);
      expect(mockIAMSend).not.toHaveBeenCalled();
    });

    it('reports error when createABTest fails', async () => {
      mockCreateABTest.mockRejectedValue(new Error('API failure'));

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([sampleABTest]),
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toBe('API failure');
    });
  });

  describe('ARN resolution', () => {
    it('resolves bundle name to ARN from deployed state', async () => {
      const testWithNames = {
        ...sampleABTest,
        variants: [
          {
            name: 'C' as const,
            weight: 80,
            variantConfiguration: { configurationBundle: { bundleArn: 'my-bundle', bundleVersion: 'LATEST' } },
          },
          {
            name: 'T1' as const,
            weight: 20,
            variantConfiguration: { configurationBundle: { bundleArn: 'my-bundle', bundleVersion: 'v2' } },
          },
        ],
      };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-004', abTestArn: 'arn:abt:004' });

      await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([testWithNames]),
        deployedResources: {
          configBundles: {
            'my-bundle': { bundleArn: 'arn:bundle:resolved', versionId: 'ver-latest' },
          },
        } as unknown as DeployedResourceState,
      });

      const callArgs = mockCreateABTest.mock.calls[0]![0];
      expect(callArgs.variants[0].variantConfiguration.configurationBundle.bundleArn).toBe('arn:bundle:resolved');
      expect(callArgs.variants[0].variantConfiguration.configurationBundle.bundleVersion).toBe('ver-latest');
      expect(callArgs.variants[1].variantConfiguration.configurationBundle.bundleVersion).toBe('v2');
    });

    it('resolves gateway placeholder to ARN', async () => {
      const testWithPlaceholder = {
        ...sampleABTest,
        gatewayRef: '{{gateway:my-gw}}',
      };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-005', abTestArn: 'arn:abt:005' });

      await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([testWithPlaceholder]),
        deployedResources: {
          mcp: {
            gateways: {
              'my-gw': { gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:gateway/resolved-gw' },
            },
          },
        } as unknown as DeployedResourceState,
      });

      expect(mockCreateABTest.mock.calls[0]![0].gatewayArn).toBe(
        'arn:aws:bedrock-agentcore:us-east-1:123:gateway/resolved-gw'
      );
    });

    it('resolves gateway placeholder to ARN from HTTP gateways', async () => {
      const testWithPlaceholder = {
        ...sampleABTest,
        gatewayRef: '{{gateway:my-http-gw}}',
      };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-007', abTestArn: 'arn:abt:007' });

      await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([testWithPlaceholder]),
        deployedResources: {
          httpGateways: {
            'my-http-gw': {
              gatewayId: 'httpgw-001',
              gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:123:httpgateway/httpgw-001',
            },
          },
        } as unknown as DeployedResourceState,
      });

      expect(mockCreateABTest.mock.calls[0]![0].gatewayArn).toBe(
        'arn:aws:bedrock-agentcore:us-east-1:123:httpgateway/httpgw-001'
      );
    });

    it('resolves online eval config name to ARN', async () => {
      const testWithEvalName = {
        ...sampleABTest,
        evaluationConfig: { onlineEvaluationConfigArn: 'my-eval-config' },
      };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-006', abTestArn: 'arn:abt:006' });

      await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([testWithEvalName]),
        deployedResources: {
          onlineEvalConfigs: {
            'my-eval-config': { onlineEvaluationConfigArn: 'arn:eval:resolved' },
          },
        } as unknown as DeployedResourceState,
      });

      expect(mockCreateABTest.mock.calls[0]![0].evaluationConfig.onlineEvaluationConfigArn).toBe('arn:eval:resolved');
    });

    it('resolves target-based variant with project prefix (runtime === projectName)', async () => {
      const targetBasedTest = {
        ...sampleABTest,
        mode: 'target-based' as const,
        variants: [
          {
            name: 'C' as const,
            weight: 90,
            variantConfiguration: { target: { targetName: 'MyAgent-prod' } },
          },
          {
            name: 'T1' as const,
            weight: 10,
            variantConfiguration: { target: { targetName: 'MyAgent-staging' } },
          },
        ],
      };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-tgt-1', abTestArn: 'arn:abt:tgt1' });

      await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([targetBasedTest]),
      });

      const callArgs = mockCreateABTest.mock.calls[0]![0];
      expect(callArgs.variants[0].variantConfiguration.target.name).toBe('TestProject-MyAgent-prod');
      expect(callArgs.variants[1].variantConfiguration.target.name).toBe('TestProject-MyAgent-staging');
    });

    it('resolves target-based variant with project prefix (different project name)', async () => {
      const targetBasedTest = {
        ...sampleABTest,
        mode: 'target-based' as const,
        variants: [
          {
            name: 'C' as const,
            weight: 90,
            variantConfiguration: { target: { targetName: 'Bar-prod' } },
          },
          {
            name: 'T1' as const,
            weight: 10,
            variantConfiguration: { target: { targetName: 'Bar-staging' } },
          },
        ],
      };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-tgt-2', abTestArn: 'arn:abt:tgt2' });

      const spec = makeProjectSpec([targetBasedTest]);
      spec.name = 'Foo';

      await setupABTests({
        region: 'us-east-1',
        projectSpec: spec,
      });

      const callArgs = mockCreateABTest.mock.calls[0]![0];
      expect(callArgs.variants[0].variantConfiguration.target.name).toBe('Foo-Bar-prod');
      expect(callArgs.variants[1].variantConfiguration.target.name).toBe('Foo-Bar-staging');
    });
  });

  describe('deletion (reconciliation)', () => {
    it('stops, polls until executionStatus is STOPPED, then deletes orphaned AB test', async () => {
      const callOrder: string[] = [];
      mockUpdateABTest.mockImplementation(() => {
        callOrder.push('stop');
        return Promise.resolve({});
      });
      let getCallCount = 0;
      mockGetABTest.mockImplementation(() => {
        getCallCount++;
        callOrder.push(`poll(${getCallCount})`);
        // First poll: executionStatus not yet STOPPED (still transitioning)
        if (getCallCount === 1) return Promise.resolve({ status: 'ACTIVE', executionStatus: 'RUNNING' });
        // Second poll: executionStatus is STOPPED — done
        return Promise.resolve({ status: 'ACTIVE', executionStatus: 'STOPPED' });
      });
      mockDeleteABTest.mockImplementation(() => {
        callOrder.push('delete');
        return Promise.resolve({ success: true });
      });

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          RemovedTest: { abTestId: 'abt-old', abTestArn: 'arn:abt:old' },
        },
      });

      // Verify: stop → poll (RUNNING) → poll (STOPPED) → delete
      expect(callOrder).toEqual(['stop', 'poll(1)', 'poll(2)', 'delete']);
      expect(mockUpdateABTest).toHaveBeenCalledWith({
        region: 'us-east-1',
        abTestId: 'abt-old',
        executionStatus: 'STOPPED',
      });
      expect(result.results[0]!.status).toBe('deleted');
    });

    it('proceeds with delete when stop fails (already stopped)', async () => {
      mockUpdateABTest.mockRejectedValue(new Error('Cannot update in current state'));
      mockDeleteABTest.mockResolvedValue({ success: true });

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          RemovedTest: { abTestId: 'abt-stopped', abTestArn: 'arn:abt:stopped' },
        },
      });

      expect(mockUpdateABTest).toHaveBeenCalled();
      expect(mockDeleteABTest).toHaveBeenCalled();
      expect(result.results[0]!.status).toBe('deleted');
    });

    it('cleans up auto-created IAM role on deletion', async () => {
      mockDeleteABTest.mockResolvedValue({ success: true });
      mockIAMSend.mockResolvedValue({});

      await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          RemovedTest: {
            abTestId: 'abt-old',
            abTestArn: 'arn:abt:old',
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

    it('does not delete role when roleCreatedByCli is false', async () => {
      mockDeleteABTest.mockResolvedValue({ success: true });

      await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          RemovedTest: {
            abTestId: 'abt-old',
            abTestArn: 'arn:abt:old',
            roleArn: 'arn:aws:iam::123:role/UserRole',
            roleCreatedByCli: false,
          },
        },
      });

      expect(mockIAMSend).not.toHaveBeenCalled();
    });

    it('reports error when deletion fails', async () => {
      mockDeleteABTest.mockRejectedValue(new Error('delete failed'));

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          FailTest: { abTestId: 'abt-fail', abTestArn: 'arn:abt:fail' },
        },
      });

      expect(result.hasErrors).toBe(true);
      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toBe('delete failed');
    });

    it('sets warning when AB test was stopped before deletion', async () => {
      mockUpdateABTest.mockResolvedValue({});
      mockGetABTest.mockResolvedValue({ status: 'ACTIVE', executionStatus: 'STOPPED' });
      mockDeleteABTest.mockResolvedValue({ success: true });

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          StoppedTest: { abTestId: 'abt-warn', abTestArn: 'arn:abt:warn' },
        },
      });

      expect(result.results[0]!.status).toBe('deleted');
      expect(result.results[0]!.warning).toBe('AB test "StoppedTest" was stopped before deletion');
    });

    it('does not set warning when stop fails (already stopped)', async () => {
      mockUpdateABTest.mockRejectedValue(new Error('Cannot update'));
      mockDeleteABTest.mockResolvedValue({ success: true });

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          AlreadyStopped: { abTestId: 'abt-no-warn', abTestArn: 'arn:abt:no-warn' },
        },
      });

      expect(result.results[0]!.status).toBe('deleted');
      expect(result.results[0]!.warning).toBeUndefined();
    });

    it('proceeds with delete even when poll never reaches STOPPED (timeout)', async () => {
      mockUpdateABTest.mockResolvedValue({});
      // executionStatus never becomes STOPPED — always RUNNING
      mockGetABTest.mockResolvedValue({ status: 'ACTIVE', executionStatus: 'RUNNING' });
      mockDeleteABTest.mockResolvedValue({ success: true });

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          StuckTest: { abTestId: 'abt-stuck', abTestArn: 'arn:abt:stuck' },
        },
      });

      // Should still attempt delete after exhausting poll loop
      expect(mockDeleteABTest).toHaveBeenCalledWith({ region: 'us-east-1', abTestId: 'abt-stuck' });
      expect(result.results[0]!.status).toBe('deleted');
      // Poll was called 20 times (the loop limit)
      expect(mockGetABTest).toHaveBeenCalledTimes(20);
      // Should warn that polling timed out
      expect(result.results[0]!.warning).toBe(
        'AB test "StuckTest" did not reach STOPPED status within the polling window — proceeding with delete'
      );
    }, 120_000);

    it('sets warning even when deleteABTest returns success: false', async () => {
      mockUpdateABTest.mockResolvedValue({});
      mockGetABTest.mockResolvedValue({ status: 'ACTIVE', executionStatus: 'STOPPED' });
      mockDeleteABTest.mockResolvedValue({ success: false, error: 'still running' });

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          FailAfterStop: { abTestId: 'abt-fail-stop', abTestArn: 'arn:abt:fail-stop' },
        },
      });

      expect(result.results[0]!.status).toBe('error');
      expect(result.results[0]!.error).toBe('still running');
      // Warning should still be set because stop succeeded
      expect(result.results[0]!.warning).toBe('AB test "FailAfterStop" was stopped before deletion');
    });
  });

  describe('IAM role creation', () => {
    it('creates role with correct trust policy and inline policy', async () => {
      const testWithoutRole = { ...sampleABTest, roleArn: undefined };
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-iam', abTestArn: 'arn:abt:iam' });
      mockIAMSend.mockResolvedValue({ Role: { Arn: 'arn:aws:iam::123:role/AutoRole' } });

      await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([testWithoutRole]),
      });

      // First call: CreateRoleCommand with trust policy
      const createRoleCall = mockIAMSend.mock.calls[0]![0];
      const trustPolicy = JSON.parse(createRoleCall.input.AssumeRolePolicyDocument);
      expect(trustPolicy.Statement).toHaveLength(1);
      expect(trustPolicy.Statement[0].Principal.Service).toBe('bedrock-agentcore.amazonaws.com');
      expect(trustPolicy.Statement[0].Condition.StringEquals['aws:SourceAccount']).toBeDefined();
      expect(trustPolicy.Statement[0].Condition.ArnLike['aws:SourceArn']).toContain('ab-test/*');

      // Second call: PutRolePolicyCommand with inline policy
      const putPolicyCall = mockIAMSend.mock.calls[1]![0];
      const policy = JSON.parse(putPolicyCall.input.PolicyDocument);
      const sids = policy.Statement.map((s: { Sid: string }) => s.Sid);
      expect(sids).toContain('AgentCoreResources');
      expect(sids).toContain('CloudWatchLogs');

      // AgentCoreResources must include all required actions
      const agentCoreStmt = policy.Statement.find((s: { Sid: string }) => s.Sid === 'AgentCoreResources');
      expect(agentCoreStmt.Action).toContain('bedrock-agentcore:GetEvaluator');
      expect(agentCoreStmt.Action).toContain('bedrock-agentcore:GetGateway');
      expect(agentCoreStmt.Action).toContain('bedrock-agentcore:GetOnlineEvaluationConfig');
      expect(agentCoreStmt.Condition.StringEquals['aws:ResourceAccount']).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('proceeds with creation when listABTests fails', async () => {
      mockListABTests.mockRejectedValue(new Error('API unavailable'));
      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-new', abTestArn: 'arn:abt:new' });

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([sampleABTest]),
      });

      expect(result.results[0]!.status).toBe('created');
      expect(mockCreateABTest).toHaveBeenCalled();
    });

    it('swallows errors during IAM role deletion', async () => {
      mockDeleteABTest.mockResolvedValue({ success: true });
      mockIAMSend.mockRejectedValue(new Error('IAM permission denied'));

      const result = await deleteOrphanedABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([]),
        existingABTests: {
          OldTest: {
            abTestId: 'abt-old',
            abTestArn: 'arn:abt:old',
            roleArn: 'arn:aws:iam::123:role/SomeRole',
            roleCreatedByCli: true,
          },
        },
      });

      // Deletion should still succeed even though IAM cleanup failed
      expect(result.results[0]!.status).toBe('deleted');
    });
  });

  describe('mixed operations', () => {
    it('creates new and updates existing', async () => {
      const newTest = { ...sampleABTest, name: 'NewTest' };
      const keptTest = { ...sampleABTest, name: 'KeptTest' };

      mockCreateABTest.mockResolvedValue({ abTestId: 'abt-new', abTestArn: 'arn:abt:new' });
      mockUpdateABTest.mockResolvedValue({ abTestId: 'abt-kept', abTestArn: 'arn:abt:kept' });

      const result = await setupABTests({
        region: 'us-east-1',
        projectSpec: makeProjectSpec([newTest, keptTest]),
        existingABTests: {
          KeptTest: { abTestId: 'abt-kept', abTestArn: 'arn:abt:kept' },
        },
      });

      expect(result.results).toHaveLength(2);
      const statuses = result.results.map(r => `${r.testName}:${r.status}`);
      expect(statuses).toContain('NewTest:created');
      expect(statuses).toContain('KeptTest:updated');
    });
  });
});
