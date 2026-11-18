import z from "zod";
import { flag } from "../../../router";
import { parseJsonFlagWithSchema } from "../../utils";
import {
  isReservedBuildArgKey,
  ProjectRuntimeSchema,
  RESERVED_BUILD_ARG_KEYS,
} from "../../../projectSchemas/runtime";
import { HarnessSpecSchema } from "../../../projectSchemas/harness";

export const ADVANCED = "Advanced:";

// Keys map 1:1 to the build fields in agentcore.json and harness.yaml. dockerfile
// is a path to an existing Dockerfile: it is copied into the resource directory
// unless buildContextPath is set, in which case it is relative to that context.
const buildFields = {
  dockerfile: z.string().min(1).optional(),
  buildContextPath: ProjectRuntimeSchema.shape.buildContextPath,
  customDockerBuildArgs: ProjectRuntimeSchema.shape.customDockerBuildArgs.refine(
    (args) => !Object.keys(args ?? {}).some(isReservedBuildArgKey),
    `customDockerBuildArgs must not use keys reserved by the build environment (${RESERVED_BUILD_ARG_KEYS.join(", ")}, CODEBUILD_*, AWS_*)`,
  ),
};
export const RuntimeBuildConfigSchema = z.strictObject({
  build: ProjectRuntimeSchema.shape.build.optional(),
  ...buildFields,
});
export const HarnessBuildConfigSchema = z.strictObject({
  build: HarnessSpecSchema.shape.build,
  ...buildFields,
});

export function buildConfigFlag(builds: string) {
  return flag(
    "build-config",
    `advanced build settings (JSON object): build (${builds}), dockerfile, buildContextPath, ` +
      "customDockerBuildArgs. Build args are not secret: they appear in logs and image metadata",
    z.string().optional(),
    { group: ADVANCED },
  );
}

export function parseBuildConfig<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  return parseJsonFlagWithSchema("build-config", raw, schema);
}
