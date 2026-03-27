/**
 * Test Group 3: CLI-Native Create with Memory, Then Import Over It
 */
import type { AgentCoreProjectSpec, Credential, Memory } from '../../../../schema';
import type { AgentEnvSpec } from '../../../../schema/schemas/agent-env';
import type { ParsedStarterToolkitConfig } from '../types';
import { parseStarterToolkitYaml } from '../yaml-parser';
import * as fs from 'node:fs';
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
  return spec;
}

function toMemorySpec(mem: ParsedStarterToolkitConfig['memories'][0]): Memory {
  const strategies: Memory['strategies'] = [];
  if (mem.mode === 'STM_AND_LTM') {
    strategies.push({ type: 'SEMANTIC' });
    strategies.push({ type: 'SUMMARIZATION' });
    strategies.push({ type: 'USER_PREFERENCE' });
  }
  return {
    name: mem.name,
    eventExpiryDuration: Math.max(7, Math.min(365, mem.eventExpiryDays)),
    strategies,
  };
}

function toCredentialSpec(cred: ParsedStarterToolkitConfig['credentials'][0]): Credential {
  return { authorizerType: 'ApiKeyCredentialProvider', name: cred.name };
}

function simulateMerge(
  projectSpec: AgentCoreProjectSpec,
  parsed: ParsedStarterToolkitConfig
): { messages: string[]; projectSpec: AgentCoreProjectSpec } {
  const messages: string[] = [];
  const onProgress = (msg: string) => messages.push(msg);
  const existingAgentNames = new Set(projectSpec.agents.map(a => a.name));
  for (const agent of parsed.agents) {
    if (!existingAgentNames.has(agent.name)) {
      projectSpec.agents.push(toAgentEnvSpec(agent));
    } else {
      onProgress(`Skipping agent "${agent.name}" (already exists in project)`);
    }
  }
  const existingMemoryNames = new Set((projectSpec.memories ?? []).map(m => m.name));
  for (const mem of parsed.memories) {
    if (!existingMemoryNames.has(mem.name)) {
      (projectSpec.memories ??= []).push(toMemorySpec(mem));
    } else {
      onProgress(`Skipping memory "${mem.name}" (already exists in project)`);
    }
  }
  const existingCredentialNames = new Set((projectSpec.credentials ?? []).map(c => c.name));
  for (const cred of parsed.credentials) {
    if (!existingCredentialNames.has(cred.name)) {
      (projectSpec.credentials ??= []).push(toCredentialSpec(cred));
      onProgress(`Added credential "${cred.name}" (${cred.providerType})`);
    } else {
      onProgress(`Skipping credential "${cred.name}" (already exists in project)`);
    }
  }
  return { messages, projectSpec };
}

const FIXTURES = path.join(__dirname, 'fixtures');
const CLI_PROJECT_PATH = path.join(FIXTURES, 'cli-project-with-agent-and-memory.json');
const DIFFERENT_AGENT_YAML = path.join(FIXTURES, 'different-agent.yaml');
const SAME_NAME_AGENT_YAML = path.join(FIXTURES, 'same-name-agent.yaml');

function loadCliProjectSpec(): AgentCoreProjectSpec {
  const content = fs.readFileSync(CLI_PROJECT_PATH, 'utf-8');
  return JSON.parse(content) as AgentCoreProjectSpec;
}

describe('parseStarterToolkitYaml', () => {
  it('parses a different-agent YAML', () => {
    const parsed = parseStarterToolkitYaml(DIFFERENT_AGENT_YAML);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]!.name).toBe('new_toolkit_agent');
    expect(parsed.agents[0]!.physicalAgentId).toBe('AGENT_NEW_123');
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0]!.name).toBe('new_toolkit_memory');
    expect(parsed.credentials).toHaveLength(1);
    expect(parsed.credentials[0]!.name).toBe('new_api_key_cred');
  });
  it('parses a same-name-agent YAML', () => {
    const parsed = parseStarterToolkitYaml(SAME_NAME_AGENT_YAML);
    expect(parsed.agents[0]!.name).toBe('existing_agent');
    expect(parsed.agents[0]!.physicalAgentId).toBe('AGENT_EXISTING_999');
  });
});

describe('merge: agent deduplication', () => {
  it('adds agent with different name', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(DIFFERENT_AGENT_YAML);
    const { projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.agents).toHaveLength(2);
  });
  it('skips agent with same name', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(SAME_NAME_AGENT_YAML);
    const { messages, projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.agents).toHaveLength(1);
    expect(messages).toContain('Skipping agent "existing_agent" (already exists in project)');
  });
  it('preserves original config when skipping', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(SAME_NAME_AGENT_YAML);
    const { projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.agents[0]!.networkMode).toBe('PUBLIC');
    expect(merged.agents[0]!.protocol).toBe('HTTP');
  });
});

describe('merge: memory deduplication', () => {
  it('adds memory with different name', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(DIFFERENT_AGENT_YAML);
    const { projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.memories).toHaveLength(2);
  });
  it('skips memory with same name', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(SAME_NAME_AGENT_YAML);
    const { messages } = simulateMerge(projectSpec, parsed);
    expect(messages).toContain('Skipping memory "existing_agent_memory" (already exists in project)');
  });
});

describe('merge: credential deduplication', () => {
  it('adds credential with different name', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(DIFFERENT_AGENT_YAML);
    const { projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.credentials).toHaveLength(2);
  });
  it('skips credential with same name', () => {
    const projectSpec = loadCliProjectSpec();
    projectSpec.credentials.push({ authorizerType: 'ApiKeyCredentialProvider', name: 'new_api_key_cred' });
    const parsed = parseStarterToolkitYaml(DIFFERENT_AGENT_YAML);
    const { messages } = simulateMerge(projectSpec, parsed);
    expect(messages).toContain('Skipping credential "new_api_key_cred" (already exists in project)');
  });
});

describe('merge: combined', () => {
  it('merging different agent produces combined projectSpec', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(DIFFERENT_AGENT_YAML);
    const { projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.agents).toHaveLength(2);
    expect(merged.memories).toHaveLength(2);
    expect(merged.credentials).toHaveLength(2);
  });
  it('handles undefined memories', () => {
    const projectSpec = loadCliProjectSpec();
    delete (projectSpec as Record<string, unknown>).memories;
    const parsed = parseStarterToolkitYaml(DIFFERENT_AGENT_YAML);
    const { projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.memories).toHaveLength(1);
  });
});

describe('source copy skip logic', () => {
  it('identifies agents to skip', () => {
    const projectSpec = loadCliProjectSpec();
    const existingAgentNames = new Set(projectSpec.agents.map(a => a.name));
    expect(existingAgentNames.has(parseStarterToolkitYaml(SAME_NAME_AGENT_YAML).agents[0]!.name)).toBe(true);
    expect(existingAgentNames.has(parseStarterToolkitYaml(DIFFERENT_AGENT_YAML).agents[0]!.name)).toBe(false);
  });
});

describe('toMemorySpec', () => {
  it('clamps below 7', () => {
    const mem: ParsedStarterToolkitConfig['memories'][0] = { name: 't', mode: 'STM_ONLY', eventExpiryDays: 1 };
    expect(toMemorySpec(mem).eventExpiryDuration).toBe(7);
  });
  it('clamps above 365', () => {
    const mem: ParsedStarterToolkitConfig['memories'][0] = { name: 't', mode: 'STM_ONLY', eventExpiryDays: 999 };
    expect(toMemorySpec(mem).eventExpiryDuration).toBe(365);
  });
});

describe('edge cases', () => {
  it('dedup is name-only', () => {
    const projectSpec = loadCliProjectSpec();
    const parsed = parseStarterToolkitYaml(SAME_NAME_AGENT_YAML);
    const { messages } = simulateMerge(projectSpec, parsed);
    expect(messages.find(m => m.includes('Skipping agent'))).toBeDefined();
  });
  it('merge is append-only', () => {
    const projectSpec = loadCliProjectSpec();
    const n = projectSpec.agents.length;
    const parsed = parseStarterToolkitYaml(SAME_NAME_AGENT_YAML);
    const { projectSpec: merged } = simulateMerge(projectSpec, parsed);
    expect(merged.agents.length).toBeGreaterThanOrEqual(n);
  });
});
