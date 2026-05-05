import type { Result } from '../../../lib/result';

export type ResourceType =
  | 'agent'
  | 'gateway'
  | 'gateway-target'
  | 'runtime-endpoint'
  | 'memory'
  | 'credential'
  | 'evaluator'
  | 'online-eval'
  | 'policy-engine'
  | 'policy'
  | 'config-bundle'
  | 'ab-test';

export interface RemoveOptions {
  resourceType: ResourceType;
  name?: string;
  force?: boolean;
  json?: boolean;
}

export interface RemoveAllOptions {
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export type RemoveResult = Result<{
  resourceType?: ResourceType;
  resourceName?: string;
  message?: string;
  note?: string;
}>;
