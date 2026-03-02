import { createExternalGatewayTarget } from '../../../operations/mcp/create-mcp';
import { ErrorPrompt } from '../../components';
import { useCreateGatewayTarget, useExistingGateways, useExistingToolNames } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddIdentityScreen } from '../identity/AddIdentityScreen';
import type { AddIdentityConfig } from '../identity/types';
import { useCreateIdentity, useExistingCredentials, useExistingIdentityNames } from '../identity/useCreateIdentity';
import { AddGatewayTargetScreen } from './AddGatewayTargetScreen';
import type { AddGatewayTargetConfig } from './types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'creating-credential'; pendingConfig: AddGatewayTargetConfig }
  | { name: 'create-success'; toolName: string; projectPath: string; loading?: boolean; loadingMessage?: string }
  | { name: 'error'; message: string };

interface AddGatewayTargetFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects dev from success screen to run agent locally */
  onDev?: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

export function AddGatewayTargetFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
}: AddGatewayTargetFlowProps) {
  const { createTool, reset: resetCreate } = useCreateGatewayTarget();
  const { gateways: existingGateways } = useExistingGateways();
  const { toolNames: existingToolNames } = useExistingToolNames();
  const { credentials } = useExistingCredentials();
  const { names: existingIdentityNames } = useExistingIdentityNames();
  const { createIdentity } = useCreateIdentity();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  const oauthCredentialNames = useMemo(
    () => credentials.filter(c => c.type === 'OAuthCredentialProvider').map(c => c.name),
    [credentials]
  );

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success' && !flow.loading) {
      onExit();
    }
  }, [isInteractive, flow, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddGatewayTargetConfig) => {
      setFlow({
        name: 'create-success',
        toolName: config.name,
        projectPath: '',
        loading: true,
        loadingMessage: 'Creating gateway target...',
      });

      if (config.source === 'existing-endpoint') {
        void createExternalGatewayTarget(config)
          .then((result: { toolName: string; projectPath: string }) => {
            setFlow({ name: 'create-success', toolName: result.toolName, projectPath: result.projectPath });
          })
          .catch((err: unknown) => {
            setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
          });
      } else {
        void createTool(config).then(result => {
          if (result.ok) {
            const { toolName, projectPath } = result.result;
            setFlow({ name: 'create-success', toolName, projectPath });
            return;
          }
          setFlow({ name: 'error', message: result.error });
        });
      }
    },
    [createTool]
  );

  const handleCreateCredential = useCallback((pendingConfig: AddGatewayTargetConfig) => {
    setFlow({ name: 'creating-credential', pendingConfig });
  }, []);

  const handleIdentityComplete = useCallback(
    (identityConfig: AddIdentityConfig) => {
      const createConfig =
        identityConfig.identityType === 'OAuthCredentialProvider'
          ? {
              type: 'OAuthCredentialProvider' as const,
              name: identityConfig.name,
              discoveryUrl: identityConfig.discoveryUrl!,
              clientId: identityConfig.clientId!,
              clientSecret: identityConfig.clientSecret!,
              scopes: identityConfig.scopes
                ?.split(',')
                .map(s => s.trim())
                .filter(Boolean),
            }
          : {
              type: 'ApiKeyCredentialProvider' as const,
              name: identityConfig.name,
              apiKey: identityConfig.apiKey,
            };

      void createIdentity(createConfig).then(result => {
        if (result.ok && flow.name === 'creating-credential') {
          const finalConfig: AddGatewayTargetConfig = {
            ...flow.pendingConfig,
            outboundAuth: { type: 'OAUTH', credentialName: result.result.name },
          };
          handleCreateComplete(finalConfig);
        } else if (!result.ok) {
          setFlow({ name: 'error', message: result.error });
        }
      });
    },
    [flow, createIdentity, handleCreateComplete]
  );

  // Create wizard
  if (flow.name === 'create-wizard') {
    return (
      <AddGatewayTargetScreen
        existingGateways={existingGateways}
        existingToolNames={existingToolNames}
        existingOAuthCredentialNames={oauthCredentialNames}
        onComplete={handleCreateComplete}
        onCreateCredential={handleCreateCredential}
        onExit={onBack}
      />
    );
  }

  // Creating credential via identity screen
  if (flow.name === 'creating-credential') {
    return (
      <AddIdentityScreen
        existingIdentityNames={existingIdentityNames}
        onComplete={handleIdentityComplete}
        onExit={() => setFlow({ name: 'create-wizard' })}
        initialType="OAuthCredentialProvider"
      />
    );
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added gateway target: ${flow.toolName}`}
        detail={`Project created at ${flow.projectPath}`}
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
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
      message="Failed to add gateway target"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
