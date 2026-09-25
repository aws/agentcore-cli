import { spawnSync } from "node:child_process";

/** The container tools `agentcore dev` accepts for Container-build runtimes, in its probe order. */
const CONTAINER_TOOLS = ["docker", "podman", "finch"] as const;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Given the current host, returns the first container tool whose daemon is reachable.
 * `<tool> info` needs a running daemon, unlike `--version`, which also succeeds on
 * hosts that ship only the CLI (for example CodeBuild images without privileged mode).
 */
export function detectContainerTool(): (typeof CONTAINER_TOOLS)[number] | undefined {
  for (const tool of CONTAINER_TOOLS) {
    const probe = spawnSync(tool, ["info"], { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });
    if (!probe.error && probe.status === 0) return tool;
  }
  return undefined;
}
