import type { ComponentConfigurationMap } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Config Bundle Wizard Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddConfigBundleStep =
  | 'name'
  | 'description'
  | 'componentType'
  | 'componentSelect'
  | 'componentArnEntry'
  | 'configuration'
  | 'addAnother'
  | 'branchName'
  | 'commitMessage'
  | 'kmsKey'
  | 'confirm';

export type ComponentType = 'runtime' | 'gateway' | 'custom';

export interface DeployedComponent {
  name: string;
  arn: string;
  type: ComponentType;
  /** True when the resource is not yet deployed — ARN is a placeholder resolved at deploy time. */
  isPlaceholder?: boolean;
}

export interface AddConfigBundleConfig {
  name: string;
  description: string;
  components: ComponentConfigurationMap;
  /** Raw text entered by user (JSON string or file path). */
  componentsRaw: string;
  branchName: string;
  commitMessage: string;
  /** Optional KMS key ARN for customer-managed encryption of the bundle. */
  kmsKeyArn: string;
  /** Currently selected component type in wizard. */
  currentComponentType?: ComponentType;
  /** Currently selected component ARN in wizard. */
  currentComponentArn?: string;
}

export const CONFIG_BUNDLE_STEP_LABELS: Record<AddConfigBundleStep, string> = {
  name: 'Name',
  description: 'Description',
  componentType: 'Type',
  componentSelect: 'Component',
  componentArnEntry: 'ARN',
  configuration: 'Config',
  addAnother: 'More?',
  branchName: 'Branch',
  commitMessage: 'Message',
  kmsKey: 'KMS Key',
  confirm: 'Confirm',
};

export const COMPONENT_TYPE_OPTIONS = [
  { id: 'runtime', title: 'Agent Runtime', description: 'Configure an agent runtime' },
  { id: 'gateway', title: 'HTTP Gateway', description: 'Configure an HTTP gateway' },
  { id: 'custom', title: 'Other (ARN)', description: 'Enter any component ARN (gateway target, etc.)' },
] as const;
