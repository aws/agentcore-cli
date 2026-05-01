import { setEnvVar } from '../../../lib';
import type { AgentCoreProjectSpec, NetworkMode } from '../../../schema';
import { DEFAULT_EPISODIC_REFLECTION_NAMESPACES, DEFAULT_STRATEGY_NAMESPACES } from '../../../schema';
import { HarnessPrimitive } from '../HarnessPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockWriteHarnessSpec = vi.fn();
const mockGetHarnessDir = vi.fn().mockReturnValue('/tmp/test/agentcore/harnesses/test');

vi.mock('../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    writeHarnessSpec = mockWriteHarnessSpec;
    getPathResolver = () => ({
      getHarnessDir: mockGetHarnessDir,
    });
    hasProject = vi.fn().mockReturnValue(true);
  },
  findConfigRoot: vi.fn().mockReturnValue('/tmp/test/agentcore'),
  setEnvVar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
}));

const baseProject: AgentCoreProjectSpec = {
  name: 'TestProject',
  version: 1,
  managedBy: 'CDK',
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
  httpGateways: [],
};

describe('HarnessPrimitive', () => {
  let primitive: HarnessPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    primitive = new HarnessPrimitive();
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockWriteHarnessSpec.mockResolvedValue(undefined);
  });

  describe('add()', () => {
    it('creates harness spec and registry entry', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      const result = await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.harnessName).toBe('testHarness');
      }

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          name: 'testHarness',
          model: {
            provider: 'bedrock',
            modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
          },
        })
      );

      expect(mockWriteProjectSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          harnesses: [{ name: 'testHarness', path: 'app/testHarness' }],
        })
      );
    });

    it('auto-creates memory entry when skipMemory is false', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      });

      expect(mockWriteProjectSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          memories: expect.arrayContaining([
            expect.objectContaining({
              name: 'testHarnessMemory',
              eventExpiryDuration: 30,
              strategies: [
                { type: 'SEMANTIC', namespaces: DEFAULT_STRATEGY_NAMESPACES.SEMANTIC },
                { type: 'USER_PREFERENCE', namespaces: DEFAULT_STRATEGY_NAMESPACES.USER_PREFERENCE },
                { type: 'SUMMARIZATION', namespaces: DEFAULT_STRATEGY_NAMESPACES.SUMMARIZATION },
                {
                  type: 'EPISODIC',
                  namespaces: DEFAULT_STRATEGY_NAMESPACES.EPISODIC,
                  reflectionNamespaces: DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
                },
              ],
            }),
          ]),
        })
      );

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          memory: { name: 'testHarnessMemory' },
        })
      );
    });

    it('sets memory reference in harness spec', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          memory: { name: 'testHarnessMemory' },
        })
      );
    });

    it('rejects duplicate harness name', async () => {
      mockReadProjectSpec.mockResolvedValue({
        ...baseProject,
        harnesses: [{ name: 'testHarness', path: './harnesses/testHarness' }],
      });

      const result = await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('already exists');
      }
    });

    it('skips memory when skipMemory is true', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        skipMemory: true,
      });

      expect(mockWriteProjectSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          memories: [],
        })
      );

      const harnessSpec = mockWriteHarnessSpec.mock.calls[0]![1];
      expect(harnessSpec).not.toHaveProperty('memory');
    });

    it('includes execution limits in harness spec', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        maxIterations: 10,
        maxTokens: 4096,
        timeoutSeconds: 300,
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          maxIterations: 10,
          maxTokens: 4096,
          timeoutSeconds: 300,
        })
      );
    });

    it('includes truncation strategy in harness spec', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        truncationStrategy: 'sliding_window',
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          truncation: {
            strategy: 'sliding_window',
          },
        })
      );
    });

    it('includes network config for VPC mode', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        networkMode: 'VPC' as NetworkMode,
        subnets: ['subnet-123', 'subnet-456'],
        securityGroups: ['sg-789'],
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          networkMode: 'VPC',
          networkConfig: {
            subnets: ['subnet-123', 'subnet-456'],
            securityGroups: ['sg-789'],
          },
        })
      );
    });

    it('includes lifecycle config when provided', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        idleTimeout: 600,
        maxLifetime: 3600,
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          lifecycleConfig: {
            idleRuntimeSessionTimeout: 600,
            maxLifetime: 3600,
          },
        })
      );
    });

    it('includes API key ARN for non-Bedrock providers', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'open_ai',
        modelId: 'gpt-4',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key',
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          model: {
            provider: 'open_ai',
            modelId: 'gpt-4',
            apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key',
          },
        })
      );
    });

    it('includes system prompt when provided', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        systemPrompt: 'You are a helpful assistant.',
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          systemPrompt: 'You are a helpful assistant.',
        })
      );
    });

    it('sets containerUri in harness spec', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        containerUri: '123456789012.dkr.ecr.us-west-2.amazonaws.com/my-harness:latest',
      });

      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          containerUri: '123456789012.dkr.ecr.us-west-2.amazonaws.com/my-harness:latest',
        })
      );
    });

    it('copies Dockerfile and sets dockerfile field in harness spec', async () => {
      const { copyFile, mkdir } = await import('fs/promises');
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        dockerfilePath: '/some/path/Dockerfile',
      });

      expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('app/testHarness'), { recursive: true });
      expect(copyFile).toHaveBeenCalledWith(
        '/some/path/Dockerfile',
        expect.stringContaining('app/testHarness/Dockerfile')
      );
      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          dockerfile: 'Dockerfile',
        })
      );
    });

    it('returns error when Dockerfile does not exist', async () => {
      const { access } = await import('fs/promises');
      vi.mocked(access).mockRejectedValueOnce(new Error('ENOENT'));
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      const result = await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        dockerfilePath: '/nonexistent/Dockerfile',
      });

      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain('Dockerfile not found at');
    });

    it('includes authorizerType AWS_IAM in harness spec', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      const result = await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        authorizerType: 'AWS_IAM',
      });

      expect(result.success).toBe(true);
      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          authorizerType: 'AWS_IAM',
        })
      );
      // AWS_IAM should NOT have authorizerConfiguration
      const harnessSpec = mockWriteHarnessSpec.mock.calls[0]![1];
      expect(harnessSpec).not.toHaveProperty('authorizerConfiguration');
    });

    it('includes CUSTOM_JWT auth config in harness spec', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      const result = await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        authorizerType: 'CUSTOM_JWT',
        jwtConfig: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
        },
      });

      expect(result.success).toBe(true);
      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'testHarness',
        expect.objectContaining({
          authorizerType: 'CUSTOM_JWT',
          authorizerConfiguration: {
            customJwtAuthorizer: {
              discoveryUrl: 'https://example.com/.well-known/openid-configuration',
              allowedAudience: ['aud1'],
            },
          },
        })
      );
    });

    it('creates managed OAuth credential when clientId and clientSecret provided', async () => {
      // First call returns the base project (for add),
      // second call returns updated project with the harness (for createManagedOAuthCredential)
      const projectAfterHarness = {
        ...JSON.parse(JSON.stringify(baseProject)),
        harnesses: [{ name: 'testHarness', path: 'app/testHarness' }],
      };
      mockReadProjectSpec
        .mockResolvedValueOnce(JSON.parse(JSON.stringify(baseProject)))
        .mockResolvedValueOnce(projectAfterHarness);

      const result = await primitive.add({
        name: 'testHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        authorizerType: 'CUSTOM_JWT',
        jwtConfig: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          clientId: 'my-client-id',
          clientSecret: 'my-client-secret',
        },
      });

      expect(result.success).toBe(true);

      // writeProjectSpec called twice: once for harness, once for credential
      expect(mockWriteProjectSpec).toHaveBeenCalledTimes(2);

      // Second call should include the managed OAuth credential
      const secondCallSpec = mockWriteProjectSpec.mock.calls[1]![0] as AgentCoreProjectSpec;
      expect(secondCallSpec.credentials).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorizerType: 'OAuthCredentialProvider',
            name: 'testHarness-oauth',
            discoveryUrl: 'https://example.com/.well-known/openid-configuration',
            vendor: 'CustomOauth2',
            managed: true,
            usage: 'inbound',
          }),
        ])
      );

      // setEnvVar should have been called for client ID and secret
      expect(setEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_TESTHARNESS_OAUTH_CLIENT_ID', 'my-client-id');
      expect(setEnvVar).toHaveBeenCalledWith(
        'AGENTCORE_CREDENTIAL_TESTHARNESS_OAUTH_CLIENT_SECRET',
        'my-client-secret'
      );
    });
  });

  describe('parseContainerFlag()', () => {
    it('returns empty for undefined', () => {
      expect(primitive.parseContainerFlag(undefined)).toEqual({});
    });

    it('detects Dockerfile paths ending with Dockerfile', () => {
      expect(primitive.parseContainerFlag('./Dockerfile')).toEqual({ dockerfilePath: './Dockerfile' });
      expect(primitive.parseContainerFlag('/abs/path/Dockerfile')).toEqual({ dockerfilePath: '/abs/path/Dockerfile' });
    });

    it('detects .dockerfile extension', () => {
      expect(primitive.parseContainerFlag('custom.dockerfile')).toEqual({ dockerfilePath: 'custom.dockerfile' });
    });

    it('detects relative paths', () => {
      expect(primitive.parseContainerFlag('./my-image/Dockerfile.prod')).toEqual({
        dockerfilePath: './my-image/Dockerfile.prod',
      });
      expect(primitive.parseContainerFlag('../Dockerfile')).toEqual({ dockerfilePath: '../Dockerfile' });
    });

    it('treats ECR URIs as containerUri', () => {
      const uri = '123456789012.dkr.ecr.us-west-2.amazonaws.com/my-harness:latest';
      expect(primitive.parseContainerFlag(uri)).toEqual({ containerUri: uri });
    });

    it('treats non-path strings as containerUri', () => {
      expect(primitive.parseContainerFlag('my-harness:latest')).toEqual({ containerUri: 'my-harness:latest' });
    });
  });

  describe('remove()', () => {
    it('removes harness from registry', async () => {
      const { rm } = await import('fs/promises');

      mockReadProjectSpec.mockResolvedValue({
        ...baseProject,
        harnesses: [{ name: 'testHarness', path: './harnesses/testHarness' }],
      });

      const result = await primitive.remove('testHarness');

      expect(result.success).toBe(true);
      expect(mockWriteProjectSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          harnesses: [],
          configBundles: [],
          abTests: [],
          httpGateways: [],
        })
      );
      expect(rm).toHaveBeenCalledWith('/tmp/test/agentcore/harnesses/test', { recursive: true, force: true });
    });

    it('errors for nonexistent harness', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      const result = await primitive.remove('nonexistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });
  });

  describe('getRemovable()', () => {
    it('returns all registered harnesses', async () => {
      mockReadProjectSpec.mockResolvedValue({
        ...baseProject,
        harnesses: [
          { name: 'harness1', path: './harnesses/harness1' },
          { name: 'harness2', path: './harnesses/harness2' },
        ],
      });

      const removable = await primitive.getRemovable();

      expect(removable).toEqual([{ name: 'harness1' }, { name: 'harness2' }]);
    });

    it('returns empty array when no harnesses exist', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      const removable = await primitive.getRemovable();

      expect(removable).toEqual([]);
    });
  });
});
