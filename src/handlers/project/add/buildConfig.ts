import z from "zod";
import { flag } from "../../../router";
import { parseJsonFlagWithSchema } from "../../utils";
import { isAbsolute } from "node:path";
import {
  containerUriIssues,
  DockerfilePathSchema,
  isReservedBuildArgKey,
  ProjectRuntimeSchema,
  RESERVED_BUILD_ARG_KEYS,
} from "../../../projectSchemas/runtime";
import { HarnessSpecSchema } from "../../../projectSchemas/harness";

export const ADVANCED = "Advanced:";

// Keys map 1:1 to the build fields in agentcore.json and harness.yaml. dockerfile
// is a path to an existing Dockerfile: it is copied into the resource directory
// unless buildContextPath is set, in which case it is relative to that context.
// Every rule a --build-config value can break is checked here, so the error names
// --build-config instead of surfacing later against agentcore.json or harness.yaml.
const buildFields = {
  dockerfile: z.string().min(1).optional(),
  buildContextPath: ProjectRuntimeSchema.shape.buildContextPath.refine(
    (path) => path === undefined || !isAbsolute(path),
    "buildContextPath must be relative to the project root, not an absolute path",
  ),
  customDockerBuildArgs: ProjectRuntimeSchema.shape.customDockerBuildArgs,
};

type BuildConfigFields = {
  build?: string;
  dockerfile?: string;
  buildContextPath?: string;
  customDockerBuildArgs?: Record<string, string>;
};

/** Rules across fields; `defaultBuild` is the build when "build" is omitted. */
function checkBuildFields(data: BuildConfigFields, ctx: z.RefinementCtx, defaultBuild?: string) {
  if (data.buildContextPath !== undefined && data.dockerfile !== undefined) {
    const dockerfile = DockerfilePathSchema.safeParse(data.dockerfile);
    if (!dockerfile.success) {
      ctx.addIssue({
        code: "custom",
        message:
          "with buildContextPath, dockerfile must be relative to that build context: " +
          (dockerfile.error.issues[0]?.message ?? "invalid path"),
        path: ["dockerfile"],
      });
    }
  }
  // The reserved keys are the CodeBuild build environment's; a ContainerLocal image
  // builds on the local machine, where they collide with nothing.
  if ((data.build ?? defaultBuild) !== "ContainerLocal") {
    if (Object.keys(data.customDockerBuildArgs ?? {}).some(isReservedBuildArgKey)) {
      ctx.addIssue({
        code: "custom",
        message:
          "customDockerBuildArgs must not use keys reserved by the CodeBuild build environment " +
          `(${RESERVED_BUILD_ARG_KEYS.join(", ")}, CODEBUILD_*, AWS_*); ContainerLocal builds ` +
          "allow them",
        path: ["customDockerBuildArgs"],
      });
    }
  }
}

export const RuntimeBuildConfigSchema = z
  .strictObject({
    build: ProjectRuntimeSchema.shape.build.optional(),
    // A pre-built ECR image; deployed as is, with build "Container" (the default).
    containerUri: ProjectRuntimeSchema.shape.containerUri,
    ...buildFields,
  })
  .superRefine((data, ctx) => {
    if (data.containerUri !== undefined) {
      for (const issue of containerUriIssues(data)) ctx.addIssue({ code: "custom", ...issue });
      return;
    }
    const container = data.build === "Container" || data.build === "ContainerLocal";
    if (container && data.dockerfile === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "dockerfile is required for a Container or ContainerLocal build",
        path: ["dockerfile"],
      });
    }
    for (const field of ["dockerfile", "buildContextPath", "customDockerBuildArgs"] as const) {
      if (!container && data[field] !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${field} requires build Container or ContainerLocal`,
          path: [field],
        });
      }
    }
    checkBuildFields(data, ctx);
  });
export const HarnessBuildConfigSchema = z
  .strictObject({ build: HarnessSpecSchema.shape.build, ...buildFields })
  .superRefine((data, ctx) => checkBuildFields(data, ctx, "Container"));

export function buildConfigFlag(builds: string, extraKeys = "") {
  return flag(
    "build-config",
    `advanced build settings (JSON object): build (${builds}), ${extraKeys}dockerfile, ` +
      "buildContextPath, customDockerBuildArgs. Without buildContextPath, dockerfile is a path " +
      "relative to the current directory, copied once to app/<name>/Dockerfile (app/<name>/ is " +
      "the build context). With buildContextPath (relative to the project root), dockerfile is " +
      "relative to that build context and used in place. Build args are not secret: they " +
      "appear in logs and image metadata",
    z.string().optional(),
    { group: ADVANCED },
  );
}

export function parseBuildConfig<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  return parseJsonFlagWithSchema("build-config", raw, schema);
}
