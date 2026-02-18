import type { AgentEnvSpec } from '../../schema';
import { CONTAINER_RUNTIMES, DOCKERFILE_NAME, ONE_GB } from '../constants';
import { PackagingError } from './errors';
import { resolveCodeLocation } from './helpers';
import type { ArtifactResult, PackageOptions, RuntimePackager } from './types/packaging';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

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
    const dockerfilePath = join(codeLocation, DOCKERFILE_NAME);

    // Preflight: Dockerfile must exist
    if (!existsSync(dockerfilePath)) {
      return Promise.reject(
        new PackagingError(`Dockerfile not found at ${dockerfilePath}. Container agents require a Dockerfile.`)
      );
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

    // Build locally
    const imageName = `agentcore-package-${agentName}`;
    const buildResult = spawnSync(runtime, ['build', '-t', imageName, '-f', dockerfilePath, codeLocation], {
      stdio: 'pipe',
    });

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
