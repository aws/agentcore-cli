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
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockResolveProjectContext = vi.fn();
const mockResolveImportTarget = vi.fn();
const mockUpdateDeployedState = vi.fn();
const mockCopyAgentSource = vi.fn();
const mockToStackName = vi.fn();

vi.mock('../import-utils', () => ({
  resolveProjectContext: (...args: unknown[]) => mockResolveProjectContext(...args),
  resolveImportTarget: (...args: unknown[]) => mockResolveImportTarget(...args),
  updateDeployedState: (...args: unknown[]) => mockUpdateDeployedState(...args),
  copyAgentSource: (...args: unknown[]) => mockCopyAgentSource(...args),
  toStackName: (...args: unknown[]) => mockToStackName(...args),
}));

const mockGetAgentRuntimeDetail = vi.fn();
const mockListAgentRuntimes = vi.fn();

vi.mock('../../../aws/agentcore-control', () => ({
  getAgentRuntimeDetail: (...args: unknown[]) => mockGetAgentRuntimeDetail(...args),
  listAgentRuntimes: (...args: unknown[]) => mockListAgentRuntimes(...args),
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

  mockConfigIO.readProjectSpec.mockResolvedValue({ ...defaultProjectSpec, runtimes: [] });
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
        id: 'rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not determine entrypoint');
      expect(result.error).toContain('--entrypoint');
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
        id: 'rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not determine entrypoint');
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
        id: 'rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not determine entrypoint');
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
        id: 'rt-123',
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
        id: 'rt-123',
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
        id: 'rt-123',
        name: 'myagent',
        // no code option
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('--code');
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
        id: 'rt-123',
        code: '/nonexistent/path',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
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
        id: 'rt-123',
        code: '/tmp/test-source',
        name: 'myagent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });
});
