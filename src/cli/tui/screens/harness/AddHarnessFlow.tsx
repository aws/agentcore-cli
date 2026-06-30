import { MANAGED_MEMORY_ADD_NOTICE } from '../../../operations/deploy';
import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { useExistingCredentials } from '../identity/useCreateIdentity';
import { AddHarnessScreen } from './AddHarnessScreen';
import { toMemoryAddOptions } from './memory-options';
import type { AddHarnessConfig } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; harnessName: string; managedMemory?: boolean; loading?: boolean; loadingMessage?: string }
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
  const { credentials } = useExistingCredentials();

  const apiKeyCredentialNames = useMemo(
    () => credentials.filter(c => c.authorizerType === 'ApiKeyCredentialProvider').map(c => c.name),
    [credentials]
  );

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
      const memoryOptions = toMemoryAddOptions(config.memory);
      const result = await harnessPrimitive.add({
        name: config.name,
        modelProvider: config.modelProvider,
        modelId: config.modelId,
        apiFormat: config.apiFormat,
        apiKeyArn: config.apiKeyArn,
        apiBase: config.apiBase,
        additionalParams: config.additionalParams,
        ...memoryOptions,
        containerUri: config.containerUri,
        dockerfilePath: config.dockerfilePath,
        maxIterations: config.maxIterations,
        maxTokens: config.maxTokens,
        timeoutSeconds: config.timeoutSeconds,
        temperature: config.temperature,
        topP: config.topP,
        topK: config.topK,
        modelMaxTokens: config.modelMaxTokens,
        allowedTools: config.allowedTools,
        mcpHeaders: config.mcpHeaders,
        truncationStrategy: config.truncationStrategy,
        networkMode: config.networkMode,
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        vpcId: config.vpcId,
        idleTimeout: config.idleTimeout,
        maxLifetime: config.maxLifetime,
        sessionStoragePath: config.sessionStoragePath,
        efsAccessPoints: config.efsAccessPoints,
        s3AccessPoints: config.s3AccessPoints,
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
        skills: config.skills,
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
              privateEndpoint: config.jwtConfig.privateEndpoint,
              privateEndpointOverrides: config.jwtConfig.privateEndpointOverrides,
            }
          : undefined,
      });
      if (!result.success) {
        setFlow({ name: 'error', message: result.error.message });
        return;
      }

      setFlow({ name: 'create-success', harnessName: config.name, managedMemory: result.memoryMode === 'managed' });
    } catch (err) {
      const { getErrorMessage } = await import('../../../errors');
      setFlow({ name: 'error', message: getErrorMessage(err) });
    }
  }, []);

  if (flow.name === 'create-wizard') {
    return (
      <AddHarnessScreen
        existingHarnessNames={existingNames}
        existingApiKeyCredentialNames={apiKeyCredentialNames}
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
        summary={
          flow.managedMemory ? (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Note: {MANAGED_MEMORY_ADD_NOTICE}</Text>
            </Box>
          ) : undefined
        }
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
