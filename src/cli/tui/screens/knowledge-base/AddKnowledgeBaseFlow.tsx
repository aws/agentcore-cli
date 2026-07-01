import { knowledgeBasePrimitive } from '../../../primitives/registry';
import { ErrorPrompt } from '../../components';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddKnowledgeBaseScreen } from './AddKnowledgeBaseScreen';
import { groupDataSources } from './groupDataSources';
import { isInlineJsonValue, materializeInlineConnectorConfig, stripInlineJsonPrefix } from './inline-connector-config';
import type { AddKnowledgeBaseConfig, CapturedDataSource } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; knowledgeBaseName: string; sources: string[] }
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

      const groups = groupDataSources(materializedSources);
      if (groups.length === 0) {
        setFlow({ name: 'error', message: 'No data sources captured.' });
        return;
      }

      const totalSources: string[] = [];

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!;
        const isS3 = group.dataSourceType === 's3';
        const isFirst = i === 0;
        const result = await knowledgeBasePrimitive.add({
          name: config.name,
          ...(isFirst && config.description ? { description: config.description } : {}),
          dataSourceType: group.dataSourceType,
          ...(isS3 ? { source: group.values } : { connectorConfig: group.values }),
        });

        if (!result.success) {
          setFlow({ name: 'error', message: `Failed on ${group.dataSourceType} group: ${result.error.message}` });
          return;
        }

        totalSources.push(...result.newDataSources);
      }

      setFlow({
        name: 'create-success',
        knowledgeBaseName: config.name,
        sources: totalSources,
      });
    })();
  }, []);

  if (flow.name === 'create-wizard') {
    return (
      <AddKnowledgeBaseScreen existingKnowledgeBaseNames={existingNames} onComplete={handleComplete} onExit={onBack} />
    );
  }
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Knowledge base "${flow.knowledgeBaseName}" added`}
        detail={`${flow.sources.length} data source(s). Run 'agentcore deploy' to create the KB and start ingestion.`}
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
