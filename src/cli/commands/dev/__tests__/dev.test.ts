import { runCLI } from '../../../../test-utils/index.js';
import { describe, expect, it } from 'vitest';

describe('dev command', () => {
  describe('--help', () => {
    it('shows all options', async () => {
      const result = await runCLI(['dev', '--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('--port'), 'Should show --port option').toBeTruthy();
      expect(result.stdout.includes('--agent'), 'Should show --agent option').toBeTruthy();
      expect(result.stdout.includes('--invoke'), 'Should show --invoke option').toBeTruthy();
      expect(result.stdout.includes('--stream'), 'Should show --stream option').toBeTruthy();
      expect(result.stdout.includes('--logs'), 'Should show --logs option').toBeTruthy();
      expect(result.stdout.includes('8080'), 'Should show default port').toBeTruthy();
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
      expect(result.stdout.includes('--invoke'), 'Should show --invoke option').toBeTruthy();
    });
  });
});
