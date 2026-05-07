// ─────────────────────────────────────────────────────────────────────────────
// AB Test Wizard Types
// ─────────────────────────────────────────────────────────────────────────────

export type ABTestMode = 'config-bundle' | 'target-based';

export type AddABTestStep =
  | 'mode'
  | 'name'
  | 'description'
  | 'agent'
  | 'gateway'
  | 'variants'
  | 'controlTarget'
  | 'treatmentTarget'
  | 'weights'
  | 'evalPath'
  | 'evalSelect'
  | 'evalCreate'
  | 'evalSamplingRate'
  | 'onlineEval'
  | 'maxDuration'
  | 'enableOnCreate'
  | 'confirm';

export type GatewayChoice = { type: 'create-new' } | { type: 'existing-http'; name: string };

/** Rich target info for target-based AB testing. */
export interface TargetInfo {
  name: string;
  runtimeRef: string;
  qualifier: string;
}

export interface AddABTestConfig {
  mode: ABTestMode;
  name: string;
  description: string;
  agent: string;
  gatewayChoice: GatewayChoice;
  // Config-bundle mode
  controlBundle: string;
  controlVersion: string;
  treatmentBundle: string;
  treatmentVersion: string;
  treatmentWeight: number;
  onlineEval: string;
  // Target-based mode fields
  gateway: string;
  gatewayIsNew: boolean;
  controlTargetInfo: TargetInfo | null;
  controlTargetIsNew: boolean;
  treatmentTargetInfo: TargetInfo | null;
  treatmentTargetIsNew: boolean;
  // Legacy target-based fields (populated from TargetInfo for downstream compatibility)
  runtime: string;
  controlTarget: string;
  controlEndpoint: string;
  treatmentTarget: string;
  treatmentEndpoint: string;
  controlWeight: number;
  controlOnlineEval: string;
  treatmentOnlineEval: string;
  evaluators: string[];
  samplingRate: number;
  // Shared
  maxDuration: number | undefined;
  enableOnCreate: boolean;
}

export const AB_TEST_STEP_LABELS: Record<AddABTestStep, string> = {
  mode: 'Mode',
  name: 'Name',
  description: 'Description',
  agent: 'Agent',
  gateway: 'Gateway',
  variants: 'Variants',
  controlTarget: 'Control',
  treatmentTarget: 'Treatment',
  weights: 'Weights',
  evalPath: 'Eval',
  evalSelect: 'Eval',
  evalCreate: 'Eval',
  evalSamplingRate: 'Eval',
  onlineEval: 'Eval',
  maxDuration: 'Duration',
  enableOnCreate: 'Enable',
  confirm: 'Confirm',
};
