import { describe, it } from 'bun:test';
import assert from 'node:assert';
import { runCLI } from '../src/test-utils/index.js';

const COMMANDS = [
  'create',
  'deploy',
  'dev',
  'invoke',
  'destroy',
  'plan',
  'status',
  'validate',
  'add',
  'attach',
  'remove',
  'edit',
  'outline',
  'package',
  'update',
];

describe('CLI help', () => {
  describe('main help', () => {
    it('shows all commands', async () => {
      const result = await runCLI(['--help']);
      
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Usage:'), 'Should show usage');
      assert.ok(result.stdout.includes('Commands:'), 'Should list commands');
    });
  });

  describe('command help', () => {
    for (const cmd of COMMANDS) {
      it(`${cmd} --help exits 0`, async () => {
        const result = await runCLI([cmd, '--help']);
        
        assert.strictEqual(result.exitCode, 0, `${cmd} --help failed: ${result.stderr}`);
        assert.ok(result.stdout.includes('Usage:'), `${cmd} should show usage`);
      });
    }
  });
});
