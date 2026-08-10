import { z } from "zod";
export const SchemaPrimitiveTypeSchema = z.enum([
  "string",
  "number",
  "object",
  "array",
  "boolean",
  "integer",
]);
export type SchemaPrimitiveType = z.infer<typeof SchemaPrimitiveTypeSchema>;
export type SchemaDefinition = {
  type: SchemaPrimitiveType;
  description?: string;
  items?: SchemaDefinition;
  properties?: Record<string, SchemaDefinition>;
  required?: string[];
};
export const SchemaDefinitionSchema: z.ZodType<SchemaDefinition> = z.object({
  type: SchemaPrimitiveTypeSchema,
  description: z.string().optional(),
  items: z.lazy(() => SchemaDefinitionSchema).optional(),
  properties: z.lazy(() => z.record(z.string(), SchemaDefinitionSchema)).optional(),
  required: z.array(z.string()).optional(),
});
export const ToolNameSchema = z
  .string()
  .min(1, "Tool name is required")
  .max(128, "Tool name must be at most 128 characters")
  .regex(
    /^[a-zA-Z][a-zA-Z0-9-]*$/,
    "Tool name must start with a letter and contain only alphanumeric characters or hyphens",
  );
export const ToolDefinitionSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().min(1),
    inputSchema: SchemaDefinitionSchema,
    outputSchema: SchemaDefinitionSchema.optional(),
  })
  .strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export const AgentCoreCliMcpDefsSchema = z.object({
  tools: z.record(z.string(), ToolDefinitionSchema),
});
export type AgentCoreCliMcpDefs = z.infer<typeof AgentCoreCliMcpDefsSchema>;
