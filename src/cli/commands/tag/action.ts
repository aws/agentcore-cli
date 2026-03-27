import { ConfigIO, NoProjectError, findConfigRoot } from '../../../lib';
import { TagKeySchema, TagValueSchema } from '../../../schema/schemas/primitives/tags';
import type { ResourceRef, ResourceTagInfo, TagListResult, TaggableResourceType } from './types';
import { TAGGABLE_RESOURCE_TYPES } from './types';

function getConfigIO(): ConfigIO {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new NoProjectError();
  }
  return new ConfigIO({ baseDir: configRoot });
}

function parseResourceRef(ref: string): ResourceRef {
  const colonIndex = ref.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid resource reference "${ref}". Expected format: type:name (e.g., agent:MyAgent)`);
  }
  const type = ref.substring(0, colonIndex) as TaggableResourceType;
  const name = ref.substring(colonIndex + 1);

  if (!TAGGABLE_RESOURCE_TYPES.includes(type)) {
    throw new Error(`Invalid resource type "${type}". Taggable types: ${TAGGABLE_RESOURCE_TYPES.join(', ')}`);
  }
  if (!name) {
    throw new Error(`Resource name is required in reference "${ref}".`);
  }
  return { type, name };
}

export async function listTags(resourceFilter?: string): Promise<TagListResult> {
  const configIO = getConfigIO();
  const spec = await configIO.readProjectSpec();
  const projectDefaults = spec.tags ?? {};
  const resources: ResourceTagInfo[] = [];

  // Collect agents
  for (const agent of spec.runtimes ?? []) {
    resources.push({
      type: 'agent',
      name: agent.name,
      tags: { ...projectDefaults, ...(agent.tags ?? {}) },
    });
  }

  // Collect memories
  for (const memory of spec.memories ?? []) {
    resources.push({
      type: 'memory',
      name: memory.name,
      tags: { ...projectDefaults, ...(memory.tags ?? {}) },
    });
  }

  // Collect gateways (now in project spec after mcp.json merge)
  for (const gateway of spec.agentCoreGateways ?? []) {
    resources.push({
      type: 'gateway',
      name: gateway.name,
      tags: { ...projectDefaults, ...(gateway.tags ?? {}) },
    });
  }

  // Collect evaluators
  for (const evaluator of spec.evaluators ?? []) {
    resources.push({
      type: 'evaluator',
      name: evaluator.name,
      tags: { ...projectDefaults, ...(evaluator.tags ?? {}) },
    });
  }

  // Collect policy engines
  for (const engine of spec.policyEngines ?? []) {
    resources.push({
      type: 'policy-engine',
      name: engine.name,
      tags: { ...projectDefaults, ...(engine.tags ?? {}) },
    });
  }

  // Collect online eval configs
  for (const config of spec.onlineEvalConfigs ?? []) {
    resources.push({
      type: 'online-eval-config',
      name: config.name,
      tags: { ...projectDefaults, ...(config.tags ?? {}) },
    });
  }

  // Apply filter if specified
  if (resourceFilter) {
    const ref = parseResourceRef(resourceFilter);
    const filtered = resources.filter(r => r.type === ref.type && r.name === ref.name);
    if (filtered.length === 0) {
      throw new Error(`Resource "${resourceFilter}" not found.`);
    }
    return { projectDefaults, resources: filtered };
  }

  return { projectDefaults, resources };
}

function validateTagKeyValue(key: string, value: string): void {
  if (key.startsWith('agentcore:')) {
    throw new Error('Tag keys starting with "agentcore:" are managed by the system and cannot be modified.');
  }
  const keyResult = TagKeySchema.safeParse(key);
  if (!keyResult.success) {
    throw new Error(`Invalid tag key: ${keyResult.error.issues[0]?.message ?? 'validation failed'}`);
  }
  const valueResult = TagValueSchema.safeParse(value);
  if (!valueResult.success) {
    throw new Error(`Invalid tag value: ${valueResult.error.issues[0]?.message ?? 'validation failed'}`);
  }
}

export async function addTag(resourceRefStr: string, key: string, value: string): Promise<{ success: boolean }> {
  validateTagKeyValue(key, value);
  const ref = parseResourceRef(resourceRefStr);
  const configIO = getConfigIO();

  if (
    ref.type === 'agent' ||
    ref.type === 'memory' ||
    ref.type === 'evaluator' ||
    ref.type === 'policy-engine' ||
    ref.type === 'online-eval-config'
  ) {
    const spec = await configIO.readProjectSpec();
    let collection: { name: string; tags?: Record<string, string> }[] | undefined;
    if (ref.type === 'agent') collection = spec.runtimes;
    else if (ref.type === 'memory') collection = spec.memories;
    else if (ref.type === 'evaluator') collection = spec.evaluators;
    else if (ref.type === 'policy-engine') collection = spec.policyEngines;
    else if (ref.type === 'online-eval-config') collection = spec.onlineEvalConfigs;

    const resource = (collection ?? []).find(r => r.name === ref.name);
    if (!resource) {
      throw new Error(`${ref.type} "${ref.name}" not found in project.`);
    }
    resource.tags = { ...(resource.tags ?? {}), [key]: value };
    await configIO.writeProjectSpec(spec);
  } else if (ref.type === 'gateway') {
    const spec = await configIO.readProjectSpec();
    const gateway = spec.agentCoreGateways.find(g => g.name === ref.name);
    if (!gateway) {
      throw new Error(`gateway "${ref.name}" not found in project.`);
    }
    gateway.tags = { ...(gateway.tags ?? {}), [key]: value };
    await configIO.writeProjectSpec(spec);
  }

  return { success: true };
}

export async function removeTag(resourceRefStr: string, key: string): Promise<{ success: boolean }> {
  if (key.startsWith('agentcore:')) {
    throw new Error('Tag keys starting with "agentcore:" are managed by the system and cannot be modified.');
  }
  const ref = parseResourceRef(resourceRefStr);
  const configIO = getConfigIO();
  const spec = await configIO.readProjectSpec();

  let collection: { name: string; tags?: Record<string, string> }[] | undefined;
  if (ref.type === 'agent') collection = spec.runtimes;
  else if (ref.type === 'memory') collection = spec.memories;
  else if (ref.type === 'evaluator') collection = spec.evaluators;
  else if (ref.type === 'policy-engine') collection = spec.policyEngines;
  else if (ref.type === 'online-eval-config') collection = spec.onlineEvalConfigs;
  else if (ref.type === 'gateway') collection = spec.agentCoreGateways;

  const resource = (collection ?? []).find(r => r.name === ref.name);
  if (!resource) {
    throw new Error(`${ref.type} "${ref.name}" not found in project.`);
  }
  if (!resource.tags || !(key in resource.tags)) {
    throw new Error(
      `Tag key "${key}" not found on ${ref.type} "${ref.name}". ` +
        `If this is an inherited project default, use "tag remove-defaults --key ${key}" instead.`
    );
  }
  delete resource.tags[key];
  if (Object.keys(resource.tags).length === 0) {
    resource.tags = undefined;
  }
  await configIO.writeProjectSpec(spec);

  return { success: true };
}

export async function setDefaultTag(key: string, value: string): Promise<{ success: boolean }> {
  validateTagKeyValue(key, value);
  const configIO = getConfigIO();
  const spec = await configIO.readProjectSpec();
  spec.tags = { ...(spec.tags ?? {}), [key]: value };
  await configIO.writeProjectSpec(spec);
  return { success: true };
}

export async function removeDefaultTag(key: string): Promise<{ success: boolean }> {
  if (key.startsWith('agentcore:')) {
    throw new Error('Tag keys starting with "agentcore:" are managed by the system and cannot be modified.');
  }
  const configIO = getConfigIO();
  const spec = await configIO.readProjectSpec();
  if (!spec.tags || !(key in spec.tags)) {
    throw new Error(`Default tag key "${key}" not found.`);
  }
  delete spec.tags[key];
  if (Object.keys(spec.tags).length === 0) {
    spec.tags = undefined;
  }
  await configIO.writeProjectSpec(spec);
  return { success: true };
}

export async function getAvailableResources(): Promise<string[]> {
  const result = await listTags();
  return result.resources.map(r => `${r.type}:${r.name}`);
}
