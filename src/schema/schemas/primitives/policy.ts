import { uniqueBy } from '../zod-util';
import { z } from 'zod';

// ============================================================================
// Policy Engine Name Schema
// ============================================================================

/**
 * Policy engine name validation.
 * Pattern: ^[A-Za-z][A-Za-z0-9_]*$ max 48
 * Must begin with a letter, alphanumeric + underscores only.
 * @see API docs: PolicyEngine name constraints
 */
export const PolicyEngineNameSchema = z
  .string()
  .min(1, 'Policy engine name is required')
  .max(48, 'Policy engine name must be 48 characters or less')
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ============================================================================
// Policy Name Schema
// ============================================================================

/**
 * Policy name validation.
 * Pattern: [A-Za-z][A-Za-z0-9_]* min 1, max 48
 * Must begin with a letter, alphanumeric + underscores only.
 * @see API docs: Policy name constraints
 */
export const PolicyNameSchema = z
  .string()
  .min(1, 'Policy name is required')
  .max(48, 'Policy name must be 48 characters or less')
  .regex(
    /^[A-Za-z][A-Za-z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ============================================================================
// Validation Mode Schema
// ============================================================================

export const ValidationModeSchema = z.enum(['FAIL_ON_ANY_FINDINGS', 'IGNORE_ALL_FINDINGS']);
export type ValidationMode = z.infer<typeof ValidationModeSchema>;

// ============================================================================
// Policy Schema
// ============================================================================

export const PolicySchema = z.object({
  name: PolicyNameSchema,
  description: z.string().min(1).max(4096).optional(),
  statement: z.string().min(1, 'Cedar policy statement is required'),
  sourceFile: z.string().optional(),
  validationMode: ValidationModeSchema.default('FAIL_ON_ANY_FINDINGS'),
});

export type Policy = z.infer<typeof PolicySchema>;

// ============================================================================
// Policy Engine Schema
// ============================================================================

export const PolicyEngineSchema = z.object({
  name: PolicyEngineNameSchema,
  description: z.string().min(1).max(4096).optional(),
  encryptionKeyArn: z.string().optional(),
  policies: z
    .array(PolicySchema)
    .default([])
    .superRefine(
      uniqueBy(
        policy => policy.name,
        name => `Duplicate policy name: ${name}`
      )
    ),
});

export type PolicyEngine = z.infer<typeof PolicyEngineSchema>;
