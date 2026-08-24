import type { AgentCoreProjectSpec, DeployedResourceState } from '../../../../schema/index.js';
import { computeResourceStatuses, handleProjectStatus } from '../action.js';
import type { ResourceStatusEntry, StatusContext } from '../action.js';
import { buildRuntimeInvocationUrl } from '../constants.js';
import assert from 'node:assert';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAgentRuntimeStatus = vi.fn();
const mockGetEvaluator = vi.fn();
const mockGetOnlineEvaluationConfig = vi.fn();
const mockGetKnowledgeBase = vi.fn();
const mockGetLatestIngestionJob = vi.fn();
const mockGetPaymentManager = vi.fn();
const mockGetPaymentConnector = vi.fn();

vi.mock('../../../aws', () => ({
  getAgentRuntimeStatus: (...args: unknown[]) => mockGetAgentRuntimeStatus(...args),
}));

vi.mock('../../../aws/agentcore-control', () => ({
  getEvaluator: (...args: unknown[]) => mockGetEvaluator(...args),
  getOnlineEvaluationConfig: (...args: unknown[]) => mockGetOnlineEvaluationConfig(...args),
}));

vi.mock('../../../aws/bedrock-agent', () => ({
  getKnowledgeBase: (...args: unknown[]) => mockGetKnowledgeBase(...args),
  getLatestIngestionJob: (...args: unknown[]) => mockGetLatestIngestionJob(...args),
}));

vi.mock('../../../aws/agentcore-payments', () => ({
  getPaymentManager: (...args: unknown[]) => mockGetPaymentManager(...args),
  getPaymentConnector: (...args: unknown[]) => mockGetPaymentConnector(...args),
}));

const loggedLines: string[] = [];
vi.mock('../../../logging', () => {
  return {
    ExecLogger: class {
      startStep = vi.fn();
      endStep = vi.fn();
      log = vi.fn((line: string) => {
        loggedLines.push(line);
      });
      finalize = vi.fn();
      getRelativeLogPath = vi.fn().mockReturnValue('logs/status.log');
    },
  };
});

const baseProject: AgentCoreProjectSpec = {
  name: 'test-project',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [],
  memories: [],
  knowledgeBases: [],
  credentials: [],
} as unknown as AgentCoreProjectSpec;

describe('computeResourceStatuses', () => {
  it('returns empty array for empty project with no deployed state', () => {
    const result = computeResourceStatuses(baseProject, undefined);
    expect(result).toEqual([]);
  });

  it('marks agent as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      runtimes: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      runtimes: {
        'my-agent': {
          runtimeId: 'rt-123',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const agentEntry = result.find(r => r.resourceType === 'agent' && r.name === 'my-agent');

    expect(agentEntry).toBeDefined();
    expect(agentEntry!.deploymentState).toBe('deployed');
    expect(agentEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123');
  });

  it('marks agent as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      runtimes: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const agentEntry = result.find(r => r.resourceType === 'agent' && r.name === 'my-agent');

    expect(agentEntry).toBeDefined();
    expect(agentEntry!.deploymentState).toBe('local-only');
    expect(agentEntry!.identifier).toBeUndefined();
  });

  it('marks agent as pending-removal when in deployed state but not in local schema', () => {
    const resources: DeployedResourceState = {
      runtimes: {
        'removed-agent': {
          runtimeId: 'rt-456',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-456',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const agentEntry = result.find(r => r.resourceType === 'agent' && r.name === 'removed-agent');

    expect(agentEntry).toBeDefined();
    expect(agentEntry!.deploymentState).toBe('pending-removal');
    expect(agentEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-456');
  });

  it('marks credential as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      credentials: [{ name: 'my-cred', authorizerType: 'OAuthCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      credentials: {
        'my-cred': {
          credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789:credential-provider/my-cred',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const credEntry = result.find(r => r.resourceType === 'credential' && r.name === 'my-cred');

    expect(credEntry).toBeDefined();
    expect(credEntry!.deploymentState).toBe('deployed');
    expect(credEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:credential-provider/my-cred');
    expect(credEntry!.detail).toBe('OAuth');
  });

  it('marks credential as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      credentials: [{ name: 'my-cred', authorizerType: 'ApiKeyCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const credEntry = result.find(r => r.resourceType === 'credential' && r.name === 'my-cred');

    expect(credEntry).toBeDefined();
    expect(credEntry!.deploymentState).toBe('local-only');
    expect(credEntry!.detail).toBe('ApiKey');
  });

  it('marks credential as pending-removal when in deployed state but not in local schema', () => {
    const resources: DeployedResourceState = {
      credentials: {
        'removed-cred': {
          credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789:credential-provider/removed-cred',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const credEntry = result.find(r => r.resourceType === 'credential' && r.name === 'removed-cred');

    expect(credEntry).toBeDefined();
    expect(credEntry!.deploymentState).toBe('pending-removal');
    expect(credEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:credential-provider/removed-cred');
  });

  it('marks memory as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      memories: [{ name: 'my-memory', strategies: [{ type: 'SEMANTIC' }] }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      memories: {
        'my-memory': {
          memoryId: 'mem-123',
          memoryArn: 'arn:aws:bedrock:us-east-1:123456789:memory/mem-123',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const memEntry = result.find(r => r.resourceType === 'memory' && r.name === 'my-memory');

    expect(memEntry).toBeDefined();
    expect(memEntry!.deploymentState).toBe('deployed');
    expect(memEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:memory/mem-123');
    expect(memEntry!.detail).toBe('SEMANTIC');
  });

  it('marks memory as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      memories: [{ name: 'my-memory', strategies: [{ type: 'SUMMARIZATION' }] }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const memEntry = result.find(r => r.resourceType === 'memory' && r.name === 'my-memory');

    expect(memEntry).toBeDefined();
    expect(memEntry!.deploymentState).toBe('local-only');
    expect(memEntry!.detail).toBe('SUMMARIZATION');
  });

  it('marks memory as pending-removal when in deployed state but not in local schema', () => {
    const resources: DeployedResourceState = {
      memories: {
        'removed-memory': {
          memoryId: 'mem-456',
          memoryArn: 'arn:aws:bedrock:us-east-1:123456789:memory/mem-456',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const pendingMemEntry = result.find(r => r.resourceType === 'memory' && r.deploymentState === 'pending-removal');

    expect(pendingMemEntry).toBeDefined();
    expect(pendingMemEntry!.name).toBe('removed-memory');
    expect(pendingMemEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:memory/mem-456');
  });

  it('marks all resources as local-only when never deployed', () => {
    const project = {
      ...baseProject,
      runtimes: [{ name: 'agent-a' }],
      memories: [{ name: 'mem-a', strategies: [] }],
      credentials: [{ name: 'cred-a', authorizerType: 'ApiKeyCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);

    expect(result).toHaveLength(3);
    expect(result.every(r => r.deploymentState === 'local-only')).toBe(true);
  });

  it('marks gateway as deployed when in both local project and deployed state', () => {
    const project = {
      ...baseProject,
      agentCoreGateways: [{ name: 'my-gateway', targets: [{ name: 't1' }, { name: 't2' }] }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      mcp: {
        gateways: {
          'my-gateway': {
            gatewayId: 'gw-123',
            gatewayArn: 'arn:aws:bedrock:us-east-1:123456789:gateway/gw-123',
          },
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'my-gateway');

    expect(gwEntry).toBeDefined();
    expect(gwEntry!.deploymentState).toBe('deployed');
    expect(gwEntry!.identifier).toBe('gw-123');
    expect(gwEntry!.detail).toBe('2 targets');
  });

  it('marks gateway as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      agentCoreGateways: [{ name: 'my-gateway', targets: [{ name: 't1' }] }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'my-gateway');

    expect(gwEntry).toBeDefined();
    expect(gwEntry!.deploymentState).toBe('local-only');
    expect(gwEntry!.detail).toBe('1 target');
  });

  it('marks gateway as pending-removal when in deployed state but not in local project', () => {
    const resources: DeployedResourceState = {
      mcp: {
        gateways: {
          'removed-gateway': {
            gatewayId: 'gw-456',
            gatewayArn: 'arn:aws:bedrock:us-east-1:123456789:gateway/gw-456',
          },
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'removed-gateway');

    expect(gwEntry).toBeDefined();
    expect(gwEntry!.deploymentState).toBe('pending-removal');
    expect(gwEntry!.identifier).toBe('gw-456');
  });

  it('marks evaluator as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      evaluators: [{ name: 'MyEval', level: 'SESSION', config: {} }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      evaluators: {
        MyEval: {
          evaluatorId: 'proj_MyEval-abc123',
          evaluatorArn: 'arn:aws:bedrock:us-east-1:123456789:evaluator/proj_MyEval-abc123',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const evalEntry = result.find(r => r.resourceType === 'evaluator' && r.name === 'MyEval');

    expect(evalEntry).toBeDefined();
    expect(evalEntry!.deploymentState).toBe('deployed');
    expect(evalEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:evaluator/proj_MyEval-abc123');
    expect(evalEntry!.detail).toBe('SESSION — LLM-as-a-Judge');
  });

  it('marks evaluator as local-only when not deployed', () => {
    const project = {
      ...baseProject,
      evaluators: [{ name: 'MyEval', level: 'TRACE', config: {} }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const evalEntry = result.find(r => r.resourceType === 'evaluator' && r.name === 'MyEval');

    expect(evalEntry).toBeDefined();
    expect(evalEntry!.deploymentState).toBe('local-only');
    expect(evalEntry!.detail).toBe('TRACE — LLM-as-a-Judge');
  });

  it('shows Code-based detail for code-based evaluator', () => {
    const project = {
      ...baseProject,
      evaluators: [{ name: 'CodeEval', level: 'SESSION', config: { codeBased: { managed: {} } } }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const evalEntry = result.find(r => r.resourceType === 'evaluator' && r.name === 'CodeEval');

    expect(evalEntry).toBeDefined();
    expect(evalEntry!.detail).toBe('SESSION — Code-based');
  });

  it('marks evaluator as pending-removal when deployed but removed from schema', () => {
    const resources: DeployedResourceState = {
      evaluators: {
        RemovedEval: {
          evaluatorId: 'proj_RemovedEval-xyz',
          evaluatorArn: 'arn:aws:bedrock:us-east-1:123456789:evaluator/proj_RemovedEval-xyz',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const evalEntry = result.find(r => r.resourceType === 'evaluator' && r.name === 'RemovedEval');

    expect(evalEntry).toBeDefined();
    expect(evalEntry!.deploymentState).toBe('pending-removal');
  });

  it('marks online-eval config as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      onlineEvalConfigs: [{ name: 'TestConfig', evaluators: ['Builtin.Helpfulness'], samplingRate: 10 }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      onlineEvalConfigs: {
        TestConfig: {
          onlineEvaluationConfigId: 'proj_TestConfig-abc',
          onlineEvaluationConfigArn: 'arn:aws:bedrock:us-east-1:123456789:online-evaluation-config/proj_TestConfig-abc',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const configEntry = result.find(r => r.resourceType === 'online-eval' && r.name === 'TestConfig');

    expect(configEntry).toBeDefined();
    expect(configEntry!.deploymentState).toBe('deployed');
    expect(configEntry!.detail).toBe('1 evaluator, 10% sampling');
  });

  it('marks online-eval config as local-only when not deployed', () => {
    const project = {
      ...baseProject,
      onlineEvalConfigs: [{ name: 'TestConfig', evaluators: ['Builtin.X', 'Builtin.Y', 'Custom'], samplingRate: 50 }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const configEntry = result.find(r => r.resourceType === 'online-eval' && r.name === 'TestConfig');

    expect(configEntry).toBeDefined();
    expect(configEntry!.deploymentState).toBe('local-only');
    expect(configEntry!.detail).toBe('3 evaluators, 50% sampling');
  });

  it('marks online-eval config as pending-removal when deployed but removed from schema', () => {
    const resources: DeployedResourceState = {
      onlineEvalConfigs: {
        RemovedConfig: {
          onlineEvaluationConfigId: 'proj_RemovedConfig-xyz',
          onlineEvaluationConfigArn:
            'arn:aws:bedrock:us-east-1:123456789:online-evaluation-config/proj_RemovedConfig-xyz',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const configEntry = result.find(r => r.resourceType === 'online-eval' && r.name === 'RemovedConfig');

    expect(configEntry).toBeDefined();
    expect(configEntry!.deploymentState).toBe('pending-removal');
  });

  it('marks harness as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      harnesses: [{ name: 'my-harness', path: 'harnesses/my-harness' }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      harnesses: {
        'my-harness': {
          harnessId: 'h-123',
          harnessArn: 'arn:aws:bedrock:us-east-1:123456789:harness/h-123',
          roleArn: 'arn:aws:iam::123456789:role/test',
          status: 'ACTIVE',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const harnessEntry = result.find(r => r.resourceType === 'harness' && r.name === 'my-harness');

    expect(harnessEntry).toBeDefined();
    expect(harnessEntry!.deploymentState).toBe('deployed');
    expect(harnessEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:harness/h-123');
  });

  it('marks harness as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      harnesses: [{ name: 'my-harness', path: 'harnesses/my-harness' }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const harnessEntry = result.find(r => r.resourceType === 'harness' && r.name === 'my-harness');

    expect(harnessEntry).toBeDefined();
    expect(harnessEntry!.deploymentState).toBe('local-only');
  });

  it('marks harness as pending-removal when in deployed state but not in local schema', () => {
    const resources: DeployedResourceState = {
      harnesses: {
        'removed-harness': {
          harnessId: 'h-456',
          harnessArn: 'arn:aws:bedrock:us-east-1:123456789:harness/h-456',
          roleArn: 'arn:aws:iam::123456789:role/test',
          status: 'ACTIVE',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const harnessEntry = result.find(r => r.resourceType === 'harness' && r.name === 'removed-harness');

    expect(harnessEntry).toBeDefined();
    expect(harnessEntry!.deploymentState).toBe('pending-removal');
    expect(harnessEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:harness/h-456');
  });

  it('renders the config version (v{N}) on a deployed harness', () => {
    const project = {
      ...baseProject,
      harnesses: [{ name: 'my-harness', path: 'harnesses/my-harness' }],
    } as unknown as AgentCoreProjectSpec;
    const resources: DeployedResourceState = {
      harnesses: {
        'my-harness': {
          harnessId: 'h-123',
          harnessArn: 'arn:aws:bedrock:us-east-1:123456789:harness/h-123',
          roleArn: 'arn:aws:iam::123456789:role/test',
          status: 'READY',
          harnessVersion: 3,
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const harnessEntry = result.find(r => r.resourceType === 'harness' && r.name === 'my-harness');
    expect(harnessEntry!.detail).toBe('v3');
  });

  it('handles mixed deployed and local-only resources', () => {
    const project = {
      ...baseProject,
      runtimes: [{ name: 'deployed-agent' }, { name: 'new-agent' }],
      credentials: [{ name: 'deployed-cred', authorizerType: 'OAuthCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      runtimes: {
        'deployed-agent': {
          runtimeId: 'rt-123',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
        'old-agent': {
          runtimeId: 'rt-old',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-old',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
      },
      credentials: {
        'deployed-cred': {
          credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789:credential-provider/deployed-cred',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);

    const deployedAgent = result.find(r => r.name === 'deployed-agent');
    expect(deployedAgent!.deploymentState).toBe('deployed');

    const newAgent = result.find(r => r.name === 'new-agent');
    expect(newAgent!.deploymentState).toBe('local-only');

    const oldAgent = result.find(r => r.name === 'old-agent');
    expect(oldAgent!.deploymentState).toBe('pending-removal');

    const deployedCred = result.find(r => r.name === 'deployed-cred');
    expect(deployedCred!.deploymentState).toBe('deployed');
  });

  it('marks knowledge-base as deployed when present in deployed-state', () => {
    const project = {
      ...baseProject,
      knowledgeBases: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'product-docs',
          dataSources: [{ type: 'S3', uri: 's3://b/d/' }],
        },
      ],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      knowledgeBases: {
        'product-docs': {
          knowledgeBaseId: 'KB1',
          knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:0:knowledge-base/KB1',
          dataSources: [{ dataSourceId: 'DS1', uri: 's3://b/d/' }],
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const kbEntry = result.find(r => r.resourceType === 'knowledge-base' && r.name === 'product-docs');

    expect(kbEntry).toBeDefined();
    expect(kbEntry!.deploymentState).toBe('deployed');
    expect(kbEntry!.identifier).toBe('arn:aws:bedrock:us-west-2:0:knowledge-base/KB1');
    expect(kbEntry!.detail).toBe('1 data source');
  });

  it('marks knowledge-base as local-only when not in deployed-state', () => {
    const project = {
      ...baseProject,
      knowledgeBases: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'fresh-kb',
          dataSources: [
            { type: 'S3', uri: 's3://b/a/' },
            { type: 'S3', uri: 's3://b/b/' },
          ],
        },
      ],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const kbEntry = result.find(r => r.resourceType === 'knowledge-base' && r.name === 'fresh-kb');

    expect(kbEntry).toBeDefined();
    expect(kbEntry!.deploymentState).toBe('local-only');
    expect(kbEntry!.detail).toBe('2 data sources');
  });

  it('marks knowledge-base as pending-removal when in deployed-state but not local', () => {
    const project = baseProject;
    const resources: DeployedResourceState = {
      knowledgeBases: {
        'orphan-kb': {
          knowledgeBaseId: 'KBOLD',
          knowledgeBaseArn: 'arn:aws:bedrock:us-west-2:0:knowledge-base/KBOLD',
          dataSources: [],
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const kbEntry = result.find(r => r.resourceType === 'knowledge-base' && r.name === 'orphan-kb');

    expect(kbEntry).toBeDefined();
    expect(kbEntry!.deploymentState).toBe('pending-removal');
  });

  it('surfaces gateway wiring on KB detail when a connector target references it', () => {
    const project = {
      ...baseProject,
      agentCoreGateways: [
        {
          name: 'main-gw',
          targets: [
            {
              name: 'docs',
              targetType: 'connector',
              connectorId: 'bedrock-knowledge-bases',
              configurations: [{ name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' } }],
            },
          ],
        },
      ],
      knowledgeBases: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'docs',
          dataSources: [{ type: 'S3', uri: 's3://b/d/' }],
        },
      ],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const kbEntry = result.find(r => r.resourceType === 'knowledge-base' && r.name === 'docs');
    expect(kbEntry?.detail).toBe('1 data source → gw:main-gw');
  });

  it('annotates gateway detail with retrieve-target count', () => {
    const project = {
      ...baseProject,
      agentCoreGateways: [
        {
          name: 'main-gw',
          targets: [
            { name: 't1', targetType: 'mcpServer' },
            {
              name: 'docs',
              targetType: 'connector',
              connectorId: 'bedrock-knowledge-bases',
              configurations: [
                { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' } },
                {
                  name: 'AgenticRetrieveStream',
                  parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'docs' } } }] },
                },
              ],
            },
          ],
        },
      ],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'main-gw');
    expect(gwEntry?.detail).toBe('2 targets (1 retrieve, agentic ×1)');
  });

  it('annotates gateway detail with both retrieve count and agentic fan-out', () => {
    const project = {
      ...baseProject,
      agentCoreGateways: [
        {
          name: 'main-gw',
          targets: [
            {
              name: 'docs',
              targetType: 'connector',
              connectorId: 'bedrock-knowledge-bases',
              configurations: [
                { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' } },
                {
                  name: 'AgenticRetrieveStream',
                  parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'docs' } } }] },
                },
              ],
            },
            {
              name: 'hr',
              targetType: 'connector',
              connectorId: 'bedrock-knowledge-bases',
              configurations: [
                { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'hr' } },
                {
                  name: 'AgenticRetrieveStream',
                  parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'hr' } } }] },
                },
              ],
            },
          ],
        },
      ],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'main-gw');
    expect(gwEntry?.detail).toBe('2 targets (2 retrieve, agentic ×2)');
  });

  it('KB detail surfaces wiring from configurations', () => {
    const project = {
      ...baseProject,
      agentCoreGateways: [
        {
          name: 'main-gw',
          targets: [
            {
              name: 'docs-target',
              targetType: 'connector',
              connectorId: 'bedrock-knowledge-bases',
              configurations: [
                { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' } },
                {
                  name: 'AgenticRetrieveStream',
                  parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'docs' } } }] },
                },
              ],
            },
          ],
        },
      ],
      knowledgeBases: [
        { type: 'AgentCoreKnowledgeBase', name: 'docs', dataSources: [{ type: 'S3', uri: 's3://b/d/' }] },
      ],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const kbEntry = result.find(r => r.resourceType === 'knowledge-base' && r.name === 'docs');
    expect(kbEntry?.detail).toBe('1 data source → gw:main-gw');
  });
});

describe('handleProjectStatus — live enrichment', () => {
  beforeEach(() => {
    mockGetAgentRuntimeStatus.mockReset();
    mockGetEvaluator.mockReset();
    mockGetOnlineEvaluationConfig.mockReset();
    mockGetPaymentManager.mockReset();
    mockGetPaymentConnector.mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  function makeContext(overrides: Partial<StatusContext> = {}): StatusContext {
    return {
      project: {
        ...baseProject,
        evaluators: [{ name: 'MyEval', level: 'SESSION', config: {} }],
        onlineEvalConfigs: [{ name: 'MyConfig', evaluators: ['Builtin.Helpfulness'], samplingRate: 10 }],
      } as unknown as AgentCoreProjectSpec,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '123456789' }],
      deployedState: {
        targets: {
          dev: {
            resources: {
              evaluators: {
                MyEval: {
                  evaluatorId: 'eval-123',
                  evaluatorArn: 'arn:aws:bedrock:us-east-1:123456789:evaluator/eval-123',
                },
              },
              onlineEvalConfigs: {
                MyConfig: {
                  onlineEvaluationConfigId: 'cfg-456',
                  onlineEvaluationConfigArn: 'arn:aws:bedrock:us-east-1:123456789:online-evaluation-config/cfg-456',
                },
              },
            },
          },
        },
      },
      ...overrides,
    } as unknown as StatusContext;
  }

  it('enriches deployed evaluators with live status', async () => {
    mockGetEvaluator.mockResolvedValue({
      evaluatorId: 'eval-123',
      evaluatorName: 'MyEval',
      status: 'ACTIVE',
      level: 'SESSION',
    });
    mockGetOnlineEvaluationConfig.mockResolvedValue({
      configId: 'cfg-456',
      configName: 'MyConfig',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
    });

    const result = await handleProjectStatus(makeContext());

    assert(result.success);

    const evalEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'evaluator' && r.name === 'MyEval'
    );
    expect(evalEntry).toBeDefined();
    expect(evalEntry!.detail).toContain('ACTIVE');

    expect(mockGetEvaluator).toHaveBeenCalledWith({
      region: 'us-east-1',
      evaluatorId: 'eval-123',
    });
  });

  it('enriches deployed online eval configs with live status', async () => {
    mockGetEvaluator.mockResolvedValue({
      evaluatorId: 'eval-123',
      evaluatorName: 'MyEval',
      status: 'ACTIVE',
      level: 'SESSION',
    });
    mockGetOnlineEvaluationConfig.mockResolvedValue({
      configId: 'cfg-456',
      configName: 'MyConfig',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
    });

    const result = await handleProjectStatus(makeContext());

    assert(result.success);

    const configEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'online-eval' && r.name === 'MyConfig'
    );
    expect(configEntry).toBeDefined();
    expect(configEntry!.detail).toContain('ACTIVE');
    expect(configEntry!.detail).toContain('ENABLED');

    expect(mockGetOnlineEvaluationConfig).toHaveBeenCalledWith({
      region: 'us-east-1',
      configId: 'cfg-456',
    });
  });

  it('sets error on evaluator when getEvaluator fails', async () => {
    mockGetEvaluator.mockRejectedValue(new Error('AccessDenied'));
    mockGetOnlineEvaluationConfig.mockResolvedValue({
      configId: 'cfg-456',
      configName: 'MyConfig',
      status: 'ACTIVE',
      executionStatus: 'ENABLED',
    });

    const result = await handleProjectStatus(makeContext());

    assert(result.success);

    const evalEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'evaluator' && r.name === 'MyEval'
    );
    expect(evalEntry).toBeDefined();
    expect(evalEntry!.error).toBe('AccessDenied');
  });

  it('sets error on online eval config when getOnlineEvaluationConfig fails', async () => {
    mockGetEvaluator.mockResolvedValue({
      evaluatorId: 'eval-123',
      evaluatorName: 'MyEval',
      status: 'ACTIVE',
      level: 'SESSION',
    });
    mockGetOnlineEvaluationConfig.mockRejectedValue(new Error('ResourceNotFound'));

    const result = await handleProjectStatus(makeContext());

    assert(result.success);

    const configEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'online-eval' && r.name === 'MyConfig'
    );
    expect(configEntry).toBeDefined();
    expect(configEntry!.error).toBe('ResourceNotFound');
  });

  it('skips enrichment when no target config is found', async () => {
    const ctx = makeContext({
      awsTargets: [] as unknown as StatusContext['awsTargets'],
      deployedState: {
        targets: {
          dev: {
            resources: {
              evaluators: {
                MyEval: {
                  evaluatorId: 'eval-123',
                  evaluatorArn: 'arn:aws:bedrock:us-east-1:123456789:evaluator/eval-123',
                },
              },
            },
          },
        },
      } as unknown as StatusContext['deployedState'],
    });

    const result = await handleProjectStatus(ctx);

    expect(result.success).toBe(true);
    expect(mockGetEvaluator).not.toHaveBeenCalled();
    expect(mockGetOnlineEvaluationConfig).not.toHaveBeenCalled();
  });

  function makePaymentContext(): StatusContext {
    return makeContext({
      project: {
        ...baseProject,
        payments: [
          {
            name: 'PayManager',
            authorizerType: 'AWS_IAM',
            connectors: [
              {
                name: 'QuickConnector',
                provider: 'CoinbaseCDP',
                provisionMode: 'QUICK_CREATE',
              },
            ],
            autoPayment: false,
            defaultSpendLimit: '10.00',
          },
        ],
      } as unknown as AgentCoreProjectSpec,
      deployedState: {
        targets: {
          dev: {
            resources: {
              payments: {
                PayManager: {
                  managerId: 'manager-123',
                  managerArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-manager/manager-123',
                  connectors: {
                    QuickConnector: {
                      connectorId: 'connector-123',
                      provisionMode: 'QUICK_CREATE',
                    },
                  },
                  processPaymentRoleArn: 'arn:aws:iam::123456789:role/process',
                  resourceRetrievalRoleArn: 'arn:aws:iam::123456789:role/retrieval',
                },
              },
            },
          },
        },
      },
    });
  }

  it('omits a retained authorization URL when the connector is READY', async () => {
    mockGetPaymentManager.mockResolvedValue({ status: 'READY' });
    mockGetPaymentConnector.mockResolvedValue({
      paymentConnectorId: 'connector-123',
      name: 'QuickConnector',
      type: 'CoinbaseCDP',
      status: 'READY',
      authorizationUrl: 'https://stale.example.com/authorize',
      credentialProviderConfigurations: [
        {
          coinbaseCDP: {
            credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-provider/generated',
          },
        },
      ],
    });

    const result = await handleProjectStatus(makePaymentContext());

    assert(result.success);
    const payment = result.resources.find(resource => resource.resourceType === 'payment');
    expect(payment?.paymentConnectors).toEqual([
      {
        name: 'QuickConnector',
        connectorId: 'connector-123',
        status: 'READY',
        credentialProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:payment-provider/generated',
      },
    ]);
  });

  it('includes the authorization URL while the connector is PENDING_AUTHENTICATION', async () => {
    mockGetPaymentManager.mockResolvedValue({ status: 'READY' });
    mockGetPaymentConnector.mockResolvedValue({
      paymentConnectorId: 'connector-123',
      name: 'QuickConnector',
      type: 'CoinbaseCDP',
      status: 'PENDING_AUTHENTICATION',
      authorizationUrl: 'https://current.example.com/authorize',
      credentialProviderConfigurations: [],
    });

    const result = await handleProjectStatus(makePaymentContext());

    assert(result.success);
    const payment = result.resources.find(resource => resource.resourceType === 'payment');
    expect(payment?.paymentConnectors?.[0]?.authorizationUrl).toBe('https://current.example.com/authorize');
  });

  it('does not enrich local-only evaluators', async () => {
    const ctx = makeContext({
      deployedState: {
        targets: {
          dev: {
            resources: {},
          },
        },
      } as unknown as StatusContext['deployedState'],
    });

    const result = await handleProjectStatus(ctx);

    assert(result.success);

    const evalEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'evaluator' && r.name === 'MyEval'
    );
    expect(evalEntry).toBeDefined();
    expect(evalEntry!.deploymentState).toBe('local-only');
    expect(mockGetEvaluator).not.toHaveBeenCalled();
  });
});

describe('handleProjectStatus — knowledge base enrichment', () => {
  beforeEach(() => {
    mockGetKnowledgeBase.mockReset();
    mockGetLatestIngestionJob.mockReset();
    loggedLines.length = 0;
  });

  afterEach(() => vi.clearAllMocks());

  function makeKbContext(): StatusContext {
    return {
      project: {
        ...baseProject,
        agentCoreGateways: [
          {
            name: 'main-gw',
            targets: [
              {
                name: 'docs',
                targetType: 'connector',
                connectorId: 'bedrock-knowledge-bases',
                configurations: [{ name: 'Retrieve', parameterValues: { knowledgeBaseId: 'product-docs' } }],
              },
            ],
          },
        ],
        knowledgeBases: [
          {
            type: 'AgentCoreKnowledgeBase',
            name: 'product-docs',
            dataSources: [
              { type: 'S3', uri: 's3://bucket/docs/' },
              { type: 'S3', uri: 's3://bucket/specs/' },
            ],
          },
        ],
      } as unknown as AgentCoreProjectSpec,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '123456789' }],
      deployedState: {
        targets: {
          dev: {
            resources: {
              knowledgeBases: {
                'product-docs': {
                  knowledgeBaseId: 'KB1',
                  knowledgeBaseArn: 'arn:aws:bedrock:us-east-1:123456789:knowledge-base/KB1',
                  dataSources: [
                    { dataSourceId: 'DS1', uri: 's3://bucket/docs/' },
                    { dataSourceId: 'DS2', uri: 's3://bucket/specs/' },
                  ],
                },
              },
            },
          },
        },
      },
    } as unknown as StatusContext;
  }

  it('fetches the latest ingestion job for every data source and renders all of them', async () => {
    mockGetKnowledgeBase.mockResolvedValue({ knowledgeBaseId: 'KB1', status: 'ACTIVE' });
    mockGetLatestIngestionJob.mockImplementation(({ dataSourceId }: { dataSourceId: string }) => {
      if (dataSourceId === 'DS1') {
        return {
          status: 'COMPLETE',
          startedAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:05:00Z'),
          statistics: {
            numberOfDocumentsScanned: 10,
            numberOfNewDocumentsIndexed: 8,
            numberOfModifiedDocumentsIndexed: 1,
            numberOfDocumentsFailed: 0,
            numberOfDocumentsDeleted: 0,
          },
        };
      }
      return {
        status: 'COMPLETE',
        startedAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:03:00Z'),
        statistics: {
          numberOfDocumentsScanned: 5,
          numberOfNewDocumentsIndexed: 5,
          numberOfModifiedDocumentsIndexed: 0,
          numberOfDocumentsFailed: 0,
          numberOfDocumentsDeleted: 0,
        },
      };
    });

    // Drill into the named KB so the full per-DS block is rendered (the default
    // view is now a one-line summary; see the dedicated summary/detail tests).
    const result = await handleProjectStatus(makeKbContext(), { knowledgeBaseName: 'product-docs' });

    assert(result.success);

    // A job was fetched for EACH data source, not just the first.
    expect(mockGetLatestIngestionJob).toHaveBeenCalledTimes(2);
    expect(mockGetLatestIngestionJob).toHaveBeenCalledWith({
      region: 'us-east-1',
      knowledgeBaseId: 'KB1',
      dataSourceId: 'DS1',
    });
    expect(mockGetLatestIngestionJob).toHaveBeenCalledWith({
      region: 'us-east-1',
      knowledgeBaseId: 'KB1',
      dataSourceId: 'DS2',
    });

    // The rich block, logged line-by-line, includes BOTH data source URIs and
    // their per-DS document counts plus the gateway wiring.
    const block = loggedLines.join('\n');
    expect(block).toContain('s3://bucket/docs/');
    expect(block).toContain('s3://bucket/specs/');
    expect(block).toContain('10 scanned, 8 new indexed');
    expect(block).toContain('5 scanned, 5 new indexed');
    expect(block).toContain('main-gw');

    // The structured detail stays a concise one-liner for TUI/JSON consumers.
    const kbEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'knowledge-base' && r.name === 'product-docs'
    );
    expect(kbEntry).toBeDefined();
    expect(kbEntry!.detail).toContain('Status: ACTIVE');
    expect(kbEntry!.detail).not.toContain('\n');
  });

  it('renders a one-line summary (not the full per-DS block) when no knowledgeBaseName is given', async () => {
    mockGetKnowledgeBase.mockResolvedValue({ knowledgeBaseId: 'KB1', status: 'ACTIVE' });
    mockGetLatestIngestionJob.mockResolvedValue({
      status: 'COMPLETE',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:05:00Z'),
      statistics: {
        numberOfDocumentsScanned: 10,
        numberOfNewDocumentsIndexed: 8,
        numberOfModifiedDocumentsIndexed: 0,
        numberOfDocumentsFailed: 0,
        numberOfDocumentsDeleted: 0,
      },
    });

    const result = await handleProjectStatus(makeKbContext());
    assert(result.success);

    const block = loggedLines.join('\n');
    // The summary rollup line is present (name + state + counts).
    expect(block).toContain('product-docs: ✓ Ready');
    expect(block).toContain('2 data sources');
    expect(block).toContain('16 indexed');
    // The full multi-line block is NOT rendered by default.
    expect(block).not.toContain('Documents:');
    expect(block).not.toContain('s3://bucket/docs/');
  });

  it('renders the full per-DS block when knowledgeBaseName matches', async () => {
    mockGetKnowledgeBase.mockResolvedValue({ knowledgeBaseId: 'KB1', status: 'ACTIVE' });
    mockGetLatestIngestionJob.mockResolvedValue({
      status: 'COMPLETE',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:05:00Z'),
      statistics: {
        numberOfDocumentsScanned: 10,
        numberOfNewDocumentsIndexed: 8,
        numberOfModifiedDocumentsIndexed: 0,
        numberOfDocumentsFailed: 0,
        numberOfDocumentsDeleted: 0,
      },
    });

    const result = await handleProjectStatus(makeKbContext(), { knowledgeBaseName: 'product-docs' });
    assert(result.success);

    const block = loggedLines.join('\n');
    // The full multi-line block IS rendered for the named KB.
    expect(block).toContain('Documents:');
    expect(block).toContain('s3://bucket/docs/');
    expect(block).toContain('s3://bucket/specs/');
  });

  it('marks data sources with no ingestion job as never run', async () => {
    mockGetKnowledgeBase.mockResolvedValue({ knowledgeBaseId: 'KB1', status: 'ACTIVE' });
    mockGetLatestIngestionJob.mockResolvedValue(null);

    // "never run" appears only in the full drill-down block.
    const result = await handleProjectStatus(makeKbContext(), { knowledgeBaseName: 'product-docs' });

    assert(result.success);
    expect(mockGetLatestIngestionJob).toHaveBeenCalledTimes(2);
    expect(loggedLines.join('\n')).toContain('Ingestion: never run');
  });

  it('flags KB as out of sync when the live KB is not found', async () => {
    mockGetKnowledgeBase.mockResolvedValue(null);

    const result = await handleProjectStatus(makeKbContext());

    assert(result.success);
    const kbEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'knowledge-base' && r.name === 'product-docs'
    );
    expect(kbEntry!.detail).toContain('out of sync');
    expect(mockGetLatestIngestionJob).not.toHaveBeenCalled();
  });

  it('sets error on KB when getKnowledgeBase throws', async () => {
    mockGetKnowledgeBase.mockRejectedValue(new Error('AccessDenied'));

    const result = await handleProjectStatus(makeKbContext());

    assert(result.success);
    const kbEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'knowledge-base' && r.name === 'product-docs'
    );
    expect(kbEntry!.error).toBe('AccessDenied');
  });
});

describe('buildRuntimeInvocationUrl', () => {
  it('constructs the correct invocation URL with encoded ARN', () => {
    const url = buildRuntimeInvocationUrl(
      'us-east-1',
      'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/travelplanner_FlightsMcp-abcdefgh'
    );
    expect(url).toBe(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Ftravelplanner_FlightsMcp-abcdefgh/invocations'
    );
  });

  it('handles different regions', () => {
    const url = buildRuntimeInvocationUrl(
      'eu-west-1',
      'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/my-agent-xyz'
    );
    expect(url).toBe(
      'https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aeu-west-1%3A111111111111%3Aruntime%2Fmy-agent-xyz/invocations'
    );
  });
});

describe('handleProjectStatus — invocation URL enrichment', () => {
  beforeEach(() => {
    mockGetAgentRuntimeStatus.mockReset();
    mockGetEvaluator.mockReset();
    mockGetOnlineEvaluationConfig.mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it('sets invocationUrl on deployed agents after runtime status enrichment', async () => {
    const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/proj_MyAgent-abc123';

    mockGetAgentRuntimeStatus.mockResolvedValue({
      runtimeId: 'proj_MyAgent-abc123',
      status: 'READY',
    });

    const ctx: StatusContext = {
      project: {
        ...baseProject,
        runtimes: [{ name: 'MyAgent' }],
      } as unknown as AgentCoreProjectSpec,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '123456789012' }],
      deployedState: {
        targets: {
          dev: {
            resources: {
              runtimes: {
                MyAgent: {
                  runtimeId: 'proj_MyAgent-abc123',
                  runtimeArn,
                  roleArn: 'arn:aws:iam::123456789012:role/test',
                },
              },
            },
          },
        },
      },
    } as unknown as StatusContext;

    const result = await handleProjectStatus(ctx);

    assert(result.success);
    const agentEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'agent' && r.name === 'MyAgent'
    );
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.invocationUrl).toBe(
      `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations`
    );
  });

  it('does not set invocationUrl on local-only agents', async () => {
    const ctx: StatusContext = {
      project: {
        ...baseProject,
        runtimes: [{ name: 'LocalAgent' }],
      } as unknown as AgentCoreProjectSpec,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '123456789012' }],
      deployedState: {
        targets: {
          dev: {
            resources: {},
          },
        },
      },
    } as unknown as StatusContext;

    const result = await handleProjectStatus(ctx);

    assert(result.success);
    const agentEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'agent' && r.name === 'LocalAgent'
    );
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.invocationUrl).toBeUndefined();
  });

  it('still sets invocationUrl when runtime status fetch fails', async () => {
    const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/proj_FailAgent-xyz';
    mockGetAgentRuntimeStatus.mockRejectedValue(new Error('Timeout'));

    const ctx: StatusContext = {
      project: {
        ...baseProject,
        runtimes: [{ name: 'FailAgent' }],
      } as unknown as AgentCoreProjectSpec,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '123456789012' }],
      deployedState: {
        targets: {
          dev: {
            resources: {
              runtimes: {
                FailAgent: {
                  runtimeId: 'proj_FailAgent-xyz',
                  runtimeArn,
                  roleArn: 'arn:aws:iam::123456789012:role/test',
                },
              },
            },
          },
        },
      },
    } as unknown as StatusContext;

    const result = await handleProjectStatus(ctx);

    assert(result.success);
    const agentEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'agent' && r.name === 'FailAgent'
    );
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.error).toBe('Timeout');
    expect(agentEntry!.invocationUrl).toBe(
      `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations`
    );
  });

  it('does not set invocationUrl on pending-removal agents', async () => {
    mockGetAgentRuntimeStatus.mockResolvedValue({
      runtimeId: 'proj_OldAgent-abc',
      status: 'READY',
    });

    const ctx: StatusContext = {
      project: {
        ...baseProject,
        runtimes: [],
      } as unknown as AgentCoreProjectSpec,
      awsTargets: [{ name: 'dev', region: 'us-east-1', account: '123456789012' }],
      deployedState: {
        targets: {
          dev: {
            resources: {
              runtimes: {
                OldAgent: {
                  runtimeId: 'proj_OldAgent-abc',
                  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/proj_OldAgent-abc',
                  roleArn: 'arn:aws:iam::123456789012:role/test',
                },
              },
            },
          },
        },
      },
    } as unknown as StatusContext;

    const result = await handleProjectStatus(ctx);

    assert(result.success);
    const agentEntry = result.resources.find(
      (r: ResourceStatusEntry) => r.resourceType === 'agent' && r.name === 'OldAgent'
    );
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.deploymentState).toBe('pending-removal');
    expect(agentEntry!.invocationUrl).toBeUndefined();
  });
});
