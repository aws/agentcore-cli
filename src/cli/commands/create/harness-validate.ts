import { HarnessNameSchema, ProjectNameSchema } from '../../../schema';
import { validateFolderNotExists } from './validate';

export interface CreateHarnessCliOptions {
  name?: string;
  projectName?: string;
  modelProvider?: string;
  modelId?: string;
  apiKeyArn?: string;
  container?: string;
  noMemory?: boolean;
  maxIterations?: string;
  maxTokens?: string;
  timeout?: string;
  truncationStrategy?: string;
  networkMode?: string;
  subnets?: string;
  securityGroups?: string;
  idleTimeout?: string;
  maxLifetime?: string;
  outputDir?: string;
  skipGit?: boolean;
  skipInstall?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const MODEL_PROVIDER_MAPPING: Record<string, string> = {
  bedrock: 'bedrock',
  Bedrock: 'bedrock',
  open_ai: 'open_ai',
  openai: 'open_ai',
  OpenAI: 'open_ai',
  anthropic: 'bedrock',
  Anthropic: 'bedrock',
  gemini: 'gemini',
  Gemini: 'gemini',
};

export function normalizeHarnessModelProvider(raw: string): string | undefined {
  return MODEL_PROVIDER_MAPPING[raw];
}

export function validateCreateHarnessOptions(options: CreateHarnessCliOptions, cwd?: string): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  const projectName = options.projectName ?? options.name;
  const projectNameResult = ProjectNameSchema.safeParse(projectName);
  if (!projectNameResult.success) {
    return { valid: false, error: projectNameResult.error.issues[0]?.message ?? 'Invalid project name' };
  }

  const nameResult = HarnessNameSchema.safeParse(options.name);
  if (!nameResult.success) {
    return { valid: false, error: nameResult.error.issues[0]?.message ?? 'Invalid harness name' };
  }

  const folderCheck = validateFolderNotExists(projectName, cwd ?? process.cwd());
  if (folderCheck !== true) {
    return { valid: false, error: folderCheck };
  }

  if (options.modelProvider) {
    const normalized = normalizeHarnessModelProvider(options.modelProvider);
    if (!normalized) {
      return {
        valid: false,
        error: `Invalid model provider: ${options.modelProvider}. Use bedrock, open_ai, or gemini`,
      };
    }
    options.modelProvider = normalized;
  }
  options.modelProvider ??= 'bedrock';

  const defaultModelIds: Record<string, string> = {
    bedrock: 'global.anthropic.claude-sonnet-4-6',
    open_ai: 'gpt-5',
    gemini: 'gemini-2.5-flash',
  };
  options.modelId ??= defaultModelIds[options.modelProvider] ?? 'global.anthropic.claude-sonnet-4-6';

  if (options.modelProvider !== 'bedrock' && !options.apiKeyArn) {
    return { valid: false, error: `--api-key-arn is required for ${options.modelProvider} provider` };
  }

  return { valid: true };
}
