/* eslint-disable security/detect-non-literal-fs-filename */
import { exists, prereqs, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(!prereqs.npm || !prereqs.git)('integration: create with different frameworks', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-frameworks-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates LangChain_LangGraph project', async () => {
    const name = `LG${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--framework',
        'LangChain_LangGraph',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const agentName = json.agentName || name;
    const agentDir = join(json.projectPath, 'app', agentName);

    // Verify agent files exist
    expect(await exists(agentDir), 'Agent directory should exist').toBe(true);
    expect(await exists(join(agentDir, 'pyproject.toml')), 'pyproject.toml should exist').toBe(true);

    // Verify pyproject.toml references langgraph and langchain
    const pyproject = await readFile(join(agentDir, 'pyproject.toml'), 'utf-8');
    const pyprojectLower = pyproject.toLowerCase();
    expect(pyprojectLower.includes('langgraph'), 'pyproject.toml should reference langgraph').toBe(true);
    expect(pyprojectLower.includes('langchain'), 'pyproject.toml should reference langchain').toBe(true);

    // Verify config has agent registered
    const config = await readProjectConfig(json.projectPath);
    const agents = config.agents as Record<string, unknown>[];
    expect(agents).toBeDefined();
    expect(agents.length).toBe(1);
    expect(agents[0]!.name).toBe(agentName);
  });

  it('creates CrewAI project', async () => {
    const name = `Crew${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--framework',
        'CrewAI',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const agentName = json.agentName || name;
    const agentDir = join(json.projectPath, 'app', agentName);

    expect(await exists(agentDir), 'Agent directory should exist').toBe(true);
    expect(await exists(join(agentDir, 'pyproject.toml')), 'pyproject.toml should exist').toBe(true);

    // Verify pyproject.toml references crewai
    const pyproject = await readFile(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(pyproject.toLowerCase().includes('crewai'), 'pyproject.toml should reference crewai').toBeTruthy();

    const config = await readProjectConfig(json.projectPath);
    const agents = config.agents as Record<string, unknown>[];
    expect(agents.length).toBe(1);
    expect(agents[0]!.name).toBe(agentName);
  });

  it('creates GoogleADK project with Gemini provider', async () => {
    const name = `Gadk${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--framework',
        'GoogleADK',
        '--model-provider',
        'Gemini',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const agentName = json.agentName || name;
    const agentDir = join(json.projectPath, 'app', agentName);

    expect(await exists(agentDir), 'Agent directory should exist').toBe(true);
    expect(await exists(join(agentDir, 'pyproject.toml')), 'pyproject.toml should exist').toBe(true);

    // Verify pyproject.toml references google-adk
    const pyproject = await readFile(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(
      pyproject.toLowerCase().includes('google') || pyproject.toLowerCase().includes('adk'),
      'pyproject.toml should reference google adk'
    ).toBeTruthy();

    // Verify config has agent registered
    const config = await readProjectConfig(json.projectPath);
    const agents = config.agents as Record<string, unknown>[];
    expect(agents.length).toBe(1);
    expect(agents[0]!.name).toBe(agentName);
  });

  it('creates OpenAIAgents project with OpenAI provider', async () => {
    const name = `Oai${Date.now().toString().slice(-6)}`;
    const result = await runCLI(
      [
        'create',
        '--name',
        name,
        '--language',
        'Python',
        '--framework',
        'OpenAIAgents',
        '--model-provider',
        'OpenAI',
        '--memory',
        'none',
        '--json',
      ],
      testDir
    );

    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const agentName = json.agentName || name;
    const agentDir = join(json.projectPath, 'app', agentName);

    expect(await exists(agentDir), 'Agent directory should exist').toBe(true);
    expect(await exists(join(agentDir, 'pyproject.toml')), 'pyproject.toml should exist').toBe(true);

    // Verify pyproject.toml references openai-agents
    const pyproject = await readFile(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(pyproject.toLowerCase().includes('openai'), 'pyproject.toml should reference openai').toBeTruthy();

    // Verify config has agent registered
    const config = await readProjectConfig(json.projectPath);
    const agents = config.agents as Record<string, unknown>[];
    expect(agents.length).toBe(1);
    expect(agents[0]!.name).toBe(agentName);
  });
});
