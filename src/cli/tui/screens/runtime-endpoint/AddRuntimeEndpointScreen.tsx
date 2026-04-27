import type { SelectableItem } from '../../components';
import { ConfirmReview, Cursor, Panel, Screen, StepIndicator, WizardSelect } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import type { RuntimeVersionMap } from './AddRuntimeEndpointFlow';
import type { RuntimeEndpointWizardConfig, RuntimeEndpointWizardStep } from './types';
import { useAddRuntimeEndpointWizard } from './useAddRuntimeEndpointWizard';
import { Box, Text, useInput } from 'ink';
import React, { useMemo, useState } from 'react';

const STEP_LABELS: Record<RuntimeEndpointWizardStep, string> = {
  runtime: 'Runtime',
  endpoint: 'Endpoint',
  confirm: 'Confirm',
};

type EndpointField = 'name' | 'version' | 'description';
const ENDPOINT_FIELDS: EndpointField[] = ['name', 'version', 'description'];

interface AddRuntimeEndpointScreenProps {
  onComplete: (config: RuntimeEndpointWizardConfig) => void;
  onExit: () => void;
  runtimeNames: string[];
  runtimeVersions: RuntimeVersionMap;
}

export function AddRuntimeEndpointScreen({
  onComplete,
  onExit,
  runtimeNames,
  runtimeVersions,
}: AddRuntimeEndpointScreenProps) {
  const skipRuntimeStep = runtimeNames.length === 1;
  const wizard = useAddRuntimeEndpointWizard({ skipRuntimeStep });

  const singleRuntime = skipRuntimeStep ? runtimeNames[0]! : '';

  // Auto-select the only runtime when skipping runtime step
  const effectiveConfig = useMemo(() => {
    if (skipRuntimeStep && !wizard.config.runtimeName) {
      return { ...wizard.config, runtimeName: singleRuntime };
    }
    return wizard.config;
  }, [skipRuntimeStep, wizard.config, singleRuntime]);

  // If we skip runtime step, set it immediately on first render
  React.useEffect(() => {
    if (skipRuntimeStep && !wizard.config.runtimeName) {
      wizard.setRuntime(singleRuntime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRuntimeStep = wizard.step === 'runtime';
  const isEndpointStep = wizard.step === 'endpoint';
  const isConfirmStep = wizard.step === 'confirm';

  // Get the max deployed version for the selected runtime
  const maxVersion = effectiveConfig.runtimeName ? runtimeVersions[effectiveConfig.runtimeName] : undefined;
  const isDeployed = maxVersion !== undefined;

  // Multi-field state for endpoint step (CustomClaimForm pattern)
  const [activeField, setActiveField] = useState<EndpointField>('name');
  const [endpointName, setEndpointName] = useState('');
  const [endpointVersion, setEndpointVersion] = useState('1');
  const [endpointDescription, setEndpointDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Runtime selection items
  const runtimeItems: SelectableItem[] = useMemo(
    () => runtimeNames.map(name => ({ id: name, title: name })),
    [runtimeNames]
  );

  const runtimeNav = useListNavigation({
    items: runtimeItems,
    onSelect: item => wizard.setRuntime(item.id),
    onExit: () => onExit(),
    isActive: isRuntimeStep,
  });

  // Multi-field input handler for endpoint step
  useInput(
    (input, key) => {
      if (!isEndpointStep) return;

      if (key.escape) {
        if (skipRuntimeStep) {
          onExit();
        } else {
          wizard.goBack();
        }
        return;
      }

      // Tab / Up / Down to cycle fields
      if (key.tab || key.upArrow || key.downArrow) {
        const idx = ENDPOINT_FIELDS.indexOf(activeField);
        if (key.shift || key.upArrow) {
          setActiveField(ENDPOINT_FIELDS[(idx - 1 + ENDPOINT_FIELDS.length) % ENDPOINT_FIELDS.length]!);
        } else {
          setActiveField(ENDPOINT_FIELDS[(idx + 1) % ENDPOINT_FIELDS.length]!);
        }
        setError(null);
        return;
      }

      // Enter: advance to next field, or submit on last field
      if (key.return) {
        const idx = ENDPOINT_FIELDS.indexOf(activeField);
        if (idx < ENDPOINT_FIELDS.length - 1) {
          // Validate current field before advancing
          if (activeField === 'name') {
            if (!endpointName.trim()) {
              setError('Endpoint name is required');
              return;
            }
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(endpointName.trim())) {
              setError('Must begin with a letter, alphanumeric + underscores only (max 48 chars)');
              return;
            }
          }
          if (activeField === 'version') {
            const num = Number(endpointVersion);
            if (!Number.isInteger(num) || num < 1) {
              setError('Version must be a positive integer');
              return;
            }
            if (isDeployed && num > maxVersion) {
              setError(`Version must be between 1 and ${maxVersion} (latest deployed version)`);
              return;
            }
          }
          setActiveField(ENDPOINT_FIELDS[idx + 1]!);
          setError(null);
          return;
        }
        // Last field — validate and submit
        if (!endpointName.trim()) {
          setError('Endpoint name is required');
          return;
        }
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(endpointName.trim())) {
          setError('Must begin with a letter, alphanumeric + underscores only (max 48 chars)');
          return;
        }
        const ver = Number(endpointVersion);
        if (!Number.isInteger(ver) || ver < 1) {
          setError('Version must be a positive integer');
          return;
        }
        if (isDeployed && ver > maxVersion) {
          setError(`Version must be between 1 and ${maxVersion} (latest deployed version)`);
          return;
        }
        const desc = endpointDescription.trim() || undefined;
        wizard.setEndpointDetails(endpointName.trim(), ver, desc);
        return;
      }

      // Text input for active field
      if (activeField === 'name' || activeField === 'version' || activeField === 'description') {
        if (key.backspace || key.delete) {
          if (activeField === 'name') setEndpointName(v => v.slice(0, -1));
          else if (activeField === 'version') setEndpointVersion(v => v.slice(0, -1));
          else setEndpointDescription(v => v.slice(0, -1));
          setError(null);
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          if (activeField === 'name') setEndpointName(v => v + input);
          else if (activeField === 'version') setEndpointVersion(v => v + input);
          else setEndpointDescription(v => v + input);
          setError(null);
          return;
        }
      }
    },
    { isActive: isEndpointStep }
  );

  // Confirm step navigation
  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(effectiveConfig),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isRuntimeStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isEndpointStep
      ? 'tab/↑↓ switch fields  ⏎ submit'
      : HELP_TEXT.CONFIRM_CANCEL;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={STEP_LABELS} />;

  const confirmFields = useMemo(
    () => [
      { label: 'Runtime', value: effectiveConfig.runtimeName },
      { label: 'Endpoint', value: effectiveConfig.endpointName },
      { label: 'Version', value: String(effectiveConfig.version) },
      ...(effectiveConfig.description ? [{ label: 'Description', value: effectiveConfig.description }] : []),
    ],
    [effectiveConfig]
  );

  return (
    <Screen
      title="Add Runtime Endpoint"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={isRuntimeStep}
    >
      <Panel>
        {isRuntimeStep && (
          <WizardSelect title="Select runtime" items={runtimeItems} selectedIndex={runtimeNav.selectedIndex} />
        )}

        {isEndpointStep && (
          <Box flexDirection="column">
            <Text dimColor>Runtime: {effectiveConfig.runtimeName}</Text>
            {isDeployed && <Text dimColor>Current deployed version: {maxVersion}</Text>}
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text color={activeField === 'name' ? 'cyan' : 'gray'}>Endpoint name: </Text>
                {activeField === 'name' && !endpointName && <Cursor />}
                <Text color={activeField === 'name' ? undefined : 'gray'}>
                  {endpointName || <Text dimColor>e.g., prod, staging</Text>}
                </Text>
                {activeField === 'name' && endpointName && <Cursor />}
              </Box>

              <Box>
                <Text color={activeField === 'version' ? 'cyan' : 'gray'}>
                  Version{isDeployed ? ` (1-${maxVersion})` : ''}:{' '}
                </Text>
                {activeField === 'version' && !endpointVersion && <Cursor />}
                <Text color={activeField === 'version' ? undefined : 'gray'}>
                  {endpointVersion || <Text dimColor>1</Text>}
                </Text>
                {activeField === 'version' && endpointVersion && <Cursor />}
              </Box>

              <Box>
                <Text color={activeField === 'description' ? 'cyan' : 'gray'}>Description: </Text>
                {activeField === 'description' && !endpointDescription && <Cursor />}
                <Text color={activeField === 'description' ? undefined : 'gray'}>
                  {endpointDescription || <Text dimColor>(optional)</Text>}
                </Text>
                {activeField === 'description' && endpointDescription && <Cursor />}
              </Box>
            </Box>

            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
