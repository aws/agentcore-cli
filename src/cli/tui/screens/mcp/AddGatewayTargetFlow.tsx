import { gatewayTargetPrimitive } from '../../../primitives/registry';
import { ErrorPrompt } from '../../components';
import { useExistingGateways, useExistingToolNames } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddIdentityScreen } from '../identity/AddIdentityScreen';
import type { AddIdentityConfig } from '../identity/types';
import { useCreateIdentity, useExistingCredentials, useExistingIdentityNames } from '../identity/useCreateIdentity';
import { AddGatewayTargetScreen } from './AddGatewayTargetScreen';
import type { AddGatewayTargetConfig, AddGatewayTargetStep, GatewayTargetWizardState } from './types';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'create-wizard'; resumeConfig?: GatewayTargetWizardState; resumeStep?: AddGatewayTargetStep }
  | { name: 'creating-credential'; pendingConfig: GatewayTargetWizardState }
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
  const { gateways: existingGateways } = useExistingGateways();
  const { toolNames: existingToolNames } = useExistingToolNames();
  const { credentials } = useExistingCredentials();
  const { names: existingIdentityNames } = useExistingIdentityNames();
  const { createIdentity } = useCreateIdentity();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  const oauthCredentialNames = useMemo(
    () => credentials.filter(c => c.authorizerType === 'OAuthCredentialProvider').map(c => c.name),
    [credentials]
  );

  const apiKeyCredentialNames = useMemo(
    () => credentials.filter(c => c.authorizerType === 'ApiKeyCredentialProvider').map(c => c.name),
    [credentials]
  );

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success' && !flow.loading) {
      onExit();
    }
  }, [isInteractive, flow, onExit]);

  const handleCreateComplete = useCallback((config: AddGatewayTargetConfig) => {
    setFlow({
      name: 'create-success',
      toolName: config.name,
      projectPath: '',
      loading: true,
      loadingMessage: 'Creating gateway target...',
    });

    if (config.targetType === 'mcpServer') {
      void gatewayTargetPrimitive
        .createExternalGatewayTarget(config)
        .then((result: { toolName: string; projectPath: string }) => {
          setFlow({ name: 'create-success', toolName: result.toolName, projectPath: result.projectPath });
        })
        .catch((err: unknown) => {
          setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        });
    } else if (config.targetType === 'openApiSchema' || config.targetType === 'smithyModel') {
      void gatewayTargetPrimitive
        .createSchemaBasedGatewayTarget(config)
        .then((result: { toolName: string }) => {
          setFlow({ name: 'create-success', toolName: result.toolName, projectPath: '' });
        })
        .catch((err: unknown) => {
          setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        });
    } else if (config.targetType === 'apiGateway') {
      void gatewayTargetPrimitive
        .createApiGatewayTarget(config)
        .then((result: { toolName: string }) => {
          setFlow({ name: 'create-success', toolName: result.toolName, projectPath: '' });
        })
        .catch((err: unknown) => {
          setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        });
    } else if (config.targetType === 'lambdaFunctionArn') {
      void gatewayTargetPrimitive
        .createLambdaFunctionArnTarget(config)
        .then((result: { toolName: string }) => {
          setFlow({ name: 'create-success', toolName: result.toolName, projectPath: '' });
        })
        .catch((err: unknown) => {
          setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        });
    } else {
      setFlow({ name: 'error', message: `Unsupported target type: ${(config as { targetType: string }).targetType}` });
    }
  }, []);

  const handleCreateCredential = useCallback((pendingConfig: GatewayTargetWizardState) => {
    setFlow({ name: 'creating-credential', pendingConfig });
  }, []);

  const handleIdentityComplete = useCallback(
    (identityConfig: AddIdentityConfig) => {
      const createConfig =
        identityConfig.identityType === 'OAuthCredentialProvider'
          ? {
              authorizerType: 'OAuthCredentialProvider' as const,
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
              authorizerType: 'ApiKeyCredentialProvider' as const,
              name: identityConfig.name,
              apiKey: identityConfig.apiKey,
            };

      void createIdentity(createConfig).then(result => {
        if (result.ok && flow.name === 'creating-credential') {
          const pending = flow.pendingConfig;
          const authType = pending.outboundAuth?.type === 'API_KEY' ? 'API_KEY' : 'OAUTH';
          // Resume wizard at confirm step with the new credential attached
          setFlow({
            name: 'create-wizard',
            resumeConfig: {
              ...pending,
              outboundAuth: { type: authType, credentialName: result.result.name },
            },
            resumeStep: 'confirm',
          });
        } else if (!result.ok) {
          setFlow({ name: 'error', message: result.error });
        }
      });
    },
    [flow, createIdentity]
  );

  // Create wizard
  if (flow.name === 'create-wizard') {
    return (
      <AddGatewayTargetScreen
        existingGateways={existingGateways}
        existingToolNames={existingToolNames}
        existingOAuthCredentialNames={oauthCredentialNames}
        existingApiKeyCredentialNames={apiKeyCredentialNames}
        onComplete={handleCreateComplete}
        onCreateCredential={handleCreateCredential}
        onExit={onBack}
        initialConfig={flow.resumeConfig}
        initialStep={flow.resumeStep}
      />
    );
  }

  // Creating credential via identity screen
  if (flow.name === 'creating-credential') {
    const resumeStep = flow.pendingConfig.targetType === 'apiGateway' ? 'api-gateway-auth' : 'outbound-auth';
    return (
      <AddIdentityScreen
        existingIdentityNames={existingIdentityNames}
        onComplete={handleIdentityComplete}
        onExit={() =>
          setFlow({
            name: 'create-wizard',
            resumeConfig: flow.pendingConfig,
            resumeStep: resumeStep,
          })
        }
        initialType={
          flow.pendingConfig.outboundAuth?.type === 'API_KEY' ? 'ApiKeyCredentialProvider' : 'OAuthCredentialProvider'
        }
      />
    );
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added gateway target: ${flow.toolName}`}
        detail={flow.projectPath ? `Project created at ${flow.projectPath}` : undefined}
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        showDevOption={false}
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
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
