import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors/errors";
import type { ReadWriteJson } from "../../../../io";

const TARGET_TAG = "agentcore:target-name";
const STACK_ARTIFACT = "aws:cloudformation:stack";
/** The resource CDK adds to every stack of its own accord, which no user asked for. */
const METADATA_RESOURCE_TYPE = "AWS::CDK::Metadata";

const AssemblyManifestSchema = z.object({
  artifacts: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        properties: z
          .object({
            tags: z.record(z.string(), z.string()).optional(),
            templateFile: z.string().optional(),
            stackName: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default({}),
});

const StackTemplateSchema = z
  .object({
    Resources: z
      .record(
        z.string(),
        // An untyped resource is a malformed template rather than a metadata
        // resource, so leaving Type optional counts it as deployable and keeps
        // the teardown path from claiming such a stack is empty.
        z.object({ Type: z.string().optional() }).passthrough(),
      )
      .default({}),
  })
  .passthrough();

/** The synthesized stack a deploy selected, and where its template lives. */
export type StackArtifact = {
  /** Artifact id the CDK Toolkit selects the stack by. */
  id: string;
  /** Name CloudFormation knows the deployed stack by. */
  stackName: string;
  /** Assembly-relative path of the synthesized template. */
  templateFile: string | undefined;
};

/** Finds the one synthesized stack artifact tagged for the selected deployment target. */
export async function stackArtifactForTarget(
  json: ReadWriteJson,
  assemblyDirectory: string,
  target: string,
): Promise<StackArtifact> {
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

  const [id, artifact] = matches[0]!;
  return {
    id,
    // Mirrors how CDK itself resolves a stack artifact's physical name
    // (`properties.stackName || artifactId`), so the name we hand CloudFormation
    // is the one the Toolkit would have used.
    stackName: artifact.properties?.stackName ?? id,
    templateFile: artifact.properties?.templateFile,
  };
}

/**
 * Counts the resources in a synthesized template that the project actually asked
 * for, so a deploy can tell "update this stack" from "tear it down".
 *
 * `AWS::CDK::Metadata` is excluded because CDK adds it to every stack unless
 * version reporting is disabled: a project whose spec declares nothing still
 * synthesizes a template holding that one resource. Counting raw resources would
 * therefore never reach zero through the CLI, so a check for an empty
 * `Resources` block would never fire — and the interesting question is whether
 * anything the user asked for is left, not whether CDK's own bookkeeping is.
 *
 * Reading the template rather than the spec keeps this honest as the spec grows:
 * a resource type added later shows up here without anyone remembering to extend
 * a list of collections to check.
 */
export async function countDeployableResources(
  json: ReadWriteJson,
  assemblyDirectory: string,
  artifact: StackArtifact,
): Promise<number> {
  // The cloud assembly schema requires templateFile on a stack artifact, so its
  // absence is a malformed assembly rather than a stack to deploy unchecked.
  if (artifact.templateFile === undefined) {
    throw new ProjectStateError(
      `Stack artifact '${artifact.id}' names no template file in the cloud assembly manifest.`,
    );
  }

  const templatePath = join(assemblyDirectory, artifact.templateFile);
  if (!existsSync(templatePath)) {
    throw new ProjectStateError(
      `The synthesized template for stack '${artifact.id}' is missing from the cloud ` +
        `assembly at ${templatePath}.`,
    );
  }

  const template = await json.read(templatePath, StackTemplateSchema);
  return Object.values(template.Resources).filter(
    (resource) => resource.Type !== METADATA_RESOURCE_TYPE,
  ).length;
}
