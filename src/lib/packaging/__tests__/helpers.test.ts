/* eslint-disable security/detect-non-literal-fs-filename */
import {
  MAX_ZIP_SIZE_BYTES,
  convertWindowsScriptsToLinux,
  convertWindowsScriptsToLinuxSync,
  copySourceTree,
  copySourceTreeSync,
  createZipFromDir,
  createZipFromDirSync,
  enforceZipSizeLimit,
  enforceZipSizeLimitSync,
  ensureDirClean,
  ensureDirCleanSync,
  isNodeRuntime,
  isPythonRuntime,
  resolveCodeLocation,
  resolveProjectPaths,
  resolveProjectPathsSync,
} from '../helpers.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ── Pure function tests ──────────────────────────────────────────────

describe('isPythonRuntime', () => {
  it('returns true for PYTHON_3_12', () => {
    expect(isPythonRuntime('PYTHON_3_12')).toBe(true);
  });

  it('returns true for PYTHON_3_13', () => {
    expect(isPythonRuntime('PYTHON_3_13')).toBe(true);
  });

  it('returns false for NODE_20', () => {
    expect(isPythonRuntime('NODE_20')).toBe(false);
  });

  it('returns false for NODE_22', () => {
    expect(isPythonRuntime('NODE_22')).toBe(false);
  });
});

describe('isNodeRuntime', () => {
  it('returns true for NODE_20', () => {
    expect(isNodeRuntime('NODE_20')).toBe(true);
  });

  it('returns true for NODE_22', () => {
    expect(isNodeRuntime('NODE_22')).toBe(true);
  });

  it('returns false for PYTHON_3_12', () => {
    expect(isNodeRuntime('PYTHON_3_12')).toBe(false);
  });
});

describe('resolveCodeLocation', () => {
  it('returns absolute path unchanged', () => {
    expect(resolveCodeLocation('/absolute/path/to/code', '/home/user/proj/agentcore')).toBe('/absolute/path/to/code');
  });

  it('resolves relative path against repository root (parent of agentcore/)', () => {
    const result = resolveCodeLocation('./app/MyAgent', '/home/user/proj/agentcore');
    expect(result).toContain('/home/user/proj/app/MyAgent');
  });

  it('resolves relative path without leading ./', () => {
    const result = resolveCodeLocation('app/MyAgent', '/home/user/proj/agentcore');
    expect(result).toContain('/home/user/proj/app/MyAgent');
  });
});

describe('MAX_ZIP_SIZE_BYTES', () => {
  it('is 250 MB', () => {
    expect(MAX_ZIP_SIZE_BYTES).toBe(250 * 1024 * 1024);
  });
});

// ── Real filesystem tests ────────────────────────────────────────────

describe('ensureDirClean', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helpers-clean-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a fresh empty directory', async () => {
    const dir = join(root, 'fresh');
    await ensureDirClean(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('removes existing contents and recreates', async () => {
    const dir = join(root, 'dirty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.txt'), 'old');
    await ensureDirClean(dir);
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('sync version works the same', () => {
    const dir = join(root, 'sync-clean');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.txt'), 'old');
    ensureDirCleanSync(dir);
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('copySourceTree', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helpers-copy-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies files and subdirectories', async () => {
    const src = join(root, 'src');
    const dest = join(root, 'dest');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'main.py'), 'print("hello")');
    writeFileSync(join(src, 'sub', 'util.py'), 'pass');
    mkdirSync(dest, { recursive: true });

    await copySourceTree(src, dest);
    expect(readFileSync(join(dest, 'main.py'), 'utf-8')).toBe('print("hello")');
    expect(readFileSync(join(dest, 'sub', 'util.py'), 'utf-8')).toBe('pass');
  });

  it('excludes __pycache__, .git, node_modules, .venv', async () => {
    const src = join(root, 'src-excl');
    const dest = join(root, 'dest-excl');
    mkdirSync(src, { recursive: true });
    mkdirSync(join(src, '__pycache__'), { recursive: true });
    mkdirSync(join(src, '.git'), { recursive: true });
    mkdirSync(join(src, 'node_modules'), { recursive: true });
    mkdirSync(join(src, '.venv'), { recursive: true });
    writeFileSync(join(src, '__pycache__', 'cached.pyc'), 'cache');
    writeFileSync(join(src, '.git', 'HEAD'), 'ref');
    writeFileSync(join(src, 'keep.py'), 'keep');
    mkdirSync(dest, { recursive: true });

    await copySourceTree(src, dest);
    expect(existsSync(join(dest, 'keep.py'))).toBe(true);
    expect(existsSync(join(dest, '__pycache__'))).toBe(false);
    expect(existsSync(join(dest, '.git'))).toBe(false);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(dest, '.venv'))).toBe(false);
  });

  it('throws for non-existent source', async () => {
    await expect(copySourceTree(join(root, 'nope'), join(root, 'x'))).rejects.toThrow('not found');
  });

  it('sync version copies files', () => {
    const src = join(root, 'src-sync');
    const dest = join(root, 'dest-sync');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'a.py'), 'a');
    mkdirSync(dest, { recursive: true });

    copySourceTreeSync(src, dest);
    expect(readFileSync(join(dest, 'a.py'), 'utf-8')).toBe('a');
  });

  it('sync version throws for non-existent source', () => {
    expect(() => copySourceTreeSync(join(root, 'missing'), join(root, 'y'))).toThrow('not found');
  });
});

describe('createZipFromDir + enforceZipSizeLimit', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helpers-zip-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a valid zip file from a directory', async () => {
    const src = join(root, 'zipme');
    const zipPath = join(root, 'output.zip');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'file.txt'), 'hello');
    writeFileSync(join(src, 'sub', 'nested.txt'), 'nested');

    await createZipFromDir(src, zipPath);
    expect(existsSync(zipPath)).toBe(true);

    // Zip should be non-empty
    const size = await enforceZipSizeLimit(zipPath);
    expect(size).toBeGreaterThan(0);
  });

  it('sync version creates a valid zip file', () => {
    const src = join(root, 'zipme-sync');
    const zipPath = join(root, 'output-sync.zip');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'data.txt'), 'data');

    createZipFromDirSync(src, zipPath);
    expect(existsSync(zipPath)).toBe(true);

    const size = enforceZipSizeLimitSync(zipPath);
    expect(size).toBeGreaterThan(0);
  });

  it('excludes __pycache__ from zip', async () => {
    const src = join(root, 'zip-excl');
    const zipPath = join(root, 'excl.zip');
    mkdirSync(join(src, '__pycache__'), { recursive: true });
    writeFileSync(join(src, '__pycache__', 'cached.pyc'), 'x'.repeat(10000));
    writeFileSync(join(src, 'main.py'), 'print("hi")');

    await createZipFromDir(src, zipPath);

    // Create another zip with just main.py for size comparison
    const src2 = join(root, 'zip-just-main');
    mkdirSync(src2, { recursive: true });
    writeFileSync(join(src2, 'main.py'), 'print("hi")');
    const zipPath2 = join(root, 'just-main.zip');
    await createZipFromDir(src2, zipPath2);

    const sizeWithExcl = await enforceZipSizeLimit(zipPath);
    const sizeJustMain = await enforceZipSizeLimit(zipPath2);
    // Sizes should be identical since __pycache__ was excluded
    expect(sizeWithExcl).toBe(sizeJustMain);
  });
});

describe('resolveProjectPaths', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helpers-resolve-'));
    // Create a minimal project structure with pyproject.toml
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "test"');
    mkdirSync(join(root, 'src'), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves paths with explicit projectRoot', async () => {
    const paths = await resolveProjectPaths({ projectRoot: root });
    expect(paths.projectRoot).toBe(root);
    expect(paths.pyprojectPath).toBe(join(root, 'pyproject.toml'));
    expect(paths.srcDir).toBe(join(root, 'src'));
  });

  it('uses agent name for build directory', async () => {
    const paths = await resolveProjectPaths({ projectRoot: root }, 'MyAgent');
    expect(paths.buildDir).toContain('MyAgent');
    expect(paths.stagingDir).toContain('MyAgent');
  });

  it('defaults agent name to "default"', async () => {
    const paths = await resolveProjectPaths({ projectRoot: root });
    expect(paths.buildDir).toContain('default');
  });

  it('throws when pyproject.toml not found', async () => {
    // Use a completely separate tmpdir so findUp doesn't discover the parent's pyproject.toml
    const isolated = mkdtempSync(join(tmpdir(), 'helpers-no-pyproject-'));
    try {
      await expect(resolveProjectPaths({ projectRoot: isolated })).rejects.toThrow();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('sync version resolves paths', () => {
    const paths = resolveProjectPathsSync({ projectRoot: root }, 'SyncAgent');
    expect(paths.projectRoot).toBe(root);
    expect(paths.buildDir).toContain('SyncAgent');
  });
});

describe('convertWindowsScriptsToLinux (shebang rewriting on non-Windows)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helpers-shebang-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rewrites hardcoded macOS shebang to portable shebang', async () => {
    const staging = join(root, 'staging1');
    const binDir = join(staging, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'myscript'), '#!/Users/dev/.venv/bin/python3\nimport sys\nprint(sys.argv)');

    await convertWindowsScriptsToLinux(staging);
    const content = readFileSync(join(binDir, 'myscript'), 'utf-8');
    expect(content).toMatch(/^#!\/usr\/bin\/env python3/);
    expect(content).not.toContain('/Users/');
  });

  it('rewrites hardcoded Linux home path shebang', async () => {
    const staging = join(root, 'staging2');
    const binDir = join(staging, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'tool'), '#!/home/user/.local/bin/python3\nimport os');

    await convertWindowsScriptsToLinux(staging);
    const content = readFileSync(join(binDir, 'tool'), 'utf-8');
    expect(content).toMatch(/^#!\/usr\/bin\/env python3/);
  });

  it('leaves portable shebang unchanged', async () => {
    const staging = join(root, 'staging3');
    const binDir = join(staging, 'bin');
    mkdirSync(binDir, { recursive: true });
    const original = '#!/usr/bin/env python3\nimport sys';
    writeFileSync(join(binDir, 'good'), original);

    await convertWindowsScriptsToLinux(staging);
    const content = readFileSync(join(binDir, 'good'), 'utf-8');
    expect(content).toBe(original);
  });

  it('handles missing bin directory gracefully', async () => {
    const staging = join(root, 'no-bin');
    mkdirSync(staging, { recursive: true });
    // Should not throw
    await convertWindowsScriptsToLinux(staging);
  });

  it('sync version rewrites shebangs', () => {
    const staging = join(root, 'staging-sync');
    const binDir = join(staging, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'script'), '#!/Users/ci/.pyenv/versions/3.12/bin/python3\nimport sys');

    convertWindowsScriptsToLinuxSync(staging);
    const content = readFileSync(join(binDir, 'script'), 'utf-8');
    expect(content).toMatch(/^#!\/usr\/bin\/env python3/);
  });

  it('async version skips subdirectories in bin (only processes files)', async () => {
    const staging = join(root, 'staging-subdir-async');
    const binDir = join(staging, 'bin');
    mkdirSync(join(binDir, 'subdir'), { recursive: true });
    writeFileSync(join(binDir, 'myscript'), '#!/Users/dev/.venv/bin/python3\nimport os');

    await convertWindowsScriptsToLinux(staging);

    const content = readFileSync(join(binDir, 'myscript'), 'utf-8');
    expect(content).toMatch(/^#!\/usr\/bin\/env python3/);
    expect(existsSync(join(binDir, 'subdir'))).toBe(true);
  });

  it('sync version skips subdirectories in bin (only processes files)', () => {
    const staging = join(root, 'staging-subdir-sync');
    const binDir = join(staging, 'bin');
    mkdirSync(join(binDir, 'subdir'), { recursive: true });
    writeFileSync(join(binDir, 'myscript'), '#!/Users/dev/.venv/bin/python3\nimport os');

    convertWindowsScriptsToLinuxSync(staging);

    const content = readFileSync(join(binDir, 'myscript'), 'utf-8');
    expect(content).toMatch(/^#!\/usr\/bin\/env python3/);
    expect(existsSync(join(binDir, 'subdir'))).toBe(true);
  });

  it('sync version handles missing bin directory gracefully', () => {
    const staging = join(root, 'staging-no-bin-sync');
    mkdirSync(staging, { recursive: true });
    convertWindowsScriptsToLinuxSync(staging);
    expect(existsSync(join(staging, 'bin'))).toBe(false);
  });
});
