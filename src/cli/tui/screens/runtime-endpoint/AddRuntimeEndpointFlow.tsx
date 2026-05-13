import { ConfigIO } from '../../../../lib';
import { runtimeEndpointPrimitive } from '../../../primitives/registry';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddRuntimeEndpointScreen } from './AddRuntimeEndpointScreen';
import type { RuntimeEndpointWizardConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

/** Map of runtime name → latest deployed version (undefined if not deployed) */
export type RuntimeVersionMap = Record<string, number | undefined>;

type FlowState =
  | { name: 'loading' }
  | { name: 'create-wizard'; runtimeNames: string[]; runtimeVersions: RuntimeVersionMap }
  | { name: 'create-success'; endpointName: string; runtimeName: string }
  | { name: 'error'; message: string };

interface AddRuntimeEndpointFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddRuntimeEndpointFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
}: AddRuntimeEndpointFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  // Load runtimes and deployed version info on mount
  useEffect(() => {
    void (async () => {
      try {
        const configIO = new ConfigIO();
        const spec = await configIO.readProjectSpec();
        const runtimeNames = spec.runtimes.map(r => r.name);
        if (runtimeNames.length === 0) {
          setFlow({ name: 'error', message: 'No runtimes found. Add a runtime first with `agentcore add agent`.' });
          return;
        }

        // Load deployed state to get version info per runtime
        const runtimeVersions: RuntimeVersionMap = {};
        if (configIO.configExists('state')) {
          try {
            const deployedState = await configIO.readDeployedState();
            for (const target of Object.values(deployedState.targets)) {
              const runtimes = target.resources?.runtimes ?? {};
              for (const [name, state] of Object.entries(runtimes)) {
                if (state.runtimeVersion) {
                  runtimeVersions[name] = state.runtimeVersion;
                }
              }
            }
          } catch {
            // Deployed state may not exist yet — that's fine
          }
        }

        setFlow({ name: 'create-wizard', runtimeNames, runtimeVersions });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setFlow({ name: 'error', message });
      }
    })();
  }, []);

  // In non-interactive mode, exit after success
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback((config: RuntimeEndpointWizardConfig) => {
    void withCommandRunTelemetry('add.runtime-endpoint', {}, () =>
      runtimeEndpointPrimitive.add({
        runtime: config.runtimeName,
        endpoint: config.endpointName,
        version: config.version,
        description: config.description,
      })
    ).then(result => {
      if (result.success) {
        setFlow({
          name: 'create-success',
          endpointName: config.endpointName,
          runtimeName: config.runtimeName,
        });
        return;
      }
      setFlow({ name: 'error', message: result.error?.message ?? 'Unknown error' });
    });
  }, []);

  if (flow.name === 'loading') {
    return null;
  }

  if (flow.name === 'create-wizard') {
    return (
      <AddRuntimeEndpointScreen
        runtimeNames={flow.runtimeNames}
        runtimeVersions={flow.runtimeVersions}
        onComplete={handleCreateComplete}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added endpoint: ${flow.endpointName} \u2192 ${flow.runtimeName}`}
        detail="Run `agentcore deploy` to create the endpoint."
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return <ErrorPrompt message="Failed to add runtime endpoint" detail={flow.message} onBack={onBack} onExit={onExit} />;
}
