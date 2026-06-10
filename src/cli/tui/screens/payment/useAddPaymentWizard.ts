import type { PaymentAuthorizerType, PaymentProvider } from '../../../../schema';
import type {
  AddPaymentConnectorConfig,
  AddPaymentConnectorStep,
  AddPaymentManagerConfig,
  AddPaymentManagerStep,
} from './types';
import { useCallback, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Payment Manager Wizard
// ─────────────────────────────────────────────────────────────────────────────

const BASE_MANAGER_STEPS: AddPaymentManagerStep[] = ['auth-type', 'manager-name', 'advanced-config'];
const JWT_MANAGER_STEPS: AddPaymentManagerStep[] = [
  'auth-type',
  'discovery-url',
  'allowed-clients',
  'allowed-audience',
  'allowed-scopes',
  'manager-name',
  'advanced-config',
];

function getDefaultManagerConfig(): AddPaymentManagerConfig {
  return {
    authorizerType: 'AWS_IAM',
    discoveryUrl: '',
    allowedClients: '',
    allowedAudience: '',
    allowedScopes: '',
    managerName: '',
    autoPayment: true,
    defaultSpendLimit: '10.00',
  };
}

export function useAddPaymentManagerWizard() {
  const [config, setConfig] = useState<AddPaymentManagerConfig>(getDefaultManagerConfig);
  const [step, setStep] = useState<AddPaymentManagerStep>('auth-type');

  const steps = useMemo(
    () => (config.authorizerType === 'CUSTOM_JWT' ? JWT_MANAGER_STEPS : BASE_MANAGER_STEPS),
    [config.authorizerType]
  );

  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const advanceFrom = useCallback(
    (currentStep: AddPaymentManagerStep) => {
      const idx = steps.indexOf(currentStep);
      const next = steps[idx + 1];
      if (next) setStep(next);
    },
    [steps]
  );

  const setAuthorizerType = useCallback((authorizerType: PaymentAuthorizerType) => {
    setConfig(c => ({ ...c, authorizerType }));
    if (authorizerType === 'AWS_IAM') {
      // Skip OIDC fields, go straight to name
      setStep('manager-name');
    } else {
      setStep('discovery-url');
    }
  }, []);

  const setDiscoveryUrl = useCallback(
    (discoveryUrl: string) => {
      setConfig(c => ({ ...c, discoveryUrl }));
      advanceFrom('discovery-url');
    },
    [advanceFrom]
  );

  const setAllowedClients = useCallback(
    (allowedClients: string) => {
      setConfig(c => ({ ...c, allowedClients }));
      advanceFrom('allowed-clients');
    },
    [advanceFrom]
  );

  const setAllowedAudience = useCallback(
    (allowedAudience: string) => {
      setConfig(c => ({ ...c, allowedAudience }));
      advanceFrom('allowed-audience');
    },
    [advanceFrom]
  );

  const setAllowedScopes = useCallback(
    (allowedScopes: string) => {
      setConfig(c => ({ ...c, allowedScopes }));
      advanceFrom('allowed-scopes');
    },
    [advanceFrom]
  );

  const setManagerName = useCallback(
    (managerName: string) => {
      setConfig(c => ({ ...c, managerName }));
      advanceFrom('manager-name');
    },
    [advanceFrom]
  );

  const setAdvancedConfig = useCallback(
    (advanced: { autoPayment: boolean; defaultSpendLimit: string }) => {
      setConfig(c => ({ ...c, autoPayment: advanced.autoPayment, defaultSpendLimit: advanced.defaultSpendLimit }));
      advanceFrom('advanced-config');
    },
    [advanceFrom]
  );

  const setDefaultSpendLimit = useCallback((defaultSpendLimit: string) => {
    setConfig(c => ({ ...c, defaultSpendLimit: defaultSpendLimit || '10.00' }));
  }, []);

  const setPaymentToolAllowlist = useCallback((paymentToolAllowlist: string | undefined) => {
    setConfig(c => ({ ...c, paymentToolAllowlist }));
  }, []);

  const setNetworkPreferences = useCallback((networkPreferences: string | undefined) => {
    setConfig(c => ({ ...c, networkPreferences }));
  }, []);

  const reset = useCallback(() => {
    setConfig(getDefaultManagerConfig());
    setStep('auth-type');
  }, []);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setAuthorizerType,
    setDiscoveryUrl,
    setAllowedClients,
    setAllowedAudience,
    setAllowedScopes,
    setManagerName,
    setAdvancedConfig,
    setDefaultSpendLimit,
    setPaymentToolAllowlist,
    setNetworkPreferences,
    reset,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Connector Wizard
// ─────────────────────────────────────────────────────────────────────────────

const CDP_CREDENTIAL_STEPS: AddPaymentConnectorStep[] = ['api-key-id', 'api-key-secret', 'wallet-secret'];
const STRIPE_PRIVY_CREDENTIAL_STEPS: AddPaymentConnectorStep[] = [
  'app-id',
  'app-secret',
  'authorization-private-key',
  'authorization-id',
];

function getConnectorStepsForProvider(
  provider: PaymentProvider,
  needsManagerSelect: boolean
): AddPaymentConnectorStep[] {
  const steps: AddPaymentConnectorStep[] = [];
  if (needsManagerSelect) steps.push('manager-select');
  steps.push('provider-select');
  if (provider === 'StripePrivy') {
    steps.push(...STRIPE_PRIVY_CREDENTIAL_STEPS);
  } else {
    steps.push(...CDP_CREDENTIAL_STEPS);
  }
  steps.push('connector-name', 'confirm');
  return steps;
}

function getDefaultConnectorConfig(preSelectedManager?: string): AddPaymentConnectorConfig {
  return {
    managerName: preSelectedManager ?? '',
    provider: 'CoinbaseCDP',
    apiKeyId: '',
    apiKeySecret: '',
    walletSecret: '',
    appId: '',
    appSecret: '',
    authorizationPrivateKey: '',
    authorizationId: '',
    connectorName: '',
  };
}

export function useAddPaymentConnectorWizard(preSelectedManager?: string) {
  const needsManagerSelect = !preSelectedManager;
  const [config, setConfig] = useState<AddPaymentConnectorConfig>(() => getDefaultConnectorConfig(preSelectedManager));

  const steps = useMemo(
    () => getConnectorStepsForProvider(config.provider, needsManagerSelect),
    [config.provider, needsManagerSelect]
  );
  const [step, setStep] = useState<AddPaymentConnectorStep>(steps[0]!);

  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const advanceFrom = useCallback(
    (currentStep: AddPaymentConnectorStep) => {
      const idx = steps.indexOf(currentStep);
      const next = steps[idx + 1];
      if (next) setStep(next);
    },
    [steps]
  );

  const setManagerName = useCallback(
    (managerName: string) => {
      setConfig(c => ({ ...c, managerName }));
      advanceFrom('manager-select');
    },
    [advanceFrom]
  );

  const setProvider = useCallback((provider: PaymentProvider) => {
    setConfig(c => ({ ...c, provider }));
    // After selecting provider, advance to the first credential step
    // The steps list will recompute via useMemo on next render
    if (provider === 'StripePrivy') {
      setStep('app-id');
    } else {
      setStep('api-key-id');
    }
  }, []);

  const setApiKeyId = useCallback(
    (apiKeyId: string) => {
      setConfig(c => ({ ...c, apiKeyId }));
      advanceFrom('api-key-id');
    },
    [advanceFrom]
  );

  const setApiKeySecret = useCallback(
    (apiKeySecret: string) => {
      setConfig(c => ({ ...c, apiKeySecret }));
      advanceFrom('api-key-secret');
    },
    [advanceFrom]
  );

  const setWalletSecret = useCallback(
    (walletSecret: string) => {
      setConfig(c => ({ ...c, walletSecret }));
      advanceFrom('wallet-secret');
    },
    [advanceFrom]
  );

  const setAppId = useCallback(
    (appId: string) => {
      setConfig(c => ({ ...c, appId }));
      advanceFrom('app-id');
    },
    [advanceFrom]
  );

  const setAppSecret = useCallback(
    (appSecret: string) => {
      setConfig(c => ({ ...c, appSecret }));
      advanceFrom('app-secret');
    },
    [advanceFrom]
  );

  const setAuthorizationPrivateKey = useCallback(
    (authorizationPrivateKey: string) => {
      // AWS docs ship the key with a `wallet-auth:` prefix — strip it transparently.
      const cleaned = authorizationPrivateKey.startsWith('wallet-auth:')
        ? authorizationPrivateKey.slice('wallet-auth:'.length)
        : authorizationPrivateKey;
      setConfig(c => ({ ...c, authorizationPrivateKey: cleaned }));
      advanceFrom('authorization-private-key');
    },
    [advanceFrom]
  );

  const setAuthorizationId = useCallback(
    (authorizationId: string) => {
      setConfig(c => ({ ...c, authorizationId }));
      advanceFrom('authorization-id');
    },
    [advanceFrom]
  );

  const setConnectorName = useCallback(
    (connectorName: string) => {
      setConfig(c => ({ ...c, connectorName }));
      advanceFrom('connector-name');
    },
    [advanceFrom]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConnectorConfig(preSelectedManager));
    setStep(steps[0]!);
  }, [preSelectedManager, steps]);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setManagerName,
    setProvider,
    setApiKeyId,
    setApiKeySecret,
    setWalletSecret,
    setAppId,
    setAppSecret,
    setAuthorizationPrivateKey,
    setAuthorizationId,
    setConnectorName,
    reset,
  };
}
