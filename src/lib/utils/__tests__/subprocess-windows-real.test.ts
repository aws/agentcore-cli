import { runSubprocessCapture, spawnSync } from '../subprocess.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;

windowsDescribe('Windows command and argument handling', () => {
  let rootDir: string;
  let binDir: string;
  let markerPath: string;
  let env: NodeJS.ProcessEnv;

  const args = [
    'plain',
    'with spaces',
    'ampersand & value',
    'pipe | value',
    'redirect > value',
    'caret ^ value',
    'percent %PATH% value',
    'bang !PATH! value',
    '(parentheses)',
    '"quoted"',
  ];

  beforeAll(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'agentcore-spawn-'));
    binDir = join(rootDir, 'bin & %CD% ! ^ (meta)');
    markerPath = join(rootDir, 'unexpected-command.txt');
    mkdirSync(binDir);

    const scriptPath = join(rootDir, 'print-args.cjs');
    writeFileSync(scriptPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');

    const commandPath = join(binDir, 'print-args.cmd');
    const nodePathForBatch = process.execPath.replaceAll('%', '%%');
    const scriptPathForBatch = scriptPath.replaceAll('%', '%%');
    writeFileSync(commandPath, `@echo off\r\n"${nodePathForBatch}" "${scriptPathForBatch}" %*\r\n`);

    env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !['PATH', 'PATHEXT'].includes(key.toUpperCase()))
    );
    env.Path = `${binDir};${dirname(process.execPath)}`;
    env.PATHEXT = '.CMD;.EXE;.BAT;.COM';
  });

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('preserves metacharacters through the asynchronous wrapper', async () => {
    const commandArgs = [...args, `& echo unexpected > "${markerPath}"`];
    const result = await runSubprocessCapture('print-args', commandArgs, { env });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(commandArgs);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('preserves metacharacters through the synchronous wrapper', () => {
    const commandArgs = [...args, `& echo unexpected > "${markerPath}"`];
    const result = spawnSync('print-args', commandArgs, { env, encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(commandArgs);
    expect(existsSync(markerPath)).toBe(false);
  });
});
