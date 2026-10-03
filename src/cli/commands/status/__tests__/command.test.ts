import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { handleProjectStatus, loadStatusConfig } from '../action.js';
import { registerStatus } from '../command.js';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRender } = vi.hoisted(() => ({
  mockRender: vi.fn(),
}));

vi.mock('../../../tui/guards', () => ({
  requireProject: vi.fn(),
}));

vi.mock('../../../telemetry/cli-command-run.js', () => ({
  withCommandRunTelemetry: vi.fn((_command, _attrs, run) => run()),
}));

vi.mock('../../../operations/dataset', () => ({
  getDatasetStatus: vi.fn(),
}));

vi.mock('../action.js', () => ({
  handleProjectStatus: vi.fn(),
  handleRuntimeLookup: vi.fn(),
  loadStatusConfig: vi.fn(),
}));

vi.mock('../../../feature-flags', () => ({
  isPreviewEnabled: () => false,
}));

vi.mock('ink', () => ({
  Box: ({ children }: { children?: unknown }) => children,
  Text: ({ children }: { children?: unknown }) => children,
  render: mockRender,
}));

describe('status command validation', () => {
  let program: Command;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    program = new Command();
    program.exitOverride();
    registerStatus(program);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.clearAllMocks();
  });

  it('sets a non-zero exit code for invalid resource type', async () => {
    await program.parseAsync(['status', '--type', 'bogus'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(mockRender).toHaveBeenCalled();
  });

  it('sets a non-zero exit code for invalid state', async () => {
    await program.parseAsync(['status', '--state', 'bogus'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(mockRender).toHaveBeenCalled();
  });

  it('leaves exit code unset for a valid filter', async () => {
    vi.mocked(loadStatusConfig).mockResolvedValue({} as never);
    vi.mocked(handleProjectStatus).mockResolvedValue({ success: true, resources: [] } as never);

    await program.parseAsync(['status', '--type', 'agent'], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
  });

  it('records AWS identity telemetry when the credentials do not match the target account', async () => {
    const recorder = { set: vi.fn(), get: vi.fn() };
    vi.mocked(withCommandRunTelemetry).mockImplementationOnce(async (_command, _attrs, run) => run(recorder as never));
    vi.mocked(loadStatusConfig).mockResolvedValue({} as never);
    vi.mocked(handleProjectStatus).mockResolvedValue({
      success: true,
      resources: [],
      targetAccount: '222222222222',
      awsIdentity: { success: true, account: '111111111111' },
    } as never);

    await program.parseAsync(['status'], { from: 'user' });

    expect(recorder.set).toHaveBeenCalledWith({ has_aws_credentials: true, aws_account_mismatch: true });
  });

  it('records missing AWS credentials in telemetry', async () => {
    const recorder = { set: vi.fn(), get: vi.fn() };
    vi.mocked(withCommandRunTelemetry).mockImplementationOnce(async (_command, _attrs, run) => run(recorder as never));
    vi.mocked(loadStatusConfig).mockResolvedValue({} as never);
    vi.mocked(handleProjectStatus).mockResolvedValue({
      success: true,
      resources: [],
      awsIdentity: { success: false, error: 'No AWS credentials found.' },
    } as never);

    await program.parseAsync(['status'], { from: 'user' });

    expect(recorder.set).toHaveBeenCalledWith({ has_aws_credentials: false, aws_account_mismatch: false });
  });
});
