/**
 * Tests for handleImportRuntime — focused on entrypoint resolution,
 * input validation, and error handling.
 *
 * Covers:
 * - Fails with clear error when entrypoint is undetectable and no --entrypoint flag
 * - Uses --entrypoint flag when provided
 * - Fails when --code is not provided
 * - Fails when source path does not exist
 * - Fails when runtime name already exists in project
 */
import { handleImportRuntime } from '../import-runtime';
import assert from 'node:assert';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockResolveProjectContext = vi.fn();
const mockResolveImportTarget = vi.fn();
const mockResolveImportContext = vi.fn();
const mockUpdateDeployedState = vi.fn();
const mockCopyAgentSource = vi.fn();
const mockToStackName = vi.fn();

const mockParseAndValidateArn = vi.fn();
const mockFindResourceInDeployedState = vi.fn();
const mockFailResult = vi.fn((...args: unknown[]) => ({
  success: false,
  error: new Error(args[1] as string),
  resourceType: args[2] as string,
  resourceName: args[3] as string,
  logPath: 'test.log',
}));

vi.mock('../import-utils', () => ({
  resolveProjectContext: (...args: unknown[]) => mockResolveProjectContext(...args),
  resolveImportTarget: (...args: unknown[]) => mockResolveImportTarget(...args),
  resolveImportContext: (...args: unknown[]) => mockResolveImportContext(...args),
  updateDeployedState: (...args: unknown[]) => mockUpdateDeployedState(...args),
  copyAgentSource: (...args: unknown[]) => mockCopyAgentSource(...args),
  toStackName: (...args: unknown[]) => mockToStackName(...args),
  parseAndValidateArn: (...args: unknown[]) => mockParseAndValidateArn(...args),
  findResourceInDeployedState: (...args: unknown[]) => mockFindResourceInDeployedState(...args),
  failResult: (...args: unknown[]) => mockFailResult(...args),
}));

const mockExecuteCdkImportPipeline = vi.fn();

vi.mock('../import-pipeline', () => ({
  executeCdkImportPipeline: (...args: unknown[]) => mockExecuteCdkImportPipeline(...args),
}));

const mockGetAgentRuntimeDetail = vi.fn();
const mockListAllAgentRuntimes = vi.fn();

vi.mock('../../../aws/agentcore-control', () => ({
  getAgentRuntimeDetail: (...args: unknown[]) => mockGetAgentRuntimeDetail(...args),
  listAllAgentRuntimes: (...args: unknown[]) => mockListAllAgentRuntimes(...args),
}));

vi.mock('../../../logging', () => {
  const MockExecLogger = vi.fn(function (this: Record<string, unknown>) {
    this.startStep = vi.fn();
    this.endStep = vi.fn();
    this.log = vi.fn();
    this.finalize = vi.fn();
    this.getRelativeLogPath = vi.fn().mockReturnValue('test.log');
  });
  return { ExecLogger: MockExecLogger };
});

vi.mock('../../../cdk/local-cdk-project', () => ({
  LocalCdkProject: vi.fn(),
}));

vi.mock('../../../cdk/toolkit-lib', () => ({
  silentIoHost: {},
}));

vi.mock('../../../operations/deploy', () => ({
  buildCdkProject: vi.fn(),
  synthesizeCdk: vi.fn(),
  checkBootstrapNeeded: vi.fn(),
  bootstrapEnvironment: vi.fn(),
}));

vi.mock('../phase1-update', () => ({
  executePhase1: vi.fn(),
  getDeployedTemplate: vi.fn(),
}));

vi.mock('../phase2-import', () => ({
  executePhase2: vi.fn(),
  publishCdkAssets: vi.fn(),
}));

vi.mock('../template-utils', () => ({
  findLogicalIdByProperty: vi.fn(),
  findLogicalIdsByType: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue('{}'),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const defaultProjectSpec = {
  name: 'testproj',
  version: 1,
  runtimes: [],
  memories: [],
  evaluators: [],
  onlineEvalConfigs: [],
};

const mockConfigIO = {
  readProjectSpec: vi.fn().mockResolvedValue(defaultProjectSpec),
  writeProjectSpec: vi.fn().mockResolvedValue(undefined),
  readDeployedState: vi.fn().mockResolvedValue({ targets: {} }),
  writeDeployedState: vi.fn().mockResolvedValue(undefined),
};

const mockLogger = {
  startStep: vi.fn(),
  endStep: vi.fn(),
  log: vi.fn(),
  finalize: vi.fn(),
  getRelativeLogPath: vi.fn().mockReturnValue('test.log'),
};

function setupDefaultMocks() {
  mockResolveProjectContext.mockResolvedValue({
    configIO: mockConfigIO,
    projectRoot: '/tmp/testproj',
    projectName: 'testproj',
  });

  mockResolveImportTarget.mockResolvedValue({
    name: 'default',
    region: 'us-east-1',
    account: '123456789012',
  });

  mockResolveImportContext.mockResolvedValue({
    ctx: {
      configIO: mockConfigIO,
      projectRoot: '/tmp/testproj',
      projectName: 'testproj',
    },
    target: {
      name: 'default',
      region: 'us-east-1',
      account: '123456789012',
    },
    logger: mockLogger,
    onProgress: vi.fn(),
  });

  mockParseAndValidateArn.mockReturnValue({
    region: 'us-east-1',
    account: '123',
    resourceType: 'runtime',
    resourceId: 'rt-123',
  });

  mockFindResourceInDeployedState.mockResolvedValue(undefined);

  mockConfigIO.readProjectSpec.mockResolvedValue({ ...defaultProjectSpec, runtimes: [] });

  mockExecuteCdkImportPipeline.mockResolvedValue({ success: true });
}

afterEach(() => vi.clearAllMocks());

// ── Tests ────────────────────────────────────────────────────────────────────

describe('handleImportRuntime', () => {
  describe('entrypoint resolution', () => {
    it('fails with clear error when entrypoint is undetectable and no --entrypoint flag', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        // entryPoint only has non-file wrappers — no .py/.ts/.js
        entryPoint: ['opentelemetry-instrument'],
      });

      const result = await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('Could not determine entrypoint');
      expect(result.error.message).toContain('--entrypoint');
    });

    it('fails with clear error when entryPoint is undefined', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: undefined,
      });

      const result = await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('Could not determine entrypoint');
    });

    it('fails with clear error when entryPoint is empty array', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: [],
      });

      const result = await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('Could not determine entrypoint');
    });

    it('uses --entrypoint flag when provided, bypassing auto-detection', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        // No detectable entrypoint from API
        entryPoint: ['some-wrapper'],
      });

      // Mock will fail at CDK step, but we can verify entrypoint was accepted
      // by checking that copyAgentSource was called with the provided entrypoint
      mockCopyAgentSource.mockRejectedValue(new Error('stop here'));

      await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
        entrypoint: 'custom_app.py',
      });

      // It should have gotten past entrypoint resolution and attempted source copy
      expect(mockCopyAgentSource).toHaveBeenCalledWith(
        expect.objectContaining({
          entrypoint: 'custom_app.py',
        })
      );
    });

    it('auto-detects .py entrypoint from otel wrapper array', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['opentelemetry-instrument', 'main.py'],
      });

      mockCopyAgentSource.mockRejectedValue(new Error('stop here'));

      await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(mockCopyAgentSource).toHaveBeenCalledWith(
        expect.objectContaining({
          entrypoint: 'main.py',
        })
      );
    });
  });

  describe('single-result auto-select', () => {
    it('auto-selects when exactly 1 runtime is returned from listing', async () => {
      setupDefaultMocks();
      mockListAllAgentRuntimes.mockResolvedValue([
        { agentRuntimeId: 'rt-solo', agentRuntimeArn: 'arn-solo', agentRuntimeName: 'solo-runtime', status: 'READY' },
      ]);
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-solo',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-solo',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['main.py'],
      });

      // Will proceed past listing and fail at copy step — confirms auto-select worked
      mockCopyAgentSource.mockRejectedValue(new Error('stop here'));

      await handleImportRuntime({
        code: '/tmp/test-source',
        name: 'myagent',
        // no --arn, so listing path is used
      });

      expect(mockGetAgentRuntimeDetail).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: 'rt-solo' }));
    });

    it('errors with "Multiple runtimes found" when more than 1 runtime exists', async () => {
      setupDefaultMocks();
      mockListAllAgentRuntimes.mockResolvedValue([
        { agentRuntimeId: 'rt-1', agentRuntimeArn: 'arn-1', agentRuntimeName: 'r1', status: 'READY' },
        { agentRuntimeId: 'rt-2', agentRuntimeArn: 'arn-2', agentRuntimeName: 'r2', status: 'READY' },
      ]);

      const result = await handleImportRuntime({
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('Multiple runtimes found');
    });

    it('errors when no runtimes exist', async () => {
      setupDefaultMocks();
      mockListAllAgentRuntimes.mockResolvedValue([]);

      const result = await handleImportRuntime({
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('No runtimes found');
    });
  });

  describe('toAgentEnvSpec field mapping', () => {
    it('maps environmentVariables to envVars array', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['main.py'],
        environmentVariables: { API_KEY: 'secret', DB_HOST: 'localhost' },
      });

      mockCopyAgentSource.mockResolvedValue(undefined);

      // Capture the first write to project spec (before any rollback)
      let writtenSpec: Record<string, unknown> | undefined;
      mockConfigIO.writeProjectSpec.mockImplementation((spec: Record<string, unknown>) => {
        if (!writtenSpec) writtenSpec = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
        return Promise.resolve();
      });

      // Will fail at CDK step, but we can inspect what was written
      await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      const runtimes = (writtenSpec as { runtimes: { envVars?: { name: string; value: string }[] }[] })?.runtimes;
      expect(runtimes).toBeDefined();
      const addedRuntime = runtimes?.[0];
      expect(addedRuntime?.envVars).toEqual([
        { name: 'API_KEY', value: 'secret' },
        { name: 'DB_HOST', value: 'localhost' },
      ]);
    });

    it('maps tags, lifecycleConfiguration, and requestHeaderAllowlist', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['main.py'],
        tags: { env: 'prod', team: 'platform' },
        lifecycleConfiguration: { idleRuntimeSessionTimeout: 600, maxLifetime: 3600 },
        requestHeaderAllowlist: ['X-Custom-Header', 'Authorization'],
      });

      mockCopyAgentSource.mockResolvedValue(undefined);

      let writtenSpec: Record<string, unknown> | undefined;
      mockConfigIO.writeProjectSpec.mockImplementation((spec: Record<string, unknown>) => {
        if (!writtenSpec) writtenSpec = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
        return Promise.resolve();
      });

      await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      const runtimes = (
        writtenSpec as {
          runtimes: {
            tags?: Record<string, string>;
            lifecycleConfiguration?: { idleRuntimeSessionTimeout?: number; maxLifetime?: number };
            requestHeaderAllowlist?: string[];
          }[];
        }
      )?.runtimes;
      const addedRuntime = runtimes?.[0];
      expect(addedRuntime?.tags).toEqual({ env: 'prod', team: 'platform' });
      expect(addedRuntime?.lifecycleConfiguration).toEqual({ idleRuntimeSessionTimeout: 600, maxLifetime: 3600 });
      expect(addedRuntime?.requestHeaderAllowlist).toEqual(['X-Custom-Header', 'Authorization']);
    });

    it('omits new fields when they are undefined', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['main.py'],
        // No environmentVariables, tags, lifecycleConfiguration, requestHeaderAllowlist
      });

      mockCopyAgentSource.mockResolvedValue(undefined);

      let writtenSpec: Record<string, unknown> | undefined;
      mockConfigIO.writeProjectSpec.mockImplementation((spec: Record<string, unknown>) => {
        if (!writtenSpec) writtenSpec = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
        return Promise.resolve();
      });

      await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      const runtimes = (
        writtenSpec as {
          runtimes: {
            envVars?: unknown;
            tags?: unknown;
            lifecycleConfiguration?: unknown;
            requestHeaderAllowlist?: unknown;
          }[];
        }
      )?.runtimes;
      const addedRuntime = runtimes?.[0];
      expect(addedRuntime?.envVars).toBeUndefined();
      expect(addedRuntime?.tags).toBeUndefined();
      expect(addedRuntime?.lifecycleConfiguration).toBeUndefined();
      expect(addedRuntime?.requestHeaderAllowlist).toBeUndefined();
    });
  });

  describe('input validation', () => {
    it('fails when --code is not provided', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['main.py'],
      });

      const result = await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        name: 'myagent',
        // no code option
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('--code');
    });

    it('fails when source path does not exist', async () => {
      setupDefaultMocks();
      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['main.py'],
      });

      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/nonexistent/path',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('does not exist');
    });

    it('fails when runtime name already exists in project', async () => {
      setupDefaultMocks();
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockConfigIO.readProjectSpec.mockResolvedValue({
        ...defaultProjectSpec,
        runtimes: [{ name: 'myagent' }],
      });

      mockGetAgentRuntimeDetail.mockResolvedValue({
        agentRuntimeId: 'rt-123',
        agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        agentRuntimeName: 'testproj_myagent',
        status: 'READY',
        roleArn: 'arn:aws:iam::123:role/test-role',
        networkMode: 'PUBLIC',
        protocol: 'HTTP',
        build: 'CodeZip',
        runtimeVersion: 'PYTHON_3_12',
        entryPoint: ['main.py'],
      });

      const result = await handleImportRuntime({
        arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      assert(!result.success);
      expect(result.error.message).toContain('already exists');
    });
  });
});
