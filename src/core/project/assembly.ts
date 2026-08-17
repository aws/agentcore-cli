import { existsSync } from "node:fs";
import { join } from "node:path";
import z from "zod";
import { ProjectStateError } from "../../errors/errors";
import type { ReadWriteJson } from "../../io";

// The generated app tags every stack with the target it was synthesized for. Selecting
// on the tag keeps the CLI from reproducing the app's stack-naming convention.
const TARGET_TAG = "agentcore:target-name";

const STACK_ARTIFACT = "aws:cloudformation:stack";

// Artifacts are keyed by the hierarchical id the toolkit matches stack patterns against.
const AssemblyManifestSchema = z.object({
  artifacts: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        properties: z.object({ tags: z.record(z.string(), z.string()).optional() }).optional(),
      }),
    )
    .default({}),
});

/**
 * Asks the synthesized manifest which stack belongs to `target`, rather than deriving
 * the name and hoping it matches what synth chose.
 */
export async function stackForTarget(
  json: ReadWriteJson,
  assemblyDirectory: string,
  target: string,
): Promise<string> {
  const path = join(assemblyDirectory, "manifest.json");
  // deploy synthesizes immediately before this, so a missing manifest means synth wrote
  // somewhere else rather than that the user skipped a step.
  if (!existsSync(path)) {
    throw new ProjectStateError(`No synthesized cloud assembly was found at ${path}.`);
  }

  const manifest = await json.read(path, AssemblyManifestSchema);
  const stacks = Object.entries(manifest.artifacts).filter(
    ([, artifact]) => artifact.type === STACK_ARTIFACT,
  );
  const match = stacks.find(([, artifact]) => artifact.properties?.tags?.[TARGET_TAG] === target);
  if (!match) {
    throw new ProjectStateError(
      `The synthesized cloud assembly has no stack for deployment target '${target}'. ` +
        `${path} defines ${stacks.length} stack(s), none tagged ${TARGET_TAG}='${target}'.`,
    );
  }
  return match[0];
}
