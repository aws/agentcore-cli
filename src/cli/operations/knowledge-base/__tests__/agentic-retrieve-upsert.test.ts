import type { AgentCoreProjectSpec } from '../../../../schema';
import { upsertAgenticRetrieveTarget } from '../agentic-retrieve-upsert';
import { describe, expect, it } from 'vitest';

type Gateway = AgentCoreProjectSpec['agentCoreGateways'][number];

function makeGateway(name = 'main-gw'): Gateway {
  return {
    name,
    targets: [],
    authorizerType: 'NONE',
    enableSemanticSearch: true,
    exceptionLevel: 'NONE',
  } as unknown as Gateway;
}

describe('upsertAgenticRetrieveTarget', () => {
  it('creates a new agentic-retrieve target on first call', () => {
    const gw = makeGateway();
    upsertAgenticRetrieveTarget(gw, 'kb-1');
    expect(gw.targets).toHaveLength(1);
    const target = gw.targets[0];
    expect(target?.name).toBe('main-gw-agentic');
    expect(target?.targetType).toBe('connector');
    expect(target?.connectorId).toBe('bedrock-agentic-retrieve');
    expect(target?.knowledgeBaseIds).toEqual(['kb-1']);
  });

  it('appends to an existing agentic-retrieve target', () => {
    const gw = makeGateway();
    upsertAgenticRetrieveTarget(gw, 'kb-1');
    upsertAgenticRetrieveTarget(gw, 'kb-2');
    expect(gw.targets).toHaveLength(1);
    expect(gw.targets[0]?.knowledgeBaseIds).toEqual(['kb-1', 'kb-2']);
  });

  it('is idempotent — re-adding the same kb is a no-op', () => {
    const gw = makeGateway();
    upsertAgenticRetrieveTarget(gw, 'kb-1');
    upsertAgenticRetrieveTarget(gw, 'kb-1');
    expect(gw.targets).toHaveLength(1);
    expect(gw.targets[0]?.knowledgeBaseIds).toEqual(['kb-1']);
  });

  it('respects a hand-renamed agentic target and only appends', () => {
    const gw = makeGateway();
    gw.targets.push({
      name: 'custom-name',
      targetType: 'connector',
      connectorId: 'bedrock-agentic-retrieve',
      knowledgeBaseIds: ['existing-kb'],
    } as unknown as Gateway['targets'][number]);

    upsertAgenticRetrieveTarget(gw, 'new-kb');
    expect(gw.targets).toHaveLength(1);
    expect(gw.targets[0]?.name).toBe('custom-name');
    expect(gw.targets[0]?.knowledgeBaseIds).toEqual(['existing-kb', 'new-kb']);
  });
});
