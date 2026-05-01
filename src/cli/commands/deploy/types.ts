import type { Result } from '../../../lib/types';

export interface DeployOptions {
  target?: string;
  yes?: boolean;
  progress?: boolean;
  verbose?: boolean;
  json?: boolean;
  plan?: boolean;
  diff?: boolean;
}

export type DeployResult = Result<{
  targetName?: string;
  stackName?: string;
  outputs?: Record<string, string>;
  logPath?: string;
  nextSteps?: string[];
  notes?: string[];
  postDeployWarnings?: string[];
}> & { logPath?: string };

export type PreflightResult = Result;
