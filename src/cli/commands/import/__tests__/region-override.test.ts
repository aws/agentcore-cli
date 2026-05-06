/**
 * Region override test (issue #924)
 *
 * Verifies that `handleImport` makes the resolved deployment target's region
 * authoritative on the environment for the duration of the call (so AWS SDK
 * clients constructed without an explicit `region` option pick it up) and
 * restores any prior values afterwards — including on the error path.
 */
// ── Imports under test (must come after mocks) ───────────────────────────
import { handleImport } from '../actions.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────

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

const mockValidateAwsCredentials = vi.fn();
vi.mock('../../../aws/account', () => ({
  validateAwsCredentials: (...args: unknown[]) => mockValidateAwsCredentials(...args),
}));

vi.mock('../../../logging', () => ({
  ExecLogger: class MockExecLogger {
    startStep = vi.fn();
    endStep = vi.fn();
    log = vi.fn();
    finalize = vi.fn();
    getRelativeLogPath = vi.fn().mockReturnValue('agentcore/.cli/logs/import/import-region-mock.log');
    logFilePath = 'agentcore/.cli/logs/import/import-region-mock.log';
  },
}));

const mockExecuteCdkImportPipeline = vi.fn();
vi.mock('../import-pipeline', () => ({
  executeCdkImportPipeline: (...args: unknown[]) => mockExecuteCdkImportPipeline(...args),
}));

const mockSetupPythonProject = vi.fn().mockResolvedValue({ status: 'success' });
vi.mock('../../../operations/python/setup', () => ({
  setupPythonProject: (...args: unknown[]) => mockSetupPythonProject(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

const TARGET_REGION = 'ap-southeast-2';
const TARGET_ACCOUNT = '111122223333';

function writeFixtureYaml(dir: string, region: string, account: string, withPhysicalIds: boolean): string {
  const yaml = `default_agent: my_agent
agents:
  my_agent:
    name: my_agent
    entrypoint: main.py
    deployment_type: direct_code_deploy
    runtime_type: PYTHON_3_12
    language: python
    aws:
      account: '${account}'
      region: ${region}
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
${withPhysicalIds ? `      agent_id: agent-abc-123\n      agent_arn: arn:aws:bedrock-agentcore:${region}:${account}:runtime/agent-abc-123` : '      agent_id: null\n      agent_arn: null'}
`;
  const filePath = path.join(dir, 'config.yaml');
  fs.writeFileSync(filePath, yaml);
  return filePath;
}

function makeProjectSpec() {
  return {
    name: 'TestProject',
    version: 1,
    runtimes: [],
    memories: [],
    credentials: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('handleImport — region env override (issue #924)', () => {
  let tmpDir: string;
  let prevRegion: string | undefined;
  let prevDefaultRegion: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-region-'));

    // Snapshot env so each test starts clean
    prevRegion = process.env.AWS_REGION;
    prevDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;

    // Default mocks
    mockFindConfigRoot.mockReturnValue(path.join(tmpDir, 'agentcore'));
    mockReadProjectSpec.mockResolvedValue(makeProjectSpec());
    mockReadAWSDeploymentTargets.mockResolvedValue([
      { name: 'default', account: TARGET_ACCOUNT, region: TARGET_REGION },
    ]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prevRegion;
    if (prevDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
  });

  it('promotes the resolved target region onto AWS_REGION/AWS_DEFAULT_REGION during execution and restores afterwards', async () => {
    const observed: { region?: string; defaultRegion?: string } = {};

    // Capture env state at the deepest mocked downstream step so we know the
    // override is active by the time SDK clients would be constructed.
    mockExecuteCdkImportPipeline.mockImplementation(() => {
      observed.region = process.env.AWS_REGION;
      observed.defaultRegion = process.env.AWS_DEFAULT_REGION;
      return Promise.resolve({ success: true, stackName: 'TestStack-default' });
    });

    const yamlPath = writeFixtureYaml(tmpDir, TARGET_REGION, TARGET_ACCOUNT, /* withPhysicalIds */ true);

    const result = await handleImport({ source: yamlPath });

    // Region override was active during the import pipeline call
    expect(observed.region).toBe(TARGET_REGION);
    expect(observed.defaultRegion).toBe(TARGET_REGION);
    // Pipeline was reached (sanity)
    expect(mockExecuteCdkImportPipeline).toHaveBeenCalled();
    // Env was restored on exit (we deleted both before the call)
    expect(process.env.AWS_REGION).toBeUndefined();
    expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
    // Sanity: success or at least did not blow up before the pipeline
    expect(result.logPath).toBeDefined();
  });

  it('restores env vars even when an error is thrown mid-flight', async () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_DEFAULT_REGION = 'us-east-1';

    mockExecuteCdkImportPipeline.mockImplementation(() => {
      // Confirm override is active before throwing
      expect(process.env.AWS_REGION).toBe(TARGET_REGION);
      throw new Error('synthetic failure');
    });

    const yamlPath = writeFixtureYaml(tmpDir, TARGET_REGION, TARGET_ACCOUNT, /* withPhysicalIds */ true);

    const result = await handleImport({ source: yamlPath });

    // The thrown error is caught and surfaced via the result, not re-thrown
    expect(result.success).toBe(false);
    // Prior env values are restored
    expect(process.env.AWS_REGION).toBe('us-east-1');
    expect(process.env.AWS_DEFAULT_REGION).toBe('us-east-1');
  });

  it('restores env even when there are no physical IDs (light path)', async () => {
    // No physical IDs → the import skips the CFN pipeline entirely, but should
    // still apply + restore the override based on the resolved single target.
    let observedDuring: string | undefined;
    mockSetupPythonProject.mockImplementation(() => {
      observedDuring = process.env.AWS_REGION;
      return Promise.resolve({ status: 'success' as const });
    });

    const yamlPath = writeFixtureYaml(tmpDir, TARGET_REGION, TARGET_ACCOUNT, /* withPhysicalIds */ false);

    await handleImport({ source: yamlPath });

    expect(observedDuring).toBe(TARGET_REGION);
    expect(process.env.AWS_REGION).toBeUndefined();
    expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
  });
});
