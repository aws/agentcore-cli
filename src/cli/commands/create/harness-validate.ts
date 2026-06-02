import { MAX_EFS_MOUNTS, MAX_S3_MOUNTS } from '../../../schema';
import { HarnessNameSchema, ProjectNameSchema } from '../../../schema';
import {
  validateAccessPointMounts,
  validateEfsAccessPointArn,
  validateS3FilesAccessPointArn,
  zipAccessPointPairs,
} from '../shared/filesystem-utils';
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
  sessionStorageMountPath?: string;
  efsAccessPointArn?: string[];
  efsMountPath?: string[];
  s3AccessPointArn?: string[];
  s3MountPath?: string[];
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

  // Validate EFS access point ARN/path pairs
  const efsArns = options.efsAccessPointArn ?? [];
  const efsPaths = options.efsMountPath ?? [];
  if (efsArns.length > 0 || efsPaths.length > 0) {
    const efsPairsResult = zipAccessPointPairs(efsArns, efsPaths, 'EFS');
    if (!efsPairsResult.success) return { valid: false, error: efsPairsResult.error };
    const efsValidation = validateAccessPointMounts(efsPairsResult.mounts, validateEfsAccessPointArn);
    if (!efsValidation.success) return { valid: false, error: efsValidation.error };
    if (efsArns.length > MAX_EFS_MOUNTS) {
      return { valid: false, error: `Maximum ${MAX_EFS_MOUNTS} EFS mounts allowed (got ${efsArns.length})` };
    }
    if (options.networkMode !== 'VPC') {
      return {
        valid: false,
        error:
          'EFS filesystem mounts require VPC network mode. Add --network-mode VPC --subnets <ids> --security-groups <ids>.',
      };
    }
  }

  // Validate S3 Files access point ARN/path pairs
  const s3Arns = options.s3AccessPointArn ?? [];
  const s3Paths = options.s3MountPath ?? [];
  if (s3Arns.length > 0 || s3Paths.length > 0) {
    const s3PairsResult = zipAccessPointPairs(s3Arns, s3Paths, 'S3 Files');
    if (!s3PairsResult.success) return { valid: false, error: s3PairsResult.error };
    const s3Validation = validateAccessPointMounts(s3PairsResult.mounts, validateS3FilesAccessPointArn);
    if (!s3Validation.success) return { valid: false, error: s3Validation.error };
    if (s3Arns.length > MAX_S3_MOUNTS) {
      return { valid: false, error: `Maximum ${MAX_S3_MOUNTS} S3 Files mounts allowed (got ${s3Arns.length})` };
    }
    if (options.networkMode !== 'VPC') {
      return {
        valid: false,
        error:
          'S3 Files filesystem mounts require VPC network mode. Add --network-mode VPC --subnets <ids> --security-groups <ids>.',
      };
    }
  }

  return { valid: true };
}
