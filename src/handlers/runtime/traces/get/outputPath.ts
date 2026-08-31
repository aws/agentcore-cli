import { join, resolve } from "node:path";
import type { Project } from "../../../project/types";

/**
 * Resolves where `runtime traces get` writes its JSON file: an explicit
 * --output wins; inside a project the file lands under the project's
 * `agentcore/.cli/traces/` (keyed by runtime and trace so downloads never
 * collide); outside a project it lands in the working directory.
 */
export function resolveTraceOutputPath(config: {
  output?: string;
  project?: Project;
  runtimeId: string;
  traceId: string;
  cwd?: string;
}): string {
  const cwd = config.cwd ?? process.cwd();
  if (config.output) return resolve(cwd, config.output);
  if (config.project) {
    return join(
      config.project.rootPath,
      "agentcore",
      ".cli",
      "traces",
      `${config.runtimeId}-${config.traceId}.json`,
    );
  }
  return resolve(cwd, `${config.traceId}.json`);
}
