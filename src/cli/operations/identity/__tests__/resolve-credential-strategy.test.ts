import * as lib from '../../../../lib/index.js';
import type { Credential } from '../../../../schema/index.js';
import { resolveCredentialStrategy } from '../create-identity.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/index.js', async () => {
  const actual = await vi.importActual('../../../../lib/index.js');
  return {
    ...actual,
    getEnvVar: vi.fn(),
  };
});

const mockGetEnvVar = vi.mocked(lib.getEnvVar);

describe('resolveCredentialStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const projectName = 'MyProject';
  const agentName = 'Agent1';
  const configBaseDir = '/fake/path';

  describe('early returns', () => {
    it('returns reuse=true with empty credential for Bedrock provider', async () => {
      const result = await resolveCredentialStrategy(projectName, agentName, 'Bedrock', 'some-key', configBaseDir, []);

      expect(result).toEqual({
        reuse: true,
        credentialName: '',
        envVarName: '',
        isAgentScoped: false,
      });
      expect(mockGetEnvVar).not.toHaveBeenCalled();
    });

    it('returns reuse=true with empty credential when no API key provided', async () => {
      const result = await resolveCredentialStrategy(projectName, agentName, 'Gemini', undefined, configBaseDir, []);

      expect(result).toEqual({
        reuse: true,
        credentialName: '',
        envVarName: '',
        isAgentScoped: false,
      });
      expect(mockGetEnvVar).not.toHaveBeenCalled();
    });

    it('returns reuse=true with empty credential when API key is empty string', async () => {
      const result = await resolveCredentialStrategy(projectName, agentName, 'Gemini', '', configBaseDir, []);

      expect(result).toEqual({
        reuse: true,
        credentialName: '',
        envVarName: '',
        isAgentScoped: false,
      });
    });
  });

  describe('first agent (no existing credential)', () => {
    it('creates project-scoped credential when no existing credentials', async () => {
      const result = await resolveCredentialStrategy(projectName, agentName, 'Gemini', 'my-api-key', configBaseDir, []);

      expect(result).toEqual({
        reuse: false,
        credentialName: 'MyProjectGemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI',
        isAgentScoped: false,
      });
      expect(mockGetEnvVar).not.toHaveBeenCalled();
    });

    it('creates project-scoped credential for OpenAI', async () => {
      const result = await resolveCredentialStrategy(projectName, agentName, 'OpenAI', 'my-api-key', configBaseDir, []);

      expect(result.credentialName).toBe('MyProjectOpenAI');
      expect(result.envVarName).toBe('AGENTCORE_CREDENTIAL_MYPROJECTOPENAI');
    });

    it('creates project-scoped credential for Anthropic', async () => {
      const result = await resolveCredentialStrategy(
        projectName,
        agentName,
        'Anthropic',
        'my-api-key',
        configBaseDir,
        []
      );

      expect(result.credentialName).toBe('MyProjectAnthropic');
      expect(result.envVarName).toBe('AGENTCORE_CREDENTIAL_MYPROJECTANTHROPIC');
    });
  });

  describe('credential exists - key comparison', () => {
    const existingCredentials: Credential[] = [{ name: 'MyProjectGemini', type: 'ApiKeyCredentialProvider' }];

    it('reuses credential when API keys match', async () => {
      mockGetEnvVar.mockResolvedValue('same-key');

      const result = await resolveCredentialStrategy(
        projectName,
        agentName,
        'Gemini',
        'same-key',
        configBaseDir,
        existingCredentials
      );

      expect(result).toEqual({
        reuse: true,
        credentialName: 'MyProjectGemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI',
        isAgentScoped: false,
      });
      expect(mockGetEnvVar).toHaveBeenCalledWith('AGENTCORE_CREDENTIAL_MYPROJECTGEMINI', configBaseDir);
    });

    it('creates agent-scoped credential when API keys differ', async () => {
      mockGetEnvVar.mockResolvedValue('existing-key');

      const result = await resolveCredentialStrategy(
        projectName,
        'Agent2',
        'Gemini',
        'different-key',
        configBaseDir,
        existingCredentials
      );

      expect(result).toEqual({
        reuse: false,
        credentialName: 'MyProjectAgent2Gemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT2GEMINI',
        isAgentScoped: true,
      });
    });

    it('creates agent-scoped credential when no existing keys can be read', async () => {
      mockGetEnvVar.mockResolvedValue(undefined);

      const result = await resolveCredentialStrategy(
        projectName,
        agentName,
        'Gemini',
        'new-key',
        configBaseDir,
        existingCredentials
      );

      // Can't verify existing key matches, so create agent-scoped to be safe
      expect(result).toEqual({
        reuse: false,
        credentialName: 'MyProjectAgent1Gemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT1GEMINI',
        isAgentScoped: true,
      });
    });
  });

  describe('reuses agent-scoped credential when keys match', () => {
    it('agent3 reuses agent2 credential when both use same secondary key', async () => {
      // Scenario: agent1 uses mainKey (project-scoped), agent2 uses secondaryKey (agent-scoped)
      // agent3 also uses secondaryKey - should reuse agent2's credential
      const existingCredentials: Credential[] = [
        { name: 'MyProjectGemini', type: 'ApiKeyCredentialProvider' },
        { name: 'MyProjectAgent2Gemini', type: 'ApiKeyCredentialProvider' },
      ];

      mockGetEnvVar.mockImplementation((envVar: string) => {
        if (envVar === 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI') return Promise.resolve('main-key');
        if (envVar === 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT2GEMINI') return Promise.resolve('secondary-key');
        return Promise.resolve(undefined);
      });

      const result = await resolveCredentialStrategy(
        projectName,
        'Agent3',
        'Gemini',
        'secondary-key',
        configBaseDir,
        existingCredentials
      );

      expect(result).toEqual({
        reuse: true,
        credentialName: 'MyProjectAgent2Gemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT2GEMINI',
        isAgentScoped: true,
      });
    });

    it('agent3 reuses project-scoped credential when using main key', async () => {
      const existingCredentials: Credential[] = [
        { name: 'MyProjectGemini', type: 'ApiKeyCredentialProvider' },
        { name: 'MyProjectAgent2Gemini', type: 'ApiKeyCredentialProvider' },
      ];

      mockGetEnvVar.mockImplementation((envVar: string) => {
        if (envVar === 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI') return Promise.resolve('main-key');
        if (envVar === 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT2GEMINI') return Promise.resolve('secondary-key');
        return Promise.resolve(undefined);
      });

      const result = await resolveCredentialStrategy(
        projectName,
        'Agent3',
        'Gemini',
        'main-key',
        configBaseDir,
        existingCredentials
      );

      expect(result).toEqual({
        reuse: true,
        credentialName: 'MyProjectGemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI',
        isAgentScoped: false,
      });
    });

    it('creates new agent-scoped credential when key matches no existing credential', async () => {
      const existingCredentials: Credential[] = [
        { name: 'MyProjectGemini', type: 'ApiKeyCredentialProvider' },
        { name: 'MyProjectAgent2Gemini', type: 'ApiKeyCredentialProvider' },
      ];

      mockGetEnvVar.mockImplementation((envVar: string) => {
        if (envVar === 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI') return Promise.resolve('main-key');
        if (envVar === 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT2GEMINI') return Promise.resolve('secondary-key');
        return Promise.resolve(undefined);
      });

      const result = await resolveCredentialStrategy(
        projectName,
        'Agent3',
        'Gemini',
        'third-key',
        configBaseDir,
        existingCredentials
      );

      expect(result).toEqual({
        reuse: false,
        credentialName: 'MyProjectAgent3Gemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT3GEMINI',
        isAgentScoped: true,
      });
    });
  });

  describe('credential name format', () => {
    it('concatenates project name, agent name, and provider correctly', async () => {
      mockGetEnvVar.mockResolvedValue('old-key');

      const result = await resolveCredentialStrategy('TestProject', 'MyAgent', 'OpenAI', 'new-key', configBaseDir, [
        { name: 'TestProjectOpenAI', type: 'ApiKeyCredentialProvider' },
      ]);

      expect(result.credentialName).toBe('TestProjectMyAgentOpenAI');
      expect(result.isAgentScoped).toBe(true);
    });

    it('handles project names with numbers', async () => {
      const result = await resolveCredentialStrategy('Project123', 'Agent1', 'Gemini', 'key', configBaseDir, []);

      expect(result.credentialName).toBe('Project123Gemini');
    });
  });

  describe('env var name format', () => {
    it('uppercases credential name in env var', async () => {
      const result = await resolveCredentialStrategy('myproject', 'agent', 'Gemini', 'key', configBaseDir, []);

      expect(result.envVarName).toBe('AGENTCORE_CREDENTIAL_MYPROJECTGEMINI');
    });
  });
});
