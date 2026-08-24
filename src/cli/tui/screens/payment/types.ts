import type { PaymentAuthorizerType, PaymentProvider } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Payment Manager Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddPaymentManagerStep =
  | 'auth-type'
  | 'discovery-url'
  | 'allowed-clients'
  | 'allowed-audience'
  | 'allowed-scopes'
  | 'manager-name'
  | 'advanced-config'
  | 'confirm';

export interface AddPaymentManagerConfig {
  authorizerType: PaymentAuthorizerType;
  discoveryUrl: string;
  allowedClients: string;
  allowedAudience: string;
  allowedScopes: string;
  managerName: string;
  autoPayment: boolean;
  defaultSpendLimit: string;
  paymentToolAllowlist?: string;
  networkPreferences?: string;
}

export const TOOL_ALLOWLIST_ITEM_ID = 'tool-allowlist';
export const NETWORK_PREFS_ITEM_ID = 'network-preferences';

export const MANAGER_STEP_LABELS: Record<AddPaymentManagerStep, string> = {
  'auth-type': 'Auth Type',
  'discovery-url': 'Discovery URL',
  'allowed-clients': 'Clients',
  'allowed-audience': 'Audience',
  'allowed-scopes': 'Scopes',
  'manager-name': 'Name',
  'advanced-config': 'Advanced',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// Payment Connector Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddPaymentConnectorStep =
  | 'manager-select'
  | 'setup-select'
  // CoinbaseCDP credentials
  | 'api-key-id'
  | 'api-key-secret'
  | 'wallet-secret'
  // StripePrivy credentials
  | 'app-id'
  | 'app-secret'
  | 'authorization-private-key'
  | 'authorization-id'
  | 'connector-name'
  | 'confirm';

export interface AddPaymentConnectorConfig {
  managerName: string;
  provisionMode: 'MANUAL' | 'QUICK_CREATE';
  provider: PaymentProvider;
  // CoinbaseCDP
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
  // StripePrivy
  appId: string;
  appSecret: string;
  authorizationPrivateKey: string;
  authorizationId: string;
  connectorName: string;
}

export const CONNECTOR_STEP_LABELS: Record<AddPaymentConnectorStep, string> = {
  'manager-select': 'Manager',
  'setup-select': 'Setup',
  'api-key-id': 'API Key ID',
  'api-key-secret': 'API Key Secret',
  'wallet-secret': 'Wallet Secret',
  'app-id': 'App ID',
  'app-secret': 'App Secret',
  'authorization-private-key': 'Auth Key',
  'authorization-id': 'Auth ID',
  'connector-name': 'Name',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const AUTH_TYPE_OPTIONS = [
  {
    id: 'AWS_IAM' as const,
    title: 'AWS IAM',
    description: 'Use AWS IAM for authorization (default)',
  },
  {
    id: 'CUSTOM_JWT' as const,
    title: 'Custom JWT',
    description: 'Use a custom JWT authorizer via OIDC discovery',
  },
] as const;

export type PaymentConnectorSetup = 'quick-create' | 'coinbase-manual' | 'stripe-privy-manual';

export const PAYMENT_CONNECTOR_SETUP_OPTIONS = [
  {
    id: 'quick-create' as const,
    title: 'Quick Create with Coinbase',
    description: 'Recommended - connect Coinbase after deployment',
  },
  {
    id: 'coinbase-manual' as const,
    title: 'Coinbase CDP credentials',
    description: 'Use existing Coinbase Developer Platform credentials',
  },
  {
    id: 'stripe-privy-manual' as const,
    title: 'Stripe + Privy credentials',
    description: 'Use existing Stripe and Privy credentials',
  },
] as const;

/** Item ID for the auto payment toggle in the advanced config pane. */
export const AUTO_PAYMENT_ITEM_ID = 'auto-payment';
