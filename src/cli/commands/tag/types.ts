export const TAGGABLE_RESOURCE_TYPES = ['agent', 'memory', 'gateway'] as const;
export type TaggableResourceType = (typeof TAGGABLE_RESOURCE_TYPES)[number];

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
