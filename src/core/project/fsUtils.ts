import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The project spec, relative to the project root. */
export const PROJECT_SPEC_RELATIVE_PATH = join("agentcore", "agentcore.json");

/** The project spec's absolute path under `rootPath`. */
export function projectSpecPath(rootPath: string): string {
  return join(rootPath, PROJECT_SPEC_RELATIVE_PATH);
}

/** Walks up from directory looking for the agentcore/agentcore.json project marker. */
export function enclosingProjectRoot(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, PROJECT_SPEC_RELATIVE_PATH))) {
      return current;
    }
    if (dirname(current) === current) {
      return undefined;
    }
  }
}
