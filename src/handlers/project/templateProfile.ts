import { z } from "zod";
import {
  DockerfilePathSchema,
  EntrypointSchema,
  LifecycleConfigurationSchema,
} from "../../projectSchemas/runtime";
import { TagsSchema } from "../../projectSchemas/tags";

/**
 * Template-specific behavior that cannot be expressed by the framework,
 * language, protocol, and build fields alone.
 *
 * Profiles are internal scaffold metadata. They are consumed while creating the
 * project tree and are not persisted in agentcore.json.
 */
export const RuntimeTemplateProfileSchema = z
  .object({
    /** False when the Runtime hosts an environment but runs no model itself. */
    usesModel: z.boolean().optional(),
    /**
     * "managed" uses the template's dependency manifest to install local
     * dependencies and generate container lockfiles. "deferred" leaves both to
     * the generated template and its user.
     */
    dependencySetup: z.enum(["managed", "deferred"]).optional(),
    /** Runtime settings required by the template. Explicit Runtime input wins for scalar settings. */
    runtime: z
      .object({
        entrypoint: EntrypointSchema.optional(),
        dockerfile: DockerfilePathSchema.optional(),
        lifecycleConfiguration: LifecycleConfigurationSchema.optional(),
        additionalPolicies: z.array(z.string().min(1)).optional(),
        tags: TagsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RuntimeTemplateProfile = z.infer<typeof RuntimeTemplateProfileSchema>;

export function templateUsesModel(profile: RuntimeTemplateProfile | undefined): boolean {
  return profile?.usesModel !== false;
}

export function templateManagesDependencies(profile: RuntimeTemplateProfile | undefined): boolean {
  return profile?.dependencySetup !== "deferred";
}
