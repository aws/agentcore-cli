export type ResourceType =
  | 'agent'
  | 'gateway'
  | 'gateway-target'
  | 'harness'
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

export interface RemoveResult {
  success: boolean;
  resourceType?: ResourceType;
  resourceName?: string;
  message?: string;
  note?: string;
  error?: string;
}
