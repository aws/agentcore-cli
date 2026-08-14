// Reads the cloud assembly `build` synthesized, so deploy can find the stack that
// belongs to a deployment target.
import { existsSync } from "node:fs";
import { join } from "node:path";
import z from "zod";
import { ProjectStateError } from "../../errors/errors";
import type { ReadWriteJson } from "../../io";

// The tag the generated CDK app puts on every stack, naming the deployment target
// the stack was synthesized for. Selecting on it means the CLI never has to
// reproduce the app's stack-naming convention, so a project that renames its
// stacks still deploys.
const TARGET_TAG = "agentcore:target-name";

const STACK_ARTIFACT = "aws:cloudformation:stack";

// Only the parts of the manifest deploy reads. Artifacts are keyed by their
// hierarchical id, which is what the CDK toolkit matches stack patterns against.
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
 * The name of the stack in the synthesized assembly that belongs to `target`.
 *
 * The generated CDK app synthesizes one stack per deployment target and tags each
 * with the target's name, so deploy asks the assembly which stack to ship rather
 * than deriving the name itself and hoping the two agree.
 */
export async function stackForTarget(
  json: ReadWriteJson,
  assemblyDirectory: string,
  target: string,
): Promise<string> {
  const path = join(assemblyDirectory, "manifest.json");
  // deploy synthesizes immediately before this, so a missing manifest means synth
  // wrote somewhere else entirely rather than that the user skipped a step.
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
