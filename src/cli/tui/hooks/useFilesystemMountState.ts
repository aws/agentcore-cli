import { MAX_EFS_MOUNTS, MAX_S3_MOUNTS } from '../../../schema';
import { useCallback, useEffect, useState } from 'react';

export interface MountEntry {
  accessPointArn: string;
  mountPath: string;
}

export interface FilesystemMountHandlers {
  pendingEfsArn: string;
  pendingS3Arn: string;
  editingEfsIndex: number;
  editingS3Index: number;
  addingNewEfs: boolean;
  addingNewS3: boolean;
  submitEfsArn: (arn: string) => void;
  submitEfsMountPath: (mountPath: string) => void;
  submitEfsAddAnother: (action: string) => void;
  submitS3Arn: (arn: string) => void;
  submitS3MountPath: (mountPath: string) => void;
  submitS3AddAnother: (action: string) => void;
  resetFilesystemState: () => void;
}

export interface FilesystemStepNames {
  efsArn: string;
  efsMountPath: string;
  efsAddAnother: string;
  s3Arn: string;
  s3MountPath: string;
  s3AddAnother: string;
}

/** Default step names used by useGenerateWizard and AddAgentScreen (camelCase). */
export const DEFAULT_FILESYSTEM_STEP_NAMES: FilesystemStepNames = {
  efsArn: 'efsArn',
  efsMountPath: 'efsMountPath',
  efsAddAnother: 'efsAddAnother',
  s3Arn: 's3Arn',
  s3MountPath: 's3MountPath',
  s3AddAnother: 's3AddAnother',
};

/** Kebab-case step names used by the harness wizard. */
export const HARNESS_FILESYSTEM_STEP_NAMES: FilesystemStepNames = {
  efsArn: 'efs-arn',
  efsMountPath: 'efs-mount-path',
  efsAddAnother: 'efs-add-another',
  s3Arn: 's3-arn',
  s3MountPath: 's3-mount-path',
  s3AddAnother: 's3-add-another',
};

interface FilesystemMountStateOptions {
  /** Current step name — used to trigger auto-redirect effects. */
  currentStep: string;
  efsMounts: MountEntry[];
  s3Mounts: MountEntry[];
  setEfsMounts: (updater: (prev: MountEntry[]) => MountEntry[]) => void;
  setS3Mounts: (updater: (prev: MountEntry[]) => MountEntry[]) => void;
  goToNextStep: (afterStep: string) => void;
  setStep: (step: string) => void;
  /** Override step names — defaults to camelCase (generate/BYO wizard). Use HARNESS_FILESYSTEM_STEP_NAMES for harness. */
  stepNames?: FilesystemStepNames;
}

/**
 * Shared filesystem mount state and handlers for EFS/S3 two-step ARN→path entry flows.
 * Used by both useGenerateWizard (create path) and AddAgentScreen (BYO path).
 */
export function useFilesystemMountState({
  currentStep,
  efsMounts,
  s3Mounts,
  setEfsMounts,
  setS3Mounts,
  goToNextStep,
  setStep,
  stepNames = DEFAULT_FILESYSTEM_STEP_NAMES,
}: FilesystemMountStateOptions): FilesystemMountHandlers {
  const s = stepNames;
  const [pendingEfsArn, setPendingEfsArn] = useState('');
  const [pendingS3Arn, setPendingS3Arn] = useState('');
  const [editingEfsIndex, setEditingEfsIndex] = useState(-1);
  const [editingS3Index, setEditingS3Index] = useState(-1);
  const [addingNewEfs, setAddingNewEfs] = useState(false);
  const [addingNewS3, setAddingNewS3] = useState(false);

  // Auto-redirect efsArn to review screen when mounts exist (unless actively adding/editing)
  useEffect(() => {
    if (currentStep === s.efsArn && editingEfsIndex < 0 && !addingNewEfs && efsMounts.length > 0) {
      setTimeout(() => setStep(s.efsAddAnother), 0);
    }
  }, [currentStep, editingEfsIndex, addingNewEfs, efsMounts, setStep, s.efsArn, s.efsAddAnother]);

  // Auto-redirect s3Arn to review screen when mounts exist (unless actively adding/editing)
  useEffect(() => {
    if (currentStep === s.s3Arn && editingS3Index < 0 && !addingNewS3 && s3Mounts.length > 0) {
      setTimeout(() => setStep(s.s3AddAnother), 0);
    }
  }, [currentStep, editingS3Index, addingNewS3, s3Mounts, setStep, s.s3Arn, s.s3AddAnother]);

  const submitEfsArn = useCallback(
    (arn: string) => {
      setAddingNewEfs(false);
      if (!arn) {
        setEditingEfsIndex(-1);
        setTimeout(() => goToNextStep(s.efsAddAnother), 0);
      } else if (editingEfsIndex < 0 && efsMounts.length >= MAX_EFS_MOUNTS) {
        setStep(s.efsAddAnother);
      } else {
        setPendingEfsArn(arn);
        setStep(s.efsMountPath);
      }
    },
    [goToNextStep, efsMounts.length, editingEfsIndex, setStep, s]
  );

  const submitEfsMountPath = useCallback(
    (mountPath: string) => {
      const idx = editingEfsIndex;
      setEfsMounts(prev => {
        const updated =
          idx >= 0
            ? prev.map((p, i) => (i === idx ? { accessPointArn: pendingEfsArn, mountPath } : p))
            : [...prev, { accessPointArn: pendingEfsArn, mountPath }];
        return updated;
      });
      setPendingEfsArn('');
      setEditingEfsIndex(-1);
      setStep(s.efsAddAnother);
    },
    [pendingEfsArn, editingEfsIndex, setEfsMounts, setStep, s]
  );

  const submitEfsAddAnother = useCallback(
    (action: string) => {
      if (action === 'add') {
        setEditingEfsIndex(-1);
        setAddingNewEfs(true);
        setStep(s.efsArn);
      } else if (action.startsWith('edit:')) {
        const idx = Number(action.slice(5));
        const mount = efsMounts[idx];
        if (mount) {
          setEditingEfsIndex(idx);
          setPendingEfsArn(mount.accessPointArn);
          setStep(s.efsArn);
        }
      } else if (action.startsWith('remove:')) {
        const idx = Number(action.slice(7));
        setEfsMounts(prev => prev.filter((_, i) => i !== idx));
      } else {
        setTimeout(() => goToNextStep(s.efsAddAnother), 0);
      }
    },
    [goToNextStep, efsMounts, setEfsMounts, setStep, s]
  );

  const submitS3Arn = useCallback(
    (arn: string) => {
      setAddingNewS3(false);
      if (!arn) {
        setEditingS3Index(-1);
        setTimeout(() => goToNextStep(s.s3AddAnother), 0);
      } else if (editingS3Index < 0 && s3Mounts.length >= MAX_S3_MOUNTS) {
        setStep(s.s3AddAnother);
      } else {
        setPendingS3Arn(arn);
        setStep(s.s3MountPath);
      }
    },
    [goToNextStep, s3Mounts.length, editingS3Index, setStep, s]
  );

  const submitS3MountPath = useCallback(
    (mountPath: string) => {
      const idx = editingS3Index;
      setS3Mounts(prev => {
        const updated =
          idx >= 0
            ? prev.map((p, i) => (i === idx ? { accessPointArn: pendingS3Arn, mountPath } : p))
            : [...prev, { accessPointArn: pendingS3Arn, mountPath }];
        return updated;
      });
      setPendingS3Arn('');
      setEditingS3Index(-1);
      setStep(s.s3AddAnother);
    },
    [pendingS3Arn, editingS3Index, setS3Mounts, setStep, s]
  );

  const submitS3AddAnother = useCallback(
    (action: string) => {
      if (action === 'add') {
        setEditingS3Index(-1);
        setAddingNewS3(true);
        setStep(s.s3Arn);
      } else if (action.startsWith('edit:')) {
        const idx = Number(action.slice(5));
        const mount = s3Mounts[idx];
        if (mount) {
          setEditingS3Index(idx);
          setPendingS3Arn(mount.accessPointArn);
          setStep(s.s3Arn);
        }
      } else if (action.startsWith('remove:')) {
        const idx = Number(action.slice(7));
        setS3Mounts(prev => prev.filter((_, i) => i !== idx));
      } else {
        setTimeout(() => goToNextStep(s.s3AddAnother), 0);
      }
    },
    [goToNextStep, s3Mounts, setS3Mounts, setStep, s]
  );

  const resetFilesystemState = useCallback(() => {
    setPendingEfsArn('');
    setPendingS3Arn('');
    setEditingEfsIndex(-1);
    setEditingS3Index(-1);
    setAddingNewEfs(false);
    setAddingNewS3(false);
  }, []);

  return {
    pendingEfsArn,
    pendingS3Arn,
    editingEfsIndex,
    editingS3Index,
    addingNewEfs,
    addingNewS3,
    submitEfsArn,
    submitEfsMountPath,
    submitEfsAddAnother,
    submitS3Arn,
    submitS3MountPath,
    submitS3AddAnother,
    resetFilesystemState,
  };
}
