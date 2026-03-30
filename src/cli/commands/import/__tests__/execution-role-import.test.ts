/**
 * Tests for execution role import from starter toolkit YAML.
 */
import type { AgentEnvSpec } from '../../../../schema/schemas/agent-env';
import type { ParsedStarterToolkitConfig } from '../types';
import { parseStarterToolkitYaml } from '../yaml-parser';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = 'app';

function toAgentEnvSpec(agent: ParsedStarterToolkitConfig['agents'][0]): AgentEnvSpec {
  const codeLocation = path.join(APP_DIR, agent.name);
  const entrypoint = path.basename(agent.entrypoint);
  const spec: AgentEnvSpec = {
    name: agent.name,
    build: agent.build,
    entrypoint: entrypoint as AgentEnvSpec['entrypoint'],
    codeLocation: codeLocation as AgentEnvSpec['codeLocation'],
    runtimeVersion: (agent.runtimeVersion ?? 'PYTHON_3_12') as AgentEnvSpec['runtimeVersion'],
    protocol: agent.protocol,
    networkMode: agent.networkMode,
    instrumentation: { enableOtel: agent.enableOtel },
  };
  if (agent.networkMode === 'VPC' && agent.networkConfig) {
    spec.networkConfig = agent.networkConfig;
  }
  if (agent.executionRoleArn) {
    spec.executionRoleArn = agent.executionRoleArn;
  }
  return spec;
}

const FIXTURE = path.join(__dirname, 'fixtures', 'agent-with-execution-role.yaml');
const FIXTURE_NO_ROLE = path.join(__dirname, 'fixtures', 'different-agent.yaml');

describe('parseStarterToolkitYaml: executionRoleArn', () => {
  it('extracts executionRoleArn from YAML with execution_role', () => {
    const parsed = parseStarterToolkitYaml(FIXTURE);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]!.executionRoleArn).toBe('arn:aws:iam::123456789012:role/StarterToolkitExecutionRole');
  });

  it('returns undefined executionRoleArn when execution_role is absent', () => {
    const parsed = parseStarterToolkitYaml(FIXTURE_NO_ROLE);
    expect(parsed.agents[0]!.executionRoleArn).toBeUndefined();
  });
});

describe('toAgentEnvSpec: executionRoleArn', () => {
  it('includes executionRoleArn in spec when present', () => {
    const parsed = parseStarterToolkitYaml(FIXTURE);
    const spec = toAgentEnvSpec(parsed.agents[0]!);
    expect(spec.executionRoleArn).toBe('arn:aws:iam::123456789012:role/StarterToolkitExecutionRole');
  });

  it('omits executionRoleArn from spec when absent', () => {
    const parsed = parseStarterToolkitYaml(FIXTURE_NO_ROLE);
    const spec = toAgentEnvSpec(parsed.agents[0]!);
    expect(spec.executionRoleArn).toBeUndefined();
  });
});
