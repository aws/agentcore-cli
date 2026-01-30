import { cleanupStaleLockFiles } from '../process.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('cleanupStaleLockFiles', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `cdk-lock-test-${randomUUID()}`);
    await fsp.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(testDir, { recursive: true, force: true });
  });

  it('removes lock files older than 5 minutes', async () => {
    const lockFile = path.join(testDir, 'read.99999.1.lock');
    await fsp.writeFile(lockFile, '');
    // Set mtime to 10 minutes ago
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    await fsp.utimes(lockFile, oldTime, oldTime);

    await cleanupStaleLockFiles(testDir);

    expect(fs.existsSync(lockFile), 'Old lock file should be removed').toBe(false);
  });

  it('removes young lock files from dead processes', async () => {
    // PID 99999 is unlikely to exist
    const lockFile = path.join(testDir, 'read.99999.1.lock');
    await fsp.writeFile(lockFile, '');

    await cleanupStaleLockFiles(testDir);

    expect(fs.existsSync(lockFile), 'Lock from dead PID should be removed').toBe(false);
  });

  it('keeps young lock files from live processes', async () => {
    const lockFile = path.join(testDir, `read.${process.pid}.1.lock`);
    await fsp.writeFile(lockFile, '');

    await cleanupStaleLockFiles(testDir);

    expect(fs.existsSync(lockFile), 'Lock from live PID should be kept').toBe(true);
  });

  // Note: synth.lock is intentionally NOT removed by cleanupStaleLockFiles
  // to avoid corrupting concurrent CDK runs (see process.ts comment)

  it('handles missing directory gracefully', async () => {
    const nonExistent = path.join(testDir, 'does-not-exist');

    // Should not throw
    await cleanupStaleLockFiles(nonExistent);
  });

  it('does not remove non-lock files', async () => {
    const manifestFile = path.join(testDir, 'manifest.json');
    const treeFile = path.join(testDir, 'tree.json');
    await fsp.writeFile(manifestFile, '{}');
    await fsp.writeFile(treeFile, '{}');

    await cleanupStaleLockFiles(testDir);

    expect(fs.existsSync(manifestFile), 'manifest.json should not be removed').toBe(true);
    expect(fs.existsSync(treeFile), 'tree.json should not be removed').toBe(true);
  });
});
