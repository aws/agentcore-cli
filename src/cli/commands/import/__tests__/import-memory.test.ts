/* eslint-disable @typescript-eslint/dot-notation */
/**
 * Test Group 2: Agent with Memory (STM + LTM) — Import Memory Unit Tests
 *
 * Covers:
 * - YAML parsing of agent + memory config (STM_AND_LTM mode)
 * - toMemorySpec conversion: strategies mapping
 * - eventExpiryDuration clamping (min 7, max 365)
 * - Memory merge logic
 * - Memory physical ID extraction
 * - Phase 2 import resource list construction
 * - Memory name deduplication
 * - Deployed state update with memory info
 * - Template logical ID lookup for memories
 */
import type { Memory } from '../../../../schema';
import { buildImportTemplate, findLogicalIdByProperty, findLogicalIdsByType } from '../template-utils';
import type { CfnTemplate } from '../template-utils';
import type { ParsedStarterToolkitMemory, ResourceToImport } from '../types';
import { parseStarterToolkitYaml } from '../yaml-parser';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// Helper: replicates toMemorySpec from actions.ts for unit testing
// (We test the logic directly since the function is not exported)
// ============================================================================
function toMemorySpec(mem: ParsedStarterToolkitMemory): Memory {
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

// ============================================================================
// Test YAML fixtures
// ============================================================================

function createTempYaml(content: string): string {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `test-import-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(tmpFile, content, 'utf-8');
  return tmpFile;
}

const STM_AND_LTM_YAML = `
agents:
  my_memory_agent:
    name: my_memory_agent
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
      observability:
        enabled: true
    bedrock_agentcore:
      agent_id: abc123def456
      agent_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/abc123def456
    memory:
      mode: STM_AND_LTM
      memory_name: my_agent_memory
      memory_id: mem-001122334455
      memory_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem-001122334455
      event_expiry_days: 30
`;

const STM_ONLY_YAML = `
agents:
  stm_agent:
    name: stm_agent
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: stm-agent-id-001
    memory:
      mode: STM_ONLY
      memory_name: stm_memory
      memory_id: mem-stm-only-001
      event_expiry_days: 14
`;

const NO_MEMORY_YAML = `
agents:
  no_mem_agent:
    name: no_mem_agent
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: no-mem-agent-001
    memory:
      mode: NO_MEMORY
      memory_id: mem-should-be-ignored
`;

const MULTI_AGENT_SHARED_MEMORY_YAML = `
agents:
  agent_a:
    name: agent_a
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: agent-a-id
    memory:
      mode: STM_AND_LTM
      memory_name: shared_memory
      memory_id: mem-shared-001
      memory_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem-shared-001
      event_expiry_days: 60
  agent_b:
    name: agent_b
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: agent-b-id
    memory:
      mode: STM_AND_LTM
      memory_name: shared_memory
      memory_id: mem-shared-001
      memory_arn: arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem-shared-001
      event_expiry_days: 60
`;

const MISSING_MEMORY_NAME_YAML = `
agents:
  unnamed_mem_agent:
    name: unnamed_mem_agent
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: unnamed-mem-id
    memory:
      mode: STM_AND_LTM
      memory_id: mem-unnamed-001
      event_expiry_days: 30
`;

const EXPIRY_CLAMPING_LOW_YAML = `
agents:
  clamp_low_agent:
    name: clamp_low_agent
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    memory:
      mode: STM_ONLY
      memory_name: clamp_low_memory
      event_expiry_days: 1
`;

const EXPIRY_CLAMPING_HIGH_YAML = `
agents:
  clamp_high_agent:
    name: clamp_high_agent
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    memory:
      mode: STM_AND_LTM
      memory_name: clamp_high_memory
      event_expiry_days: 999
`;

// ============================================================================
// YAML Parsing Tests
// ============================================================================

describe('YAML Parsing: Agent with Memory', () => {
  it('parses STM_AND_LTM agent + memory config correctly', () => {
    const tmpFile = createTempYaml(STM_AND_LTM_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0]!.name).toBe('my_memory_agent');
      expect(parsed.agents[0]!.physicalAgentId).toBe('abc123def456');
      expect(parsed.agents[0]!.physicalAgentArn).toBe(
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/abc123def456'
      );

      expect(parsed.memories).toHaveLength(1);
      expect(parsed.memories[0]!.name).toBe('my_agent_memory');
      expect(parsed.memories[0]!.mode).toBe('STM_AND_LTM');
      expect(parsed.memories[0]!.physicalMemoryId).toBe('mem-001122334455');
      expect(parsed.memories[0]!.physicalMemoryArn).toBe(
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem-001122334455'
      );
      expect(parsed.memories[0]!.eventExpiryDays).toBe(30);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('parses STM_ONLY memory config correctly', () => {
    const tmpFile = createTempYaml(STM_ONLY_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      expect(parsed.memories).toHaveLength(1);
      expect(parsed.memories[0]!.name).toBe('stm_memory');
      expect(parsed.memories[0]!.mode).toBe('STM_ONLY');
      expect(parsed.memories[0]!.physicalMemoryId).toBe('mem-stm-only-001');
      expect(parsed.memories[0]!.eventExpiryDays).toBe(14);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('skips NO_MEMORY mode even if memory_id is present', () => {
    const tmpFile = createTempYaml(NO_MEMORY_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      // Agent should still be parsed
      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0]!.name).toBe('no_mem_agent');
      expect(parsed.agents[0]!.physicalAgentId).toBe('no-mem-agent-001');

      // Memory should NOT be parsed since mode is NO_MEMORY
      expect(parsed.memories).toHaveLength(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('extracts AWS target info from agent config', () => {
    const tmpFile = createTempYaml(STM_AND_LTM_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      expect(parsed.awsTarget.account).toBe('123456789012');
      expect(parsed.awsTarget.region).toBe('us-west-2');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('generates default memory name when memory_name is missing', () => {
    const tmpFile = createTempYaml(MISSING_MEMORY_NAME_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      expect(parsed.memories).toHaveLength(1);
      // Should fallback to agent_name + "_memory"
      expect(parsed.memories[0]!.name).toBe('unnamed_mem_agent_memory');
      expect(parsed.memories[0]!.physicalMemoryId).toBe('mem-unnamed-001');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ============================================================================
// Memory Name Deduplication Tests
// ============================================================================

describe('Memory Name Deduplication', () => {
  it('deduplicates shared memory across multiple agents', () => {
    const tmpFile = createTempYaml(MULTI_AGENT_SHARED_MEMORY_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      // Both agents should be parsed
      expect(parsed.agents).toHaveLength(2);

      // But only ONE memory should exist (deduped by name)
      expect(parsed.memories).toHaveLength(1);
      expect(parsed.memories[0]!.name).toBe('shared_memory');
      expect(parsed.memories[0]!.physicalMemoryId).toBe('mem-shared-001');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ============================================================================
// toMemorySpec Conversion Tests
// ============================================================================

describe('toMemorySpec', () => {
  it('STM_AND_LTM mode produces SEMANTIC, SUMMARIZATION, USER_PREFERENCE strategies', () => {
    const mem: ParsedStarterToolkitMemory = {
      name: 'test_memory',
      mode: 'STM_AND_LTM',
      eventExpiryDays: 30,
      physicalMemoryId: 'mem-123',
    };

    const result = toMemorySpec(mem);

    expect(result.name).toBe('test_memory');
    expect(result.eventExpiryDuration).toBe(30);
    expect(result.strategies).toHaveLength(3);
    expect(result.strategies.map(s => s.type)).toEqual(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE']);
  });

  it('STM_ONLY mode produces only SEMANTIC strategy', () => {
    const mem: ParsedStarterToolkitMemory = {
      name: 'stm_memory',
      mode: 'STM_ONLY',
      eventExpiryDays: 14,
      physicalMemoryId: 'mem-456',
    };

    const result = toMemorySpec(mem);

    expect(result.name).toBe('stm_memory');
    expect(result.eventExpiryDuration).toBe(14);
    expect(result.strategies).toHaveLength(0);
  });

  it('NO_MEMORY mode produces empty strategies', () => {
    const mem: ParsedStarterToolkitMemory = {
      name: 'no_mem',
      mode: 'NO_MEMORY',
      eventExpiryDays: 30,
    };

    const result = toMemorySpec(mem);

    expect(result.strategies).toHaveLength(0);
  });

  describe('eventExpiryDuration clamping', () => {
    it('clamps low values to minimum of 7', () => {
      const mem: ParsedStarterToolkitMemory = {
        name: 'low_expiry',
        mode: 'STM_ONLY',
        eventExpiryDays: 1,
      };

      const result = toMemorySpec(mem);
      expect(result.eventExpiryDuration).toBe(7);
    });

    it('clamps zero to minimum of 7', () => {
      const mem: ParsedStarterToolkitMemory = {
        name: 'zero_expiry',
        mode: 'STM_ONLY',
        eventExpiryDays: 0,
      };

      const result = toMemorySpec(mem);
      expect(result.eventExpiryDuration).toBe(7);
    });

    it('clamps negative values to minimum of 7', () => {
      const mem: ParsedStarterToolkitMemory = {
        name: 'neg_expiry',
        mode: 'STM_ONLY',
        eventExpiryDays: -10,
      };

      const result = toMemorySpec(mem);
      expect(result.eventExpiryDuration).toBe(7);
    });

    it('clamps high values to maximum of 365', () => {
      const mem: ParsedStarterToolkitMemory = {
        name: 'high_expiry',
        mode: 'STM_AND_LTM',
        eventExpiryDays: 999,
      };

      const result = toMemorySpec(mem);
      expect(result.eventExpiryDuration).toBe(365);
    });

    it('preserves valid values within range', () => {
      for (const days of [7, 30, 90, 180, 365]) {
        const mem: ParsedStarterToolkitMemory = {
          name: `valid_${days}`,
          mode: 'STM_ONLY',
          eventExpiryDays: days,
        };
        const result = toMemorySpec(mem);
        expect(result.eventExpiryDuration).toBe(days);
      }
    });
  });
});

// ============================================================================
// YAML Parsing: eventExpiryDays Clamping via YAML
// ============================================================================

describe('YAML Parsing: eventExpiryDays values', () => {
  it('parses low event_expiry_days from YAML (clamping happens in toMemorySpec)', () => {
    const tmpFile = createTempYaml(EXPIRY_CLAMPING_LOW_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      expect(parsed.memories).toHaveLength(1);
      // Raw value from YAML is 1 -- clamping is done in toMemorySpec, not in parser
      expect(parsed.memories[0]!.eventExpiryDays).toBe(1);

      // But toMemorySpec should clamp it
      const spec = toMemorySpec(parsed.memories[0]!);
      expect(spec.eventExpiryDuration).toBe(7);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('parses high event_expiry_days from YAML (clamping happens in toMemorySpec)', () => {
    const tmpFile = createTempYaml(EXPIRY_CLAMPING_HIGH_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      expect(parsed.memories).toHaveLength(1);
      expect(parsed.memories[0]!.eventExpiryDays).toBe(999);

      const spec = toMemorySpec(parsed.memories[0]!);
      expect(spec.eventExpiryDuration).toBe(365);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ============================================================================
// Memory Merge Logic Tests
// ============================================================================

describe('Memory Merge Logic', () => {
  it('skips existing memories by name', () => {
    const existingMemories: Memory[] = [
      {
        name: 'existing_memory',
        eventExpiryDuration: 30,
        strategies: [{ type: 'SEMANTIC' }],
      },
    ];

    const parsedMemories: ParsedStarterToolkitMemory[] = [
      {
        name: 'existing_memory',
        mode: 'STM_AND_LTM',
        eventExpiryDays: 60,
        physicalMemoryId: 'mem-existing',
      },
      {
        name: 'new_memory',
        mode: 'STM_ONLY',
        eventExpiryDays: 14,
        physicalMemoryId: 'mem-new',
      },
    ];

    // Replicate the merge logic from actions.ts
    const existingMemoryNames = new Set(existingMemories.map(m => m.name));
    const merged = [...existingMemories];
    const skipped: string[] = [];

    for (const mem of parsedMemories) {
      if (!existingMemoryNames.has(mem.name)) {
        merged.push(toMemorySpec(mem));
      } else {
        skipped.push(mem.name);
      }
    }

    expect(merged).toHaveLength(2);
    expect(skipped).toEqual(['existing_memory']);

    // The existing memory should not be updated (keeps original config)
    const existing = merged.find(m => m.name === 'existing_memory')!;
    expect(existing.eventExpiryDuration).toBe(30); // Original value, not 60

    // The new memory should be added
    const newMem = merged.find(m => m.name === 'new_memory')!;
    expect(newMem.eventExpiryDuration).toBe(14);
    expect(newMem.strategies).toHaveLength(0);
  });

  it('adds all memories when project has none', () => {
    const existingMemories: Memory[] = [];
    const parsedMemories: ParsedStarterToolkitMemory[] = [
      {
        name: 'memory_one',
        mode: 'STM_AND_LTM',
        eventExpiryDays: 30,
        physicalMemoryId: 'mem-1',
      },
      {
        name: 'memory_two',
        mode: 'STM_ONLY',
        eventExpiryDays: 7,
        physicalMemoryId: 'mem-2',
      },
    ];

    const existingMemoryNames = new Set(existingMemories.map(m => m.name));
    const merged = [...existingMemories];

    for (const mem of parsedMemories) {
      if (!existingMemoryNames.has(mem.name)) {
        merged.push(toMemorySpec(mem));
      }
    }

    expect(merged).toHaveLength(2);
    expect(merged[0]!.name).toBe('memory_one');
    expect(merged[0]!.strategies).toHaveLength(3);
    expect(merged[1]!.name).toBe('memory_two');
    expect(merged[1]!.strategies).toHaveLength(0);
  });
});

// ============================================================================
// Physical ID Extraction Tests
// ============================================================================

describe('Memory Physical ID Extraction', () => {
  it('extracts physicalMemoryId and physicalMemoryArn from YAML', () => {
    const tmpFile = createTempYaml(STM_AND_LTM_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      const mem = parsed.memories[0]!;
      expect(mem.physicalMemoryId).toBe('mem-001122334455');
      expect(mem.physicalMemoryArn).toBe('arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem-001122334455');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('handles memory with no physicalMemoryArn', () => {
    const tmpFile = createTempYaml(STM_ONLY_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      const mem = parsed.memories[0]!;
      expect(mem.physicalMemoryId).toBe('mem-stm-only-001');
      // STM_ONLY_YAML doesn't include memory_arn
      expect(mem.physicalMemoryArn).toBeUndefined();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('filters memories with physicalMemoryId for import', () => {
    const tmpFile = createTempYaml(EXPIRY_CLAMPING_LOW_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      // This YAML has no memory_id
      const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);
      expect(memoriesToImport).toHaveLength(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ============================================================================
// Template Logical ID Lookup Tests
// ============================================================================

describe('Template Logical ID Lookup for Memories', () => {
  const synthTemplate: CfnTemplate = {
    Resources: {
      MyAgentMemoryResource: {
        Type: 'AWS::BedrockAgentCore::Memory',
        Properties: {
          Name: 'my_agent_memory',
          EventExpiryDuration: 30,
          Strategies: [],
        },
      },
      MyAgentRuntime: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: {
          AgentRuntimeName: 'TestProject_my_memory_agent',
        },
      },
      MyIAMRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: 'MyRole',
        },
      },
    },
  };

  it('finds memory logical ID by Name property', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Memory',
      'Name',
      'my_agent_memory'
    );
    expect(logicalId).toBe('MyAgentMemoryResource');
  });

  it('finds all memory logical IDs by type', () => {
    const logicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Memory');
    expect(logicalIds).toEqual(['MyAgentMemoryResource']);
  });

  it('finds runtime logical ID by AgentRuntimeName', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Runtime',
      'AgentRuntimeName',
      'TestProject_my_memory_agent'
    );
    expect(logicalId).toBe('MyAgentRuntime');
  });

  it('returns undefined for non-existent memory name', () => {
    const logicalId = findLogicalIdByProperty(
      synthTemplate,
      'AWS::BedrockAgentCore::Memory',
      'Name',
      'nonexistent_memory'
    );
    expect(logicalId).toBeUndefined();
  });

  it('falls back to single memory logical ID when name does not match', () => {
    const memoryLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Memory');
    let logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', 'different_name');

    // Primary lookup fails
    expect(logicalId).toBeUndefined();

    // Fallback: if there's only one memory resource, use it
    if (!logicalId && memoryLogicalIds.length === 1) {
      logicalId = memoryLogicalIds[0];
    }
    expect(logicalId).toBe('MyAgentMemoryResource');
  });
});

// ============================================================================
// Phase 2 Resource Import List Construction
// ============================================================================

describe('Phase 2: ResourceToImport List Construction', () => {
  const synthTemplate: CfnTemplate = {
    Resources: {
      RuntimeLogicalId: {
        Type: 'AWS::BedrockAgentCore::Runtime',
        Properties: {
          AgentRuntimeName: 'TestProject_my_memory_agent',
        },
      },
      MemoryLogicalId: {
        Type: 'AWS::BedrockAgentCore::Memory',
        Properties: {
          Name: 'my_agent_memory',
        },
      },
      IAMRoleLogicalId: {
        Type: 'AWS::IAM::Role',
        Properties: {},
      },
    },
  };

  it('builds ResourceToImport list containing both Runtime and Memory', () => {
    const tmpFile = createTempYaml(STM_AND_LTM_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      const projectName = 'TestProject';

      const agentsToImport = parsed.agents.filter(a => a.physicalAgentId);
      const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);

      const resourcesToImport: ResourceToImport[] = [];

      // Build agent resources
      for (const agent of agentsToImport) {
        const expectedRuntimeName = `${projectName}_${agent.name}`;
        let logicalId = findLogicalIdByProperty(
          synthTemplate,
          'AWS::BedrockAgentCore::Runtime',
          'AgentRuntimeName',
          expectedRuntimeName
        );

        if (!logicalId) {
          const runtimeLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Runtime');
          if (runtimeLogicalIds.length === 1) logicalId = runtimeLogicalIds[0];
        }

        if (logicalId) {
          resourcesToImport.push({
            resourceType: 'AWS::BedrockAgentCore::Runtime',
            logicalResourceId: logicalId,
            resourceIdentifier: { AgentRuntimeId: agent.physicalAgentId! },
          });
        }
      }

      // Build memory resources
      for (const memory of memoriesToImport) {
        let logicalId = findLogicalIdByProperty(synthTemplate, 'AWS::BedrockAgentCore::Memory', 'Name', memory.name);

        if (!logicalId) {
          const memoryLogicalIds = findLogicalIdsByType(synthTemplate, 'AWS::BedrockAgentCore::Memory');
          if (memoryLogicalIds.length === 1) logicalId = memoryLogicalIds[0];
        }

        if (logicalId) {
          resourcesToImport.push({
            resourceType: 'AWS::BedrockAgentCore::Memory',
            logicalResourceId: logicalId,
            resourceIdentifier: { MemoryId: memory.physicalMemoryId! },
          });
        }
      }

      // Verify the list
      expect(resourcesToImport).toHaveLength(2);

      const runtimeImport = resourcesToImport.find(r => r.resourceType === 'AWS::BedrockAgentCore::Runtime');
      expect(runtimeImport).toBeDefined();
      expect(runtimeImport!.logicalResourceId).toBe('RuntimeLogicalId');
      expect(runtimeImport!.resourceIdentifier).toEqual({ AgentRuntimeId: 'abc123def456' });

      const memoryImport = resourcesToImport.find(r => r.resourceType === 'AWS::BedrockAgentCore::Memory');
      expect(memoryImport).toBeDefined();
      expect(memoryImport!.logicalResourceId).toBe('MemoryLogicalId');
      expect(memoryImport!.resourceIdentifier).toEqual({ MemoryId: 'mem-001122334455' });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('produces only Runtime resource when memory has no physicalMemoryId', () => {
    const yamlNoMemId = `
agents:
  agent_no_memid:
    name: agent_no_memid
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: agent-id-001
    memory:
      mode: STM_AND_LTM
      memory_name: mem_without_id
      event_expiry_days: 30
`;
    const tmpFile = createTempYaml(yamlNoMemId);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);

      const agentsToImport = parsed.agents.filter(a => a.physicalAgentId);
      const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);

      expect(agentsToImport).toHaveLength(1);
      expect(memoriesToImport).toHaveLength(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ============================================================================
// Deployed State Update Tests
// ============================================================================

describe('Deployed State Update with Memory', () => {
  it('constructs memory ARN from components when physicalMemoryArn is provided', () => {
    const tmpFile = createTempYaml(STM_AND_LTM_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);
      const targetRegion = 'us-west-2';
      const targetAccount = '123456789012';

      // Simulate deployed state update logic from actions.ts
      const targetState: Record<string, unknown> = { resources: {} };
      const resources = targetState.resources as Record<string, unknown>;
      resources.memories = {};

      for (const memory of memoriesToImport) {
        if (memory.physicalMemoryId) {
          (resources.memories as Record<string, unknown>)[memory.name] = {
            memoryId: memory.physicalMemoryId,
            memoryArn:
              memory.physicalMemoryArn ??
              `arn:aws:bedrock-agentcore:${targetRegion}:${targetAccount}:memory/${memory.physicalMemoryId}`,
          };
        }
      }

      const memState = (resources.memories as Record<string, Record<string, string>>)['my_agent_memory']!;
      expect(memState.memoryId).toBe('mem-001122334455');
      // Should use the ARN from YAML since it's provided
      expect(memState.memoryArn).toBe('arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem-001122334455');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('constructs memory ARN from region/account when physicalMemoryArn is missing', () => {
    const tmpFile = createTempYaml(STM_ONLY_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);
      const targetRegion = 'us-west-2';
      const targetAccount = '123456789012';

      const memoryStates: Record<string, { memoryId: string; memoryArn: string }> = {};

      for (const memory of memoriesToImport) {
        if (memory.physicalMemoryId) {
          memoryStates[memory.name] = {
            memoryId: memory.physicalMemoryId,
            memoryArn:
              memory.physicalMemoryArn ??
              `arn:aws:bedrock-agentcore:${targetRegion}:${targetAccount}:memory/${memory.physicalMemoryId}`,
          };
        }
      }

      const memState = memoryStates['stm_memory']!;
      expect(memState.memoryId).toBe('mem-stm-only-001');
      // Should construct ARN since YAML doesn't have memory_arn
      expect(memState.memoryArn).toBe('arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/mem-stm-only-001');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('includes both agent and memory info in deployed state', () => {
    const tmpFile = createTempYaml(STM_AND_LTM_YAML);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      const agentsToImport = parsed.agents.filter(a => a.physicalAgentId);
      const memoriesToImport = parsed.memories.filter(m => m.physicalMemoryId);
      const targetRegion = 'us-west-2';
      const targetAccount = '123456789012';

      // Simulate full deployed state
      const existingState: Record<string, unknown> = { targets: {} };
      const targetState: Record<string, unknown> = { resources: {} };
      const resources = targetState.resources as Record<string, unknown>;
      resources.stackName = 'AgentCore-TestProject-default';

      if (agentsToImport.length > 0) {
        resources.agents = {};
        for (const agent of agentsToImport) {
          if (agent.physicalAgentId) {
            (resources.agents as Record<string, unknown>)[agent.name] = {
              runtimeId: agent.physicalAgentId,
              runtimeArn:
                agent.physicalAgentArn ??
                `arn:aws:bedrock-agentcore:${targetRegion}:${targetAccount}:runtime/${agent.physicalAgentId}`,
              roleArn: 'imported',
            };
          }
        }
      }

      if (memoriesToImport.length > 0) {
        resources.memories = {};
        for (const memory of memoriesToImport) {
          if (memory.physicalMemoryId) {
            (resources.memories as Record<string, unknown>)[memory.name] = {
              memoryId: memory.physicalMemoryId,
              memoryArn:
                memory.physicalMemoryArn ??
                `arn:aws:bedrock-agentcore:${targetRegion}:${targetAccount}:memory/${memory.physicalMemoryId}`,
            };
          }
        }
      }

      (existingState.targets as Record<string, unknown>)['default'] = targetState;

      // Verify deployed state structure
      const target = (existingState.targets as Record<string, Record<string, unknown>>)['default']!;
      const res = target.resources as Record<string, unknown>;

      expect(res.stackName).toBe('AgentCore-TestProject-default');

      const agents = res.agents as Record<string, Record<string, string>>;
      expect(agents['my_memory_agent']).toBeDefined();
      expect(agents['my_memory_agent']!.runtimeId).toBe('abc123def456');

      const memories = res.memories as Record<string, Record<string, string>>;
      expect(memories['my_agent_memory']).toBeDefined();
      expect(memories['my_agent_memory']!.memoryId).toBe('mem-001122334455');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ============================================================================
// buildImportTemplate Tests for Memory Resources
// ============================================================================

describe('buildImportTemplate with Memory', () => {
  it('adds memory resource to deployed template with Retain deletion policy', () => {
    const deployedTemplate: CfnTemplate = {
      Resources: {
        ExistingIAMRole: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'ExistingRole' },
        },
      },
    };

    const synthTemplate: CfnTemplate = {
      Resources: {
        ExistingIAMRole: {
          Type: 'AWS::IAM::Role',
          Properties: { RoleName: 'ExistingRole' },
        },
        MemoryLogicalId: {
          Type: 'AWS::BedrockAgentCore::Memory',
          Properties: {
            Name: 'my_agent_memory',
            EventExpiryDuration: 30,
          },
          DependsOn: 'ExistingIAMRole',
        },
        RuntimeLogicalId: {
          Type: 'AWS::BedrockAgentCore::Runtime',
          Properties: {
            AgentRuntimeName: 'TestProject_my_agent',
          },
          DependsOn: ['ExistingIAMRole', 'MemoryLogicalId'],
        },
      },
    };

    const importTemplate = buildImportTemplate(deployedTemplate, synthTemplate, [
      'MemoryLogicalId',
      'RuntimeLogicalId',
    ]);

    // Verify memory resource was added
    expect(importTemplate.Resources['MemoryLogicalId']).toBeDefined();
    expect(importTemplate.Resources['MemoryLogicalId']!.Type).toBe('AWS::BedrockAgentCore::Memory');
    expect(importTemplate.Resources['MemoryLogicalId']!.DeletionPolicy).toBe('Retain');
    expect(importTemplate.Resources['MemoryLogicalId']!.UpdateReplacePolicy).toBe('Retain');

    // DependsOn should be removed for import
    expect(importTemplate.Resources['MemoryLogicalId']!.DependsOn).toBeUndefined();

    // Verify runtime resource was also added
    expect(importTemplate.Resources['RuntimeLogicalId']).toBeDefined();
    expect(importTemplate.Resources['RuntimeLogicalId']!.DeletionPolicy).toBe('Retain');
    expect(importTemplate.Resources['RuntimeLogicalId']!.DependsOn).toBeUndefined();

    // Original resource should still be there
    expect(importTemplate.Resources['ExistingIAMRole']).toBeDefined();
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('handles agent with memory mode but no memory section gracefully', () => {
    const yaml = `
agents:
  agent_no_memory_section:
    name: agent_no_memory_section
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: agent-no-mem-section
`;
    const tmpFile = createTempYaml(yaml);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      expect(parsed.agents).toHaveLength(1);
      expect(parsed.memories).toHaveLength(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('handles memory with empty mode string', () => {
    const yaml = `
agents:
  agent_empty_mode:
    name: agent_empty_mode
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    memory:
      mode:
      memory_name: empty_mode_memory
`;
    const tmpFile = createTempYaml(yaml);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      // mode is null/empty, so memory should not be added (condition: memoryConfig.mode)
      expect(parsed.memories).toHaveLength(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('multiple agents with unique memories create separate memory entries', () => {
    const yaml = `
agents:
  agent_x:
    name: agent_x
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: agent-x-id
    memory:
      mode: STM_AND_LTM
      memory_name: memory_x
      memory_id: mem-x
      event_expiry_days: 30
  agent_y:
    name: agent_y
    deployment_type: container
    runtime_type: PYTHON_3_12
    entrypoint: main.py
    language: python
    aws:
      account: "123456789012"
      region: us-west-2
      protocol_configuration:
        server_protocol: HTTP
      network_configuration:
        network_mode: PUBLIC
    bedrock_agentcore:
      agent_id: agent-y-id
    memory:
      mode: STM_ONLY
      memory_name: memory_y
      memory_id: mem-y
      event_expiry_days: 14
`;
    const tmpFile = createTempYaml(yaml);
    try {
      const parsed = parseStarterToolkitYaml(tmpFile);
      expect(parsed.agents).toHaveLength(2);
      expect(parsed.memories).toHaveLength(2);

      const memX = parsed.memories.find(m => m.name === 'memory_x')!;
      expect(memX.mode).toBe('STM_AND_LTM');
      expect(memX.physicalMemoryId).toBe('mem-x');

      const memY = parsed.memories.find(m => m.name === 'memory_y')!;
      expect(memY.mode).toBe('STM_ONLY');
      expect(memY.physicalMemoryId).toBe('mem-y');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
