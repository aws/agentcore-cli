import { paymentManagerPrimitive } from '../../../primitives/registry';
import { ConfirmReview, ErrorPrompt, Panel, Screen, SelectScreen } from '../../components';
import type { SelectableItem } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddPaymentConnectorScreen } from './AddPaymentConnectorScreen';
import { AddPaymentManagerScreen } from './AddPaymentManagerScreen';
import type { AddPaymentConnectorConfig, AddPaymentManagerConfig } from './types';
import { useCreatePayment, useCreatePaymentConnector, useExistingConnectorNames } from './useCreatePayment';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'select' }
  | { name: 'manager-wizard' }
  | { name: 'connector-prompt'; managerConfig: AddPaymentManagerConfig }
  | { name: 'connector-wizard-unified'; managerConfig: AddPaymentManagerConfig }
  | { name: 'confirm'; managerConfig: AddPaymentManagerConfig; connectorConfig?: AddPaymentConnectorConfig }
  | { name: 'connector-wizard'; preSelectedManager?: string }
  | { name: 'success'; message: string }
  | { name: 'error'; message: string };

interface AddPaymentFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
  /**
   * Which payment sub-resource to jump straight into, skipping the
   * manager/connector picker. When set, Esc from the wizard returns to the
   * caller (onBack) rather than the (skipped) picker. Defaults to 'select'
   * (show the picker) for any caller that doesn't specify one.
   */
  initialAction?: 'manager' | 'connector' | 'select';
}

export function AddPaymentFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
  initialAction = 'select',
}: AddPaymentFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [managerNames, setManagerNames] = useState<string[]>([]);
  const { createPayment, reset: resetCreate } = useCreatePayment();
  const { createConnector, reset: resetConnector } = useCreatePaymentConnector();
  const [connectorManagerName, setConnectorManagerName] = useState<string | undefined>(undefined);
  const { names: existingConnectorNames, refresh: refreshConnectorNames } =
    useExistingConnectorNames(connectorManagerName);
  const confirmHandlerRef = useRef<(() => void) | null>(null);
  const isSubmittingRef = useRef(false);

  useInput(
    (_input, key) => {
      if (key.return && flow.name === 'confirm' && confirmHandlerRef.current && !isSubmittingRef.current) {
        isSubmittingRef.current = true;
        confirmHandlerRef.current();
      }
    },
    { isActive: flow.name === 'confirm' }
  );

  useEffect(() => {
    if (flow.name !== 'confirm') confirmHandlerRef.current = null;
  }, [flow]);

  // Load existing managers from disk on mount, then route based on initialAction.
  // - 'manager'    -> jump straight into the manager wizard
  // - 'connector'  -> jump into the connector flow (0/1/many-manager handling, mirrors handleSelectAction)
  // - 'select'     -> show the manager/connector picker (default; legacy behavior)
  // We branch on the freshly-loaded `names`, not the managerNames state (not yet committed this tick).
  useEffect(() => {
    let cancelled = false;
    const route = (names: string[]) => {
      if (cancelled) return;
      setManagerNames(names);
      if (initialAction === 'manager') {
        setFlow({ name: 'manager-wizard' });
      } else if (initialAction === 'connector') {
        if (names.length === 0) {
          setFlow({ name: 'error', message: 'No payment managers exist. Create a manager first.' });
        } else if (names.length === 1) {
          setConnectorManagerName(names[0]);
          void refreshConnectorNames(names[0]);
          setFlow({ name: 'connector-wizard', preSelectedManager: names[0] });
        } else {
          setFlow({ name: 'connector-wizard' });
        }
      } else {
        setFlow({ name: 'select' });
      }
    };
    void paymentManagerPrimitive
      .getExistingManagers()
      .then(route)
      .catch(() => route([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; initialAction is stable per render of this flow
  }, []);

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const buildSelectItems = useCallback((): SelectableItem[] => {
    return [
      {
        id: '__add_manager__',
        title: 'Add a payment manager',
        description: 'Create a new payment manager with authorization config',
      },
      {
        id: '__add_connector__',
        title: 'Add a payment connector',
        description: 'Link payment provider credentials to an existing manager',
      },
    ];
  }, []);

  const handleSelectAction = useCallback(
    (item: SelectableItem) => {
      if (item.id === '__add_manager__') {
        setFlow({ name: 'manager-wizard' });
      } else if (item.id === '__add_connector__') {
        if (managerNames.length === 0) {
          setFlow({ name: 'error', message: 'No payment managers exist. Create a manager first.' });
        } else if (managerNames.length === 1) {
          // Only one manager, pre-select it
          setConnectorManagerName(managerNames[0]);
          void refreshConnectorNames(managerNames[0]);
          setFlow({ name: 'connector-wizard', preSelectedManager: managerNames[0] });
        } else {
          setFlow({ name: 'connector-wizard' });
        }
      }
    },
    [managerNames, refreshConnectorNames]
  );

  const handleManagerComplete = useCallback((config: AddPaymentManagerConfig) => {
    setFlow({ name: 'connector-prompt', managerConfig: config });
  }, []);

  const handleConnectorComplete = useCallback(
    (config: AddPaymentConnectorConfig) => {
      const baseOptions = {
        manager: config.managerName,
        name: config.connectorName,
        provider: config.provider,
      } as const;

      const connectorOptions =
        config.provider === 'StripePrivy'
          ? {
              ...baseOptions,
              provider: 'StripePrivy' as const,
              appId: config.appId,
              appSecret: config.appSecret,
              authorizationPrivateKey: config.authorizationPrivateKey,
              authorizationId: config.authorizationId,
            }
          : {
              ...baseOptions,
              provider: 'CoinbaseCDP' as const,
              apiKeyId: config.apiKeyId,
              apiKeySecret: config.apiKeySecret,
              walletSecret: config.walletSecret,
            };

      setFlow({ name: 'loading' });
      void createConnector(connectorOptions)
        .then(result => {
          if (result.ok) {
            setFlow({ name: 'success', message: `Added payment connector: ${result.connectorName}` });
          } else {
            setFlow({ name: 'error', message: result.error });
          }
        })
        .catch(err => {
          setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unexpected error' });
        });
    },
    [createConnector]
  );

  // Loading
  if (flow.name === 'loading') {
    return (
      <Box>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  // Select action: add manager or add connector
  if (flow.name === 'select') {
    return (
      <SelectScreen
        title="Add Payment"
        items={buildSelectItems()}
        onSelect={(item: SelectableItem) => handleSelectAction(item)}
        onExit={onBack}
      />
    );
  }

  // Manager wizard
  if (flow.name === 'manager-wizard') {
    return (
      <AddPaymentManagerScreen
        existingManagerNames={managerNames}
        onComplete={handleManagerComplete}
        onExit={() => {
          // When launched directly into the manager wizard (no picker shown), Esc
          // returns to the caller. Otherwise fall back to the picker (or onBack if
          // there were no managers to pick from).
          if (initialAction === 'manager' || managerNames.length === 0) {
            onBack();
          } else {
            setFlow({ name: 'select' });
          }
        }}
      />
    );
  }

  // After manager config collected, ask about connector
  if (flow.name === 'connector-prompt') {
    const connectorChoiceItems = [
      {
        id: 'add-connector',
        title: 'Add a payment connector',
        description: 'Link CoinbaseCDP or StripePrivy credentials',
      },
      { id: 'skip', title: 'Skip for now' },
    ];
    return (
      <SelectScreen
        title="Add a payment connector?"
        items={connectorChoiceItems}
        onSelect={item => {
          if (item.id === 'add-connector') {
            setFlow({ name: 'connector-wizard-unified', managerConfig: flow.managerConfig });
          } else {
            setFlow({ name: 'confirm', managerConfig: flow.managerConfig });
          }
        }}
        onExit={() => setFlow({ name: 'manager-wizard' })}
      />
    );
  }

  // Connector wizard within the unified manager flow (no confirm on this screen)
  if (flow.name === 'connector-wizard-unified') {
    return (
      <AddPaymentConnectorScreen
        existingManagerNames={[flow.managerConfig.managerName]}
        existingConnectorNames={[]}
        preSelectedManager={flow.managerConfig.managerName}
        onComplete={connectorConfig => {
          setFlow({ name: 'confirm', managerConfig: flow.managerConfig, connectorConfig });
        }}
        onExit={() => setFlow({ name: 'connector-prompt', managerConfig: flow.managerConfig })}
        skipConfirm
      />
    );
  }

  // Unified confirm screen — shows manager + optional connector, creates on Enter
  if (flow.name === 'confirm') {
    const managerFields = [
      { label: 'Auth Type', value: flow.managerConfig.authorizerType },
      { label: 'Manager Name', value: flow.managerConfig.managerName },
      { label: 'Auto Payment', value: flow.managerConfig.autoPayment ? 'Enabled' : 'Disabled' },
      { label: 'Default Spend Limit', value: `$${flow.managerConfig.defaultSpendLimit}` },
      ...(flow.managerConfig.paymentToolAllowlist
        ? [{ label: 'Tool Allowlist', value: flow.managerConfig.paymentToolAllowlist }]
        : []),
      ...(flow.managerConfig.networkPreferences
        ? [{ label: 'Network Preferences', value: flow.managerConfig.networkPreferences }]
        : []),
    ];

    const connectorFields = flow.connectorConfig
      ? [
          { label: 'Connector Name', value: flow.connectorConfig.connectorName },
          { label: 'Provider', value: flow.connectorConfig.provider },
          ...(flow.connectorConfig.provider === 'StripePrivy'
            ? [
                {
                  label: 'App ID',
                  value:
                    flow.connectorConfig.appId.length > 8 ? '****' + flow.connectorConfig.appId.slice(-4) : '••••••••',
                },
                {
                  label: 'App Secret',
                  value:
                    flow.connectorConfig.appSecret.length > 8
                      ? '****' + flow.connectorConfig.appSecret.slice(-4)
                      : '••••••••',
                },
                {
                  label: 'Auth Key',
                  value:
                    flow.connectorConfig.authorizationPrivateKey.length > 8
                      ? '****' + flow.connectorConfig.authorizationPrivateKey.slice(-4)
                      : '••••••••',
                },
                {
                  label: 'Auth ID',
                  value:
                    flow.connectorConfig.authorizationId.length > 8
                      ? '****' + flow.connectorConfig.authorizationId.slice(-4)
                      : '••••••••',
                },
              ]
            : [
                {
                  label: 'API Key ID',
                  value:
                    flow.connectorConfig.apiKeyId.length > 8
                      ? '****' + flow.connectorConfig.apiKeyId.slice(-4)
                      : '••••••••',
                },
                {
                  label: 'API Key Secret',
                  value:
                    flow.connectorConfig.apiKeySecret.length > 8
                      ? '****' + flow.connectorConfig.apiKeySecret.slice(-4)
                      : '••••••••',
                },
                {
                  label: 'Wallet Secret',
                  value:
                    flow.connectorConfig.walletSecret.length > 8
                      ? '****' + flow.connectorConfig.walletSecret.slice(-4)
                      : '••••••••',
                },
              ]),
        ]
      : [];

    const warningFields = !flow.connectorConfig
      ? [{ label: '⚠ Warning', value: 'No connector — deploy will fail until you add one' }]
      : [];

    const allFields = [...managerFields, ...connectorFields, ...warningFields];

    const handleConfirmSubmit = async () => {
      const mgrConfig = flow.managerConfig;
      const parseList = (val: string): string[] | undefined => {
        const items = val
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        return items.length > 0 ? items : undefined;
      };

      // Create manager
      const mgrResult = await createPayment({
        name: mgrConfig.managerName,
        authorizerType: mgrConfig.authorizerType,
        discoveryUrl: mgrConfig.authorizerType === 'CUSTOM_JWT' ? mgrConfig.discoveryUrl : undefined,
        allowedClients: mgrConfig.authorizerType === 'CUSTOM_JWT' ? parseList(mgrConfig.allowedClients) : undefined,
        allowedAudience: mgrConfig.authorizerType === 'CUSTOM_JWT' ? parseList(mgrConfig.allowedAudience) : undefined,
        allowedScopes: mgrConfig.authorizerType === 'CUSTOM_JWT' ? parseList(mgrConfig.allowedScopes) : undefined,
        autoPayment: mgrConfig.autoPayment,
        defaultSpendLimit: mgrConfig.defaultSpendLimit,
        paymentToolAllowlist: mgrConfig.paymentToolAllowlist ? parseList(mgrConfig.paymentToolAllowlist) : undefined,
        networkPreferences: mgrConfig.networkPreferences ? parseList(mgrConfig.networkPreferences) : undefined,
      });

      if (!mgrResult.ok) {
        isSubmittingRef.current = false;
        setFlow({ name: 'error', message: mgrResult.error });
        return;
      }

      setManagerNames(prev => [...prev, mgrConfig.managerName]);

      // Create connector if provided
      if (flow.connectorConfig) {
        const connConfig = flow.connectorConfig;
        const baseOptions = {
          manager: mgrConfig.managerName,
          name: connConfig.connectorName,
          provider: connConfig.provider,
        } as const;
        const connectorOptions =
          connConfig.provider === 'StripePrivy'
            ? {
                ...baseOptions,
                provider: 'StripePrivy' as const,
                appId: connConfig.appId,
                appSecret: connConfig.appSecret,
                authorizationPrivateKey: connConfig.authorizationPrivateKey,
                authorizationId: connConfig.authorizationId,
              }
            : {
                ...baseOptions,
                provider: 'CoinbaseCDP' as const,
                apiKeyId: connConfig.apiKeyId,
                apiKeySecret: connConfig.apiKeySecret,
                walletSecret: connConfig.walletSecret,
              };

        const connResult = await createConnector(connectorOptions);
        if (!connResult.ok) {
          isSubmittingRef.current = false;
          setFlow({
            name: 'error',
            message: `Manager "${mgrConfig.managerName}" was created, but connector failed: ${connResult.error}\n\nUse "Add a payment connector" to retry adding the connector.`,
          });
          return;
        }
      }

      isSubmittingRef.current = false;
      const msg = flow.connectorConfig
        ? `Payment manager "${mgrConfig.managerName}" and connector "${flow.connectorConfig.connectorName}" created`
        : `Payment manager "${mgrConfig.managerName}" created`;
      setFlow({ name: 'success', message: msg });
    };

    // eslint-disable-next-line react-hooks/refs -- intentional: handler must close over current flow state
    confirmHandlerRef.current = () => void handleConfirmSubmit();

    return (
      <Screen
        title="Confirm Payment Setup"
        onExit={() => setFlow({ name: 'connector-prompt', managerConfig: flow.managerConfig })}
        helpText="Enter confirm · Esc back · Ctrl+C quit"
      >
        <Panel>
          <ConfirmReview fields={allFields} />
        </Panel>
      </Screen>
    );
  }

  // Connector wizard
  if (flow.name === 'connector-wizard') {
    return (
      <AddPaymentConnectorScreen
        existingManagerNames={managerNames}
        existingConnectorNames={existingConnectorNames}
        preSelectedManager={flow.preSelectedManager}
        onComplete={handleConnectorComplete}
        onManagerSelected={name => {
          setConnectorManagerName(name);
          void refreshConnectorNames(name);
        }}
        onExit={() => {
          resetConnector();
          // When launched directly into the connector wizard (no picker shown),
          // Esc returns to the caller rather than the skipped picker.
          if (initialAction === 'connector') {
            onBack();
          } else {
            setFlow({ name: 'select' });
          }
        }}
      />
    );
  }

  // Unified success screen
  if (flow.name === 'success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={flow.message}
        detail="Run `agentcore deploy` to create payment infrastructure on AWS."
        showDevOption={true}
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add payment resource"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        resetConnector();
        // When launched directly into a single sub-resource (no picker shown),
        // back from an error returns to the caller rather than dropping the user
        // on the skipped picker or an unrequested manager wizard.
        if (initialAction !== 'select') {
          onBack();
        } else if (managerNames.length === 0) {
          setFlow({ name: 'manager-wizard' });
        } else {
          setFlow({ name: 'select' });
        }
      }}
      onExit={onExit}
    />
  );
}
