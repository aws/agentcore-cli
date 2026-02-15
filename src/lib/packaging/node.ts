import type { AgentEnvSpec, NodeRuntime, RuntimeVersion } from '../../schema';
import { NPM_INSTALL_HINT, getArtifactZipName } from '../constants';
import { runSubprocessCapture, runSubprocessCaptureSync } from '../utils/subprocess';
import { PackagingError } from './errors';
import {
  copySourceTree,
  copySourceTreeSync,
  createZipFromDir,
  createZipFromDirSync,
  enforceZipSizeLimit,
  enforceZipSizeLimitSync,
  ensureBinaryAvailable,
  ensureBinaryAvailableSync,
  ensureDirClean,
  ensureDirCleanSync,
  isNodeRuntime,
  resolveProjectPaths,
  resolveProjectPathsSync,
} from './helpers';
import type { ArtifactResult, CodeZipPackager, PackageOptions, RuntimePackager } from './types/packaging';
import { join } from 'path';

const NODE_RUNTIME_REGEX = /NODE_(\d+)/;

/**
 * Type guard to check if runtime version is a Node runtime
 */
function isNodeRuntimeVersion(version: RuntimeVersion): version is NodeRuntime {
  return isNodeRuntime(version);
}

/**
 * Extracts Node version from runtime constant.
 * Example: NODE_20 -> "20" (for use with node version checks)
 */
export function extractNodeVersion(runtime: NodeRuntime): string {
  const match = NODE_RUNTIME_REGEX.exec(runtime);
  if (!match) {
    throw new PackagingError(`Unsupported Node runtime value: ${runtime}`);
  }
  const [, major] = match;
  if (!major) {
    throw new PackagingError(`Invalid Node runtime value: ${runtime}`);
  }
  return major;
}

/**
 * Async Node/TypeScript packager for CLI usage.
 */
export class NodeCodeZipPackager implements RuntimePackager {
  async pack(spec: AgentEnvSpec, options: PackageOptions = {}): Promise<ArtifactResult> {
    if (spec.build !== 'CodeZip') {
      throw new PackagingError('Node packager only supports CodeZip build type.');
    }

    if (!isNodeRuntimeVersion(spec.runtimeVersion)) {
      throw new PackagingError(`Node packager only supports Node runtimes. Received: ${spec.runtimeVersion}`);
    }

    const agentName = options.agentName ?? spec.name;
    const { projectRoot, srcDir, stagingDir, artifactsDir } = await resolveProjectPaths(options, agentName);

    await ensureBinaryAvailable('npm', NPM_INSTALL_HINT);
    await ensureDirClean(stagingDir);

    // Copy source files
    await copySourceTree(srcDir, stagingDir);

    // Install production dependencies
    await this.installDependencies(projectRoot, stagingDir);

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    await createZipFromDir(stagingDir, artifactPath);
    const sizeBytes = await enforceZipSizeLimit(artifactPath);

    return {
      artifactPath,
      sizeBytes,
      stagingPath: stagingDir,
    };
  }

  private async installDependencies(projectRoot: string, stagingDir: string): Promise<void> {
    // Copy package.json to staging
    const result = await runSubprocessCapture('npm', ['install', '--omit=dev', '--prefix', stagingDir], {
      cwd: projectRoot,
    });

    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw new PackagingError(combined.length > 0 ? combined : `npm install failed with exit code ${result.code}`);
    }
  }
}

/**
 * Sync Node/TypeScript packager for CDK bundling.
 */
export class NodeCodeZipPackagerSync implements CodeZipPackager {
  packCodeZip(config: AgentEnvSpec, options: PackageOptions = {}): ArtifactResult {
    const runtimeVersion = config.runtimeVersion ?? 'NODE_20';

    if (!isNodeRuntimeVersion(runtimeVersion)) {
      throw new PackagingError(`Node packager only supports Node runtimes. Received: ${runtimeVersion}`);
    }

    const agentName = options.agentName ?? config.name ?? 'asset';
    const { projectRoot, srcDir, stagingDir, artifactsDir } = resolveProjectPathsSync(options, agentName);

    ensureBinaryAvailableSync('npm', NPM_INSTALL_HINT);
    ensureDirCleanSync(stagingDir);

    // Copy source files
    copySourceTreeSync(srcDir, stagingDir);

    // Install production dependencies
    this.installDependenciesSync(projectRoot, stagingDir);

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    createZipFromDirSync(stagingDir, artifactPath);
    const sizeBytes = enforceZipSizeLimitSync(artifactPath);

    return {
      artifactPath,
      sizeBytes,
      stagingPath: stagingDir,
    };
  }

  private installDependenciesSync(projectRoot: string, stagingDir: string): void {
    const result = runSubprocessCaptureSync('npm', ['install', '--omit=dev', '--prefix', stagingDir], {
      cwd: projectRoot,
    });

    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw new PackagingError(combined.length > 0 ? combined : `npm install failed with exit code ${result.code}`);
    }
  }
}
