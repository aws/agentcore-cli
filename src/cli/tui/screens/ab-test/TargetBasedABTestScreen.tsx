import type { SelectableItem } from '../../components';
import {
  ConfirmReview,
  Cursor,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  TwoColumn,
  WizardSelect,
} from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { usePanelNavigation } from '../../hooks/usePanelNavigation';
import type { HttpGatewayInfo, OnlineEvalConfigInfo, RuntimeInfo } from './AddABTestScreen';
import type { AddABTestConfig, TargetInfo } from './types';
import { TARGET_BASED_STEP_LABELS, useTargetBasedWizard } from './useTargetBasedWizard';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface TargetBasedABTestScreenProps {
  onComplete: (config: AddABTestConfig) => void;
  onExit: () => void;
  existingTestNames: string[];
  runtimes: RuntimeInfo[];
  httpGatewayDetails: HttpGatewayInfo[];
  existingHttpGateways: string[];
  onlineEvalConfigDetails: OnlineEvalConfigInfo[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder field indices
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_TARGET = 0;
const FIELD_WEIGHT = 1;
const FIELD_EVAL = 2;
const FIELD_COUNT = 3;

// ─────────────────────────────────────────────────────────────────────────────
// VariantColumn sub-component
// ─────────────────────────────────────────────────────────────────────────────

interface VariantColumnProps {
  label: string;
  color: string;
  isActive: boolean;
  focusedField: number | null;
  activeField: number | null;
  targetInfo: TargetInfo | null;
  weight: number;
  evalConfigName: string;
  targetItems: SelectableItem[];
  targetNavIndex: number;
  evalItems: SelectableItem[];
  evalNavIndex: number;
  onWeightSubmit: (value: string) => void;
  onWeightCancel: () => void;
}

function VariantColumn({
  label,
  color,
  isActive,
  focusedField,
  activeField,
  targetInfo,
  weight,
  evalConfigName,
  targetItems,
  targetNavIndex,
  evalItems,
  evalNavIndex,
  onWeightSubmit,
  onWeightCancel,
}: VariantColumnProps) {
  const borderColor = isActive ? color : 'gray';

  const fieldLabel = (idx: number, text: string, value: string) => {
    const isFocused = focusedField === idx;
    const isFieldActive = activeField === idx;
    const prefix = isFocused || isFieldActive ? '>' : ' ';
    const checkmark = value && value !== '(not set)' ? '\u2713 ' : '';

    return (
      <Box>
        <Text color={isFocused ? color : undefined} bold={isFocused}>
          {prefix} {text}:{' '}
        </Text>
        <Text color={checkmark ? 'green' : 'gray'}>
          {checkmark}
          {value}
        </Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text bold color={color}>
        {label}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {/* Target field */}
        {activeField === FIELD_TARGET ? (
          <WizardSelect title="Select target" items={targetItems} selectedIndex={targetNavIndex} />
        ) : (
          fieldLabel(
            FIELD_TARGET,
            'Target',
            targetInfo ? `${targetInfo.name} (${targetInfo.runtimeRef}/${targetInfo.qualifier})` : '(not set)'
          )
        )}

        {/* Weight field */}
        {activeField === FIELD_WEIGHT ? (
          <TextInput
            key="weight"
            prompt={`${label} weight (1-99)`}
            initialValue={String(weight)}
            onSubmit={onWeightSubmit}
            onCancel={onWeightCancel}
            customValidation={value => {
              const w = parseInt(value, 10);
              if (isNaN(w)) return 'Must be a number';
              if (w < 1 || w > 99) return 'Must be between 1 and 99';
              return true;
            }}
          />
        ) : (
          fieldLabel(FIELD_WEIGHT, 'Weight', `${weight}%`)
        )}

        {/* Eval config field */}
        {activeField === FIELD_EVAL ? (
          evalItems.length > 0 ? (
            <WizardSelect title="Select eval config" items={evalItems} selectedIndex={evalNavIndex} />
          ) : (
            <Box flexDirection="column">
              <Text color="yellow">No eval config found for this target.</Text>
              <Text dimColor>Press Esc to go back. Create one with: agentcore add online-eval</Text>
            </Box>
          )
        ) : (
          fieldLabel(FIELD_EVAL, 'Eval', evalConfigName || '(optional)')
        )}
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export function TargetBasedABTestScreen({
  onComplete,
  onExit,
  existingTestNames,
  runtimes,
  httpGatewayDetails,
  existingHttpGateways,
  onlineEvalConfigDetails,
}: TargetBasedABTestScreenProps) {
  const wizard = useTargetBasedWizard();

  // ── Name/Description multi-field form ───────────────────────────────────
  type NameField = 'name' | 'description';
  const NAME_FIELDS: NameField[] = ['name', 'description'];
  const [activeNameField, setActiveNameField] = useState<NameField>('name');
  const [nameValue, setNameValue] = useState('');
  const [descriptionValue, setDescriptionValue] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [gatewayCreateMode, setGatewayCreateMode] = useState(false);

  // Step flags
  const isNameStep = wizard.step === 'nameDescription';
  const isGatewayStep = wizard.step === 'gateway';
  const isBuilderStep = wizard.step === 'builder';
  const isEnableStep = wizard.step === 'enableOnCreate';
  const isConfirmStep = wizard.step === 'confirm';

  // ── Name/Description input handler ─────────────────────────────────────
  useInput(
    (input, key) => {
      if (!isNameStep) return;

      if (key.escape) {
        if (activeNameField === 'description') {
          setActiveNameField('name');
        } else {
          onExit();
        }
        return;
      }

      if (key.tab || key.upArrow || key.downArrow) {
        const idx = NAME_FIELDS.indexOf(activeNameField);
        if (key.shift || key.upArrow) {
          setActiveNameField(NAME_FIELDS[(idx - 1 + NAME_FIELDS.length) % NAME_FIELDS.length]!);
        } else {
          setActiveNameField(NAME_FIELDS[(idx + 1) % NAME_FIELDS.length]!);
        }
        setNameError(null);
        return;
      }

      if (key.return) {
        if (activeNameField === 'name') {
          if (!nameValue.trim()) {
            setNameError('Name is required');
            return;
          }
          if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(nameValue.trim())) {
            setNameError('Must begin with a letter, alphanumeric + underscores only (max 48 chars)');
            return;
          }
          if (existingTestNames.includes(nameValue.trim())) {
            setNameError(`AB test "${nameValue.trim()}" already exists`);
            return;
          }
          setActiveNameField('description');
          setNameError(null);
          return;
        }
        // On description, submit both
        if (!nameValue.trim()) {
          setNameError('Name is required');
          setActiveNameField('name');
          return;
        }
        wizard.setName(nameValue.trim());
        wizard.setDescription(descriptionValue.trim());
        wizard.advanceFromNameDescription();
        return;
      }

      // Text input
      if (key.backspace || key.delete) {
        if (activeNameField === 'name') setNameValue(v => v.slice(0, -1));
        else setDescriptionValue(v => v.slice(0, -1));
        setNameError(null);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (activeNameField === 'name') setNameValue(v => v + input);
        else setDescriptionValue(v => v + input);
        setNameError(null);
      }
    },
    { isActive: isNameStep }
  );

  // ── Gateway items ───────────────────────────────────────────────────────
  const gatewayItems: SelectableItem[] = useMemo(() => {
    const items: SelectableItem[] = [];
    for (const gwName of existingHttpGateways) {
      items.push({ id: gwName, title: gwName, description: 'Existing HTTP gateway' });
    }
    items.push({
      id: '__create__',
      title: 'Create new gateway',
      description: 'Auto-create for this AB test',
    });
    return items;
  }, [existingHttpGateways]);

  // ── Target items builder ────────────────────────────────────────────────
  const buildTargetItems = useCallback(
    (excludeTarget: TargetInfo | null): SelectableItem[] => {
      const items: SelectableItem[] = [];

      // Section 1: Existing targets on the selected gateway
      const selectedGw = httpGatewayDetails.find(g => g.name === wizard.config.gateway);
      const existingTargets = selectedGw?.targets ?? [];
      if (existingTargets.length > 0) {
        items.push({
          id: '__section_existing__',
          title: '── Gateway Targets ──',
          description: '',
          disabled: true,
        });
        for (const t of existingTargets) {
          if (t.name === excludeTarget?.name) continue;
          items.push({
            id: `existing:${t.name}`,
            title: t.name,
            description: `${t.runtimeRef}/${t.qualifier}`,
          });
        }
      }

      // Section 2: Runtime endpoints (auto-create targets)
      const endpointItems: SelectableItem[] = [];
      for (const rt of runtimes) {
        for (const ep of rt.endpoints) {
          const targetName = `${rt.name}-${ep.name}`;
          if (targetName === excludeTarget?.name) continue;
          endpointItems.push({
            id: `endpoint:${rt.name}/${ep.name}`,
            title: `${rt.name}/${ep.name}`,
            description: `v${ep.version}`,
          });
        }
      }
      if (endpointItems.length > 0) {
        items.push({
          id: '__section_endpoints__',
          title: '── Runtime Endpoints ──\n   Select to auto-create target',
          description: '',
          disabled: true,
          spaceBefore: items.length > 0,
        });
        items.push(...endpointItems);
      }

      return items;
    },
    [httpGatewayDetails, runtimes, wizard.config.gateway]
  );

  const controlTargetItems = useMemo(() => buildTargetItems(null), [buildTargetItems]);
  const treatmentTargetItems = useMemo(
    () => buildTargetItems(wizard.config.controlTargetInfo),
    [buildTargetItems, wizard.config.controlTargetInfo]
  );

  // ── Eval items (auto-matched by runtime + endpoint) ─────────────────────
  const buildEvalItems = useCallback(
    (targetInfo: TargetInfo | null): SelectableItem[] => {
      if (!targetInfo) return [];
      return onlineEvalConfigDetails
        .filter(c => c.agent === targetInfo.runtimeRef && (c.endpoint ?? 'DEFAULT') === targetInfo.qualifier)
        .map(c => ({ id: c.name, title: c.name, description: `${c.agent}/${c.endpoint ?? 'DEFAULT'}` }));
    },
    [onlineEvalConfigDetails]
  );

  const controlEvalItems = useMemo(
    () => buildEvalItems(wizard.config.controlTargetInfo),
    [buildEvalItems, wizard.config.controlTargetInfo]
  );
  const treatmentEvalItems = useMemo(
    () => buildEvalItems(wizard.config.treatmentTargetInfo),
    [buildEvalItems, wizard.config.treatmentTargetInfo]
  );

  // Auto-match eval when target is selected and exactly one match exists
  useEffect(() => {
    if (wizard.config.controlTargetInfo && controlEvalItems.length === 1 && !wizard.config.controlOnlineEval) {
      wizard.setControlEval(controlEvalItems[0]!.id);
    }
  }, [wizard.config.controlTargetInfo, controlEvalItems, wizard.config.controlOnlineEval, wizard.setControlEval]);

  useEffect(() => {
    if (wizard.config.treatmentTargetInfo && treatmentEvalItems.length === 1 && !wizard.config.treatmentOnlineEval) {
      wizard.setTreatmentEval(treatmentEvalItems[0]!.id);
    }
  }, [
    wizard.config.treatmentTargetInfo,
    treatmentEvalItems,
    wizard.config.treatmentOnlineEval,
    wizard.setTreatmentEval,
  ]);

  // ── Enable items ────────────────────────────────────────────────────────
  const enableItems: SelectableItem[] = useMemo(
    () => [
      { id: 'yes', title: 'Yes', description: 'Start the AB test immediately after deploy' },
      { id: 'no', title: 'No', description: 'Create paused — start manually later' },
    ],
    []
  );

  // ── Panel navigation for the builder step ───────────────────────────────
  const panel = usePanelNavigation({
    isActive: isBuilderStep,
    fieldCount: FIELD_COUNT,
    onExit: () => wizard.goBack(),
    onComplete: () => wizard.advance(),
  });

  // ── Target selection handler ────────────────────────────────────────────
  const handleTargetSelect = useCallback(
    (column: number, item: SelectableItem) => {
      const setter = column === 0 ? wizard.setControlTarget : wizard.setTreatmentTarget;

      if (item.id.startsWith('existing:')) {
        const targetName = item.id.replace('existing:', '');
        const selectedGw = httpGatewayDetails.find(g => g.name === wizard.config.gateway);
        const target = selectedGw?.targets.find(t => t.name === targetName);
        if (target) {
          setter({ name: target.name, runtimeRef: target.runtimeRef, qualifier: target.qualifier }, false);
        }
      } else if (item.id.startsWith('endpoint:')) {
        const path = item.id.replace('endpoint:', '');
        const [runtimeName, endpointName] = path.split('/');
        if (runtimeName && endpointName) {
          const autoName = `${runtimeName}-${endpointName}`;
          setter({ name: autoName, runtimeRef: runtimeName, qualifier: endpointName }, true);
        }
      }
      panel.deactivate();
    },
    [httpGatewayDetails, wizard.config.gateway, wizard.setControlTarget, wizard.setTreatmentTarget, panel]
  );

  // ── List navigations for builder pickers ────────────────────────────────

  // Control target picker
  const controlTargetNav = useListNavigation({
    items: controlTargetItems,
    onSelect: item => handleTargetSelect(0, item),
    onExit: () => panel.deactivate(),
    isActive: panel.isFieldActive(0, FIELD_TARGET),
    isDisabled: item => item.disabled === true,
  });

  // Treatment target picker
  const treatmentTargetNav = useListNavigation({
    items: treatmentTargetItems,
    onSelect: item => handleTargetSelect(1, item),
    onExit: () => panel.deactivate(),
    isActive: panel.isFieldActive(1, FIELD_TARGET),
    isDisabled: item => item.disabled === true,
  });

  // Control eval picker
  const controlEvalNav = useListNavigation({
    items: controlEvalItems,
    onSelect: item => {
      wizard.setControlEval(item.id);
      panel.deactivate();
    },
    onExit: () => panel.deactivate(),
    isActive: panel.isFieldActive(0, FIELD_EVAL),
  });

  // Treatment eval picker
  const treatmentEvalNav = useListNavigation({
    items: treatmentEvalItems,
    onSelect: item => {
      wizard.setTreatmentEval(item.id);
      panel.deactivate();
    },
    onExit: () => panel.deactivate(),
    isActive: panel.isFieldActive(1, FIELD_EVAL),
  });

  // ── Non-builder navigation hooks ────────────────────────────────────────

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => {
      if (item.id === '__create__') {
        setGatewayCreateMode(true);
        return;
      }
      wizard.setGateway(item.id, false);
    },
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !gatewayCreateMode,
    isDisabled: item => item.disabled === true,
  });

  const enableNav = useListNavigation({
    items: enableItems,
    onSelect: item => wizard.setEnableOnCreate(item.id === 'yes'),
    onExit: () => wizard.goBack(),
    isActive: isEnableStep,
  });

  // Builder "Continue" navigation — when all fields filled, Enter on confirm row advances
  const builderContinueItems: SelectableItem[] = useMemo(
    () => (wizard.isBuilderComplete ? [{ id: 'continue', title: 'Continue' }] : []),
    [wizard.isBuilderComplete]
  );

  const _builderContinueNav = useListNavigation({
    items: builderContinueItems,
    onSelect: () => wizard.advance(),
    onExit: () => wizard.goBack(),
    isActive: false, // Controlled programmatically below
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.toAddABTestConfig()),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  // ── Help text ───────────────────────────────────────────────────────────
  const isSelectStep = (isGatewayStep && !gatewayCreateMode) || isEnableStep;
  const helpText = isSelectStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : isBuilderStep
        ? 'Tab switch column \u00B7 \u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc back'
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={TARGET_BASED_STEP_LABELS} />
  );

  // ── Format display helpers ──────────────────────────────────────────────
  const formatTargetDisplay = (info: TargetInfo | null, isNew: boolean): string => {
    if (!info) return '(not set)';
    const newLabel = isNew ? ' (new)' : '';
    return `${info.name} endpoint=${info.qualifier} runtime=${info.runtimeRef}${newLabel}`;
  };

  // ── Weight submit handlers ──────────────────────────────────────────────
  const handleControlWeightSubmit = useCallback(
    (value: string) => {
      const w = parseInt(value, 10);
      if (!isNaN(w) && w >= 1 && w <= 99) {
        wizard.setControlWeight(w);
      }
      panel.deactivate();
    },
    [wizard, panel]
  );

  const handleTreatmentWeightSubmit = useCallback(
    (value: string) => {
      const w = parseInt(value, 10);
      if (!isNaN(w) && w >= 1 && w <= 99) {
        // Treatment weight setter: set control to 100 - treatment
        wizard.setControlWeight(100 - w);
      }
      panel.deactivate();
    },
    [wizard, panel]
  );

  const handleWeightCancel = useCallback(() => {
    panel.deactivate();
  }, [panel]);

  return (
    <Screen
      title="Add AB Test — Target-Based"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={false}
    >
      <Panel fullWidth>
        {/* ── Step 1: Name + Description ─────────────────────── */}
        {isNameStep && (
          <Box flexDirection="column">
            <Box>
              <Text color={activeNameField === 'name' ? 'cyan' : 'gray'}>{'Name: '}</Text>
              {activeNameField === 'name' && !nameValue && <Cursor />}
              <Text color={activeNameField === 'name' ? undefined : 'gray'}>
                {nameValue || <Text dimColor>{'e.g., my-ab-test'}</Text>}
              </Text>
              {activeNameField === 'name' && nameValue ? <Cursor /> : null}
            </Box>
            <Box>
              <Text color={activeNameField === 'description' ? 'cyan' : 'gray'}>{'Description: '}</Text>
              {activeNameField === 'description' && !descriptionValue && <Cursor />}
              <Text color={activeNameField === 'description' ? undefined : 'gray'}>
                {descriptionValue || <Text dimColor>{'(optional)'}</Text>}
              </Text>
              {activeNameField === 'description' && descriptionValue ? <Cursor /> : null}
            </Box>
            {nameError && (
              <Box marginTop={1}>
                <Text color="red">{nameError}</Text>
              </Box>
            )}
          </Box>
        )}

        {/* ── Step 2: Gateway ────────────────────────────────── */}
        {isGatewayStep && !gatewayCreateMode && (
          <WizardSelect title="Select gateway" items={gatewayItems} selectedIndex={gatewayNav.selectedIndex} />
        )}
        {isGatewayStep && gatewayCreateMode && (
          <TextInput
            key="tb-gateway-name"
            prompt="New gateway name"
            initialValue=""
            onSubmit={name => {
              wizard.setGateway(name, true);
              setGatewayCreateMode(false);
            }}
            onCancel={() => setGatewayCreateMode(false)}
          />
        )}

        {/* ── Step 3: Side-by-Side Builder ───────────────────── */}
        {isBuilderStep && (
          <Box flexDirection="column">
            <TwoColumn
              left={
                <VariantColumn
                  label="CONTROL"
                  color="cyan"
                  isActive={panel.isColumnActive(0)}
                  focusedField={
                    panel.position.layer === 'focus' && panel.position.column === 0 ? panel.position.field : null
                  }
                  activeField={
                    panel.position.layer === 'active' && panel.position.column === 0 ? panel.position.field : null
                  }
                  targetInfo={wizard.config.controlTargetInfo}
                  weight={wizard.config.controlWeight}
                  evalConfigName={wizard.config.controlOnlineEval}
                  targetItems={controlTargetItems}
                  targetNavIndex={controlTargetNav.selectedIndex}
                  evalItems={controlEvalItems}
                  evalNavIndex={controlEvalNav.selectedIndex}
                  onWeightSubmit={handleControlWeightSubmit}
                  onWeightCancel={handleWeightCancel}
                />
              }
              right={
                <VariantColumn
                  label="TREATMENT"
                  color="yellow"
                  isActive={panel.isColumnActive(1)}
                  focusedField={
                    panel.position.layer === 'focus' && panel.position.column === 1 ? panel.position.field : null
                  }
                  activeField={
                    panel.position.layer === 'active' && panel.position.column === 1 ? panel.position.field : null
                  }
                  targetInfo={wizard.config.treatmentTargetInfo}
                  weight={wizard.config.treatmentWeight}
                  evalConfigName={wizard.config.treatmentOnlineEval}
                  targetItems={treatmentTargetItems}
                  targetNavIndex={treatmentTargetNav.selectedIndex}
                  evalItems={treatmentEvalItems}
                  evalNavIndex={treatmentEvalNav.selectedIndex}
                  onWeightSubmit={handleTreatmentWeightSubmit}
                  onWeightCancel={handleWeightCancel}
                />
              }
            />
            {wizard.isBuilderComplete && (
              <Box marginTop={1}>
                <Text color="green">
                  {'\u2713'} All fields configured. Press Enter to continue, or adjust values above.
                </Text>
              </Box>
            )}
            {!wizard.isBuilderComplete && (
              <Box marginTop={1}>
                <Text dimColor>Configure both columns, then press Enter to continue.</Text>
              </Box>
            )}
          </Box>
        )}

        {/* ── Step 4: Enable on Create ───────────────────────── */}
        {isEnableStep && (
          <WizardSelect
            title="Enable AB test on creation?"
            items={enableItems}
            selectedIndex={enableNav.selectedIndex}
          />
        )}

        {/* ── Step 5: Confirm ────────────────────────────────── */}
        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Mode', value: 'Target-Based' },
              { label: 'Name', value: wizard.config.name },
              ...(wizard.config.description ? [{ label: 'Description', value: wizard.config.description }] : []),
              {
                label: 'Gateway',
                value: wizard.config.gatewayIsNew
                  ? `${wizard.config.gateway} (new)`
                  : wizard.config.gateway || 'Create new (auto)',
              },
              {
                label: 'Control target',
                value: formatTargetDisplay(wizard.config.controlTargetInfo, wizard.config.controlTargetIsNew),
              },
              {
                label: 'Treatment target',
                value: formatTargetDisplay(wizard.config.treatmentTargetInfo, wizard.config.treatmentTargetIsNew),
              },
              {
                label: 'Traffic split',
                value: `Control ${wizard.config.controlWeight}% / Treatment ${wizard.config.treatmentWeight}%`,
              },
              ...(wizard.config.controlOnlineEval || wizard.config.treatmentOnlineEval
                ? [
                    {
                      label: 'Evaluation',
                      value: `C: ${wizard.config.controlOnlineEval || '(none)'}, T: ${wizard.config.treatmentOnlineEval || '(none)'}`,
                    },
                  ]
                : []),
              { label: 'Enable on create', value: wizard.config.enableOnCreate ? 'Yes' : 'No' },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
