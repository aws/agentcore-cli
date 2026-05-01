import { ConfigIO } from '../../../../lib';
import { listConfigurationBundleVersions } from '../../../aws/agentcore-config-bundles';
import { ErrorPrompt } from '../../components';
import { useCreateABTest, useExistingABTestNames } from '../../hooks/useCreateABTest';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddConfigBundleFlow } from '../config-bundle/AddConfigBundleFlow';
import { AddABTestScreen } from './AddABTestScreen';
import type { HttpGatewayInfo, OnlineEvalConfigInfo, RuntimeInfo } from './AddABTestScreen';
import { TargetBasedABTestScreen } from './TargetBasedABTestScreen';
import type { AddABTestConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'target-wizard' }
  | { name: 'create-bundle' }
  | { name: 'create-success'; testName: string }
  | { name: 'error'; message: string };

interface AddABTestFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddABTestFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddABTestFlowProps) {
  const { createABTest, createTargetBasedABTest, reset: resetCreate } = useCreateABTest();
  const { names: existingNames } = useExistingABTestNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  // Load deployed state for bundle lists
  const [agents, setAgents] = useState<{ name: string }[]>([]);
  const [existingHttpGateways, setExistingHttpGateways] = useState<string[]>([]);
  const [deployedBundles, setDeployedBundles] = useState<{ name: string; bundleId: string }[]>([]);
  const [onlineEvalConfigs, setOnlineEvalConfigs] = useState<string[]>([]);
  const [runtimesInfo, setRuntimesInfo] = useState<RuntimeInfo[]>([]);
  const [httpGatewayDetails, setHttpGatewayDetails] = useState<HttpGatewayInfo[]>([]);
  const [onlineEvalConfigDetails, setOnlineEvalConfigDetails] = useState<OnlineEvalConfigInfo[]>([]);
  const [region, setRegion] = useState('us-east-1');

  const [loadEpoch, setLoadEpoch] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const configIO = new ConfigIO();
        const deployedState = await configIO.readDeployedState();
        const projectSpec = await configIO.readProjectSpec();

        // Get region from first target
        for (const [, target] of Object.entries(deployedState.targets ?? {})) {
          const resources = target.resources;

          // Deployed config bundles
          const bundles = resources?.configBundles;
          if (bundles) {
            setDeployedBundles(
              Object.entries(bundles).map(([name, state]) => ({
                name,
                bundleId: state.bundleId,
              }))
            );
          }
          break;
        }

        // Agents from project spec runtimes
        const runtimes = projectSpec.runtimes ?? [];
        setAgents(runtimes.map(r => ({ name: r.name })));

        // Runtimes with endpoints for target-based mode
        setRuntimesInfo(
          runtimes.map(r => ({
            name: r.name,
            endpoints: Object.entries(r.endpoints ?? {}).map(([epName, ep]) => ({
              name: epName,
              version: ep.version,
            })),
          }))
        );

        // Existing HTTP gateways from project spec
        const httpGws = projectSpec.httpGateways ?? [];
        setExistingHttpGateways(httpGws.map(gw => gw.name));

        // HTTP gateway details with targets for target-based mode
        setHttpGatewayDetails(
          httpGws.map(gw => ({
            name: gw.name,
            runtimeRef: gw.runtimeRef,
            targets: (gw.targets ?? []).map(t => ({
              name: t.name,
              runtimeRef: t.runtimeRef,
              qualifier: t.qualifier,
            })),
          }))
        );

        // Online eval configs from project spec
        const evalConfigs = projectSpec.onlineEvalConfigs ?? [];
        setOnlineEvalConfigs(evalConfigs.map(c => c.name));
        setOnlineEvalConfigDetails(
          evalConfigs.map(c => ({
            name: c.name,
            agent: c.agent,
            endpoint: c.endpoint,
          }))
        );

        // Region from aws-targets, falling back to env
        const targets = await configIO.resolveAWSDeploymentTargets();
        if (targets.length > 0) {
          setRegion(targets[0]!.region);
        } else {
          setRegion(process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1');
        }
      } catch {
        // No deployed state — lists will be empty
      }
    })();
  }, [loadEpoch]);

  const fetchBundleVersions = useCallback(
    async (bundleId: string) => {
      try {
        const result = await listConfigurationBundleVersions({ region, bundleId });
        return result.versions.map(v => ({
          versionId: v.versionId,
          createdAt: v.versionCreatedAt,
        }));
      } catch {
        return [];
      }
    },
    [region]
  );

  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddABTestConfig) => {
      if (config.mode === 'target-based') {
        const gatewayName =
          config.gatewayChoice.type === 'existing-http'
            ? config.gatewayChoice.name
            : config.gatewayChoice.type === 'create-new'
              ? `${config.name.replace(/_/g, '-').slice(0, 44)}-gw`
              : '';
        void createTargetBasedABTest({
          name: config.name,
          description: config.description || undefined,
          gateway: gatewayName,
          runtime: config.runtime,
          controlEndpoint: config.controlEndpoint,
          treatmentEndpoint: config.treatmentEndpoint,
          controlWeight: config.controlWeight,
          treatmentWeight: config.treatmentWeight,
          controlOnlineEval: config.controlOnlineEval,
          treatmentOnlineEval: config.treatmentOnlineEval,
          enableOnCreate: config.enableOnCreate,
        }).then(result => {
          if (result.ok) {
            setFlow({ name: 'create-success', testName: result.testName });
            return;
          }
          setFlow({ name: 'error', message: result.error });
        });
        return;
      }

      const controlWeight = 100 - config.treatmentWeight;
      void createABTest({
        name: config.name,
        description: config.description || undefined,
        agent: config.agent,
        gatewayChoice: config.gatewayChoice,
        controlBundle: config.controlBundle,
        controlVersion: config.controlVersion,
        treatmentBundle: config.treatmentBundle,
        treatmentVersion: config.treatmentVersion,
        controlWeight,
        treatmentWeight: config.treatmentWeight,
        onlineEval: config.onlineEval,
        maxDuration: config.maxDuration,
        enableOnCreate: config.enableOnCreate,
      }).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', testName: result.testName });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createABTest, createTargetBasedABTest]
  );

  const handleSwitchToTargetBased = useCallback(() => {
    setFlow({ name: 'target-wizard' });
  }, []);

  const handleCreateBundle = useCallback(() => {
    setFlow({ name: 'create-bundle' });
  }, []);

  const handleBundleFlowDone = useCallback(() => {
    setLoadEpoch(e => e + 1);
    setFlow({ name: 'create-wizard' });
  }, []);

  if (flow.name === 'create-bundle') {
    return (
      <AddConfigBundleFlow isInteractive={isInteractive} onExit={handleBundleFlowDone} onBack={handleBundleFlowDone} />
    );
  }

  if (flow.name === 'target-wizard') {
    return (
      <TargetBasedABTestScreen
        onComplete={handleCreateComplete}
        onExit={onBack}
        existingTestNames={existingNames}
        runtimes={runtimesInfo}
        httpGatewayDetails={httpGatewayDetails}
        existingHttpGateways={existingHttpGateways}
        onlineEvalConfigDetails={onlineEvalConfigDetails}
      />
    );
  }

  if (flow.name === 'create-wizard') {
    return (
      <AddABTestScreen
        existingTestNames={existingNames}
        agents={agents}
        existingHttpGateways={existingHttpGateways}
        deployedBundles={deployedBundles}
        onlineEvalConfigs={onlineEvalConfigs}
        fetchBundleVersions={fetchBundleVersions}
        onComplete={handleCreateComplete}
        onExit={onBack}
        onCreateBundle={handleCreateBundle}
        runtimes={runtimesInfo}
        httpGatewayDetails={httpGatewayDetails}
        onlineEvalConfigDetails={onlineEvalConfigDetails}
        onSwitchToTargetBased={handleSwitchToTargetBased}
      />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added AB test: ${flow.testName}`}
        detail="AB test added to project in `agentcore/agentcore.json`. Deploy with `agentcore deploy` to create."
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add AB test"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
