import type { AgentCoreProjectSpec } from '../../../schema';
import { PaymentManagerPrimitive } from '../PaymentManagerPrimitive';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();

vi.mock('../../../lib', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
  findConfigRoot: vi.fn().mockReturnValue(null),
  removeEnvVars: vi.fn().mockResolvedValue(undefined),
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  serializeResult: (r: unknown) => r,
}));

vi.mock('../templates/templateRoot', () => ({
  getTemplatePath: vi.fn().mockReturnValue('/nonexistent/template/path'),
}));

function makeProject(overrides: Partial<AgentCoreProjectSpec> = {}): AgentCoreProjectSpec {
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
    abTests: [],
    httpGateways: [],
    harnesses: [],
    payments: [],
    ...overrides,
  };
}

function makePaymentManager(
  name: string,
  connectors: { name: string; credentialName: string; provider?: 'CoinbaseCDP' | 'StripePrivy' }[] = []
) {
  return {
    name,
    authorizerType: 'AWS_IAM' as const,
    autoPayment: true,
    defaultSpendLimit: '10.00',
    connectors: connectors.map(c => ({
      name: c.name,
      credentialName: c.credentialName,
      provider: c.provider ?? ('CoinbaseCDP' as const),
    })),
  };
}

function makePaymentCredential(name: string) {
  return {
    authorizerType: 'PaymentCredentialProvider' as const,
    name,
    provider: 'CoinbaseCDP' as const,
  };
}

const primitive = new PaymentManagerPrimitive();

describe('PaymentManagerPrimitive', () => {
  afterEach(() => vi.clearAllMocks());

  describe('add()', () => {
    it('happy path with AWS_IAM — adds manager to spec and returns success', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'myManager',
        authorizerType: 'AWS_IAM',
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('managerName', 'myManager');

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.payments).toHaveLength(1);
      const manager = written.payments![0]!;
      expect(manager.name).toBe('myManager');
      expect(manager.authorizerType).toBe('AWS_IAM');
      expect(manager.connectors).toEqual([]);
      expect(manager.authorizerConfiguration).toBeUndefined();
      // Documented defaults are materialized even when not passed.
      expect(manager.autoPayment).toBe(true);
      expect(manager.defaultSpendLimit).toBe('10.00');
    });

    it('preserves an explicit autoPayment=false (not overridden by the default)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'noAutoMgr',
        authorizerType: 'AWS_IAM',
        autoPayment: false,
      });

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.payments![0]!.autoPayment).toBe(false);
    });

    it('happy path writes optional fields when provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'richManager',
        authorizerType: 'AWS_IAM',
        description: 'My payment manager',
        autoPayment: true,
        defaultSpendLimit: '50.00',
        paymentToolAllowlist: ['buy_item', 'refund'],
        networkPreferences: ['eip155:84532'],
      });

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      const manager = written.payments![0]!;
      expect(manager.description).toBe('My payment manager');
      expect(manager.autoPayment).toBe(true);
      expect(manager.defaultSpendLimit).toBe('50.00');
      expect(manager.paymentToolAllowlist).toEqual(['buy_item', 'refund']);
      expect(manager.networkPreferences).toEqual(['eip155:84532']);
    });

    it('happy path with CUSTOM_JWT and discovery URL — builds authorizerConfiguration', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'jwtManager',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedClients: ['client1', 'client2'],
        allowedAudience: ['aud1'],
        allowedScopes: ['scope1'],
      });

      expect(result.success).toBe(true);

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      const manager = written.payments![0]!;
      expect(manager.authorizerType).toBe('CUSTOM_JWT');
      expect(manager.authorizerConfiguration?.customJWTAuthorizer?.discoveryUrl).toBe(
        'https://example.com/.well-known/openid-configuration'
      );
      expect(manager.authorizerConfiguration?.customJWTAuthorizer?.allowedClients).toEqual(['client1', 'client2']);
      expect(manager.authorizerConfiguration?.customJWTAuthorizer?.allowedAudience).toEqual(['aud1']);
      expect(manager.authorizerConfiguration?.customJWTAuthorizer?.allowedScopes).toEqual(['scope1']);
    });

    it('duplicate name — returns error without writing', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makePaymentManager('existingManager')] }));

      const result = await primitive.add({
        name: 'existingManager',
        authorizerType: 'AWS_IAM',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('existingManager');
        expect(result.error.message).toContain('already exists');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('CUSTOM_JWT without discovery URL — returns error without writing', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.add({
        name: 'jwtManager',
        authorizerType: 'CUSTOM_JWT',
        // no discoveryUrl
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('--discovery-url');
        expect(result.error.message).toContain('CUSTOM_JWT');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('readProjectSpec failure — returns error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('disk read failure'));

      const result = await primitive.add({
        name: 'anyManager',
        authorizerType: 'AWS_IAM',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('disk read failure');
      }
    });
  });

  describe('remove()', () => {
    it('cascading delete — removes manager and its connectors from spec', async () => {
      const project = makeProject({
        payments: [
          makePaymentManager('managerA', [{ name: 'connA', credentialName: 'cred1' }]),
          makePaymentManager('managerB'),
        ],
        credentials: [makePaymentCredential('cred1')],
      });
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('managerA');

      expect(result.success).toBe(true);

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.payments).toHaveLength(1);
      expect(written.payments![0]!.name).toBe('managerB');
      // credential no longer referenced — should be removed
      expect(written.credentials).toHaveLength(0);
    });

    it('cascading delete — removes multiple connectors and their credentials', async () => {
      const project = makeProject({
        payments: [
          makePaymentManager('bigManager', [
            { name: 'connA', credentialName: 'credA' },
            { name: 'connB', credentialName: 'credB' },
          ]),
        ],
        credentials: [makePaymentCredential('credA'), makePaymentCredential('credB')],
      });
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('bigManager');

      expect(result.success).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.payments).toHaveLength(0);
      expect(written.credentials).toHaveLength(0);
    });

    it('non-existent name — returns error without writing', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.remove('doesNotExist');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('doesNotExist');
        expect(result.error.message).toContain('not found');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('credential shared across managers — credential kept after removing one manager', async () => {
      const project = makeProject({
        payments: [
          makePaymentManager('managerA', [{ name: 'connA', credentialName: 'sharedCred' }]),
          makePaymentManager('managerB', [{ name: 'connB', credentialName: 'sharedCred' }]),
        ],
        credentials: [makePaymentCredential('sharedCred')],
      });
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('managerA');

      expect(result.success).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.payments).toHaveLength(1);
      expect(written.payments![0]!.name).toBe('managerB');
      // sharedCred still referenced by managerB — must be kept
      expect(written.credentials).toHaveLength(1);
      expect(written.credentials[0]!.name).toBe('sharedCred');
    });

    it('manager with no connectors — removes cleanly without touching credentials', async () => {
      const project = makeProject({
        payments: [makePaymentManager('emptyManager'), makePaymentManager('otherManager')],
        credentials: [makePaymentCredential('unrelatedCred')],
      });
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('emptyManager');

      expect(result.success).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.payments).toHaveLength(1);
      expect(written.payments![0]!.name).toBe('otherManager');
      expect(written.credentials).toHaveLength(1);
    });

    it('readProjectSpec failure — returns error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('io error'));

      const result = await primitive.remove('anyManager');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('io error');
      }
    });
  });

  describe('getRemovable()', () => {
    it('returns manager names from spec', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [makePaymentManager('alpha'), makePaymentManager('beta')],
        })
      );

      const result = await primitive.getRemovable();

      expect(result).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
    });

    it('returns empty array when no managers exist', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      expect(await primitive.getRemovable()).toEqual([]);
    });

    it('returns empty array on readProjectSpec error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getRemovable()).toEqual([]);
    });
  });

  describe('getExistingManagers()', () => {
    it('returns manager names as strings', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [makePaymentManager('m1'), makePaymentManager('m2')],
        })
      );

      const result = await primitive.getExistingManagers();

      expect(result).toEqual(['m1', 'm2']);
    });

    it('returns empty array on error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getExistingManagers()).toEqual([]);
    });
  });

  describe('previewRemove()', () => {
    it('returns summary and schema changes for a manager with connectors', async () => {
      const project = makeProject({
        payments: [makePaymentManager('previewManager', [{ name: 'connA', credentialName: 'credA' }])],
        credentials: [makePaymentCredential('credA')],
      });
      mockReadProjectSpec.mockResolvedValue(project);

      const preview = await primitive.previewRemove('previewManager');

      expect(preview.summary[0]).toContain('previewManager');
      expect(preview.summary.some(s => s.includes('connA'))).toBe(true);
      expect(preview.schemaChanges).toHaveLength(1);
      expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
      const after = preview.schemaChanges[0]!.after as AgentCoreProjectSpec;
      expect(after.payments).toHaveLength(0);
    });

    it('notes shared credential is kept in preview', async () => {
      const project = makeProject({
        payments: [
          makePaymentManager('mgr1', [{ name: 'connA', credentialName: 'sharedCred' }]),
          makePaymentManager('mgr2', [{ name: 'connB', credentialName: 'sharedCred' }]),
        ],
        credentials: [makePaymentCredential('sharedCred')],
      });
      mockReadProjectSpec.mockResolvedValue(project);

      const preview = await primitive.previewRemove('mgr1');

      expect(preview.summary.some(s => s.includes('kept'))).toBe(true);
    });

    it('throws when manager not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      await expect(primitive.previewRemove('missing')).rejects.toThrow('not found');
    });
  });
});
