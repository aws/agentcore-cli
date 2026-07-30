import z from "zod";
import { ERROR_SOURCE } from "../errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
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

/**
 * List of all invocable command paths in the CLI that should emit telemetry.
 */
export const COMMAND_PATHS = [
  // root
  "/agentcore",

  // harness
  "/agentcore/harness",
  "/agentcore/harness/create",
  "/agentcore/harness/get",
  "/agentcore/harness/list",
  "/agentcore/harness/update",
  "/agentcore/harness/delete",
  "/agentcore/harness/invoke",
  "/agentcore/harness/exec",
  "/agentcore/harness/endpoint",
  "/agentcore/harness/endpoint/create",
  "/agentcore/harness/endpoint/get",
  "/agentcore/harness/endpoint/list",
  "/agentcore/harness/endpoint/update",
  "/agentcore/harness/endpoint/delete",
  "/agentcore/harness/version",
  "/agentcore/harness/version/get",
  "/agentcore/harness/version/list",

  // identity
  "/agentcore/identity",
  "/agentcore/identity/api-key-credential-provider",
  "/agentcore/identity/api-key-credential-provider/create",
  "/agentcore/identity/api-key-credential-provider/get",
  "/agentcore/identity/api-key-credential-provider/list",
  "/agentcore/identity/api-key-credential-provider/update",
  "/agentcore/identity/api-key-credential-provider/delete",

  // runtime
  "/agentcore/runtime",
  "/agentcore/runtime/get",
  "/agentcore/runtime/list",
  "/agentcore/runtime/invoke",
  "/agentcore/runtime/version",
  "/agentcore/runtime/version/get",
  "/agentcore/runtime/version/list",
  "/agentcore/runtime/endpoint",
  "/agentcore/runtime/endpoint/get",
  "/agentcore/runtime/endpoint/list",

  // eval
  "/agentcore/eval",
  "/agentcore/eval/evaluator",
  "/agentcore/eval/evaluator/llm-as-a-judge",
  "/agentcore/eval/evaluator/llm-as-a-judge/create",
  "/agentcore/eval/evaluator/llm-as-a-judge/update",
  "/agentcore/eval/evaluator/code-based",
  "/agentcore/eval/evaluator/code-based/create",
  "/agentcore/eval/evaluator/code-based/update",
  "/agentcore/eval/evaluator/get",
  "/agentcore/eval/evaluator/list",
  "/agentcore/eval/evaluator/delete",

  // config
  "/agentcore/config",

  // project
  "/agentcore/project/create",
] as const;

export type CommandPath = (typeof COMMAND_PATHS)[number];

const commandPathSchema = z.enum([...COMMAND_PATHS, "unknown"]).catch("unknown");

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
});
