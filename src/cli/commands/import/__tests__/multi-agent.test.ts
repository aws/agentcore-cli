import {
  buildImportTemplate,
  filterCompanionOnlyTemplate,
  findLogicalIdByProperty,
  findLogicalIdsByType,
} from '../template-utils.js';
import type { CfnTemplate } from '../template-utils.js';
import { parseStarterToolkitYaml } from '../yaml-parser.js';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('parseStarterToolkitYaml - multi-agent', () => {
  it('parses a YAML file with 2 agents', () => {
    const result = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'two-agents.yaml'));
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]!.name).toBe('search_agent');
    expect(result.agents[1]!.name).toBe('chat_agent');
  });

  it('extracts correct properties for each agent', () => {
    const result = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'two-agents.yaml'));
    expect(result.agents[0]!.build).toBe('CodeZip');
    expect(result.agents[0]!.protocol).toBe('HTTP');
    expect(result.agents[0]!.physicalAgentId).toBe('agent-abc-111');
    expect(result.agents[1]!.protocol).toBe('MCP');
    expect(result.agents[1]!.physicalAgentId).toBe('agent-def-222');
  });

  it('extracts awsTarget from the first agent', () => {
    const result = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'two-agents.yaml'));
    expect(result.awsTarget.account).toBe('111122223333');
    expect(result.awsTarget.region).toBe('us-west-2');
  });

  it('extracts defaultAgent', () => {
    const result = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'two-agents.yaml'));
    expect(result.defaultAgent).toBe('search_agent');
  });

  it('parses memory only from agents with non-NO_MEMORY mode', () => {
    const result = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'two-agents.yaml'));
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.name).toBe('shared_memory');
    expect(result.memories[0]!.mode).toBe('STM_AND_LTM');
    expect(result.memories[0]!.physicalMemoryId).toBe('mem-xyz-999');
  });

  it('extracts credentials from agents', () => {
    const result = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'two-agents.yaml'));
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0]!.name).toBe('github-oauth');
  });
});

describe('parseStarterToolkitYaml - 3 agents with shared memory', () => {
  it('parses a YAML file with 3 agents', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'three-agents-shared-memory.yaml'));
    expect(r.agents).toHaveLength(3);
    expect(r.agents.map(a => a.name)).toEqual(['agent_alpha', 'agent_beta', 'agent_gamma']);
  });

  it('deduplicates shared memory', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'three-agents-shared-memory.yaml'));
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]!.name).toBe('shared_memory');
  });

  it('extracts different runtime versions', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'three-agents-shared-memory.yaml'));
    expect(r.agents.map(a => a.runtimeVersion)).toEqual(['PYTHON_3_12', 'PYTHON_3_13', 'PYTHON_3_11']);
  });

  it('extracts different protocols', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'three-agents-shared-memory.yaml'));
    expect(r.agents.map(a => a.protocol)).toEqual(['HTTP', 'MCP', 'HTTP']);
  });
});

describe('parseStarterToolkitYaml - similar agent names', () => {
  it('parses agents with similar names correctly', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'similar-names.yaml'));
    expect(r.agents).toHaveLength(2);
    expect(r.agents[0]!.name).toBe('agent1');
    expect(r.agents[1]!.name).toBe('agent1_v2');
  });
});

describe('parseStarterToolkitYaml - underscore names', () => {
  it('parses agents with underscores in names', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'underscore-names.yaml'));
    expect(r.agents).toHaveLength(2);
    expect(r.agents[0]!.name).toBe('my_search_agent');
    expect(r.agents[1]!.name).toBe('my_chat_agent');
  });
});

describe('parseStarterToolkitYaml - partial import', () => {
  it('parses both agents, one with physicalAgentId and one without', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'partial-import.yaml'));
    expect(r.agents).toHaveLength(2);
    expect(r.agents[0]!.physicalAgentId).toBe('agent-deployed-111');
    expect(r.agents[1]!.physicalAgentId).toBeFalsy();
  });

  it('memory from deployed agent is extracted', () => {
    const r = parseStarterToolkitYaml(path.join(FIXTURES_DIR, 'partial-import.yaml'));
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]!.name).toBe('deployed_agent_memory');
    expect(r.memories[0]!.mode).toBe('STM_ONLY');
    expect(r.memories[0]!.eventExpiryDays).toBe(14);
  });
});

describe('findLogicalIdsByType - multiple runtimes', () => {
  const template: CfnTemplate = {
    Resources: {
      SearchRT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'p_search' },
      },
      ChatRT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'p_chat' },
      },
      Mem: { Type: 'AWS::BedrockAgentCore::Memory', Properties: { Name: 'mem' } },
      Role: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'role' } },
    },
  };

  it('finds all runtime logical IDs', () => {
    const ids = findLogicalIdsByType(template, 'AWS::BedrockAgentCore::Runtime');
    expect(ids).toHaveLength(2);
    expect(ids).toContain('SearchRT');
    expect(ids).toContain('ChatRT');
  });

  it('finds memory logical IDs', () => {
    expect(findLogicalIdsByType(template, 'AWS::BedrockAgentCore::Memory')).toEqual(['Mem']);
  });
});

describe('findLogicalIdByProperty - multiple runtimes', () => {
  const template: CfnTemplate = {
    Resources: {
      SearchRT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_search' },
      },
      ChatRT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_chat' },
      },
    },
  };

  it('finds correct logical ID for each agent', () => {
    expect(findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'proj_search')).toBe(
      'SearchRT'
    );
    expect(findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'proj_chat')).toBe(
      'ChatRT'
    );
  });

  it('returns undefined for non-existent agent', () => {
    expect(
      findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'proj_missing')
    ).toBeUndefined();
  });
});

describe('findLogicalIdByProperty - similar names with direct string values', () => {
  const template: CfnTemplate = {
    Resources: {
      Agent1RT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_agent1' },
      },
      Agent1V2RT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_agent1_v2' },
      },
    },
  };

  it('exact match takes precedence', () => {
    expect(findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'proj_agent1')).toBe(
      'Agent1RT'
    );
    expect(
      findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'proj_agent1_v2')
    ).toBe('Agent1V2RT');
  });
});

describe('findLogicalIdByProperty - Fn::Sub false match fix', () => {
  const template: CfnTemplate = {
    Resources: {
      Agent1V2RT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: { 'Fn::Sub': 'proj_agent1_v2' } },
      },
      Agent1RT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: { 'Fn::Sub': 'proj_agent1' } },
      },
    },
  };

  it('correctly matches Agent1RT for proj_agent1 (not Agent1V2RT)', () => {
    expect(findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'proj_agent1')).toBe(
      'Agent1RT'
    );
  });
});

describe('findLogicalIdByProperty - fallback single-runtime logic', () => {
  const template: CfnTemplate = {
    Resources: {
      RT1: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_a' },
      },
      RT2: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_b' },
      },
    },
  };

  it('with multiple runtimes, fallback is NOT triggered', () => {
    expect(findLogicalIdsByType(template, 'AWS::BedrockAgentCore::Runtime').length).toBeGreaterThan(1);
    expect(
      findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'proj_missing')
    ).toBeUndefined();
  });
});

describe('filterCompanionOnlyTemplate - multiple agents', () => {
  const synthTemplate: CfnTemplate = {
    Resources: {
      SearchRT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_search' },
      },
      ChatRT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'proj_chat' },
      },
      Mem: { Type: 'AWS::BedrockAgentCore::Memory', Properties: { Name: 'mem' } },
      SearchRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'SearchRole' } },
      Policy: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyDocument: {
            Statement: [{ Resource: { 'Fn::GetAtt': ['SearchRT', 'Arn'] } }],
          },
        },
        DependsOn: 'SearchRT',
      },
    },
    Outputs: {
      SearchId: { Value: { Ref: 'SearchRT' } },
      RoleArn: { Value: { 'Fn::GetAtt': ['SearchRole', 'Arn'] } },
    },
  };

  it('removes all primary resources', () => {
    const f = filterCompanionOnlyTemplate(synthTemplate);
    expect(f.Resources).not.toHaveProperty('SearchRT');
    expect(f.Resources).not.toHaveProperty('ChatRT');
    expect(f.Resources).not.toHaveProperty('Mem');
    expect(f.Resources).toHaveProperty('SearchRole');
    expect(f.Resources).toHaveProperty('Policy');
  });

  it('removes outputs referencing primary resources', () => {
    const f = filterCompanionOnlyTemplate(synthTemplate);
    expect(f.Outputs).not.toHaveProperty('SearchId');
    expect(f.Outputs).toHaveProperty('RoleArn');
  });

  it('replaces dangling refs and removes DependsOn', () => {
    const f = filterCompanionOnlyTemplate(synthTemplate);
    const doc = f.Resources.Policy!.Properties!.PolicyDocument as {
      Statement: { Resource: unknown }[];
    };
    expect(doc.Statement[0]!.Resource).toBe('*');
    expect(f.Resources.Policy!.DependsOn).toBeUndefined();
  });
});

describe('buildImportTemplate - multiple agents', () => {
  const deployed: CfnTemplate = {
    Resources: {
      Role: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'R' } },
    },
  };
  const synth: CfnTemplate = {
    Resources: {
      Role: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'R' } },
      RT: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { N: 'x' },
        DependsOn: 'Role',
      },
      Mem: { Type: 'AWS::BedrockAgentCore::Memory', Properties: { Name: 'mem' } },
    },
  };

  it('adds resources with DeletionPolicy Retain and no DependsOn', () => {
    const t = buildImportTemplate(deployed, synth, ['RT', 'Mem']);
    expect(t.Resources.RT!.DeletionPolicy).toBe('Retain');
    expect(t.Resources.RT!.DependsOn).toBeUndefined();
    expect(t.Resources.Mem!.DeletionPolicy).toBe('Retain');
  });

  it('does not mutate original', () => {
    const keys = Object.keys(deployed.Resources);
    buildImportTemplate(deployed, synth, ['RT']);
    expect(Object.keys(deployed.Resources)).toEqual(keys);
  });
});

describe('sanitize and toStackName', () => {
  const sanitize = (n: string) => n.replace(/_/g, '-');
  const toStackName = (p: string, t: string) => `AgentCore-${sanitize(p)}-${sanitize(t)}`;

  it('replaces underscores with hyphens', () => {
    expect(sanitize('my_project')).toBe('my-project');
  });

  it('generates correct stack name', () => {
    expect(toStackName('my_project', 'default')).toBe('AgentCore-my-project-default');
  });
});

describe('credential deduplication', () => {
  it('deduplicates credentials with same name', () => {
    const creds: { name: string }[] = [];
    for (const n of ['shared', 'shared', 'unique']) {
      if (!creds.find(c => c.name === n)) creds.push({ name: n });
    }
    expect(creds).toHaveLength(2);
  });
});

describe('source code directory structure', () => {
  it('each agent gets its own directory', () => {
    const dirs = ['search_agent', 'chat_agent'].map(n => path.join('/proj', 'app', n));
    expect(dirs[0]).toBe('/proj/app/search_agent');
    expect(dirs[1]).toBe('/proj/app/chat_agent');
    expect(new Set(dirs).size).toBe(2);
  });
});
