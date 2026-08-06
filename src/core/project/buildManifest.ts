import z from "zod";
import { DeploymentTargetSchema } from "../../handlers/project/types";

export { DeploymentTargetSchema, type DeploymentTarget } from "../../handlers/project/types";

/** Relative to the project root; build writes this file and deploy reads it. */
export const BUILD_MANIFEST_PATH = "agentcore/.build/manifest.json";

export const BUILD_MANIFEST_VERSION = 1;

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
 * Persisted handoff from build to deploy
 *
 * Deploy requires a new build when the manifest is missing, unreadable, invalid, has an unsupported
 * manifest version, or its input fingerprint differs from the current project inputs. Otherwise,
 * deploy uses the typed artifact to select its backend.
 */
export const BuildManifestSchema = z
  .object({
    manifestVersion: z.literal(BUILD_MANIFEST_VERSION),
    projectName: z.string().min(1),
    cliVersion: z.string().min(1),
    /** Deploy recomputes this hash to reject artifacts built from stale project inputs. */
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    builtAt: z.iso.datetime(),
    targets: z.array(DeploymentTargetSchema).min(1, "must include at least one deployment target"),
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
