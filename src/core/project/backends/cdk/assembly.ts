import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors/errors";
import type { ReadWriteJson } from "../../../../io";

const TARGET_TAG = "agentcore:target-name";
const STACK_ARTIFACT = "aws:cloudformation:stack";

const AssemblyManifestSchema = z.object({
  artifacts: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        properties: z
          .object({
            tags: z.record(z.string(), z.string()).optional(),
          })
          .optional(),
      }),
    )
    .default({}),
});

/** Finds the one synthesized stack tagged for the selected deployment target. */
export async function stackForTarget(
  json: ReadWriteJson,
  assemblyDirectory: string,
  target: string,
): Promise<string> {
  const manifestPath = join(assemblyDirectory, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new ProjectStateError(`No synthesized cloud assembly was found at ${manifestPath}.`);
  }

  const manifest = await json.read(manifestPath, AssemblyManifestSchema);
  const stacks = Object.entries(manifest.artifacts).filter(
    ([, artifact]) => artifact.type === STACK_ARTIFACT,
  );
  const matches = stacks.filter(
    ([, artifact]) => artifact.properties?.tags?.[TARGET_TAG] === target,
  );

  if (matches.length === 0) {
    throw new ProjectStateError(
      `The synthesized cloud assembly has no stack for deployment target '${target}'. ` +
        `${manifestPath} defines ${stacks.length} stack(s), none tagged ${TARGET_TAG}='${target}'.`,
    );
  }
  if (matches.length > 1) {
    throw new ProjectStateError(
      `The synthesized cloud assembly has ${matches.length} stacks for deployment target ` +
        `'${target}'. Exactly one stack must be tagged ${TARGET_TAG}='${target}'.`,
    );
  }
  return matches[0]![0];
}
