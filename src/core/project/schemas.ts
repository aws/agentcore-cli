import z from "zod";
import { ProjectNameSchema } from "../../handlers/project/types";

export const ProjectSpecEnvelopeSchema = z
  .object({
    name: ProjectNameSchema,
    version: z.number().int().min(1),
    managedBy: z.string().min(1).default("CDK"),
  })
  .passthrough();

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

export const BuildManifestSchema = z
  .object({
    version: z.literal(1),
    projectName: z.string().min(1),
    backend: z.string().min(1),
    cliVersion: z.string().min(1),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    builtAt: z.iso.datetime(),
    cloudAssemblyPath: z.string().min(1),
    targets: z.array(
      DeploymentTargetSchema.extend({
        stackName: z.string().min(1),
      }),
    ),
  })
  .strict();

export const CloudAssemblyManifestSchema = z
  .object({
    artifacts: z.record(
      z.string(),
      z
        .object({
          type: z.string(),
          properties: z
            .object({
              stackName: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
