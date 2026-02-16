import { writeEnvFile, writeGitignore } from '../files.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('writeGitignore', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-gitignore-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .gitignore with expected content', async () => {
    await writeGitignore(dir);

    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toContain('.env.local');
    expect(content).toContain('cdk/cdk.out/');
    expect(content).toContain('cdk/node_modules/');
    expect(content).toContain('.cli/*');
    expect(content).toContain('!.cli/deployed-state.json');
    expect(content).toContain('.cache/*');
  });
});

describe('writeEnvFile', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'init-envfile-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates empty .env.local file', async () => {
    await writeEnvFile(dir);

    const content = readFileSync(join(dir, '.env.local'), 'utf-8');
    expect(content).toBe('');
  });
});
