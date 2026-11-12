import { InvalidEnvironmentError } from "../../errors";
import { MissingToolError, toolAvailable } from "../../io";

export const CONTAINER_TOOLS = ["docker", "podman", "finch"] as const;
export type ContainerTool = (typeof CONTAINER_TOOLS)[number];
export type ToolAvailable = typeof toolAvailable;

const CONTAINER_RUNTIME_INSTALL_HINT =
  "Install Docker (https://docs.docker.com/get-docker/), Podman (https://podman.io/), " +
  "or Finch (https://runfinch.com/).";

/** Returns the first installed container tool that can build (docker, then podman, then finch). */
export async function resolveContainerTool(
  available: ToolAvailable = toolAvailable,
  signal?: AbortSignal,
): Promise<ContainerTool> {
  for (const tool of CONTAINER_TOOLS) {
    const hasVersion = await available(tool);
    signal?.throwIfAborted();
    if (!hasVersion) continue;

    const canBuild = await available(tool, ["build", "--help"]);
    signal?.throwIfAborted();
    if (canBuild) return tool;
    if (tool === "finch") {
      throw new InvalidEnvironmentError(
        "Finch is installed but its VM is not initialized. Run 'finch vm init' and retry.",
      );
    }
  }
  throw new MissingToolError("container runtime", CONTAINER_RUNTIME_INSTALL_HINT);
}

/**
 * The executable CDK uses to build and publish local container images. An explicit
 * CDK_DOCKER is honored as-is; otherwise the same detection as `agentcore dev` applies.
 */
export async function resolveCdkDockerExecutable(
  env: NodeJS.ProcessEnv = process.env,
  available: ToolAvailable = toolAvailable,
): Promise<string> {
  return env.CDK_DOCKER || resolveContainerTool(available);
}
