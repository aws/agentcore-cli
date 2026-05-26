/**
 * Container runtime detection.
 * Detects Docker, Podman, or Finch for container operations.
 */
import { CONTAINER_RUNTIMES, type ContainerRuntime } from '../../lib';
import { checkSubprocess, isWindows, runSubprocessCapture } from '../../lib';

export type { ContainerRuntime } from '../../lib';

export interface ContainerRuntimeInfo {
  runtime: ContainerRuntime;
  binary: string;
  version: string;
}

export interface DetectionResult {
  /** The first available runtime, or null if none are installed. */
  runtime: ContainerRuntimeInfo | null;
}

/**
 * Detect available container runtime.
 * Checks docker, podman, finch in order; returns the first that is installed
 * and capable of running container operations.
 */
export async function detectContainerRuntime(): Promise<DetectionResult> {
  for (const runtime of CONTAINER_RUNTIMES) {
    // Check if binary exists
    const exists = isWindows ? await checkSubprocess('where', [runtime]) : await checkSubprocess('which', [runtime]);
    if (!exists) continue;

    // Verify with --version
    const result = await runSubprocessCapture(runtime, ['--version']);
    if (result.code !== 0) continue;

    // Validate the binary actually supports container operations.
    // Some environments have shims (e.g., toolbox wrappers) that respond to
    // --version but don't support build/run commands. These shims may exit 0
    // even on failure, so also check stderr for error indicators.
    const buildCheck = await runSubprocessCapture(runtime, ['build', '--help']);
    if (buildCheck.code !== 0) continue;
    if (buildCheck.stderr && /unknown command|not found/i.test(buildCheck.stderr)) continue;

    const version = result.stdout.trim().split('\n')[0] ?? 'unknown';
    return { runtime: { runtime, binary: runtime, version } };
  }
  return { runtime: null };
}

/**
 * Get the container runtime binary path, or throw with install guidance.
 * Used by commands that require a container runtime (e.g., dev).
 */
export async function requireContainerRuntime(): Promise<ContainerRuntimeInfo> {
  const { runtime } = await detectContainerRuntime();
  if (!runtime) {
    throw new Error(
      'No container runtime found. Install Docker (https://docker.com), ' +
        'Podman (https://podman.io), or Finch (https://runfinch.com).'
    );
  }
  return runtime;
}
