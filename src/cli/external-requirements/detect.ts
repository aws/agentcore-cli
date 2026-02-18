/**
 * Container runtime detection.
 * Detects Docker, Podman, or Finch for container operations.
 */
import { CONTAINER_RUNTIMES, type ContainerRuntime, START_HINTS } from '../../lib';
import { checkSubprocess, isWindows, runSubprocessCapture } from '../../lib';

export type { ContainerRuntime } from '../../lib';

export interface ContainerRuntimeInfo {
  runtime: ContainerRuntime;
  binary: string;
  version: string;
}

export interface DetectionResult {
  /** The first ready runtime, or null if none are ready. */
  runtime: ContainerRuntimeInfo | null;
  /** Runtimes that are installed but not ready (e.g., VM not started). */
  notReadyRuntimes: ContainerRuntime[];
}

/**
 * Build a user-friendly hint for runtimes that are installed but not ready.
 */
export function getStartHint(runtimes: ContainerRuntime[]): string {
  return runtimes.map(r => `  ${r}: ${START_HINTS[r]}`).join('\n');
}

/**
 * Detect available container runtime.
 * Checks docker, podman, finch in order; returns the first that is installed and usable,
 * plus a list of runtimes that are installed but not ready.
 */
export async function detectContainerRuntime(): Promise<DetectionResult> {
  const notReadyRuntimes: ContainerRuntime[] = [];
  for (const runtime of CONTAINER_RUNTIMES) {
    // Check if binary exists
    const exists = isWindows ? await checkSubprocess('where', [runtime]) : await checkSubprocess('which', [runtime]);
    if (!exists) continue;

    // Verify with --version
    const result = await runSubprocessCapture(runtime, ['--version']);
    if (result.code !== 0) continue;

    // Verify the runtime is actually usable (e.g., finch VM initialized, docker daemon running)
    const infoResult = await runSubprocessCapture(runtime, ['info']);
    if (infoResult.code !== 0) {
      notReadyRuntimes.push(runtime);
      continue;
    }

    const version = result.stdout.trim().split('\n')[0] ?? 'unknown';
    return { runtime: { runtime, binary: runtime, version }, notReadyRuntimes };
  }
  return { runtime: null, notReadyRuntimes };
}

/**
 * Get the container runtime binary path, or throw with install guidance.
 * Used by commands that require a container runtime (e.g., dev).
 */
export async function requireContainerRuntime(): Promise<ContainerRuntimeInfo> {
  const { runtime, notReadyRuntimes } = await detectContainerRuntime();
  if (!runtime) {
    if (notReadyRuntimes.length > 0) {
      throw new Error(
        `Found ${notReadyRuntimes.join(', ')} but not ready. Start a runtime:\n${getStartHint(notReadyRuntimes)}`
      );
    }
    throw new Error(
      'No container runtime found. Install Docker (https://docker.com), ' +
        'Podman (https://podman.io), or Finch (https://runfinch.com).'
    );
  }
  return runtime;
}
