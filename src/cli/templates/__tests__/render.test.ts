import { copyAndRenderDir, copyDir } from '../render.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('copyDir', () => {
  let srcDir: string;
  let destDir: string;

  beforeAll(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'copy-src-'));
    destDir = join(mkdtempSync(join(tmpdir(), 'copy-dest-')), 'output');

    // Create source files
    writeFileSync(join(srcDir, 'file1.txt'), 'hello');
    writeFileSync(join(srcDir, 'file2.ts'), 'const x = 1;');

    // Create subdirectory
    mkdirSync(join(srcDir, 'sub'));
    writeFileSync(join(srcDir, 'sub', 'nested.txt'), 'nested content');

    // Template file that should be renamed
    writeFileSync(join(srcDir, 'gitignore.template'), 'node_modules/');
  });

  afterAll(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(join(destDir, '..'), { recursive: true, force: true });
  });

  it('copies files to destination', async () => {
    await copyDir(srcDir, destDir);

    expect(readFileSync(join(destDir, 'file1.txt'), 'utf-8')).toBe('hello');
    expect(readFileSync(join(destDir, 'file2.ts'), 'utf-8')).toBe('const x = 1;');
  });

  it('copies nested directories', () => {
    expect(readFileSync(join(destDir, 'sub', 'nested.txt'), 'utf-8')).toBe('nested content');
  });

  it('renames gitignore.template to .gitignore', () => {
    expect(readFileSync(join(destDir, '.gitignore'), 'utf-8')).toBe('node_modules/');
  });
});

describe('copyAndRenderDir', () => {
  let srcDir: string;
  let destDir: string;

  beforeAll(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'render-src-'));
    destDir = join(mkdtempSync(join(tmpdir(), 'render-dest-')), 'output');

    // Create Handlebars templates
    writeFileSync(join(srcDir, 'readme.md'), 'Project: {{projectName}}');
    writeFileSync(join(srcDir, 'config.json'), '{"name": "{{projectName}}", "version": "{{version}}"}');

    // Subdirectory with template
    mkdirSync(join(srcDir, 'src'));
    writeFileSync(join(srcDir, 'src', 'index.ts'), 'export const name = "{{projectName}}";');

    // Template file rename
    writeFileSync(join(srcDir, 'npmignore.template'), 'dist/');
  });

  afterAll(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(join(destDir, '..'), { recursive: true, force: true });
  });

  it('renders Handlebars templates with data', async () => {
    await copyAndRenderDir(srcDir, destDir, { projectName: 'MyApp', version: 2 });

    expect(readFileSync(join(destDir, 'readme.md'), 'utf-8')).toBe('Project: MyApp');
    expect(readFileSync(join(destDir, 'config.json'), 'utf-8')).toBe('{"name": "MyApp", "version": "2"}');
  });

  it('renders templates in subdirectories', () => {
    expect(readFileSync(join(destDir, 'src', 'index.ts'), 'utf-8')).toBe('export const name = "MyApp";');
  });

  it('renames npmignore.template to .npmignore', () => {
    expect(readFileSync(join(destDir, '.npmignore'), 'utf-8')).toBe('dist/');
  });
});
