import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

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

/** Checks the project header without requiring the v1 project schema to parse. */
export async function isV0Project(rootPath: string): Promise<boolean> {
  try {
    const contents = await readFile(projectSpecPath(rootPath), "utf8");
    const header = z.object({ version: z.unknown().optional() }).safeParse(JSON.parse(contents));
    return header.success && header.data.version === 1;
  } catch {
    // Leave unreadable or malformed specs to normal project validation.
    return false;
  }
}

export function toPythonPackageName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "");
}

export function defaultExportProjectName(harnessName: string): string {
  return `Export${harnessName.replace(/_/g, "")}`.slice(0, 23);
}
