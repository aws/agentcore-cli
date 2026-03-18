import type { TaggableResourceType } from './types';

export const TAGGABLE_RESOURCE_TYPES: readonly TaggableResourceType[] = ['agent', 'memory', 'gateway'];

export const NON_TAGGABLE_NOTE =
  'Credentials are not taggable (deployed via AgentCore Identity API, not CFN resources).';
