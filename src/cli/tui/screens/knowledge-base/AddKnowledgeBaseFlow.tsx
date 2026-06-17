import { gatewayPrimitive, knowledgeBasePrimitive } from '../../../primitives/registry';
import { ErrorPrompt } from '../../components';
import { useExistingGateways } from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddKnowledgeBaseScreen } from './AddKnowledgeBaseScreen';
import { groupDataSources } from './groupDataSources';
import { isInlineJsonValue, materializeInlineConnectorConfig, stripInlineJsonPrefix } from './inline-connector-config';
import type { AddKnowledgeBaseConfig, CapturedDataSource } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; knowledgeBaseName: string; sources: string[]; gatewayWired?: string }
  | { name: 'error'; message: string };

interface AddKnowledgeBaseFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddKnowledgeBaseFlow({
  isInteractive = true,
  onExit,
  onBack,
  onDev,
  onDeploy,
}: AddKnowledgeBaseFlowProps) {
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const { gateways: existingGateways } = useExistingGateways();

  // Load existing KB names for duplicate detection.
  useEffect(() => {
    void knowledgeBasePrimitive.getRemovable().then(removables => {
      setExistingNames(removables.map(r => r.name));
    });
  }, []);

  // In non-interactive mode, exit after success.
  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleComplete = useCallback((config: AddKnowledgeBaseConfig) => {
    void (async () => {
      // Materialize any inline-JSON connector configs to disk first. The
      // wizard tags those entries with INLINE_JSON_PREFIX; we strip the
      // prefix, write the JSON to app/<kbName>/<auto-name>.json, and replace
      // the captured value with the resulting path so the primitive sees a
      // normal connector-config path. Failures here surface to the user as a
      // wizard error before any primitive call.
      let materializedSources: CapturedDataSource[];
      try {
        materializedSources = await Promise.all(
          config.dataSources.map(async ds => {
            if (!isInlineJsonValue(ds.value)) return ds;
            const json = stripInlineJsonPrefix(ds.value);
            const path = await materializeInlineConnectorConfig({
              kbName: config.name,
              dataSourceType: ds.dataSourceType,
              jsonContents: json,
            });
            return { dataSourceType: ds.dataSourceType, value: path };
          })
        );
      } catch (err) {
        setFlow({
          name: 'error',
          message: `Failed to save inline connector config: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      // Group captured sources by data-source-type, then dispatch one
      // primitive.add() per group sequentially: the first call creates the
      // KB, subsequent calls hit appendToExisting() and add their sources to
      // the same KB. The primitive's gateway-equality guard accepts the same
      // gateway value on every append; description is sent only on the first
      // call so the no-update guard can't trip.
      const groups = groupDataSources(materializedSources);
      if (groups.length === 0) {
        setFlow({ name: 'error', message: 'No data sources captured.' });
        return;
      }

      // If the user chose "Create a new gateway and attach", create the
      // gateway BEFORE the KB add. Use sensible defaults — authorizer NONE,
      // semantic search on — so the inline-create stays a single step. The
      // user can edit the gateway later via `agentcore add gateway` flags or
      // the schema directly. Mutually exclusive with `config.gateway`.
      //
      // Track whether we created the gateway in *this* flow so we can roll it
      // back if a downstream KB add fails. Without this, a failure mid-flow
      // (duplicate source, gateway-equality mismatch, etc.) leaves the new
      // gateway persisted in agentcore.json with no KB attached — the user
      // sees an error toast but their config has drifted.
      let gatewayToWire: string | undefined = config.gateway;
      let createdGatewayInThisFlow: string | undefined;
      if (config.newGatewayName) {
        const gwResult = await gatewayPrimitive.add({
          name: config.newGatewayName,
          authorizerType: 'NONE',
          enableSemanticSearch: true,
        });
        if (!gwResult.success) {
          setFlow({
            name: 'error',
            message: `Failed to create gateway "${config.newGatewayName}": ${gwResult.error.message}`,
          });
          return;
        }
        gatewayToWire = gwResult.gatewayName;
        createdGatewayInThisFlow = gwResult.gatewayName;
      }

      const rollbackGatewayIfCreated = async (reason: string): Promise<string> => {
        if (!createdGatewayInThisFlow) return reason;
        const removeResult = await gatewayPrimitive.remove(createdGatewayInThisFlow);
        if (removeResult.success) {
          return `${reason} (rolled back the gateway "${createdGatewayInThisFlow}" that was just created.)`;
        }
        return `${reason} (note: gateway "${createdGatewayInThisFlow}" was created but rollback failed: ${removeResult.error?.message ?? 'unknown error'}. Run \`agentcore remove gateway --name ${createdGatewayInThisFlow}\` to clean up.)`;
      };

      const totalSources: string[] = [];
      let gatewayWired: string | undefined;

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!;
        const isS3 = group.dataSourceType === 's3';
        const isFirst = i === 0;
        const result = await knowledgeBasePrimitive.add({
          name: config.name,
          ...(isFirst && config.description ? { description: config.description } : {}),
          dataSourceType: group.dataSourceType,
          ...(isS3 ? { source: group.values } : { connectorConfig: group.values }),
          gateway: gatewayToWire,
        });

        if (!result.success) {
          const message = await rollbackGatewayIfCreated(
            `Failed on ${group.dataSourceType} group: ${result.error.message}`
          );
          setFlow({ name: 'error', message });
          return;
        }

        totalSources.push(...result.newDataSources);
        if (result.gatewayWired) {
          gatewayWired = result.gatewayWired;
        }
      }

      setFlow({
        name: 'create-success',
        knowledgeBaseName: config.name,
        sources: totalSources,
        gatewayWired,
      });
    })();
  }, []);

  if (flow.name === 'create-wizard') {
    return (
      <AddKnowledgeBaseScreen
        existingKnowledgeBaseNames={existingNames}
        existingGatewayNames={existingGateways}
        onComplete={handleComplete}
        onExit={onBack}
      />
    );
  }
  if (flow.name === 'create-success') {
    const wiredSuffix = flow.gatewayWired ? ` Wired to gateway "${flow.gatewayWired}" as a connector target.` : '';
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Knowledge base "${flow.knowledgeBaseName}" added`}
        detail={`${flow.sources.length} data source(s).${wiredSuffix} Run 'agentcore deploy' to create the KB and start ingestion.`}
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }
  if (flow.name === 'error') {
    return <ErrorPrompt message="Failed to add knowledge base" detail={flow.message} onBack={onBack} onExit={onExit} />;
  }
  return null;
}
