import type { ABTestMode } from '../../../operations/jobs';

/** Wizard step ids for the run-as-job A/B test flow. */
export type RunABTestStep = 'mode' | 'gateway' | 'control' | 'treatment' | 'onlineEval' | 'filter' | 'name' | 'confirm';

export interface RunABTestConfig {
  mode: ABTestMode;
  name: string;
  gateway: string;
  // config-bundle mode
  controlBundle: string;
  controlVersion: string;
  treatmentBundle: string;
  treatmentVersion: string;
  // target-based mode
  controlTarget: string;
  treatmentTarget: string;
  runtime: string;
  // eval configs
  onlineEval: string;
  controlOnlineEval: string;
  treatmentOnlineEval: string;
  // shared
  controlWeight: number;
  treatmentWeight: number;
  /** Single gateway target path pattern; blank means no gateway filter. Applies to both modes. */
  gatewayFilter: string;
}

/** Deployed resource lists loaded once for the wizard's pickers. */
export interface ABTestResources {
  gateways: string[];
  bundles: { name: string; bundleId: string }[];
  targets: string[];
  runtimes: string[];
  onlineEvalConfigs: string[];
}
