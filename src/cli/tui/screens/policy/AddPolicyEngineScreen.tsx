import { PolicyEngineNameSchema } from '../../../../schema';
import { Panel, Screen, TextInput } from '../../components';
import { HELP_TEXT } from '../../constants';
import { generateUniqueName } from '../../utils';
import type { AddPolicyEngineConfig } from './types';
import React from 'react';

interface AddPolicyEngineScreenProps {
  onComplete: (config: AddPolicyEngineConfig) => void;
  onExit: () => void;
  existingEngineNames: string[];
  headerContent?: React.ReactNode;
}

export function AddPolicyEngineScreen({
  onComplete,
  onExit,
  existingEngineNames,
  headerContent,
}: AddPolicyEngineScreenProps) {
  return (
    <Screen title="Add Policy Engine" onExit={onExit} helpText={HELP_TEXT.TEXT_INPUT} headerContent={headerContent}>
      <Panel>
        <TextInput
          key="name"
          prompt="Policy engine name"
          initialValue={generateUniqueName('MyPolicyEngine', existingEngineNames)}
          onSubmit={name => onComplete({ name })}
          onCancel={onExit}
          schema={PolicyEngineNameSchema}
          customValidation={value => !existingEngineNames.includes(value) || 'Policy engine name already exists'}
        />
      </Panel>
    </Screen>
  );
}
