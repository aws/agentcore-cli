import {
  BuildTypeSchema,
  ModelProviderSchema,
  ProjectNameSchema,
  SDKFrameworkSchema,
  TargetLanguageSchema,
  getSupportedModelProviders,
} from '../../../schema';
import type { CreateOptions } from './types';
import { existsSync } from 'fs';
import { join } from 'path';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const MEMORY_OPTIONS = ['none', 'shortTerm', 'longAndShortTerm'] as const;

/** Check if a folder with the given name already exists in the directory */
export function validateFolderNotExists(name: string, cwd: string): true | string {
  const projectPath = join(cwd, name);

  if (existsSync(projectPath)) {
    return `A folder named '${name}' already exists in this directory`;
  }
  return true;
}

export function validateCreateOptions(options: CreateOptions, cwd?: string): ValidationResult {
  // Name is required for non-interactive mode
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  // Validate name format
  const nameResult = ProjectNameSchema.safeParse(options.name);
  if (!nameResult.success) {
    return { valid: false, error: nameResult.error.issues[0]?.message ?? 'Invalid project name' };
  }

  // Check if directory already exists
  const folderCheck = validateFolderNotExists(options.name, cwd ?? process.cwd());
  if (folderCheck !== true) {
    return { valid: false, error: folderCheck };
  }

  // If --no-agent (agent === false), no further validation needed
  if (options.agent === false) {
    return { valid: true };
  }

  // Validate build type if provided
  if (options.build) {
    const buildResult = BuildTypeSchema.safeParse(options.build);
    if (!buildResult.success) {
      return { valid: false, error: `Invalid build type: ${options.build}. Use CodeZip or Container` };
    }
  }

  // Without --no-agent, all agent options are required
  const hasAllAgentOptions = options.framework && options.modelProvider && options.memory;

  if (!hasAllAgentOptions) {
    return {
      valid: false,
      error: 'Use --no-agent for project-only, or provide all: --framework, --model-provider, --memory',
    };
  }

  // Validate all agent options
  {
    if (!options.language) {
      return { valid: false, error: '--language is required when creating an agent' };
    }
    if (!options.framework) {
      return { valid: false, error: '--framework is required when creating an agent' };
    }
    if (!options.modelProvider) {
      return { valid: false, error: '--model-provider is required when creating an agent' };
    }
    if (!options.memory) {
      return { valid: false, error: '--memory is required when creating an agent' };
    }

    // Validate language
    const langResult = TargetLanguageSchema.safeParse(options.language);
    if (!langResult.success) {
      return { valid: false, error: `Invalid language: ${options.language}. Use Python` };
    }

    // Validate framework
    const fwResult = SDKFrameworkSchema.safeParse(options.framework);
    if (!fwResult.success) {
      return { valid: false, error: `Invalid framework: ${options.framework}` };
    }

    // Validate model provider
    const mpResult = ModelProviderSchema.safeParse(options.modelProvider);
    if (!mpResult.success) {
      return { valid: false, error: `Invalid model provider: ${options.modelProvider}` };
    }

    // Validate language is supported
    if (options.language === 'TypeScript') {
      return { valid: false, error: 'TypeScript is not yet supported. Currently supported: Python' };
    }

    // Validate framework/model compatibility
    const supportedProviders = getSupportedModelProviders(fwResult.data);
    if (!supportedProviders.includes(mpResult.data)) {
      return { valid: false, error: `${options.framework} does not support ${options.modelProvider}` };
    }

    // Validate memory option
    if (!MEMORY_OPTIONS.includes(options.memory as (typeof MEMORY_OPTIONS)[number])) {
      return {
        valid: false,
        error: `Invalid memory option: ${options.memory}. Use none, shortTerm, or longAndShortTerm`,
      };
    }
  }

  return { valid: true };
}
