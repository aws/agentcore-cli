/**
 * Test Group 8: Import Without Prior Deploy (No Physical IDs)
 *
 * Verifies that the import command correctly handles starter toolkit projects
 * that were created but never deployed (no agent_id/memory_id in YAML).
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
  findConfigRoot: (...args: unknown[]) => mockFindConfigRoot(...args),
}));

const mockValidateAwsCredentials = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../aws/account', () => ({
  validateAwsCredentials: (...args: unknown[]) => mockValidateAwsCredentials(...args),
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

const mockBuildCdkProject = vi.fn();
const mockSynthesizeCdk = vi.fn();
vi.mock('../../../operations/deploy', () => ({
  buildCdkProject: (...args: unknown[]) => mockBuildCdkProject(...args),
  synthesizeCdk: (...args: unknown[]) => mockSynthesizeCdk(...args),
}));

const mockSetupPythonProject = vi.fn().mockResolvedValue({ status: 'success' });
vi.mock('../../../operations/python/setup', () => ({
  setupPythonProject: (...args: unknown[]) => mockSetupPythonProject(...args),
}));

const mockExecutePhase1 = vi.fn();
const mockGetDeployedTemplate = vi.fn();
vi.mock('../phase1-update', () => ({
  executePhase1: (...args: unknown[]) => mockExecutePhase1(...args),
  getDeployedTemplate: (...args: unknown[]) => mockGetDeployedTemplate(...args),
}));

const mockExecutePhase2 = vi.fn();
const mockPublishCdkAssets = vi.fn();
vi.mock('../phase2-import', () => ({
  executePhase2: (...args: unknown[]) => mockExecutePhase2(...args),
  publishCdkAssets: (...args: unknown[]) => mockPublishCdkAssets(...args),
}));

// ============================================================================
// YAML Parsing Tests: null physical IDs
// ============================================================================

describe('YAML parsing: null physical IDs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test8-yaml-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses agent_id: null as falsy physicalAgentId', () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
    source_path: null
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

    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]!.physicalAgentId).toBeFalsy();
    expect(parsed.agents[0]!.physicalAgentArn).toBeFalsy();
  });

  it('parses memory_id: null as falsy physicalMemoryId', () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
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
      mode: STM_AND_LTM
      memory_id: null
      memory_arn: null
      memory_name: test_memory
      event_expiry_days: 30
`;
    const filePath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const parsed = parseStarterToolkitYaml(filePath);

    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0]!.physicalMemoryId).toBeFalsy();
    expect(parsed.memories[0]!.physicalMemoryArn).toBeFalsy();
  });

  it('filters agents with null physical IDs correctly', () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
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
      mode: STM_AND_LTM
      memory_id: null
      memory_arn: null
      memory_name: test_memory
      event_expiry_days: 30
`;
    const filePath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const parsed = parseStarterToolkitYaml(filePath);

    const agentsToImport = parsed.agents.filter(a => a.physicalAgentId);
    const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);

    expect(agentsToImport).toHaveLength(0);
    expect(memoriesToImport).toHaveLength(0);
  });

  it('handles YAML with account: null and region: null', () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
    aws:
      account: null
      region: null
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

    // account: null -> parseYamlValue returns null -> String(null ?? '') = ''
    expect(parsed.awsTarget.account).toBe('');
    expect(parsed.awsTarget.region).toBe('');
  });

  it('handles YAML with completely empty aws section (no account/region keys)', () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    aws:
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

    // When no account/region keys at all, awsTarget gets empty strings
    expect(parsed.awsTarget.account).toBe('');
    expect(parsed.awsTarget.region).toBe('');
  });

  it('handles agent_id with string value "null" (quoted) vs actual null', () => {
    const yamlNull = `
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
    const filePath1 = path.join(tmpDir, 'null.yaml');
    fs.writeFileSync(filePath1, yamlNull);
    const parsed1 = parseStarterToolkitYaml(filePath1);
    expect(parsed1.agents[0]!.physicalAgentId).toBeFalsy();

    // Quoted "null" string should be the literal string "null"
    const yamlQuotedNull = `
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
      agent_id: "null"
      agent_arn: "null"
    memory:
      mode: NO_MEMORY
`;
    const filePath2 = path.join(tmpDir, 'quoted-null.yaml');
    fs.writeFileSync(filePath2, yamlQuotedNull);
    const parsed2 = parseStarterToolkitYaml(filePath2);

    // Quoted "null" is the literal string "null" which is truthy!
    // This would incorrectly try to import with ID "null"
    expect(parsed2.agents[0]!.physicalAgentId).toBe('null');
  });

  it('handles tilde (~) as YAML null value', () => {
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
      agent_id: ~
      agent_arn: ~
    memory:
      mode: NO_MEMORY
`;
    const filePath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const parsed = parseStarterToolkitYaml(filePath);

    // ~ is treated as null by parseYamlValue
    expect(parsed.agents[0]!.physicalAgentId).toBeFalsy();
  });

  it('handles account with value but no region', () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    aws:
      account: '111122223333'
      region: null
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

    expect(parsed.awsTarget.account).toBe('111122223333');
    expect(parsed.awsTarget.region).toBe('');
  });
});

// ============================================================================
// handleImport Tests: no-deploy path
// ============================================================================

describe('handleImport: no-deploy path (no physical IDs)', () => {
  let tmpDir: string;
  let yamlPath: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test8-import-'));

    // Create a no-deploy YAML with valid account/region
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
    source_path: null
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
      mode: STM_AND_LTM
      memory_id: null
      memory_arn: null
      memory_name: test_agent_memory
      event_expiry_days: 30
`;
    yamlPath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(yamlPath, yamlContent);

    // Set up project structure
    const projectDir = path.join(tmpDir, 'myproject');
    const configDir = path.join(projectDir, 'agentcore');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'agentcore.json'),
      JSON.stringify({
        name: 'myproject',
        version: 1,
        runtimes: [],
        memories: [],
        credentials: [],
      })
    );

    // Mock findConfigRoot to return our test config directory
    mockFindConfigRoot.mockReturnValue(configDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('succeeds with empty importedAgents/importedMemories when no physical IDs', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');

    const progressMessages: string[] = [];
    const result = await handleImport({
      source: yamlPath,
      onProgress: (msg: string) => progressMessages.push(msg),
    });

    expect(result.success).toBe(true);
    expect(result.importedAgents).toEqual([]);
    expect(result.importedMemories).toEqual([]);
    expect(result.stackName).toBeDefined();
    expect(result.projectSpec).toBeDefined();
  });

  it('emits "No deployed resources found" message', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');

    const progressMessages: string[] = [];
    await handleImport({
      source: yamlPath,
      onProgress: (msg: string) => progressMessages.push(msg),
    });

    const noResourcesMsg = progressMessages.find(m => m.includes('No deployed resources found'));
    expect(noResourcesMsg).toBeDefined();
    expect(noResourcesMsg).toContain('agentcore deploy');
  });

  it('writes projectSpec (config merge happens) even without physical IDs', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    await handleImport({ source: yamlPath });

    // writeProjectSpec should have been called with the merged config
    expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    expect(writtenSpec.runtimes).toHaveLength(1);
    expect(writtenSpec.runtimes[0].name).toBe('test_agent');
  });

  it('adds memory to project config even without physical memory ID', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    await handleImport({ source: yamlPath });

    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    expect(writtenSpec.memories).toHaveLength(1);
    expect(writtenSpec.memories[0].name).toBe('test_agent_memory');
  });

  it('does NOT call CDK build/synth operations', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    await handleImport({ source: yamlPath });

    expect(mockBuildCdkProject).not.toHaveBeenCalled();
    expect(mockSynthesizeCdk).not.toHaveBeenCalled();
  });

  it('does NOT call Phase 1 or Phase 2', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    await handleImport({ source: yamlPath });

    expect(mockExecutePhase1).not.toHaveBeenCalled();
    expect(mockExecutePhase2).not.toHaveBeenCalled();
    expect(mockPublishCdkAssets).not.toHaveBeenCalled();
  });

  it('does NOT modify deployed state', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    await handleImport({ source: yamlPath });

    expect(mockReadDeployedState).not.toHaveBeenCalled();
    expect(mockWriteDeployedState).not.toHaveBeenCalled();
  });

  it('skips Python setup for container agents', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    await handleImport({ source: yamlPath });

    expect(mockSetupPythonProject).not.toHaveBeenCalled();
  });

  it('returns correct stackName in result', async () => {
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    const result = await handleImport({ source: yamlPath });

    expect(result.stackName).toBe('AgentCore-myproject-default');
  });
});

// ============================================================================
// Target resolution for no-deploy imports
// ============================================================================

describe('handleImport: target resolution with null account/region', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test8-target-'));

    // Set up project structure
    const projectDir = path.join(tmpDir, 'myproject');
    const configDir = path.join(projectDir, 'agentcore');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'agentcore.json'),
      JSON.stringify({
        name: 'myproject',
        version: 1,
        runtimes: [],
        memories: [],
        credentials: [],
      })
    );

    mockFindConfigRoot.mockReturnValue(configDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('succeeds when no targets exist AND YAML has null account/region (no physical IDs)', async () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    aws:
      account: null
      region: null
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
    const yamlPath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(yamlPath, yamlContent);

    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([]); // No existing targets

    const { handleImport } = await import('../actions.js');
    const result = await handleImport({ source: yamlPath });

    // No physical IDs means target resolution is skipped entirely.
    // The import succeeds -- config merge + source copy still happen.
    expect(result.success).toBe(true);
    expect(result.importedAgents).toEqual([]);
    expect(result.importedMemories).toEqual([]);
  });

  it('succeeds when project already has targets even with null YAML account/region', async () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: container
    aws:
      account: null
      region: null
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
    const yamlPath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(yamlPath, yamlContent);

    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([{ name: 'default', account: '111122223333', region: 'us-east-1' }]);

    const { handleImport } = await import('../actions.js');
    const result = await handleImport({ source: yamlPath });

    expect(result.success).toBe(true);
    expect(result.importedAgents).toEqual([]);
    expect(result.importedMemories).toEqual([]);
  });

  it('does not write targets when YAML has account/region but no physical IDs', async () => {
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
    const yamlPath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(yamlPath, yamlContent);

    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
    mockWriteProjectSpec.mockResolvedValue(undefined);
    mockReadAWSDeploymentTargets.mockResolvedValue([]); // No existing targets

    const { handleImport } = await import('../actions.js');
    const result = await handleImport({ source: yamlPath });

    expect(result.success).toBe(true);
    // No physical IDs means target is not written to disk
    expect(mockWriteAWSDeploymentTargets).not.toHaveBeenCalled();
    // But the stackName should still be computed using 'default' fallback
    expect(result.stackName).toBe('AgentCore-myproject-default');
  });
});

// ============================================================================
// Edge case: empty value after colon in YAML
// ============================================================================

describe('YAML parsing edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test8-edge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles agent_id with empty value after colon (treated as nested object, not null)', () => {
    // agent_id: (empty) is treated as a nested object {} by the parser, not null.
    // This is a known limitation of the simple YAML parser.
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
      agent_id:
      agent_arn:
    memory:
      mode: NO_MEMORY
`;
    const filePath = path.join(tmpDir, '.bedrock_agentcore.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const parsed = parseStarterToolkitYaml(filePath);

    // The parser creates {} for empty values after colon.
    // An empty object {} is truthy but not a usable ID.
    // Starter toolkit always writes "null" not empty, so this is academic.
    const agent = parsed.agents[0]!;
    expect(agent.physicalAgentId).toBeDefined(); // {} is defined (not undefined)
  });

  it('preserves agent metadata even when physical IDs are null', () => {
    const yamlContent = `
default_agent: test_agent
agents:
  test_agent:
    name: test_agent
    entrypoint: main.py
    deployment_type: direct_code_deploy
    runtime_type: PYTHON_3_12
    source_path: null
    aws:
      account: '111122223333'
      region: us-east-1
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: MCP
      observability:
        enabled: false
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

    expect(agent.name).toBe('test_agent');
    expect(agent.build).toBe('CodeZip');
    expect(agent.protocol).toBe('MCP');
    expect(agent.enableOtel).toBe(false);
    expect(agent.runtimeVersion).toBe('PYTHON_3_12');
  });
});
