import { ToolNameSchema } from '../../../../schema';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddWebSearchConfig } from './types';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';

type Step = 'name' | 'gateway' | 'exclude-domains' | 'confirm';

const STEP_LABELS: Record<Step, string> = {
  name: 'Name',
  gateway: 'Gateway',
  'exclude-domains': 'Exclude domains',
  confirm: 'Confirm',
};

const STEPS: Step[] = ['name', 'gateway', 'exclude-domains', 'confirm'];

interface AddWebSearchScreenProps {
  onComplete: (config: AddWebSearchConfig) => void;
  onExit: () => void;
  existingGatewayNames: string[];
  existingToolNames: string[];
}

export function AddWebSearchScreen({
  onComplete,
  onExit,
  existingGatewayNames,
  existingToolNames,
}: AddWebSearchScreenProps) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [gateway, setGateway] = useState<string | undefined>(undefined);
  const [excludeDomains, setExcludeDomains] = useState<string[] | undefined>(undefined);

  const isNameStep = step === 'name';
  const isGatewayStep = step === 'gateway';
  const isExcludeDomainsStep = step === 'exclude-domains';
  const isConfirmStep = step === 'confirm';

  const noGatewaysAvailable = isGatewayStep && existingGatewayNames.length === 0;

  const gatewayItems: SelectableItem[] = useMemo(
    () => existingGatewayNames.map(g => ({ id: g, title: g })),
    [existingGatewayNames]
  );

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    isActive: isGatewayStep && !noGatewaysAvailable,
    onSelect: (item: SelectableItem) => {
      setGateway(item.id);
      setStep('exclude-domains');
    },
    onExit: () => setStep('name'),
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete({ name, gateway: gateway!, excludeDomains }),
    onExit: () => setStep('exclude-domains'),
    isActive: isConfirmStep,
  });

  const helpText = isGatewayStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={STEPS} currentStep={step} labels={STEP_LABELS} />;

  const confirmFields = useMemo(
    () => [
      { label: 'Name', value: name },
      { label: 'Gateway', value: gateway ?? '' },
      {
        label: 'Exclude domains',
        value: excludeDomains && excludeDomains.length > 0 ? excludeDomains.join(', ') : '(none)',
      },
    ],
    [name, gateway, excludeDomains]
  );

  return (
    <Screen
      title="Add Web Search"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={isNameStep || (isGatewayStep && noGatewaysAvailable)}
    >
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Web search target name"
            initialValue={generateUniqueName('web-search', existingToolNames)}
            onSubmit={(value: string) => {
              setName(value);
              setStep('gateway');
            }}
            onCancel={onExit}
            schema={ToolNameSchema}
            customValidation={value => !existingToolNames.includes(value) || 'Target name already exists'}
          />
        )}

        {isGatewayStep && noGatewaysAvailable && <NoGatewaysMessage />}

        {isGatewayStep && !noGatewaysAvailable && (
          <WizardSelect
            title="Attach to which gateway?"
            description="The web search target will be wired to this gateway as an MCP tool."
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {isExcludeDomainsStep && (
          <TextInput
            key="exclude-domains"
            prompt="Exclude domains (optional, comma-separated)"
            placeholder="e.g. internal.example.com, staging.example.com"
            allowEmpty
            onSubmit={(value: string) => {
              const domains = value
                .split(',')
                .map(d => d.trim())
                .filter(d => d.length > 0);
              setExcludeDomains(domains.length > 0 ? domains : undefined);
              setStep('confirm');
            }}
            onCancel={() => setStep('gateway')}
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}

function NoGatewaysMessage() {
  return (
    <Box flexDirection="column">
      <Text color="yellow">No gateways found</Text>
      <Text dimColor>Run `agentcore add gateway` first, then re-run this command.</Text>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}
