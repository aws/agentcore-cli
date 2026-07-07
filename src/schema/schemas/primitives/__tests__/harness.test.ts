import {
  HarnessModelProviderSchema,
  HarnessModelSchema,
  HarnessNameSchema,
  HarnessSkillSchema,
  HarnessSpecSchema,
  HarnessToolSchema,
  HarnessToolTypeSchema,
} from '../harness';
import { describe, expect, it } from 'vitest';

describe('HarnessNameSchema', () => {
  it.each(['MyHarness', 'a', 'Agent1', 'my_harness_01'])('accepts valid name "%s"', name => {
    expect(HarnessNameSchema.safeParse(name).success).toBe(true);
  });

  it('accepts 40-character name (max)', () => {
    const name = 'A' + 'b'.repeat(39);
    expect(name).toHaveLength(40);
    expect(HarnessNameSchema.safeParse(name).success).toBe(true);
  });

  it('rejects 41-character name', () => {
    const name = 'A' + 'b'.repeat(40);
    expect(name).toHaveLength(41);
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
  it.each(['bedrock', 'open_ai', 'gemini', 'lite_llm'])('accepts "%s"', provider => {
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
      topK: 40,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-integer topK', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      apiKeyArn: 'arn:aws:bedrock-agentcore:us-west-2:123:apikey/abc',
      topK: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects topK above 500', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      apiKeyArn: 'arn:aws:bedrock-agentcore:us-west-2:123:apikey/abc',
      topK: 501,
    });
    expect(result.success).toBe(false);
  });

  it('requires apiKeyArn for open_ai and gemini providers', () => {
    expect(HarnessModelSchema.safeParse({ provider: 'open_ai', modelId: 'gpt-4o' }).success).toBe(false);
    expect(HarnessModelSchema.safeParse({ provider: 'gemini', modelId: 'gemini-2.5-pro' }).success).toBe(false);
    expect(HarnessModelSchema.safeParse({ provider: 'bedrock', modelId: 'claude' }).success).toBe(true);
  });

  it('accepts lite_llm model without apiKeyArn (key is optional)', () => {
    const result = HarnessModelSchema.safeParse({ provider: 'lite_llm', modelId: 'anthropic/claude-sonnet-4-5' });
    expect(result.success).toBe(true);
  });

  it('accepts lite_llm model with apiBase and additionalParams', () => {
    const result = HarnessModelSchema.safeParse({
      provider: 'lite_llm',
      modelId: 'anthropic/claude-sonnet-4-5',
      apiBase: 'https://proxy.example.com/v1',
      additionalParams: { reasoning_effort: 'high' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects apiBase for non-lite_llm providers', () => {
    expect(HarnessModelSchema.safeParse({ provider: 'bedrock', modelId: 'm', apiBase: 'https://x' }).success).toBe(
      false
    );
  });

  it('rejects additionalParams for non-lite_llm providers', () => {
    expect(
      HarnessModelSchema.safeParse({ provider: 'bedrock', modelId: 'm', additionalParams: { foo: 'bar' } }).success
    ).toBe(false);
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
      topK: 40,
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

  it('accepts harness with a literal system prompt', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      systemPrompt: 'You are a helpful research assistant. Cite your sources.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a file-path-shaped system prompt (migration fail-fast; use system-prompt.md)', () => {
    for (const bad of ['./system-prompt.md', '../prompts/system.md', 'prompts/system.txt']) {
      const result = HarnessSpecSchema.safeParse({ ...minimalHarness, systemPrompt: bad });
      expect(result.success).toBe(false);
    }
  });

  it('does not misfire on prose that merely mentions a filename', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      systemPrompt: 'Refer to docs.md when the user asks about setup.',
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

  it('accepts harness with path skills', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      skills: [{ path: './skills/research' }, { path: '.agents/skills/xlsx' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with s3 skills', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      skills: [{ s3Uri: 's3://my-bucket/skills/calc' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts harness with git skills (public and private)', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      skills: [
        { gitUrl: 'https://github.com/owner/repo', path: 'skills/greet' },
        {
          gitUrl: 'https://github.com/owner/private',
          auth: {
            credentialName:
              'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/my-pat',
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects git skill with non-https URL', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      skills: [{ gitUrl: 'git@github.com:owner/repo' }],
    });
    expect(result.success).toBe(false);
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

  // B5 — truncation strategy "none"
  it('accepts truncation strategy "none"', () => {
    const result = HarnessSpecSchema.safeParse({ ...minimalHarness, truncation: { strategy: 'none' } });
    expect(result.success).toBe(true);
  });

  // B27e — truncation config must match the strategy
  it('rejects a summarization config under a sliding_window strategy', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      truncation: { strategy: 'sliding_window', config: { summarization: { summaryRatio: 0.5 } } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a config under the "none" strategy', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      truncation: { strategy: 'none', config: { slidingWindow: { messagesCount: 5 } } },
    });
    expect(result.success).toBe(false);
  });

  // B6 / B7 — memory messagesCount + retrievalConfig
  it('accepts memory messagesCount and retrievalConfig', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { name: 'mem', messagesCount: 20, retrievalConfig: { topK: 5, relevanceScore: 0.7 } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown key in memory.retrievalConfig', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { name: 'mem', retrievalConfig: { topK: 5, strategyId: 'x' } },
    });
    expect(result.success).toBe(false);
  });

  // Review fix — retrievalConfig must carry at least one knob (an empty {} fans out to per-namespace
  // {} objects, the pre-v6 crash shape).
  it('rejects an empty memory.retrievalConfig', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { name: 'mem', retrievalConfig: {} },
    });
    expect(result.success).toBe(false);
  });

  // Review fix — HarnessMemoryRefSchema is .strict(): a typo'd key (e.g. messageCount) is a parse
  // error, not a silently-dropped field.
  it('rejects an unknown key on the memory ref (typo guard)', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { name: 'mem', messageCount: 20 },
    });
    expect(result.success).toBe(false);
  });

  // Review fix — retrievalConfig is dropped at synth for a by-arn ref (no resolvable strategies), so
  // reject it at parse time. Gated on `arn` alone: the { arn, name, retrievalConfig } combo must also
  // fail, because arn takes precedence in resolveHarnessMemory.
  it('rejects retrievalConfig on a by-arn memory ref', () => {
    const byArn = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { arn: 'arn:aws:bedrock-agentcore:us-west-2:123:memory/abc', retrievalConfig: { topK: 5 } },
    });
    expect(byArn.success).toBe(false);

    const byArnAndName = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { arn: 'arn:aws:bedrock-agentcore:us-west-2:123:memory/abc', name: 'mem', retrievalConfig: { topK: 5 } },
    });
    expect(byArnAndName.success).toBe(false);
  });

  it('still accepts messagesCount/actorId on a by-arn memory ref', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      memory: { arn: 'arn:aws:bedrock-agentcore:us-west-2:123:memory/abc', actorId: 'user-1', messagesCount: 20 },
    });
    expect(result.success).toBe(true);
  });

  // Managed memory + 3-mode discriminated union (NY-Summit).
  describe('HarnessMemoryRefSchema — 3-mode union', () => {
    it('accepts managed mode with default-shaped strategies', () => {
      const r = HarnessSpecSchema.safeParse({
        ...minimalHarness,
        memory: { mode: 'managed', strategies: ['SEMANTIC', 'SUMMARIZATION'] },
      });
      expect(r.success).toBe(true);
    });

    it('leaves managed strategies absent when omitted (service applies its own default)', () => {
      const r = HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { mode: 'managed' } });
      expect(r.success).toBe(true);
      if (r.success && r.data.memory?.mode === 'managed') {
        expect(r.data.memory.strategies).toBeUndefined();
      }
    });

    it('rejects CUSTOM in managed strategies (not valid for managed memory)', () => {
      const r = HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { mode: 'managed', strategies: ['CUSTOM'] } });
      expect(r.success).toBe(false);
    });

    it('rejects an out-of-range managed eventExpiryDuration', () => {
      const r = HarnessSpecSchema.safeParse({
        ...minimalHarness,
        memory: { mode: 'managed', strategies: ['SEMANTIC'], eventExpiryDuration: 2 },
      });
      expect(r.success).toBe(false);
    });

    it('accepts managed eventExpiryDuration within 3-365', () => {
      const r = HarnessSpecSchema.safeParse({
        ...minimalHarness,
        memory: { mode: 'managed', strategies: ['SEMANTIC'], eventExpiryDuration: 30 },
      });
      expect(r.success).toBe(true);
    });

    it('rejects an unknown key on the managed arm (strict)', () => {
      const r = HarnessSpecSchema.safeParse({
        ...minimalHarness,
        memory: { mode: 'managed', strategies: ['SEMANTIC'], bogus: true },
      });
      expect(r.success).toBe(false);
    });

    it('accepts existing mode by name', () => {
      expect(
        HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { mode: 'existing', name: 'mem' } }).success
      ).toBe(true);
    });

    it('rejects existing mode with neither arn nor name', () => {
      expect(HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { mode: 'existing' } }).success).toBe(false);
    });

    it('preserves the by-arn retrievalConfig rejection on the existing arm', () => {
      const r = HarnessSpecSchema.safeParse({
        ...minimalHarness,
        memory: {
          mode: 'existing',
          arn: 'arn:aws:bedrock-agentcore:us-west-2:1:memory/m-aBcD012345',
          retrievalConfig: { topK: 5 },
        },
      });
      expect(r.success).toBe(false);
    });

    it('accepts disabled mode', () => {
      expect(HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { mode: 'disabled' } }).success).toBe(true);
    });

    it('rejects an unknown key on the disabled arm (strict)', () => {
      expect(
        HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { mode: 'disabled', bogus: true } }).success
      ).toBe(false);
    });

    it('rejects an unknown mode', () => {
      expect(HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { mode: 'bogus' } }).success).toBe(false);
    });

    describe('legacy normalization', () => {
      it('maps a legacy by-name ref to existing', () => {
        const r = HarnessSpecSchema.safeParse({ ...minimalHarness, memory: { name: 'mem' } });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.memory).toEqual({ mode: 'existing', name: 'mem' });
      });

      it('maps a legacy by-arn ref to existing', () => {
        const r = HarnessSpecSchema.safeParse({
          ...minimalHarness,
          memory: { arn: 'arn:aws:bedrock-agentcore:us-west-2:1:memory/m-aBcD012345' },
        });
        expect(r.success).toBe(true);
        if (r.success && r.data.memory) expect(r.data.memory.mode).toBe('existing');
      });

      it('leaves absent memory absent (never invents managed)', () => {
        const r = HarnessSpecSchema.safeParse({ ...minimalHarness });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.memory).toBeUndefined();
      });

      it('passes an already-tagged managed ref through unchanged', () => {
        const r = HarnessSpecSchema.safeParse({
          ...minimalHarness,
          memory: { mode: 'managed', strategies: ['SEMANTIC', 'SUMMARIZATION'] },
        });
        expect(r.success).toBe(true);
        if (r.success && r.data.memory) expect(r.data.memory.mode).toBe('managed');
      });
    });
  });

  // Review fix — both truncation arms present must fail (the outer .strict() rejects the second
  // arm's key rather than silently dropping it).
  it('rejects a truncation config carrying both arms', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      truncation: {
        strategy: 'sliding_window',
        config: { slidingWindow: { messagesCount: 5 }, summarization: { summaryRatio: 0.5 } },
      },
    });
    expect(result.success).toBe(false);
  });

  // B8 — sessionStoragePath CFN MountPath parity ('/mnt/' is 5 chars + no subdir; spaces and
  // multi-level paths fail the pattern; a valid single-level path is accepted).
  it('enforces the CFN MountPath constraint on sessionStoragePath', () => {
    for (const p of ['/mnt/', '/mnt/bad path', '/mnt/x/y/z']) {
      expect(HarnessSpecSchema.safeParse({ ...minimalHarness, sessionStoragePath: p }).success).toBe(false);
    }
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, sessionStoragePath: '/mnt/data' }).success).toBe(true);
  });

  // B16 — empty / whitespace system prompt
  it('rejects an empty or whitespace-only system prompt', () => {
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, systemPrompt: '' }).success).toBe(false);
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, systemPrompt: '   ' }).success).toBe(false);
  });

  // B21 — env-var value length + map size
  it('rejects an env-var value over 5000 chars or more than 50 entries', () => {
    expect(
      HarnessSpecSchema.safeParse({ ...minimalHarness, environmentVariables: { K: 'x'.repeat(5001) } }).success
    ).toBe(false);
    const many: Record<string, string> = {};
    for (let i = 0; i < 51; i++) many[`K${i}`] = 'v';
    expect(HarnessSpecSchema.safeParse({ ...minimalHarness, environmentVariables: many }).success).toBe(false);
  });

  // B25 — containerUri ECR pattern
  it('rejects a non-ECR containerUri', () => {
    expect(
      HarnessSpecSchema.safeParse({ ...minimalHarness, containerUri: 'docker.io/library/nginx:latest' }).success
    ).toBe(false);
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
      systemPrompt: 'You are a research agent. Use tools when appropriate and cite sources.',
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
      skills: [{ path: './skills/research' }],
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

  it('accepts bedrock model with apiFormat responses', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: { provider: 'bedrock', modelId: 'openai.gpt-oss-120b', apiFormat: 'responses' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts bedrock model with apiFormat chat_completions', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: { provider: 'bedrock', modelId: 'openai.gpt-oss-120b', apiFormat: 'chat_completions' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts bedrock model with apiFormat converse_stream', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: { provider: 'bedrock', modelId: 'anthropic.claude-v2', apiFormat: 'converse_stream' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts apiFormat responses for open_ai provider', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: {
        provider: 'open_ai',
        modelId: 'gpt-4o',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key',
        apiFormat: 'responses',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts apiFormat chat_completions for open_ai provider', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: {
        provider: 'open_ai',
        modelId: 'gpt-4o',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key',
        apiFormat: 'chat_completions',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects converse_stream for open_ai provider', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: {
        provider: 'open_ai',
        modelId: 'gpt-4o',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key',
        apiFormat: 'converse_stream',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Invalid API format for open_ai'))).toBe(true);
    }
  });

  it('rejects apiFormat for gemini provider', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: {
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        apiKeyArn: 'arn:aws:secretsmanager:us-east-1:123:secret:key',
        apiFormat: 'responses',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('only supported for bedrock and open_ai'))).toBe(true);
    }
  });

  it('rejects invalid apiFormat value', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      model: { provider: 'bedrock', modelId: 'anthropic.claude-v2', apiFormat: 'invalid_format' },
    });
    expect(result.success).toBe(false);
  });
});

describe('HarnessSkillSchema', () => {
  it('accepts a bare path string and normalizes to object', () => {
    const result = HarnessSkillSchema.safeParse('./my-skill');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ path: './my-skill' });
    }
  });

  it('accepts a path object', () => {
    const result = HarnessSkillSchema.safeParse({ path: './skills/research' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ path: './skills/research' });
    }
  });

  it('accepts an S3 source', () => {
    const result = HarnessSkillSchema.safeParse({ s3Uri: 's3://my-bucket/skills/research' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ s3Uri: 's3://my-bucket/skills/research' });
    }
  });

  it('rejects S3 source without s3:// prefix', () => {
    const result = HarnessSkillSchema.safeParse({ s3Uri: 'my-bucket/skills/research' });
    expect(result.success).toBe(false);
  });

  it('accepts a git source with URL only', () => {
    const result = HarnessSkillSchema.safeParse({ gitUrl: 'https://github.com/org/repo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ gitUrl: 'https://github.com/org/repo' });
    }
  });

  it('accepts a git source with path and auth', () => {
    const input = {
      gitUrl: 'https://github.com/org/repo',
      path: 'skills/research',
      auth: {
        credentialName: 'my-cred',
        username: 'bot-user',
      },
    };
    const result = HarnessSkillSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(input);
    }
  });

  it('rejects git source without https:// prefix', () => {
    const result = HarnessSkillSchema.safeParse({ gitUrl: 'git@github.com:org/repo.git' });
    expect(result.success).toBe(false);
  });

  it('rejects empty string', () => {
    const result = HarnessSkillSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects empty path object', () => {
    const result = HarnessSkillSchema.safeParse({ path: '' });
    expect(result.success).toBe(false);
  });

  it('accepts an AWS skills source without paths', () => {
    const result = HarnessSkillSchema.safeParse({ awsSkills: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ awsSkills: {} });
    }
  });

  it('accepts an AWS skills source with paths', () => {
    const result = HarnessSkillSchema.safeParse({ awsSkills: { paths: ['core-skills/*'] } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ awsSkills: { paths: ['core-skills/*'] } });
    }
  });

  it('rejects an AWS skills source with empty path string', () => {
    const result = HarnessSkillSchema.safeParse({ awsSkills: { paths: [''] } });
    expect(result.success).toBe(false);
  });
});

describe('HarnessSpecSchema skills field', () => {
  const minimalHarness = {
    name: 'TestHarness',
    model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0' },
  };

  it('accepts mixed skill sources including AWS skills', () => {
    const result = HarnessSpecSchema.safeParse({
      ...minimalHarness,
      skills: [
        './local-skill',
        { s3Uri: 's3://bucket/skill' },
        { gitUrl: 'https://github.com/org/repo', path: 'skills/foo' },
        { awsSkills: { paths: ['core-skills/*'] } },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toHaveLength(4);
      expect(result.data.skills[0]).toEqual({ path: './local-skill' });
      expect(result.data.skills[1]).toEqual({ s3Uri: 's3://bucket/skill' });
      expect(result.data.skills[2]).toEqual({ gitUrl: 'https://github.com/org/repo', path: 'skills/foo' });
      expect(result.data.skills[3]).toEqual({ awsSkills: { paths: ['core-skills/*'] } });
    }
  });

  it('defaults skills to empty array', () => {
    const result = HarnessSpecSchema.safeParse(minimalHarness);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual([]);
    }
  });
});

describe('HarnessSpecSchema vpcId for container builds', () => {
  const minimalHarnessForVpc = {
    name: 'myHarness',
    model: {
      provider: 'bedrock' as const,
      modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
    },
  };
  const baseDockerfileHarness = {
    ...minimalHarnessForVpc,
    dockerfile: 'Dockerfile',
    networkMode: 'VPC' as const,
    networkConfig: { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'] },
  };

  it('accepts a dockerfile build in VPC mode WITHOUT vpcId at the schema level (backfilled at deploy)', () => {
    // vpcId is required to build but not enforced on read/write — old configs must still load. See the
    // matching note in agent-env.ts; deploy backfills it and the CDK construct fails fast if missing.
    const r = HarnessSpecSchema.safeParse(baseDockerfileHarness);
    expect(r.success).toBe(true);
  });

  it('accepts a dockerfile build in VPC mode when vpcId is present', () => {
    const r = HarnessSpecSchema.safeParse({
      ...baseDockerfileHarness,
      networkConfig: { ...baseDockerfileHarness.networkConfig, vpcId: 'vpc-0123456789abcdef0' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a containerUri harness in VPC mode without vpcId (backfilled at deploy, like dockerfile)', () => {
    // A containerUri harness IS a container build (export emits a `FROM <uri>` Dockerfile that
    // CodeBuild builds), so it is treated the same as a dockerfile harness — lenient on read, vpcId
    // backfilled at deploy.
    const r = HarnessSpecSchema.safeParse({
      ...minimalHarnessForVpc,
      containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
      networkMode: 'VPC',
      networkConfig: { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'] },
    });
    expect(r.success).toBe(true);
  });
});

describe('HarnessSpecSchema — SG≤5 for dockerfile builds in VPC mode', () => {
  const minimalHarnessForSg = {
    name: 'myHarness',
    model: {
      provider: 'bedrock' as const,
      modelId: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
    },
  };
  const sixSgs = [
    'sg-00000000000000001',
    'sg-00000000000000002',
    'sg-00000000000000003',
    'sg-00000000000000004',
    'sg-00000000000000005',
    'sg-00000000000000006',
  ];
  const fiveSgs = sixSgs.slice(0, 5);

  it('rejects dockerfile+VPC with 6 security groups', () => {
    const r = HarnessSpecSchema.safeParse({
      ...minimalHarnessForSg,
      dockerfile: 'Dockerfile',
      networkMode: 'VPC' as const,
      networkConfig: {
        subnets: ['subnet-0123456789abcdef0'],
        securityGroups: sixSgs,
        vpcId: 'vpc-0123456789abcdef0',
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('5 security groups'))).toBe(true);
    }
  });

  it('accepts dockerfile+VPC with exactly 5 security groups', () => {
    const r = HarnessSpecSchema.safeParse({
      ...minimalHarnessForSg,
      dockerfile: 'Dockerfile',
      networkMode: 'VPC' as const,
      networkConfig: {
        subnets: ['subnet-0123456789abcdef0'],
        securityGroups: fiveSgs,
        vpcId: 'vpc-0123456789abcdef0',
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects containerUri+VPC with 6 security groups (a containerUri harness is a container build, so the cap applies)', () => {
    const r = HarnessSpecSchema.safeParse({
      ...minimalHarnessForSg,
      containerUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag',
      networkMode: 'VPC',
      networkConfig: {
        subnets: ['subnet-0123456789abcdef0'],
        securityGroups: sixSgs,
        vpcId: 'vpc-0123456789abcdef0',
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('5 security groups'))).toBe(true);
    }
  });
});
