import type { CredentialType } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Identity Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddIdentityStep = 'type' | 'name' | 'apiKey' | 'confirm';

export interface AddIdentityConfig {
  identityType: CredentialType;
  name: string;
  apiKey: string;
}

export const IDENTITY_STEP_LABELS: Record<AddIdentityStep, string> = {
  type: 'Type',
  name: 'Name',
  apiKey: 'API Key',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const IDENTITY_TYPE_OPTIONS = [
  { id: 'ApiKeyCredentialProvider' as const, title: 'API Key', description: 'Store and manage API key credentials' },
] as const;
