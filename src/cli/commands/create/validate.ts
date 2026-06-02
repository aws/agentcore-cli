import {
  AgentNameSchema,
  BuildTypeSchema,
  MAX_EFS_MOUNTS,
  MAX_S3_MOUNTS,
  ModelProviderSchema,
  ProjectNameSchema,
  ProtocolModeSchema,
  SDKFrameworkSchema,
  SessionStorageSchema,
  TargetLanguageSchema,
  getSupportedFrameworksForProtocol,
  getSupportedModelProviders,
  matchEnumValue,
} from '../../../schema';
import type { ProtocolMode } from '../../../schema';
import {
  validateAccessPointMounts,
  validateEfsAccessPointArn,
  validateS3FilesAccessPointArn,
  zipAccessPointPairs,
} from '../shared/filesystem-utils';
import { parseAndValidateLifecycleOptions } from '../shared/lifecycle-utils';
import { validateVpcOptions } from '../shared/vpc-utils';
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
  if (!options.name && !(options.agent === false && options.projectName)) {
    return { valid: false, error: '--name is required' };
  }

  const projectName = options.projectName ?? options.name!;

  // Validate project name format
  const projectNameResult = ProjectNameSchema.safeParse(projectName);
  if (!projectNameResult.success) {
    return { valid: false, error: projectNameResult.error.issues[0]?.message ?? 'Invalid project name' };
  }

  // Check if directory already exists
  const folderCheck = validateFolderNotExists(projectName, cwd ?? process.cwd());
  if (folderCheck !== true) {
    return { valid: false, error: folderCheck };
  }

  // If --no-agent (agent === false), no further validation needed
  if (options.agent === false) {
    return { valid: true };
  }

  const agentNameResult = AgentNameSchema.safeParse(options.name);
  if (!agentNameResult.success) {
    return { valid: false, error: agentNameResult.error.issues[0]?.message ?? 'Invalid agent name' };
  }

  // Import path: validate import-specific options
  if (options.type === 'import') {
    if (!options.agentId) return { valid: false, error: '--agent-id is required for import' };
    if (!options.agentAliasId) return { valid: false, error: '--agent-alias-id is required for import' };
    if (!options.region) return { valid: false, error: '--region is required for import' };
    if (!options.framework)
      return { valid: false, error: '--framework is required for import (Strands or LangChain_LangGraph)' };
    const fw = matchEnumValue(SDKFrameworkSchema, options.framework) ?? options.framework;
    options.framework = fw;
    if (fw !== 'Strands' && fw !== 'LangChain_LangGraph') {
      return { valid: false, error: `Import only supports Strands or LangChain_LangGraph, got: ${options.framework}` };
    }
    options.memory ??= 'none';
    if (!MEMORY_OPTIONS.includes(options.memory as (typeof MEMORY_OPTIONS)[number])) {
      return {
        valid: false,
        error: `Invalid memory option: ${options.memory}. Use none, shortTerm, or longAndShortTerm`,
      };
    }
    return { valid: true };
  }

  // Normalize enum flag values (case-insensitive matching)
  if (options.protocol) options.protocol = matchEnumValue(ProtocolModeSchema, options.protocol) ?? options.protocol;
  if (options.language) options.language = matchEnumValue(TargetLanguageSchema, options.language) ?? options.language;
  if (options.framework) options.framework = matchEnumValue(SDKFrameworkSchema, options.framework) ?? options.framework;
  if (options.modelProvider)
    options.modelProvider = matchEnumValue(ModelProviderSchema, options.modelProvider) ?? options.modelProvider;
  if (options.build) options.build = matchEnumValue(BuildTypeSchema, options.build) ?? options.build;

  // Validate protocol if provided
  let protocol: ProtocolMode = 'HTTP';
  if (options.protocol) {
    const protocolResult = ProtocolModeSchema.safeParse(options.protocol);
    if (!protocolResult.success) {
      return { valid: false, error: `Invalid protocol: ${options.protocol}. Use HTTP, MCP, A2A, or AGUI` };
    }
    protocol = protocolResult.data;
  }

  // Validate build type if provided (applies to all protocols)
  if (options.build) {
    const buildResult = BuildTypeSchema.safeParse(options.build);
    if (!buildResult.success) {
      return { valid: false, error: `Invalid build type: ${options.build}. Use CodeZip or Container` };
    }
  }

  // TypeScript only supports HTTP today; MCP and A2A templates have not been authored yet
  if (protocol !== 'HTTP' && options.language === 'TypeScript') {
    return {
      valid: false,
      error: `${protocol} protocol is not yet supported for TypeScript. Use --protocol HTTP or --language Python.`,
    };
  }

  // MCP protocol: only name, language, and build type required
  if (protocol === 'MCP') {
    if (options.framework) {
      return { valid: false, error: '--framework is not applicable for MCP protocol' };
    }
    if (options.modelProvider) {
      return { valid: false, error: '--model-provider is not applicable for MCP protocol' };
    }
    if (options.memory && options.memory !== 'none') {
      return { valid: false, error: '--memory is not applicable for MCP protocol' };
    }
    if (options.language) {
      const langResult = TargetLanguageSchema.safeParse(options.language);
      if (!langResult.success) {
        return { valid: false, error: `Invalid language: ${options.language}` };
      }
    }
    return { valid: true };
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
      return { valid: false, error: `Invalid language: ${options.language}. Use Python or TypeScript` };
    }

    // Validate framework
    const fwResult = SDKFrameworkSchema.safeParse(options.framework);
    if (!fwResult.success) {
      return { valid: false, error: `Invalid framework: ${options.framework}` };
    }

    // Validate framework is supported for the protocol
    if (protocol !== 'HTTP') {
      const supportedFrameworks = getSupportedFrameworksForProtocol(protocol);
      if (!supportedFrameworks.includes(fwResult.data)) {
        return { valid: false, error: `${options.framework} does not support ${protocol} protocol` };
      }
    }

    // Validate model provider
    const mpResult = ModelProviderSchema.safeParse(options.modelProvider);
    if (!mpResult.success) {
      return { valid: false, error: `Invalid model provider: ${options.modelProvider}` };
    }

    // TypeScript supports Strands and Vercel AI only
    if (options.language === 'TypeScript' && fwResult.data !== 'Strands' && fwResult.data !== 'VercelAI') {
      return {
        valid: false,
        error: `Framework ${options.framework} is not yet available for TypeScript. Only Strands and Vercel AI SDK are supported.`,
      };
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

  // Validate VPC options
  const vpcResult = validateVpcOptions(options);
  if (!vpcResult.valid) {
    return { valid: false, error: vpcResult.error };
  }

  // Parse and validate lifecycle configuration
  const lifecycleResult = parseAndValidateLifecycleOptions(options);
  if (!lifecycleResult.valid) return lifecycleResult;
  if (lifecycleResult.idleTimeout !== undefined) options.idleTimeout = lifecycleResult.idleTimeout;
  if (lifecycleResult.maxLifetime !== undefined) options.maxLifetime = lifecycleResult.maxLifetime;

  // Filesystem mounts are not supported for TypeScript agents (no needsOs template blocks)
  if (options.language === 'TypeScript') {
    if (options.sessionStorageMountPath) {
      return { valid: false, error: '--session-storage-mount-path is not supported for TypeScript agents' };
    }
    if ((options.efsAccessPointArn ?? []).length > 0 || (options.efsMountPath ?? []).length > 0) {
      return { valid: false, error: '--efs-access-point-arn is not supported for TypeScript agents' };
    }
    if ((options.s3AccessPointArn ?? []).length > 0 || (options.s3MountPath ?? []).length > 0) {
      return { valid: false, error: '--s3-access-point-arn is not supported for TypeScript agents' };
    }
  }

  // Validate session storage mount path
  if (options.sessionStorageMountPath) {
    const mountPathResult = SessionStorageSchema.shape.mountPath.safeParse(options.sessionStorageMountPath);
    if (!mountPathResult.success) {
      return { valid: false, error: `--session-storage-mount-path: ${mountPathResult.error.issues[0]?.message}` };
    }
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
