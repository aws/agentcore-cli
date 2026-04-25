import type { VpcOptions } from '../shared/vpc-utils';

export interface CreateOptions extends VpcOptions {
  name?: string;
  projectName?: string;
  agent?: boolean;
  defaults?: boolean;
  type?: string;
  build?: string;
  language?: string;
  framework?: string;
  modelProvider?: string;
  apiKey?: string;
  memory?: string;
  protocol?: string;
  agentId?: string;
  agentAliasId?: string;
  region?: string;
  idleTimeout?: number | string;
  maxLifetime?: number | string;
  sessionStorageMountPath?: string;
  outputDir?: string;
  skipGit?: boolean;
  skipPythonSetup?: boolean;
  skipInstall?: boolean;
  dryRun?: boolean;
  json?: boolean;
  // Harness-specific
  modelId?: string;
  apiKeyArn?: string;
  container?: string;
  harnessMemory?: boolean;
  maxIterations?: string;
  maxTokens?: string;
  timeout?: string;
  truncationStrategy?: string;
}

export interface CreateResult {
  success: boolean;
  projectPath?: string;
  agentName?: string;
  error?: string;
  dryRun?: boolean;
  wouldCreate?: string[];
  warnings?: string[];
}
