import type { DeployedResourceState, HarnessSpec } from '../../../../../../schema';
import { mapHarnessSpecToCreateOptions } from '../harness-mapper';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedStat = vi.mocked(stat);

beforeEach(() => {
  vi.clearAllMocks();
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  mockedStat.mockRejectedValue(enoent);
});

function minimalSpec(overrides?: Partial<HarnessSpec>): HarnessSpec {
  return {
    name: 'test_harness',
    model: { provider: 'bedrock', modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' },
    tools: [],
    skills: [],
    ...overrides,
  };
}

const BASE_OPTIONS = {
  harnessDir: '/project/agentcore/harnesses/test_harness',
  executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
  region: 'us-east-1' as const,
  projectName: 'myproject',
};

describe('mapHarnessSpecToCreateOptions', () => {
  // ── Model mapping ──────────────────────────────────────────────────────

  describe('model mapping', () => {
    it('maps bedrock provider with temperature, topP, and maxTokens', async () => {
      const spec = minimalSpec({
        model: {
          provider: 'bedrock',
          modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 4096,
        },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.model).toEqual({
        bedrockModelConfig: {
          modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 4096,
        },
      });
    });

    it('maps open_ai provider with apiKeyArn', async () => {
      const spec = minimalSpec({
        model: {
          provider: 'open_ai',
          modelId: 'gpt-4o',
          apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key',
          temperature: 0.5,
          topP: 0.8,
          maxTokens: 2048,
        },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.model).toEqual({
        openAiModelConfig: {
          modelId: 'gpt-4o',
          apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:openai-key',
          temperature: 0.5,
          topP: 0.8,
          maxTokens: 2048,
        },
      });
    });

    it('maps gemini provider with topK', async () => {
      const spec = minimalSpec({
        model: {
          provider: 'gemini',
          modelId: 'gemini-1.5-pro',
          apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gemini-key',
          topK: 0.4,
          temperature: 0.3,
        },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.model).toEqual({
        geminiModelConfig: {
          modelId: 'gemini-1.5-pro',
          apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:gemini-key',
          topK: 0.4,
          temperature: 0.3,
        },
      });
    });
  });

  // ── System prompt mapping ──────────────────────────────────────────────

  describe('system prompt mapping', () => {
    it('reads system prompt from a file path starting with ./', async () => {
      mockedStat.mockResolvedValueOnce({ size: 100 } as any);
      mockedReadFile.mockResolvedValueOnce('You are a helpful assistant.');

      const spec = minimalSpec({ systemPrompt: './prompt.md' });
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(mockedReadFile).toHaveBeenCalledWith(join(BASE_OPTIONS.harnessDir, './prompt.md'), 'utf-8');
      expect(result.systemPrompt).toEqual([{ text: 'You are a helpful assistant.' }]);
    });

    it('reads system prompt from a file path starting with ../', async () => {
      mockedStat.mockResolvedValueOnce({ size: 100 } as any);
      mockedReadFile.mockResolvedValueOnce('Shared prompt content.');

      const spec = minimalSpec({ systemPrompt: '../shared/prompt.txt' });
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(mockedReadFile).toHaveBeenCalledWith(join(BASE_OPTIONS.harnessDir, '../shared/prompt.txt'), 'utf-8');
      expect(result.systemPrompt).toEqual([{ text: 'Shared prompt content.' }]);
    });

    it('rejects system prompt file exceeding 1 MB', async () => {
      mockedStat.mockResolvedValueOnce({ size: 1024 * 1024 + 1 } as any);

      const spec = minimalSpec({ systemPrompt: './huge-prompt.md' });

      await expect(mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec })).rejects.toThrow('too large');
    });

    it('treats non-path strings as literal text', async () => {
      const spec = minimalSpec({ systemPrompt: 'You are a research assistant.' });
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(result.systemPrompt).toEqual([{ text: 'You are a research assistant.' }]);
    });

    it('omits system prompt when not specified', async () => {
      const spec = minimalSpec();
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.systemPrompt).toBeUndefined();
    });
  });

  // ── Tools mapping ──────────────────────────────────────────────────────

  describe('tools mapping', () => {
    it('passes tools through with type, name, and config', async () => {
      const spec = minimalSpec({
        tools: [
          {
            type: 'remote_mcp',
            name: 'my_mcp_tool',
            config: { remoteMcp: { url: 'https://mcp.example.com' } },
          },
          {
            type: 'agentcore_browser',
            name: 'browser_tool',
          },
        ],
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.tools).toEqual([
        {
          type: 'remote_mcp',
          name: 'my_mcp_tool',
          config: { remoteMcp: { url: 'https://mcp.example.com' } },
        },
        {
          type: 'agentcore_browser',
          name: 'browser_tool',
        },
      ]);
    });

    it('omits tools when array is empty', async () => {
      const spec = minimalSpec({ tools: [] });
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.tools).toBeUndefined();
    });
  });

  // ── Skills mapping ─────────────────────────────────────────────────────

  describe('skills mapping', () => {
    it('maps string array to { path } objects', async () => {
      const spec = minimalSpec({ skills: ['research', 'summarize'] });
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.skills).toEqual([{ path: 'research' }, { path: 'summarize' }]);
    });

    it('omits skills when array is empty', async () => {
      const spec = minimalSpec({ skills: [] });
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.skills).toBeUndefined();
    });
  });

  // ── Memory mapping ─────────────────────────────────────────────────────

  describe('memory mapping', () => {
    it('resolves memory by name from deployed state', async () => {
      const deployedResources: DeployedResourceState = {
        memories: {
          my_memory: {
            memoryId: 'mem-123',
            memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
          },
        },
      };

      const spec = minimalSpec({ memory: { name: 'my_memory' } });
      const result = await mapHarnessSpecToCreateOptions({
        ...BASE_OPTIONS,
        harnessSpec: spec,
        deployedResources,
      });

      expect(result.memory).toEqual({
        memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-123',
      });
    });

    it('uses ARN directly when provided', async () => {
      const spec = minimalSpec({
        memory: { arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/custom-mem' },
      });
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.memory).toEqual({
        memoryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/custom-mem',
      });
    });

    it('throws when memory name is not found in deployed state', async () => {
      const spec = minimalSpec({ memory: { name: 'nonexistent' } });

      await expect(mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec })).rejects.toThrow(
        'Memory "nonexistent" referenced by harness is not in deployed state'
      );
    });
  });

  // ── Truncation mapping ─────────────────────────────────────────────────

  describe('truncation mapping', () => {
    it('passes through truncation configuration', async () => {
      const spec = minimalSpec({
        truncation: {
          strategy: 'sliding_window',
          config: { slidingWindow: { messagesCount: 20 } },
        },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.truncation).toEqual({
        strategy: 'sliding_window',
        config: { slidingWindow: { messagesCount: 20 } },
      });
    });
  });

  // ── Container URI mapping ──────────────────────────────────────────────

  describe('container URI mapping', () => {
    it('maps containerUri to environmentArtifact', async () => {
      const spec = minimalSpec({
        containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-harness:latest',
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.environmentArtifact).toEqual({
        containerConfiguration: {
          containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-harness:latest',
        },
      });
    });

    it('resolves containerUri from CDK outputs when dockerfile is set', async () => {
      const spec = minimalSpec({ dockerfile: 'Dockerfile' });
      const cdkOutputs = {
        HarnessTestHarnessContainerUriOutputABC123: '123456789012.dkr.ecr.us-east-1.amazonaws.com/harness-test:abc',
      };

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec, cdkOutputs });

      expect(result.environmentArtifact).toEqual({
        containerConfiguration: {
          containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/harness-test:abc',
        },
      });
    });

    it('resolves containerUri from new AgentCoreHarnessEnvironment output key', async () => {
      const spec = minimalSpec({ dockerfile: 'Dockerfile' });
      const cdkOutputs = {
        ApplicationHarnessTestHarnessImageUriOutputABC123:
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/harness-test:new',
      };

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec, cdkOutputs });

      expect(result.environmentArtifact).toEqual({
        containerConfiguration: {
          containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/harness-test:new',
        },
      });
    });

    it('prefers new ImageUri key over old ContainerUri key when both are present', async () => {
      const spec = minimalSpec({ dockerfile: 'Dockerfile' });
      const cdkOutputs = {
        ApplicationHarnessTestHarnessImageUriOutputABC123:
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/harness-test:new',
        HarnessTestHarnessContainerUriOutputDEF456: '123456789012.dkr.ecr.us-east-1.amazonaws.com/harness-test:old',
      };

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec, cdkOutputs });

      expect(result.environmentArtifact).toEqual({
        containerConfiguration: {
          containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/harness-test:new',
        },
      });
    });

    it('throws when dockerfile is set but no container URI found in CDK outputs', async () => {
      const spec = minimalSpec({ dockerfile: 'Dockerfile' });

      await expect(
        mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec, cdkOutputs: {} })
      ).rejects.toThrow('no container URI was found in CDK outputs');
    });

    it('prefers explicit containerUri over dockerfile', async () => {
      const spec = minimalSpec({
        containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/explicit:latest',
        dockerfile: undefined,
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.environmentArtifact).toEqual({
        containerConfiguration: {
          containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/explicit:latest',
        },
      });
    });
  });

  // ── Network/Lifecycle mapping ──────────────────────────────────────────

  describe('environment provider mapping', () => {
    it('maps networkConfig to environment.agentCoreRuntimeEnvironment.networkConfiguration', async () => {
      const spec = minimalSpec({
        networkMode: 'VPC',
        networkConfig: {
          subnets: ['subnet-12345678'],
          securityGroups: ['sg-12345678'],
        },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.environment).toEqual({
        agentCoreRuntimeEnvironment: {
          networkConfiguration: {
            networkMode: 'VPC',
            networkModeConfig: {
              subnets: ['subnet-12345678'],
              securityGroups: ['sg-12345678'],
            },
          },
        },
      });
    });

    it('maps lifecycleConfig to environment.agentCoreRuntimeEnvironment.lifecycleConfiguration', async () => {
      const spec = minimalSpec({
        lifecycleConfig: {
          idleRuntimeSessionTimeout: 900,
          maxLifetime: 28800,
        },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.environment).toEqual({
        agentCoreRuntimeEnvironment: {
          lifecycleConfiguration: {
            idleRuntimeSessionTimeout: 900,
            maxLifetime: 28800,
          },
        },
      });
    });

    it('combines network and lifecycle in the same environment provider', async () => {
      const spec = minimalSpec({
        networkMode: 'VPC',
        networkConfig: {
          subnets: ['subnet-12345678'],
          securityGroups: ['sg-12345678'],
        },
        lifecycleConfig: {
          idleRuntimeSessionTimeout: 600,
        },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.environment).toEqual({
        agentCoreRuntimeEnvironment: {
          networkConfiguration: {
            networkMode: 'VPC',
            networkModeConfig: {
              subnets: ['subnet-12345678'],
              securityGroups: ['sg-12345678'],
            },
          },
          lifecycleConfiguration: {
            idleRuntimeSessionTimeout: 600,
          },
        },
      });
    });

    it('omits environment when neither network nor lifecycle is present', async () => {
      const spec = minimalSpec();
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.environment).toBeUndefined();
    });
  });

  // ── Pass-through fields ────────────────────────────────────────────────

  describe('pass-through fields', () => {
    it('includes execution limits', async () => {
      const spec = minimalSpec({
        maxIterations: 10,
        maxTokens: 8192,
        timeoutSeconds: 300,
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.maxIterations).toBe(10);
      expect(result.maxTokens).toBe(8192);
      expect(result.timeoutSeconds).toBe(300);
    });

    it('includes environment variables', async () => {
      const spec = minimalSpec({
        environmentVariables: { API_KEY: 'secret', DEBUG: 'true' },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.environmentVariables).toEqual({ API_KEY: 'secret', DEBUG: 'true' });
    });

    it('includes tags', async () => {
      const spec = minimalSpec({
        tags: { team: 'platform', env: 'prod' },
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.tags).toEqual({ team: 'platform', env: 'prod' });
    });

    it('includes allowedTools', async () => {
      const spec = minimalSpec({
        allowedTools: ['*', 'my_tool'],
      });

      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.allowedTools).toEqual(['*', 'my_tool']);
    });
  });

  // ── Core fields ────────────────────────────────────────────────────────

  describe('core fields', () => {
    it('sets region, harnessName, and executionRoleArn', async () => {
      const spec = minimalSpec();
      const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

      expect(result.region).toBe('us-east-1');
      expect(result.harnessName).toBe('myproject_test_harness');
      expect(result.executionRoleArn).toBe('arn:aws:iam::123456789012:role/HarnessRole');
    });
  });
});
