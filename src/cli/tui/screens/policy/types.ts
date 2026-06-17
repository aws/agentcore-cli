// ─────────────────────────────────────────────────────────────────────────────
// Policy Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyResourceType = 'policy-engine' | 'policy';

export type PolicySourceMethod = 'file' | 'inline' | 'generate' | 'form';

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail Model (matches KobaPolicyEvaluator Smithy model)
// ─────────────────────────────────────────────────────────────────────────────

export type GuardrailCategoryType = 'contentFilter' | 'promptAttack' | 'sensitiveInformation';

export const CONTENT_FILTER_FILTERS = ['VIOLENCE', 'HATE', 'SEXUAL', 'MISCONDUCT', 'INSULT'] as const;
export type ContentFilterCategory = (typeof CONTENT_FILTER_FILTERS)[number];

export const PROMPT_ATTACK_FILTERS = ['JAILBREAK', 'PROMPT_INJECTION', 'PROMPT_LEAKAGE'] as const;
export type PromptAttackCategory = (typeof PROMPT_ATTACK_FILTERS)[number];

export const SENSITIVE_INFO_FILTERS = [
  'ADDRESS',
  'AGE',
  'AWS_ACCESS_KEY',
  'AWS_SECRET_KEY',
  'CA_HEALTH_NUMBER',
  'CA_SOCIAL_INSURANCE_NUMBER',
  'CREDIT_DEBIT_CARD_CVV',
  'CREDIT_DEBIT_CARD_EXPIRY',
  'CREDIT_DEBIT_CARD_NUMBER',
  'DRIVER_ID',
  'EMAIL',
  'INTERNATIONAL_BANK_ACCOUNT_NUMBER',
  'IP_ADDRESS',
  'LICENSE_PLATE',
  'MAC_ADDRESS',
  'NAME',
  'PASSWORD',
  'PHONE',
  'PIN',
  'SWIFT_CODE',
  'UK_NATIONAL_HEALTH_SERVICE_NUMBER',
  'UK_NATIONAL_INSURANCE_NUMBER',
  'UK_UNIQUE_TAXPAYER_REFERENCE_NUMBER',
  'URL',
  'USERNAME',
  'US_BANK_ACCOUNT_NUMBER',
  'US_BANK_ROUTING_NUMBER',
  'US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER',
  'US_PASSPORT_NUMBER',
  'US_SOCIAL_SECURITY_NUMBER',
  'VEHICLE_IDENTIFICATION_NUMBER',
] as const;
export type SensitiveInformationEntityType = (typeof SENSITIVE_INFO_FILTERS)[number];

export type GuardrailFilter = ContentFilterCategory | PromptAttackCategory | SensitiveInformationEntityType;

export const GUARDRAIL_CATEGORY_OPTIONS: {
  id: GuardrailCategoryType;
  title: string;
  description: string;
  filters: readonly string[];
}[] = [
  {
    id: 'contentFilter',
    title: 'Content Filter',
    description: 'Violence, hate, sexual, misconduct, insults',
    filters: CONTENT_FILTER_FILTERS,
  },
  {
    id: 'promptAttack',
    title: 'Prompt Attack',
    description: 'Jailbreak, injection, leakage',
    filters: PROMPT_ATTACK_FILTERS,
  },
  {
    id: 'sensitiveInformation',
    title: 'Sensitive Information',
    description: 'PII & credentials detection',
    filters: SENSITIVE_INFO_FILTERS,
  },
];

export type PolicyEffect = 'permit' | 'forbid' | 'suppressOutput';

/**
 * `permit`/`forbid` evaluate at request time (INITIATE phase) against input data.
 * `suppressOutput` is an output-phase effect: it evaluates the model's response
 * (RETURN_OUTPUT phase) against `context.output.*` and blocks the response when a
 * guardrail trips. The Koba registry infers the phase from the effect keyword and
 * rejects input data paths for `suppressOutput`.
 */
export const POLICY_EFFECT_OPTIONS: { id: PolicyEffect; title: string; description: string }[] = [
  { id: 'forbid', title: 'Forbid', description: 'Block requests that exceed threshold (greaterThan)' },
  { id: 'permit', title: 'Permit', description: 'Allow requests that fall below threshold (lessThan)' },
  {
    id: 'suppressOutput',
    title: 'Suppress Output',
    description: "Block the model's response when output exceeds threshold (greaterThan)",
  },
];

/** Effects that evaluate the model output (RETURN_OUTPUT phase) rather than the request. */
export const OUTPUT_PHASE_EFFECTS: readonly PolicyEffect[] = ['suppressOutput'];

export const DEFAULT_INPUT_DATA_PATH = 'context.input.prompt';
export const DEFAULT_OUTPUT_DATA_PATH = 'context.output.prompt';

/** The authorization phase a given effect must be registered under. */
export function authorizationPhaseForEffect(effect: PolicyEffect): 'INITIATE' | 'RETURN_OUTPUT' {
  return OUTPUT_PHASE_EFFECTS.includes(effect) ? 'RETURN_OUTPUT' : 'INITIATE';
}

/** The default data path to suggest for a given effect. */
export function defaultDataPathForEffect(effect: PolicyEffect): string {
  return OUTPUT_PHASE_EFFECTS.includes(effect) ? DEFAULT_OUTPUT_DATA_PATH : DEFAULT_INPUT_DATA_PATH;
}

/** Form config: selected category, chosen filters, effect, and data path */
export interface GuardrailFormConfig {
  category: GuardrailCategoryType | null;
  filters: string[];
  effect: PolicyEffect;
  dataPath: string;
}

export type AddPolicyStep =
  | 'gateway'
  | 'target'
  | 'engine'
  | 'name'
  | 'source-method'
  | 'source-file'
  | 'source-inline'
  | 'source-generate-gateway'
  | 'source-generate-description'
  | 'source-generate-loading'
  | 'source-generate-review'
  | 'source-form-effect'
  | 'source-form-category'
  | 'source-form-filters'
  | 'source-form-data-path'
  | 'source-form-review'
  | 'enforcement-mode'
  | 'validation-mode'
  | 'confirm';

export interface AddPolicyEngineConfig {
  name: string;
}

export interface AddPolicyConfig {
  name: string;
  engine: string;
  sourceMethod: PolicySourceMethod;
  statement: string;
  sourceFile: string;
  gatewayName: string;
  targetName: string;
  gatewayArn: string;
  naturalLanguageDescription: string;
  validationMode: 'FAIL_ON_ANY_FINDINGS' | 'IGNORE_ALL_FINDINGS';
  enforcementMode: 'ACTIVE' | 'LOG_ONLY';
  guardrailForm: GuardrailFormConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const POLICY_STEP_LABELS: Record<AddPolicyStep, string> = {
  gateway: 'Gateway',
  target: 'Target',
  engine: 'Engine',
  name: 'Name',
  'source-method': 'Source',
  'source-file': 'File',
  'source-inline': 'Policy',
  'source-generate-gateway': 'Gateway',
  'source-generate-description': 'Describe',
  'source-generate-loading': 'Generating',
  'source-generate-review': 'Review',
  'source-form-effect': 'Effect',
  'source-form-category': 'Category',
  'source-form-filters': 'Filters',
  'source-form-data-path': 'Data Path',
  'source-form-review': 'Review',
  'enforcement-mode': 'Enforcement',
  'validation-mode': 'Validation',
  confirm: 'Confirm',
};

export const VALIDATION_MODE_OPTIONS = [
  {
    id: 'FAIL_ON_ANY_FINDINGS',
    title: 'Fail on any findings',
    description: 'Block policies that fail analyzer validation',
  },
  {
    id: 'IGNORE_ALL_FINDINGS',
    title: 'Ignore all findings',
    description: 'Skip analyzer validation checks',
  },
] as const;

export const ENFORCEMENT_MODE_OPTIONS = [
  {
    id: 'ACTIVE',
    title: 'Active',
    description: 'Policy decisions are enforced on requests',
  },
  {
    id: 'LOG_ONLY',
    title: 'Log only',
    description: 'Policy is evaluated but decisions are observed only (shadow mode)',
  },
] as const;

export const POLICY_SOURCE_METHOD_OPTIONS = [
  {
    id: 'form' as const,
    title: 'Use a form',
    description: 'Guardrail categories, filters & thresholds',
  },
  {
    id: 'file' as const,
    title: 'Select a policy file',
    description: 'From your project',
  },
  {
    id: 'inline' as const,
    title: 'Write a policy',
    description: 'Type policy directly',
  },
  {
    id: 'generate' as const,
    title: 'Generate a policy',
    description: 'From natural language',
  },
] as const;

export const POLICY_RESOURCE_OPTIONS = [
  {
    id: 'policy-engine' as const,
    title: 'Policy Engine',
    description: 'Attaches to a gateway',
  },
  {
    id: 'policy' as const,
    title: 'Policy',
    description: 'Policy within an engine',
  },
] as const;
