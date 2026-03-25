import { useMultiSelectNavigation } from '../../hooks';
import { SecretInput, TextInput, WizardMultiSelect } from '../index';
import { CustomClaimsManager } from './CustomClaimsManager';
import type { ClaimsManagerMode, ConstraintType, CustomClaimEntry, JwtSubStep } from './types';
import { CONSTRAINT_ITEMS, OIDC_WELL_KNOWN_SUFFIX, validateCommaSeparated } from './types';
import { Box, Text } from 'ink';
import React from 'react';

export interface JwtConfigInputProps {
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

export function JwtConfigInput({
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
            <Text dimColor>Optional: Provide OAuth credentials for bearer token fetching</Text>
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
