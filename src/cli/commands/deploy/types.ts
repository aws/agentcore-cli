export interface DeployOptions {
  target?: string;
  yes?: boolean;
  progress?: boolean;
  verbose?: boolean;
  json?: boolean;
  plan?: boolean;
}

export interface DeployResult {
  success: boolean;
  targetName?: string;
  stackName?: string;
  outputs?: Record<string, string>;
  logPath?: string;
  nextSteps?: string[];
  error?: string;
}

export interface PreflightResult {
  success: boolean;
  stackNames?: string[];
  needsBootstrap?: boolean;
  error?: string;
}
