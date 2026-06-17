import { type TestProject, createTestProject, parseJsonOutput, runCLI } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Client-side CLI validation for `agentcore run ab-test` (the fire-and-forget jobs-model command
 * that replaced the old `add/remove ab-test` primitive). No live AWS — every case here must fail
 * fast on local validation before any API call. Mirrors integ-tests/recommendation.test.ts.
 */
describe('integration: run ab-test CLI validation', () => {
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

  describe('required flags', () => {
    it('requires --name and --gateway in non-interactive (JSON) mode', async () => {
      const result = await runCLI(['run', 'ab-test', '--json'], project.projectPath);
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('--name');
      expect(json.error).toContain('--gateway');
    });

    it('rejects an invalid --mode', async () => {
      const result = await runCLI(
        ['run', 'ab-test', '--name', 'MyTest', '--gateway', 'MyGw', '--mode', 'bogus-mode', '--json'],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('--mode');
    });
  });

  describe('variant weight validation', () => {
    it('rejects weights that do not sum to 100', async () => {
      const result = await runCLI(
        [
          'run',
          'ab-test',
          '--name',
          'MyTest',
          '--gateway',
          'MyGw',
          '--control-weight',
          '60',
          '--treatment-weight',
          '60',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('sum to 100');
    });

    it('rejects a non-integer / out-of-range weight', async () => {
      const result = await runCLI(
        [
          'run',
          'ab-test',
          '--name',
          'MyTest',
          '--gateway',
          'MyGw',
          '--control-weight',
          '150',
          '--treatment-weight',
          '50',
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('between 0 and 100');
    });
  });

  describe('mode-specific required inputs', () => {
    it('config-bundle mode requires control/treatment bundle names and versions', async () => {
      const result = await runCLI(
        ['run', 'ab-test', '--name', 'MyTest', '--gateway', 'MyGw', '--mode', 'config-bundle', '--json'],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
    });

    it('target-based mode requires control/treatment targets', async () => {
      const result = await runCLI(
        ['run', 'ab-test', '--name', 'MyTest', '--gateway', 'MyGw', '--mode', 'target-based', '--json'],
        project.projectPath
      );
      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
    });
  });
});
