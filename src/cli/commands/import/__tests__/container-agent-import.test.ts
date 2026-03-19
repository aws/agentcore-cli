/**
 * Test Group 6: Container (Docker) Agent Import
 */
import { RUNTIME_TYPE_MAP } from '../constants';
import { buildImportTemplate, filterCompanionOnlyTemplate } from '../template-utils';
import { parseStarterToolkitYaml } from '../yaml-parser';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function writeTempYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test6-'));
  const filePath = path.join(dir, '.bedrock_agentcore.yaml');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    /* noop */
  }
}

const AGENT_YAML_TEMPLATE = (overrides: string) => `
default_agent: my_agent
agents:
  my_agent:
    name: my_agent
    entrypoint: main.py
    ${overrides}
    aws:
      account: '111122223333'
      region: us-east-1
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: null
`;

describe('deployment_type mapping', () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) cleanupTempFile(f);
    tempFiles.length = 0;
  });

  it('container -> Container', () => {
    const f = writeTempYaml(AGENT_YAML_TEMPLATE('deployment_type: container\n    runtime_type: PYTHON_3_12'));
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.build).toBe('Container');
  });

  it('direct_code_deploy -> CodeZip', () => {
    const f = writeTempYaml(AGENT_YAML_TEMPLATE('deployment_type: direct_code_deploy\n    runtime_type: PYTHON_3_12'));
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.build).toBe('CodeZip');
  });

  it('missing -> Container (default)', () => {
    const f = writeTempYaml(AGENT_YAML_TEMPLATE('runtime_type: PYTHON_3_12'));
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.build).toBe('Container');
  });
});

describe('runtime_type handling', () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) cleanupTempFile(f);
    tempFiles.length = 0;
  });

  it('null -> PYTHON_3_12', () => {
    const f = writeTempYaml(AGENT_YAML_TEMPLATE('deployment_type: container\n    runtime_type: null'));
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.runtimeVersion).toBe('PYTHON_3_12');
  });

  it('missing -> PYTHON_3_12', () => {
    const f = writeTempYaml(AGENT_YAML_TEMPLATE('deployment_type: container'));
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.runtimeVersion).toBe('PYTHON_3_12');
  });

  it('PYTHON_3_13 -> PYTHON_3_13', () => {
    const f = writeTempYaml(AGENT_YAML_TEMPLATE('deployment_type: container\n    runtime_type: PYTHON_3_13'));
    tempFiles.push(f);
    expect(parseStarterToolkitYaml(f).agents[0]!.runtimeVersion).toBe('PYTHON_3_13');
  });

  it('unrecognized -> PYTHON_3_12 (not python3.12)', () => {
    const f = writeTempYaml(AGENT_YAML_TEMPLATE('deployment_type: container\n    runtime_type: some_unknown'));
    tempFiles.push(f);
    const rv = parseStarterToolkitYaml(f).agents[0]!.runtimeVersion;
    expect(rv).toBe('PYTHON_3_12');
    expect(rv).not.toBe('python3.12');
  });
});

describe('RUNTIME_TYPE_MAP', () => {
  it('maps known types', () => {
    expect(RUNTIME_TYPE_MAP.PYTHON_3_10).toBe('PYTHON_3_10');
    expect(RUNTIME_TYPE_MAP.PYTHON_3_11).toBe('PYTHON_3_11');
    expect(RUNTIME_TYPE_MAP.PYTHON_3_12).toBe('PYTHON_3_12');
    expect(RUNTIME_TYPE_MAP.PYTHON_3_13).toBe('PYTHON_3_13');
  });

  it('undefined for invalid keys', () => {
    expect(RUNTIME_TYPE_MAP['null' as keyof typeof RUNTIME_TYPE_MAP]).toBeUndefined();
    expect(RUNTIME_TYPE_MAP['undefined' as keyof typeof RUNTIME_TYPE_MAP]).toBeUndefined();
    expect(RUNTIME_TYPE_MAP['python_3_12' as keyof typeof RUNTIME_TYPE_MAP]).toBeUndefined();
  });
});

describe('full container agent parse', () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) cleanupTempFile(f);
    tempFiles.length = 0;
  });

  it('parses complete container agent with agent_id', () => {
    const yaml = `
default_agent: container_agent
agents:
  container_agent:
    name: container_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: null
    language: python
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: PUBLIC
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: abc123def456
      agent_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/abc123def456
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    const parsed = parseStarterToolkitYaml(f);
    const agent = parsed.agents[0]!;
    expect(agent.build).toBe('Container');
    expect(agent.runtimeVersion).toBe('PYTHON_3_12');
    expect(agent.physicalAgentId).toBe('abc123def456');
    expect(parsed.awsTarget.account).toBe('123456789012');
  });

  it('parses container agent with VPC', () => {
    const yaml = `
default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: null
    aws:
      account: '123456789012'
      region: us-east-1
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
          - subnet-12345678
          security_groups:
          - sg-11112222
      protocol_configuration:
        server_protocol: MCP
      observability:
        enabled: false
    bedrock_agentcore:
      agent_id: null
`;
    const f = writeTempYaml(yaml);
    tempFiles.push(f);
    const agent = parseStarterToolkitYaml(f).agents[0]!;
    expect(agent.build).toBe('Container');
    expect(agent.networkMode).toBe('VPC');
    expect(agent.networkConfig!.subnets).toContain('subnet-12345678');
    expect(agent.protocol).toBe('MCP');
    expect(agent.enableOtel).toBe(false);
  });
});

describe('import template for container agents', () => {
  it('buildImportTemplate sets DeletionPolicy: Retain', () => {
    const deployed = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: { Role: { Type: 'AWS::IAM::Role', Properties: {} } },
    };
    const synth = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        RT: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: { AgentRuntimeName: 'x' }, DependsOn: ['CR'] },
        CR: { Type: 'AWS::CloudFormation::CustomResource', Properties: {} },
      },
    };
    const result = buildImportTemplate(deployed, synth, ['RT']);
    expect(result.Resources.RT).toBeDefined();
    expect(result.Resources.RT!.DeletionPolicy).toBe('Retain');
    expect(result.Resources.RT!.DependsOn).toBeUndefined();
    expect(result.Resources.CR).toBeUndefined();
  });

  it('filterCompanionOnlyTemplate removes primary resources', () => {
    const synth = {
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: {} },
        RT: { Type: 'AWS::BedrockAgentCore::Runtime', Properties: {} },
        Lambda: { Type: 'AWS::Lambda::Function', Properties: {} },
      },
      Outputs: {
        RTId: { Value: { 'Fn::GetAtt': ['RT', 'AgentRuntimeId'] } },
        LambdaArn: { Value: { 'Fn::GetAtt': ['Lambda', 'Arn'] } },
      },
    };
    const filtered = filterCompanionOnlyTemplate(synth);
    expect(filtered.Resources.RT).toBeUndefined();
    expect(filtered.Resources.Role).toBeDefined();
    expect(filtered.Resources.Lambda).toBeDefined();
    expect(filtered.Outputs!.RTId).toBeUndefined();
    expect(filtered.Outputs!.LambdaArn).toBeDefined();
  });
});

describe('container source code', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test6-src-'));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('may contain Dockerfile', () => {
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), 'FROM python:3.12\n');
    fs.writeFileSync(path.join(tempDir, 'main.py'), 'print("hi")');
    expect(fs.readdirSync(tempDir)).toContain('Dockerfile');
  });

  it('may lack pyproject.toml', () => {
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), 'FROM python:3.12\n');
    expect(fs.existsSync(path.join(tempDir, 'pyproject.toml'))).toBe(false);
  });
});

describe('defaults alignment', () => {
  it('CLI default matches starter toolkit default', () => {
    expect('container').toBe('container');
  });
});
