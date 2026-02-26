import { ToolNameSchema } from '../../../../schema';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddGatewayTargetConfig } from './types';
import { MCP_TOOL_STEP_LABELS, SKIP_FOR_NOW } from './types';
import { useAddGatewayTargetWizard } from './useAddGatewayTargetWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddGatewayTargetScreenProps {
  existingGateways: string[];
  existingToolNames: string[];
  onComplete: (config: AddGatewayTargetConfig) => void;
  onExit: () => void;
}

export function AddGatewayTargetScreen({
  existingGateways,
  existingToolNames,
  onComplete,
  onExit,
}: AddGatewayTargetScreenProps) {
  const wizard = useAddGatewayTargetWizard(existingGateways);

  const gatewayItems: SelectableItem[] = useMemo(
    () => [
      ...existingGateways.map(g => ({ id: g, title: g })),
      { id: SKIP_FOR_NOW, title: 'Skip for now', description: 'Create unassigned target' },
    ],
    [existingGateways]
  );

  const isGatewayStep = wizard.step === 'gateway';
  const isTextStep = wizard.step === 'name' || wizard.step === 'endpoint';
  const isConfirmStep = wizard.step === 'confirm';
  const noGatewaysAvailable = isGatewayStep && existingGateways.length === 0;

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => wizard.setGateway(item.id),
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !noGatewaysAvailable,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isConfirmStep
    ? HELP_TEXT.CONFIRM_CANCEL
    : isTextStep
      ? HELP_TEXT.TEXT_INPUT
      : HELP_TEXT.NAVIGATE_SELECT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={MCP_TOOL_STEP_LABELS} />;

  return (
    <Screen title="Add MCP Tool" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isGatewayStep && !noGatewaysAvailable && (
          <WizardSelect
            title="Select gateway"
            description="Which gateway will route to this tool?"
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {noGatewaysAvailable && <NoGatewaysMessage />}

        {isTextStep && (
          <TextInput
            key={wizard.step}
            prompt={wizard.step === 'endpoint' ? 'MCP server endpoint URL' : MCP_TOOL_STEP_LABELS[wizard.step]}
            initialValue={wizard.step === 'endpoint' ? undefined : generateUniqueName('mytool', existingToolNames)}
            placeholder={wizard.step === 'endpoint' ? 'https://example.com/mcp' : undefined}
            onSubmit={wizard.step === 'endpoint' ? wizard.setEndpoint : wizard.setName}
            onCancel={() => (wizard.currentIndex === 0 ? onExit() : wizard.goBack())}
            schema={wizard.step === 'name' ? ToolNameSchema : undefined}
            customValidation={
              wizard.step === 'name'
                ? value => !existingToolNames.includes(value) || 'Tool name already exists'
                : wizard.step === 'endpoint'
                  ? value => {
                      try {
                        const url = new URL(value);
                        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                          return 'Endpoint must use http:// or https:// protocol';
                        }
                        return true;
                      } catch {
                        return 'Must be a valid URL (e.g. https://example.com/mcp)';
                      }
                    }
                  : undefined
            }
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              {
                label: 'Source',
                value: wizard.config.source === 'existing-endpoint' ? 'Existing endpoint' : 'Create new',
              },
              ...(wizard.config.endpoint ? [{ label: 'Endpoint', value: wizard.config.endpoint }] : []),
              ...(wizard.config.source === 'create-new' ? [{ label: 'Language', value: wizard.config.language }] : []),
              ...(wizard.config.gateway ? [{ label: 'Gateway', value: wizard.config.gateway }] : []),
              ...(!wizard.config.gateway ? [{ label: 'Gateway', value: '(none - assign later)' }] : []),
              ...(wizard.config.source === 'create-new' ? [{ label: 'Host', value: wizard.config.host }] : []),
              ...(wizard.config.source === 'create-new' ? [{ label: 'Source', value: wizard.config.sourcePath }] : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

function NoGatewaysMessage() {
  return (
    <Box flexDirection="column">
      <Text color="yellow">No gateways found</Text>
      <Text dimColor>Add a gateway first, then attach tools to it.</Text>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}
