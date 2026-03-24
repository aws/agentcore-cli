// ─────────────────────────────────────────────────────────────────────────────
// Policy Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyResourceType = 'policy-engine' | 'policy';

export type PolicySourceMethod = 'file' | 'inline' | 'generate';

export type AddPolicyStep =
  | 'engine'
  | 'name'
  | 'source-method'
  | 'source-file'
  | 'source-inline'
  | 'source-generate-gateway'
  | 'source-generate-description'
  | 'source-generate-loading'
  | 'source-generate-review'
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
  gatewayArn: string;
  naturalLanguageDescription: string;
  validationMode: 'FAIL_ON_ANY_FINDINGS' | 'IGNORE_ALL_FINDINGS';
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const POLICY_STEP_LABELS: Record<AddPolicyStep, string> = {
  engine: 'Engine',
  name: 'Name',
  'source-method': 'Source',
  'source-file': 'File',
  'source-inline': 'Cedar',
  'source-generate-gateway': 'Gateway',
  'source-generate-description': 'Describe',
  'source-generate-loading': 'Generating',
  'source-generate-review': 'Review',
  'validation-mode': 'Validation',
  confirm: 'Confirm',
};

export const VALIDATION_MODE_OPTIONS = [
  {
    id: 'FAIL_ON_ANY_FINDINGS',
    title: 'Fail on any findings',
    description: 'Block policies that fail Cedar analyzer validation',
  },
  {
    id: 'IGNORE_ALL_FINDINGS',
    title: 'Ignore all findings',
    description: 'Skip Cedar analyzer validation checks',
  },
] as const;

export const POLICY_SOURCE_METHOD_OPTIONS = [
  {
    id: 'file' as const,
    title: 'Select a Cedar policy file',
    description: 'From your project',
  },
  {
    id: 'inline' as const,
    title: 'Write a Cedar policy',
    description: 'Type Cedar directly',
  },
  {
    id: 'generate' as const,
    title: 'Generate a Cedar policy',
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
    description: 'Cedar policy within an engine',
  },
] as const;
