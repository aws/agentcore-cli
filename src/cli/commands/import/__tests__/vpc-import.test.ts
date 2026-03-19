/**
 * Test Group 5: VPC Agent Import
 *
 * Tests that the import flow correctly handles agents configured with VPC networking:
 * - YAML parsing of network_configuration with VPC mode
 * - toAgentEnvSpec sets networkMode and networkConfig correctly
 * - PUBLIC agents don't get networkConfig
 * - Edge cases: empty arrays, null network_mode_config
 * - Custom YAML parser handles nested list structures
 */
// We need to test the yaml-parser module. Since parseSimpleYaml is not exported,
// we test it through parseStarterToolkitYaml by writing temp files.
import { parseStarterToolkitYaml } from '../yaml-parser.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURES_DIR = path.join(__dirname, 'fixtures-vpc');

function writeFixture(name: string, content: string): string {
  const filePath = path.join(FIXTURES_DIR, name);
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  // Clean up fixtures
  if (fs.existsSync(FIXTURES_DIR)) {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// 1. YAML Parsing: VPC Config Extraction
// ============================================================================
describe('YAML parsing: VPC config extraction', () => {
  it('parses VPC agent with subnets and security_groups as arrays', () => {
    const filePath = writeFixture(
      'vpc-basic.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-abc123
            - subnet-def456
          security_groups:
            - sg-12345
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: VPCAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    expect(parsed.agents).toHaveLength(1);

    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('VPC');
    expect(agent.networkConfig).toBeDefined();
    expect(agent.networkConfig!.subnets).toEqual(['subnet-abc123', 'subnet-def456']);
    expect(agent.networkConfig!.securityGroups).toEqual(['sg-12345']);
  });

  it('parses PUBLIC agent without networkConfig', () => {
    const filePath = writeFixture(
      'public-basic.yaml',
      `default_agent: public_agent
agents:
  public_agent:
    name: public_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: PUBLIC
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: PUBAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    expect(parsed.agents).toHaveLength(1);

    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('PUBLIC');
    expect(agent.networkConfig).toBeUndefined();
  });

  it('defaults to PUBLIC when network_configuration is absent', () => {
    const filePath = writeFixture(
      'no-network.yaml',
      `default_agent: simple_agent
agents:
  simple_agent:
    name: simple_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
    bedrock_agentcore:
      agent_id: null
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('PUBLIC');
    expect(agent.networkConfig).toBeUndefined();
  });

  it('extracts physicalAgentId for VPC agents', () => {
    const filePath = writeFixture(
      'vpc-with-id.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-abc123
          security_groups:
            - sg-12345
    bedrock_agentcore:
      agent_id: VPCAGENT001
      agent_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/VPCAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.physicalAgentId).toBe('VPCAGENT001');
    expect(agent.physicalAgentArn).toBe('arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/VPCAGENT001');
  });
});

// ============================================================================
// 2. PUBLIC agents don't get networkConfig even if network_mode_config exists
// ============================================================================
describe('PUBLIC agents: no networkConfig even if network_mode_config present', () => {
  it('ignores network_mode_config for PUBLIC mode', () => {
    const filePath = writeFixture(
      'public-with-config.yaml',
      `default_agent: public_agent
agents:
  public_agent:
    name: public_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: PUBLIC
        network_mode_config:
          subnets:
            - subnet-abc123
          security_groups:
            - sg-12345
    bedrock_agentcore:
      agent_id: PUBAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('PUBLIC');
    // networkConfig should be undefined because networkMode is PUBLIC
    expect(agent.networkConfig).toBeUndefined();
  });
});

// ============================================================================
// 3. Edge Cases
// ============================================================================
describe('VPC edge cases', () => {
  it('VPC mode with empty subnets and security_groups keys (no list items)', () => {
    const filePath = writeFixture(
      'vpc-empty-arrays.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
          security_groups:
    bedrock_agentcore:
      agent_id: VPCAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('VPC');
    // networkModeConfig exists (it's an object, not null), so networkConfig should be set.
    expect(agent.networkConfig).toBeDefined();
    // After fix: Array.isArray guard ensures that when the YAML parser creates
    // empty objects {} (for keys with no list items), we fall back to [].
    expect(Array.isArray(agent.networkConfig!.subnets)).toBe(true);
    expect(agent.networkConfig!.subnets).toEqual([]);
    expect(Array.isArray(agent.networkConfig!.securityGroups)).toBe(true);
    expect(agent.networkConfig!.securityGroups).toEqual([]);
  });

  it('VPC mode with null network_mode_config', () => {
    const filePath = writeFixture(
      'vpc-null-config.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config: null
    bedrock_agentcore:
      agent_id: VPCAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('VPC');
    // network_mode_config is null, so networkConfig should be undefined
    expect(agent.networkConfig).toBeUndefined();
  });

  it('handles single subnet and single security group', () => {
    const filePath = writeFixture(
      'vpc-single.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-only1234
          security_groups:
            - sg-only5678
    bedrock_agentcore:
      agent_id: null
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('VPC');
    expect(agent.networkConfig).toBeDefined();
    expect(agent.networkConfig!.subnets).toEqual(['subnet-only1234']);
    expect(agent.networkConfig!.securityGroups).toEqual(['sg-only5678']);
  });

  it('handles many subnets and security groups', () => {
    const filePath = writeFixture(
      'vpc-many.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-aaa11111
            - subnet-bbb22222
            - subnet-ccc33333
          security_groups:
            - sg-xxx11111
            - sg-yyy22222
    bedrock_agentcore:
      agent_id: VPCAGENT999
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkConfig!.subnets).toEqual(['subnet-aaa11111', 'subnet-bbb22222', 'subnet-ccc33333']);
    expect(agent.networkConfig!.securityGroups).toEqual(['sg-xxx11111', 'sg-yyy22222']);
  });
});

// ============================================================================
// 4. Custom YAML parser: nested list structures
// ============================================================================
describe('Custom YAML parser: nested lists in objects', () => {
  it('parses subnets as string arrays, not objects or numbers', () => {
    const filePath = writeFixture(
      'type-check.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-abc123
            - subnet-def456
          security_groups:
            - sg-12345
    bedrock_agentcore:
      agent_id: null
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkConfig).toBeDefined();

    // Verify each element is a string (not parsed as number or object)
    for (const subnet of agent.networkConfig!.subnets) {
      expect(typeof subnet).toBe('string');
    }
    for (const sg of agent.networkConfig!.securityGroups) {
      expect(typeof sg).toBe('string');
    }
  });

  it('handles mixed VPC and PUBLIC agents in same config', () => {
    const filePath = writeFixture(
      'mixed-agents.yaml',
      `default_agent: public_agent
agents:
  public_agent:
    name: public_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: PUBLIC
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: PUB001
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-abc123
          security_groups:
            - sg-12345
      observability:
        enabled: false
    bedrock_agentcore:
      agent_id: VPC001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    expect(parsed.agents).toHaveLength(2);

    const publicAgent = parsed.agents.find(a => a.name === 'public_agent')!;
    const vpcAgent = parsed.agents.find(a => a.name === 'vpc_agent')!;

    expect(publicAgent.networkMode).toBe('PUBLIC');
    expect(publicAgent.networkConfig).toBeUndefined();

    expect(vpcAgent.networkMode).toBe('VPC');
    expect(vpcAgent.networkConfig).toBeDefined();
    expect(vpcAgent.networkConfig!.subnets).toEqual(['subnet-abc123']);
    expect(vpcAgent.networkConfig!.securityGroups).toEqual(['sg-12345']);

    // Also verify other fields are not cross-contaminated
    expect(publicAgent.enableOtel).toBe(true);
    expect(vpcAgent.enableOtel).toBe(false);
  });

  it('handles network_mode_config with quoted subnet values', () => {
    const filePath = writeFixture(
      'vpc-quoted.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - "subnet-abc123"
            - 'subnet-def456'
          security_groups:
            - "sg-12345"
    bedrock_agentcore:
      agent_id: null
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkConfig).toBeDefined();
    // Quoted values should have quotes stripped
    expect(agent.networkConfig!.subnets).toEqual(['subnet-abc123', 'subnet-def456']);
    expect(agent.networkConfig!.securityGroups).toEqual(['sg-12345']);
  });
});

// ============================================================================
// 5. toAgentEnvSpec: VPC config makes it into agentcore.json format
// ============================================================================
describe('toAgentEnvSpec: VPC config in final output', () => {
  it('VPC agent parsed result has correct structure for toAgentEnvSpec', () => {
    const filePath = writeFixture(
      'vpc-for-spec.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    deployment_type: container
    runtime_type: PYTHON_3_12
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-abc123
            - subnet-def456
          security_groups:
            - sg-12345
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: VPCAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;

    // Verify agent has all the fields that toAgentEnvSpec expects
    expect(agent.name).toBe('vpc_agent');
    expect(agent.entrypoint).toBe('main.py');
    expect(agent.build).toBe('Container');
    expect(agent.runtimeVersion).toBe('PYTHON_3_12');
    expect(agent.networkMode).toBe('VPC');
    expect(agent.networkConfig).toEqual({
      subnets: ['subnet-abc123', 'subnet-def456'],
      securityGroups: ['sg-12345'],
    });
    expect(agent.protocol).toBe('HTTP');
    expect(agent.enableOtel).toBe(true);
    expect(agent.physicalAgentId).toBe('VPCAGENT001');
  });

  it('PUBLIC agent parsed result has no networkConfig', () => {
    const filePath = writeFixture(
      'public-for-spec.yaml',
      `default_agent: public_agent
agents:
  public_agent:
    name: public_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: PUBAGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('PUBLIC');
    expect(agent.networkConfig).toBeUndefined();
  });
});

// ============================================================================
// 6. Starter Toolkit fixture format (real Pydantic model_dump output)
// ============================================================================
describe('Starter toolkit fixture format compatibility', () => {
  it('handles the exact format from a real starter toolkit YAML', () => {
    const filePath = writeFixture(
      'real-toolkit-format.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: agent.py
    deployment_type: container
    runtime_type: PYTHON_3_12
    platform: linux/amd64
    container_runtime: docker
    language: python
    aws:
      execution_role: arn:aws:iam::123456789012:role/TestRole
      execution_role_auto_create: true
      account: '123456789012'
      region: us-west-2
      ecr_repository: null
      ecr_auto_create: false
      s3_path: null
      s3_auto_create: false
      network_configuration:
        network_mode: VPC
        network_mode_config:
          security_groups:
            - sg-12345678
          subnets:
            - subnet-12345678
            - subnet-87654321
      protocol_configuration:
        server_protocol: HTTP
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: REALAGENT01
      agent_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/REALAGENT01
      agent_session_id: session-123
    memory:
      mode: STM_AND_LTM
      memory_id: MEM001
      memory_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/MEM001
      memory_name: vpc_agent_memory
      event_expiry_days: 30
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    expect(parsed.agents).toHaveLength(1);

    const agent = parsed.agents[0]!;
    expect(agent.networkMode).toBe('VPC');
    expect(agent.networkConfig).toBeDefined();
    expect(agent.networkConfig!.securityGroups).toEqual(['sg-12345678']);
    expect(agent.networkConfig!.subnets).toEqual(['subnet-12345678', 'subnet-87654321']);
    expect(agent.physicalAgentId).toBe('REALAGENT01');

    // Memory should also be parsed
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0]!.name).toBe('vpc_agent_memory');
    expect(parsed.memories[0]!.physicalMemoryId).toBe('MEM001');
  });

  it('handles security_groups listed before subnets', () => {
    const filePath = writeFixture(
      'sg-before-subnets.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          security_groups:
            - sg-first1234
          subnets:
            - subnet-second56
    bedrock_agentcore:
      agent_id: null
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkConfig).toBeDefined();
    expect(agent.networkConfig!.securityGroups).toEqual(['sg-first1234']);
    expect(agent.networkConfig!.subnets).toEqual(['subnet-second56']);
  });
});

// ============================================================================
// 7. YAML parser regression: edge cases for list handling
// ============================================================================
describe('YAML parser: list handling edge cases', () => {
  it('does not mistake subnet-xxx as a key:value pair (no colon in value)', () => {
    const filePath = writeFixture(
      'list-no-colon.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-abc123
          security_groups:
            - sg-12345
    bedrock_agentcore:
      agent_id: null
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkConfig!.subnets[0]).toBe('subnet-abc123');
    expect(typeof agent.networkConfig!.subnets[0]).toBe('string');
  });

  it('correctly parses VPC config followed by sibling keys at same level', () => {
    const filePath = writeFixture(
      'vpc-with-siblings.yaml',
      `default_agent: vpc_agent
agents:
  vpc_agent:
    name: vpc_agent
    entrypoint: main.py
    aws:
      account: '123456789012'
      region: us-west-2
      network_configuration:
        network_mode: VPC
        network_mode_config:
          subnets:
            - subnet-abc123
          security_groups:
            - sg-12345
      protocol_configuration:
        server_protocol: MCP
      observability:
        enabled: false
    bedrock_agentcore:
      agent_id: AGENT001
`
    );

    const parsed = parseStarterToolkitYaml(filePath);
    const agent = parsed.agents[0]!;
    expect(agent.networkConfig!.subnets).toEqual(['subnet-abc123']);
    expect(agent.networkConfig!.securityGroups).toEqual(['sg-12345']);
    expect(agent.protocol).toBe('MCP');
    expect(agent.enableOtel).toBe(false);
  });
});
