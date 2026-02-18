import type { GenerateConfig } from '../../../../tui/screens/generate/types.js';
import type { CredentialStrategy } from '../../../identity/create-identity.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('writeAgentToProject with credentialStrategy', () => {
  let testDir: string;
  let configBaseDir: string;

  const baseConfig: GenerateConfig = {
    projectName: 'TestAgent',
    sdk: 'Strands',
    modelProvider: 'Gemini',
    memory: 'none',
    language: 'Python',
  };

  const baseProject = {
    name: 'MyProject',
    version: 1,
    agents: [],
    memories: [],
    credentials: [],
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `write-agent-test-${randomUUID()}`);
    configBaseDir = join(testDir, 'agentcore');
    await mkdir(configBaseDir, { recursive: true });
    await writeFile(join(configBaseDir, 'agentcore.json'), JSON.stringify(baseProject, null, 2));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Dynamic import to get fresh module after setup
  async function getWriteAgentToProject() {
    const mod = await import('../write-agent-to-project.js');
    return mod.writeAgentToProject;
  }

  async function readProject() {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(configBaseDir, 'agentcore.json'), 'utf-8');
    return JSON.parse(content);
  }

  describe('with credentialStrategy.reuse = true', () => {
    it('does not add credential to project', async () => {
      const writeAgentToProject = await getWriteAgentToProject();
      const strategy: CredentialStrategy = {
        reuse: true,
        credentialName: 'MyProjectGemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI',
        isAgentScoped: false,
      };

      await writeAgentToProject(baseConfig, {
        configBaseDir,
        credentialStrategy: strategy,
      });

      const project = await readProject();
      expect(project.credentials).toHaveLength(0);
      expect(project.agents).toHaveLength(1);
    });
  });

  describe('with credentialStrategy.reuse = false', () => {
    it('adds credential with strategy.credentialName', async () => {
      const writeAgentToProject = await getWriteAgentToProject();
      const strategy: CredentialStrategy = {
        reuse: false,
        credentialName: 'MyProjectAgent2Gemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTAGENT2GEMINI',
        isAgentScoped: true,
      };

      await writeAgentToProject(baseConfig, {
        configBaseDir,
        credentialStrategy: strategy,
      });

      const project = await readProject();
      expect(project.credentials).toHaveLength(1);
      expect(project.credentials[0].name).toBe('MyProjectAgent2Gemini');
    });

    it('adds project-scoped credential name', async () => {
      const writeAgentToProject = await getWriteAgentToProject();
      const strategy: CredentialStrategy = {
        reuse: false,
        credentialName: 'MyProjectGemini',
        envVarName: 'AGENTCORE_CREDENTIAL_MYPROJECTGEMINI',
        isAgentScoped: false,
      };

      await writeAgentToProject(baseConfig, {
        configBaseDir,
        credentialStrategy: strategy,
      });

      const project = await readProject();
      expect(project.credentials[0].name).toBe('MyProjectGemini');
    });
  });

  describe('duplicate agent detection', () => {
    it('throws AgentAlreadyExistsError for duplicate name', async () => {
      const writeAgentToProject = await getWriteAgentToProject();
      // First write an agent, then try to write the same one again
      await writeAgentToProject(baseConfig, { configBaseDir });

      await expect(writeAgentToProject(baseConfig, { configBaseDir })).rejects.toThrow('TestAgent');
    });
  });

  describe('new project creation (no existing config)', () => {
    it('creates project spec when config does not exist', async () => {
      const writeAgentToProject = await getWriteAgentToProject();
      // Remove the existing config so configExists('project') returns false
      const { rm: rmFile } = await import('node:fs/promises');
      await rmFile(join(configBaseDir, 'agentcore.json'));

      await writeAgentToProject(baseConfig, { configBaseDir });

      const project = await readProject();
      expect(project.name).toBe('TestAgent');
      expect(project.agents).toHaveLength(1);
      expect(project.agents[0].name).toBe('TestAgent');
    });
  });

  describe('without credentialStrategy (backward compatibility)', () => {
    it('uses mapModelProviderToCredentials behavior', async () => {
      const writeAgentToProject = await getWriteAgentToProject();

      await writeAgentToProject(baseConfig, { configBaseDir });

      const project = await readProject();
      expect(project.credentials).toHaveLength(1);
      expect(project.credentials[0].name).toBe('MyProjectGemini');
    });

    it('adds no credential for Bedrock', async () => {
      const writeAgentToProject = await getWriteAgentToProject();
      const bedrockConfig: GenerateConfig = {
        ...baseConfig,
        modelProvider: 'Bedrock',
      };

      await writeAgentToProject(bedrockConfig, { configBaseDir });

      const project = await readProject();
      expect(project.credentials).toHaveLength(0);
    });
  });
});
