export type ExportHarnessStep = 'select-harness' | 'target-name' | 'build-type' | 'confirm';

export interface ExportHarnessConfig {
  harness: string;
  targetAgentName: string;
  build: 'CodeZip' | 'Container';
}

export const EXPORT_HARNESS_STEP_LABELS: Record<ExportHarnessStep, string> = {
  'select-harness': 'Select harness',
  'target-name': 'Agent name',
  'build-type': 'Build type',
  confirm: 'Confirm',
};
