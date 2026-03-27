import { runCLI } from '../../../../test-utils/index.js';
import { describe, expect, it } from 'vitest';

describe('dev command', () => {
  describe('--help', () => {
    it('shows all options', async () => {
      const result = await runCLI(['dev', '--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('[prompt]'), 'Should show [prompt] positional argument').toBeTruthy();
      expect(result.stdout.includes('--port'), 'Should show --port option').toBeTruthy();
      expect(result.stdout.includes('--runtime'), 'Should show --runtime option').toBeTruthy();
      expect(result.stdout.includes('--stream'), 'Should show --stream option').toBeTruthy();
      expect(result.stdout.includes('--logs'), 'Should show --logs option').toBeTruthy();
      expect(result.stdout.includes('8080'), 'Should show default port').toBeTruthy();
    });

    it('does not show --invoke flag', async () => {
      const result = await runCLI(['dev', '--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('--invoke'), 'Should not show removed --invoke option').toBeFalsy();
    });
  });

  describe('requires project context', () => {
    it('exits with error when run outside project', async () => {
      const result = await runCLI(['dev'], process.cwd());

      expect(result.exitCode).toBe(1);
      expect(
        result.stdout.toLowerCase().includes('project') || result.stderr.toLowerCase().includes('project'),
        `Should mention project requirement, got: ${result.stdout}`
      ).toBeTruthy();
    });
  });

  describe('positional prompt invoke', () => {
    it('exits with helpful error when no server running and no project found', async () => {
      // With no dev server running, invoke path shows connection error
      const result = await runCLI(['dev', 'Hello agent'], process.cwd());

      expect(result.exitCode).toBe(1);
      const output = result.stderr.toLowerCase();
      expect(
        output.includes('dev server not running'),
        `Should mention dev server not running, got: ${result.stderr}`
      ).toBeTruthy();
    });

    it('does not go through requireProject guard when invoking', async () => {
      // Invoke path uses loadProjectConfig (soft check), not requireProject()
      // The error should mention the dev server, not the generic project guard message
      const result = await runCLI(['dev', 'test prompt'], process.cwd());

      expect(result.exitCode).toBe(1);
      const output = result.stderr.toLowerCase();
      expect(
        !output.includes('run agentcore create'),
        `Should not show the requireProject guard message, got: ${result.stderr}`
      ).toBeTruthy();
    });
  });

  describe('flag validation', () => {
    it('rejects invalid port number', async () => {
      const result = await runCLI(['dev', '--port', 'abc'], process.cwd());

      expect(result.exitCode).toBe(1);
    });

    it('rejects negative port number', async () => {
      const result = await runCLI(['dev', '--port', '-1'], process.cwd());

      expect(result.exitCode).toBe(1);
    });

    it('stream flag is documented in help', async () => {
      const result = await runCLI(['dev', '--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('--stream'), 'Should show --stream option').toBeTruthy();
    });
  });
});
