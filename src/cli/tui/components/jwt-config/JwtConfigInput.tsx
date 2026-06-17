import {
  LATTICE_RESOURCE_CONFIG_PATTERN,
  SECURITY_GROUP_ID_PATTERN,
  SUBNET_ID_PATTERN,
} from '../../../../schema/schemas/auth';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { SecretInput, TextInput, WizardMultiSelect, WizardSelect } from '../index';
import { CustomClaimsManager } from './CustomClaimsManager';
import { DomainOverridesManager } from './DomainOverridesManager';
import type {
  ClaimsManagerMode,
  ConstraintType,
  CustomClaimEntry,
  DomainOverrideEntry,
  DomainOverridesManagerMode,
  JwtSubStep,
} from './types';
import {
  CONSTRAINT_ITEMS,
  ENDPOINT_IP_TYPE_ITEMS,
  OIDC_WELL_KNOWN_SUFFIX,
  PRIVATE_ENDPOINT_TYPE_ITEMS,
  validateCommaSeparated,
} from './types';
import { Box, Text } from 'ink';
import React from 'react';

/** Validate a comma-separated list of ids against a schema regex (matches the CLI flag path strictness). */
function validateIdList(value: string, pattern: RegExp, label: string, max?: number): true | string {
  const ids = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return 'At least one value is required';
  if (max && ids.length > max) return `At most ${max} allowed`;
  const bad = ids.find(id => !pattern.test(id));
  return bad ? `Invalid ${label}: "${bad}"` : true;
}

export interface JwtConfigInputProps {
  subStep: JwtSubStep;
  steps: JwtSubStep[];
  selectedConstraints: Set<ConstraintType>;
  customClaims: CustomClaimEntry[];
  discoveryUrl: string;
  audience: string;
  clients: string;
  scopes: string;
  // PrivateLink inbound (harness-only; optional so Gateway/Agent/Generate callers are unaffected).
  latticeResourceId?: string;
  vpcId?: string;
  vpcSubnets?: string;
  vpcSecurityGroups?: string;
  vpcRoutingDomain?: string;
  domainOverrides?: DomainOverrideEntry[];
  onDiscoveryUrl: (url: string) => void;
  onConstraintsPicked: (selectedIds: string[]) => void;
  onAudience: (audience: string) => void;
  onClients: (clients: string) => void;
  onScopes: (scopes: string) => void;
  onCustomClaimsDone: (claims: CustomClaimEntry[]) => void;
  onPrivateEndpointType?: (type: string) => void;
  onLatticeResourceId?: (value: string) => void;
  onVpcId?: (value: string) => void;
  onVpcSubnets?: (value: string) => void;
  onVpcIpType?: (value: string) => void;
  onVpcSecurityGroups?: (value: string) => void;
  onVpcRoutingDomain?: (value: string) => void;
  onDomainOverridesDone?: (overrides: DomainOverrideEntry[]) => void;
  onOverridesManagerModeChange?: (mode: DomainOverridesManagerMode) => void;
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
  latticeResourceId = '',
  vpcId = '',
  vpcSubnets = '',
  vpcSecurityGroups = '',
  vpcRoutingDomain = '',
  domainOverrides = [],
  onDiscoveryUrl,
  onConstraintsPicked,
  onAudience,
  onClients,
  onScopes,
  onCustomClaimsDone,
  onPrivateEndpointType,
  onLatticeResourceId,
  onVpcId,
  onVpcSubnets,
  onVpcIpType,
  onVpcSecurityGroups,
  onVpcRoutingDomain,
  onDomainOverridesDone,
  onOverridesManagerModeChange,
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

  const privateEndpointTypeNav = useListNavigation({
    items: PRIVATE_ENDPOINT_TYPE_ITEMS,
    onSelect: item => onPrivateEndpointType?.(item.id),
    onExit: () => onBack(),
    isActive: subStep === 'privateEndpointType',
  });

  const ipTypeNav = useListNavigation({
    items: ENDPOINT_IP_TYPE_ITEMS,
    onSelect: item => onVpcIpType?.(item.id),
    onExit: () => onBack(),
    isActive: subStep === 'vpcIpType',
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
        {subStep === 'privateEndpointType' && (
          <WizardSelect
            title="Private network access to the IdP discovery endpoint (PrivateLink)"
            description="Choose None if the discovery URL is publicly reachable"
            items={PRIVATE_ENDPOINT_TYPE_ITEMS}
            selectedIndex={privateEndpointTypeNav.selectedIndex}
          />
        )}
        {subStep === 'latticeResourceId' && (
          <TextInput
            prompt="VPC Lattice resource-config id or ARN"
            placeholder="rcfg-0123456789abcdef0"
            initialValue={latticeResourceId}
            onSubmit={v => onLatticeResourceId?.(v)}
            onCancel={onBack}
            customValidation={value =>
              LATTICE_RESOURCE_CONFIG_PATTERN.test(value.trim()) ||
              'Must be a VPC Lattice resource-config id (rcfg-...) or ARN'
            }
          />
        )}
        {subStep === 'domainOverrides' && (
          <DomainOverridesManager
            initialOverrides={domainOverrides}
            onDone={overrides => onDomainOverridesDone?.(overrides)}
            onCancel={onBack}
            onModeChange={onOverridesManagerModeChange}
          />
        )}
        {subStep === 'vpcId' && (
          <TextInput
            prompt="VPC id"
            placeholder="vpc-0123456789abcdef0"
            initialValue={vpcId}
            onSubmit={v => onVpcId?.(v)}
            onCancel={onBack}
            customValidation={value =>
              /^vpc-(([0-9a-z]{8})|([0-9a-z]{17}))$/.test(value.trim()) || 'Must be a VPC id (vpc-...)'
            }
          />
        )}
        {subStep === 'vpcSubnets' && (
          <TextInput
            prompt="Subnet IDs (comma-separated)"
            placeholder="subnet-0123456789abcdef0, subnet-0fedcba9876543210"
            initialValue={vpcSubnets}
            onSubmit={v => onVpcSubnets?.(v)}
            onCancel={onBack}
            customValidation={value => validateIdList(value, SUBNET_ID_PATTERN, 'subnet id (subnet-...)')}
          />
        )}
        {subStep === 'vpcIpType' && (
          <WizardSelect
            title="Endpoint IP address type"
            items={ENDPOINT_IP_TYPE_ITEMS}
            selectedIndex={ipTypeNav.selectedIndex}
          />
        )}
        {subStep === 'vpcSecurityGroups' && (
          <TextInput
            prompt="Security group IDs (comma-separated, max 5; press Enter to skip)"
            placeholder="sg-0123456789abcdef0"
            initialValue={vpcSecurityGroups}
            onSubmit={v => onVpcSecurityGroups?.(v)}
            onCancel={onBack}
            allowEmpty
            customValidation={value =>
              value.trim() === ''
                ? true
                : validateIdList(value, SECURITY_GROUP_ID_PATTERN, 'security group id (sg-...)', 5)
            }
          />
        )}
        {subStep === 'vpcRoutingDomain' && (
          <TextInput
            prompt="Routing domain (press Enter to skip)"
            placeholder="example.internal"
            initialValue={vpcRoutingDomain}
            onSubmit={v => onVpcRoutingDomain?.(v)}
            onCancel={onBack}
            allowEmpty
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
