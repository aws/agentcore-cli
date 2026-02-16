/* eslint-disable security/detect-non-literal-fs-filename */
import { ConfigNotFoundError, ConfigParseError, ConfigValidationError } from '../../../errors/config.js';
import { ConfigIO } from '../config-io.js';
import { NoProjectError } from '../path-resolver.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('ConfigIO extended', () => {
  let testDir: string;
  let originalCwd: string;
  let originalInitCwd: string | undefined;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-configio-ext-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    originalCwd = process.cwd();
    originalInitCwd = process.env.INIT_CWD;
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    if (originalInitCwd !== undefined) {
      process.env.INIT_CWD = originalInitCwd;
    } else {
      delete process.env.INIT_CWD;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  function changeWorkingDir(dir: string): void {
    process.chdir(dir);
    delete process.env.INIT_CWD;
  }

  describe('readProjectSpec error paths', () => {
    it('throws ConfigNotFoundError when agentcore.json does not exist', async () => {
      const projectDir = join(testDir, `missing-config-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });
      // Create a minimal file so findConfigRoot finds the directory
      writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();
      // Delete the file after ConfigIO discovers the root
      const fs = await import('node:fs/promises');
      await fs.unlink(join(agentcoreDir, 'agentcore.json'));

      await expect(configIO.readProjectSpec()).rejects.toThrow(ConfigNotFoundError);
    });

    it('throws ConfigParseError for invalid JSON', async () => {
      const projectDir = join(testDir, `bad-json-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });
      writeFileSync(join(agentcoreDir, 'agentcore.json'), '{not valid json!!!}');
      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();

      await expect(configIO.readProjectSpec()).rejects.toThrow(ConfigParseError);
    });

    it('throws ConfigValidationError for valid JSON that fails schema', async () => {
      const projectDir = join(testDir, `bad-schema-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });
      writeFileSync(join(agentcoreDir, 'agentcore.json'), JSON.stringify({ invalid: true }));
      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();

      await expect(configIO.readProjectSpec()).rejects.toThrow(ConfigValidationError);
    });
  });

  describe('writeProjectSpec error paths', () => {
    it('throws NoProjectError when no project discovered', async () => {
      const emptyDir = join(testDir, `empty-write-${randomUUID()}`);
      mkdirSync(emptyDir, { recursive: true });
      changeWorkingDir(emptyDir);

      const configIO = new ConfigIO();

      await expect(configIO.writeProjectSpec({} as any)).rejects.toThrow(NoProjectError);
    });

    it('throws ConfigValidationError for invalid project data', async () => {
      const projectDir = join(testDir, `invalid-write-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });

      const configIO = new ConfigIO({ baseDir: agentcoreDir });

      await expect(configIO.writeProjectSpec({ bad: 'data' } as any)).rejects.toThrow(ConfigValidationError);
    });
  });

  describe('configExists', () => {
    it('returns true when agentcore.json exists', () => {
      const projectDir = join(testDir, `exists-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });
      writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();

      expect(configIO.configExists('project')).toBe(true);
    });

    it('returns false when aws-targets.json does not exist', () => {
      const projectDir = join(testDir, `no-targets-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });
      writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();

      expect(configIO.configExists('awsTargets')).toBe(false);
      expect(configIO.configExists('state')).toBe(false);
      expect(configIO.configExists('mcp')).toBe(false);
      expect(configIO.configExists('mcpDefs')).toBe(false);
    });
  });

  describe('initializeBaseDir', () => {
    it('creates base and cli system directories', async () => {
      const projectDir = join(testDir, `init-base-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');

      const configIO = new ConfigIO({ baseDir: agentcoreDir });
      await configIO.initializeBaseDir();

      expect(existsSync(agentcoreDir)).toBe(true);
      expect(existsSync(join(agentcoreDir, '.cli'))).toBe(true);
    });

    it('throws NoProjectError when project not discovered', async () => {
      const emptyDir = join(testDir, `no-init-${randomUUID()}`);
      mkdirSync(emptyDir, { recursive: true });
      changeWorkingDir(emptyDir);

      const configIO = new ConfigIO();

      await expect(configIO.initializeBaseDir()).rejects.toThrow(NoProjectError);
    });
  });

  describe('baseDirExists', () => {
    it('returns true when base dir exists', () => {
      const projectDir = join(testDir, `basedir-exists-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });

      const configIO = new ConfigIO({ baseDir: agentcoreDir });

      expect(configIO.baseDirExists()).toBe(true);
    });

    it('returns false when base dir does not exist', () => {
      const configIO = new ConfigIO({ baseDir: join(testDir, 'nonexistent') });

      expect(configIO.baseDirExists()).toBe(false);
    });
  });
});
