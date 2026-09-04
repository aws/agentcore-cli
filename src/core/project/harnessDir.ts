import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { ReadWriteJson } from "../../io";
import { HarnessSpecSchema, type HarnessRegistryEntry } from "../../projectSchemas/harness";
import { DEFAULT_SYSTEM_PROMPT } from "./templates/harness";

export const HARNESS_SPEC_FILENAME = "harness.json";
export const SYSTEM_PROMPT_FILENAME = "system-prompt.md";

export type HarnessDirectory = {
  /** Absolute path of the harness directory (`app/<name>` by default). */
  harnessDir: string;
  spec: z.output<typeof HarnessSpecSchema>;
  /** The effective prompt: the file, else the spec's inline prompt, else the scaffolded default. */
  systemPrompt: string;
};

/**
 * Reads one harness's directory the way every consumer must: `harness.json`
 * through the spec schema, and the prompt from `system-prompt.md` (trimmed)
 * with the same fallbacks the scaffold and the export path use. Shared so the
 * export and the imperative deploy cannot drift on what a harness directory
 * means.
 */
export async function readHarnessDirectory(
  json: ReadWriteJson,
  projectRoot: string,
  entry: HarnessRegistryEntry,
): Promise<HarnessDirectory> {
  const harnessDir = join(projectRoot, entry.path);
  const spec = await json.read(join(harnessDir, HARNESS_SPEC_FILENAME), HarnessSpecSchema);
  const promptPath = join(harnessDir, SYSTEM_PROMPT_FILENAME);
  const filePrompt = existsSync(promptPath) ? (await readFile(promptPath, "utf-8")).trim() : "";
  const systemPrompt =
    filePrompt.length > 0 ? filePrompt : (spec.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  return { harnessDir, spec, systemPrompt };
}
