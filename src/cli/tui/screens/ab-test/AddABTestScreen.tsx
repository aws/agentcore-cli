import { ABTestNameSchema } from '../../../../schema/schemas/primitives/ab-test';
import type { SelectableItem } from '../../components';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import type { VersionLoadState } from './VariantConfigForm';
import { VariantConfigForm } from './VariantConfigForm';
import type { AddABTestConfig, TargetInfo } from './types';
import { AB_TEST_STEP_LABELS } from './types';
import { useAddABTestWizard } from './useAddABTestWizard';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

function formatVersionDate(value: string): string {
  const n = Number(value);
  if (!isNaN(n) && n > 0) {
    // Epoch seconds (< 1e12) vs milliseconds (>= 1e12)
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toLocaleString();
  }
  return new Date(value).toLocaleString();
}

/** Runtime endpoint info passed from the parent flow. */
export interface RuntimeEndpointInfo {
  name: string;
  version: number;
}

/** Runtime info with endpoints, passed from the parent flow. */
export interface RuntimeInfo {
  name: string;
  endpoints: RuntimeEndpointInfo[];
}

/** Gateway target info passed from the parent flow. */
export interface GatewayTargetInfo {
  name: string;
  runtimeRef: string;
  qualifier: string;
}

/** HTTP gateway info with targets, passed from the parent flow. */
export interface HttpGatewayInfo {
  name: string;
  runtimeRef: string;
  targets: GatewayTargetInfo[];
}

/** Online eval config info with agent and endpoint for filtering. */
export interface OnlineEvalConfigInfo {
  name: string;
  agent: string;
  endpoint?: string;
}

interface AddABTestScreenProps {
  onComplete: (config: AddABTestConfig) => void;
  onExit: () => void;
  existingTestNames: string[];
  agents: { name: string }[];
  existingHttpGateways: string[];
  deployedBundles: { name: string; bundleId: string }[];
  onlineEvalConfigs: string[];
  fetchBundleVersions: (bundleId: string) => Promise<{ versionId: string; createdAt: string }[]>;
  onCreateBundle?: () => void;
  /** Full runtime info including endpoints (for target-based mode). */
  runtimes: RuntimeInfo[];
  /** Full HTTP gateway info including targets (for target-based mode). */
  httpGatewayDetails: HttpGatewayInfo[];
  /** Full online eval config objects for target-based eval filtering. */
  onlineEvalConfigDetails?: OnlineEvalConfigInfo[];
  /** Callback to switch to the dedicated target-based wizard screen. */
  onSwitchToTargetBased?: () => void;
}

export function AddABTestScreen({
  onComplete,
  onExit,
  existingTestNames,
  agents,
  existingHttpGateways,
  deployedBundles,
  onlineEvalConfigs,
  fetchBundleVersions,
  onCreateBundle,
  runtimes,
  httpGatewayDetails,
  onlineEvalConfigDetails = [],
  onSwitchToTargetBased,
}: AddABTestScreenProps) {
  const wizard = useAddABTestWizard();

  // Build select items
  const agentItems: SelectableItem[] = useMemo(
    () => agents.map(a => ({ id: a.name, title: a.name, description: 'Agent' })),
    [agents]
  );

  const bundleItems: SelectableItem[] = useMemo(
    () => deployedBundles.map(b => ({ id: b.name, title: b.name, description: `ID: ${b.bundleId}` })),
    [deployedBundles]
  );

  const onlineEvalItems: SelectableItem[] = useMemo(
    () => onlineEvalConfigs.map(name => ({ id: name, title: name, description: 'Online Eval Config' })),
    [onlineEvalConfigs]
  );

  const gatewayItems: SelectableItem[] = useMemo(() => {
    const items: SelectableItem[] = [];
    for (const gwName of existingHttpGateways) {
      items.push({ id: gwName, title: gwName, description: 'Existing HTTP gateway' });
    }
    items.push({
      id: '__create__',
      title: '+ Create new gateway',
      description: 'Auto-create for this AB test',
      spaceBefore: items.length > 0,
    });
    return items;
  }, [existingHttpGateways]);

  const enableItems: SelectableItem[] = useMemo(
    () => [
      { id: 'yes', title: 'Yes', description: 'Start the AB test immediately after deploy' },
      { id: 'no', title: 'No', description: 'Create paused — start manually later' },
    ],
    []
  );

  // Version items — fetched dynamically per bundle
  const [controlVersionItems, setControlVersionItems] = React.useState<SelectableItem[]>([]);
  const [treatmentVersionItems, setTreatmentVersionItems] = React.useState<SelectableItem[]>([]);
  const [controlVersionLoadState, setControlVersionLoadState] = React.useState<VersionLoadState>('idle');
  const [treatmentVersionLoadState, setTreatmentVersionLoadState] = React.useState<VersionLoadState>('idle');

  const handleFetchVersions = React.useCallback(
    (bundleName: string) => {
      const bundle = deployedBundles.find(b => b.name === bundleName);
      if (!bundle) return;

      setControlVersionLoadState('loading');
      setTreatmentVersionLoadState('loading');

      void fetchBundleVersions(bundle.bundleId)
        .then(versions => {
          const items = versions.map(v => ({
            id: v.versionId,
            title: v.versionId.slice(0, 8),
            description: `Created: ${formatVersionDate(v.createdAt)}`,
          }));
          setControlVersionItems(items);
          setTreatmentVersionItems(items);
          setControlVersionLoadState('loaded');
          setTreatmentVersionLoadState('loaded');
        })
        .catch(() => {
          setControlVersionLoadState('error');
          setTreatmentVersionLoadState('error');
        });
    },
    [deployedBundles, fetchBundleVersions]
  );

  // ── Gateway sub-flow state (target-based: "create new" text input) ────────
  const [gatewayCreateMode, setGatewayCreateMode] = useState(false);

  // ── Target picker sub-flow state ──────────────────────────────────────────
  // Sub-flow phases: 'pick' -> 'selectRuntime' -> 'selectQualifier'
  type TargetSubFlowPhase = 'pick' | 'selectRuntime' | 'selectQualifier';
  const [controlSubFlow, setControlSubFlow] = useState<TargetSubFlowPhase>('pick');
  const [controlNewRuntime, setControlNewRuntime] = useState('');

  const [treatmentSubFlow, setTreatmentSubFlow] = useState<TargetSubFlowPhase>('pick');
  const [treatmentNewRuntime, setTreatmentNewRuntime] = useState('');

  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on step change */
  useEffect(() => {
    if (wizard.step === 'controlTarget') {
      setControlSubFlow('pick');
      setControlNewRuntime('');
    }
  }, [wizard.step]);

  useEffect(() => {
    if (wizard.step === 'treatmentTarget') {
      setTreatmentSubFlow('pick');
      setTreatmentNewRuntime('');
    }
  }, [wizard.step]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Step flags
  const isModeStep = wizard.step === 'mode';
  const isNameStep = wizard.step === 'name';
  const isDescriptionStep = wizard.step === 'description';
  const isAgentStep = wizard.step === 'agent';
  const isGatewayStep = wizard.step === 'gateway';
  const isVariantsStep = wizard.step === 'variants';
  const isOnlineEvalStep = wizard.step === 'onlineEval';
  const isControlTargetStep = wizard.step === 'controlTarget';
  const isTreatmentTargetStep = wizard.step === 'treatmentTarget';
  const isWeightsStep = wizard.step === 'weights';
  const isEvalPathStep = wizard.step === 'evalPath';
  const isEvalSelectStep = wizard.step === 'evalSelect';
  const isEnableStep = wizard.step === 'enableOnCreate';
  const isConfirmStep = wizard.step === 'confirm';

  const isTargetBased = wizard.config.mode === 'target-based';

  // Tell the wizard which steps to skip (both forward and backward navigation).
  const gatewayChoiceTypeRef = React.useRef(wizard.config.gatewayChoice.type);

  const shouldSkipStep = useCallback(
    (s: string) => {
      // Agent selection is only needed in config-bundle mode when auto-creating a gateway.
      if (s === 'agent' && (isTargetBased || gatewayChoiceTypeRef.current !== 'create-new')) return true;
      // Config-bundle steps skipped in target-based mode
      if (s === 'variants' && isTargetBased) return true;
      if (s === 'onlineEval' && isTargetBased) return true;
      // Target-based steps skipped in config-bundle mode
      if (s === 'controlTarget' && !isTargetBased) return true;
      if (s === 'treatmentTarget' && !isTargetBased) return true;
      if (s === 'weights' && !isTargetBased) return true;
      if (s === 'evalPath' && !isTargetBased) return true;
      if (s === 'evalSelect' && !isTargetBased) return true;
      if (s === 'evalCreate' && !isTargetBased) return true;
      if (s === 'evalSamplingRate' && !isTargetBased) return true;
      if (s === 'maxDuration') return true;
      return false;
    },
    [isTargetBased]
  );

  useEffect(() => {
    wizard.setSkipCheck(shouldSkipStep);
  }, [shouldSkipStep]); // wizard.setSkipCheck is stable (useCallback with no deps)

  // Mode selection items
  const modeItems: SelectableItem[] = useMemo(
    () => [
      {
        id: 'config-bundle',
        title: 'Config Bundle',
        description: 'Split traffic between config bundle versions (same target, different config)',
      },
      {
        id: 'target-based',
        title: 'Target-Based',
        description: 'Split traffic between gateway targets (different targets, each self-contained)',
      },
    ],
    []
  );

  // ── Target picker items builder ──────────────────────────────────────────
  // Builds the three-section grouped picker items for target selection.
  const buildTargetItems = useCallback(
    (excludeTarget: TargetInfo | null): SelectableItem[] => {
      const items: SelectableItem[] = [];

      // Section 1: Existing targets on the selected gateway
      const selectedGw = httpGatewayDetails.find(g => g.name === wizard.config.gateway);
      const existingTargets = selectedGw?.targets ?? [];
      if (existingTargets.length > 0) {
        items.push({
          id: '__section_existing__',
          title: '── Existing Targets ──',
          description: '',
          disabled: true,
        });
        for (const t of existingTargets) {
          if (excludeTarget?.name === t.name) continue;
          items.push({
            id: `existing:${t.name}`,
            title: t.name,
            description: `endpoint=${t.qualifier}  runtime=${t.runtimeRef}`,
          });
        }
      }

      // Section 2: Endpoints from project runtimes (quick-create targets)
      const endpointItems: SelectableItem[] = [];
      for (const rt of runtimes) {
        for (const ep of rt.endpoints) {
          const targetName = ep.name;
          if (excludeTarget?.name === targetName) continue;
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
          title: '── Endpoints ──',
          description: 'Select to auto-create target',
          disabled: true,
          spaceBefore: items.length > 0,
        });
        items.push(...endpointItems);
      }

      // Section 3: Create new target
      items.push({
        id: '__create_target__',
        title: '+ Create new target',
        description: 'Configure runtime, name, and endpoint',
        spaceBefore: true,
      });

      return items;
    },
    [httpGatewayDetails, runtimes, wizard.config.gateway]
  );

  const controlTargetItems = useMemo(() => buildTargetItems(null), [buildTargetItems]);
  const treatmentTargetItems = useMemo(
    () => buildTargetItems(wizard.config.controlTargetInfo),
    [buildTargetItems, wizard.config.controlTargetInfo]
  );

  // Runtime items for the "create new target" sub-flow
  const runtimeItems: SelectableItem[] = useMemo(
    () => runtimes.map(r => ({ id: r.name, title: r.name, description: `${r.endpoints.length} endpoint(s)` })),
    [runtimes]
  );

  // Qualifier items for a given runtime (DEFAULT + all endpoints)
  const buildQualifierItems = useCallback(
    (runtimeName: string): SelectableItem[] => {
      const rt = runtimes.find(r => r.name === runtimeName);
      const items: SelectableItem[] = [{ id: 'DEFAULT', title: 'DEFAULT', description: 'Default endpoint' }];
      if (rt) {
        for (const ep of rt.endpoints) {
          items.push({ id: ep.name, title: ep.name, description: `v${ep.version}` });
        }
      }
      return items;
    },
    [runtimes]
  );

  const controlEndpointItems = useMemo(
    () => buildQualifierItems(controlNewRuntime),
    [buildQualifierItems, controlNewRuntime]
  );
  const treatmentEndpointItems = useMemo(
    () => buildQualifierItems(treatmentNewRuntime),
    [buildQualifierItems, treatmentNewRuntime]
  );

  // Navigation hooks for select steps
  const modeNav = useListNavigation({
    items: modeItems,
    onSelect: item => {
      if (item.id === 'target-based' && onSwitchToTargetBased) {
        onSwitchToTargetBased();
        return;
      }
      wizard.setMode(item.id as 'config-bundle' | 'target-based');
    },
    onExit: () => wizard.goBack(),
    isActive: isModeStep,
  });

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit: () => wizard.goBack(),
    isActive: isAgentStep,
  });

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => {
      if (item.id === '__create__') {
        setGatewayCreateMode(true);
        return;
      }
      const choice = { type: 'existing-http', name: item.id } as const;
      gatewayChoiceTypeRef.current = choice.type;
      wizard.setGatewayWithName(item.id, false);
    },
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !gatewayCreateMode,
    isDisabled: item => item.disabled === true,
  });

  const onlineEvalNav = useListNavigation({
    items: onlineEvalItems,
    onSelect: item => wizard.setOnlineEval(item.id),
    onExit: () => wizard.goBack(),
    isActive: isOnlineEvalStep,
  });

  // ── Control target picker navigation ─────────────────────────────────────
  const controlTargetNav = useListNavigation({
    items: controlTargetItems,
    onSelect: item => {
      if (item.id === '__create_target__') {
        setControlSubFlow('selectRuntime');
        return;
      }
      if (item.id.startsWith('existing:')) {
        const targetName = item.id.replace('existing:', '');
        const selectedGw = httpGatewayDetails.find(g => g.name === wizard.config.gateway);
        const target = selectedGw?.targets.find(t => t.name === targetName);
        if (target) {
          wizard.setControlTarget(
            { name: target.name, runtimeRef: target.runtimeRef, qualifier: target.qualifier },
            false
          );
        }
        return;
      }
      if (item.id.startsWith('endpoint:')) {
        const path = item.id.replace('endpoint:', '');
        const [runtimeName, endpointName] = path.split('/');
        if (runtimeName && endpointName) {
          const autoName = `${runtimeName}-${endpointName}`;
          wizard.setControlTarget({ name: autoName, runtimeRef: runtimeName, qualifier: endpointName }, true);
        }
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isControlTargetStep && controlSubFlow === 'pick',
    isDisabled: item => item.disabled === true,
  });

  // Control sub-flow: select runtime
  const controlRuntimeNav = useListNavigation({
    items: runtimeItems,
    onSelect: item => {
      setControlNewRuntime(item.id);
      setControlSubFlow('selectQualifier');
    },
    onExit: () => setControlSubFlow('pick'),
    isActive: isControlTargetStep && controlSubFlow === 'selectRuntime',
  });

  // Control sub-flow: select qualifier (auto-generates target name)
  const controlEndpointNav = useListNavigation({
    items: controlEndpointItems,
    onSelect: item => {
      const autoName = `${controlNewRuntime}-${item.id}`;
      wizard.setControlTarget({ name: autoName, runtimeRef: controlNewRuntime, qualifier: item.id }, true);
    },
    onExit: () => setControlSubFlow('selectRuntime'),
    isActive: isControlTargetStep && controlSubFlow === 'selectQualifier',
  });

  // ── Treatment target picker navigation ───────────────────────────────────
  const treatmentTargetNav = useListNavigation({
    items: treatmentTargetItems,
    onSelect: item => {
      if (item.id === '__create_target__') {
        setTreatmentSubFlow('selectRuntime');
        return;
      }
      if (item.id.startsWith('existing:')) {
        const targetName = item.id.replace('existing:', '');
        const selectedGw = httpGatewayDetails.find(g => g.name === wizard.config.gateway);
        const target = selectedGw?.targets.find(t => t.name === targetName);
        if (target) {
          wizard.setTreatmentTarget(
            { name: target.name, runtimeRef: target.runtimeRef, qualifier: target.qualifier },
            false
          );
        }
        return;
      }
      if (item.id.startsWith('endpoint:')) {
        const path = item.id.replace('endpoint:', '');
        const [runtimeName, endpointName] = path.split('/');
        if (runtimeName && endpointName) {
          const autoName = `${runtimeName}-${endpointName}`;
          wizard.setTreatmentTarget({ name: autoName, runtimeRef: runtimeName, qualifier: endpointName }, true);
        }
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isTreatmentTargetStep && treatmentSubFlow === 'pick',
    isDisabled: item => item.disabled === true,
  });

  // Treatment sub-flow: select runtime
  const treatmentRuntimeNav = useListNavigation({
    items: runtimeItems,
    onSelect: item => {
      setTreatmentNewRuntime(item.id);
      setTreatmentSubFlow('selectQualifier');
    },
    onExit: () => setTreatmentSubFlow('pick'),
    isActive: isTreatmentTargetStep && treatmentSubFlow === 'selectRuntime',
  });

  // Treatment sub-flow: select qualifier (auto-generates target name)
  const treatmentEndpointNav = useListNavigation({
    items: treatmentEndpointItems,
    onSelect: item => {
      const autoName = `${treatmentNewRuntime}-${item.id}`;
      wizard.setTreatmentTarget({ name: autoName, runtimeRef: treatmentNewRuntime, qualifier: item.id }, true);
    },
    onExit: () => setTreatmentSubFlow('selectRuntime'),
    isActive: isTreatmentTargetStep && treatmentSubFlow === 'selectQualifier',
  });

  const evalPathItems: SelectableItem[] = useMemo(
    () => [
      {
        id: 'select',
        title: 'Select existing online eval configs',
        description: 'Use configs already in your project',
      },
      { id: 'create', title: 'Create new', description: 'Pick evaluators + sampling rate, auto-create configs' },
    ],
    []
  );

  const evalPathNav = useListNavigation({
    items: evalPathItems,
    onSelect: item => wizard.setEvalPath(item.id as 'select' | 'create'),
    onExit: () => wizard.goBack(),
    isActive: isEvalPathStep,
  });

  // ── Eval select sub-flow: pick control eval, then treatment eval ────────
  type EvalSelectPhase = 'controlEval' | 'treatmentEval';
  const [evalSelectPhase, setEvalSelectPhase] = useState<EvalSelectPhase>('controlEval');
  const [selectedControlEval, setSelectedControlEval] = useState('');

  // Reset eval select sub-flow when entering the step
  /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on step change */
  useEffect(() => {
    if (wizard.step === 'evalSelect') {
      setEvalSelectPhase('controlEval');
      setSelectedControlEval('');
    }
  }, [wizard.step]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Filter online eval configs by runtime + endpoint (qualifier)
  const controlRuntime = wizard.config.controlTargetInfo?.runtimeRef ?? '';
  const controlEndpoint = wizard.config.controlTargetInfo?.qualifier ?? '';
  const treatmentRuntime = wizard.config.treatmentTargetInfo?.runtimeRef ?? '';
  const treatmentEndpoint = wizard.config.treatmentTargetInfo?.qualifier ?? '';

  const controlEvalItems: SelectableItem[] = useMemo(() => {
    return onlineEvalConfigDetails
      .filter(c => c.agent === controlRuntime && (c.endpoint ?? 'DEFAULT') === controlEndpoint)
      .map(c => ({ id: c.name, title: c.name, description: `${c.agent}/${c.endpoint ?? 'DEFAULT'}` }));
  }, [onlineEvalConfigDetails, controlRuntime, controlEndpoint]);

  const treatmentEvalItems: SelectableItem[] = useMemo(() => {
    return onlineEvalConfigDetails
      .filter(c => c.agent === treatmentRuntime && (c.endpoint ?? 'DEFAULT') === treatmentEndpoint)
      .map(c => ({ id: c.name, title: c.name, description: `${c.agent}/${c.endpoint ?? 'DEFAULT'}` }));
  }, [onlineEvalConfigDetails, treatmentRuntime, treatmentEndpoint]);

  const controlEvalNoMatch = isEvalSelectStep && evalSelectPhase === 'controlEval' && controlEvalItems.length === 0;
  const treatmentEvalNoMatch =
    isEvalSelectStep && evalSelectPhase === 'treatmentEval' && treatmentEvalItems.length === 0;

  const controlEvalNav = useListNavigation({
    items: controlEvalItems,
    onSelect: item => {
      setSelectedControlEval(item.id);
      setEvalSelectPhase('treatmentEval');
    },
    onExit: () => wizard.goBack(),
    isActive: isEvalSelectStep && evalSelectPhase === 'controlEval' && !controlEvalNoMatch,
  });

  const treatmentEvalNav = useListNavigation({
    items: treatmentEvalItems,
    onSelect: item => {
      wizard.setEvalSelect(selectedControlEval, item.id);
    },
    onExit: () => setEvalSelectPhase('controlEval'),
    isActive: isEvalSelectStep && evalSelectPhase === 'treatmentEval' && !treatmentEvalNoMatch,
  });

  const enableNav = useListNavigation({
    items: enableItems,
    onSelect: item => wizard.setEnableOnCreate(item.id === 'yes'),
    onExit: () => wizard.goBack(),
    isActive: isEnableStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  // Help text
  const isSelectStep =
    isModeStep ||
    isAgentStep ||
    (isGatewayStep && !gatewayCreateMode) ||
    isOnlineEvalStep ||
    isEnableStep ||
    isControlTargetStep ||
    isTreatmentTargetStep ||
    isEvalPathStep ||
    isEvalSelectStep;
  const helpText = isSelectStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : isVariantsStep
        ? HELP_TEXT.VARIANTS_FORM
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={AB_TEST_STEP_LABELS} />;

  const controlWeight = 100 - wizard.config.treatmentWeight;

  // Format target display for confirm review
  const formatTargetDisplay = (info: TargetInfo | null, isNew: boolean): string => {
    if (!info) return '(not set)';
    const newLabel = isNew ? ' (new)' : '';
    return `${info.name} endpoint=${info.qualifier} runtime=${info.runtimeRef}${newLabel}`;
  };

  return (
    <Screen
      title="Add AB Test [preview]"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={false}
    >
      <Panel fullWidth>
        {isModeStep && (
          <WizardSelect
            title="What type of A/B test do you want to create?"
            items={modeItems}
            selectedIndex={modeNav.selectedIndex}
          />
        )}

        {isNameStep && (
          <TextInput
            key="name"
            prompt="AB test name"
            initialValue=""
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={ABTestNameSchema}
            customValidation={value => (existingTestNames.includes(value) ? `AB test "${value}" already exists` : true)}
          />
        )}

        {isDescriptionStep && (
          <TextInput
            key="description"
            prompt="Description (optional, press Enter to skip)"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setDescription}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isAgentStep && <WizardSelect title="Select agent" items={agentItems} selectedIndex={agentNav.selectedIndex} />}

        {/* ── Step 4: Gateway selection ──────────────────────────── */}
        {isGatewayStep && !gatewayCreateMode && (
          <WizardSelect title="Select gateway" items={gatewayItems} selectedIndex={gatewayNav.selectedIndex} />
        )}
        {isGatewayStep && gatewayCreateMode && (
          <TextInput
            key="gateway-name"
            prompt="New gateway name"
            initialValue=""
            onSubmit={name => {
              gatewayChoiceTypeRef.current = 'create-new';
              wizard.setGatewayWithName(name, true);
              setGatewayCreateMode(false);
            }}
            onCancel={() => setGatewayCreateMode(false)}
          />
        )}

        {isVariantsStep && (
          <VariantConfigForm
            bundleItems={bundleItems}
            fetchVersionItems={handleFetchVersions}
            controlVersionItems={controlVersionItems}
            treatmentVersionItems={treatmentVersionItems}
            controlVersionLoadState={controlVersionLoadState}
            treatmentVersionLoadState={treatmentVersionLoadState}
            onComplete={wizard.setVariants}
            onCancel={() => wizard.goBack()}
            onCreateBundle={onCreateBundle}
          />
        )}

        {/* ── Step 5: Control target selection ─────────────────── */}
        {isControlTargetStep && controlSubFlow === 'pick' && (
          <WizardSelect
            title="Select control target"
            items={controlTargetItems}
            selectedIndex={controlTargetNav.selectedIndex}
          />
        )}
        {isControlTargetStep && controlSubFlow === 'selectRuntime' && (
          <WizardSelect
            title="Select runtime for new control target"
            items={runtimeItems}
            selectedIndex={controlRuntimeNav.selectedIndex}
          />
        )}
        {isControlTargetStep && controlSubFlow === 'selectQualifier' && (
          <WizardSelect
            title={`Select endpoint for control target (runtime: ${controlNewRuntime})`}
            items={controlEndpointItems}
            selectedIndex={controlEndpointNav.selectedIndex}
          />
        )}

        {/* ── Step 6: Treatment target selection ───────────────── */}
        {isTreatmentTargetStep && treatmentSubFlow === 'pick' && (
          <Box flexDirection="column">
            {wizard.config.controlTargetInfo && (
              <Box marginBottom={1}>
                <Text color="green">
                  {'\u2713'} Control: {wizard.config.controlTargetInfo.name} endpoint=
                  {wizard.config.controlTargetInfo.qualifier}
                </Text>
              </Box>
            )}
            <WizardSelect
              title="Select treatment target"
              items={treatmentTargetItems}
              selectedIndex={treatmentTargetNav.selectedIndex}
            />
          </Box>
        )}
        {isTreatmentTargetStep && treatmentSubFlow === 'selectRuntime' && (
          <WizardSelect
            title="Select runtime for new treatment target"
            items={runtimeItems}
            selectedIndex={treatmentRuntimeNav.selectedIndex}
          />
        )}
        {isTreatmentTargetStep && treatmentSubFlow === 'selectQualifier' && (
          <WizardSelect
            title={`Select endpoint for treatment target (runtime: ${treatmentNewRuntime})`}
            items={treatmentEndpointItems}
            selectedIndex={treatmentEndpointNav.selectedIndex}
          />
        )}

        {/* ── Target-based: Traffic weights ───────────────────── */}
        {isWeightsStep && (
          <TextInput
            key="weights"
            prompt="Control weight (1-100, treatment gets the remainder)"
            initialValue={String(wizard.config.controlWeight)}
            onSubmit={value => {
              const w = parseInt(value, 10);
              if (!isNaN(w) && w >= 1 && w <= 99) {
                wizard.setWeights(w, 100 - w);
              }
            }}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const w = parseInt(value, 10);
              if (isNaN(w)) return 'Must be a number';
              if (w < 1 || w > 99) return 'Must be between 1 and 99';
              return true;
            }}
          />
        )}

        {/* ── Target-based: Eval path selection ───────────────── */}
        {isEvalPathStep && (
          <WizardSelect
            title="How do you want to configure evaluation?"
            items={evalPathItems}
            selectedIndex={evalPathNav.selectedIndex}
          />
        )}

        {/* ── Target-based: Eval select (control) ───────────── */}
        {isEvalSelectStep && evalSelectPhase === 'controlEval' && !controlEvalNoMatch && (
          <WizardSelect
            title={`Select online eval for control (${controlRuntime}/${controlEndpoint})`}
            items={controlEvalItems}
            selectedIndex={controlEvalNav.selectedIndex}
          />
        )}
        {isEvalSelectStep && evalSelectPhase === 'controlEval' && controlEvalNoMatch && (
          <Text color="red">
            No online eval config found for {controlRuntime}/{controlEndpoint}. Create one first: agentcore add
            online-eval --runtime {controlRuntime} --endpoint {controlEndpoint}
          </Text>
        )}

        {/* ── Target-based: Eval select (treatment) ─────────── */}
        {isEvalSelectStep && evalSelectPhase === 'treatmentEval' && !treatmentEvalNoMatch && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color="green">
                {'\u2713'} Control eval: {selectedControlEval}
              </Text>
            </Box>
            <WizardSelect
              title={`Select online eval for treatment (${treatmentRuntime}/${treatmentEndpoint})`}
              items={treatmentEvalItems}
              selectedIndex={treatmentEvalNav.selectedIndex}
            />
          </Box>
        )}
        {isEvalSelectStep && evalSelectPhase === 'treatmentEval' && treatmentEvalNoMatch && (
          <Text color="red">
            No online eval config found for {treatmentRuntime}/{treatmentEndpoint}. Create one first: agentcore add
            online-eval --runtime {treatmentRuntime} --endpoint {treatmentEndpoint}
          </Text>
        )}

        {/* ── Config-bundle: Online eval selection ────────────── */}
        {isOnlineEvalStep &&
          (onlineEvalItems.length > 0 ? (
            <WizardSelect
              title="Select online evaluation config"
              items={onlineEvalItems}
              selectedIndex={onlineEvalNav.selectedIndex}
            />
          ) : (
            <Text color="red">
              No online eval configs found. An online eval is required for AB tests. Add one with `agentcore add
              online-eval`, then retry. Press Esc to go back.
            </Text>
          ))}

        {/* TODO(post-preview): Re-enable maxDuration TextInput once configurable duration is launched. */}

        {isEnableStep && (
          <WizardSelect
            title="Enable AB test on creation?"
            items={enableItems}
            selectedIndex={enableNav.selectedIndex}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={
              isTargetBased
                ? [
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
                      value: `Control ${wizard.config.controlWeight}% / Treatment ${100 - wizard.config.controlWeight}%`,
                    },
                    {
                      label: 'Evaluation',
                      value: `C: ${wizard.config.controlOnlineEval}, T1: ${wizard.config.treatmentOnlineEval}`,
                    },
                    { label: 'Enable on create', value: wizard.config.enableOnCreate ? 'Yes' : 'No' },
                  ]
                : [
                    { label: 'Mode', value: 'Config Bundle' },
                    { label: 'Name', value: wizard.config.name },
                    ...(wizard.config.description ? [{ label: 'Description', value: wizard.config.description }] : []),
                    {
                      label: 'Gateway',
                      value:
                        wizard.config.gatewayChoice.type === 'create-new'
                          ? `Create new for ${wizard.config.agent} (auto)`
                          : wizard.config.gatewayChoice.name,
                    },
                    { label: 'Control bundle', value: wizard.config.controlBundle },
                    { label: 'Control version', value: wizard.config.controlVersion.slice(0, 8) },
                    { label: 'Treatment bundle', value: wizard.config.treatmentBundle },
                    { label: 'Treatment version', value: wizard.config.treatmentVersion.slice(0, 8) },
                    {
                      label: 'Traffic split',
                      value: `Control ${controlWeight}% / Treatment ${wizard.config.treatmentWeight}%`,
                    },
                    { label: 'Online eval', value: wizard.config.onlineEval },
                    { label: 'Enable on create', value: wizard.config.enableOnCreate ? 'Yes' : 'No' },
                  ]
            }
          />
        )}
      </Panel>
    </Screen>
  );
}
