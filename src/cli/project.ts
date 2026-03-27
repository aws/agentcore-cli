import { getSchemaUrlForVersion } from '../lib';
import type { AgentCoreProjectSpec } from '../schema';
import { SCHEMA_VERSION } from './constants';

/**
 * Create a default AgentCore project spec with standard defaults.
 */
export function createDefaultProjectSpec(projectName: string): AgentCoreProjectSpec {
  return {
    $schema: getSchemaUrlForVersion(SCHEMA_VERSION),
    name: projectName,
    version: SCHEMA_VERSION,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    tags: {
      'agentcore:created-by': 'agentcore-cli',
      'agentcore:project-name': projectName,
    },
  };
}
