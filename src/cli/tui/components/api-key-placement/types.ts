export type ApiKeyPlacementSubStep = 'checklist' | 'location' | 'parameterName' | 'prefix';

export const PLACEMENT_OPTIONS = [
  { id: 'location', title: 'Location (default: HEADER)' },
  { id: 'parameterName', title: 'Parameter name (default: x-api-key)' },
  { id: 'prefix', title: 'Prefix (default: none)' },
] as const;
