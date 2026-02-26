import { z } from 'zod';

// ============================================================================
// Schema Primitive Types
// ============================================================================

export const SchemaPrimitiveTypeSchema = z.enum(['string', 'number', 'object', 'array', 'boolean', 'integer']);
export type SchemaPrimitiveType = z.infer<typeof SchemaPrimitiveTypeSchema>;

// ============================================================================
// Schema Definition (recursive)
// ============================================================================

/**
 * Opaque schema definition for tool input/output.
 * This is passed through to CloudFormation without validation.
 */
export interface SchemaDefinition {
  type: SchemaPrimitiveType;
  description?: string;
  items?: SchemaDefinition;
  properties?: Record<string, SchemaDefinition>;
  required?: string[];
}

export const SchemaDefinitionSchema: z.ZodType<SchemaDefinition> = z.object({
  type: SchemaPrimitiveTypeSchema,
  description: z.string().optional(),
  items: z.lazy(() => SchemaDefinitionSchema).optional(),
  properties: z.lazy(() => z.record(z.string(), SchemaDefinitionSchema)).optional(),
  required: z.array(z.string()).optional(),
});

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * Tool name validation for CLI input.
 * Allows alphanumeric characters, hyphens, and underscores.
 * This is a general-purpose schema for tool names that works for both
 * MCP runtime tools (direct) and gateway target tools.
 */
export const ToolNameSchema = z
  .string()
  .min(1, 'Tool name is required')
  .max(128, 'Tool name must be at most 128 characters')
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    'Tool name must start with a letter and contain only alphanumeric characters, hyphens, or underscores'
  );

/**
 * Gateway Target Definition schema.
 */
export const ToolDefinitionSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().min(1),
    inputSchema: SchemaDefinitionSchema,
    outputSchema: SchemaDefinitionSchema.optional(),
  })
  .strict();

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

// ============================================================================
// MCP Definitions File (mcp-defs.json)
// ============================================================================

/**
 * Top-level MCP definitions file schema (mcp-defs.json).
 */
export const AgentCoreCliMcpDefsSchema = z.object({
  tools: z.record(z.string(), ToolDefinitionSchema),
});

export type AgentCoreCliMcpDefs = z.infer<typeof AgentCoreCliMcpDefsSchema>;
