import type { BedrockAgentConfig } from '../../../../aws/bedrock-import-types';
import { LangGraphTranslator } from '../langgraph-translator';
import { generatePyprojectToml } from '../pyproject-generator';
import { StrandsTranslator } from '../strands-translator';
import { describe, expect, it } from 'vitest';

function makeSimpleAgentConfig(overrides: Partial<BedrockAgentConfig> = {}): BedrockAgentConfig {
  return {
    agent: {
      agentId: 'agent-1',
      agentName: 'TestAgent',
      agentArn: 'arn:aws:bedrock:us-east-1:123456:agent/agent-1',
      foundationModel: 'anthropic.claude-3-sonnet-20240229-v1:0',
      instruction: 'You are a helpful assistant.',
      orchestrationType: 'DEFAULT',
      promptOverrideConfiguration: {
        promptConfigurations: [
          {
            promptType: 'ORCHESTRATION',
            promptState: 'ENABLED',
            basePromptTemplate: { system: 'You are a helpful assistant. $instruction$' },
            inferenceConfiguration: {
              temperature: 0.7,
              maximumLength: 4096,
              topP: 0.9,
              topK: 250,
            },
          },
        ],
      },
      model: { providerName: 'Anthropic', modelId: 'claude-3-sonnet' },
    },
    action_groups: [],
    knowledge_bases: [],
    collaborators: [],
    ...overrides,
  };
}

describe('StrandsTranslator', () => {
  it('generates valid Python code for a simple agent', () => {
    const config = makeSimpleAgentConfig();
    const translator = new StrandsTranslator(config, {
      agentConfig: config,
      enableMemory: false,
      memoryOption: 'none',
      enableObservability: true,
    });
    const result = translator.translate();

    expect(result.mainPyContent).toContain('from strands import Agent, tool');
    expect(result.mainPyContent).toContain('BedrockModel');
    expect(result.mainPyContent).toContain('ORCHESTRATION_TEMPLATE');
    expect(result.mainPyContent).toContain('def invoke_agent(question: str');
    expect(result.mainPyContent).toContain('@app.entrypoint');
    expect(result.mainPyContent).toContain('def endpoint(payload, context):');
    expect(result.collaboratorFiles.size).toBe(0);
    expect(result.features.hasMemory).toBe(false);
    expect(result.features.hasActionGroups).toBe(false);
  });

  it('includes memory code when memory is configured', () => {
    const config = makeSimpleAgentConfig({
      agent: {
        ...makeSimpleAgentConfig().agent,
        memoryConfiguration: { enabledMemoryTypes: ['SESSION_SUMMARY'] },
      },
    });
    const translator = new StrandsTranslator(config, {
      agentConfig: config,
      enableMemory: true,
      memoryOption: 'longAndShortTerm',
      enableObservability: false,
    });
    const result = translator.translate();

    expect(result.mainPyContent).toContain('MemoryClient');
    expect(result.mainPyContent).toContain('memory_client');
    expect(result.features.hasMemory).toBe(true);
  });

  it('generates action group tools for function-schema action groups', () => {
    const config = makeSimpleAgentConfig({
      action_groups: [
        {
          actionGroupId: 'ag-1',
          actionGroupName: 'weather_tools',
          actionGroupState: 'ENABLED',
          functionSchema: {
            functions: [
              {
                name: 'get_weather',
                description: 'Get current weather for a location',
                parameters: {
                  location: { type: 'string', description: 'City name', required: true },
                },
              },
            ],
          },
        },
      ],
    });
    const translator = new StrandsTranslator(config, {
      agentConfig: config,
      enableMemory: false,
      memoryOption: 'none',
      enableObservability: false,
    });
    const result = translator.translate();

    expect(result.mainPyContent).toContain('def get_weather(location: str)');
    expect(result.mainPyContent).toContain('action_group_tools');
    expect(result.features.hasActionGroups).toBe(true);
  });

  it('generates knowledge base code', () => {
    const config = makeSimpleAgentConfig({
      knowledge_bases: [
        {
          knowledgeBaseId: 'kb-123',
          knowledgeBaseState: 'ENABLED',
          name: 'product_docs',
          description: 'Product documentation',
          knowledgeBaseArn: 'arn:aws:bedrock:us-east-1:123456:knowledge-base/kb-123',
        },
      ],
    });
    const translator = new StrandsTranslator(config, {
      agentConfig: config,
      enableMemory: false,
      memoryOption: 'none',
      enableObservability: false,
    });
    const result = translator.translate();

    expect(result.mainPyContent).toContain('retrieve_product_docs');
    expect(result.mainPyContent).toContain('bedrock-agent-runtime');
    expect(result.mainPyContent).toContain('kb-123');
    expect(result.features.hasKnowledgeBases).toBe(true);
  });
});

describe('LangGraphTranslator', () => {
  it('generates valid LangChain/LangGraph Python code for a simple agent', () => {
    const config = makeSimpleAgentConfig();
    const translator = new LangGraphTranslator(config, {
      agentConfig: config,
      enableMemory: false,
      memoryOption: 'none',
      enableObservability: true,
    });
    const result = translator.translate();

    expect(result.mainPyContent).toContain('from langchain_aws import ChatBedrock');
    expect(result.mainPyContent).toContain('create_react_agent');
    expect(result.mainPyContent).toContain('InMemorySaver');
    expect(result.mainPyContent).toContain('ORCHESTRATION_TEMPLATE');
    expect(result.mainPyContent).toContain('def invoke_agent(question: str');
    expect(result.mainPyContent).toContain('@app.entrypoint');
    expect(result.mainPyContent).toContain('LangchainInstrumentor');
    expect(result.collaboratorFiles.size).toBe(0);
  });

  it('generates knowledge base code with AmazonKnowledgeBasesRetriever', () => {
    const config = makeSimpleAgentConfig({
      knowledge_bases: [
        {
          knowledgeBaseId: 'kb-456',
          knowledgeBaseState: 'ENABLED',
          name: 'faq_kb',
          description: 'FAQ knowledge base',
          knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:123456:knowledge-base/kb-456',
        },
      ],
    });
    const translator = new LangGraphTranslator(config, {
      agentConfig: config,
      enableMemory: false,
      memoryOption: 'none',
      enableObservability: false,
    });
    const result = translator.translate();

    expect(result.mainPyContent).toContain('AmazonKnowledgeBasesRetriever');
    expect(result.mainPyContent).toContain('retriever_faq_kb');
    expect(result.mainPyContent).toContain('kb-456');
  });

  it('includes guardrails in model configuration', () => {
    const config = makeSimpleAgentConfig({
      agent: {
        ...makeSimpleAgentConfig().agent,
        guardrailConfiguration: {
          guardrailId: 'gr-123',
          version: '1',
        },
      },
    });
    const translator = new LangGraphTranslator(config, {
      agentConfig: config,
      enableMemory: false,
      memoryOption: 'none',
      enableObservability: false,
    });
    const result = translator.translate();

    expect(result.mainPyContent).toContain('guardrails');
    expect(result.mainPyContent).toContain('gr-123');
    expect(result.features.hasGuardrails).toBe(true);
  });
});

describe('generatePyprojectToml', () => {
  it('generates Strands pyproject.toml', () => {
    const result = generatePyprojectToml('TestAgent', 'Strands', {
      hasMemory: false,
      hasKnowledgeBases: false,
      hasActionGroups: false,
      hasCodeInterpreter: false,
      hasMultiAgent: false,
      hasGuardrails: false,
      hasGateway: false,
    });

    expect(result).toContain('[project]');
    expect(result).toContain('name = "TestAgent"');
    expect(result).toContain('strands-agents');
    expect(result).not.toContain('langgraph');
  });

  it('generates LangGraph pyproject.toml', () => {
    const result = generatePyprojectToml('TestAgent', 'LangChain_LangGraph', {
      hasMemory: false,
      hasKnowledgeBases: false,
      hasActionGroups: false,
      hasCodeInterpreter: false,
      hasMultiAgent: false,
      hasGuardrails: false,
      hasGateway: false,
    });

    expect(result).toContain('langgraph');
    expect(result).toContain('langchain_aws');
    expect(result).not.toContain('strands-agents');
  });

  it('includes memory dependencies when memory is enabled', () => {
    const result = generatePyprojectToml('TestAgent', 'Strands', {
      hasMemory: true,
      hasKnowledgeBases: false,
      hasActionGroups: false,
      hasCodeInterpreter: false,
      hasMultiAgent: false,
      hasGuardrails: false,
      hasGateway: false,
    });

    expect(result).toContain('bedrock-agentcore[memory]');
  });
});
