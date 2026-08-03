import { AgentCoreProjectSpecSchema, AgentCoreRegionSchema } from '../../../schema';
import { LLM_CONTEXT_FILES } from '../schema-assets';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

function projectSpecFields(source: string): string[] {
  const match = /interface AgentCoreProjectSpec \{([\s\S]*?)\n\}/.exec(source);
  if (!match?.[1]) {
    throw new Error('Missing AgentCoreProjectSpec interface');
  }

  return [...match[1].matchAll(/^ {2}([$A-Za-z_][$\w]*)\??:/gm)].map(field => field[1]!);
}

describe('LLM_CONTEXT_FILES', () => {
  it('vends only the current project context files', () => {
    expect(Object.keys(LLM_CONTEXT_FILES).sort()).toEqual(['README.md', 'agentcore.ts', 'aws-targets.ts']);
    expect(LLM_CONTEXT_FILES['README.md']).not.toContain('mcp.ts');
  });

  it('documents every supported agentcore.json top-level field', () => {
    const jsonSchema = z.toJSONSchema(AgentCoreProjectSpecSchema, { target: 'draft-07' });
    const schemaFields = Object.keys(jsonSchema.properties ?? {}).filter(field => field !== 'httpGateways');

    expect(projectSpecFields(LLM_CONTEXT_FILES['agentcore.ts']!)).toEqual(schemaFields);
  });

  it('documents every supported AgentCore region', () => {
    const regionSource = LLM_CONTEXT_FILES['aws-targets.ts']!;
    const regionType = /type AgentCoreRegion =([\s\S]*?);/.exec(regionSource)?.[1];
    const documentedRegions = [...(regionType ?? '').matchAll(/'([^']+)'/g)].map(match => match[1]);

    expect(documentedRegions).toEqual(AgentCoreRegionSchema.options);
  });
});
