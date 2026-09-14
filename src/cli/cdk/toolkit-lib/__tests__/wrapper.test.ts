import { PermissionsBoundaryRequiredError } from '../../../../lib/errors/types';
import { CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY, PERMISSIONS_BOUNDARY_ENV_VAR } from '../../../constants';
import { CdkToolkitWrapper } from '../wrapper';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromCdkApp, deploy, readGlobalConfigMock, contextStoreCalls, toolkitProps } = vi.hoisted(() => ({
  fromCdkApp: vi.fn().mockResolvedValue({}),
  deploy: vi.fn().mockResolvedValue({}),
  readGlobalConfigMock: vi.fn(),
  contextStoreCalls: [] as { appDirectory: string; commandlineContext?: Record<string, unknown> }[],
  toolkitProps: [] as { ioHost?: { notify: (msg: unknown) => Promise<void> } }[],
}));

vi.mock('@aws-cdk/toolkit-lib', () => ({
  Toolkit: class {
    constructor(props: { ioHost?: { notify: (msg: unknown) => Promise<void> } }) {
      toolkitProps.push(props);
    }
    fromCdkApp = fromCdkApp;
    deploy = deploy;
  },
  BaseCredentials: { awsCliCompatible: vi.fn().mockReturnValue({}) },
  BootstrapEnvironments: { fromList: vi.fn() },
  BootstrapStackParameters: { exactly: vi.fn() },
  CdkAppMultiContext: class {
    constructor(appDirectory: string, commandlineContext?: Record<string, unknown>) {
      contextStoreCalls.push({ appDirectory, commandlineContext });
    }
  },
}));

// Path is resolved at module load, so the read is mocked rather than redirected.
vi.mock('../../../../lib/schemas/io/global-config', () => ({
  readGlobalConfig: readGlobalConfigMock,
}));

const PROJECT_DIR = '/tmp/does-not-exist/agentcore/cdk';

/** The `props` object handed to `Toolkit.fromCdkApp` on the most recent initialize(). */
function lastFromCdkAppProps(): Record<string, unknown> {
  return fromCdkApp.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe('CdkToolkitWrapper permissions boundary wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextStoreCalls.length = 0;
    delete process.env[PERMISSIONS_BOUNDARY_ENV_VAR];
    fromCdkApp.mockResolvedValue({});
    readGlobalConfigMock.mockResolvedValue({ success: true, config: {} });
  });

  it('leaves the default context store in place when no boundary is configured', async () => {
    await new CdkToolkitWrapper({ projectDir: PROJECT_DIR }).initialize();

    expect(lastFromCdkAppProps().contextStore).toBeUndefined();
    expect(contextStoreCalls).toHaveLength(0);
  });

  it('layers the boundary onto the app context store as a policy name', async () => {
    await new CdkToolkitWrapper({
      projectDir: PROJECT_DIR,
      permissionsBoundary: 'AgentCoreExecutionRoleBoundary',
    }).initialize();

    expect(lastFromCdkAppProps().contextStore).toBeDefined();
    expect(contextStoreCalls).toEqual([
      {
        appDirectory: PROJECT_DIR,
        commandlineContext: {
          [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { name: 'AgentCoreExecutionRoleBoundary' },
        },
      },
    ]);
  });

  it('passes a boundary ARN through as the arn form', async () => {
    const arn = 'arn:aws:iam::111122223333:policy/AgentCoreExecutionRoleBoundary';

    await new CdkToolkitWrapper({ projectDir: PROJECT_DIR, permissionsBoundary: arn }).initialize();

    expect(contextStoreCalls[0]?.commandlineContext).toEqual({
      [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { arn },
    });
  });

  it('picks the boundary up from the environment', async () => {
    process.env[PERMISSIONS_BOUNDARY_ENV_VAR] = 'FromEnvBoundary';

    await new CdkToolkitWrapper({ projectDir: PROJECT_DIR }).initialize();

    expect(contextStoreCalls[0]?.commandlineContext).toEqual({
      [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { name: 'FromEnvBoundary' },
    });
  });

  it('picks the boundary up from the machine global config', async () => {
    readGlobalConfigMock.mockResolvedValue({ success: true, config: { permissionsBoundary: 'FromGlobalBoundary' } });

    await new CdkToolkitWrapper({ projectDir: PROJECT_DIR }).initialize();

    expect(contextStoreCalls[0]?.commandlineContext).toEqual({
      [CDK_PERMISSIONS_BOUNDARY_CONTEXT_KEY]: { name: 'FromGlobalBoundary' },
    });
  });
});

describe('CdkToolkitWrapper deploy error rewriting', () => {
  const REQUIRED_ARN = 'arn:aws:iam::111122223333:policy/OrgBoundary';
  const denial =
    'is not authorized to perform: iam:CreateRole on resource: arn:aws:iam::111122223333:role/Foo ' +
    `with an explicit deny in a permissions boundary: ${REQUIRED_ARN}`;

  beforeEach(() => {
    vi.clearAllMocks();
    contextStoreCalls.length = 0;
    toolkitProps.length = 0;
    delete process.env[PERMISSIONS_BOUNDARY_ENV_VAR];
    fromCdkApp.mockResolvedValue({});
    readGlobalConfigMock.mockResolvedValue({ success: true, config: {} });
  });

  it('turns a boundary denial into PermissionsBoundaryRequiredError', async () => {
    deploy.mockRejectedValue(new Error(denial));
    const wrapper = new CdkToolkitWrapper({ projectDir: PROJECT_DIR });
    await wrapper.initialize();

    await expect(wrapper.deploy()).rejects.toBeInstanceOf(PermissionsBoundaryRequiredError);
  });

  it('reports the mismatch when a boundary was already applied', async () => {
    deploy.mockRejectedValue(new Error(denial));
    const wrapper = new CdkToolkitWrapper({ projectDir: PROJECT_DIR, permissionsBoundary: 'WrongBoundary' });
    await wrapper.initialize();

    await expect(wrapper.deploy()).rejects.toThrow(/Applied: {2}WrongBoundary/);
  });

  it('leaves unrelated deploy failures alone', async () => {
    const original = new Error('stack is in ROLLBACK_COMPLETE state');
    deploy.mockRejectedValue(original);
    const wrapper = new CdkToolkitWrapper({ projectDir: PROJECT_DIR });
    await wrapper.initialize();

    await expect(wrapper.deploy()).rejects.toBe(original);
  });

  // What actually happens against a boundary-enforcing account: the reason arrives only as a
  // progress message, then the toolkit throws NoStack with no cause.
  const progressMessage = {
    code: 'CDK_TOOLKIT_I5502',
    level: 'info',
    message:
      'AgentCore-proj-default | 1/5 | CREATE_FAILED | AWS::IAM::Role | ExecutionRole is not authorized to ' +
      'perform: iam:CreateRole on resource: arn:aws:iam::111122223333:role/Foo with an explicit deny in a ' +
      `permissions boundary: ${REQUIRED_ARN}`,
  };

  /** A deploy that reports the denial as progress, then fails the way CloudFormation does. */
  function deployReportingDenialThenNoStack(notifyDuringDeploy: boolean) {
    deploy.mockImplementation(async () => {
      if (notifyDuringDeploy) {
        await toolkitProps.at(-1)?.ioHost?.notify(progressMessage);
      }
      throw new Error('NoStack: CloudFormationStack object does not hold a stack');
    });
  }

  it('recognizes a denial seen on a progress message when the error itself says NoStack', async () => {
    const notify = vi.fn<(msg: unknown) => Promise<void>>().mockResolvedValue(undefined);
    const wrapper = new CdkToolkitWrapper({
      projectDir: PROJECT_DIR,
      ioHost: { notify, requestResponse: vi.fn() } as never,
    });
    await wrapper.initialize();
    deployReportingDenialThenNoStack(true);

    await expect(wrapper.deploy()).rejects.toBeInstanceOf(PermissionsBoundaryRequiredError);
    // The wrapper must stay transparent: the caller's host still receives every message.
    expect(notify).toHaveBeenCalledWith(progressMessage);
  });

  it('does not pin an earlier deploy′s denial on a later unrelated failure', async () => {
    const wrapper = new CdkToolkitWrapper({
      projectDir: PROJECT_DIR,
      ioHost: { notify: vi.fn().mockResolvedValue(undefined), requestResponse: vi.fn() } as never,
    });
    await wrapper.initialize();

    deployReportingDenialThenNoStack(true);
    await expect(wrapper.deploy()).rejects.toBeInstanceOf(PermissionsBoundaryRequiredError);

    // Second deploy reports no denial; the failure must surface as itself.
    deployReportingDenialThenNoStack(false);
    await expect(wrapper.deploy()).rejects.not.toBeInstanceOf(PermissionsBoundaryRequiredError);
  });

  it('leaves the toolkit default host in place when the caller supplies none', async () => {
    await new CdkToolkitWrapper({ projectDir: PROJECT_DIR }).initialize();

    expect(toolkitProps.at(-1)?.ioHost).toBeUndefined();
  });
});
