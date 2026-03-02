import type { CredentialType } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Identity Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddIdentityStep =
  | 'type'
  | 'name'
  | 'apiKey'
  | 'discoveryUrl'
  | 'clientId'
  | 'clientSecret'
  | 'scopes'
  | 'confirm';

export interface AddIdentityConfig {
  identityType: CredentialType;
  name: string;
  /** API Key (when type is ApiKeyCredentialProvider) */
  apiKey: string;
  /** OAuth fields (when type is OAuthCredentialProvider) */
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
}

export const IDENTITY_STEP_LABELS: Record<AddIdentityStep, string> = {
  type: 'Type',
  name: 'Name',
  apiKey: 'API Key',
  discoveryUrl: 'Discovery URL',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  scopes: 'Scopes',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const IDENTITY_TYPE_OPTIONS = [
  { id: 'ApiKeyCredentialProvider' as const, title: 'API Key', description: 'Store and manage API key credentials' },
  { id: 'OAuthCredentialProvider' as const, title: 'OAuth', description: 'OAuth 2.0 client credentials' },
] as const;
