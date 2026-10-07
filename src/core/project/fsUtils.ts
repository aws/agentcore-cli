import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import z from "zod";
import { DeserializationError, InputValidationError } from "../../errors";
import { readTextFile, readYamlFile } from "../../io";
import { HarnessYamlSchema, type HarnessSpec } from "../../projectSchemas/harness";

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

export function toPythonPackageName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "");
}

export type HarnessFiles = { spec: HarnessSpec; systemPrompt?: string };

export async function readHarnessFiles(harnessDir: string): Promise<HarnessFiles> {
  const harnessPath = join(harnessDir, "harness.yaml");
  const parsed = HarnessYamlSchema.safeParse(await readYamlFile(harnessPath));
  if (!parsed.success) {
    throw new InputValidationError(
      `Invalid harness.yaml at '${harnessPath}': ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  const spec = parsed.data;
  if (spec.systemPrompt !== undefined) return { spec, systemPrompt: spec.systemPrompt };

  const promptPath = join(harnessDir, "system-prompt.md");
  let systemPrompt: string;
  try {
    systemPrompt = await readTextFile(promptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { spec };
    throw new DeserializationError(promptPath, {
      cause: error,
      details: error instanceof Error ? error.message : String(error),
    });
  }
  if (!systemPrompt.trim()) {
    throw new InputValidationError(
      `System prompt file '${promptPath}' is empty or whitespace-only.`,
    );
  }
  return { spec, systemPrompt };
}
