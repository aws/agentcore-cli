import z from "zod";

/** Relative to the project root; build writes this file and deploy reads it. */
export const BUILD_MANIFEST_PATH = "agentcore/.build/manifest.json";

export const BUILD_MANIFEST_VERSION = 1;

export const DeploymentTargetSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-zA-Z][a-zA-Z0-9-]*$/,
        "must start with a letter and contain only letters, numbers, and hyphens",
      ),
    description: z.string().max(256).optional(),
    account: z.string().regex(/^[0-9]{12}$/, "must be a 12-digit AWS account ID"),
    region: z.string().min(1),
  })
  .strict();

export type DeploymentTarget = z.infer<typeof DeploymentTargetSchema>;

const ProjectRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.startsWith("\\") &&
      !/^[a-zA-Z]:[\\/]/.test(path) &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "must be a non-empty path relative to the project root",
  );

const CdkCloudAssemblyArtifactSchema = z
  .object({
    kind: z.literal("cdk-cloud-assembly"),
    path: ProjectRelativePathSchema,
    stacksByTarget: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

/**
 * The artifact is the deploy dispatch point. Add a new discriminated variant
 * before implementing another deployment mechanism.
 */
export const BuildArtifactSchema = z.discriminatedUnion("kind", [CdkCloudAssemblyArtifactSchema]);

export type BuildArtifact = z.infer<typeof BuildArtifactSchema>;

/**
 * Persisted handofffrom build to deploy
 *
 * Deploy requires a new build when the manifest is missing, unreadable, not valid, has unsupported manifestVerison,
 * or if its inputFinderprint differs from current project inputs. Otherwise, deploy would use the
 * typed artifact to select its backend
 */
export const BuildManifestSchema = z
  .object({
    manifestVersion: z.literal(BUILD_MANIFEST_VERSION),
    projectName: z.string().min(1),
    cliVersion: z.string().min(1),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    builtAt: z.iso.datetime(),
    targets: z.array(DeploymentTargetSchema),
    artifact: BuildArtifactSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const targetNames = new Set<string>();

    for (const [index, target] of manifest.targets.entries()) {
      if (targetNames.has(target.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate deployment target name: ${target.name}`,
          path: ["targets", index, "name"],
        });
      }
      targetNames.add(target.name);
    }

    if (manifest.artifact.kind !== "cdk-cloud-assembly") return;

    const stackTargets = new Set(Object.keys(manifest.artifact.stacksByTarget));
    for (const targetName of targetNames) {
      if (!stackTargets.has(targetName)) {
        ctx.addIssue({
          code: "custom",
          message: `missing stack for deployment target: ${targetName}`,
          path: ["artifact", "stacksByTarget"],
        });
      }
    }
    for (const targetName of stackTargets) {
      if (!targetNames.has(targetName)) {
        ctx.addIssue({
          code: "custom",
          message: `stack is configured for an unknown deployment target: ${targetName}`,
          path: ["artifact", "stacksByTarget", targetName],
        });
      }
    }
  });

export type BuildManifest = z.infer<typeof BuildManifestSchema>;

/** The JSON response emitted by `agentcore project build`. */
export const BuildResultSchema = z
  .object({
    manifestPath: z.literal(BUILD_MANIFEST_PATH),
    manifest: BuildManifestSchema,
  })
  .strict();

export type BuildResult = z.infer<typeof BuildResultSchema>;
