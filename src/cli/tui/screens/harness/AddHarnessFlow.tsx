import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddHarnessScreen } from './AddHarnessScreen';
import type { AddHarnessConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; harnessName: string; loading?: boolean; loadingMessage?: string }
  | { name: 'error'; message: string };

interface AddHarnessFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddHarnessFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddHarnessFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });
  const [existingNames, setExistingNames] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const { ConfigIO } = await import('../../../../lib');
        const configIO = new ConfigIO();
        if (configIO.hasProject()) {
          const project = await configIO.readProjectSpec();
          setExistingNames((project.harnesses ?? []).map(h => h.name));
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success' && !flow.loading) {
      onExit();
    }
  }, [isInteractive, flow, onExit]);

  const handleCreateComplete = useCallback(async (config: AddHarnessConfig) => {
    setFlow({ name: 'create-success', harnessName: config.name, loading: true, loadingMessage: 'Creating harness...' });
    try {
      const { harnessPrimitive } = await import('../../../primitives/registry');
      const result = await harnessPrimitive.add({
        name: config.name,
        modelProvider: config.modelProvider,
        modelId: config.modelId,
        apiKeyArn: config.apiKeyArn,
        skipMemory: config.skipMemory,
        containerUri: config.containerUri,
        dockerfilePath: config.dockerfilePath,
        maxIterations: config.maxIterations,
        maxTokens: config.maxTokens,
        timeoutSeconds: config.timeoutSeconds,
        truncationStrategy: config.truncationStrategy,
        networkMode: config.networkMode,
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        idleTimeout: config.idleTimeout,
        maxLifetime: config.maxLifetime,
        sessionStoragePath: config.sessionStoragePath,
        selectedTools: config.selectedTools,
        mcpName: config.mcpName,
        mcpUrl: config.mcpUrl,
        gatewayArn: config.gatewayArn,
        gatewayOutboundAuth: config.gatewayOutboundAuth,
        gatewayProviderArn: config.gatewayProviderArn,
        gatewayScopes: config.gatewayScopes
          ? config.gatewayScopes
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          : undefined,
        authorizerType: config.authorizerType,
        jwtConfig: config.jwtConfig
          ? {
              discoveryUrl: config.jwtConfig.discoveryUrl,
              allowedAudience: config.jwtConfig.allowedAudience,
              allowedClients: config.jwtConfig.allowedClients,
              allowedScopes: config.jwtConfig.allowedScopes,
              customClaims: config.jwtConfig.customClaims,
              clientId: config.jwtConfig.clientId,
              clientSecret: config.jwtConfig.clientSecret,
            }
          : undefined,
      });
      if (!result.success) {
        setFlow({ name: 'error', message: result.error });
        return;
      }

      setFlow({ name: 'create-success', harnessName: config.name });
    } catch (err) {
      const { getErrorMessage } = await import('../../../errors');
      setFlow({ name: 'error', message: getErrorMessage(err) });
    }
  }, []);

  if (flow.name === 'create-wizard') {
    return (
      <AddHarnessScreen
        existingHarnessNames={existingNames}
        onComplete={config => void handleCreateComplete(config)}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added harness: ${flow.harnessName}`}
        detail="Harness config written to app/. Deploy with `agentcore deploy`."
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add harness"
      detail={flow.message}
      onBack={() => setFlow({ name: 'create-wizard' })}
      onExit={onExit}
    />
  );
}
