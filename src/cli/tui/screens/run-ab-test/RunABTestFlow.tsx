import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { getErrorMessage } from '../../../errors';
import { createJobEngine } from '../../../operations/jobs';
import type { ABTestJobRecord, ABTestMode, StartABTestJobOptions } from '../../../operations/jobs';
import {
  ConfirmReview,
  ErrorPrompt,
  GradientText,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import type { ABTestResources, RunABTestConfig, RunABTestStep } from './types';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

// ============================================================================
// Resource loading
// ============================================================================

const CONFIG_BUNDLE_STEPS: RunABTestStep[] = [
  'mode',
  'gateway',
  'control',
  'treatment',
  'onlineEval',
  'filter',
  'name',
  'confirm',
];

const TARGET_BASED_STEPS: RunABTestStep[] = ['mode', 'gateway', 'control', 'treatment', 'filter', 'name', 'confirm'];

const STEP_LABELS: Record<RunABTestStep, string> = {
  mode: 'Mode',
  gateway: 'Gateway',
  control: 'Control',
  treatment: 'Treatment',
  onlineEval: 'Online Eval',
  filter: 'Filter',
  name: 'Name',
  confirm: 'Confirm',
};

async function loadResources(): Promise<{ resources: ABTestResources; region: string }> {
  const configIO = new ConfigIO();
  const [projectSpec, deployedState, awsTargets] = await Promise.all([
    configIO.readProjectSpec(),
    configIO.readDeployedState(),
    configIO.resolveAWSDeploymentTargets(),
  ]);

  const bundles: { name: string; bundleId: string }[] = [];
  const gateways = new Set<string>();
  const targets = new Set<string>();
  const onlineEvalConfigs = new Set<string>();

  for (const target of Object.values(deployedState.targets ?? {})) {
    const resources = target.resources;
    if (!resources) continue;
    for (const [name, state] of Object.entries(resources.configBundles ?? {})) {
      bundles.push({ name, bundleId: state.bundleId });
    }
    for (const name of Object.keys(resources.mcp?.gateways ?? {})) gateways.add(name);
    for (const name of Object.keys(resources.gateways ?? {})) gateways.add(name);
    for (const name of Object.keys(resources.onlineEvalConfigs ?? {})) onlineEvalConfigs.add(name);
  }

  // Gateway-target names come from project spec (deployed by their spec name as-is; only the gateway
  // itself is prefixed with `${project}-`).
  for (const gw of projectSpec.agentCoreGateways ?? []) {
    for (const t of gw.targets ?? []) {
      if (t.targetType === 'httpRuntime') targets.add(t.name);
    }
  }

  const runtimes = (projectSpec.runtimes ?? []).map(r => r.name);
  const region = awsTargets[0]?.region ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

  return {
    resources: {
      gateways: [...gateways],
      bundles,
      targets: [...targets],
      runtimes,
      onlineEvalConfigs: [...onlineEvalConfigs],
    },
    region,
  };
}

// ============================================================================
// Flow Component
// ============================================================================

type FlowState =
  | { name: 'loading' }
  | { name: 'wizard'; resources: ABTestResources; region: string }
  | { name: 'starting'; config: RunABTestConfig }
  | { name: 'started'; record: ABTestJobRecord; config: RunABTestConfig }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string };

interface RunABTestFlowProps {
  onExit: () => void;
  /** Navigate to the A/B Test Jobs screen (falls back to onExit when not provided). */
  onViewJobs?: () => void;
}

export function RunABTestFlow({ onExit, onViewJobs }: RunABTestFlowProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });

  useEffect(() => {
    if (flow.name !== 'loading') return;
    let cancelled = false;

    void (async () => {
      try {
        await validateAwsCredentials();
      } catch (err) {
        if (!cancelled) setFlow({ name: 'creds-error', message: getErrorMessage(err) });
        return;
      }

      try {
        const { resources, region } = await loadResources();
        if (cancelled) return;
        if (resources.gateways.length === 0) {
          setFlow({
            name: 'error',
            message: 'No deployed gateway found. Run `agentcore add gateway` and `agentcore deploy` first.',
          });
          return;
        }
        setFlow({ name: 'wizard', resources, region });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]);

  // Fire-and-forget: start the A/B test job, then show the Started confirmation screen.
  useEffect(() => {
    if (flow.name !== 'starting') return;
    let cancelled = false;
    const { config } = flow;

    void (async () => {
      try {
        const opts: StartABTestJobOptions = {
          name: config.name,
          mode: config.mode,
          gateway: config.gateway,
          agent: config.runtime || undefined,
          runtime: config.runtime || undefined,
          controlBundle: config.mode === 'config-bundle' ? config.controlBundle : undefined,
          controlVersion: config.mode === 'config-bundle' ? config.controlVersion : undefined,
          treatmentBundle: config.mode === 'config-bundle' ? config.treatmentBundle : undefined,
          treatmentVersion: config.mode === 'config-bundle' ? config.treatmentVersion : undefined,
          controlTarget: config.mode === 'target-based' ? config.controlTarget : undefined,
          treatmentTarget: config.mode === 'target-based' ? config.treatmentTarget : undefined,
          onlineEval: config.mode === 'config-bundle' ? config.onlineEval : undefined,
          controlOnlineEval: config.mode === 'target-based' ? config.controlOnlineEval : undefined,
          treatmentOnlineEval: config.mode === 'target-based' ? config.treatmentOnlineEval : undefined,
          gatewayFilter: config.gatewayFilter.trim() || undefined,
          controlWeight: config.controlWeight,
          treatmentWeight: config.treatmentWeight,
          enableOnCreate: true,
        };
        const result = await engine.start('ab-test', opts);
        if (cancelled) return;
        if (!result.success) {
          setFlow({ name: 'error', message: result.error.message });
          return;
        }
        setFlow({ name: 'started', record: result.record, config });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [flow.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (flow.name === 'loading') {
    return (
      <Screen title="Run A/B Test" onExit={onExit}>
        <GradientText text="Loading deployed resources..." />
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'wizard') {
    return (
      <RunABTestWizard
        resources={flow.resources}
        region={flow.region}
        onComplete={config => setFlow({ name: 'starting', config })}
        onExit={onExit}
      />
    );
  }

  if (flow.name === 'starting') {
    return (
      <Screen title="Run A/B Test" onExit={onExit}>
        <GradientText text="Creating A/B test (resolving role; this can take ~15s)..." />
      </Screen>
    );
  }

  if (flow.name === 'started') {
    return (
      <StartedView
        record={flow.record}
        config={flow.config}
        onRunAnother={() => setFlow({ name: 'loading' })}
        onViewJobs={onViewJobs}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="A/B test failed"
      detail={flow.message}
      onBack={() => setFlow({ name: 'loading' })}
      onExit={onExit}
    />
  );
}

// ============================================================================
// Started confirmation view
// ============================================================================

interface StartedViewProps {
  record: ABTestJobRecord;
  config: RunABTestConfig;
  onRunAnother: () => void;
  onViewJobs?: () => void;
  onExit: () => void;
}

function StartedView({ record, config, onRunAnother, onViewJobs, onExit }: StartedViewProps) {
  const actions = [
    { id: 'jobs', title: 'View jobs' },
    { id: 'another', title: 'Run another' },
    { id: 'back', title: 'Back' },
  ];

  const nav = useListNavigation({
    items: actions,
    onSelect: item => {
      if (item.id === 'jobs') (onViewJobs ?? onExit)();
      else if (item.id === 'another') onRunAnother();
      else onExit();
    },
    onExit,
    isActive: true,
  });

  return (
    <Screen title="A/B Test Started" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text color="green">
            ✓ {record.id} ({record.status})
          </Text>
          <Text>
            <Text bold>Name:</Text> {config.name}
            {'  '}
            <Text bold>Mode:</Text> {config.mode}
            {'  '}
            <Text bold>Gateway:</Text> {config.gateway}
          </Text>

          <Box marginTop={1}>
            <Text dimColor>Track its progress and results in A/B Test Jobs.</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            {actions.map((action, idx) => {
              const selected = idx === nav.selectedIndex;
              return (
                <Text key={action.id}>
                  <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                  <Text color={selected ? 'cyan' : undefined} bold={selected}>
                    {action.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      </Panel>
    </Screen>
  );
}

// ============================================================================
// Wizard Component
// ============================================================================

interface RunABTestWizardProps {
  resources: ABTestResources;
  region: string;
  onComplete: (config: RunABTestConfig) => void;
  onExit: () => void;
}

function RunABTestWizard({ resources, region, onComplete, onExit }: RunABTestWizardProps) {
  const [config, setConfig] = useState<RunABTestConfig>({
    mode: 'config-bundle',
    name: '',
    gateway: resources.gateways[0] ?? '',
    controlBundle: '',
    controlVersion: 'LATEST',
    treatmentBundle: '',
    treatmentVersion: 'LATEST',
    controlTarget: '',
    treatmentTarget: '',
    runtime: resources.runtimes[0] ?? '',
    controlWeight: 50,
    treatmentWeight: 50,
    onlineEval: '',
    controlOnlineEval: '',
    treatmentOnlineEval: '',
    gatewayFilter: '',
  });

  const steps = config.mode === 'target-based' ? TARGET_BASED_STEPS : CONFIG_BUNDLE_STEPS;
  const [step, setStep] = useState<RunABTestStep>('mode');
  const currentIndex = steps.indexOf(step);

  // Live draft of the optional filter input, so the footer hint can flip submit/skip.
  const [filterDraft, setFilterDraft] = useState(config.gatewayFilter);

  const goBack = useCallback(() => {
    const prev = steps[currentIndex - 1];
    if (prev) setStep(prev);
    else onExit();
  }, [steps, currentIndex, onExit]);

  const goNext = useCallback(() => {
    const next = steps[currentIndex + 1];
    if (next) setStep(next);
  }, [steps, currentIndex]);

  // ── step item lists ──
  const modeItems: SelectableItem[] = useMemo(
    () => [
      { id: 'config-bundle', title: 'Config bundle', description: 'Compare two configuration bundle versions' },
      { id: 'target-based', title: 'Target based', description: 'Compare two gateway-target runtime endpoints' },
    ],
    []
  );
  const gatewayItems: SelectableItem[] = useMemo(
    () => resources.gateways.map(g => ({ id: g, title: g })),
    [resources.gateways]
  );
  const onlineEvalItems: SelectableItem[] = useMemo(
    () => resources.onlineEvalConfigs.map(c => ({ id: c, title: c })),
    [resources.onlineEvalConfigs]
  );

  const isStep = (s: RunABTestStep) => step === s;

  const modeNav = useListNavigation({
    items: modeItems,
    onSelect: item => {
      setConfig(c => ({ ...c, mode: item.id as ABTestMode }));
      setStep('gateway');
    },
    onExit,
    isActive: isStep('mode'),
  });

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => {
      setConfig(c => ({ ...c, gateway: item.id }));
      goNext();
    },
    onExit: goBack,
    isActive: isStep('gateway'),
  });

  const onlineEvalNav = useListNavigation({
    items: onlineEvalItems,
    onSelect: item => {
      setConfig(c => ({ ...c, onlineEval: item.id }));
      goNext();
    },
    onExit: goBack,
    isActive: isStep('onlineEval'),
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(config),
    onExit: goBack,
    isActive: isStep('confirm'),
  });

  const helpText = isStep('filter')
    ? filterDraft.trim()
      ? 'Enter submit · Esc back'
      : 'Enter to skip · Esc back'
    : isStep('control') || isStep('treatment') || isStep('name')
      ? HELP_TEXT.TEXT_INPUT
      : HELP_TEXT.NAVIGATE_SELECT;
  const headerContent = <StepIndicator steps={steps} currentStep={step} labels={STEP_LABELS} />;

  return (
    <Screen
      title="Run A/B Test"
      onExit={goBack}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={!isStep('control') && !isStep('treatment')}
    >
      <Panel>
        {isStep('mode') && (
          <WizardSelect title="Variant mode" items={modeItems} selectedIndex={modeNav.selectedIndex} />
        )}

        {isStep('gateway') && (
          <WizardSelect
            title="Select gateway"
            description="The test routes traffic through this deployed gateway"
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {isStep('control') && (
          <VariantForm
            variant="Control"
            mode={config.mode}
            bundleItems={resources.bundles.map(b => ({ id: b.name, title: b.name }))}
            targetItems={resources.targets.map(t => ({ id: t, title: t }))}
            evalItems={onlineEvalItems}
            initialBundle={config.controlBundle}
            initialVersion={config.controlVersion}
            initialTarget={config.controlTarget}
            initialEval={config.controlOnlineEval}
            initialWeight={config.controlWeight}
            onPartialUpdate={(bundle, version, target, evalCfg) => {
              setConfig(c => ({
                ...c,
                controlBundle: bundle,
                controlVersion: version,
                controlTarget: target,
                controlOnlineEval: evalCfg,
              }));
            }}
            onComplete={(bundle, version, target, evalCfg, weight) => {
              setConfig(c => ({
                ...c,
                controlBundle: bundle,
                controlVersion: version,
                controlTarget: target,
                controlOnlineEval: evalCfg,
                controlWeight: weight,
                treatmentWeight: 100 - weight,
              }));
              goNext();
            }}
            onCancel={goBack}
          />
        )}

        {isStep('treatment') && (
          <VariantForm
            variant="Treatment"
            mode={config.mode}
            bundleItems={resources.bundles.map(b => ({ id: b.name, title: b.name }))}
            targetItems={resources.targets.map(t => ({ id: t, title: t }))}
            evalItems={onlineEvalItems}
            initialBundle={config.treatmentBundle}
            initialVersion={config.treatmentVersion}
            initialTarget={config.treatmentTarget}
            initialEval={config.treatmentOnlineEval}
            initialWeight={config.treatmentWeight}
            onPartialUpdate={(bundle, version, target, evalCfg) => {
              setConfig(c => ({
                ...c,
                treatmentBundle: bundle,
                treatmentVersion: version,
                treatmentTarget: target,
                treatmentOnlineEval: evalCfg,
              }));
            }}
            onComplete={(bundle, version, target, evalCfg, weight) => {
              setConfig(c => ({
                ...c,
                treatmentBundle: bundle,
                treatmentVersion: version,
                treatmentTarget: target,
                treatmentOnlineEval: evalCfg,
                treatmentWeight: weight,
                controlWeight: 100 - weight,
              }));
              goNext();
            }}
            onCancel={goBack}
          />
        )}

        {isStep('onlineEval') && (
          <WizardSelect
            title="Shared online eval config"
            description="Evaluator applied to both variants (config-bundle mode)"
            items={onlineEvalItems}
            selectedIndex={onlineEvalNav.selectedIndex}
          />
        )}

        {isStep('filter') && (
          <Box flexDirection="column">
            <Text bold>Gateway filter (optional)</Text>
            <Text dimColor>Restrict the test to one gateway target path pattern (e.g. &quot;/orders/*&quot;).</Text>
            <Text dimColor>Leave blank to have no gateway filter.</Text>
            <Box marginTop={1}>
              <TextInput
                key="filter"
                prompt="Gateway filter"
                initialValue={config.gatewayFilter}
                allowEmpty
                onChange={value => setFilterDraft(value)}
                onSubmit={value => {
                  setConfig(c => ({ ...c, gatewayFilter: value.trim() }));
                  goNext();
                }}
                onCancel={goBack}
              />
            </Box>
          </Box>
        )}

        {isStep('name') && (
          <Box flexDirection="column">
            <Text dimColor>A short name for this A/B test.</Text>
            <TextInput
              key="name"
              prompt="A/B test name"
              initialValue={config.name}
              onSubmit={value => {
                if (value.trim()) {
                  setConfig(c => ({ ...c, name: value.trim() }));
                  goNext();
                }
              }}
              onCancel={goBack}
            />
          </Box>
        )}

        {isStep('confirm') && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: config.name },
              { label: 'Mode', value: config.mode },
              { label: 'Gateway', value: config.gateway },
              ...(config.mode === 'config-bundle'
                ? [
                    {
                      label: 'Control',
                      value: `${config.controlBundle} @ ${config.controlVersion} (weight ${config.controlWeight})`,
                    },
                    {
                      label: 'Treatment',
                      value: `${config.treatmentBundle} @ ${config.treatmentVersion} (weight ${config.treatmentWeight})`,
                    },
                    { label: 'Online eval', value: config.onlineEval },
                  ]
                : [
                    {
                      label: 'Control',
                      value: `${config.controlTarget} — eval: ${config.controlOnlineEval} (weight ${config.controlWeight})`,
                    },
                    {
                      label: 'Treatment',
                      value: `${config.treatmentTarget} — eval: ${config.treatmentOnlineEval} (weight ${config.treatmentWeight})`,
                    },
                  ]),
              { label: 'Gateway filter', value: config.gatewayFilter.trim() || 'none' },
              { label: 'Region', value: region },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

// ============================================================================
// Variant Form — one screen per variant with all its fields
// ============================================================================

type VariantSubField = 'picker' | 'version' | 'eval' | 'weight';

interface VariantFormProps {
  variant: 'Control' | 'Treatment';
  mode: ABTestMode;
  bundleItems: SelectableItem[];
  targetItems: SelectableItem[];
  evalItems: SelectableItem[];
  initialBundle: string;
  initialVersion: string;
  initialTarget: string;
  initialEval: string;
  initialWeight: number;
  onPartialUpdate?: (bundle: string, version: string, target: string, evalCfg: string) => void;
  onComplete: (bundle: string, version: string, target: string, evalCfg: string, weight: number) => void;
  onCancel: () => void;
}

function VariantForm({
  variant,
  mode,
  bundleItems,
  targetItems,
  evalItems,
  initialBundle,
  initialVersion,
  initialTarget,
  initialEval,
  initialWeight,
  onPartialUpdate,
  onComplete,
  onCancel,
}: VariantFormProps) {
  const isConfigBundle = mode === 'config-bundle';
  const fields: VariantSubField[] = useMemo(
    () => (isConfigBundle ? ['picker', 'version', 'weight'] : ['picker', 'eval', 'weight']),
    [isConfigBundle]
  );

  const [activeField, setActiveField] = useState<VariantSubField>('picker');
  const [selectedPicker, setSelectedPicker] = useState(isConfigBundle ? initialBundle : initialTarget);
  const [version, setVersion] = useState(initialVersion);
  const [evalCfg, setEvalCfg] = useState(initialEval);
  const [weight, setWeight] = useState(String(initialWeight));

  const advanceField = useCallback(() => {
    const idx = fields.indexOf(activeField);
    const next = fields[idx + 1];
    if (next) {
      // Save partial state to parent so going back preserves selections
      onPartialUpdate?.(isConfigBundle ? selectedPicker : '', version, isConfigBundle ? '' : selectedPicker, evalCfg);
      setActiveField(next);
    } else {
      const w = parseInt(weight, 10);
      onComplete(
        isConfigBundle ? selectedPicker : '',
        version,
        isConfigBundle ? '' : selectedPicker,
        evalCfg,
        isNaN(w) ? initialWeight : w
      );
    }
  }, [
    activeField,
    fields,
    weight,
    selectedPicker,
    version,
    evalCfg,
    isConfigBundle,
    initialWeight,
    onComplete,
    onPartialUpdate,
  ]);

  const goBackField = useCallback(() => {
    const idx = fields.indexOf(activeField);
    if (idx > 0) setActiveField(fields[idx - 1]!);
    else onCancel();
  }, [activeField, fields, onCancel]);

  const pickerItems = isConfigBundle ? bundleItems : targetItems;

  const pickerNav = useListNavigation({
    items: pickerItems,
    onSelect: item => {
      setSelectedPicker(item.id);
      advanceField();
    },
    onExit: goBackField,
    isActive: activeField === 'picker',
  });

  const evalNav = useListNavigation({
    items: evalItems,
    onSelect: item => {
      setEvalCfg(item.id);
      advanceField();
    },
    onExit: goBackField,
    isActive: activeField === 'eval',
  });

  return (
    <Box flexDirection="column">
      <Text bold>{variant} Variant</Text>
      <Text dimColor>{'─'.repeat(30)}</Text>

      {/* Summary of completed fields (shown above the active input) */}
      {selectedPicker && activeField !== 'picker' && (
        <Text>
          <Text bold>{isConfigBundle ? 'Bundle:' : 'Target:'}</Text> {selectedPicker} <Text color="green">✓</Text>
        </Text>
      )}
      {version && activeField === 'weight' && isConfigBundle && (
        <Text>
          <Text bold>Version:</Text> {version} <Text color="green">✓</Text>
        </Text>
      )}
      {evalCfg && activeField === 'weight' && !isConfigBundle && (
        <Text>
          <Text bold>Online Eval:</Text> {evalCfg} <Text color="green">✓</Text>
        </Text>
      )}

      {/* Active field */}
      <Box marginTop={1} flexDirection="column">
        {activeField === 'picker' && (
          <WizardSelect
            title={isConfigBundle ? 'Select config bundle:' : 'Select gateway target:'}
            items={pickerItems}
            selectedIndex={pickerNav.selectedIndex}
          />
        )}

        {activeField === 'version' && (
          <Box flexDirection="column">
            <Text dimColor>Bundle version (or LATEST):</Text>
            <TextInput
              key={`${variant}-version`}
              prompt="Version"
              initialValue={version}
              onSubmit={value => {
                setVersion(value || 'LATEST');
                advanceField();
              }}
              onCancel={goBackField}
            />
          </Box>
        )}

        {activeField === 'eval' && (
          <WizardSelect
            title="Select online eval (scoped to this endpoint):"
            items={evalItems}
            selectedIndex={evalNav.selectedIndex}
          />
        )}

        {activeField === 'weight' && (
          <Box flexDirection="column">
            <Text dimColor>Traffic weight (0-100):</Text>
            <TextInput
              key={`${variant}-weight`}
              prompt="Weight"
              initialValue={weight}
              onSubmit={value => {
                const w = parseInt(value, 10);
                if (!isNaN(w) && w >= 0 && w <= 100) {
                  setWeight(value);
                  advanceField();
                }
              }}
              onCancel={goBackField}
              customValidation={value => {
                const w = parseInt(value, 10);
                if (isNaN(w)) return 'Must be a number';
                if (w < 0 || w > 100) return 'Must be between 0 and 100';
                return true;
              }}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
