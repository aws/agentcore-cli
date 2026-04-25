import { CONFIG_DIR } from '../../../lib';
import type { HarnessModelProvider, NetworkMode } from '../../../schema';
import { getErrorMessage } from '../../errors';
import { harnessPrimitive } from '../../primitives/registry';
import { type ProgressCallback, createProject } from './action';
import type { CreateResult } from './types';
import { join } from 'path';

export interface CreateHarnessProjectOptions {
  name: string;
  projectName?: string;
  cwd: string;
  modelProvider: HarnessModelProvider;
  modelId: string;
  apiKeyArn?: string;
  skipMemory?: boolean;
  containerUri?: string;
  dockerfilePath?: string;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  truncationStrategy?: 'sliding_window' | 'summarization';
  networkMode?: NetworkMode;
  subnets?: string[];
  securityGroups?: string[];
  idleTimeout?: number;
  maxLifetime?: number;
  sessionStoragePath?: string;
  skipGit?: boolean;
  skipInstall?: boolean;
  onProgress?: ProgressCallback;
}

export async function createProjectWithHarness(options: CreateHarnessProjectOptions): Promise<CreateResult> {
  const { name, projectName: explicitProjectName, cwd, skipGit, skipInstall, onProgress } = options;
  const projectName = explicitProjectName ?? name;

  const projectResult = await createProject({
    name: projectName,
    cwd,
    skipGit,
    skipInstall,
    onProgress,
  });

  if (!projectResult.success) {
    return projectResult;
  }

  const projectRoot = projectResult.projectPath!;
  const configBaseDir = join(projectRoot, CONFIG_DIR);

  try {
    onProgress?.('Add harness to project', 'start');

    const harnessResult = await harnessPrimitive.add({
      name: options.name,
      modelProvider: options.modelProvider,
      modelId: options.modelId,
      apiKeyArn: options.apiKeyArn,
      containerUri: options.containerUri,
      dockerfilePath: options.dockerfilePath,
      skipMemory: options.skipMemory,
      maxIterations: options.maxIterations,
      maxTokens: options.maxTokens,
      timeoutSeconds: options.timeoutSeconds,
      truncationStrategy: options.truncationStrategy,
      networkMode: options.networkMode,
      subnets: options.subnets,
      securityGroups: options.securityGroups,
      idleTimeout: options.idleTimeout,
      maxLifetime: options.maxLifetime,
      sessionStoragePath: options.sessionStoragePath,
      configBaseDir,
    });

    if (!harnessResult.success) {
      onProgress?.('Add harness to project', 'error');
      return {
        success: false,
        error: harnessResult.error,
        warnings: projectResult.warnings,
      };
    }

    onProgress?.('Add harness to project', 'done');

    return {
      success: true,
      projectPath: projectRoot,
      warnings: projectResult.warnings,
    };
  } catch (err) {
    return {
      success: false,
      error: getErrorMessage(err),
      warnings: projectResult.warnings,
    };
  }
}
