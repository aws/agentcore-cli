import type { SelectableItem } from '../index';

export type ConstraintType = 'audience' | 'clients' | 'scopes' | 'customClaims';

export type JwtSubStep =
  | 'discoveryUrl'
  | 'constraintPicker'
  | 'audience'
  | 'clients'
  | 'scopes'
  | 'customClaims'
  | 'clientId'
  | 'clientSecret';

export type ClaimValueType = 'STRING' | 'STRING_ARRAY';
export type ClaimOperator = 'EQUALS' | 'CONTAINS' | 'CONTAINS_ANY';

export interface CustomClaimEntry {
  claimName: string;
  valueType: ClaimValueType;
  operator: ClaimOperator;
  matchValue: string;
}

export type ClaimsManagerMode = 'list' | 'add' | 'edit-pick' | 'edit' | 'delete-pick';

export const CONSTRAINT_ITEMS: SelectableItem[] = [
  { id: 'audience', title: 'Allowed Audiences', description: 'Validate token audience claims' },
  { id: 'clients', title: 'Allowed Clients', description: 'Validate client identifiers in the token' },
  { id: 'scopes', title: 'Allowed Scopes', description: 'Validate token contains required scopes' },
  { id: 'customClaims', title: 'Custom Claims', description: 'Match specific token claims against rules' },
];

/** OIDC well-known suffix for validation */
export const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';

/** Validates that a comma-separated string has at least one non-empty value */
export function validateCommaSeparated(value: string): true | string {
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return items.length > 0 || 'At least one value is required';
}

export function formatClaimSummary(claim: CustomClaimEntry): string {
  const opLabel = claim.operator === 'EQUALS' ? '=' : claim.operator === 'CONTAINS' ? 'contains' : 'contains any of';
  const valueDisplay = claim.valueType === 'STRING_ARRAY' ? `[${claim.matchValue}]` : `"${claim.matchValue}"`;
  return `${claim.claimName} ${opLabel} ${valueDisplay}`;
}
