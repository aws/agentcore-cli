import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walks up from directory looking for the agentcore/agentcore.json project marker. */
export function enclosingProjectRoot(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, "agentcore", "agentcore.json"))) {
      return current;
    }
    if (dirname(current) === current) {
      return undefined;
    }
  }
}
