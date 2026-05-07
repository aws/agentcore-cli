import { PRIMARY_RESOURCE_TYPES } from './constants';

/**
 * A simplified CloudFormation template structure.
 */
export interface CfnTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, unknown>;
  Mappings?: Record<string, unknown>;
  Conditions?: Record<string, unknown>;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, unknown>;
  Rules?: Record<string, unknown>;
  Transform?: unknown;
  Metadata?: Record<string, unknown>;
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Condition?: string;
  Metadata?: Record<string, unknown>;
}

/**
 * Check if a CFN resource type is a primary AgentCore resource.
 */
function isPrimaryResourceType(type: string): boolean {
  return PRIMARY_RESOURCE_TYPES.some(t => type.startsWith(t));
}

/**
 * Recursively replace { "Ref": "<id>" } and { "Fn::GetAtt": ["<id>", ...] }
 * references to removed logical IDs with a wildcard placeholder.
 *
 * Uses "*" because these references often end up in IAM policy Resource fields
 * which require ARN format or "*". Phase 3 (agentcore deploy) replaces the
 * entire template with the real synthesized values.
 */
function replaceDanglingRefs(value: unknown, removedIds: Set<string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(item => replaceDanglingRefs(item, removedIds));
  }

  const obj = value as Record<string, unknown>;

  // Handle { "Ref": "LogicalId" }
  if ('Ref' in obj && typeof obj.Ref === 'string' && removedIds.has(obj.Ref)) {
    return '*';
  }

  // Handle { "Fn::GetAtt": ["LogicalId", "Attribute"] }
  if ('Fn::GetAtt' in obj) {
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && getAtt.length >= 1 && removedIds.has(getAtt[0] as string)) {
      return '*';
    }
  }

  // Handle { "Fn::Sub": "...${LogicalId}..." } or { "Fn::Sub": ["...", { ... }] }
  if ('Fn::Sub' in obj) {
    const sub = obj['Fn::Sub'];
    if (typeof sub === 'string') {
      let replaced = sub;
      for (const id of removedIds) {
        // eslint-disable-next-line security/detect-non-literal-regexp -- id comes from template logical IDs
        replaced = replaced.replace(new RegExp(`\\$\\{${id}[^}]*\\}`, 'g'), '*');
      }
      if (replaced !== sub) return { 'Fn::Sub': replaced };
    }
  }

  // Recurse into all properties
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = replaceDanglingRefs(val, removedIds);
  }
  return result;
}

/**
 * Filter a synthesized CDK template to keep only companion resources.
 * Removes all AWS::BedrockAgentCore::* resources and their related Outputs.
 * Replaces dangling Ref/Fn::GetAtt references with placeholders.
 *
 * Used for Phase 1 (UPDATE) to create companion IAM roles and policies
 * without the primary resources.
 */
export function filterCompanionOnlyTemplate(synthTemplate: CfnTemplate): CfnTemplate {
  const filtered: CfnTemplate = {
    ...synthTemplate,
    Resources: {},
    Outputs: {},
  };

  // Collect logical IDs of primary resources to remove
  const removedLogicalIds = new Set<string>();

  for (const [logicalId, resource] of Object.entries(synthTemplate.Resources)) {
    if (isPrimaryResourceType(resource.Type)) {
      removedLogicalIds.add(logicalId);
    } else {
      // Deep clone to avoid mutating original
      filtered.Resources[logicalId] = JSON.parse(JSON.stringify(resource)) as CfnResource;
    }
  }

  // Replace dangling Ref/Fn::GetAtt references in companion resources
  for (const [logicalId, resource] of Object.entries(filtered.Resources)) {
    filtered.Resources[logicalId] = replaceDanglingRefs(resource, removedLogicalIds) as CfnResource;
  }

  // Keep outputs that don't reference removed resources
  if (synthTemplate.Outputs) {
    for (const [outputKey, outputValue] of Object.entries(synthTemplate.Outputs)) {
      const outputJson = JSON.stringify(outputValue);
      // Check if any removed logical ID is referenced in this output
      const referencesRemoved = Array.from(removedLogicalIds).some(id => outputJson.includes(id));
      if (!referencesRemoved) {
        filtered.Outputs![outputKey] = outputValue;
      }
    }
  }

  // Remove DependsOn references to removed resources
  for (const [, resource] of Object.entries(filtered.Resources)) {
    if (resource.DependsOn) {
      if (typeof resource.DependsOn === 'string') {
        if (removedLogicalIds.has(resource.DependsOn)) {
          delete resource.DependsOn;
        }
      } else if (Array.isArray(resource.DependsOn)) {
        resource.DependsOn = resource.DependsOn.filter(d => !removedLogicalIds.has(d));
        if (resource.DependsOn.length === 0) {
          delete resource.DependsOn;
        }
      }
    }
  }

  return filtered;
}

/**
 * Build the import template by adding primary resources to the deployed template.
 * Sets DeletionPolicy: Retain on all imported resources.
 * Does NOT add any new Outputs (CFN restriction).
 */
export function buildImportTemplate(
  deployedTemplate: CfnTemplate,
  synthTemplate: CfnTemplate,
  logicalIdsToImport: string[]
): CfnTemplate {
  const importTemplate = JSON.parse(JSON.stringify(deployedTemplate)) as CfnTemplate;

  for (const logicalId of logicalIdsToImport) {
    const resource = synthTemplate.Resources[logicalId];
    if (!resource) {
      throw new Error(`Logical ID ${logicalId} not found in synthesized template`);
    }

    // Deep clone and set DeletionPolicy: Retain
    const importedResource = JSON.parse(JSON.stringify(resource)) as CfnResource;
    importedResource.DeletionPolicy = 'Retain';
    importedResource.UpdateReplacePolicy = 'Retain';

    // Remove DependsOn to avoid issues with resources not yet in the stack
    // Phase 3 (agentcore deploy) will add these back
    delete importedResource.DependsOn;

    // Keep all properties including AgentRuntimeArtifact so that CFN validation
    // passes. The CDK assets must be published to S3 before creating the IMPORT
    // change set (handled in phase2-import).

    importTemplate.Resources[logicalId] = importedResource;
  }

  return importTemplate;
}

/**
 * Find the logical ID of a resource in a synthesized template by its type and a property value.
 */
export function findLogicalIdByProperty(
  template: CfnTemplate,
  resourceType: string,
  propertyName: string,
  propertyValue: string,
  options?: { excludeLogicalIds?: ReadonlySet<string> }
): string | undefined {
  const exclude = options?.excludeLogicalIds;

  // First pass: exact string match (highest confidence)
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (exclude?.has(logicalId)) continue;
    if (resource.Type === resourceType && resource.Properties) {
      if (resource.Properties[propertyName] === propertyValue) {
        return logicalId;
      }
    }
  }

  // Second pass: check intrinsic functions (Fn::Join, Fn::Sub, etc.)
  // Use a regex boundary check to avoid false substring matches
  // (e.g., "agent1" matching "agent1_v2")
  const escaped = propertyValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // eslint-disable-next-line security/detect-non-literal-regexp
  const pattern = new RegExp(escaped + '(?=[^a-zA-Z0-9_]|$)');

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (exclude?.has(logicalId)) continue;
    if (resource.Type === resourceType && resource.Properties) {
      const propVal = resource.Properties[propertyName];
      if (typeof propVal === 'object' && propVal !== null) {
        if (pattern.test(JSON.stringify(propVal))) {
          return logicalId;
        }
      }
    }
  }
  return undefined;
}

/**
 * Find all logical IDs of a specific resource type in a template.
 */
export function findLogicalIdsByType(template: CfnTemplate, resourceType: string): string[] {
  return Object.entries(template.Resources)
    .filter(([, resource]) => resource.Type === resourceType)
    .map(([logicalId]) => logicalId);
}
