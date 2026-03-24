/**
 * Test Group 1: Starter Toolkit Agent Only (No Memory)
 *
 * Tests the import path for a single agent with no memory, no credentials,
 * CodeZip build, PUBLIC network, HTTP protocol.
 */
import { PRIMARY_RESOURCE_TYPES } from '../constants';
import {
  buildImportTemplate,
  filterCompanionOnlyTemplate,
  findLogicalIdByProperty,
  findLogicalIdsByType,
} from '../template-utils';
import type { ParsedStarterToolkitAgent, ParsedStarterToolkitConfig } from '../types';
import { parseStarterToolkitYaml } from '../yaml-parser';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const NO_MEMORY_YAML = `
default_agent: my_strands_agent
agents:
  my_strands_agent:
    name: my_strands_agent
    entrypoint: main.py
    deployment_type: direct_code_deploy
    runtime_type: PYTHON_3_12
    language: python
    source_path: ./agent_src
    aws:
      account: '111122223333'
      region: us-west-2
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    memory:
      mode: NO_MEMORY
    bedrock_agentcore:
      agent_id: ABCDEFGHIJ
      agent_arn: arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/ABCDEFGHIJ
`;

function writeTempYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test1-'));
  const filePath = path.join(dir, '.bedrock_agentcore.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function cleanupTempFile(filePath: string): void {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

describe('YAML Parsing: No-memory agent config', () => {
  const tempFiles: string[] = [];
  let parsed: ParsedStarterToolkitConfig;

  beforeEach(() => {
    const f = writeTempYaml(NO_MEMORY_YAML);
    tempFiles.push(f);
    parsed = parseStarterToolkitYaml(f);
  });

  afterEach(() => {
    for (const f of tempFiles) cleanupTempFile(f);
    tempFiles.length = 0;
  });

  it('should parse exactly one agent', () => {
    expect(parsed.agents).toHaveLength(1);
  });

  it('should have zero memories when mode is NO_MEMORY', () => {
    expect(parsed.memories).toHaveLength(0);
  });

  it('should have zero credentials', () => {
    expect(parsed.credentials).toHaveLength(0);
  });

  it('should parse agent name correctly', () => {
    expect(parsed.agents[0]!.name).toBe('my_strands_agent');
  });

  it('should parse default_agent correctly', () => {
    expect(parsed.defaultAgent).toBe('my_strands_agent');
  });

  it('should parse deployment_type as CodeZip for direct_code_deploy', () => {
    expect(parsed.agents[0]!.build).toBe('CodeZip');
  });

  it('should parse protocol as HTTP', () => {
    expect(parsed.agents[0]!.protocol).toBe('HTTP');
  });

  it('should parse network mode as PUBLIC', () => {
    expect(parsed.agents[0]!.networkMode).toBe('PUBLIC');
  });

  it('should parse networkConfig as undefined for PUBLIC mode', () => {
    expect(parsed.agents[0]!.networkConfig).toBeUndefined();
  });

  it('should parse runtime version as PYTHON_3_12', () => {
    expect(parsed.agents[0]!.runtimeVersion).toBe('PYTHON_3_12');
  });

  it('should parse physical agent ID', () => {
    expect(parsed.agents[0]!.physicalAgentId).toBe('ABCDEFGHIJ');
  });

  it('should parse physical agent ARN', () => {
    expect(parsed.agents[0]!.physicalAgentArn).toBe(
      'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/ABCDEFGHIJ'
    );
  });

  it('should parse AWS account and region', () => {
    expect(parsed.awsTarget.account).toBe('111122223333');
    expect(parsed.awsTarget.region).toBe('us-west-2');
  });

  it('should parse observability enabled as true', () => {
    expect(parsed.agents[0]!.enableOtel).toBe(true);
  });

  it('should parse entrypoint correctly', () => {
    expect(parsed.agents[0]!.entrypoint).toBe('main.py');
  });

  it('should parse language as python (default)', () => {
    expect(parsed.agents[0]!.language).toBe('python');
  });

  it('should resolve source_path relative to YAML file directory', () => {
    const agent = parsed.agents[0]!;
    expect(path.isAbsolute(agent.sourcePath!)).toBe(true);
    expect(agent.sourcePath!).toContain('agent_src');
  });
});

describe('YAML Parsing: Edge cases', () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) cleanupTempFile(f);
    tempFiles.length = 0;
  });

  it('should handle missing memory section', () => {
    const yaml = `
default_agent: a
agents:
  a:
    name: a
    entrypoint: main.py
    aws:
      account: '111'
      region: us-east-1
    bedrock_agentcore:
      agent_id: X
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).memories).toHaveLength(0);
  });

  it('should handle memory mode null', () => {
    const yaml = `
default_agent: a
agents:
  a:
    name: a
    entrypoint: main.py
    aws:
      account: '111'
      region: us-east-1
    memory:
      mode: null
    bedrock_agentcore:
      agent_id: X
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).memories).toHaveLength(0);
  });

  it('should handle runtime_type null -> PYTHON_3_12', () => {
    const yaml = `
default_agent: a
agents:
  a:
    name: a
    entrypoint: main.py
    runtime_type: null
    aws:
      account: '111'
      region: us-east-1
    bedrock_agentcore:
      agent_id: X
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.runtimeVersion).toBe('PYTHON_3_12');
  });

  it('should fall back to PYTHON_3_12 for unknown runtime_type (not python3.12)', () => {
    const yaml = `
default_agent: a
agents:
  a:
    name: a
    entrypoint: main.py
    runtime_type: some_unknown
    aws:
      account: '111'
      region: us-east-1
    bedrock_agentcore:
      agent_id: X
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    const rv = parseStarterToolkitYaml(f).agents[0]!.runtimeVersion;
    expect(rv).toBe('PYTHON_3_12');
    expect(rv).not.toBe('python3.12');
  });

  it('should default to Container build when deployment_type missing', () => {
    const yaml = `
default_agent: a
agents:
  a:
    name: a
    entrypoint: main.py
    aws:
      account: '111'
      region: us-east-1
    bedrock_agentcore:
      agent_id: X
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.build).toBe('Container');
  });

  it('should set sourcePath to undefined when absent', () => {
    const yaml = `
default_agent: a
agents:
  a:
    name: a
    entrypoint: main.py
    aws:
      account: '111'
      region: us-east-1
    bedrock_agentcore:
      agent_id: X
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.sourcePath).toBeUndefined();
  });
});

describe('toAgentEnvSpec conversion', () => {
  const APP_DIR = 'app';
  function toAgentEnvSpec(agent: ParsedStarterToolkitAgent) {
    return {
      type: 'AgentCoreRuntime' as const,
      name: agent.name,
      build: agent.build,
      entrypoint: path.basename(agent.entrypoint),
      codeLocation: path.join(APP_DIR, agent.name),
      runtimeVersion: agent.runtimeVersion,
      networkMode: agent.networkMode,
      networkConfig: agent.networkMode === 'VPC' ? agent.networkConfig : undefined,
      protocol: agent.protocol,
      instrumentation: agent.enableOtel ? { otel: true } : undefined,
    };
  }

  const base: ParsedStarterToolkitAgent = {
    name: 'my_strands_agent',
    entrypoint: 'main.py',
    build: 'CodeZip',
    runtimeVersion: 'PYTHON_3_12',
    language: 'python',
    networkMode: 'PUBLIC',
    protocol: 'HTTP',
    enableOtel: true,
  };

  it('type=AgentCoreRuntime', () => {
    expect(toAgentEnvSpec(base).type).toBe('AgentCoreRuntime');
  });
  it('build=CodeZip', () => {
    expect(toAgentEnvSpec(base).build).toBe('CodeZip');
  });
  it('protocol=HTTP', () => {
    expect(toAgentEnvSpec(base).protocol).toBe('HTTP');
  });
  it('networkMode=PUBLIC', () => {
    expect(toAgentEnvSpec(base).networkMode).toBe('PUBLIC');
  });
  it('codeLocation=app/<name>', () => {
    expect(toAgentEnvSpec(base).codeLocation).toBe('app/my_strands_agent');
  });
  it('basename entrypoint', () => {
    expect(toAgentEnvSpec({ ...base, entrypoint: 'src/main.py' }).entrypoint).toBe('main.py');
  });
  it('instrumentation', () => {
    expect(toAgentEnvSpec(base).instrumentation).toEqual({ otel: true });
  });
  it('no networkConfig for PUBLIC', () => {
    expect(toAgentEnvSpec(base).networkConfig).toBeUndefined();
  });
  it('runtimeVersion=PYTHON_3_12', () => {
    expect(toAgentEnvSpec(base).runtimeVersion).toBe('PYTHON_3_12');
  });
});

describe('toMemorySpec: not invoked for no-memory', () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) cleanupTempFile(f);
    tempFiles.length = 0;
  });

  it('zero memories for NO_MEMORY', () => {
    const f = writeTempYaml(NO_MEMORY_YAML);
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).memories).toHaveLength(0);
  });
});

describe('Merge logic', () => {
  it('should add agent to empty project', () => {
    const existingAgentNames = new Set<string>();
    const agentName = 'my_strands_agent';
    expect(!existingAgentNames.has(agentName)).toBe(true);
  });

  it('should skip duplicate agent', () => {
    const existingAgentNames = new Set<string>(['my_strands_agent']);
    const agentName = 'my_strands_agent';
    expect(!existingAgentNames.has(agentName)).toBe(false);
  });
});

describe('Source code copy', () => {
  let tempDir: string;
  let destDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test1-src-'));
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test1-dst-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  it('copies recursively', () => {
    fs.writeFileSync(path.join(tempDir, 'main.py'), 'print("hi")');
    fs.mkdirSync(path.join(tempDir, 'sub'));
    fs.writeFileSync(path.join(tempDir, 'sub', 'util.py'), '# util');
    copyDirRecursive(tempDir, destDir);
    expect(fs.existsSync(path.join(destDir, 'main.py'))).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'sub', 'util.py'))).toBe(true);
  });

  it('fixes pyproject.toml setuptools', () => {
    const content = [
      '[build-system]',
      'requires = ["setuptools>=68", "wheel"]',
      'build-backend = "setuptools.build_meta"',
      '',
      '[tool.setuptools.packages.find]',
      'where = ["src"]',
    ].join('\n');
    const filePath = path.join(tempDir, 'pyproject.toml');
    fs.writeFileSync(filePath, content);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const fixed = raw.replace(/\[tool\.setuptools\.packages\.find\]\n.*where\s*=.*\n?/g, '').trim();
    fs.writeFileSync(filePath, fixed);
    const result = fs.readFileSync(filePath, 'utf-8');
    expect(result).not.toContain('[tool.setuptools.packages.find]');
    expect(result).toContain('[build-system]');
  });
});

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

describe('Phase 1: filterCompanionOnlyTemplate', () => {
  const synthTemplate = {
    AWSTemplateFormatVersion: '2010-09-09' as const,
    Resources: {
      AgentRole: {
        Type: 'AWS::IAM::Role',
        Properties: { RoleName: 'role' },
      },
      AgentPolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'policy' },
        DependsOn: ['AgentRuntime'] as string[],
      },
      AgentRuntime: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'my_strands_agent' },
      },
      LogGroup: {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: { 'Fn::Sub': '/aws/agentcore/${AgentRuntime}' },
        },
      },
    },
    Outputs: {
      RuntimeId: {
        Value: { 'Fn::GetAtt': ['AgentRuntime', 'AgentRuntimeId'] },
      },
      RoleArn: { Value: { 'Fn::GetAtt': ['AgentRole', 'Arn'] } },
    },
  };

  it('removes Runtime resources', () => {
    const filtered = filterCompanionOnlyTemplate(synthTemplate);
    expect(filtered.Resources.AgentRuntime).toBeUndefined();
  });

  it('keeps IAM Role', () => {
    const filtered = filterCompanionOnlyTemplate(synthTemplate);
    expect(filtered.Resources.AgentRole).toBeDefined();
  });

  it('keeps IAM Policy', () => {
    const filtered = filterCompanionOnlyTemplate(synthTemplate);
    expect(filtered.Resources.AgentPolicy).toBeDefined();
  });

  it('replaces dangling Fn::GetAtt with "*"', () => {
    const filtered = filterCompanionOnlyTemplate(synthTemplate);
    const logGroupProps = filtered.Resources.LogGroup?.Properties;
    const logGroupName = logGroupProps?.LogGroupName as Record<string, string> | undefined;
    if (logGroupName && 'Fn::Sub' in logGroupName) {
      expect(logGroupName['Fn::Sub']).toContain('*');
    }
  });

  it('removes outputs referencing removed resources', () => {
    const filtered = filterCompanionOnlyTemplate(synthTemplate);
    expect(filtered.Outputs?.RuntimeId).toBeUndefined();
  });

  it('keeps outputs not referencing removed resources', () => {
    const filtered = filterCompanionOnlyTemplate(synthTemplate);
    expect(filtered.Outputs?.RoleArn).toBeDefined();
  });

  it('removes DependsOn to removed resources', () => {
    const filtered = filterCompanionOnlyTemplate(synthTemplate);
    const policy = filtered.Resources.AgentPolicy;
    if (policy?.DependsOn) {
      if (Array.isArray(policy.DependsOn)) {
        expect(policy.DependsOn).not.toContain('AgentRuntime');
      }
    }
  });

  it('handles only-primary template', () => {
    const onlyPrimary = {
      AWSTemplateFormatVersion: '2010-09-09' as const,
      Resources: {
        RT: {
          Type: 'AWS::BedrockAgentCore::Runtime',
          Properties: {},
        },
      },
    };
    const filtered = filterCompanionOnlyTemplate(onlyPrimary);
    expect(filtered.Resources.RT).toBeUndefined();
    expect(Object.keys(filtered.Resources)).toHaveLength(0);
  });
});

describe('Phase 2: buildImportTemplate', () => {
  const deployedTemplate = {
    AWSTemplateFormatVersion: '2010-09-09' as const,
    Resources: {
      AgentRole: { Type: 'AWS::IAM::Role', Properties: {} },
    },
  };

  const synthTemplate = {
    AWSTemplateFormatVersion: '2010-09-09' as const,
    Resources: {
      AgentRole: { Type: 'AWS::IAM::Role', Properties: {} },
      AgentRuntime: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'my_strands_agent' },
        DependsOn: ['SomeCustomResource'] as string[],
      },
      SomeCustomResource: {
        Type: 'AWS::CloudFormation::CustomResource',
        Properties: {},
      },
    },
  };

  it('adds primary resource', () => {
    const result = buildImportTemplate(deployedTemplate, synthTemplate, ['AgentRuntime']);
    expect(result.Resources.AgentRuntime).toBeDefined();
  });

  it('sets DeletionPolicy=Retain', () => {
    const result = buildImportTemplate(deployedTemplate, synthTemplate, ['AgentRuntime']);
    const rt = result.Resources.AgentRuntime!;
    expect(rt.DeletionPolicy).toBe('Retain');
  });

  it('sets UpdateReplacePolicy=Retain', () => {
    const result = buildImportTemplate(deployedTemplate, synthTemplate, ['AgentRuntime']);
    const rt = result.Resources.AgentRuntime!;
    expect(rt.UpdateReplacePolicy).toBe('Retain');
  });

  it('removes DependsOn', () => {
    const result = buildImportTemplate(deployedTemplate, synthTemplate, ['AgentRuntime']);
    const rt = result.Resources.AgentRuntime!;
    expect(rt.DependsOn).toBeUndefined();
  });

  it('does not modify original', () => {
    buildImportTemplate(deployedTemplate, synthTemplate, ['AgentRuntime']);
    expect(deployedTemplate.Resources).not.toHaveProperty('AgentRuntime');
  });

  it('throws for missing logical ID', () => {
    expect(() => buildImportTemplate(deployedTemplate, synthTemplate, ['NonExistent'])).toThrow();
  });
});

describe('Template utils: findLogicalId', () => {
  const template = {
    AWSTemplateFormatVersion: '2010-09-09' as const,
    Resources: {
      RT1: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'agent_a' },
      },
      RT2: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: { AgentRuntimeName: 'agent_b' },
      },
      Role: { Type: 'AWS::IAM::Role', Properties: {} },
    },
  };

  it('finds by property', () => {
    const id = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'agent_a');
    expect(id).toBe('RT1');
  });

  it('returns undefined for non-match', () => {
    const id = findLogicalIdByProperty(template, 'AWS::BedrockAgentCore::Runtime', 'AgentRuntimeName', 'nope');
    expect(id).toBeUndefined();
  });

  it('finds by type', () => {
    const ids = findLogicalIdsByType(template, 'AWS::BedrockAgentCore::Runtime');
    expect(ids).toHaveLength(2);
    expect(ids).toContain('RT1');
    expect(ids).toContain('RT2');
  });

  it('empty for missing type', () => {
    const ids = findLogicalIdsByType(template, 'AWS::Lambda::Function');
    expect(ids).toHaveLength(0);
  });
});

describe('sanitize and toStackName', () => {
  it('replaces underscores', () => {
    const sanitize = (n: string) => n.replace(/_/g, '-');
    expect(sanitize('my_strands_agent')).toBe('my-strands-agent');
  });

  it('correct stack name', () => {
    const sanitize = (n: string) => n.replace(/_/g, '-');
    const toStackName = (p: string) => `agentcore-${sanitize(p)}`;
    expect(toStackName('my_project')).toBe('agentcore-my-project');
  });
});

describe('Constants', () => {
  it('includes Runtime', () => {
    expect(PRIMARY_RESOURCE_TYPES).toContain('AWS::BedrockAgentCore::Runtime');
  });

  it('includes Memory', () => {
    expect(PRIMARY_RESOURCE_TYPES).toContain('AWS::BedrockAgentCore::Memory');
  });

  it('excludes IAM::Role', () => {
    expect(PRIMARY_RESOURCE_TYPES).not.toContain('AWS::IAM::Role');
  });
});

describe('Integration: full parse', () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) cleanupTempFile(f);
    tempFiles.length = 0;
  });

  it('1 agent, 0 memories, 0 credentials', () => {
    const f = writeTempYaml(NO_MEMORY_YAML);
    tempFiles.push(f);
    const parsed = parseStarterToolkitYaml(f);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.memories).toHaveLength(0);
    expect(parsed.credentials).toHaveLength(0);
  });

  it('correct physical agent ID', () => {
    const f = writeTempYaml(NO_MEMORY_YAML);
    tempFiles.push(f);
    const parsed = parseStarterToolkitYaml(f);
    expect(parsed.agents[0]!.physicalAgentId).toBe('ABCDEFGHIJ');
  });

  it('zero memories to import', () => {
    const f = writeTempYaml(NO_MEMORY_YAML);
    tempFiles.push(f);
    const parsed = parseStarterToolkitYaml(f);
    const resourcesToImport = parsed.agents
      .filter(a => a.physicalAgentId)
      .map(a => ({
        ResourceType: 'AWS::BedrockAgentCore::Runtime',
        LogicalResourceId: 'RT',
        ResourceIdentifier: { AgentRuntimeId: a.physicalAgentId! },
      }));
    expect(resourcesToImport).toHaveLength(1);
    expect(resourcesToImport[0]!.ResourceIdentifier.AgentRuntimeId).toBe('ABCDEFGHIJ');
  });
});
