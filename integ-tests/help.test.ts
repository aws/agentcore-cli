import { runCLI } from '../src/test-utils/index.js';
import { describe, expect, it } from 'vitest';

const COMMANDS = [
  'create',
  'deploy',
  'dev',
  'invoke',
  'status',
  'validate',
  'add',
  'attach',
  'remove',
  'edit',
  'package',
  'update',
];

describe('CLI help', () => {
  describe('main help', () => {
    it('shows all commands', async () => {
      const result = await runCLI(['--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('Usage:'), 'Should show usage').toBeTruthy();
      expect(result.stdout.includes('Commands:'), 'Should list commands').toBeTruthy();
    });
  });

  describe('command help', () => {
    for (const cmd of COMMANDS) {
      it(`${cmd} --help exits 0`, async () => {
        const result = await runCLI([cmd, '--help'], process.cwd());

        expect(result.exitCode, `${cmd} --help failed: ${result.stderr}`).toBe(0);
        expect(result.stdout.includes('Usage:'), `${cmd} should show usage`).toBeTruthy();
      });
    }
  });
});
