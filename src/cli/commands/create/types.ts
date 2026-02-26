export interface CreateOptions {
  name?: string;
  agent?: boolean;
  defaults?: boolean;
  build?: string;
  language?: string;
  framework?: string;
  modelProvider?: string;
  apiKey?: string;
  memory?: string;
  outputDir?: string;
  skipGit?: boolean;
  skipPythonSetup?: boolean;
  dryRun?: boolean;
  json?: boolean;
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
