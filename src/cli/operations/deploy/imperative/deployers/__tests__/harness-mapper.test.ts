import type { DeployedResourceState, Memory } from '../../../../../../schema';
import type { MapHarnessOptions } from '../harness-mapper';
import { mapHarnessSpecToCreateOptions } from '../harness-mapper';
import { describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockImplementation((path: string) => {
    if (path.includes('system-prompt.md')) return Promise.resolve('You are helpful.');
    if (path.includes('custom-prompt.md')) return Promise.resolve('Custom prompt content.');
    return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  }),
  stat: vi.fn().mockImplementation((path: string) => {
    if (path.includes('too-large.md')) return Promise.resolve({ size: 2 * 1024 * 1024 });
    return Promise.resolve({ size: 100 });
  }),
}));

function baseOptions(overrides: Partial<MapHarnessOptions> = {}): MapHarnessOptions {
  return {
    harnessSpec: {
      name: 'test-harness',
      model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet' },
      tools: [],
      skills: [],
    } as any,
    harnessDir: '/project/harnesses/test-harness',
    executionRoleArn: 'arn:aws:iam::111:role/HarnessRole',
    region: 'us-east-1',
    projectName: 'my-project',
    ...overrides,
  };
}

describe('mapHarnessSpecToCreateOptions', () => {
  describe('basic mapping', () => {
    it('sets harnessName as projectName_specName', async () => {
      const result = await mapHarnessSpecToCreateOptions(baseOptions());
      expect(result.harnessName).toBe('my-project_test-harness');
    });

    it('passes region and executionRoleArn', async () => {
      const result = await mapHarnessSpecToCreateOptions(baseOptions());
      expect(result.region).toBe('us-east-1');
      expect(result.executionRoleArn).toBe('arn:aws:iam::111:role/HarnessRole');
    });
  });

  describe('model mapping', () => {
    it('maps bedrock provider', async () => {
      const result = await mapHarnessSpecToCreateOptions(baseOptions());
      expect(result.model).toEqual({
        bedrockModelConfig: { modelId: 'anthropic.claude-3-5-sonnet' },
      });
    });

    it('maps open_ai provider with apiKeyArn', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'oai',
          model: {
            provider: 'open_ai',
            modelId: 'gpt-4o',
            apiKeyArn: 'arn:aws:secretsmanager:us-east-1:111:secret:key',
          },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        openAiModelConfig: { modelId: 'gpt-4o', apiKeyArn: 'arn:aws:secretsmanager:us-east-1:111:secret:key' },
      });
    });

    it('maps gemini provider with topK', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'gem',
          model: { provider: 'gemini', modelId: 'gemini-2.0-flash', topK: 0.5 },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        geminiModelConfig: { modelId: 'gemini-2.0-flash', topK: 0.5 },
      });
    });

    it('maps bedrock with apiFormat responses', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'openai.gpt-oss-120b', apiFormat: 'responses' },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        bedrockModelConfig: { modelId: 'openai.gpt-oss-120b', apiFormat: 'responses' },
      });
    });

    it('maps bedrock with apiFormat chat_completions', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'openai.gpt-oss-120b', apiFormat: 'chat_completions' },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        bedrockModelConfig: { modelId: 'openai.gpt-oss-120b', apiFormat: 'chat_completions' },
      });
    });

    it('omits apiFormat when converse_stream (default)', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude', apiFormat: 'converse_stream' },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        bedrockModelConfig: { modelId: 'claude' },
      });
    });

    it('maps open_ai with apiFormat chat_completions', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: {
            provider: 'open_ai',
            modelId: 'gpt-5',
            apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key',
            apiFormat: 'chat_completions',
          },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        openAiModelConfig: {
          modelId: 'gpt-5',
          apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key',
          apiFormat: 'chat_completions',
        },
      });
    });

    it('omits apiFormat for open_ai when responses (default)', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: {
            provider: 'open_ai',
            modelId: 'gpt-5',
            apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key',
            apiFormat: 'responses',
          },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        openAiModelConfig: { modelId: 'gpt-5', apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key' },
      });
    });

    it('includes optional model params when set', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude', temperature: 0.7, topP: 0.9, maxTokens: 2048 },
          tools: [],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.model).toEqual({
        bedrockModelConfig: { modelId: 'claude', temperature: 0.7, topP: 0.9, maxTokens: 2048 },
      });
    });
  });

  describe('system prompt', () => {
    it('auto-discovers system-prompt.md when no systemPrompt in spec', async () => {
      const result = await mapHarnessSpecToCreateOptions(baseOptions());
      expect(result.systemPrompt).toEqual([{ text: 'You are helpful.' }]);
    });

    it('loads from file path when systemPrompt is a relative path', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          systemPrompt: './custom-prompt.md',
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.systemPrompt).toEqual([{ text: 'Custom prompt content.' }]);
    });

    it('uses inline text when systemPrompt is not a file path', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          systemPrompt: 'Inline prompt text here',
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.systemPrompt).toEqual([{ text: 'Inline prompt text here' }]);
    });

    it('throws when prompt file exceeds max size', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          systemPrompt: './too-large.md',
        } as any,
      });
      await expect(mapHarnessSpecToCreateOptions(opts)).rejects.toThrow('too large');
    });
  });

  describe('tools mapping', () => {
    it('maps tools with type, name, and config', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [
            { type: 'remote_mcp', name: 'my-mcp', config: { remoteMcp: { url: 'https://example.com' } } },
            { type: 'agentcore_code_interpreter', name: 'code-interp' },
          ],
          skills: [],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.tools).toEqual([
        { type: 'remote_mcp', name: 'my-mcp', config: { remoteMcp: { url: 'https://example.com' } } },
        { type: 'agentcore_code_interpreter', name: 'code-interp' },
      ]);
    });

    it('omits tools when empty array', async () => {
      const result = await mapHarnessSpecToCreateOptions(baseOptions());
      expect(result.tools).toBeUndefined();
    });
  });

  describe('skills mapping', () => {
    it('maps skills as path objects', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: ['path/to/skill1', 'path/to/skill2'],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.skills).toEqual([{ path: 'path/to/skill1' }, { path: 'path/to/skill2' }]);
    });
  });

  describe('memory mapping', () => {
    it('maps memory with direct ARN', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          memory: { arn: 'arn:aws:bedrock:us-east-1:111:memory/mem-123' },
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.memory).toEqual({
        agentCoreMemoryConfiguration: { arn: 'arn:aws:bedrock:us-east-1:111:memory/mem-123' },
      });
    });

    it('resolves memory by name from deployed state', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          memory: { name: 'my-memory' },
        } as any,
        deployedResources: {
          memories: { 'my-memory': { memoryArn: 'arn:aws:bedrock:us-east-1:111:memory/mem-resolved' } },
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.memory).toEqual({
        agentCoreMemoryConfiguration: { arn: 'arn:aws:bedrock:us-east-1:111:memory/mem-resolved' },
      });
    });

    it('throws when memory name cannot be resolved', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          memory: { name: 'missing-memory' },
        } as any,
      });
      await expect(mapHarnessSpecToCreateOptions(opts)).rejects.toThrow('not in deployed state');
    });

    it('includes retrievalConfig derived from memory strategy namespaces', async () => {
      const deployedResources: DeployedResourceState = {
        memories: {
          my_memory: {
            memoryId: 'mem-123',
            memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          },
        },
      };
      const memorySpec: Memory = {
        name: 'my_memory',
        eventExpiryDuration: 30,
        strategies: [
          { type: 'SEMANTIC', namespaces: ['/users/{actorId}/facts'] },
          { type: 'USER_PREFERENCE', namespaces: ['/users/{actorId}/preferences'] },
          { type: 'SUMMARIZATION', namespaces: ['/summaries/{actorId}/{sessionId}'] },
          {
            type: 'EPISODIC',
            namespaces: ['/episodes/{actorId}/{sessionId}'],
            reflectionNamespaces: ['/episodes/{actorId}'],
          },
        ],
      };

      const result = await mapHarnessSpecToCreateOptions(
        baseOptions({
          harnessSpec: {
            name: 'h',
            model: { provider: 'bedrock', modelId: 'claude' },
            tools: [],
            skills: [],
            memory: { name: 'my_memory' },
          } as any,
          deployedResources,
          memorySpec,
        })
      );

      expect(result.memory).toEqual({
        agentCoreMemoryConfiguration: {
          arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          retrievalConfig: {
            '/users/{actorId}/facts': {},
            '/users/{actorId}/preferences': {},
            '/summaries/{actorId}/{sessionId}': {},
            '/episodes/{actorId}/{sessionId}': {},
            '/episodes/{actorId}': {},
          },
        },
      });
    });

    it('includes EPISODIC reflectionNamespaces in retrievalConfig even without namespaces', async () => {
      const deployedResources: DeployedResourceState = {
        memories: {
          my_memory: {
            memoryId: 'mem-123',
            memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          },
        },
      };
      const memorySpec: Memory = {
        name: 'my_memory',
        eventExpiryDuration: 30,
        strategies: [
          { type: 'SEMANTIC' },
          {
            type: 'EPISODIC',
            reflectionNamespaces: ['/episodes/{actorId}'],
          },
        ],
      };

      const result = await mapHarnessSpecToCreateOptions(
        baseOptions({
          harnessSpec: {
            name: 'h',
            model: { provider: 'bedrock', modelId: 'claude' },
            tools: [],
            skills: [],
            memory: { name: 'my_memory' },
          } as any,
          deployedResources,
          memorySpec,
        })
      );

      expect(result.memory?.agentCoreMemoryConfiguration.retrievalConfig).toEqual({
        '/episodes/{actorId}': {},
      });
    });

    it('omits retrievalConfig when strategies have no namespaces or reflectionNamespaces', async () => {
      const deployedResources: DeployedResourceState = {
        memories: {
          my_memory: {
            memoryId: 'mem-123',
            memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          },
        },
      };
      const memorySpec: Memory = {
        name: 'my_memory',
        eventExpiryDuration: 30,
        strategies: [{ type: 'SEMANTIC' }, { type: 'SUMMARIZATION' }],
      };

      const result = await mapHarnessSpecToCreateOptions(
        baseOptions({
          harnessSpec: {
            name: 'h',
            model: { provider: 'bedrock', modelId: 'claude' },
            tools: [],
            skills: [],
            memory: { name: 'my_memory' },
          } as any,
          deployedResources,
          memorySpec,
        })
      );

      expect(result.memory?.agentCoreMemoryConfiguration.retrievalConfig).toBeUndefined();
    });

    it('omits retrievalConfig when memorySpec not provided', async () => {
      const deployedResources: DeployedResourceState = {
        memories: {
          my_memory: {
            memoryId: 'mem-123',
            memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          },
        },
      };

      const result = await mapHarnessSpecToCreateOptions(
        baseOptions({
          harnessSpec: {
            name: 'h',
            model: { provider: 'bedrock', modelId: 'claude' },
            tools: [],
            skills: [],
            memory: { name: 'my_memory' },
          } as any,
          deployedResources,
        })
      );

      expect(result.memory?.agentCoreMemoryConfiguration.retrievalConfig).toBeUndefined();
    });

    it('includes both actorId and retrievalConfig when both are set', async () => {
      const deployedResources: DeployedResourceState = {
        memories: {
          my_memory: {
            memoryId: 'mem-123',
            memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          },
        },
      };
      const memorySpec: Memory = {
        name: 'my_memory',
        eventExpiryDuration: 30,
        strategies: [{ type: 'SEMANTIC', namespaces: ['/users/{actorId}/facts'] }],
      };

      const result = await mapHarnessSpecToCreateOptions(
        baseOptions({
          harnessSpec: {
            name: 'h',
            model: { provider: 'bedrock', modelId: 'claude' },
            tools: [],
            skills: [],
            memory: { name: 'my_memory', actorId: 'alice' },
          } as any,
          deployedResources,
          memorySpec,
        })
      );

      expect(result.memory).toEqual({
        agentCoreMemoryConfiguration: {
          arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          actorId: 'alice',
          retrievalConfig: {
            '/users/{actorId}/facts': {},
          },
        },
      });
    });
  });

  describe('execution limits', () => {
    it('passes through maxIterations, maxTokens, timeoutSeconds', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          maxIterations: 10,
          maxTokens: 4096,
          timeoutSeconds: 120,
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.maxIterations).toBe(10);
      expect(result.maxTokens).toBe(4096);
      expect(result.timeoutSeconds).toBe(120);
    });
  });

  describe('container artifact', () => {
    it('maps direct containerUri', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          containerUri: '111.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.environmentArtifact).toEqual({
        containerConfiguration: { containerUri: '111.dkr.ecr.us-east-1.amazonaws.com/repo:tag' },
      });
    });

    it('resolves container URI from CDK outputs for dockerfile', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'my-env',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          dockerfile: 'Dockerfile',
        } as any,
        cdkOutputs: { ApplicationHarnessMyEnvImageUriOutput123: '111.dkr.ecr.us-east-1.amazonaws.com/built:latest' },
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.environmentArtifact).toEqual({
        containerConfiguration: { containerUri: '111.dkr.ecr.us-east-1.amazonaws.com/built:latest' },
      });
    });

    it('throws when dockerfile specified but no CDK output found', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          dockerfile: 'Dockerfile',
        } as any,
        cdkOutputs: {},
      });
      await expect(mapHarnessSpecToCreateOptions(opts)).rejects.toThrow('no container URI was found');
    });
  });

  describe('environment provider', () => {
    it('maps network config', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          networkConfig: { subnets: ['subnet-1'], securityGroups: ['sg-1'] },
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.environment).toEqual({
        agentCoreRuntimeEnvironment: {
          networkConfiguration: {
            networkMode: 'VPC',
            networkModeConfig: { subnets: ['subnet-1'], securityGroups: ['sg-1'] },
          },
        },
      });
    });

    it('maps sessionStoragePath', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          sessionStoragePath: '/mnt/storage',
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.environment).toEqual({
        agentCoreRuntimeEnvironment: {
          filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/storage' } }],
        },
      });
    });

    it('maps efsAccessPoints to filesystemConfigurations', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          networkMode: 'VPC',
          networkConfig: { subnets: ['subnet-abc'], securityGroups: ['sg-abc'] },
          efsAccessPoints: [
            {
              accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',
              mountPath: '/mnt/efs',
            },
          ],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.environment?.agentCoreRuntimeEnvironment?.filesystemConfigurations).toContainEqual({
        efsAccessPoint: {
          accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',
          mountPath: '/mnt/efs',
        },
      });
    });

    it('maps s3AccessPoints to filesystemConfigurations', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          networkMode: 'VPC',
          networkConfig: { subnets: ['subnet-abc'], securityGroups: ['sg-abc'] },
          s3AccessPoints: [
            {
              accessPointArn:
                'arn:aws:s3files:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567',
              mountPath: '/mnt/s3',
            },
          ],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.environment?.agentCoreRuntimeEnvironment?.filesystemConfigurations).toContainEqual({
        s3FilesAccessPoint: {
          accessPointArn:
            'arn:aws:s3files:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567',
          mountPath: '/mnt/s3',
        },
      });
    });

    it('maps all three filesystem types together', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          networkMode: 'VPC',
          networkConfig: { subnets: ['subnet-abc'], securityGroups: ['sg-abc'] },
          sessionStoragePath: '/mnt/session',
          efsAccessPoints: [
            {
              accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0',
              mountPath: '/mnt/efs',
            },
          ],
          s3AccessPoints: [
            {
              accessPointArn:
                'arn:aws:s3files:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567',
              mountPath: '/mnt/s3',
            },
          ],
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      const fcs = result.environment?.agentCoreRuntimeEnvironment?.filesystemConfigurations as unknown[];
      expect(fcs).toHaveLength(3);
      expect(fcs[0]).toEqual({ sessionStorage: { mountPath: '/mnt/session' } });
      expect(fcs[1]).toMatchObject({ efsAccessPoint: { mountPath: '/mnt/efs' } });
      expect(fcs[2]).toMatchObject({ s3FilesAccessPoint: { mountPath: '/mnt/s3' } });
    });

    it('returns no environment when no network/lifecycle/storage', async () => {
      const result = await mapHarnessSpecToCreateOptions(baseOptions());
      expect(result.environment).toBeUndefined();
    });
  });

  describe('authorizer configuration', () => {
    it('maps custom JWT authorizer', async () => {
      const opts = baseOptions({
        harnessSpec: {
          name: 'h',
          model: { provider: 'bedrock', modelId: 'claude' },
          tools: [],
          skills: [],
          authorizerConfiguration: {
            customJwtAuthorizer: {
              discoveryUrl: 'https://example.com/.well-known/openid-configuration',
              allowedAudience: ['aud1'],
              allowedClients: ['client1'],
            },
          },
        } as any,
      });
      const result = await mapHarnessSpecToCreateOptions(opts);
      expect(result.authorizerConfiguration).toEqual({
        customJWTAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
          allowedClients: ['client1'],
        },
      });
    });
  });
});
