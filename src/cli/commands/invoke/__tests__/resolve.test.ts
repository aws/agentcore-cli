import { ResourceNotFoundError, ValidationError } from '../../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../../schema';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../../operations/fetch-access';
import { resolveInvokeTarget } from '../resolve';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../operations/fetch-access', () => ({
  canFetchRuntimeToken: vi.fn(),
  fetchRuntimeToken: vi.fn(),
}));

vi.mock('../../../operations/session', () => ({
  generateSessionId: vi.fn(() => 'generated-session-id'),
}));

const mockedCanFetch = vi.mocked(canFetchRuntimeToken);
const mockedFetchToken = vi.mocked(fetchRuntimeToken);

function makeProject(overrides: Partial<AgentCoreProjectSpec> = {}): AgentCoreProjectSpec {
  return {
    name: 'test-project',
    runtimes: [
      {
        name: 'my-agent',
        build: 'CodeZip',
        codeLocation: './agents/my-agent',
        entrypoint: 'main.py',
        runtimeVersion: '1.0',
        networkMode: 'PUBLIC',
      },
    ],
    credentials: [],
    ...overrides,
  } as AgentCoreProjectSpec;
}

function makeDeployedState(overrides: Partial<DeployedState> = {}): DeployedState {
  return {
    targets: {
      default: {
        resources: {
          runtimes: {
            'my-agent': {
              runtimeId: 'rt-123',
              runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/rt-123',
              roleArn: 'arn:aws:iam::123456789:role/test-role',
            },
          },
        },
      },
    },
    ...overrides,
  } as DeployedState;
}

function makeAwsTargets(): AwsDeploymentTargets {
  return [{ name: 'default', account: '123456789', region: 'us-east-1' }];
}

describe('resolveInvokeTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves successfully with default target and single agent', async () => {
    const result = await resolveInvokeTarget({
      project: makeProject(),
      deployedState: makeDeployedState(),
      awsTargets: makeAwsTargets(),
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.agentSpec.name).toBe('my-agent');
    expect(result.targetName).toBe('default');
    expect(result.region).toBe('us-east-1');
    expect(result.runtimeArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/rt-123');
  });

  it('returns error when no deployed targets exist', async () => {
    const result = await resolveInvokeTarget({
      project: makeProject(),
      deployedState: { targets: {} } as DeployedState,
      awsTargets: makeAwsTargets(),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ResourceNotFoundError);
    expect(result.error.message).toContain('No deployed targets found');
  });

  it('returns error when specified target name does not exist', async () => {
    const result = await resolveInvokeTarget({
      project: makeProject(),
      deployedState: makeDeployedState(),
      awsTargets: makeAwsTargets(),
      targetName: 'nonexistent',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ResourceNotFoundError);
    expect(result.error.message).toContain("'nonexistent' not found");
  });

  it('returns error when target config is missing from aws-targets', async () => {
    const result = await resolveInvokeTarget({
      project: makeProject(),
      deployedState: makeDeployedState(),
      awsTargets: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ResourceNotFoundError);
    expect(result.error.message).toContain("Target config 'default' not found");
  });

  it('returns error when no runtimes are defined', async () => {
    const result = await resolveInvokeTarget({
      project: makeProject({ runtimes: [] }),
      deployedState: makeDeployedState(),
      awsTargets: makeAwsTargets(),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.message).toContain('No agents defined');
  });

  it('returns error when multiple runtimes exist but no agentName specified', async () => {
    const project = makeProject({
      runtimes: [
        {
          name: 'agent-a',
          build: 'CodeZip',
          codeLocation: '.',
          entrypoint: 'a.py',
          runtimeVersion: '1.0',
          networkMode: 'PUBLIC',
        },
        {
          name: 'agent-b',
          build: 'CodeZip',
          codeLocation: '.',
          entrypoint: 'b.py',
          runtimeVersion: '1.0',
          networkMode: 'PUBLIC',
        },
      ] as unknown as AgentCoreProjectSpec['runtimes'],
    });

    const result = await resolveInvokeTarget({
      project,
      deployedState: makeDeployedState(),
      awsTargets: makeAwsTargets(),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.message).toContain('Multiple runtimes found');
  });

  it('returns error when specified agent name does not exist', async () => {
    const result = await resolveInvokeTarget({
      project: makeProject(),
      deployedState: makeDeployedState(),
      awsTargets: makeAwsTargets(),
      agentName: 'nonexistent',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ResourceNotFoundError);
    expect(result.error.message).toContain("'nonexistent' not found");
  });

  it('returns error when agent is not deployed to the target', async () => {
    const deployedState = makeDeployedState({
      targets: {
        default: {
          resources: {
            runtimes: {},
          },
        },
      },
    } as unknown as DeployedState);

    const result = await resolveInvokeTarget({
      project: makeProject(),
      deployedState,
      awsTargets: makeAwsTargets(),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ValidationError);
    expect(result.error.message).toContain("'my-agent' is not deployed");
  });

  it('resolves specific agent by name', async () => {
    const project = makeProject({
      runtimes: [
        {
          name: 'agent-a',
          build: 'CodeZip',
          codeLocation: '.',
          entrypoint: 'a.py',
          runtimeVersion: '1.0',
          networkMode: 'PUBLIC',
        },
        {
          name: 'agent-b',
          build: 'CodeZip',
          codeLocation: '.',
          entrypoint: 'b.py',
          runtimeVersion: '1.0',
          networkMode: 'PUBLIC',
        },
      ] as unknown as AgentCoreProjectSpec['runtimes'],
    });

    const deployedState = {
      targets: {
        default: {
          resources: {
            runtimes: {
              'agent-a': {
                runtimeId: 'rt-a',
                runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-a',
                roleArn: 'arn:aws:iam::123:role/r',
              },
              'agent-b': {
                runtimeId: 'rt-b',
                runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-b',
                roleArn: 'arn:aws:iam::123:role/r',
              },
            },
          },
        },
      },
    } as unknown as DeployedState;

    const result = await resolveInvokeTarget({
      project,
      deployedState,
      awsTargets: makeAwsTargets(),
      agentName: 'agent-b',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.agentSpec.name).toBe('agent-b');
    expect(result.runtimeArn).toContain('rt-b');
  });

  describe('CUSTOM_JWT token resolution', () => {
    function makeJwtProject(): AgentCoreProjectSpec {
      return makeProject({
        runtimes: [
          {
            name: 'my-agent',
            build: 'CodeZip',
            codeLocation: '.',
            entrypoint: 'main.py',
            runtimeVersion: '1.0',
            networkMode: 'PUBLIC',
            authorizerType: 'CUSTOM_JWT',
            authorizerConfiguration: {
              customJwtAuthorizer: { issuerUrl: 'https://issuer.example.com', audiences: ['aud'] },
            },
          },
        ] as unknown as AgentCoreProjectSpec['runtimes'],
      });
    }

    it('auto-fetches bearer token for CUSTOM_JWT agents', async () => {
      mockedCanFetch.mockResolvedValue(true);
      mockedFetchToken.mockResolvedValue({ token: 'jwt-token-123', expiresIn: 3600 });

      const result = await resolveInvokeTarget({
        project: makeJwtProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.bearerToken).toBe('jwt-token-123');
      expect(mockedCanFetch).toHaveBeenCalledWith('my-agent', undefined);
      expect(mockedFetchToken).toHaveBeenCalledWith('my-agent', { deployTarget: 'default' });
    });

    it('skips token fetch when bearerToken is already provided', async () => {
      const result = await resolveInvokeTarget({
        project: makeJwtProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
        bearerToken: 'pre-existing-token',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.bearerToken).toBe('pre-existing-token');
      expect(mockedCanFetch).not.toHaveBeenCalled();
    });

    it('returns error when canFetchRuntimeToken is false', async () => {
      mockedCanFetch.mockResolvedValue(false);

      const result = await resolveInvokeTarget({
        project: makeJwtProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('no bearer token is available');
    });

    it('returns error when fetchRuntimeToken throws', async () => {
      mockedCanFetch.mockResolvedValue(true);
      mockedFetchToken.mockRejectedValue(new Error('token endpoint unreachable'));

      const result = await resolveInvokeTarget({
        project: makeJwtProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('Auto-fetch failed');
      expect(result.error.message).toContain('token endpoint unreachable');
    });
  });

  describe('session ID generation', () => {
    it('generates session ID when bearer token is present and no session ID provided', async () => {
      const result = await resolveInvokeTarget({
        project: makeProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
        bearerToken: 'some-token',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessionId).toBe('generated-session-id');
    });

    it('preserves provided session ID even with bearer token', async () => {
      const result = await resolveInvokeTarget({
        project: makeProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
        bearerToken: 'some-token',
        sessionId: 'my-session',
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessionId).toBe('my-session');
    });

    it('does not generate session ID when no bearer token', async () => {
      const result = await resolveInvokeTarget({
        project: makeProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.sessionId).toBeUndefined();
    });
  });

  describe('config bundle baggage', () => {
    it('constructs baggage when a config bundle is associated with the agent', async () => {
      const project = makeProject({
        configBundles: [
          {
            name: 'my-bundle',
            components: { '{{runtime:my-agent}}': { type: 'inference-profile' } },
          },
        ],
      } as unknown as Partial<AgentCoreProjectSpec>);

      const deployedState = {
        targets: {
          default: {
            resources: {
              runtimes: {
                'my-agent': {
                  runtimeId: 'rt-123',
                  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/rt-123',
                  roleArn: 'arn:aws:iam::123456789:role/test-role',
                },
              },
              configBundles: {
                'my-bundle': {
                  bundleArn: 'arn:aws:bedrock-agentcore:us-east-1:123:config-bundle/cb-1',
                  versionId: 'v2',
                },
              },
            },
          },
        },
      } as unknown as DeployedState;

      const result = await resolveInvokeTarget({
        project,
        deployedState,
        awsTargets: makeAwsTargets(),
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.baggage).toContain('aws.agentcore.configbundle_arn=');
      expect(result.baggage).toContain('aws.agentcore.configbundle_version=');
      expect(result.baggage).toContain(
        encodeURIComponent('arn:aws:bedrock-agentcore:us-east-1:123:config-bundle/cb-1')
      );
      expect(result.baggage).toContain(encodeURIComponent('v2'));
    });

    it('returns no baggage when no config bundle is associated', async () => {
      const result = await resolveInvokeTarget({
        project: makeProject(),
        deployedState: makeDeployedState(),
        awsTargets: makeAwsTargets(),
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.baggage).toBeUndefined();
    });
  });

  it('passes configIO to token fetch functions when provided', async () => {
    const project = makeProject({
      runtimes: [
        {
          name: 'my-agent',
          build: 'CodeZip',
          codeLocation: '.',
          entrypoint: 'main.py',
          runtimeVersion: '1.0',
          networkMode: 'PUBLIC',
          authorizerType: 'CUSTOM_JWT',
          authorizerConfiguration: {
            customJwtAuthorizer: { issuerUrl: 'https://issuer.example.com', audiences: ['aud'] },
          },
        },
      ] as unknown as AgentCoreProjectSpec['runtimes'],
    });

    mockedCanFetch.mockResolvedValue(true);
    mockedFetchToken.mockResolvedValue({ token: 'tok', expiresIn: 3600 });

    const fakeConfigIO = {} as any;
    await resolveInvokeTarget({
      project,
      deployedState: makeDeployedState(),
      awsTargets: makeAwsTargets(),
      configIO: fakeConfigIO,
    });

    expect(mockedCanFetch).toHaveBeenCalledWith('my-agent', { configIO: fakeConfigIO });
    expect(mockedFetchToken).toHaveBeenCalledWith('my-agent', { configIO: fakeConfigIO, deployTarget: 'default' });
  });
});
