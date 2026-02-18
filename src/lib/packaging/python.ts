import type { AgentEnvSpec, PythonRuntime, RuntimeVersion } from '../../schema';
import { UV_INSTALL_HINT, getArtifactZipName } from '../constants';
import { runSubprocessCapture, runSubprocessCaptureSync } from '../utils/subprocess';
import { PackagingError } from './errors';
import {
  convertWindowsScriptsToLinux,
  convertWindowsScriptsToLinuxSync,
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
  isPythonRuntime,
  resolveProjectPaths,
  resolveProjectPathsSync,
} from './helpers';
import type { ArtifactResult, CodeZipPackager, PackageOptions, RuntimePackager } from './types/packaging';
import { detectUnavailablePlatform } from './uv';
import { join } from 'path';

// eslint-disable-next-line security/detect-unsafe-regex -- bounded input from RuntimeVersion enum, not user input
const PYTHON_RUNTIME_REGEX = /PYTHON_(\d+)_?(\d+)?/;

/**
 * Type guard to check if runtime version is a Python runtime
 */
function isPythonRuntimeVersion(version: RuntimeVersion): version is PythonRuntime {
  return isPythonRuntime(version);
}
// AC Runtime uses AL2023 with GLIBC 2.34, we can support any manylinux <= 2_34
export const PLATFORM_CANDIDATES = ['aarch64-manylinux2014', 'aarch64-manylinux_2_28', 'aarch64-manylinux_2_34'];

/**
 * Extracts Python version from runtime constant.
 * Example: PYTHON_3_12 -> "3.12" (for use with uv --python-version)
 */
export function extractPythonVersion(runtime: PythonRuntime): string {
  const match = PYTHON_RUNTIME_REGEX.exec(runtime);
  if (!match) {
    throw new PackagingError(`Unsupported Python runtime value: ${runtime}`);
  }
  const [, major, minor] = match;
  if (!major || !minor) {
    throw new PackagingError(`Invalid Python runtime value: ${runtime}`);
  }
  return `${Number(major)}.${Number(minor)}`;
}

/**
 * Async Python packager for CLI usage.
 */
export class PythonCodeZipPackager implements RuntimePackager {
  async pack(spec: AgentEnvSpec, options: PackageOptions = {}): Promise<ArtifactResult> {
    if (spec.build !== 'CodeZip') {
      throw new PackagingError('Python packager only supports CodeZip build type.');
    }

    if (!isPythonRuntimeVersion(spec.runtimeVersion)) {
      throw new PackagingError(`Python packager only supports Python runtimes. Received: ${spec.runtimeVersion}`);
    }

    const agentName = options.agentName ?? spec.name;
    const { projectRoot, srcDir, stagingDir, artifactsDir, pyprojectPath } = await resolveProjectPaths(
      options,
      agentName
    );
    const pythonPlatforms = options.pythonPlatform ? [options.pythonPlatform] : PLATFORM_CANDIDATES;

    await ensureBinaryAvailable('uv', UV_INSTALL_HINT);
    await ensureDirClean(stagingDir);

    const finalStaging = await this.installWithRetries(
      projectRoot,
      srcDir,
      stagingDir,
      spec.runtimeVersion,
      pythonPlatforms,
      pyprojectPath
    );

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    await createZipFromDir(finalStaging, artifactPath);
    const sizeBytes = await enforceZipSizeLimit(artifactPath);

    return {
      artifactPath,
      sizeBytes,
      stagingPath: finalStaging,
    };
  }

  private async installWithRetries(
    projectRoot: string,
    srcDir: string,
    stagingDir: string,
    runtimeVersion: PythonRuntime,
    pythonPlatforms: string[],
    pyprojectPath: string
  ): Promise<string> {
    const pythonVersion = extractPythonVersion(runtimeVersion);

    for (const platform of pythonPlatforms) {
      if (!platform) {
        throw new PackagingError('No platform candidate available for dependency installation.');
      }
      await ensureDirClean(stagingDir);

      const result = await runSubprocessCapture(
        'uv',
        [
          'pip',
          'install',
          '-r',
          pyprojectPath,
          '--target',
          stagingDir,
          '--python-version',
          pythonVersion,
          '--python-platform',
          platform,
          '--only-binary',
          ':all:',
        ],
        { cwd: projectRoot }
      );

      if (result.code === 0) {
        await copySourceTree(srcDir, stagingDir);
        await convertWindowsScriptsToLinux(stagingDir);
        return stagingDir;
      } else {
        const platformIssue = detectUnavailablePlatform(result);
        if (platformIssue) {
          continue;
        }

        const combined = `${result.stdout}\n${result.stderr}`.trim();
        throw new PackagingError(
          combined.length > 0 ? combined : `uv install failed on platform ${platform} with exit code ${result.code}`
        );
      }
    }

    throw new PackagingError('uv install failed for all platform candidates.');
  }
}

/**
 * Sync Python packager for CDK bundling.
 */
export class PythonCodeZipPackagerSync implements CodeZipPackager {
  packCodeZip(config: AgentEnvSpec, options: PackageOptions = {}): ArtifactResult {
    const runtimeVersion = config.runtimeVersion ?? 'PYTHON_3_12';

    if (!isPythonRuntimeVersion(runtimeVersion)) {
      throw new PackagingError(`Python packager only supports Python runtimes. Received: ${runtimeVersion}`);
    }

    const agentName = options.agentName ?? config.name ?? 'asset';
    const { projectRoot, srcDir, stagingDir, artifactsDir, pyprojectPath } = resolveProjectPathsSync(
      options,
      agentName
    );
    const pythonPlatforms = options.pythonPlatform ? [options.pythonPlatform] : PLATFORM_CANDIDATES;

    ensureBinaryAvailableSync('uv', UV_INSTALL_HINT);
    ensureDirCleanSync(stagingDir);

    const finalStaging = this.installWithRetriesSync(
      projectRoot,
      srcDir,
      stagingDir,
      runtimeVersion,
      pythonPlatforms,
      pyprojectPath
    );

    const artifactPath = options.outputPath ?? join(artifactsDir, getArtifactZipName(agentName));
    createZipFromDirSync(finalStaging, artifactPath);
    const sizeBytes = enforceZipSizeLimitSync(artifactPath);

    return {
      artifactPath,
      sizeBytes,
      stagingPath: finalStaging,
    };
  }

  private installWithRetriesSync(
    projectRoot: string,
    srcDir: string,
    stagingDir: string,
    runtimeVersion: PythonRuntime,
    pythonPlatforms: string[],
    pyprojectPath: string
  ): string {
    const pythonVersion = extractPythonVersion(runtimeVersion);

    for (const platform of pythonPlatforms) {
      if (!platform) {
        throw new PackagingError('No platform candidate available for dependency installation.');
      }
      ensureDirCleanSync(stagingDir);

      const result = runSubprocessCaptureSync(
        'uv',
        [
          'pip',
          'install',
          '-r',
          pyprojectPath,
          '--target',
          stagingDir,
          '--python-version',
          pythonVersion,
          '--python-platform',
          platform,
          '--only-binary',
          ':all:',
        ],
        { cwd: projectRoot }
      );

      if (result.code === 0) {
        copySourceTreeSync(srcDir, stagingDir);
        convertWindowsScriptsToLinuxSync(stagingDir);
        return stagingDir;
      } else {
        const platformIssue = detectUnavailablePlatform(result);
        if (platformIssue) {
          continue;
        }

        const combined = `${result.stdout}\n${result.stderr}`.trim();
        throw new PackagingError(
          combined.length > 0 ? combined : `uv install failed on platform ${platform} with exit code ${result.code}`
        );
      }
    }

    throw new PackagingError('uv install failed for all platform candidates.');
  }
}
