import { ToolNameSchema } from '../../../../schema';
import {
  ConfirmReview,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddMcpToolConfig, ComputeHost, ExposureMode, TargetLanguage } from './types';
import { COMPUTE_HOST_OPTIONS, EXPOSURE_MODE_OPTIONS, MCP_TOOL_STEP_LABELS, TARGET_LANGUAGE_OPTIONS } from './types';
import { useAddMcpToolWizard } from './useAddMcpWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddMcpToolScreenProps {
  existingGateways: string[];
  existingAgents: string[];
  existingToolNames: string[];
  onComplete: (config: AddMcpToolConfig) => void;
  onExit: () => void;
}

export function AddMcpToolScreen({
  existingGateways,
  existingAgents,
  existingToolNames,
  onComplete,
  onExit,
}: AddMcpToolScreenProps) {
  const wizard = useAddMcpToolWizard(existingGateways, existingAgents);

  const languageItems: SelectableItem[] = useMemo(
    () => TARGET_LANGUAGE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const exposureItems: SelectableItem[] = useMemo(
    () =>
      EXPOSURE_MODE_OPTIONS.map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
        disabled: 'disabled' in o ? o.disabled : undefined,
      })),
    []
  );

  const gatewayItems: SelectableItem[] = useMemo(
    () => existingGateways.map(g => ({ id: g, title: g })),
    [existingGateways]
  );

  const hostItems: SelectableItem[] = useMemo(
    () => COMPUTE_HOST_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const agentItems: SelectableItem[] = useMemo(() => existingAgents.map(a => ({ id: a, title: a })), [existingAgents]);

  const isLanguageStep = wizard.step === 'language';
  const isExposureStep = wizard.step === 'exposure';
  const isAgentsStep = wizard.step === 'agents';
  const isGatewayStep = wizard.step === 'gateway';
  const isHostStep = wizard.step === 'host';
  const isTextStep = wizard.step === 'name';
  const isConfirmStep = wizard.step === 'confirm';
  const noGatewaysAvailable = isGatewayStep && existingGateways.length === 0;
  const noAgentsAvailable = isAgentsStep && existingAgents.length === 0;

  const languageNav = useListNavigation({
    items: languageItems,
    onSelect: item => wizard.setLanguage(item.id as TargetLanguage),
    onExit: () => onExit(),
    isActive: isLanguageStep,
  });

  const exposureNav = useListNavigation({
    items: exposureItems,
    onSelect: item => wizard.setExposure(item.id as ExposureMode),
    onExit: () => wizard.goBack(),
    isActive: isExposureStep,
    isDisabled: item => item.disabled === true,
  });

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => wizard.setGateway(item.id),
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !noGatewaysAvailable,
  });

  const hostNav = useListNavigation({
    items: hostItems,
    onSelect: item => wizard.setHost(item.id as ComputeHost),
    onExit: () => wizard.goBack(),
    isActive: isHostStep,
  });

  const agentsNav = useMultiSelectNavigation({
    items: agentItems,
    getId: item => item.id,
    onConfirm: selected => wizard.setAgents(selected),
    onExit: () => wizard.goBack(),
    isActive: isAgentsStep && !noAgentsAvailable,
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
      : isAgentsStep
        ? HELP_TEXT.MULTI_SELECT
        : HELP_TEXT.NAVIGATE_SELECT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={MCP_TOOL_STEP_LABELS} />;

  const isMcpRuntime = wizard.config.exposure === 'mcp-runtime';

  return (
    <Screen title="Add MCP Tool" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isLanguageStep && (
          <WizardSelect title="Select language" items={languageItems} selectedIndex={languageNav.selectedIndex} />
        )}

        {isExposureStep && (
          <WizardSelect
            title="Select exposure mode"
            description="How will this tool be accessed?"
            items={exposureItems}
            selectedIndex={exposureNav.selectedIndex}
          />
        )}

        {isGatewayStep && !noGatewaysAvailable && (
          <WizardSelect
            title="Select gateway"
            description="Which gateway will route to this tool?"
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {noGatewaysAvailable && <NoGatewaysMessage />}

        {isAgentsStep && !noAgentsAvailable && (
          <WizardMultiSelect
            title="Select agents to attach"
            description="Which agents can invoke this MCP runtime?"
            items={agentItems}
            cursorIndex={agentsNav.cursorIndex}
            selectedIds={agentsNav.selectedIds}
          />
        )}

        {noAgentsAvailable && <NoAgentsMessage />}

        {isHostStep && (
          <WizardSelect
            title="Select compute host"
            description="Where will this tool run?"
            items={hostItems}
            selectedIndex={hostNav.selectedIndex}
          />
        )}

        {isTextStep && (
          <TextInput
            key={wizard.step}
            prompt={MCP_TOOL_STEP_LABELS[wizard.step]}
            initialValue={generateUniqueName('mytool', existingToolNames)}
            onSubmit={wizard.setName}
            onCancel={() => (wizard.currentIndex === 0 ? onExit() : wizard.goBack())}
            schema={ToolNameSchema}
            customValidation={value => !existingToolNames.includes(value) || 'Tool name already exists'}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              { label: 'Language', value: wizard.config.language },
              { label: 'Exposure', value: isMcpRuntime ? 'MCP Runtime' : 'Behind Gateway' },
              ...(isMcpRuntime && wizard.config.selectedAgents.length > 0
                ? [{ label: 'Agents', value: wizard.config.selectedAgents.join(', ') }]
                : []),
              ...(!isMcpRuntime && wizard.config.gateway ? [{ label: 'Gateway', value: wizard.config.gateway }] : []),
              { label: 'Host', value: wizard.config.host },
              { label: 'Source', value: wizard.config.sourcePath },
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

function NoAgentsMessage() {
  return (
    <Box flexDirection="column">
      <Text color="yellow">No agents found</Text>
      <Text dimColor>Create an agent first to attach MCP runtime tools.</Text>
      <Text dimColor>You can still create the tool and attach agents later.</Text>
      <Box marginTop={1}>
        <Text dimColor>Enter to continue without agents · Esc back</Text>
      </Box>
    </Box>
  );
}
