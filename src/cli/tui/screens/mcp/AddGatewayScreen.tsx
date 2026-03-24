import type { GatewayAuthorizerType, PolicyEngineMode } from '../../../../schema';
import { GatewayNameSchema } from '../../../../schema';
import { computeManagedOAuthCredentialName } from '../../../primitives/credential-utils';
import {
  ConfirmReview,
  Cursor,
  Panel,
  Screen,
  SecretInput,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddGatewayConfig } from './types';
import {
  AUTHORIZER_TYPE_OPTIONS,
  EXCEPTION_LEVEL_ITEM_ID,
  GATEWAY_STEP_LABELS,
  NONE_SELECTION,
  POLICY_ENGINE_MODE_OPTIONS,
  SEMANTIC_SEARCH_ITEM_ID,
} from './types';
import { useAddGatewayWizard } from './useAddGatewayWizard';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

interface AddGatewayScreenProps {
  onComplete: (config: AddGatewayConfig) => void;
  onExit: () => void;
  existingGateways: string[];
  unassignedTargets: string[];
  existingPolicyEngines: string[];
}

const INITIAL_ADVANCED_SELECTED = [SEMANTIC_SEARCH_ITEM_ID];

export function AddGatewayScreen({
  onComplete,
  onExit,
  existingGateways,
  unassignedTargets,
  existingPolicyEngines,
}: AddGatewayScreenProps) {
  const wizard = useAddGatewayWizard(unassignedTargets.length, existingPolicyEngines.length);

  // JWT config state
  const [jwtSubStep, setJwtSubStep] = useState<JwtSubStep>('discoveryUrl');
  const [jwtDiscoveryUrl, setJwtDiscoveryUrl] = useState('');
  const [jwtSelectedConstraints, setJwtSelectedConstraints] = useState<Set<ConstraintType>>(new Set());
  const [jwtAudience, setJwtAudience] = useState('');
  const [jwtClients, setJwtClients] = useState('');
  const [jwtScopes, setJwtScopes] = useState('');
  const [jwtCustomClaims, setJwtCustomClaims] = useState<CustomClaimEntry[]>([]);
  const [jwtClientId, setJwtClientId] = useState('');
  const [claimsManagerMode, setClaimsManagerMode] = useState<ClaimsManagerMode>('add');

  const unassignedTargetItems: SelectableItem[] = useMemo(
    () => unassignedTargets.map(name => ({ id: name, title: name })),
    [unassignedTargets]
  );

  const authorizerItems: SelectableItem[] = useMemo(
    () => AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const advancedConfigItems: SelectableItem[] = useMemo(
    () => [
      { id: SEMANTIC_SEARCH_ITEM_ID, title: 'Semantic Search' },
      { id: EXCEPTION_LEVEL_ITEM_ID, title: 'Debug Exception Level' },
    ],
    []
  );

  // Policy engine sub-step: 0 = select engine, 1 = select mode
  // Reset when re-entering the step (e.g., after navigating back)
  const [policyEngineSubStep, setPolicyEngineSubStep] = useState(0);
  const [selectedEngineName, setSelectedEngineName] = useState('');
  React.useEffect(() => {
    if (wizard.step === 'policy-engine') {
      setPolicyEngineSubStep(0);
      setSelectedEngineName('');
    }
  }, [wizard.step]);

  const policyEngineItems: SelectableItem[] = useMemo(
    () => [
      { id: NONE_SELECTION, title: 'None', description: 'No policy engine' },
      ...existingPolicyEngines.map(name => ({ id: name, title: name })),
    ],
    [existingPolicyEngines]
  );

  const policyEngineModeItems: SelectableItem[] = useMemo(
    () => POLICY_ENGINE_MODE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isAuthorizerStep = wizard.step === 'authorizer';
  const isJwtConfigStep = wizard.step === 'jwt-config';
  const isIncludeTargetsStep = wizard.step === 'include-targets';
  const isPolicyEngineStep = wizard.step === 'policy-engine';
  const isAdvancedConfigStep = wizard.step === 'advanced-config';
  const isConfirmStep = wizard.step === 'confirm';

  const authorizerNav = useListNavigation({
    items: authorizerItems,
    onSelect: item => wizard.setAuthorizerType(item.id as GatewayAuthorizerType),
    onExit: () => wizard.goBack(),
    isActive: isAuthorizerStep,
  });

  const targetsNav = useMultiSelectNavigation({
    items: unassignedTargetItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setSelectedTargets(ids),
    onExit: () => wizard.goBack(),
    isActive: isIncludeTargetsStep,
    requireSelection: false,
  });

  const policyEngineNav = useListNavigation({
    items: policyEngineItems,
    onSelect: item => {
      if (item.id === NONE_SELECTION) {
        wizard.skipPolicyEngine();
      } else {
        setSelectedEngineName(item.id);
        setPolicyEngineSubStep(1);
      }
    },
    onExit: () => {
      if (policyEngineSubStep === 0) {
        wizard.goBack();
      } else {
        setPolicyEngineSubStep(0);
      }
    },
    isActive: isPolicyEngineStep && policyEngineSubStep === 0,
  });

  const policyEngineModeNav = useListNavigation({
    items: policyEngineModeItems,
    onSelect: item => {
      wizard.setPolicyEngineConfig(selectedEngineName, item.id as PolicyEngineMode);
      setPolicyEngineSubStep(0);
    },
    onExit: () => setPolicyEngineSubStep(0),
    isActive: isPolicyEngineStep && policyEngineSubStep === 1,
  });

  const advancedNav = useMultiSelectNavigation({
    items: advancedConfigItems,
    getId: item => item.id,
    initialSelectedIds: INITIAL_ADVANCED_SELECTED,
    onConfirm: selectedIds =>
      wizard.setAdvancedConfig({
        enableSemanticSearch: selectedIds.includes(SEMANTIC_SEARCH_ITEM_ID),
        exceptionLevel: selectedIds.includes(EXCEPTION_LEVEL_ITEM_ID) ? 'DEBUG' : 'NONE',
      }),
    onExit: () => wizard.goBack(),
    isActive: isAdvancedConfigStep,
    requireSelection: false,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  // Compute the ordered list of JWT sub-steps based on selected constraints
  const jwtSteps = useMemo<JwtSubStep[]>(() => {
    const steps: JwtSubStep[] = ['discoveryUrl', 'constraintPicker'];
    if (jwtSelectedConstraints.has('audience')) steps.push('audience');
    if (jwtSelectedConstraints.has('clients')) steps.push('clients');
    if (jwtSelectedConstraints.has('scopes')) steps.push('scopes');
    if (jwtSelectedConstraints.has('customClaims')) steps.push('customClaims');
    steps.push('clientId', 'clientSecret');
    return steps;
  }, [jwtSelectedConstraints]);

  const jwtStepIndex = jwtSteps.indexOf(jwtSubStep);

  // Navigate to the next JWT sub-step after current
  const jwtGoNext = useCallback(() => {
    const nextStep = jwtSteps[jwtStepIndex + 1];
    if (nextStep) setJwtSubStep(nextStep);
  }, [jwtSteps, jwtStepIndex]);

  // Navigate to the previous JWT sub-step
  const jwtGoBack = useCallback(() => {
    if (jwtStepIndex <= 0) {
      wizard.goBack();
    } else {
      const prevStep = jwtSteps[jwtStepIndex - 1];
      if (prevStep) setJwtSubStep(prevStep);
    }
  }, [jwtSteps, jwtStepIndex, wizard]);

  // JWT config handlers
  const handleJwtDiscoveryUrl = (url: string) => {
    setJwtDiscoveryUrl(url);
    setJwtSubStep('constraintPicker');
  };

  const handleJwtConstraintsPicked = useCallback((selectedIds: string[]) => {
    const constraints = new Set(selectedIds as ConstraintType[]);
    setJwtSelectedConstraints(constraints);
    // Find first selected constraint in order
    const order: ConstraintType[] = ['audience', 'clients', 'scopes', 'customClaims'];
    const first = order.find(c => constraints.has(c));
    if (first) {
      setJwtSubStep(first);
    } else {
      setJwtSubStep('clientId');
    }
  }, []);

  const handleJwtAudience = (audience: string) => {
    setJwtAudience(audience);
    jwtGoNext();
  };

  const handleJwtClients = (clients: string) => {
    setJwtClients(clients);
    jwtGoNext();
  };

  const handleJwtScopes = (scopes: string) => {
    setJwtScopes(scopes);
    jwtGoNext();
  };

  const handleJwtCustomClaimsDone = useCallback(
    (claims: CustomClaimEntry[]) => {
      setJwtCustomClaims(claims);
      jwtGoNext();
    },
    [jwtGoNext]
  );

  const handleJwtClientId = (clientId: string) => {
    setJwtClientId(clientId);
    jwtGoNext();
  };

  const handleJwtClientIdSkip = () => {
    setJwtClientId('');
    finishJwtConfig('');
  };

  const finishJwtConfig = (clientSecret: string) => {
    const parseList = (s: string) =>
      s
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
    const audienceList = jwtSelectedConstraints.has('audience') ? parseList(jwtAudience) : undefined;
    const clientsList = jwtSelectedConstraints.has('clients') ? parseList(jwtClients) : undefined;
    const scopesList = jwtSelectedConstraints.has('scopes') ? parseList(jwtScopes) : undefined;

    wizard.setJwtConfig({
      discoveryUrl: jwtDiscoveryUrl,
      ...(audienceList && audienceList.length > 0 ? { allowedAudience: audienceList } : {}),
      ...(clientsList && clientsList.length > 0 ? { allowedClients: clientsList } : {}),
      ...(scopesList && scopesList.length > 0 ? { allowedScopes: scopesList } : {}),
      ...(jwtSelectedConstraints.has('customClaims') && jwtCustomClaims.length > 0
        ? {
            customClaims: jwtCustomClaims.map(c => ({
              inboundTokenClaimName: c.claimName,
              inboundTokenClaimValueType: c.valueType,
              authorizingClaimMatchValue: {
                claimMatchOperator: c.operator,
                claimMatchValue:
                  c.valueType === 'STRING'
                    ? { matchValueString: c.matchValue }
                    : {
                        matchValueStringList: c.matchValue
                          .split(',')
                          .map(v => v.trim())
                          .filter(Boolean),
                      },
              },
            })),
          }
        : {}),
      ...(jwtClientId.trim() ? { clientId: jwtClientId, clientSecret } : {}),
    });

    setJwtSubStep('discoveryUrl');
  };

  const handleJwtClientSecret = (clientSecret: string) => {
    finishJwtConfig(clientSecret);
  };

  const helpText = isJwtConfigStep
    ? jwtSubStep === 'constraintPicker'
      ? HELP_TEXT.MULTI_SELECT
      : jwtSubStep === 'customClaims'
        ? claimsManagerMode === 'add' || claimsManagerMode === 'edit'
          ? '↑/↓ field · ←/→ cycle · Enter next/save · Esc cancel'
          : 'Navigate · Enter select · Esc back'
        : HELP_TEXT.TEXT_INPUT
    : isIncludeTargetsStep || isAdvancedConfigStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : isAuthorizerStep || isPolicyEngineStep
          ? HELP_TEXT.NAVIGATE_SELECT
          : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={GATEWAY_STEP_LABELS} />;

  return (
    <Screen title="Add Gateway" onExit={onExit} helpText={helpText} headerContent={headerContent} exitEnabled={false}>
      <Panel>
        {isNameStep && (
          <TextInput
            key={wizard.step}
            prompt={GATEWAY_STEP_LABELS[wizard.step]}
            initialValue={generateUniqueName('my-gateway', existingGateways, { separator: '-' })}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={GatewayNameSchema}
            customValidation={value => !existingGateways.includes(value) || 'Gateway name already exists'}
          />
        )}

        {isAuthorizerStep && (
          <Box flexDirection="column">
            <WizardSelect
              title="Select authorizer type"
              description="How will clients authenticate to this gateway?"
              items={authorizerItems}
              selectedIndex={authorizerNav.selectedIndex}
            />
            {authorizerItems[authorizerNav.selectedIndex]?.id === 'NONE' && (
              <Box marginTop={1}>
                <Text color="yellow">⚠️ Warning: Gateway will be publicly accessible without authorization</Text>
              </Box>
            )}
          </Box>
        )}

        {isJwtConfigStep && (
          <JwtConfigInput
            subStep={jwtSubStep}
            steps={jwtSteps}
            selectedConstraints={jwtSelectedConstraints}
            customClaims={jwtCustomClaims}
            discoveryUrl={jwtDiscoveryUrl}
            audience={jwtAudience}
            clients={jwtClients}
            scopes={jwtScopes}
            onDiscoveryUrl={handleJwtDiscoveryUrl}
            onConstraintsPicked={handleJwtConstraintsPicked}
            onAudience={handleJwtAudience}
            onClients={handleJwtClients}
            onScopes={handleJwtScopes}
            onCustomClaimsDone={handleJwtCustomClaimsDone}
            onClientId={handleJwtClientId}
            onClientIdSkip={handleJwtClientIdSkip}
            onClientSecret={handleJwtClientSecret}
            onBack={jwtGoBack}
            onClaimsManagerModeChange={setClaimsManagerMode}
          />
        )}

        {isIncludeTargetsStep &&
          (unassignedTargetItems.length > 0 ? (
            <WizardMultiSelect
              title="Select unassigned targets to include in this gateway"
              items={unassignedTargetItems}
              cursorIndex={targetsNav.cursorIndex}
              selectedIds={targetsNav.selectedIds}
            />
          ) : (
            <Text dimColor>No unassigned targets available. Press Enter to continue.</Text>
          ))}

        {isPolicyEngineStep && policyEngineSubStep === 0 && (
          <WizardSelect
            title="Select a policy engine"
            description="Attach a Cedar policy engine to authorize tool calls on this gateway"
            items={policyEngineItems}
            selectedIndex={policyEngineNav.selectedIndex}
          />
        )}

        {isPolicyEngineStep && policyEngineSubStep === 1 && (
          <WizardSelect
            title="Select enforcement mode"
            description={`Policy engine: ${selectedEngineName}`}
            items={policyEngineModeItems}
            selectedIndex={policyEngineModeNav.selectedIndex}
          />
        )}

        {isAdvancedConfigStep && (
          <Box flexDirection="column">
            <Text bold>Advanced Configuration</Text>
            <Text dimColor>Toggle options with Space, press Enter to continue</Text>
            <Box marginTop={1} flexDirection="column">
              {advancedConfigItems.map((item, idx) => {
                const isCursor = idx === advancedNav.cursorIndex;
                const isChecked = advancedNav.selectedIds.has(item.id);
                const checkbox = isChecked ? '[✓]' : '[ ]';
                return (
                  <Box key={item.id}>
                    <Text wrap="truncate">
                      <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '❯' : ' '} </Text>
                      <Text color={isChecked ? 'green' : undefined}>{checkbox} </Text>
                      <Text color={isCursor ? 'cyan' : undefined}>{item.title}</Text>
                    </Text>
                    <Text dimColor> {isChecked ? 'Enabled' : 'Disabled'}</Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              { label: 'Description', value: wizard.config.description },
              {
                label: 'Authorizer',
                value:
                  AUTHORIZER_TYPE_OPTIONS.find(o => o.id === wizard.config.authorizerType)?.title ??
                  wizard.config.authorizerType,
              },
              ...(wizard.config.authorizerType === 'CUSTOM_JWT' && wizard.config.jwtConfig
                ? [
                    { label: 'Discovery URL', value: wizard.config.jwtConfig.discoveryUrl },
                    ...(wizard.config.jwtConfig.allowedAudience?.length
                      ? [{ label: 'Allowed Audience', value: wizard.config.jwtConfig.allowedAudience.join(', ') }]
                      : []),
                    ...(wizard.config.jwtConfig.allowedClients?.length
                      ? [{ label: 'Allowed Clients', value: wizard.config.jwtConfig.allowedClients.join(', ') }]
                      : []),
                    ...(wizard.config.jwtConfig.allowedScopes?.length
                      ? [{ label: 'Allowed Scopes', value: wizard.config.jwtConfig.allowedScopes.join(', ') }]
                      : []),
                    ...(wizard.config.jwtConfig.customClaims?.length
                      ? [
                          {
                            label: 'Custom Claims',
                            value: `${wizard.config.jwtConfig.customClaims.length} claim(s) configured`,
                          },
                        ]
                      : []),
                    ...(wizard.config.jwtConfig.clientId
                      ? [{ label: 'Gateway Credential', value: computeManagedOAuthCredentialName(wizard.config.name) }]
                      : []),
                  ]
                : []),
              {
                label: 'Targets',
                value:
                  wizard.config.selectedTargets && wizard.config.selectedTargets.length > 0
                    ? wizard.config.selectedTargets.join(', ')
                    : '(none)',
              },
              { label: 'Semantic Search', value: wizard.config.enableSemanticSearch ? 'Enabled' : 'Disabled' },
              { label: 'Exception Level', value: wizard.config.exceptionLevel === 'DEBUG' ? 'Debug' : 'None' },
              ...(wizard.config.policyEngineConfiguration
                ? [
                    { label: 'Policy Engine', value: wizard.config.policyEngineConfiguration.policyEngineName },
                    { label: 'Enforcement Mode', value: wizard.config.policyEngineConfiguration.mode },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT Configuration Types & Constants
// ─────────────────────────────────────────────────────────────────────────────

type ConstraintType = 'audience' | 'clients' | 'scopes' | 'customClaims';

type JwtSubStep =
  | 'discoveryUrl'
  | 'constraintPicker'
  | 'audience'
  | 'clients'
  | 'scopes'
  | 'customClaims'
  | 'clientId'
  | 'clientSecret';

type ClaimValueType = 'STRING' | 'STRING_ARRAY';
type ClaimOperator = 'EQUALS' | 'CONTAINS' | 'CONTAINS_ANY';

interface CustomClaimEntry {
  claimName: string;
  valueType: ClaimValueType;
  operator: ClaimOperator;
  matchValue: string;
}

const CONSTRAINT_ITEMS: SelectableItem[] = [
  { id: 'audience', title: 'Allowed Audiences', description: 'Validate token audience claims' },
  { id: 'clients', title: 'Allowed Clients', description: 'Validate client identifiers in the token' },
  { id: 'scopes', title: 'Allowed Scopes', description: 'Validate token contains required scopes' },
  { id: 'customClaims', title: 'Custom Claims', description: 'Match specific token claims against rules' },
];

/** OIDC well-known suffix for validation */
const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';

/** Validates that a comma-separated string has at least one non-empty value */
function validateCommaSeparated(value: string): true | string {
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return items.length > 0 || 'At least one value is required';
}

// ─────────────────────────────────────────────────────────────────────────────
// JwtConfigInput — main JWT configuration component
// ─────────────────────────────────────────────────────────────────────────────

interface JwtConfigInputProps {
  subStep: JwtSubStep;
  steps: JwtSubStep[];
  selectedConstraints: Set<ConstraintType>;
  customClaims: CustomClaimEntry[];
  discoveryUrl: string;
  audience: string;
  clients: string;
  scopes: string;
  onDiscoveryUrl: (url: string) => void;
  onConstraintsPicked: (selectedIds: string[]) => void;
  onAudience: (audience: string) => void;
  onClients: (clients: string) => void;
  onScopes: (scopes: string) => void;
  onCustomClaimsDone: (claims: CustomClaimEntry[]) => void;
  onClientId: (clientId: string) => void;
  onClientIdSkip: () => void;
  onClientSecret: (clientSecret: string) => void;
  onBack: () => void;
  onClaimsManagerModeChange?: (mode: ClaimsManagerMode) => void;
}

function JwtConfigInput({
  subStep,
  steps,
  selectedConstraints,
  customClaims,
  discoveryUrl,
  audience,
  clients,
  scopes,
  onDiscoveryUrl,
  onConstraintsPicked,
  onAudience,
  onClients,
  onScopes,
  onCustomClaimsDone,
  onClientId,
  onClientIdSkip,
  onClientSecret,
  onBack,
  onClaimsManagerModeChange,
}: JwtConfigInputProps) {
  // Count only the user-facing steps (exclude clientId/clientSecret which are optional)
  const coreSteps = steps.filter(s => s !== ('clientId' as JwtSubStep) && s !== ('clientSecret' as JwtSubStep));
  const coreIndex = coreSteps.indexOf(subStep);
  const displayStep = coreIndex >= 0 ? coreIndex + 1 : coreSteps.length;
  const totalDisplay = coreSteps.length;

  const constraintNav = useMultiSelectNavigation({
    items: CONSTRAINT_ITEMS,
    getId: item => item.id,
    initialSelectedIds: Array.from(selectedConstraints),
    onConfirm: onConstraintsPicked,
    onExit: () => onBack(),
    isActive: subStep === 'constraintPicker',
    requireSelection: true,
  });

  return (
    <Box flexDirection="column">
      <Text bold>Configure Custom JWT Authorizer</Text>
      {subStep !== 'clientId' && subStep !== 'clientSecret' && (
        <Text dimColor>
          Step {displayStep} of {totalDisplay}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {subStep === 'discoveryUrl' && (
          <TextInput
            prompt="Discovery URL"
            placeholder="https://example.com/.well-known/openid-configuration"
            initialValue={discoveryUrl}
            onSubmit={onDiscoveryUrl}
            onCancel={onBack}
            customValidation={value => {
              try {
                const url = new URL(value);
                if (url.protocol !== 'https:') {
                  return 'Discovery URL must use HTTPS';
                }
              } catch {
                return 'Must be a valid URL';
              }
              if (!value.endsWith(OIDC_WELL_KNOWN_SUFFIX)) {
                return `URL must end with '${OIDC_WELL_KNOWN_SUFFIX}'`;
              }
              return true;
            }}
          />
        )}
        {subStep === 'constraintPicker' && (
          <Box flexDirection="column">
            <WizardMultiSelect
              title="Select JWT constraints to configure (at least one required)"
              description="Space to toggle, Enter to confirm"
              items={CONSTRAINT_ITEMS}
              cursorIndex={constraintNav.cursorIndex}
              selectedIds={constraintNav.selectedIds}
            />
          </Box>
        )}
        {subStep === 'audience' && (
          <TextInput
            prompt="Allowed Audiences (comma-separated)"
            placeholder="e.g., aud-123, aud-456"
            initialValue={audience}
            onSubmit={onAudience}
            onCancel={onBack}
            customValidation={validateCommaSeparated}
          />
        )}
        {subStep === 'clients' && (
          <TextInput
            prompt="Allowed Clients (comma-separated)"
            placeholder="e.g., client-123, client-456"
            initialValue={clients}
            onSubmit={onClients}
            onCancel={onBack}
            customValidation={validateCommaSeparated}
          />
        )}
        {subStep === 'scopes' && (
          <TextInput
            prompt="Allowed Scopes (comma-separated)"
            placeholder="e.g., openid, profile, email"
            initialValue={scopes}
            onSubmit={onScopes}
            onCancel={onBack}
            customValidation={validateCommaSeparated}
          />
        )}
        {subStep === 'customClaims' && (
          <CustomClaimsManager
            initialClaims={customClaims}
            onDone={onCustomClaimsDone}
            onCancel={onBack}
            onModeChange={onClaimsManagerModeChange}
          />
        )}
        {subStep === 'clientId' && (
          <Box flexDirection="column">
            <Text dimColor>Optional: Provide OAuth credentials for gateway bearer token fetching</Text>
            <Box marginTop={1}>
              <TextInput
                prompt="OAuth Client ID (press Enter to skip)"
                onSubmit={value => {
                  if (value.trim()) onClientId(value);
                  else onClientIdSkip();
                }}
                onCancel={onBack}
                allowEmpty
              />
            </Box>
          </Box>
        )}
        {subStep === 'clientSecret' && (
          <SecretInput
            prompt="OAuth Client Secret"
            onSubmit={onClientSecret}
            onCancel={onBack}
            customValidation={value => value.trim().length > 0 || 'Client secret is required'}
            revealChars={4}
          />
        )}
      </Box>
    </Box>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomClaimsManager — add/edit/done loop for custom claims
// ─────────────────────────────────────────────────────────────────────────────

interface CustomClaimsManagerProps {
  initialClaims: CustomClaimEntry[];
  onDone: (claims: CustomClaimEntry[]) => void;
  onCancel: () => void;
  onModeChange?: (mode: ClaimsManagerMode) => void;
}

type ClaimsManagerMode = 'list' | 'add' | 'edit-pick' | 'edit' | 'delete-pick';

function CustomClaimsManager({ initialClaims, onDone, onCancel, onModeChange }: CustomClaimsManagerProps) {
  const [claims, setClaims] = useState<CustomClaimEntry[]>(initialClaims);
  const [mode, setMode] = useState<ClaimsManagerMode>(initialClaims.length > 0 ? 'list' : 'add');
  const [editIndex, setEditIndex] = useState(-1);

  React.useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  // Action items for the list view
  const actionItems = useMemo<SelectableItem[]>(() => {
    const items: SelectableItem[] = [{ id: 'add', title: 'Add claim' }];
    if (claims.length > 0) {
      items.push({ id: 'edit', title: 'Edit existing claim' });
      items.push({ id: 'delete', title: 'Delete claim' });
      items.push({ id: 'done', title: 'Done' });
    }
    return items;
  }, [claims.length]);

  const actionNav = useListNavigation({
    items: actionItems,
    onSelect: item => {
      if (item.id === 'add') setMode('add');
      else if (item.id === 'edit') setMode('edit-pick');
      else if (item.id === 'delete') setMode('delete-pick');
      else if (item.id === 'done') onDone(claims);
    },
    onExit: onCancel,
    isActive: mode === 'list',
  });

  // Claim picker for edit mode
  const claimPickerItems = useMemo<SelectableItem[]>(
    () => claims.map((c, i) => ({ id: String(i), title: formatClaimSummary(c) })),
    [claims]
  );

  const claimPickerNav = useListNavigation({
    items: claimPickerItems,
    onSelect: (_, index) => {
      setEditIndex(index);
      setMode('edit');
    },
    onExit: () => setMode('list'),
    isActive: mode === 'edit-pick',
  });

  const deletePickerNav = useListNavigation({
    items: claimPickerItems,
    onSelect: (_, index) => {
      setClaims(prev => {
        const next = prev.filter((_, i) => i !== index);
        setMode(next.length === 0 ? 'add' : 'list');
        return next;
      });
    },
    onExit: () => setMode('list'),
    isActive: mode === 'delete-pick',
  });

  const handleClaimSave = useCallback(
    (claim: CustomClaimEntry) => {
      if (mode === 'edit' && editIndex >= 0) {
        setClaims(prev => prev.map((c, i) => (i === editIndex ? claim : c)));
      } else {
        setClaims(prev => [...prev, claim]);
      }
      setMode('list');
      setEditIndex(-1);
    },
    [mode, editIndex]
  );

  const handleClaimCancel = useCallback(() => {
    if (claims.length > 0) {
      setMode('list');
    } else {
      onCancel();
    }
  }, [claims.length, onCancel]);

  return (
    <Box flexDirection="column">
      <Text bold>Custom Claims</Text>

      {mode === 'list' && (
        <Box flexDirection="column">
          {claims.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              {claims.map((claim, i) => (
                <Text key={i} dimColor>
                  {i + 1}. {formatClaimSummary(claim)}
                </Text>
              ))}
            </Box>
          )}
          <Box marginTop={1} flexDirection="column">
            {actionItems.map((item, idx) => {
              const isCursor = idx === actionNav.selectedIndex;
              return (
                <Text key={item.id}>
                  <Text color={isCursor ? 'cyan' : undefined}>
                    {isCursor ? '❯' : ' '} {item.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {mode === 'edit-pick' && (
        <Box flexDirection="column">
          <Text dimColor>Select a claim to edit:</Text>
          <Box marginTop={1} flexDirection="column">
            {claimPickerItems.map((item, idx) => {
              const isCursor = idx === claimPickerNav.selectedIndex;
              return (
                <Text key={item.id}>
                  <Text color={isCursor ? 'cyan' : undefined}>
                    {isCursor ? '❯' : ' '} {item.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {mode === 'delete-pick' && (
        <Box flexDirection="column">
          <Text dimColor>Select a claim to delete:</Text>
          <Box marginTop={1} flexDirection="column">
            {claimPickerItems.map((item, idx) => {
              const isCursor = idx === deletePickerNav.selectedIndex;
              return (
                <Text key={item.id}>
                  <Text color={isCursor ? 'red' : undefined}>
                    {isCursor ? '❯' : ' '} {item.title}
                  </Text>
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {(mode === 'add' || mode === 'edit') && (
        <CustomClaimForm
          initialClaim={mode === 'edit' && editIndex >= 0 ? claims[editIndex] : undefined}
          onSave={handleClaimSave}
          onCancel={handleClaimCancel}
        />
      )}
    </Box>
  );
}

function formatClaimSummary(claim: CustomClaimEntry): string {
  const opLabel = claim.operator === 'EQUALS' ? '=' : claim.operator === 'CONTAINS' ? 'contains' : 'contains any of';
  const valueDisplay = claim.valueType === 'STRING_ARRAY' ? `[${claim.matchValue}]` : `"${claim.matchValue}"`;
  return `${claim.claimName} ${opLabel} ${valueDisplay}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomClaimForm — tab-field form for a single custom claim
// ─────────────────────────────────────────────────────────────────────────────

const VALUE_TYPES: ClaimValueType[] = ['STRING', 'STRING_ARRAY'];
const OPERATORS: ClaimOperator[] = ['EQUALS', 'CONTAINS', 'CONTAINS_ANY'];

type ClaimField = 'claimName' | 'valueType' | 'operator' | 'matchValue';
const CLAIM_FIELDS: ClaimField[] = ['claimName', 'valueType', 'operator', 'matchValue'];

interface CustomClaimFormProps {
  initialClaim?: CustomClaimEntry;
  onSave: (claim: CustomClaimEntry) => void;
  onCancel: () => void;
}

function CustomClaimForm({ initialClaim, onSave, onCancel }: CustomClaimFormProps) {
  const [activeField, setActiveField] = useState<ClaimField>('claimName');
  const [claimName, setClaimName] = useState(initialClaim?.claimName ?? '');
  const [valueType, setValueType] = useState<ClaimValueType>(initialClaim?.valueType ?? 'STRING');
  const [operator, setOperator] = useState<ClaimOperator>(initialClaim?.operator ?? 'EQUALS');
  const [matchValue, setMatchValue] = useState(initialClaim?.matchValue ?? '');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    // Tab / Shift+Tab / Up / Down to cycle fields
    if (key.tab || key.upArrow || key.downArrow) {
      const idx = CLAIM_FIELDS.indexOf(activeField);
      if (key.shift || key.upArrow) {
        setActiveField(CLAIM_FIELDS[(idx - 1 + CLAIM_FIELDS.length) % CLAIM_FIELDS.length]!);
      } else {
        setActiveField(CLAIM_FIELDS[(idx + 1) % CLAIM_FIELDS.length]!);
      }
      setError(null);
      return;
    }

    // Enter: advance to next field, or submit on the last field
    if (key.return) {
      const idx = CLAIM_FIELDS.indexOf(activeField);
      if (idx < CLAIM_FIELDS.length - 1) {
        // Validate current field before advancing
        if (activeField === 'claimName') {
          if (!claimName.trim()) {
            setError('Claim name is required');
            return;
          }
          if (!/^[A-Za-z0-9_.\-:]+$/.test(claimName.trim())) {
            setError('Claim name may only contain letters, digits, _, ., -, :');
            return;
          }
        }
        setActiveField(CLAIM_FIELDS[idx + 1]!);
        setError(null);
        return;
      }
      // Last field — submit
      if (!claimName.trim()) {
        setError('Claim name is required');
        return;
      }
      if (!/^[A-Za-z0-9_.\-:]+$/.test(claimName.trim())) {
        setError('Claim name may only contain letters, digits, _, ., -, :');
        return;
      }
      if (!matchValue.trim()) {
        setError('Match value is required');
        return;
      }
      if (valueType === 'STRING_ARRAY') {
        const values = matchValue
          .split(',')
          .map(v => v.trim())
          .filter(Boolean);
        if (values.length === 0) {
          setError('At least one non-empty value is required');
          return;
        }
      }
      onSave({ claimName: claimName.trim(), valueType, operator, matchValue: matchValue.trim() });
      return;
    }

    // For text fields: handle typing
    if (activeField === 'claimName' || activeField === 'matchValue') {
      if (key.backspace || key.delete) {
        if (activeField === 'claimName') setClaimName(v => v.slice(0, -1));
        else setMatchValue(v => v.slice(0, -1));
        setError(null);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (activeField === 'claimName') setClaimName(v => v + input);
        else setMatchValue(v => v + input);
        setError(null);
        return;
      }
    }

    // For select fields: left/right to cycle
    if (activeField === 'valueType') {
      if (key.leftArrow || key.rightArrow) {
        const idx = VALUE_TYPES.indexOf(valueType);
        const next = key.rightArrow
          ? (idx + 1) % VALUE_TYPES.length
          : (idx - 1 + VALUE_TYPES.length) % VALUE_TYPES.length;
        setValueType(VALUE_TYPES[next]!);
        return;
      }
    }

    if (activeField === 'operator') {
      if (key.leftArrow || key.rightArrow) {
        const idx = OPERATORS.indexOf(operator);
        const next = key.rightArrow ? (idx + 1) % OPERATORS.length : (idx - 1 + OPERATORS.length) % OPERATORS.length;
        setOperator(OPERATORS[next]!);
        return;
      }
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{initialClaim ? 'Edit Claim' : 'New Claim'}</Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={activeField === 'claimName' ? 'cyan' : 'gray'}>Claim name: </Text>
          {activeField === 'claimName' && !claimName && <Cursor />}
          <Text color={activeField === 'claimName' ? undefined : 'gray'}>
            {claimName || <Text dimColor>e.g., department</Text>}
          </Text>
          {activeField === 'claimName' && claimName && <Cursor />}
        </Box>

        <Box>
          <Text color={activeField === 'valueType' ? 'cyan' : 'gray'}>Value type: </Text>
          <Text color={activeField === 'valueType' ? 'yellow' : 'gray'}>
            {valueType === 'STRING' ? 'String' : 'String Array'}
          </Text>
          {activeField === 'valueType' && (
            <Text dimColor>
              {' '}
              ◂ {VALUE_TYPES.indexOf(valueType) + 1}/{VALUE_TYPES.length} ▸
            </Text>
          )}
        </Box>

        <Box>
          <Text color={activeField === 'operator' ? 'cyan' : 'gray'}>Operator: </Text>
          <Text color={activeField === 'operator' ? 'yellow' : 'gray'}>
            {operator === 'EQUALS' ? 'Equals' : operator === 'CONTAINS' ? 'Contains' : 'Contains Any'}
          </Text>
          {activeField === 'operator' && (
            <Text dimColor>
              {' '}
              ◂ {OPERATORS.indexOf(operator) + 1}/{OPERATORS.length} ▸
            </Text>
          )}
        </Box>

        <Box>
          <Text color={activeField === 'matchValue' ? 'cyan' : 'gray'}>Match value: </Text>
          {activeField === 'matchValue' && !matchValue && <Cursor />}
          <Text color={activeField === 'matchValue' ? undefined : 'gray'}>
            {matchValue || (
              <Text dimColor>
                {valueType === 'STRING_ARRAY' ? 'comma-separated, e.g., admin, dev' : 'e.g., engineering'}
              </Text>
            )}
          </Text>
          {activeField === 'matchValue' && matchValue && <Cursor />}
        </Box>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}
