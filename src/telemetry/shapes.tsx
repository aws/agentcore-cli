import z from "zod";
import { ERROR_SOURCE } from "../errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const MAX_ATTR_LENGTH = 64;

/**
 * Resource attributes that are attached to every metric datapoint.
 * Set once per session, not metric.
 */
export const resourceAttributesSchema = z.object({
  "service.name": z.literal("agentcore-cli"),
  "service.version": z.string().regex(SEMVER_PATTERN),
  "agentcore-cli.installation_id": z.string().regex(UUID_PATTERN),
  "agentcore-cli.session_id": z.string().regex(UUID_PATTERN),
  "os.type": z.string().min(1).max(MAX_ATTR_LENGTH),
  "os.version": z.string().min(1).max(MAX_ATTR_LENGTH),
  "host.arch": z.string().min(1).max(MAX_ATTR_LENGTH),
  "node.version": z.string().regex(NODE_VERSION_PATTERN),
});

/**
 * Type derived from {@link resourceAttributesSchema}
 */
export type ResourceAttributes = z.infer<typeof resourceAttributesSchema>;

// We make an exception for command paths becase they are validated as part of their construction.
// We still apply a reasonable narrowing here to avoid leakage.
const commandPathSchema = z
  .string()
  .max(128)
  .regex(/^\/agentcore(\/[a-z][a-z0-9-]*)*$/, "command_path must be a valid CLI command path")
  .catch("unknown") as unknown as BaseEnumeratedField;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BaseEnumeratedField = z.ZodEnum<any> | z.ZodBoolean | z.ZodNumber | z.ZodLiteral<any>;
type EnumeratedField =
  | BaseEnumeratedField
  | z.ZodOptional<BaseEnumeratedField>
  | z.ZodDefault<BaseEnumeratedField>
  | z.ZodCatch<BaseEnumeratedField>;

/** Adds a compile time check that the given object has no free-form fields to prevent PII leakage **/
function safeSchema<T extends Record<string, EnumeratedField>>(shape: T) {
  return z.object(shape);
}

// We make an exception for error names because they are validated in the
// classification. We still apply a reasonable narrowing here to avoid leakage.
const errorNameSchema = z
  .string()
  .max(64)
  .refine((s) => s.endsWith("Error") || s.endsWith("Exception"), {
    message: "error_name must end with 'Error' or 'Exception'",
  })
  .catch("UnknownError") as unknown as BaseEnumeratedField;

export const commandRunSchema = safeSchema({
  exit_reason: z.enum(["success", "failure"]),
  command_path: commandPathSchema,
  error_name: errorNameSchema.optional(),
  error_source: z.enum(Object.values(ERROR_SOURCE)).optional(),
  is_tui: z.boolean().default(false),
});
