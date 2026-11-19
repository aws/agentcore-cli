import { posix } from "node:path";
import { ProjectStateError } from "../../errors/errors";
import type { ProjectRuntime } from "../../projectSchemas/runtime";

/** Generated metadata used by both Box deployment launchers. */
export const BOX_RUNTIME_CONFIG = "runtime-start.json";
export const BOX_RUNTIME_MODULE = "box_runtime.py";
export const BOX_CONTAINER_START = "box_container_start.py";
export const BOX_DEFERRED_INGRESS_PORT = 8082;

export interface BoxRuntimeMount {
  readonly path: string;
  readonly filesystem_types: readonly string[];
}

/**
 * Storage is mounted after Runtime restores the process. An HTTP launcher must wait for the
 * actual filesystem before creating Box's mount namespace. Grant only each configured path.
 */
export function boxRuntimeMounts(runtime: ProjectRuntime): readonly BoxRuntimeMount[] {
  const configurations = runtime.filesystemConfigurations ?? [];
  if (configurations.length === 0) return [];
  if ((runtime.protocol ?? "HTTP") !== "HTTP") {
    throw new ProjectStateError(
      `runtime "${runtime.name}": deferred Box startup with storage supports HTTP only. ` +
        "Use an HTTP Box runtime before adding filesystemConfigurations.",
    );
  }
  const mounts = new Map<string, BoxRuntimeMount>();
  for (const configuration of configurations) {
    const storage =
      "sessionStorage" in configuration
        ? configuration.sessionStorage
        : "efsAccessPoint" in configuration
          ? configuration.efsAccessPoint
          : configuration.s3FilesAccessPoint;
    const path = storage.mountPath.replace(/\/$/, "");
    if (
      !/^\/mnt\/[a-zA-Z0-9._-]+$/.test(path) ||
      [".", ".."].includes(posix.basename(path)) ||
      posix.normalize(path) !== path
    ) {
      throw new ProjectStateError(
        `runtime "${runtime.name}": storage mount "${storage.mountPath}" must name one directory ` +
          "directly below /mnt; dot and parent-directory segments are not allowed.",
      );
    }
    // EFS, S3 Files, and Runtime session storage expose NFS, not their placeholder bind mount.
    mounts.set(path, { path, filesystem_types: ["nfs", "nfs4"] });
  }
  return [...mounts.values()];
}

export function renderBoxRuntimeConfig(runtime: ProjectRuntime): string {
  return `${JSON.stringify({ version: 1, required_mounts: boxRuntimeMounts(runtime) }, null, 2)}
`;
}
