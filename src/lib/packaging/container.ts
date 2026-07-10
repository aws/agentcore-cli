import type { AgentEnvSpec } from '../../schema';
import { CONTAINER_RUNTIMES, DOCKERFILE_NAME, ONE_GB } from '../constants';
import { PackagingError } from '../errors/types';
import { getCustomBuildArgs, getUvBuildArgs } from './build-args';
import { resolveBuildContext } from './build-context';
import { ensureBuildContextDockerignore } from './build-context-dockerignore';
import { resolveCodeLocation } from './helpers';
import type { ArtifactResult, PackageOptions, RuntimePackager } from './types/packaging';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

/**
 * Detect container runtime synchronously.
 * Checks runtimes in CONTAINER_RUNTIMES order; returns the first available binary name.
 */
function detectContainerRuntimeSync(): string | null {
  for (const runtime of CONTAINER_RUNTIMES) {
    const result = spawnSync('which', [runtime], { stdio: 'pipe' });
    if (result.status === 0) {
      const versionResult = spawnSync(runtime, ['--version'], { stdio: 'pipe' });
      if (versionResult.status === 0) return runtime;
    }
  }
  return null;
}

/**
 * Packager for Container agents.
 * Builds a container image locally and validates its size.
 */
export class ContainerPackager implements RuntimePackager {
  pack(spec: AgentEnvSpec, options: PackageOptions = {}): Promise<ArtifactResult> {
    if (spec.build !== 'Container') {
      return Promise.reject(new PackagingError('ContainerPackager only supports Container build type.'));
    }

    const agentName = options.agentName ?? spec.name;
    const configBaseDir = options.artifactDir ?? options.projectRoot ?? process.cwd();
    const codeLocation = resolveCodeLocation(spec.codeLocation, configBaseDir);
    // Build context + Dockerfile via the shared resolver (identical to the deploy/CodeBuild path).
    const { buildContext, dockerfilePath } = resolveBuildContext(spec, configBaseDir);

    // Preflight: Dockerfile must exist
    if (!existsSync(dockerfilePath)) {
      return Promise.reject(
        new PackagingError(
          `${spec.dockerfile ?? DOCKERFILE_NAME} not found at ${dockerfilePath}. Container agents require a Dockerfile.`
        )
      );
    }

    // Dockerfile validated — when buildContextPath widens the context, ensure a .dockerignore keeps
    // secrets/junk out of the local image (the same file the deploy path honors). No-op if the dir is
    // missing or a .dockerignore already exists, so a failing build never leaves a stray file.
    if (spec.buildContextPath) {
      ensureBuildContextDockerignore(buildContext);
    }

    // Detect container runtime
    const runtime = detectContainerRuntimeSync();
    if (!runtime) {
      // No runtime available — skip local build validation (deploy will use CodeBuild)
      return Promise.resolve({
        artifactPath: '',
        sizeBytes: 0,
        stagingPath: codeLocation,
      });
    }

    // Build locally. Docker image tags must be lowercase, but agent names allow uppercase
    // (e.g. the default "AgentOne"), so lower-case the tag — matching the dev server.
    const imageName = `agentcore-package-${agentName}`.toLowerCase();
    const buildArgFlags = getCustomBuildArgs(spec.customDockerBuildArgs);
    const buildResult = spawnSync(
      runtime,
      ['build', '-t', imageName, '-f', dockerfilePath, ...getUvBuildArgs(), ...buildArgFlags, buildContext],
      {
        stdio: 'pipe',
      }
    );

    if (buildResult.status !== 0) {
      return Promise.reject(new PackagingError(`Container build failed:\n${buildResult.stderr?.toString()}`));
    }

    // Validate size (1GB limit)
    const inspectResult = spawnSync(runtime, ['image', 'inspect', imageName, '--format', '{{.Size}}'], {
      stdio: 'pipe',
    });

    const sizeBytes = parseInt(inspectResult.stdout?.toString().trim() ?? '0', 10);
    if (sizeBytes > ONE_GB) {
      const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
      return Promise.reject(
        new PackagingError(
          `Container image exceeds 1GB limit (${sizeMb}MB). ` +
            'Optimize your Dockerfile: use multi-stage builds, minimize dependencies, add .dockerignore.'
        )
      );
    }

    return Promise.resolve({
      artifactPath: `${runtime}://${imageName}`,
      sizeBytes,
      stagingPath: codeLocation,
    });
  }
}
