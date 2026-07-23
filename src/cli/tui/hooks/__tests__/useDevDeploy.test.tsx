import { useDevDeploy } from '../useDevDeploy.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockHandleDeploy,
  mockReadProjectSpec,
  mockEnsureDefaultDeploymentTarget,
  mockCanSkipDeploy,
  TEST_MANAGED_MEMORY_NOTICE,
} = vi.hoisted(() => ({
  mockHandleDeploy: vi.fn(),
  mockReadProjectSpec: vi.fn(),
  mockEnsureDefaultDeploymentTarget: vi.fn(),
  mockCanSkipDeploy: vi.fn(),
  TEST_MANAGED_MEMORY_NOTICE: 'Managed memory: this harness provisions a dedicated AgentCore Memory resource',
}));

vi.mock('../../../commands/deploy/actions.js', () => ({
  handleDeploy: (...args: unknown[]) => mockHandleDeploy(...args),
}));

// The mount effect now reads the project spec, ensures a deploy target, and checks
// for changes before deploying. Mock those so the effect reaches handleDeploy instead
// of hanging/erroring on the real ConfigIO (no project on disk in tests). Keep the rest
// of `lib` intact (getErrorMessage et al. are resolved through it) and override only ConfigIO.
vi.mock('../../../../lib', async importActual => ({
  ...(await importActual<typeof import('../../../../lib')>()),
  ConfigIO: vi.fn(function (this: Record<string, unknown>) {
    this.readProjectSpec = mockReadProjectSpec;
  }),
}));

vi.mock('../../../operations/deploy', () => ({
  ensureDefaultDeploymentTarget: (...args: unknown[]) => mockEnsureDefaultDeploymentTarget(...args),
  MANAGED_MEMORY_DEPLOY_NOTICE: TEST_MANAGED_MEMORY_NOTICE,
}));

vi.mock('../../../operations/deploy/change-detection', () => ({
  canSkipDeploy: (...args: unknown[]) => mockCanSkipDeploy(...args),
}));

function Harness({ skip }: { skip?: boolean }) {
  const { steps, isComplete, error, managedMemoryNotice, dependencySyncNotice, dependencySyncWarnings } = useDevDeploy({
    skip,
  });
  return (
    <Text>
      steps:{steps.length} isComplete:{String(isComplete)} error:{error ?? 'null'} notice:
      {managedMemoryNotice ?? 'null'} depSyncNotice:{dependencySyncNotice ?? 'null'} depSyncWarnings:
      {dependencySyncWarnings.length}
    </Text>
  );
}

describe('useDevDeploy', () => {
  beforeEach(() => {
    // Default: a deployable project (has a harness) with changes to deploy, so the
    // effect proceeds to handleDeploy. Individual tests override handleDeploy's result.
    mockReadProjectSpec.mockResolvedValue({ harnesses: [{ name: 'test-harness' }] });
    mockEnsureDefaultDeploymentTarget.mockResolvedValue(undefined);
    mockCanSkipDeploy.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls handleDeploy on mount', async () => {
    mockHandleDeploy.mockResolvedValue({ success: true });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(mockHandleDeploy).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'default',
          autoConfirm: true,
        })
      );
    });

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
    });
  });

  it('does not call handleDeploy when skip is true', async () => {
    const { lastFrame } = render(<Harness skip={true} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
    });

    expect(mockHandleDeploy).not.toHaveBeenCalled();
  });

  it('captures error from failed deploy', async () => {
    mockHandleDeploy.mockResolvedValue({ success: false, error: 'Stack failed' });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
      expect(lastFrame()).toContain('error:Stack failed');
    });
  });

  it('captures error from thrown exception', async () => {
    mockHandleDeploy.mockRejectedValue(new Error('Network error'));

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
      expect(lastFrame()).toContain('error:Network error');
    });
  });

  it('surfaces the managed-memory heads-up from the onNotice callback', async () => {
    mockHandleDeploy.mockImplementation((opts: { onNotice?: (message: string) => void }) => {
      opts.onNotice?.(TEST_MANAGED_MEMORY_NOTICE);
      return Promise.resolve({ success: true });
    });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('notice:Managed memory:');
      expect(lastFrame()).toContain('isComplete:true');
    });
  });

  it('does not let other onNotice messages clobber the managed-memory slot', async () => {
    mockHandleDeploy.mockImplementation((opts: { onNotice?: (message: string) => void }) => {
      opts.onNotice?.('Updated managed dependencies in agentcore/cdk/package.json:');
      return Promise.resolve({ success: true });
    });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
    });
    expect(lastFrame()).toContain('notice:null');
  });

  it('reads the dependency sync notice and warnings from the deploy result', async () => {
    mockHandleDeploy.mockResolvedValue({
      success: true,
      dependencySyncResult: {
        notice: 'dep-sync-notice',
        warnings: ['lodash (file:x) uses a non-semver specifier and was left unmanaged.'],
      },
    });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('depSyncNotice:dep-sync-notice');
      expect(lastFrame()).toContain('depSyncWarnings:1');
      expect(lastFrame()).toContain('isComplete:true');
    });
  });

  it('leaves the managed-memory heads-up null when onNotice is not called', async () => {
    mockHandleDeploy.mockResolvedValue({ success: true });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('isComplete:true');
    });
    expect(lastFrame()).toContain('notice:null');
  });

  it('populates steps from onProgress callback', async () => {
    mockHandleDeploy.mockImplementation((opts: { onProgress?: (step: string, status: string) => void }) => {
      opts.onProgress?.('Validate project', 'start');
      opts.onProgress?.('Validate project', 'success');
      opts.onProgress?.('Build CDK', 'start');
      opts.onProgress?.('Build CDK', 'success');
      return Promise.resolve({ success: true });
    });

    const { lastFrame } = render(<Harness />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('steps:2');
      expect(lastFrame()).toContain('isComplete:true');
    });
  });
});
