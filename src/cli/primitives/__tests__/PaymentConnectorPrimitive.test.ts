import type { AgentCoreProjectSpec } from '../../../schema';
import { PaymentConnectorPrimitive } from '../PaymentConnectorPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockSetEnvVar, mockRemoveEnvVars, mockReadProjectSpec, mockWriteProjectSpec } = vi.hoisted(() => ({
  mockSetEnvVar: vi.fn().mockResolvedValue(undefined),
  mockRemoveEnvVars: vi.fn().mockResolvedValue(undefined),
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.readProjectSpec = mockReadProjectSpec;
    this.writeProjectSpec = mockWriteProjectSpec;
  });
  return {
    ConfigIO: MockConfigIO,
    findConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: mockSetEnvVar,
    removeEnvVars: mockRemoveEnvVars,
    toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    serializeResult: (r: unknown) => r,
    ResourceNotFoundError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ResourceNotFoundError';
      }
    },
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<AgentCoreProjectSpec> = {}): AgentCoreProjectSpec {
  return {
    name: 'test-project',
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

function makeManager(
  name: string,
  connectors: { name: string; provider: 'CoinbaseCDP' | 'StripePrivy'; credentialName: string }[] = []
) {
  return {
    name,
    authorizerType: 'AWS_IAM' as const,
    autoPayment: true,
    defaultSpendLimit: '10.00',
    connectors,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PaymentConnectorPrimitive', () => {
  let primitive: PaymentConnectorPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    primitive = new PaymentConnectorPrimitive();
  });

  // ── add() ──────────────────────────────────────────────────────────────────

  describe('add()', () => {
    describe('CoinbaseCDP happy path', () => {
      it('returns success with correct names', async () => {
        mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makeManager('mgr1')] }));

        const result = await primitive.add({
          manager: 'mgr1',
          name: 'conn1',
          provider: 'CoinbaseCDP',
          apiKeyId: 'key-id',
          apiKeySecret: 'key-secret',
          walletSecret: 'wallet-secret',
        });

        expect(result.success).toBe(true);
        if (!result.success) throw new Error('expected success');
        expect(result.connectorName).toBe('conn1');
        expect(result.managerName).toBe('mgr1');
        expect(result.credentialName).toBe('mgr1-conn1-cdp');
      });

      it('writes all 3 CoinbaseCDP env vars', async () => {
        mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makeManager('mgr1')] }));

        await primitive.add({
          manager: 'mgr1',
          name: 'conn1',
          provider: 'CoinbaseCDP',
          apiKeyId: 'key-id',
          apiKeySecret: 'key-secret',
          walletSecret: 'wallet-secret',
        });

        expect(mockSetEnvVar).toHaveBeenCalledTimes(3);
        expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MGR1_CONN1_CDP_API_KEY_ID', 'key-id');
        expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MGR1_CONN1_CDP_API_KEY_SECRET', 'key-secret');
        expect(mockSetEnvVar).toHaveBeenCalledWith(
          'AGENTCORE_CREDENTIAL_MGR1_CONN1_CDP_WALLET_SECRET',
          'wallet-secret'
        );
      });

      it('writes env vars BEFORE writeProjectSpec', async () => {
        mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makeManager('mgr1')] }));

        const callOrder: string[] = [];
        mockSetEnvVar.mockImplementation(() => {
          callOrder.push('setEnvVar');
          return Promise.resolve();
        });
        mockWriteProjectSpec.mockImplementation(() => {
          callOrder.push('writeProjectSpec');
          return Promise.resolve();
        });

        await primitive.add({
          manager: 'mgr1',
          name: 'conn1',
          provider: 'CoinbaseCDP',
          apiKeyId: 'key-id',
          apiKeySecret: 'key-secret',
          walletSecret: 'wallet-secret',
        });

        const firstWrite = callOrder.indexOf('writeProjectSpec');
        const lastEnvVar = callOrder.lastIndexOf('setEnvVar');
        expect(lastEnvVar).toBeLessThan(firstWrite);
      });

      it('writes connector into manager and credential into spec', async () => {
        mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makeManager('mgr1')] }));

        await primitive.add({
          manager: 'mgr1',
          name: 'conn1',
          provider: 'CoinbaseCDP',
          apiKeyId: 'key-id',
          apiKeySecret: 'key-secret',
          walletSecret: 'wallet-secret',
        });

        expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
        const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
        const manager = writtenSpec.payments!.find(m => m.name === 'mgr1');
        expect(manager?.connectors).toHaveLength(1);
        expect(manager?.connectors[0]!.name).toBe('conn1');
        expect(manager?.connectors[0]!.provider).toBe('CoinbaseCDP');
        expect(manager?.connectors[0]!.credentialName).toBe('mgr1-conn1-cdp');
        expect(writtenSpec.credentials).toHaveLength(1);
        expect(writtenSpec.credentials[0]!.name).toBe('mgr1-conn1-cdp');
      });
    });

    describe('StripePrivy happy path', () => {
      it('writes 4 env vars for StripePrivy', async () => {
        mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makeManager('mgr1')] }));

        const result = await primitive.add({
          manager: 'mgr1',
          name: 'sp-conn',
          provider: 'StripePrivy',
          appId: 'app-123',
          appSecret: 'app-secret-456',
          authorizationPrivateKey: 'priv-key-789',
          authorizationId: 'auth-id-abc',
        });

        expect(result.success).toBe(true);
        expect(mockSetEnvVar).toHaveBeenCalledTimes(4);
        expect(mockSetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MGR1_SP_CONN_STRIPE_PRIVY_APP_ID', 'app-123');
        expect(mockSetEnvVar).toHaveBeenCalledWith(
          'AGENTCORE_CREDENTIAL_MGR1_SP_CONN_STRIPE_PRIVY_APP_SECRET',
          'app-secret-456'
        );
        expect(mockSetEnvVar).toHaveBeenCalledWith(
          'AGENTCORE_CREDENTIAL_MGR1_SP_CONN_STRIPE_PRIVY_AUTHORIZATION_PRIVATE_KEY',
          'priv-key-789'
        );
        expect(mockSetEnvVar).toHaveBeenCalledWith(
          'AGENTCORE_CREDENTIAL_MGR1_SP_CONN_STRIPE_PRIVY_AUTHORIZATION_ID',
          'auth-id-abc'
        );
      });

      it('uses "stripe-privy" suffix for credentialName', async () => {
        mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makeManager('mgr1')] }));

        const result = await primitive.add({
          manager: 'mgr1',
          name: 'sp-conn',
          provider: 'StripePrivy',
          appId: 'app-123',
          appSecret: 'app-secret-456',
          authorizationPrivateKey: 'priv-key-789',
          authorizationId: 'auth-id-abc',
        });

        if (!result.success) throw new Error('expected success');
        expect(result.credentialName).toBe('mgr1-sp-conn-stripe-privy');
      });
    });

    describe('error cases', () => {
      it('returns error when manager does not exist', async () => {
        mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [] }));

        const result = await primitive.add({
          manager: 'non-existent',
          name: 'conn1',
          provider: 'CoinbaseCDP',
          apiKeyId: 'k',
          apiKeySecret: 's',
          walletSecret: 'w',
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toContain('"non-existent"');
          expect(result.error.message).toContain('not found');
        }
        expect(mockSetEnvVar).not.toHaveBeenCalled();
        expect(mockWriteProjectSpec).not.toHaveBeenCalled();
      });

      it('returns error for duplicate connector name within same manager', async () => {
        mockReadProjectSpec.mockResolvedValue(
          makeProject({
            payments: [
              makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
            ],
          })
        );

        const result = await primitive.add({
          manager: 'mgr1',
          name: 'conn1',
          provider: 'CoinbaseCDP',
          apiKeyId: 'k',
          apiKeySecret: 's',
          walletSecret: 'w',
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.message).toContain('"conn1"');
          expect(result.error.message).toContain('already exists');
          expect(result.error.message).toContain('"mgr1"');
        }
        expect(mockSetEnvVar).not.toHaveBeenCalled();
        expect(mockWriteProjectSpec).not.toHaveBeenCalled();
      });
    });
  });

  // ── remove() ──────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('auto-resolves manager when connector exists in exactly one manager', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
          ],
          credentials: [
            { authorizerType: 'PaymentCredentialProvider', name: 'mgr1-conn1-cdp', provider: 'CoinbaseCDP' },
          ],
        })
      );

      const result = await primitive.remove('conn1');

      expect(result.success).toBe(true);
      expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.payments![0]!.connectors).toHaveLength(0);
    });

    it('returns error when connector exists in multiple managers (ambiguous)', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
            makeManager('mgr2', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr2-conn1-cdp' }]),
          ],
          credentials: [
            { authorizerType: 'PaymentCredentialProvider', name: 'mgr1-conn1-cdp', provider: 'CoinbaseCDP' },
            { authorizerType: 'PaymentCredentialProvider', name: 'mgr2-conn1-cdp', provider: 'CoinbaseCDP' },
          ],
        })
      );

      const result = await primitive.remove('conn1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('exists in multiple managers');
        expect(result.error.message).toContain('mgr1');
        expect(result.error.message).toContain('mgr2');
        expect(result.error.message).toContain('--manager');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('removes orphaned credential from spec and cleans up env vars', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
          ],
          credentials: [
            { authorizerType: 'PaymentCredentialProvider', name: 'mgr1-conn1-cdp', provider: 'CoinbaseCDP' },
          ],
        })
      );

      const result = await primitive.remove('conn1');

      expect(result.success).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      // Credential removed from spec
      expect(written.credentials).toHaveLength(0);
      // Env vars cleaned up
      expect(mockRemoveEnvVars).toHaveBeenCalledTimes(1);
      expect(mockRemoveEnvVars).toHaveBeenCalledWith(
        expect.arrayContaining([
          'AGENTCORE_CREDENTIAL_MGR1_CONN1_CDP_API_KEY_ID',
          'AGENTCORE_CREDENTIAL_MGR1_CONN1_CDP_API_KEY_SECRET',
          'AGENTCORE_CREDENTIAL_MGR1_CONN1_CDP_WALLET_SECRET',
        ])
      );
    });

    it('keeps shared credential in spec when still referenced by another connector', async () => {
      // Both connectors in different managers share the same credentialName
      const sharedCred = 'shared-cred';
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: sharedCred }]),
            makeManager('mgr2', [{ name: 'conn2', provider: 'CoinbaseCDP', credentialName: sharedCred }]),
          ],
          credentials: [{ authorizerType: 'PaymentCredentialProvider', name: sharedCred, provider: 'CoinbaseCDP' }],
        })
      );

      // Remove conn1 from mgr1 using composite key
      const result = await primitive.remove('mgr1/conn1');

      expect(result.success).toBe(true);
      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      // Credential kept because mgr2/conn2 still references it
      expect(written.credentials).toHaveLength(1);
      expect(written.credentials[0]!.name).toBe(sharedCred);
      // No env var cleanup
      expect(mockRemoveEnvVars).not.toHaveBeenCalled();
    });
  });

  // ── previewRemove() ────────────────────────────────────────────────────────

  describe('previewRemove()', () => {
    it('correctly excludes the target connector when computing stillReferenced', async () => {
      // Only one connector references this credential — previewRemove should
      // report it as orphaned (not shared), even though the connector is still
      // in the spec during the preview pass.
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
          ],
          credentials: [
            { authorizerType: 'PaymentCredentialProvider', name: 'mgr1-conn1-cdp', provider: 'CoinbaseCDP' },
          ],
        })
      );

      const preview = await primitive.previewRemove('mgr1/conn1');

      const credRemovalMsg = preview.summary.find(s => s.includes('will also be removed'));
      expect(credRemovalMsg).toBeDefined();
      expect(credRemovalMsg).toContain('mgr1-conn1-cdp');
    });

    it('reports credential as shared when another connector still references it', async () => {
      const sharedCred = 'shared-cred';
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: sharedCred }]),
            makeManager('mgr2', [{ name: 'conn2', provider: 'CoinbaseCDP', credentialName: sharedCred }]),
          ],
          credentials: [{ authorizerType: 'PaymentCredentialProvider', name: sharedCred, provider: 'CoinbaseCDP' }],
        })
      );

      const preview = await primitive.previewRemove('mgr1/conn1');

      const sharedMsg = preview.summary.find(s => s.includes('shared') && s.includes('kept'));
      expect(sharedMsg).toBeDefined();
    });

    it('includes the target connector in the summary', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
          ],
          credentials: [
            { authorizerType: 'PaymentCredentialProvider', name: 'mgr1-conn1-cdp', provider: 'CoinbaseCDP' },
          ],
        })
      );

      const preview = await primitive.previewRemove('conn1');

      expect(preview.summary[0]).toContain('conn1');
      expect(preview.summary[0]).toContain('mgr1');
    });

    it('includes a schema change entry for agentcore.json', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
          ],
          credentials: [
            { authorizerType: 'PaymentCredentialProvider', name: 'mgr1-conn1-cdp', provider: 'CoinbaseCDP' },
          ],
        })
      );

      const preview = await primitive.previewRemove('conn1');

      expect(preview.schemaChanges).toHaveLength(1);
      expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
      const after = preview.schemaChanges[0]!.after as AgentCoreProjectSpec;
      expect(after.payments![0]!.connectors).toHaveLength(0);
    });

    it('throws when connector is not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject({ payments: [makeManager('mgr1')] }));

      await expect(primitive.previewRemove('does-not-exist')).rejects.toThrow('not found');
    });

    it('throws when connector exists in multiple managers without a composite key', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject({
          payments: [
            makeManager('mgr1', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr1-conn1-cdp' }]),
            makeManager('mgr2', [{ name: 'conn1', provider: 'CoinbaseCDP', credentialName: 'mgr2-conn1-cdp' }]),
          ],
        })
      );

      await expect(primitive.previewRemove('conn1')).rejects.toThrow('exists in multiple managers');
    });
  });
});
