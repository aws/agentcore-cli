/* eslint-disable security/detect-non-literal-fs-filename */
import { ConfigNotFoundError, ConfigParseError, ConfigValidationError } from '../../../errors/config.js';
import { ConfigIO } from '../config-io.js';
import { NoProjectError } from '../path-resolver.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('ConfigIO', () => {
  let testDir: string;
  let originalCwd: string;
  let originalInitCwd: string | undefined;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-configio-test-${randomUUID()}`);
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

  // Helper to change working directory for tests
  // Clears INIT_CWD since npm sets it and it takes precedence over cwd
  function changeWorkingDir(dir: string): void {
    process.chdir(dir);
    delete process.env.INIT_CWD;
  }

  describe('hasProject()', () => {
    it('returns false when no project exists and no baseDir provided', async () => {
      const emptyDir = join(testDir, `empty-${randomUUID()}`);
      await mkdir(emptyDir, { recursive: true });
      changeWorkingDir(emptyDir);

      const configIO = new ConfigIO();
      expect(configIO.hasProject()).toBe(false);
    });

    it('returns true when baseDir is explicitly provided', () => {
      const explicitDir = join(testDir, `explicit-${randomUUID()}`, 'agentcore');
      const configIO = new ConfigIO({ baseDir: explicitDir });
      expect(configIO.hasProject()).toBe(true);
    });

    it('returns true when project is discovered', async () => {
      const projectDir = join(testDir, `project-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      await mkdir(agentcoreDir, { recursive: true });
      await writeFile(join(agentcoreDir, 'agentcore.json'), JSON.stringify({ version: '1.0', agents: [] }));

      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();
      expect(configIO.hasProject()).toBe(true);
    });
  });

  describe('NoProjectError prevention (issue #94)', () => {
    let emptyDir: string;

    beforeEach(async () => {
      emptyDir = join(testDir, `empty-${randomUUID()}`);
      await mkdir(emptyDir, { recursive: true });
      changeWorkingDir(emptyDir);
    });

    it('initializeBaseDir() throws NoProjectError when no project exists', async () => {
      const configIO = new ConfigIO();
      await expect(configIO.initializeBaseDir()).rejects.toThrow(NoProjectError);
      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });

    it('writeProjectSpec() throws NoProjectError when no project exists', async () => {
      const configIO = new ConfigIO();
      await expect(configIO.writeProjectSpec({ version: '1.0', agents: [] } as never)).rejects.toThrow(NoProjectError);
      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });

    it('writeMcpSpec() throws NoProjectError when no project exists', async () => {
      const configIO = new ConfigIO();
      await expect(configIO.writeMcpSpec({ agentCoreGateways: [] })).rejects.toThrow(NoProjectError);
      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });

    it('does not create agentcore directory on any write operation', async () => {
      const configIO = new ConfigIO();
      const operations = [
        () => configIO.initializeBaseDir(),
        () => configIO.writeProjectSpec({ version: '1.0', agents: [] } as never),
        () => configIO.writeMcpSpec({ agentCoreGateways: [] }),
        () => configIO.writeMcpDefs({ tools: {} }),
      ];

      for (const op of operations) {
        try {
          await op();
        } catch {
          // Expected to throw NoProjectError
        }
      }

      expect(existsSync(join(emptyDir, 'agentcore'))).toBe(false);
    });
  });

  describe('initializeBaseDir', () => {
    it('creates base and cli system directories when baseDir is provided', async () => {
      const projectDir = join(testDir, `new-project-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');

      const configIO = new ConfigIO({ baseDir: agentcoreDir });
      await configIO.initializeBaseDir();

      expect(existsSync(agentcoreDir)).toBe(true);
      expect(existsSync(join(agentcoreDir, '.cli'))).toBe(true);
    });
  });

  describe('readProjectSpec error paths', () => {
    it('throws ConfigNotFoundError when agentcore.json does not exist', async () => {
      const projectDir = join(testDir, `missing-config-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });
      writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
      changeWorkingDir(projectDir);

      const configIO = new ConfigIO();
      // Delete the file after ConfigIO discovers the root
      await unlink(join(agentcoreDir, 'agentcore.json'));

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

  describe('writeProjectSpec', () => {
    it('throws ConfigValidationError for invalid project data', async () => {
      const projectDir = join(testDir, `invalid-write-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });

      const configIO = new ConfigIO({ baseDir: agentcoreDir });
      await expect(configIO.writeProjectSpec({ bad: 'data' } as any)).rejects.toThrow(ConfigValidationError);
    });

    it('writes and round-trips a valid project spec', async () => {
      const projectDir = join(testDir, `write-valid-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });

      const configIO = new ConfigIO({ baseDir: agentcoreDir });

      // Use 'as any' to avoid branded type issues with FilePath/DirectoryPath
      const validSpec = {
        name: 'TestProject',
        version: 1,
        agents: [
          {
            type: 'AgentCoreRuntime',
            name: 'myagent',
            build: 'CodeZip',
            entrypoint: 'main.py',
            codeLocation: './app',
            runtimeVersion: 'PYTHON_3_13',
          },
        ],
      } as any;

      await configIO.writeProjectSpec(validSpec);
      expect(existsSync(join(agentcoreDir, 'agentcore.json'))).toBe(true);

      const readBack = await configIO.readProjectSpec();
      expect(readBack.version).toBe(1);
      expect(readBack.agents).toHaveLength(1);
      expect(readBack.agents[0]!.name).toBe('myagent');
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

    it('returns false for config types that do not exist', () => {
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

  describe('getPathResolver, getProjectRoot, getConfigRoot', () => {
    it('returns the path resolver, project root, and config root', () => {
      const projectDir = join(testDir, `paths-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });

      const configIO = new ConfigIO({ baseDir: agentcoreDir });
      expect(configIO.getPathResolver()).toBeDefined();
      expect(configIO.getProjectRoot()).toBe(projectDir);
      expect(configIO.getConfigRoot()).toBe(agentcoreDir);
    });
  });

  describe('setBaseDir', () => {
    it('updates the base directory', () => {
      const configIO = new ConfigIO({ baseDir: '/original' });
      expect(configIO.getConfigRoot()).toBe('/original');

      configIO.setBaseDir('/updated');
      expect(configIO.getConfigRoot()).toBe('/updated');
    });
  });

  describe('writeMcpSpec and readMcpSpec', () => {
    it('round-trips a valid MCP spec', async () => {
      const projectDir = join(testDir, `mcp-rt-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });

      const configIO = new ConfigIO({ baseDir: agentcoreDir });

      const mcpSpec = { agentCoreGateways: [] };
      await configIO.writeMcpSpec(mcpSpec);
      expect(configIO.configExists('mcp')).toBe(true);

      const readBack = await configIO.readMcpSpec();
      expect(readBack.agentCoreGateways).toEqual([]);
    });
  });

  describe('writeMcpDefs and readMcpDefs', () => {
    it('round-trips valid MCP definitions', async () => {
      const projectDir = join(testDir, `mcpdefs-rt-${randomUUID()}`);
      const agentcoreDir = join(projectDir, 'agentcore');
      mkdirSync(agentcoreDir, { recursive: true });

      const configIO = new ConfigIO({ baseDir: agentcoreDir });

      const mcpDefs = { tools: {} };
      await configIO.writeMcpDefs(mcpDefs);
      expect(configIO.configExists('mcpDefs')).toBe(true);

      const readBack = await configIO.readMcpDefs();
      expect(readBack.tools).toEqual({});
    });
  });
});
