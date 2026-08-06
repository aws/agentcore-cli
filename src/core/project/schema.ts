import z from "zod";

/**
 * The agentcore.json file format. `create` writes through this schema and
 * `resolve` parses with it, so the two can never drift apart. Strict: unknown
 * keys are errors. New sections (memory, gateway, ...) are added here as the
 * CLI grows support for them.
 */
export const ProjectSpecSchema = z.strictObject({
  name: z.string().min(1),
  version: z.literal(1),
  managedBy: z.literal("CDK"),
  runtimes: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        build: z.enum(["CodeZip", "Container"]),
        entrypoint: z.string().min(1),
        codeLocation: z.string().min(1),
        dockerfile: z.string().optional(),
      }),
    )
    .default([]),
});

export type ProjectSpec = z.infer<typeof ProjectSpecSchema>;

export type ProjectRuntime = z.infer<typeof ProjectSpecSchema>["runtimes"][number];
