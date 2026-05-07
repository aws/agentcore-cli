export interface DeployOptions {
  target?: string;
  yes?: boolean;
  progress?: boolean;
  verbose?: boolean;
  json?: boolean;
  plan?: boolean;
  diff?: boolean;
  /**
   * If set, attempt to recover stacks stuck in `REVIEW_IN_PROGRESS` (caused
   * by a prior failed CloudFormation early-validation) by deleting them
   * before deployment proceeds. See
   * https://github.com/aws/agentcore-cli/issues/907.
   */
  recover?: boolean;
}

export interface DeployResult {
  success: boolean;
  targetName?: string;
  stackName?: string;
  outputs?: Record<string, string>;
  logPath?: string;
  nextSteps?: string[];
  notes?: string[];
  postDeployWarnings?: string[];
  error?: string;
}

export interface PreflightResult {
  success: boolean;
  stackNames?: string[];
  needsBootstrap?: boolean;
  error?: string;
}
