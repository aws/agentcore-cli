import {
  HarnessModelProviderSchema,
  HarnessModelSchema,
  HarnessNameSchema,
  HarnessSpecSchema,
  HarnessToolSchema,
  HarnessToolTypeSchema,
} from '../harness';
import { describe, expect, it } from 'vitest';

describe('HarnessNameSchema', () => {
  it.each(['MyHarness', 'a', 'Agent1', 'my_harness_01'])('accepts valid name "%s"', name => {
    expect(HarnessNameSchema.safeParse(name).success).toBe(true);
  });

  it('accepts 48-character name (max)', () => {
    const name = 'A' + 'b'.repeat(47);
    expect(name).toHaveLength(48);
    expect(HarnessNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects 49-character name', () => {
    const name = 'A' + 'b'.repeat(48);
    expect(name).toHaveLength(49);
    expect(HarnessNameSchema.safeParse(name).success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(HarnessNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects name starting with digit', () => {
    expect(HarnessNameSchema.safeParse('1harness').success).toBe(false);
  });

  it('rejects name with hyphens', () => {
    expect(HarnessNameSchema.safeParse('my-harness').success).toBe(false);
  });

  it('rejects name with spaces', () => {
    expect(HarnessNameSchema.safeParse('my harness').success).toBe(false);
  });
});

describe('HarnessToolTypeSchema', () => {
  it.each(['remote_mcp', 'agentcore_browser', 'agentcore_gateway', 'inline_function', 'agentcore_code_interpreter'])(
    'accepts "%s"',
    type => {
      expect(HarnessToolTypeSchema.safeParse(type).success).toBe(true);
    }
  );

  it('rejects unknown tool type', () => {
    expect(HarnessToolTypeSchema.safeParse('unknown_tool').success).toBe(false);
  });
});

describe('HarnessModelProviderSchema', () => {
  it.each(['bedrock', 'open_ai', 'gemini'])('accepts "%s"', provider => {
    expect(HarnessModelProviderSchema.safeParse(provider).success).toBe(true);
  });

  it('rejects unknown provider', () => {
    expect(HarnessModelProviderSchema.safeParse('azure').success).toBe(false);
  });
});

describe('HarnessToolSchema', () => {
  it('accepts browser tool with no config', () => {
    const result = HarnessToolSchema.safeParse({ type: 'agentcore_browser', name: 'browser' });
    expect(result.success).toBe(true);
  });

  it('accepts browser tool with optional browserArn', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_browser',
      name: 'browser',
      config: { agentCoreBrowser: { browserArn: 'arn:aws:bedrock-agentcore:us-west-2:123:browser/abc' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts code interpreter tool with no config', () => {
    const result = HarnessToolSchema.safeParse({ type: 'agentcore_code_interpreter', name: 'code-interp' });
    expect(result.success).toBe(true);
  });

  it('accepts remote MCP tool with url', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'remote_mcp',
      name: 'exa',
      config: { remoteMcp: { url: 'https://mcp.exa.ai/mcp' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts remote MCP tool with headers', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'remote_mcp',
      name: 'exa',
      config: { remoteMcp: { url: 'https://mcp.exa.ai/mcp', headers: { Authorization: 'Bearer tok' } } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts gateway tool with gatewayArn', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: { agentCoreGateway: { gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts gateway tool with outboundAuth awsIam', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: {
        agentCoreGateway: {
          gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc',
          outboundAuth: { awsIam: {} },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts gateway tool with outboundAuth none', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: {
        agentCoreGateway: {
          gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc',
          outboundAuth: { none: {} },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts gateway tool with outboundAuth oauth', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: {
        agentCoreGateway: {
          gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc',
          outboundAuth: {
            oauth: {
              providerArn:
                'arn:aws:bedrock-agentcore:us-west-2:123:token-vault/default/oauth2credentialprovider/my-provider',
              scopes: ['read', 'write'],
              grantType: 'CLIENT_CREDENTIALS',
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts gateway tool without outboundAuth (defaults to SigV4)', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: {
        agentCoreGateway: {
          gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects gateway tool with invalid outboundAuth variant', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: {
        agentCoreGateway: {
          gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc',
          outboundAuth: { unknownAuth: {} },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects gateway tool with credentialProviderName and shows migration message', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: {
        agentCoreGateway: {
          gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc',
          credentialProviderName: 'my-oauth',
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('no longer supported'))).toBe(true);
    }
  });

  it('accepts inline function tool', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'inline_function',
      name: 'approve_purchase',
      config: {
        inlineFunction: {
          description: 'Approve a purchase',
          inputSchema: {
            type: 'object',
            properties: { amount: { type: 'number' } },
            required: ['amount'],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects tool name longer than 64 chars', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_browser',
      name: 'a'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('rejects tool name with invalid characters', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_browser',
      name: 'my tool!',
    });
    expect(result.success).toBe(false);
  });

  it('rejects remote_mcp with agentCoreBrowser config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'remote_mcp',
      name: 'mcp-server',
      config: { agentCoreBrowser: { browserArn: 'arn:aws:bedrock-agentcore:us-west-2:123:browser/abc' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('requires "remoteMcp" config'))).toBe(true);
    }
  });

  it('rejects agentcore_gateway without config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('requires a "agentCoreGateway" config'))).toBe(true);
    }
  });

  it('rejects remote_mcp without config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'remote_mcp',
      name: 'exa',
    });
    expect(result.success).toBe(false);
  });

  it('rejects inline_function without config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'inline_function',
      name: 'my-func',
    });
    expect(result.success).toBe(false);
  });

  it('rejects agentcore_gateway with remoteMcp config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_gateway',
      name: 'my-gw',
      config: { remoteMcp: { url: 'https://example.com' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects inline_function with agentCoreGateway config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'inline_function',
      name: 'my-func',
      config: { agentCoreGateway: { gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc' } },
    });
    expect(result.success).toBe(false);
  });

  it('allows agentcore_browser without config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_browser',
      name: 'browser',
    });
    expect(result.success).toBe(true);
  });

  it('allows agentcore_code_interpreter without config', () => {
    const result = HarnessToolSchema.safeParse({
      type: 'agentcore_code_interpreter',
      name: 'code-interp',
    });
    expect(result.success).toBe(true);
  });
});

describe('HarnessModelSchema', () => {
  it('accepts bedrock model with just modelId', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
    });
    expect(result.success).toBe(true);
  });

  it('accepts bedrock model with optional inference params', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
    });
    expect(result.success).toBe(true);
  });

  it('accepts open_ai model with apiKeyArn', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'open_ai',
      modelId: 'gpt-4o',
      apiKeyArn: 'arn:aws:bedrock-agentcore:us-west-2:123:apikey/abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts gemini model with topK', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      apiKeyArn: 'arn:aws:bedrock-agentcore:us-west-2:123:apikey/abc',
      topK: 0.5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects temperature above 2.0', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'bedrock',
      modelId: 'test',
      temperature: 2.1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects temperature below 0', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'bedrock',
      modelId: 'test',
      temperature: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects topP above 1.0', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'bedrock',
      modelId: 'test',
      topP: 1.1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxTokens of 0', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'bedrock',
      modelId: 'test',
      maxTokens: 0,
    });
    expect(result.success).toBe(false);
  });

  it('requires modelId', () => {
    const result = HarnessModelSchema.safeParse({ provider: 'bedrock' });
    expect(result.success).toBe(false);
  });

  it('rejects topK for bedrock provider', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
      topK: 0.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(i => i.message.includes('topK is only supported for the "gemini" provider'))
      ).toBe(true);
    }
  });

  it('rejects topK for open_ai provider', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'open_ai',
      modelId: 'gpt-4o',
      apiKeyArn: 'arn:aws:bedrock-agentcore:us-west-2:123:apikey/abc',
      topK: 0.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('HarnessSpecSchema', () => {
  const minimalHarness = {
    name: 'myHarness',
    model: {
      provider: 'bedrock',
      modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
    },
  };

  it('accepts minimal harness spec', () => {
    const result = HarnessSpecSchema.safeParse(minimalHarness);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual([]);
      expect(result.data.skills).toEqual([]);
    }
  });

  it('accepts harness with system prompt file path', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      systemPrompt: './system-prompt.md',
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with tools', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      tools: [
        { type: 'agentcore_browser', name: 'browser' },
        { type: 'remote_mcp', name: 'exa', config: { remoteMcp: { url: 'https://mcp.exa.ai/mcp' } } },
        {
          type: 'agentcore_gateway',
          name: 'my-gw',
          config: { agentCoreGateway: { gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc' } },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate tool names', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      tools: [
        { type: 'agentcore_browser', name: 'browser' },
        { type: 'agentcore_code_interpreter', name: 'browser' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate tool name'))).toBe(true);
    }
  });

  it('accepts harness with skills as string paths', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      skills: ['./skills/research', '.agents/skills/xlsx'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with allowedTools', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      allowedTools: ['file_operations', 'browser'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts wildcard in allowedTools', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      allowedTools: ['*'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with memory reference', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { name: 'research_memory' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with memory arn override', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { arn: 'arn:aws:bedrock-agentcore:us-west-2:123:memory/abc' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with execution limits', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      maxIterations: 50,
      timeoutSeconds: 1800,
      maxTokens: 8192,
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with sliding_window truncation', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      truncation: {
        strategy: 'sliding_window',
        config: { slidingWindow: { messagesCount: 100 } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with summarization truncation', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      truncation: {
        strategy: 'summarization',
        config: { summarization: { summaryRatio: 0.3, preserveRecentMessages: 10 } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown truncation strategy', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      truncation: { strategy: 'random', config: {} },
    });
    expect(result.success).toBe(false);
  });

  it('accepts harness with container config', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      containerUri: '123456789012.dkr.ecr.us-west-2.amazonaws.com/my-agent:latest',
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with dockerfile', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      dockerfile: 'Dockerfile',
    });
    expect(result.success).toBe(true);
  });

  it('rejects containerUri and dockerfile together', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      containerUri: '123456789012.dkr.ecr.us-west-2.amazonaws.com/my-agent:latest',
      dockerfile: 'Dockerfile',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('mutually exclusive'))).toBe(true);
    }
  });

  it('accepts harness with VPC network config', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      networkMode: 'VPC',
      networkConfig: {
        subnets: ['subnet-abc12345'],
        securityGroups: ['sg-abc12345'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects VPC mode without networkConfig', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      networkMode: 'VPC',
    });
    expect(result.success).toBe(false);
  });

  it('rejects networkConfig without VPC mode', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      networkConfig: {
        subnets: ['subnet-abc12345'],
        securityGroups: ['sg-abc12345'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts harness with lifecycle config', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      lifecycleConfig: {
        idleRuntimeSessionTimeout: 900,
        maxLifetime: 28800,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with environment variables', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      environmentVariables: { NODE_ENV: 'production', DEBUG: 'true' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with tags', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      tags: { team: 'platform', env: 'dev' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with executionRoleArn', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      executionRoleArn: 'arn:aws:iam::123456789012:role/MyRole',
    });
    expect(result.success).toBe(true);
  });

  it('accepts fully-loaded harness spec', () => {
    const result = HarnessSpecSchema.safeParse({
      name: 'research_agent',
      model: {
        provider: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
        temperature: 0.7,
        maxTokens: 4096,
      },
      systemPrompt: './system-prompt.md',
      tools: [
        { type: 'agentcore_browser', name: 'browser' },
        { type: 'agentcore_code_interpreter', name: 'code_interpreter' },
        { type: 'remote_mcp', name: 'exa', config: { remoteMcp: { url: 'https://mcp.exa.ai/mcp' } } },
        {
          type: 'agentcore_gateway',
          name: 'my_gateway',
          config: { agentCoreGateway: { gatewayArn: 'arn:aws:bedrock-agentcore:us-west-2:123:gateway/abc' } },
        },
        {
          type: 'inline_function',
          name: 'approve_purchase',
          config: {
            inlineFunction: {
              description: 'Approve a purchase',
              inputSchema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
            },
          },
        },
      ],
      skills: ['./skills/research'],
      allowedTools: ['*'],
      memory: { name: 'research_memory' },
      maxIterations: 75,
      timeoutSeconds: 3600,
      maxTokens: 16384,
      truncation: { strategy: 'sliding_window', config: { slidingWindow: { messagesCount: 150 } } },
      lifecycleConfig: { idleRuntimeSessionTimeout: 900 },
      networkMode: 'PUBLIC',
      tags: { team: 'research' },
    });
    expect(result.success).toBe(true);
  });
});
