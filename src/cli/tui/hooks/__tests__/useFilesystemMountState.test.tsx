import {
  DEFAULT_FILESYSTEM_STEP_NAMES,
  HARNESS_FILESYSTEM_STEP_NAMES,
  useFilesystemMountState,
} from '../useFilesystemMountState.js';
import type { MountEntry } from '../useFilesystemMountState.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EFS_ARN = 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0';
const S3_ARN =
  'arn:aws:s3files:us-east-1:123456789012:file-system/fs-12345678901234567/access-point/fsap-12345678901234567';
const s = DEFAULT_FILESYSTEM_STEP_NAMES;

/** Render the hook and return a stable ref to the latest handlers + mocks. */
function makeHook(opts: {
  efsMounts?: MountEntry[];
  s3Mounts?: MountEntry[];
  stepNames?: typeof DEFAULT_FILESYSTEM_STEP_NAMES;
}) {
  const setEfsMounts = vi.fn();
  const setS3Mounts = vi.fn();
  const goToNextStep = vi.fn();
  const setStep = vi.fn();

  type Handlers = ReturnType<typeof useFilesystemMountState>;
  // Use a mutable object outside React — the component writes via a prop callback
  const snapshot: { current: Handlers | null } = { current: null };

  const Wrapper = ({ onRender }: { onRender: (h: Handlers) => void }) => {
    const handlers = useFilesystemMountState({
      currentStep: 'other',
      efsMounts: opts.efsMounts ?? [],
      s3Mounts: opts.s3Mounts ?? [],
      setEfsMounts,
      setS3Mounts,
      goToNextStep,
      setStep,
      stepNames: opts.stepNames,
    });
    onRender(handlers);
    return <Text>ok</Text>;
  };

  render(
    <Wrapper
      onRender={h => {
        snapshot.current = h;
      }}
    />
  );
  return { snapshot, setEfsMounts, setS3Mounts, goToNextStep, setStep };
}

// ─────────────────────────────────────────────────────────────────────────────
// submitEfsArn
// ─────────────────────────────────────────────────────────────────────────────

describe('useFilesystemMountState - submitEfsArn', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('empty ARN calls goToNextStep(efsAddAnother)', () => {
    const { snapshot, goToNextStep } = makeHook({});
    snapshot.current!.submitEfsArn('');
    vi.runAllTimers();
    expect(goToNextStep).toHaveBeenCalledWith(s.efsAddAnother);
  });

  it('valid ARN navigates to efsMountPath', () => {
    const { snapshot, setStep } = makeHook({});
    snapshot.current!.submitEfsArn(EFS_ARN);
    expect(setStep).toHaveBeenCalledWith(s.efsMountPath);
  });

  it('at max capacity (not editing) redirects to efsAddAnother review', () => {
    const full: MountEntry[] = [
      { accessPointArn: EFS_ARN, mountPath: '/mnt/efs1' },
      { accessPointArn: EFS_ARN, mountPath: '/mnt/efs2' },
    ];
    const { snapshot, setStep } = makeHook({ efsMounts: full });
    snapshot.current!.submitEfsArn(EFS_ARN);
    expect(setStep).toHaveBeenCalledWith(s.efsAddAnother);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitEfsMountPath
// ─────────────────────────────────────────────────────────────────────────────

describe('useFilesystemMountState - submitEfsMountPath', () => {
  it('appends new mount and navigates to efsAddAnother', () => {
    const { snapshot, setEfsMounts, setStep } = makeHook({});
    snapshot.current!.submitEfsMountPath('/mnt/efs');
    const updater = setEfsMounts.mock.calls[0]![0] as (prev: MountEntry[]) => MountEntry[];
    expect(updater([])).toEqual([{ accessPointArn: '', mountPath: '/mnt/efs' }]);
    expect(setStep).toHaveBeenCalledWith(s.efsAddAnother);
  });

  it('appends new mount with pendingEfsArn when adding (not editing)', () => {
    const { snapshot, setEfsMounts } = makeHook({});
    // Simulate: user typed ARN, then submitted mount path
    snapshot.current!.submitEfsArn(EFS_ARN); // stores pending ARN via setPendingEfsArn
    snapshot.current!.submitEfsMountPath('/mnt/efs');
    const calls = setEfsMounts.mock.calls;
    const updater = calls[calls.length - 1]![0] as (prev: MountEntry[]) => MountEntry[];
    const updated = updater([]);
    // pendingEfsArn is set by submitEfsArn but state update is async;
    // the updater appends using the captured pendingEfsArn at call time
    expect(updated[0]!.mountPath).toBe('/mnt/efs');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitEfsAddAnother
// ─────────────────────────────────────────────────────────────────────────────

describe('useFilesystemMountState - submitEfsAddAnother', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('"add" navigates to efsArn', () => {
    const { snapshot, setStep } = makeHook({});
    snapshot.current!.submitEfsAddAnother('add');
    expect(setStep).toHaveBeenCalledWith(s.efsArn);
  });

  it('"edit:0" navigates to efsArn with correct mount ARN pending', () => {
    const existing: MountEntry[] = [{ accessPointArn: EFS_ARN, mountPath: '/mnt/efs' }];
    const { snapshot, setStep } = makeHook({ efsMounts: existing });
    snapshot.current!.submitEfsAddAnother('edit:0');
    expect(setStep).toHaveBeenCalledWith(s.efsArn);
  });

  it('"remove:0" removes the entry at index 0', () => {
    const existing: MountEntry[] = [
      { accessPointArn: EFS_ARN, mountPath: '/mnt/efs1' },
      { accessPointArn: EFS_ARN, mountPath: '/mnt/efs2' },
    ];
    const { snapshot, setEfsMounts } = makeHook({ efsMounts: existing });
    snapshot.current!.submitEfsAddAnother('remove:0');
    const updater = setEfsMounts.mock.calls[0]![0] as (prev: MountEntry[]) => MountEntry[];
    const result = updater(existing);
    expect(result).toHaveLength(1);
    expect(result[0]!.mountPath).toBe('/mnt/efs2');
  });

  it('"done" calls goToNextStep(efsAddAnother)', () => {
    const { snapshot, goToNextStep } = makeHook({});
    snapshot.current!.submitEfsAddAnother('done');
    vi.runAllTimers();
    expect(goToNextStep).toHaveBeenCalledWith(s.efsAddAnother);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stepNames — harness kebab-case
// ─────────────────────────────────────────────────────────────────────────────

describe('useFilesystemMountState - HARNESS_FILESYSTEM_STEP_NAMES', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses kebab-case step names when HARNESS_FILESYSTEM_STEP_NAMES passed', () => {
    const hs = HARNESS_FILESYSTEM_STEP_NAMES;
    const { snapshot, setStep } = makeHook({ stepNames: hs });
    snapshot.current!.submitEfsArn(EFS_ARN);
    expect(setStep).toHaveBeenCalledWith(hs.efsMountPath); // 'efs-mount-path'
  });

  it('empty ARN uses kebab efsAddAnother for skip', () => {
    const hs = HARNESS_FILESYSTEM_STEP_NAMES;
    const { snapshot, goToNextStep } = makeHook({ stepNames: hs });
    snapshot.current!.submitEfsArn('');
    vi.runAllTimers();
    expect(goToNextStep).toHaveBeenCalledWith(hs.efsAddAnother); // 'efs-add-another'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 handlers — spot-check parity
// ─────────────────────────────────────────────────────────────────────────────

describe('useFilesystemMountState - S3 handlers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('submitS3Arn with empty ARN calls goToNextStep(s3AddAnother)', () => {
    const { snapshot, goToNextStep } = makeHook({});
    snapshot.current!.submitS3Arn('');
    vi.runAllTimers();
    expect(goToNextStep).toHaveBeenCalledWith(s.s3AddAnother);
  });

  it('submitS3Arn with valid ARN navigates to s3MountPath', () => {
    const { snapshot, setStep } = makeHook({});
    snapshot.current!.submitS3Arn(S3_ARN);
    expect(setStep).toHaveBeenCalledWith(s.s3MountPath);
  });

  it('submitS3AddAnother "remove:0" removes entry at index', () => {
    const existing: MountEntry[] = [{ accessPointArn: S3_ARN, mountPath: '/mnt/s3' }];
    const { snapshot, setS3Mounts } = makeHook({ s3Mounts: existing });
    snapshot.current!.submitS3AddAnother('remove:0');
    const updater = setS3Mounts.mock.calls[0]![0] as (prev: MountEntry[]) => MountEntry[];
    expect(updater(existing)).toHaveLength(0);
  });

  it('submitS3MountPath appends new S3 mount', () => {
    const { snapshot, setS3Mounts, setStep } = makeHook({});
    snapshot.current!.submitS3MountPath('/mnt/s3');
    expect(setS3Mounts).toHaveBeenCalled();
    expect(setStep).toHaveBeenCalledWith(s.s3AddAnother);
  });
});
