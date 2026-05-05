/**
 * Tests for importing custom JWT authorizer configuration from starter toolkit YAML.
 */
import { parseStarterToolkitYaml } from '../yaml-parser.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mocks ----

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockReadAWSDeploymentTargets = vi.fn();
const mockWriteAWSDeploymentTargets = vi.fn();
const mockReadDeployedState = vi.fn();
const mockWriteDeployedState = vi.fn();
const mockFindConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: class MockConfigIO {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    writeAWSDeploymentTargets = mockWriteAWSDeploymentTargets;
    readDeployedState = mockReadDeployedState;
    writeDeployedState = mockWriteDeployedState;
  },
  NoProjectError: class NoProjectError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'No agentcore project found');
      this.name = 'NoProjectError';
    }
  },
  ValidationError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ValidationError';
    }
  },
  findConfigRoot: (...args: unknown[]) => mockFindConfigRoot(...args),
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

vi.mock('../../../aws/account', () => ({
  validateAwsCredentials: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../cdk/local-cdk-project', () => ({
  LocalCdkProject: vi.fn(),
}));

vi.mock('../../../cdk/toolkit-lib', () => ({
  silentIoHost: {},
}));

vi.mock('../../../logging', () => ({
  ExecLogger: class MockExecLogger {
    startStep = vi.fn();
    endStep = vi.fn();
    log = vi.fn();
    finalize = vi.fn();
    getRelativeLogPath = vi.fn().mockReturnValue('agentcore/.cli/logs/import/import-mock.log');
    logFilePath = 'agentcore/.cli/logs/import/import-mock.log';
  },
}));

vi.mock('../../../operations/deploy', () => ({
  buildCdkProject: vi.fn(),
  synthesizeCdk: vi.fn(),
}));

vi.mock('../../../operations/python/setup', () => ({
  setupPythonProject: vi.fn().mockResolvedValue({ status: 'success' }),
}));

vi.mock('../phase1-update', () => ({
  executePhase1: vi.fn(),
  getDeployedTemplate: vi.fn(),
}));

vi.mock('../phase2-import', () => ({
  executePhase2: vi.fn(),
  publishCdkAssets: vi.fn(),
}));

// ============================================================================
// YAML Parsing: JWT authorizer extraction
// ============================================================================

describe('YAML parsing: JWT authorizer config', () => {
  it('extracts authorizerType and authorizerConfiguration from YAML with customJWTAuthorizer', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'jwt-authorizer.yaml');
    const parsed = parseStarterToolkitYaml(fixturePath);

    expect(parsed.agents).toHaveLength(1);
    const agent = parsed.agents[0]!;
    expect(agent.authorizerType).toBe('CUSTOM_JWT');
    expect(agent.authorizerConfiguration).toBeDefined();
    expect(agent.authorizerConfiguration!.customJwtAuthorizer).toBeDefined();

    const jwt = agent.authorizerConfiguration!.customJwtAuthorizer!;
    expect(jwt.discoveryUrl).toBe(
      'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_abc123/.well-known/openid-configuration'
    );
    expect(jwt.allowedClients).toEqual(['client-id-1', 'client-id-2']);
    expect(jwt.allowedAudience).toEqual(['aud-1']);
  });

  it('returns no authorizer fields when authorizer_configuration is null', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-test-'));
    try {
      const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    aws:
      account: '111122223333'
      region: us-east-1
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: null
      agent_arn: null
    memory:
      mode: NO_MEMORY
    authorizer_configuration: null
`;
      const filePath = path.join(tmpDir, '.bedrock_agentcore.yaml');
      fs.writeFileSync(filePath, yamlContent);

      const parsed = parseStarterToolkitYaml(filePath);
      const agent = parsed.agents[0]!;
      expect(agent.authorizerType).toBeUndefined();
      expect(agent.authorizerConfiguration).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns no authorizer fields when authorizer_configuration is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-test-'));
    try {
      const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    aws:
      account: '111122223333'
      region: us-east-1
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: null
      agent_arn: null
    memory:
      mode: NO_MEMORY
`;
      const filePath = path.join(tmpDir, '.bedrock_agentcore.yaml');
      fs.writeFileSync(filePath, yamlContent);

      const parsed = parseStarterToolkitYaml(filePath);
      const agent = parsed.agents[0]!;
      expect(agent.authorizerType).toBeUndefined();
      expect(agent.authorizerConfiguration).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles customJWTAuthorizer with all optional fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-test-'));
    try {
      const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    aws:
      account: '111122223333'
      region: us-east-1
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: null
      agent_arn: null
    memory:
      mode: NO_MEMORY
    authorizer_configuration:
      customJWTAuthorizer:
        discoveryUrl: "https://example.com/.well-known/openid-configuration"
        allowedClients:
          - client1
        allowedAudience:
          - aud1
          - aud2
        allowedScopes:
          - read
          - write
`;
      const filePath = path.join(tmpDir, '.bedrock_agentcore.yaml');
      fs.writeFileSync(filePath, yamlContent);

      const parsed = parseStarterToolkitYaml(filePath);
      const jwt = parsed.agents[0]!.authorizerConfiguration!.customJwtAuthorizer!;
      expect(jwt.discoveryUrl).toBe('https://example.com/.well-known/openid-configuration');
      expect(jwt.allowedClients).toEqual(['client1']);
      expect(jwt.allowedAudience).toEqual(['aud1', 'aud2']);
      expect(jwt.allowedScopes).toEqual(['read', 'write']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// handleImport: authorizer passthrough to agentcore.json
// ============================================================================

describe('handleImport: JWT authorizer passthrough', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-import-'));

    const projectDir = path.join(tmpDir, 'myproject');
    const configDir = path.join(projectDir, 'agentcore');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'agentcore.json'),
      JSON.stringify({ name: 'myproject', version: 1, runtimes: [], memories: [], credentials: [] })
    );
    mockFindConfigRoot.mockReturnValue(configDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes authorizerType and authorizerConfiguration in written spec', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-west-2' }]);

    const fixturePath = path.join(__dirname, 'fixtures', 'jwt-authorizer.yaml');
    const { handleImport } = await import('../actions.js');
    const result = await handleImport({ source: fixturePath });

    expect(result.success).toBe(true);
    expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);

    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    const agent = writtenSpec.runtimes[0];
    expect(agent.authorizerType).toBe('CUSTOM_JWT');
    expect(agent.authorizerConfiguration).toBeDefined();
    expect(agent.authorizerConfiguration.customJwtAuthorizer.discoveryUrl).toBe(
      'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_abc123/.well-known/openid-configuration'
    );
    expect(agent.authorizerConfiguration.customJwtAuthorizer.allowedClients).toEqual(['client-id-1', 'client-id-2']);
  });

  it('does not include authorizer fields when YAML has no authorizer config', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-west-2' }]);

    const fixturePath = path.join(__dirname, 'fixtures', 'two-agents.yaml');
    const { handleImport } = await import('../actions.js');
    await handleImport({ source: fixturePath });

    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    for (const agent of writtenSpec.runtimes) {
      expect(agent.authorizerType).toBeUndefined();
      expect(agent.authorizerConfiguration).toBeUndefined();
    }
  });

  it('does not emit authorizer warning for agents with JWT config', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-west-2' }]);

    const fixturePath = path.join(__dirname, 'fixtures', 'jwt-authorizer.yaml');
    const { handleImport } = await import('../actions.js');

    const progressMessages: string[] = [];
    await handleImport({
      source: fixturePath,
      onProgress: (msg: string) => progressMessages.push(msg),
    });

    const authWarning = progressMessages.find(m => m.includes('not automatically imported'));
    expect(authWarning).toBeUndefined();
  });
});
