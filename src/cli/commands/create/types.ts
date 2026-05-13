import type { Result } from '../../../lib/result';
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
  withConfigBundle?: boolean;
  outputDir?: string;
  skipGit?: boolean;
  skipPythonSetup?: boolean;
  skipInstall?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export type CreateResult = Result<{
  projectPath?: string;
  agentName?: string;
  dryRun?: boolean;
  wouldCreate?: string[];
}> & { warnings?: string[] };
