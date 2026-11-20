import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors";
import type { ReadWriteJson } from "../../../../io";
import type { WorkloadBuilds } from "../../../../handlers/project/types";
import { workloadEntries } from "./localContainers";

// The assembly's manifest.json, which each synth rewrites: only the stacks it lists,
// and the asset manifests they depend on, are current. Older files can linger.
const AssemblyManifestSchema = z.object({
  artifacts: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        dependencies: z.array(z.string()).optional(),
        properties: z
          .object({ file: z.string().optional(), templateFile: z.string().optional() })
          .passthrough()
          .optional(),
      }),
    )
    .default({}),
});

const WorkloadKeySchema = z.string().regex(/^(runtime|harness)\/.+$/);

// The companion CDK package records each ContainerLocal workload's image in its
// stack template: workload key -> key of the image under the asset manifest's
// dockerImages.
const LocalImagesSchema = z.record(WorkloadKeySchema, z.string().min(1));
const StackTemplateSchema = z.object({
  Metadata: z.object({ "agentcore:localImages": z.unknown() }).passthrough().optional(),
});

// The parts of a cloud assembly asset manifest (`<stack>.assets.json`) that
// describe how CDK builds a Docker image asset.
const AssetManifestSchema = z.object({
  dockerImages: z
    .record(
      z.string(),
      z.object({
        source: z.object({
          directory: z.string().optional(),
          dockerFile: z.string().optional(),
          dockerBuildArgs: z.record(z.string(), z.string()).optional(),
          platform: z.string().optional(),
        }),
      }),
    )
    .default({}),
});

export type LocalImageBuild = {
  /** `runtime/<name>` or `harness/<name>`. */
  resource: string;
  tag: string;
  /** The staged, already filtered build context inside the assembly. */
  directory: string;
  /** `load` adds --load, which Docker with a non-default buildx driver needs to keep the image. */
  command: (executable: string, options?: { load?: boolean }) => string[];
};

const tagComponent = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");

const cdkMismatch = (detail: string) =>
  new ProjectStateError(
    `${detail} The project's @aws/agentcore-cdk package is too old for ContainerLocal or does ` +
      "not match this CLI. Update the dependency in agentcore/cdk and run npm install.",
  );

/**
 * The ContainerLocal images the synthesized assembly's stacks declare, as local
 * build commands. Images shared by several target stacks are built once.
 * Throws when a ContainerLocal workload has no recorded image.
 */
export async function localImageBuilds(
  json: ReadWriteJson,
  assemblyDirectory: string,
  projectName: string,
  builds: WorkloadBuilds,
): Promise<LocalImageBuild[]> {
  const manifestPath = join(assemblyDirectory, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  const { artifacts } = await json.read(manifestPath, AssemblyManifestSchema);
  const expected = workloadEntries(builds)
    .filter(([, build]) => build === "ContainerLocal")
    .map(([key]) => key);
  const found = new Set<string>();
  const images = new Map<string, LocalImageBuild>();

  for (const [stackId, stack] of Object.entries(artifacts)) {
    if (stack.type !== "aws:cloudformation:stack" || !stack.properties?.templateFile) continue;
    const template = await json.read(
      join(assemblyDirectory, stack.properties.templateFile),
      StackTemplateSchema,
    );
    const parsed = LocalImagesSchema.safeParse(template.Metadata?.["agentcore:localImages"] ?? {});
    if (!parsed.success) {
      throw cdkMismatch(
        `Stack ${stackId} has invalid "agentcore:localImages" metadata: expected an object ` +
          "mapping runtime/<name> or harness/<name> to an image asset hash.",
      );
    }
    const recorded = parsed.data;
    if (Object.keys(recorded).length === 0) continue;
    const assetFiles = (stack.dependencies ?? [])
      .map((dependency) => artifacts[dependency])
      .filter((artifact) => artifact?.type === "cdk:asset-manifest")
      .flatMap((artifact) => (artifact?.properties?.file ? [artifact.properties.file] : []));
    const dockerImages: z.infer<typeof AssetManifestSchema>["dockerImages"] = {};
    for (const file of assetFiles) {
      Object.assign(
        dockerImages,
        (await json.read(join(assemblyDirectory, file), AssetManifestSchema)).dockerImages,
      );
    }

    for (const [resource, hash] of Object.entries(recorded)) {
      const image = dockerImages[hash];
      if (!image) {
        throw cdkMismatch(
          `Stack ${stackId} records image ${hash} for ${resource}, but its asset manifest has no such image.`,
        );
      }
      found.add(resource);
      if (images.has(hash)) continue;
      const { directory, dockerFile, dockerBuildArgs, platform } = image.source;
      if (!directory) {
        throw cdkMismatch(
          `The asset manifest of stack ${stackId} has no build context for ${resource}.`,
        );
      }
      const tag = `agentcore-local/${tagComponent(`${projectName}-${resource.replace("/", "-")}`)}:${hash}`;
      images.set(hash, {
        resource,
        tag,
        directory: resolve(assemblyDirectory, directory),
        command: (executable, options) => [
          executable,
          "build",
          ...(options?.load ? ["--load"] : []),
          "--platform",
          platform ?? "linux/arm64",
          "--tag",
          tag,
          ...(dockerFile ? ["--file", dockerFile] : []),
          ...Object.entries(dockerBuildArgs ?? {}).flatMap(([key, value]) => [
            "--build-arg",
            `${key}=${value}`,
          ]),
          ".",
        ],
      });
    }
  }

  const missing = expected.filter((key) => !found.has(key));
  if (missing.length > 0) {
    throw cdkMismatch(
      `The synthesized stacks record no local image for ${missing.join(", ")} ` +
        '(no "agentcore:localImages" entry).',
    );
  }
  return [...images.values()];
}
