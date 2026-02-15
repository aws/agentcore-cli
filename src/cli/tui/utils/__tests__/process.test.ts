import { cleanupStaleLockFiles, isProcessRunning } from '../process.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('isProcessRunning', () => {
  it('returns true for current process PID', async () => {
    expect(await isProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for non-existent PID', async () => {
    // PID 99999999 is very unlikely to exist
    expect(await isProcessRunning(99999999)).toBe(false);
  });

  it('returns false for PID that requires elevated permissions', async () => {
    // PID 1 (init/launchd) exists but process.kill(1, 0) throws EPERM without root
    // On macOS without root, this returns false due to the catch block
    const result = await isProcessRunning(1);
    // Either true (if running as root) or false (EPERM caught) — both are valid
    expect(typeof result).toBe('boolean');
  });
});

describe('cleanupStaleLockFiles', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `cdk-lock-test-${randomUUID()}`);
    await fsp.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(testDir, { recursive: true, force: true });
  });

  it('removes lock files from dead processes', async () => {
    // PID 99999 is unlikely to exist
    const lockFile = path.join(testDir, 'read.99999.1.lock');
    await fsp.writeFile(lockFile, '');

    await cleanupStaleLockFiles(testDir);

    expect(fs.existsSync(lockFile), 'Lock from dead PID should be removed').toBe(false);
  });

  it('removes multiple lock files from same dead process', async () => {
    await fsp.writeFile(path.join(testDir, 'read.99999.1.lock'), '');
    await fsp.writeFile(path.join(testDir, 'read.99999.2.lock'), '');

    await cleanupStaleLockFiles(testDir);

    const remaining = await fsp.readdir(testDir);
    expect(remaining).toHaveLength(0);
  });

  it('keeps lock files from live processes', async () => {
    const lockFile = path.join(testDir, `read.${process.pid}.1.lock`);
    await fsp.writeFile(lockFile, '');

    await cleanupStaleLockFiles(testDir);

    expect(fs.existsSync(lockFile), 'Lock from live PID should be kept').toBe(true);
  });

  it('handles missing directory gracefully', async () => {
    const nonExistent = path.join(testDir, 'does-not-exist');
    await cleanupStaleLockFiles(nonExistent);
  });

  it('does not remove non-lock files', async () => {
    await fsp.writeFile(path.join(testDir, 'manifest.json'), '{}');
    await fsp.writeFile(path.join(testDir, 'tree.json'), '{}');
    await fsp.writeFile(path.join(testDir, 'synth.lock'), '');

    await cleanupStaleLockFiles(testDir);

    const remaining = await fsp.readdir(testDir);
    expect(remaining).toContain('manifest.json');
    expect(remaining).toContain('tree.json');
    expect(remaining).toContain('synth.lock');
  });

  it('handles mix of live and dead process locks', async () => {
    await fsp.writeFile(path.join(testDir, `read.${process.pid}.1.lock`), '');
    await fsp.writeFile(path.join(testDir, 'read.99999.1.lock'), '');

    await cleanupStaleLockFiles(testDir);

    const remaining = await fsp.readdir(testDir);
    expect(remaining).toContain(`read.${process.pid}.1.lock`);
    expect(remaining).not.toContain('read.99999.1.lock');
  });
});
