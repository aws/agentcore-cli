import {
  type TestProject,
  createTestProject,
  parseJsonOutput,
  readProjectConfig,
  runCLI,
} from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function runSuccess(args: string[], cwd: string) {
  const result = await runCLI(args, cwd);
  expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', true);
  return json as Record<string, unknown>;
}

async function runFailure(args: string[], cwd: string) {
  const result = await runCLI(args, cwd);
  expect(result.exitCode).toBe(1);
  const json: unknown = parseJsonOutput(result.stdout);
  expect(json).toHaveProperty('success', false);
  expect(json).toHaveProperty('error');
  return json as Record<string, unknown>;
}

describe('integration: add and remove runtime-endpoint', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({
      name: 'RuntimeEP',
      language: 'Python',
      framework: 'Strands',
      modelProvider: 'Bedrock',
      memory: 'none',
    });
  }, 120_000);

  afterAll(async () => {
    await project.cleanup();
  });

  it('adds an endpoint to a runtime and writes it to agentcore.json', async () => {
    await runSuccess(
      ['add', 'runtime-endpoint', '--runtime', project.agentName, '--endpoint', 'prod', '--version', '1', '--json'],
      project.projectPath
    );

    const spec = await readProjectConfig(project.projectPath);
    const runtime = spec.runtimes.find(r => r.name === project.agentName);
    expect(runtime).toBeDefined();
    expect(runtime!.endpoints).toBeDefined();
    expect(runtime!.endpoints!.prod).toBeDefined();
    expect(runtime!.endpoints!.prod!.version).toBe(1);
  });

  it('rejects duplicate endpoint name', async () => {
    const json = await runFailure(
      ['add', 'runtime-endpoint', '--runtime', project.agentName, '--endpoint', 'prod', '--version', '1', '--json'],
      project.projectPath
    );

    // RuntimeEndpointPrimitive returns: `Endpoint "<name>" already exists on runtime "<runtime>".`
    expect(String(json.error)).toMatch(/already exists|prod|duplicate/i);
  });

  it('removes endpoint from runtime', async () => {
    await runSuccess(
      ['remove', 'runtime-endpoint', '--name', `${project.agentName}/prod`, '--yes', '--json'],
      project.projectPath
    );

    const spec = await readProjectConfig(project.projectPath);
    const runtime = spec.runtimes.find(r => r.name === project.agentName);
    expect(runtime).toBeDefined();
    expect(runtime!.endpoints?.prod).toBeUndefined();
  });

  it('returns error when removing non-existent endpoint', async () => {
    const json = await runFailure(
      ['remove', 'runtime-endpoint', '--name', `${project.agentName}/nonexistent`, '--yes', '--json'],
      project.projectPath
    );

    // RuntimeEndpointPrimitive returns: `Runtime endpoint "<name>" not found.`
    expect(String(json.error)).toMatch(/not found|nonexistent/i);
  });
});
