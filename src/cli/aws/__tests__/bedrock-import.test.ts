import { getBedrockAgentConfig, listBedrockAgentAliases, listBedrockAgents } from '../bedrock-import';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentSend = vi.fn();
const mockBedrockSend = vi.fn();
const mockS3Send = vi.fn();

// Mock the AWS SDK clients using class syntax for proper `new` support
vi.mock('@aws-sdk/client-bedrock-agent', () => {
  return {
    BedrockAgentClient: class {
      send = mockAgentSend;
    },
    ListAgentsCommand: class {},
    ListAgentAliasesCommand: class {},
    GetAgentCommand: class {},
    GetAgentAliasCommand: class {},
    GetAgentActionGroupCommand: class {},
    GetKnowledgeBaseCommand: class {},
    ListAgentActionGroupsCommand: class {},
    ListAgentKnowledgeBasesCommand: class {},
    ListAgentCollaboratorsCommand: class {},
  };
});

vi.mock('@aws-sdk/client-bedrock', () => {
  return {
    BedrockClient: class {
      send = mockBedrockSend;
    },
    GetFoundationModelCommand: class {},
    GetGuardrailCommand: class {},
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: class {
      send = mockS3Send;
    },
    GetObjectCommand: class {},
  };
});

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

vi.mock('js-yaml', () => ({
  default: { load: vi.fn((s: string) => JSON.parse(s)) },
}));

describe('bedrock-import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listBedrockAgents', () => {
    it('returns mapped agent summaries', async () => {
      mockAgentSend.mockResolvedValueOnce({
        agentSummaries: [
          { agentId: 'agent-1', agentName: 'TestAgent', description: 'A test agent' },
          { agentId: 'agent-2', agentName: 'AnotherAgent', description: '' },
        ],
      });

      const result = await listBedrockAgents('us-east-1');
      expect(result).toEqual([
        { agentId: 'agent-1', agentName: 'TestAgent', description: 'A test agent' },
        { agentId: 'agent-2', agentName: 'AnotherAgent', description: '' },
      ]);
    });

    it('returns empty array when no agents', async () => {
      mockAgentSend.mockResolvedValueOnce({ agentSummaries: [] });

      const result = await listBedrockAgents('us-east-1');
      expect(result).toEqual([]);
    });
  });

  describe('listBedrockAgentAliases', () => {
    it('returns mapped alias summaries', async () => {
      mockAgentSend.mockResolvedValueOnce({
        agentAliasSummaries: [{ agentAliasId: 'alias-1', agentAliasName: 'prod', description: 'Production' }],
      });

      const result = await listBedrockAgentAliases('us-east-1', 'agent-1');
      expect(result).toEqual([{ aliasId: 'alias-1', aliasName: 'prod', description: 'Production' }]);
    });
  });

  describe('getBedrockAgentConfig', () => {
    it('fetches full agent config with action groups and KBs', async () => {
      // GetAgentAliasCommand
      mockAgentSend.mockResolvedValueOnce({
        agentAlias: { routingConfiguration: [{ agentVersion: '1' }] },
      });
      // GetAgentCommand
      mockAgentSend.mockResolvedValueOnce({
        agent: {
          agentId: 'agent-1',
          agentName: 'TestAgent',
          agentArn: 'arn:aws:bedrock:us-east-1:123456:agent/agent-1',
          foundationModel: 'anthropic.claude-3-sonnet',
          instruction: 'You are helpful.',
          orchestrationType: 'DEFAULT',
          promptOverrideConfiguration: { promptConfigurations: [] },
          agentCollaboration: 'DISABLED',
        },
      });
      // GetFoundationModelCommand
      mockBedrockSend.mockResolvedValueOnce({
        modelDetails: { modelId: 'claude-3-sonnet', modelName: 'Claude 3 Sonnet', providerName: 'Anthropic' },
      });
      // ListAgentActionGroupsCommand
      mockAgentSend.mockResolvedValueOnce({ actionGroupSummaries: [] });
      // ListAgentKnowledgeBasesCommand
      mockAgentSend.mockResolvedValueOnce({ agentKnowledgeBaseSummaries: [] });

      const result = await getBedrockAgentConfig('us-east-1', 'agent-1', 'alias-1');

      expect(result.agent.agentId).toBe('agent-1');
      expect(result.agent.agentName).toBe('TestAgent');
      expect(result.agent.model?.providerName).toBe('Anthropic');
      expect(result.action_groups).toEqual([]);
      expect(result.knowledge_bases).toEqual([]);
      expect(result.collaborators).toEqual([]);
    });
  });
});
