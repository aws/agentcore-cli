export type TaggableResourceType =
  | 'agent'
  | 'memory'
  | 'gateway'
  | 'evaluator'
  | 'policy-engine'
  | 'online-eval-config';

export const TAGGABLE_RESOURCE_TYPES: TaggableResourceType[] = [
  'agent',
  'memory',
  'gateway',
  'evaluator',
  'policy-engine',
  'online-eval-config',
];

export interface ResourceRef {
  type: TaggableResourceType;
  name: string;
}

export interface ResourceTagInfo {
  type: TaggableResourceType;
  name: string;
  tags: Record<string, string>;
}

export interface TagListResult {
  projectDefaults: Record<string, string>;
  resources: ResourceTagInfo[];
}
