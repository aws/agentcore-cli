import { z } from "zod";
export const GatewayGrantTypeSchema = z.enum([
  "CLIENT_CREDENTIALS",
  "AUTHORIZATION_CODE",
  "TOKEN_EXCHANGE",
]);
export type GatewayGrantType = z.infer<typeof GatewayGrantTypeSchema>;
export const GatewayOutboundAuthSchema = z.union([
  z.object({ awsIam: z.object({}).strict() }).strict(),
  z.object({ none: z.object({}).strict() }).strict(),
  z
    .object({
      oauth: z
        .object({
          providerArn: z.string().min(1),
          scopes: z.array(z.string().min(1)),
          grantType: GatewayGrantTypeSchema.optional(),
          customParameters: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type GatewayOutboundAuth = z.infer<typeof GatewayOutboundAuthSchema>;
const MEMORY_ARN_PATTERN = /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:memory\/.+$/;
const GATEWAY_ARN_PATTERN = /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:gateway\/.+$/;
const RUNTIME_ARN_PATTERN = /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/.+$/;
export const BROWSER_ARN_PATTERN =
  /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:(\d{12}|aws):browser(-custom)?\/.+$/;
export const CODE_INTERPRETER_ARN_PATTERN =
  /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:(\d{12}|aws):code-interpreter(-custom)?\/.+$/;
const MemoryTargetSchema = z
  .object({
    type: z.literal("memory"),
    arn: z.string().regex(MEMORY_ARN_PATTERN, "Must be a valid bedrock-agentcore memory ARN"),
    namespaces: z.array(z.string().min(1)).optional(),
  })
  .strict();
const GatewayTargetSchema = z
  .object({
    type: z.literal("gateway"),
    arn: z.string().regex(GATEWAY_ARN_PATTERN, "Must be a valid bedrock-agentcore gateway ARN"),
    outboundAuth: GatewayOutboundAuthSchema.optional(),
  })
  .strict();
const RuntimeTargetSchema = z
  .object({
    type: z.literal("runtime"),
    arn: z.string().regex(RUNTIME_ARN_PATTERN, "Must be a valid bedrock-agentcore runtime ARN"),
    exec: z.boolean().optional(),
  })
  .strict();
const BrowserTargetSchema = z
  .object({
    type: z.literal("browser"),
    arn: z
      .string()
      .regex(BROWSER_ARN_PATTERN, "Must be a valid bedrock-agentcore browser ARN")
      .optional(),
  })
  .strict();
const CodeInterpreterTargetSchema = z
  .object({
    type: z.literal("codeInterpreter"),
    arn: z
      .string()
      .regex(CODE_INTERPRETER_ARN_PATTERN, "Must be a valid bedrock-agentcore code-interpreter ARN")
      .optional(),
  })
  .strict();
export const ConnectionTargetSchema = z.discriminatedUnion("type", [
  MemoryTargetSchema,
  GatewayTargetSchema,
  RuntimeTargetSchema,
  BrowserTargetSchema,
  CodeInterpreterTargetSchema,
]);
export type ConnectionTarget = z.infer<typeof ConnectionTargetSchema>;
export const ConnectionSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/,
        "Connection id must match [a-zA-Z][a-zA-Z0-9_-]{0,63}",
      )
      .optional(),
    to: ConnectionTargetSchema,
    access: z.enum(["read", "readwrite"]).optional(),
    description: z.string().max(200).optional(),
  })
  .strict();
export type Connection = z.infer<typeof ConnectionSchema>;
export const ConnectionsSchema = z.array(ConnectionSchema);
