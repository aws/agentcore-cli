import { hasCommand } from '../src/test-utils/index.js';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const hasPython = hasCommand('python3');

describe.skipIf(!hasPython)('import fixture cleanup', () => {
  it('deletes tracked resources in dependency order without losing failures', () => {
    const testPath = join(__dirname, '..', 'e2e-tests', 'fixtures', 'import', 'test_cleanup_resources.py');
    const result = spawnSync('python3', [testPath], { encoding: 'utf-8' });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
