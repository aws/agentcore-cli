import { uniqueBy } from "./zod-util";
import { TagsSchema } from "./tags";
import { z } from "zod";
export const PolicyEngineNameSchema = z
  .string()
  .min(1, "Policy engine name is required")
  .max(48, "Policy engine name must be 48 characters or less")
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const PolicyNameSchema = z
  .string()
  .min(1, "Policy name is required")
  .max(48, "Policy name must be 48 characters or less")
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const ValidationModeSchema = z.enum(["FAIL_ON_ANY_FINDINGS", "IGNORE_ALL_FINDINGS"]);
export type ValidationMode = z.infer<typeof ValidationModeSchema>;
export const AuthorizationPhaseSchema = z.enum(["INITIATE", "RETURN_OUTPUT"]).default("INITIATE");
export type AuthorizationPhase = z.infer<typeof AuthorizationPhaseSchema>;
export const EnforcementModeSchema = z.enum(["ACTIVE", "LOG_ONLY"]).default("ACTIVE");
export type EnforcementMode = z.infer<typeof EnforcementModeSchema>;
export const PolicySchema = z.object({
  name: PolicyNameSchema,
  description: z.string().min(1).max(4096).optional(),
  statement: z.string().min(1, "Cedar policy statement is required"),
  sourceFile: z.string().optional(),
  validationMode: ValidationModeSchema.default("FAIL_ON_ANY_FINDINGS"),
  enforcementMode: EnforcementModeSchema.default("ACTIVE"),
  authorizationPhase: AuthorizationPhaseSchema.optional(),
});
export type Policy = z.infer<typeof PolicySchema>;
export const PolicyEngineSchema = z.object({
  name: PolicyEngineNameSchema,
  description: z.string().min(1).max(4096).optional(),
  encryptionKeyArn: z.string().optional(),
  tags: TagsSchema.optional(),
  policies: z
    .array(PolicySchema)
    .default([])
    .superRefine(
      uniqueBy(
        (policy) => policy.name,
        (name) => `Duplicate policy name: ${name}`,
      ),
    ),
});
export type PolicyEngine = z.infer<typeof PolicyEngineSchema>;

/**
 The deployed service name of a policy engine; mirrors the L3 AgentCorePolicyEngine construct's rule.
**/
export function policyEngineResourceName(projectName: string, engineName: string): string {
  return `${projectName}_${engineName}`;
}
