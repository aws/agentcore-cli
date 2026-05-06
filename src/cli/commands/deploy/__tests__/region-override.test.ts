/**
 * Region override test (issue #924)
 *
 * Verifies that `handleDeploy` makes the resolved deployment target's region
 * authoritative on the environment for the duration of the call (so AWS SDK
 * clients and the CDK toolkit-lib internals — which fall back to AWS_REGION
 * / AWS_DEFAULT_REGION when no explicit region is configured — pick up the
 * target's region) and restores any prior env values afterwards, including on
 * the error path.
 */
// ── Imports under test (must come after mocks) ───────────────────────────
import { handleDeploy } from '../actions.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────

const mockResolveAWSDeploymentTargets = vi.fn();
const mockReadProjectSpec = vi.fn();

vi.mock('../../../../lib', () => ({
  ConfigIO: class MockConfigIO {
    resolveAWSDeploymentTargets = mockResolveAWSDeploymentTargets;
    readProjectSpec = mockReadProjectSpec;
  },
  SecureCredentials: class MockSecureCredentials {
    constructor(public values: Record<string, string>) {}
  },
}));

const mockValidateAwsCredentials = vi.fn();
vi.mock('../../../aws/account', () => ({
  validateAwsCredentials: (...args: unknown[]) => mockValidateAwsCredentials(...args),
}));

vi.mock('../../../cdk/toolkit-lib', () => ({
  createSwitchableIoHost: () => ({ host: {}, switchToVerbose: vi.fn(), dispose: vi.fn() }),
}));

vi.mock('../../../cloudformation', () => ({
  buildDeployedState: vi.fn(),
  getStackOutputs: vi.fn(),
  parseAgentOutputs: vi.fn(),
  parseEvaluatorOutputs: vi.fn(),
  parseGatewayOutputs: vi.fn(),
  parseMemoryOutputs: vi.fn(),
  parseOnlineEvalOutputs: vi.fn(),
  parsePolicyEngineOutputs: vi.fn(),
  parsePolicyOutputs: vi.fn(),
  parseRuntimeEndpointOutputs: vi.fn(),
}));

const mockValidateProject = vi.fn();
vi.mock('../../../operations/deploy', () => ({
  bootstrapEnvironment: vi.fn(),
  buildCdkProject: vi.fn(),
  checkBootstrapNeeded: vi.fn(),
  checkStackDeployability: vi.fn(),
  getAllCredentials: vi.fn().mockReturnValue([]),
  hasIdentityApiProviders: vi.fn().mockReturnValue(false),
  hasIdentityOAuthProviders: vi.fn().mockReturnValue(false),
  performStackTeardown: vi.fn(),
  setupApiKeyProviders: vi.fn(),
  setupOAuth2Providers: vi.fn(),
  setupTransactionSearch: vi.fn(),
  synthesizeCdk: vi.fn(),
  validateProject: (...args: unknown[]) => mockValidateProject(...args),
}));

vi.mock('../../../operations/deploy/gateway-status', () => ({
  formatTargetStatus: vi.fn(),
  getGatewayTargetStatuses: vi.fn(),
}));

vi.mock('../../../operations/deploy/post-deploy-ab-tests', () => ({
  deleteOrphanedABTests: vi.fn(),
  setupABTests: vi.fn(),
}));

vi.mock('../../../operations/deploy/post-deploy-config-bundles', () => ({
  resolveConfigBundleComponentKeys: vi.fn(),
  setupConfigBundles: vi.fn(),
}));

vi.mock('../../../operations/deploy/post-deploy-http-gateways', () => ({
  setupHttpGateways: vi.fn(),
}));

vi.mock('../../../operations/deploy/post-deploy-online-evals', () => ({
  enableOnlineEvalConfigs: vi.fn(),
}));

vi.mock('../../../logging', () => ({
  ExecLogger: class MockExecLogger {
    startStep = vi.fn();
    endStep = vi.fn();
    log = vi.fn();
    finalize = vi.fn();
    getRelativeLogPath = vi.fn().mockReturnValue('agentcore/.cli/logs/deploy/deploy-mock.log');
    logFilePath = 'agentcore/.cli/logs/deploy/deploy-mock.log';
  },
}));

// ── Tests ────────────────────────────────────────────────────────────────

const TARGET_REGION = 'ap-southeast-2';
const TARGET_ACCOUNT = '111122223333';

describe('handleDeploy — region env override (issue #924)', () => {
  let prevRegion: string | undefined;
  let prevDefaultRegion: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    prevRegion = process.env.AWS_REGION;
    prevDefaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;

    mockResolveAWSDeploymentTargets.mockResolvedValue([
      { name: 'default', account: TARGET_ACCOUNT, region: TARGET_REGION },
    ]);
    mockReadProjectSpec.mockResolvedValue({
      name: 'TestProject',
      version: 1,
      runtimes: [],
      memories: [],
      credentials: [],
    });
  });

  afterEach(() => {
    if (prevRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prevRegion;
    if (prevDefaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = prevDefaultRegion;
  });

  it('promotes the target region onto AWS_REGION/AWS_DEFAULT_REGION before downstream operations run', async () => {
    let observedRegion: string | undefined;
    let observedDefault: string | undefined;

    // validateProject is the first downstream operation after the target is
    // loaded — capturing env state here proves the override is in effect by
    // the time any SDK client could be constructed by deeper helpers.
    mockValidateProject.mockImplementation(() => {
      observedRegion = process.env.AWS_REGION;
      observedDefault = process.env.AWS_DEFAULT_REGION;
      // Return a context that triggers immediate exit (no resources).
      throw new Error('halt-after-validate');
    });

    const result = await handleDeploy({ target: 'default' });

    expect(observedRegion).toBe(TARGET_REGION);
    expect(observedDefault).toBe(TARGET_REGION);
    // Error path returned a failure result; env is restored.
    expect(result.success).toBe(false);
    expect(process.env.AWS_REGION).toBeUndefined();
    expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
  });

  it('restores prior AWS_REGION / AWS_DEFAULT_REGION values on the error path', async () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_DEFAULT_REGION = 'us-east-1';

    mockValidateProject.mockImplementation(() => {
      // Override active inside the call.
      expect(process.env.AWS_REGION).toBe(TARGET_REGION);
      throw new Error('boom');
    });

    const result = await handleDeploy({ target: 'default' });

    expect(result.success).toBe(false);
    expect(process.env.AWS_REGION).toBe('us-east-1');
    expect(process.env.AWS_DEFAULT_REGION).toBe('us-east-1');
  });

  it('does not mutate env when the target cannot be resolved', async () => {
    mockResolveAWSDeploymentTargets.mockResolvedValue([]);

    const result = await handleDeploy({ target: 'default' });

    // Target lookup failed → early return, validateProject was never called,
    // and env was never touched.
    expect(mockValidateProject).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(process.env.AWS_REGION).toBeUndefined();
    expect(process.env.AWS_DEFAULT_REGION).toBeUndefined();
  });
});
