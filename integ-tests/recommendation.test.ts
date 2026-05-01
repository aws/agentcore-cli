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
    it('fails when agent not deployed (inline input)', async () => {
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
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('deployed');
    });

    it('fails when agent not deployed (file input)', async () => {
      const promptFile = join(project.projectPath, 'system-prompt.txt');
      await writeFile(promptFile, 'You are a helpful assistant for testing.');

      const result = await runCLI(
        [
          'run',
          'recommendation',
          '--runtime',
          project.agentName,
          '--evaluator',
          'Builtin.Faithfulness',
          '--prompt-file',
          promptFile,
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('deployed');
    });

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

  describe('tool-description recommendation input validation', () => {
    it('fails when agent not deployed (tool-description type with --tools)', async () => {
      const result = await runCLI(
        [
          'run',
          'recommendation',
          '--type',
          'tool-description',
          '--runtime',
          project.agentName,
          '--tools',
          'search:Searches the web for information',
          '--tools',
          'calculator:Performs math calculations',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      expect(json.error).toContain('deployed');
    });
  });

  describe('config bundle source validation', () => {
    it('fails when bundle not found in deployed state', async () => {
      const result = await runCLI(
        [
          'run',
          'recommendation',
          '--runtime',
          project.agentName,
          '--evaluator',
          'Builtin.Faithfulness',
          '--bundle-name',
          'NonExistentBundle',
          '--bundle-version',
          'v1',
          '--system-prompt-json-path',
          'systemPrompt',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.success).toBe(false);
      // Fails at agent resolution (not deployed) before bundle resolution
      expect(json.error).toContain('deployed');
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

  describe('lookback and session options', () => {
    it('accepts --lookback flag (fails at deploy check, not parsing)', async () => {
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
          '--lookback',
          '14',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.error).toContain('deployed');
    });

    it('accepts --session-id flag (fails at deploy check, not parsing)', async () => {
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
          '--session-id',
          'sess-001',
          'sess-002',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = parseJsonOutput(result.stdout) as Record<string, unknown>;
      expect(json.error).toContain('deployed');
    });
  });
});
