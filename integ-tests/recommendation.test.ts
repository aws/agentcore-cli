import { type TestProject, createTestProject, parseJsonOutput, runCLI } from '../src/test-utils/index.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: run recommendation CLI validation', () => {
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
    it('requires --runtime', async () => {
      const result = await runCLI(
        ['run', 'recommendation', '--evaluator', 'Builtin.Faithfulness', '--inline', 'test prompt', '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('--runtime');
    });

    it('requires --evaluator for system-prompt type', async () => {
      const result = await runCLI(
        ['run', 'recommendation', '--runtime', project.agentName, '--inline', 'test prompt', '--json'],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('--evaluator');
    });

    it('rejects invalid --type', async () => {
      const result = await runCLI(
        [
          'run',
          'recommendation',
          '--type',
          'invalid-type',
          '--runtime',
          project.agentName,
          '--evaluator',
          'Builtin.Faithfulness',
          '--inline',
          'test prompt',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('--type');
    });
  });

  describe('system-prompt recommendation input validation', () => {
    it('fails with non-existent prompt file', async () => {
      const result = await runCLI(
        [
          'run',
          'recommendation',
          '--runtime',
          project.agentName,
          '--evaluator',
          'Builtin.Faithfulness',
          '--prompt-file',
          '/tmp/nonexistent-prompt-file-xyz.txt',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
    });
  });

  describe('spans file validation', () => {
    it('fails when spans file does not exist', async () => {
      const result = await runCLI(
        [
          'run',
          'recommendation',
          '--runtime',
          project.agentName,
          '--evaluator',
          'Builtin.Faithfulness',
          '--inline',
          'You are a helpful assistant.',
          '--spans-file',
          '/tmp/nonexistent-spans-xyz.json',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
    });

    it('fails when spans file contains invalid JSON', async () => {
      const spansFile = join(project.projectPath, 'bad-spans.json');
      await writeFile(spansFile, 'not valid json');

      const result = await runCLI(
        [
          'run',
          'recommendation',
          '--runtime',
          project.agentName,
          '--evaluator',
          'Builtin.Faithfulness',
          '--inline',
          'You are a helpful assistant.',
          '--spans-file',
          spansFile,
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
    });
  });
});
