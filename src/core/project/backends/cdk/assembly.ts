import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors/errors";
import type { ReadWriteJson } from "../../../../io";

const TARGET_TAG = "agentcore:target-name";
const STACK_ARTIFACT = "aws:cloudformation:stack";
/** The resource CDK adds to every stack of its own accord, which no user asked for. */
const METADATA_RESOURCE_TYPE = "AWS::CDK::Metadata";
const SECURE_VPC_TAG = "agentcore:secure-vpc";
const SecureVpcTagsSchema = z.object({
  Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
});

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

/** A stack output that exports `Fn::GetAtt` of a resource, as each runtime's `RuntimeId` does. */
const GetAttOutputSchema = z.object({
  Value: z.object({ "Fn::GetAtt": z.tuple([z.string(), z.string()]) }),
  Export: z.object({ Name: z.string() }),
});
const PlatformVersionPropertiesSchema = z.object({ PlatformVersion: z.string() });

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
    Outputs: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

/**
 * The command that synthesizes a project's vended CDK app (run in its
 * `agentcore/cdk` directory) into a cloud assembly at `outputDirectory`. Builds
 * the app first, through its `cdk` npm script.
 */
export function synthCommand(outputDirectory: string): string[] {
  return ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", outputDirectory];
}

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
  const template = await readStackTemplate(json, assemblyDirectory, artifact);
  return Object.values(template.Resources).filter(
    (resource) => resource.Type !== METADATA_RESOURCE_TYPE,
  ).length;
}

/**
 * Refuses a stack that leaves a `PRIVATE_VPC` runtime without its private VPC. A CDK library
 * from before containment drops the field without an error and would deploy the runtime with an
 * internet path. The CDK library tags each private VPC `agentcore:secure-vpc` with
 * `<stack>/<runtime>`.
 */
export async function assertPrivateVpcs(
  json: ReadWriteJson,
  assemblyDirectory: string,
  artifact: StackArtifact,
  runtimeNames: readonly string[],
): Promise<void> {
  if (runtimeNames.length === 0) return;
  const template = await readStackTemplate(json, assemblyDirectory, artifact);
  const tagged = new Set(
    Object.values(template.Resources)
      .filter((resource) => resource.Type === "AWS::EC2::VPC")
      .flatMap((resource) => SecureVpcTagsSchema.safeParse(resource.Properties).data?.Tags ?? [])
      .filter((tag) => tag.Key === SECURE_VPC_TAG)
      .map((tag) => tag.Value.slice(tag.Value.lastIndexOf("/") + 1)),
  );
  const missing = runtimeNames.filter((name) => !tagged.has(name));
  if (missing.length > 0) {
    throw new ProjectStateError(
      `Runtime ${missing.map((name) => `'${name}'`).join(", ")} has "containment": "PRIVATE_VPC", ` +
        "but the synthesized stack builds no private VPC for it. The @aws/agentcore-cdk in " +
        "agentcore/cdk is older than containment: update it, then deploy again.",
    );
  }
}

/**
 * The runtimes whose platform deploy checks after synth: each one that names a `platformVersion`,
 * in a Box project or not, `"V1"` included, since a CDK library from before the field drops it.
 */
export function runtimePlatformVersions(
  runtimes: readonly { readonly name: string; readonly platformVersion?: string }[],
): { name: string; platformVersion: string }[] {
  return runtimes.flatMap(({ name, platformVersion }) =>
    platformVersion === undefined ? [] : [{ name, platformVersion }],
  );
}

/**
 * Refuses a stack in which a runtime of `runtimes` does not run on its own `platformVersion`. A
 * CDK library from before `platformVersion` drops the field without an error, and the service
 * would pick the platform. The CDK library exports each runtime's ID as
 * `<stack>-<runtime>-RuntimeId` (`_` as `-`), from `Fn::GetAtt` of its
 * `AWS::BedrockAgentCore::Runtime`; a runtime with no such export is refused too, as one whose
 * platform deploy cannot check.
 */
export async function assertPlatformVersions(
  json: ReadWriteJson,
  assemblyDirectory: string,
  artifact: StackArtifact,
  runtimes: readonly { readonly name: string; readonly platformVersion: string }[],
): Promise<void> {
  if (runtimes.length === 0) return;
  const template = await readStackTemplate(json, assemblyDirectory, artifact);
  const logicalIdByExport = new Map(
    Object.values(template.Outputs).flatMap((output) => {
      const parsed = GetAttOutputSchema.safeParse(output).data;
      return parsed ? [[parsed.Export.Name, parsed.Value["Fn::GetAtt"][0]] as const] : [];
    }),
  );
  // The CDK library's exportName: each part with `_` as `-` and every other character but
  // letters, digits, `:` and `-` removed, joined with `-`.
  const exportName = (...parts: string[]) =>
    parts.map((part) => part.replace(/_/g, "-").replace(/[^a-zA-Z0-9:-]/g, "")).join("-");
  const problems = runtimes.flatMap(({ name, platformVersion }) => {
    const logicalId = logicalIdByExport.get(exportName(artifact.stackName, name, "RuntimeId"));
    const resource = logicalId === undefined ? undefined : template.Resources[logicalId];
    if (resource === undefined) {
      return [
        `Could not find runtime '${name}' in the synthesized stack '${artifact.stackName}', so ` +
          `deploy cannot check that it runs on "platformVersion": "${platformVersion}".`,
      ];
    }
    const synthesized = PlatformVersionPropertiesSchema.safeParse(resource.Properties).data;
    if (synthesized?.PlatformVersion === platformVersion) return [];
    return [
      `Runtime '${name}' has "platformVersion": "${platformVersion}", but the synthesized stack ` +
        "does not set it. The @aws/agentcore-cdk in agentcore/cdk is older than platformVersion: " +
        "update it to a release that has platformVersion, then deploy again.",
    ];
  });
  if (problems.length > 0) throw new ProjectStateError(problems.join("\n"));
}

async function readStackTemplate(
  json: ReadWriteJson,
  assemblyDirectory: string,
  artifact: StackArtifact,
): Promise<z.infer<typeof StackTemplateSchema>> {
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

  return json.read(templatePath, StackTemplateSchema);
}
