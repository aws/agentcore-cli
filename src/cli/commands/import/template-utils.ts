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
 * Filter a synthesized CDK template to keep only companion resources.
 * Removes all AWS::BedrockAgentCore::* resources and their related Outputs.
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
      filtered.Resources[logicalId] = { ...resource };
    }
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
  const importTemplate: CfnTemplate = JSON.parse(JSON.stringify(deployedTemplate));

  for (const logicalId of logicalIdsToImport) {
    const resource = synthTemplate.Resources[logicalId];
    if (!resource) {
      throw new Error(`Logical ID ${logicalId} not found in synthesized template`);
    }

    // Deep clone and set DeletionPolicy: Retain
    const importedResource: CfnResource = JSON.parse(JSON.stringify(resource));
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
  propertyValue: string
): string | undefined {
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Type === resourceType && resource.Properties) {
      const propVal = resource.Properties[propertyName];
      if (propVal === propertyValue) {
        return logicalId;
      }
      // Also check Fn::Join and other intrinsic functions that might construct the name
      if (typeof propVal === 'object' && propVal !== null) {
        const propJson = JSON.stringify(propVal);
        if (propJson.includes(propertyValue)) {
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
