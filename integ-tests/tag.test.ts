import { createTestProject, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: tag command', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  it('creates project with auto-tags in agentcore.json', async () => {
    const specPath = join(project.projectPath, 'agentcore', 'agentcore.json');
    const spec = JSON.parse(await readFile(specPath, 'utf-8'));
    expect(spec.tags).toEqual({
      'agentcore:created-by': 'agentcore-cli',
      'agentcore:project-name': expect.any(String),
    });
  });

  it('set-defaults adds a project-level tag', async () => {
    const result = await runCLI(
      ['tag', 'set-defaults', '--key', 'environment', '--value', 'dev', '--json'],
      project.projectPath
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(true);

    // Verify in agentcore.json
    const specPath = join(project.projectPath, 'agentcore', 'agentcore.json');
    const spec = JSON.parse(await readFile(specPath, 'utf-8'));
    expect(spec.tags.environment).toBe('dev');
  });

  it('tag add sets a per-resource tag', async () => {
    // Get the agent name from spec
    const specPath = join(project.projectPath, 'agentcore', 'agentcore.json');
    const spec = JSON.parse(await readFile(specPath, 'utf-8'));
    const agentName = spec.agents[0]?.name;
    expect(agentName, 'Expected at least one agent in the project').toBeDefined();

    const result = await runCLI(
      ['tag', 'add', '--resource', `agent:${agentName}`, '--key', 'cost-center', '--value', '12345', '--json'],
      project.projectPath
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    // Verify in agentcore.json
    const updatedSpec = JSON.parse(await readFile(specPath, 'utf-8'));
    expect(updatedSpec.agents[0].tags).toEqual({ 'cost-center': '12345' });
  });

  it('tag list returns JSON output', async () => {
    const result = await runCLI(['tag', 'list', '--json'], project.projectPath);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.projectDefaults).toBeDefined();
    expect(output.resources).toBeInstanceOf(Array);
  });

  it('tag remove removes a per-resource tag', async () => {
    const specPath = join(project.projectPath, 'agentcore', 'agentcore.json');
    const spec = JSON.parse(await readFile(specPath, 'utf-8'));
    const agentName = spec.agents[0]?.name;
    expect(agentName, 'Expected at least one agent in the project').toBeDefined();
    expect(spec.agents[0].tags?.['cost-center'], 'Expected cost-center tag from previous test').toBeDefined();

    const result = await runCLI(
      ['tag', 'remove', '--resource', `agent:${agentName}`, '--key', 'cost-center', '--json'],
      project.projectPath
    );
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const updatedSpec = JSON.parse(await readFile(specPath, 'utf-8'));
    expect(updatedSpec.agents[0].tags).toBeUndefined();
  });

  it('remove-defaults removes a project-level tag', async () => {
    const result = await runCLI(['tag', 'remove-defaults', '--key', 'environment', '--json'], project.projectPath);
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const specPath = join(project.projectPath, 'agentcore', 'agentcore.json');
    const spec = JSON.parse(await readFile(specPath, 'utf-8'));
    expect(spec.tags.environment).toBeUndefined();
  });
});
