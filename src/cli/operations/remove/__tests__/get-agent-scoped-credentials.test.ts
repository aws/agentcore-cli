import type { Credential } from '../../../../schema/index.js';
import { getAgentScopedCredentials } from '../remove-agent.js';
import { describe, expect, it } from 'vitest';

describe('getAgentScopedCredentials', () => {
  const projectName = 'MyProject';

  const makeCredential = (name: string): Credential => ({ name, type: 'ApiKeyCredentialProvider' });

  describe('matches agent-scoped credentials', () => {
    it('matches credential for the specified agent', () => {
      const credentials = [makeCredential('MyProjectAgent2Gemini'), makeCredential('MyProjectGemini')];

      const result = getAgentScopedCredentials(projectName, 'Agent2', credentials);

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('MyProjectAgent2Gemini');
    });

    it('matches multiple providers for same agent', () => {
      const credentials = [
        makeCredential('MyProjectAgent2Gemini'),
        makeCredential('MyProjectAgent2OpenAI'),
        makeCredential('MyProjectAgent2Anthropic'),
      ];

      const result = getAgentScopedCredentials(projectName, 'Agent2', credentials);

      expect(result).toHaveLength(3);
    });

    it('matches OpenAI provider', () => {
      const credentials = [makeCredential('MyProjectAgent1OpenAI')];
      const result = getAgentScopedCredentials(projectName, 'Agent1', credentials);
      expect(result).toHaveLength(1);
    });

    it('matches Anthropic provider', () => {
      const credentials = [makeCredential('MyProjectAgent1Anthropic')];
      const result = getAgentScopedCredentials(projectName, 'Agent1', credentials);
      expect(result).toHaveLength(1);
    });
  });

  describe('does NOT match', () => {
    it('does not match project-scoped credentials', () => {
      const credentials = [makeCredential('MyProjectGemini')];

      const result = getAgentScopedCredentials(projectName, 'Agent1', credentials);

      expect(result).toHaveLength(0);
    });

    it('does not match credentials for different agent', () => {
      const credentials = [makeCredential('MyProjectAgent1Gemini')];

      const result = getAgentScopedCredentials(projectName, 'Agent2', credentials);

      expect(result).toHaveLength(0);
    });

    it('does not match Bedrock (no credentials)', () => {
      const credentials = [makeCredential('MyProjectAgent1Bedrock')];

      const result = getAgentScopedCredentials(projectName, 'Agent1', credentials);

      expect(result).toHaveLength(0);
    });
  });

  describe('pattern edge cases', () => {
    it('TestA does NOT match TestAB credentials', () => {
      // Critical edge case: Agent "TestA" should not match "TestAB"'s credentials
      const credentials = [makeCredential('MyProjectTestAGemini'), makeCredential('MyProjectTestABGemini')];

      const result = getAgentScopedCredentials(projectName, 'TestA', credentials);

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('MyProjectTestAGemini');
    });

    it('TestAB does NOT match TestA credentials', () => {
      const credentials = [makeCredential('MyProjectTestAGemini'), makeCredential('MyProjectTestABGemini')];

      const result = getAgentScopedCredentials(projectName, 'TestAB', credentials);

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('MyProjectTestABGemini');
    });

    it('handles agent names with numbers', () => {
      const credentials = [makeCredential('MyProjectAgent123Gemini')];

      const result = getAgentScopedCredentials(projectName, 'Agent123', credentials);

      expect(result).toHaveLength(1);
    });

    it('returns empty array for empty credentials', () => {
      const result = getAgentScopedCredentials(projectName, 'Agent1', []);
      expect(result).toHaveLength(0);
    });

    it('handles project names with numbers', () => {
      const credentials = [makeCredential('Project123Agent1Gemini')];

      const result = getAgentScopedCredentials('Project123', 'Agent1', credentials);

      expect(result).toHaveLength(1);
    });
  });
});
