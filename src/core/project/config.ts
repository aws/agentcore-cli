import z from "zod";
import { DeploymentTargetSchema, ProjectNameSchema } from "../../handlers/project/types";

/**
 * Validates only the project fields that build needs. Resource definitions are
 * intentionally left to their owning commands and deployment backend.
 */
export const ProjectSpecEnvelopeSchema = z
  .object({
    name: ProjectNameSchema,
    version: z.number().int().min(1),
    managedBy: z.string().min(1).default("CDK"),
  })
  .passthrough();

export const DeploymentTargetsSchema = z
  .array(DeploymentTargetSchema)
  .superRefine((targets, ctx) => {
    const seen = new Set<string>();
    targets.forEach((target, index) => {
      if (seen.has(target.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate deployment target name: ${target.name}`,
          path: [index, "name"],
        });
      }
      seen.add(target.name);
    });
  });
