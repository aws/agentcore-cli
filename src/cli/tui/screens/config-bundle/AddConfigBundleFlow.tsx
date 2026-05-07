import { ConfigIO } from '../../../../lib';
import { ErrorPrompt, GradientText, Screen } from '../../components';
import { useCreateConfigBundle, useExistingConfigBundleNames } from '../../hooks/useCreateConfigBundle';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddConfigBundleScreen } from './AddConfigBundleScreen';
import type { AddConfigBundleConfig, DeployedComponent } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'loading' }
  | { name: 'create-wizard'; deployedComponents: DeployedComponent[] }
  | { name: 'create-success'; bundleName: string }
  | { name: 'error'; message: string };

interface AddConfigBundleFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddConfigBundleFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
}: AddConfigBundleFlowProps) {
  const { createConfigBundle, reset: resetCreate } = useCreateConfigBundle();
  const { names: existingNames } = useExistingConfigBundleNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  // Load deployed runtimes/gateways and fill in undeployed ones from project spec
  useEffect(() => {
    void (async () => {
      try {
        const configIO = new ConfigIO();
        const components: DeployedComponent[] = [];
        const deployedArns = new Set<string>();

        // 1. Collect deployed components (real ARNs)
        try {
          const deployedState = await configIO.readDeployedState();
          for (const target of Object.values(deployedState.targets)) {
            const runtimes = target.resources?.runtimes;
            if (runtimes) {
              for (const [name, state] of Object.entries(runtimes)) {
                components.push({ name, arn: state.runtimeArn, type: 'runtime' });
                deployedArns.add(name);
              }
            }
            const httpGateways = target.resources?.httpGateways;
            if (httpGateways) {
              for (const [name, state] of Object.entries(httpGateways)) {
                components.push({ name, arn: state.gatewayArn, type: 'gateway' });
                deployedArns.add(name);
              }
            }
          }
        } catch {
          // No deployed state yet — that's fine, we'll use project spec below
        }

        // 2. Add undeployed runtimes/gateways from project spec as placeholders
        try {
          const projectSpec = await configIO.readProjectSpec();
          for (const rt of projectSpec.runtimes ?? []) {
            if (!deployedArns.has(rt.name)) {
              components.push({
                name: rt.name,
                arn: `{{runtime:${rt.name}}}`,
                type: 'runtime',
                isPlaceholder: true,
              });
            }
          }
          for (const gw of projectSpec.httpGateways ?? []) {
            if (!deployedArns.has(gw.name)) {
              components.push({
                name: gw.name,
                arn: `{{gateway:${gw.name}}}`,
                type: 'gateway',
                isPlaceholder: true,
              });
            }
          }
        } catch {
          // If we can't read project spec, continue with what we have
        }

        setFlow({ name: 'create-wizard', deployedComponents: components });
      } catch {
        setFlow({ name: 'create-wizard', deployedComponents: [] });
      }
    })();
  }, []);

  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddConfigBundleConfig) => {
      void createConfigBundle({
        name: config.name,
        description: config.description || undefined,
        components: config.components,
        branchName: config.branchName || 'mainline',
        commitMessage: config.commitMessage || `Create ${config.name}`,
      }).then(result => {
        if (result.ok) {
          setFlow(prev => {
            if (prev.name === 'loading') return prev;
            return { name: 'create-success', bundleName: result.bundleName };
          });
          return;
        }
        setFlow(prev => {
          if (prev.name === 'loading') return prev;
          return { name: 'error', message: result.error };
        });
      });
    },
    [createConfigBundle]
  );

  if (flow.name === 'loading') {
    return (
      <Screen title="Add Configuration Bundle" onExit={onBack}>
        <GradientText text="Loading deployed resources..." />
      </Screen>
    );
  }

  if (flow.name === 'create-wizard') {
    return (
      <AddConfigBundleScreen
        existingBundleNames={existingNames}
        deployedComponents={flow.deployedComponents}
        onComplete={handleCreateComplete}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added configuration bundle: ${flow.bundleName}`}
        detail="Bundle added to project in `agentcore/agentcore.json`. Deploy with `agentcore deploy`."
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add configuration bundle"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow(prev => {
          if (prev.name === 'loading') return prev;
          return { name: 'create-wizard', deployedComponents: [] };
        });
      }}
      onExit={onExit}
    />
  );
}
