import { gatewayTargetPrimitive } from '../../../primitives/registry';
import { ErrorPrompt } from '../../components';
import { useExistingGateways, useExistingToolNames } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddWebSearchScreen } from './AddWebSearchScreen';
import type { AddWebSearchConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; toolName: string; gateway: string; excludeDomains?: string[] }
  | { name: 'error'; message: string };

interface AddWebSearchFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddWebSearchFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddWebSearchFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });
  const { gateways: existingGateways } = useExistingGateways();
  const { toolNames: existingToolNames } = useExistingToolNames();

  // In non-interactive mode, exit after success.
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleComplete = useCallback((config: AddWebSearchConfig) => {
    void gatewayTargetPrimitive
      .createWebSearchGatewayTarget({
        targetType: 'webSearch',
        name: config.name,
        gateway: config.gateway,
        ...(config.excludeDomains && config.excludeDomains.length > 0 ? { excludeDomains: config.excludeDomains } : {}),
      })
      .then((result: { toolName: string }) => {
        setFlow({
          name: 'create-success',
          toolName: result.toolName,
          gateway: config.gateway,
          excludeDomains: config.excludeDomains,
        });
      })
      .catch((err: unknown) => {
        setFlow({ name: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
      });
  }, []);

  if (flow.name === 'create-wizard') {
    return (
      <AddWebSearchScreen
        existingGatewayNames={existingGateways}
        existingToolNames={existingToolNames}
        onComplete={handleComplete}
        onExit={onBack}
      />
    );
  }
  if (flow.name === 'create-success') {
    const excludeSuffix =
      flow.excludeDomains && flow.excludeDomains.length > 0
        ? ` Excluded domains: ${flow.excludeDomains.join(', ')}.`
        : '';
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Web search target "${flow.toolName}" added`}
        detail={`Wired to gateway "${flow.gateway}".${excludeSuffix} Run 'agentcore deploy' to deploy.`}
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }
  if (flow.name === 'error') {
    return (
      <ErrorPrompt message="Failed to add web search target" detail={flow.message} onBack={onBack} onExit={onExit} />
    );
  }
  return null;
}
