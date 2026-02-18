import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration tests for multi-agent credential behavior (Option C).
 *
 * Tests the smart credential detection:
 * - Same API key → reuse existing project-scoped credential
 * - Different API key → create agent-scoped credential
 * - Remove agent → clean up agent-scoped credentials
 */
describe('multi-agent credential behavior', () => {
  let testDir: string;
  let projectDir: string;
  const projectName = 'MultiAgentProj';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-multi-agent-cred-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project without agent
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function readProjectSpec() {
    const content = await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8');
    return JSON.parse(content);
  }

  async function readEnvLocal() {
    try {
      return await readFile(join(projectDir, 'agentcore/.env.local'), 'utf-8');
    } catch {
      return '';
    }
  }

  describe('credential reuse with same API key', () => {
    it('first agent creates project-scoped credential', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Agent1',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Gemini',
          '--api-key',
          'KEY1',
          '--memory',
          'none',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const spec = await readProjectSpec();
      expect(spec.credentials).toHaveLength(1);
      expect(spec.credentials[0].name).toBe(`${projectName}Gemini`);

      const env = await readEnvLocal();
      expect(env).toContain('AGENTCORE_CREDENTIAL_MULTIAGENTPROJGEMINI=');
      expect(env).toContain('KEY1');
    });

    it('second agent with same key reuses credential (no duplicate)', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Agent2',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Gemini',
          '--api-key',
          'KEY1',
          '--memory',
          'none',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const spec = await readProjectSpec();
      // Should still have only 1 credential (reused)
      expect(spec.credentials).toHaveLength(1);
      expect(spec.credentials[0].name).toBe(`${projectName}Gemini`);

      // Should have 2 agents
      expect(spec.agents).toHaveLength(2);
    });
  });

  describe('agent-scoped credential with different API key', () => {
    it('third agent with different key creates agent-scoped credential', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Agent3',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Gemini',
          '--api-key',
          'KEY2',
          '--memory',
          'none',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const spec = await readProjectSpec();
      // Should now have 2 credentials
      expect(spec.credentials).toHaveLength(2);

      const credNames = spec.credentials.map((c: { name: string }) => c.name);
      expect(credNames).toContain(`${projectName}Gemini`);
      expect(credNames).toContain(`${projectName}Agent3Gemini`);

      // Should have 3 agents
      expect(spec.agents).toHaveLength(3);

      // .env.local should have both keys
      const env = await readEnvLocal();
      expect(env).toContain('AGENTCORE_CREDENTIAL_MULTIAGENTPROJGEMINI=');
      expect(env).toContain('KEY1');
      expect(env).toContain('AGENTCORE_CREDENTIAL_MULTIAGENTPROJAGENT3GEMINI=');
      expect(env).toContain('KEY2');

      // Generated code should reference correct credentials
      const agent1Code = await readFile(join(projectDir, 'app/Agent1/model/load.py'), 'utf-8');
      expect(agent1Code).toContain(`IDENTITY_PROVIDER_NAME = "${projectName}Gemini"`);

      const agent3Code = await readFile(join(projectDir, 'app/Agent3/model/load.py'), 'utf-8');
      expect(agent3Code).toContain(`IDENTITY_PROVIDER_NAME = "${projectName}Agent3Gemini"`);
    });
  });

  describe('credential persistence on agent removal', () => {
    it('removing agent preserves agent-scoped credential for reuse', async () => {
      const result = await runCLI(['remove', 'agent', '--name', 'Agent3', '--json'], projectDir);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const spec = await readProjectSpec();
      // Credentials preserved (both project-scoped and agent-scoped)
      expect(spec.credentials).toHaveLength(2);
      expect(spec.credentials.map((c: { name: string }) => c.name)).toContain(`${projectName}Gemini`);
      expect(spec.credentials.map((c: { name: string }) => c.name)).toContain(`${projectName}Agent3Gemini`);

      // Should have 2 agents
      expect(spec.agents).toHaveLength(2);
    });

    it('removing agent with shared credential preserves credential', async () => {
      // Remove Agent2 (uses shared project-scoped credential)
      const result = await runCLI(['remove', 'agent', '--name', 'Agent2', '--json'], projectDir);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const spec = await readProjectSpec();
      // Both credentials still exist
      expect(spec.credentials).toHaveLength(2);

      // Should have 1 agent
      expect(spec.agents).toHaveLength(1);
    });
  });

  describe('BYO (bring-your-own) agent path', () => {
    it('BYO agent with same key reuses credential', async () => {
      // Create a code directory for BYO agent
      const byoDir = join(projectDir, 'app/ByoAgent');
      await mkdir(byoDir, { recursive: true });
      await writeFile(join(byoDir, 'main.py'), '# BYO agent');

      const specBefore = await readProjectSpec();
      const credCountBefore = specBefore.credentials.length;

      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'ByoAgent',
          '--type',
          'byo',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--code-location',
          'app/ByoAgent/',
          '--model-provider',
          'Gemini',
          '--api-key',
          'KEY1',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const spec = await readProjectSpec();
      // Should still have same number of credentials (reused)
      expect(spec.credentials).toHaveLength(credCountBefore);
    });

    it('BYO agent with different key creates agent-scoped credential', async () => {
      const byoDir2 = join(projectDir, 'app/ByoAgent2');
      await mkdir(byoDir2, { recursive: true });
      await writeFile(join(byoDir2, 'main.py'), '# BYO agent 2');

      const specBefore = await readProjectSpec();
      const credCountBefore = specBefore.credentials.length;

      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'ByoAgent2',
          '--type',
          'byo',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--code-location',
          'app/ByoAgent2/',
          '--model-provider',
          'Gemini',
          '--api-key',
          'DIFFERENT_KEY',
          '--json',
        ],
        projectDir
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const spec = await readProjectSpec();
      // Should have one more credential
      expect(spec.credentials).toHaveLength(credCountBefore + 1);
      const credNames = spec.credentials.map((c: { name: string }) => c.name);
      expect(credNames).toContain(`${projectName}ByoAgent2Gemini`);
    });
  });
});
