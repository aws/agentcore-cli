export type ResourceType = 'agent' | 'gateway' | 'mcp-tool' | 'memory' | 'identity' | 'target';

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
