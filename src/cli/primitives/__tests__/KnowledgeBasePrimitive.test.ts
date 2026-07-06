import type { AgentCoreProjectSpec } from '../../../schema';
import { KnowledgeBasePrimitive } from '../KnowledgeBasePrimitive';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function emptyProject(): AgentCoreProjectSpec {
  return {
    version: '1.0',
    name: 'TestProj',
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    policyEngines: [],
    datasets: [],
    agentCoreGateways: [],
    knowledgeBases: [],
  } as unknown as AgentCoreProjectSpec;
}

function makePrimitive(initial: AgentCoreProjectSpec) {
  const primitive = new KnowledgeBasePrimitive();
  let project = initial;
  vi.spyOn(
    primitive as unknown as { readProjectSpec: () => Promise<AgentCoreProjectSpec> },
    'readProjectSpec'
  ).mockImplementation(() => Promise.resolve(project));
  vi.spyOn(
    primitive as unknown as { writeProjectSpec: (p: AgentCoreProjectSpec) => Promise<void> },
    'writeProjectSpec'
  ).mockImplementation((p: AgentCoreProjectSpec) => {
    project = p;
    return Promise.resolve();
  });
  return { primitive, getProject: () => project };
}

/**
 * Like makePrimitive, but also points configIO.getConfigRoot() at a real
 * temp `<projectRoot>/agentcore` dir so materializeConnectorConfig can copy
 * connector-config files into `<projectRoot>/app/<kb>/`.
 */
function makePrimitiveWithProjectDir(initial: AgentCoreProjectSpec) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kb-prim-'));
  const configRoot = join(projectRoot, 'agentcore');
  const base = makePrimitive(initial);
  // configIO is a protected readonly field; spy on its getConfigRoot.
  vi.spyOn(
    (base.primitive as unknown as { configIO: { getConfigRoot: () => string } }).configIO,
    'getConfigRoot'
  ).mockReturnValue(configRoot);
  return { ...base, projectRoot, configRoot };
}

describe('add knowledge-base — non-S3 connectors', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeConfig(dir: string, name: string, body: Record<string, unknown>): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(body));
    return p;
  }

  it('adds a WEB data source from a connector-config file and copies it under app/<kb>/', async () => {
    const { primitive, getProject, projectRoot } = makePrimitiveWithProjectDir(emptyProject());
    tmpDirs.push(projectRoot);
    const webCfg = writeConfig(projectRoot, 'web.json', {
      type: 'WEB',
      connectionConfiguration: { authType: 'NO_AUTH' },
    });

    const result = await primitive.add({
      name: 'web-docs',
      dataSourceType: 'web-crawler',
      connectorConfig: [webCfg],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    const kb = getProject().knowledgeBases[0];
    expect(kb?.dataSources).toEqual([{ type: 'WEB', connectorConfigFile: 'app/web-docs/web.json' }]);
    expect(existsSync(join(projectRoot, 'app', 'web-docs', 'web.json'))).toBe(true);
  });

  it('warns when an auth connector config has no secretArn but still succeeds', async () => {
    const { primitive, getProject, projectRoot } = makePrimitiveWithProjectDir(emptyProject());
    tmpDirs.push(projectRoot);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const confCfg = writeConfig(projectRoot, 'confluence.json', {
      type: 'CONFLUENCE',
      connectionConfiguration: {},
    });

    const result = await primitive.add({
      name: 'conf-docs',
      dataSourceType: 'confluence',
      connectorConfig: [confCfg],
    });

    expect(result.success).toBe(true);
    expect(getProject().knowledgeBases).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/secretArn/i);
  });

  it('rejects --connector-config when data-source-type is s3', async () => {
    const { primitive } = makePrimitive(emptyProject());
    const r = await primitive.add({ name: 'kb', dataSourceType: 's3', connectorConfig: ['/tmp/x.json'] });
    expect(r.success).toBe(false);
  });

  it('rejects --source when data-source-type is non-S3', async () => {
    const { primitive } = makePrimitive(emptyProject());
    const r = await primitive.add({ name: 'kb', dataSourceType: 'web-crawler', source: ['s3://b/'] });
    expect(r.success).toBe(false);
  });

  it('errors when the connector config type disagrees with --data-source-type', async () => {
    const { primitive, projectRoot } = makePrimitiveWithProjectDir(emptyProject());
    tmpDirs.push(projectRoot);
    const cfg = writeConfig(projectRoot, 'mismatch.json', {
      type: 'CONFLUENCE',
      connectionConfiguration: {},
    });
    const r = await primitive.add({
      name: 'kb',
      dataSourceType: 'web-crawler',
      connectorConfig: [cfg],
    });
    expect(r.success).toBe(false);
    // No file should have been copied since validation failed.
    expect(existsSync(join(projectRoot, 'app'))).toBe(false);
  });

  it('rejects two connector configs with the same basename and copies nothing', async () => {
    const { primitive, getProject, projectRoot } = makePrimitiveWithProjectDir(emptyProject());
    tmpDirs.push(projectRoot);
    const dirA = join(projectRoot, 'a');
    const dirB = join(projectRoot, 'b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const aPath = writeConfig(dirA, 'web.json', {
      type: 'WEB',
      connectionConfiguration: { authType: 'NO_AUTH' },
    });
    const bPath = writeConfig(dirB, 'web.json', {
      type: 'WEB',
      connectionConfiguration: { authType: 'NO_AUTH' },
    });

    const result = await primitive.add({
      name: 'kb',
      dataSourceType: 'web-crawler',
      connectorConfig: [aPath, bPath],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/web\.json|collision|would both be stored/i);
    // No copy happened, and the spec was not mutated.
    expect(existsSync(join(projectRoot, 'app', 'kb', 'web.json'))).toBe(false);
    expect(existsSync(join(projectRoot, 'app', 'kb'))).toBe(false);
    expect(getProject().knowledgeBases).toHaveLength(0);
  });

  it('appends a different connector config to an existing connector KB and copies it', async () => {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'conf-docs',
        dataSources: [{ type: 'CONFLUENCE', connectorConfigFile: 'app/conf-docs/confluence.json' }],
      },
    ] as unknown as AgentCoreProjectSpec['knowledgeBases'];
    const { primitive, getProject, projectRoot } = makePrimitiveWithProjectDir(initial);
    tmpDirs.push(projectRoot);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg2 = writeConfig(projectRoot, 'confluence2.json', {
      type: 'CONFLUENCE',
      connectionConfiguration: {},
    });

    const result = await primitive.add({
      name: 'conf-docs',
      dataSourceType: 'confluence',
      connectorConfig: [cfg2],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.appended).toBe(true);
    expect(existsSync(join(projectRoot, 'app', 'conf-docs', 'confluence2.json'))).toBe(true);
    expect(getProject().knowledgeBases[0]?.dataSources).toHaveLength(2);
    // CONFLUENCE without secretArn warns.
    expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/secretArn/i);
  });

  it('suppresses the secretArn warning under --json', async () => {
    const { primitive, projectRoot } = makePrimitiveWithProjectDir(emptyProject());
    tmpDirs.push(projectRoot);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = writeConfig(projectRoot, 'confluence.json', {
      type: 'CONFLUENCE',
      connectionConfiguration: {},
    });

    const result = await primitive.add({
      name: 'conf-docs',
      dataSourceType: 'confluence',
      connectorConfig: [cfg],
      json: true,
    });

    expect(result.success).toBe(true);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toMatch(/secretArn/i);
  });

  it('keeps a connector config already inside app/<kb>/ in place', async () => {
    const { primitive, getProject, projectRoot } = makePrimitiveWithProjectDir(emptyProject());
    tmpDirs.push(projectRoot);
    const destDir = join(projectRoot, 'app', 'web-docs');
    rmSync(destDir, { recursive: true, force: true });
    // Place the config directly where materialize would copy it.
    mkdirSync(destDir, { recursive: true });
    const inPlace = writeConfig(destDir, 'web.json', {
      type: 'WEB',
      connectionConfiguration: { authType: 'NO_AUTH' },
    });

    const result = await primitive.add({
      name: 'web-docs',
      dataSourceType: 'web-crawler',
      connectorConfig: [inPlace],
    });

    expect(result.success).toBe(true);
    const kb = getProject().knowledgeBases[0];
    expect(kb?.dataSources).toEqual([{ type: 'WEB', connectorConfigFile: 'app/web-docs/web.json' }]);
    expect(readFileSync(inPlace, 'utf-8')).toContain('NO_AUTH');
  });
});

describe('KnowledgeBasePrimitive — add (new KB)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a new KB entry when the name does not exist', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());

    const result = await primitive.add({
      name: 'product-docs',
      source: ['s3://my-bucket/docs/'],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.knowledgeBaseName).toBe('product-docs');
    expect(result.appended).toBe(false);

    const kbs = getProject().knowledgeBases;
    expect(kbs).toHaveLength(1);
    expect(kbs[0]?.name).toBe('product-docs');
    expect(kbs[0]?.dataSources).toEqual([{ type: 'S3', uri: 's3://my-bucket/docs/' }]);
  });

  it('accepts multiple --source flags on first invocation', async () => {
    const { primitive, getProject } = makePrimitive(emptyProject());
    const result = await primitive.add({
      name: 'docs',
      source: ['s3://my-bucket/a/', 's3://my-bucket/b/'],
    });
    expect(result.success).toBe(true);
    expect(getProject().knowledgeBases[0]?.dataSources).toHaveLength(2);
  });

  it('rejects when neither --source nor --connector-config is provided', async () => {
    const { primitive } = makePrimitive(emptyProject());
    const result = await primitive.add({ name: 'empty' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/at least one --source is required/i);
  });

  it('rejects --connector-config when the data source type defaults to s3', async () => {
    const { primitive } = makePrimitive(emptyProject());
    const result = await primitive.add({
      name: 'kb',
      connectorConfig: ['./confluence.json'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/only valid for non-S3/i);
  });

  it('rejects an invalid S3 URI', async () => {
    const { primitive } = makePrimitive(emptyProject());
    const result = await primitive.add({
      name: 'kb',
      source: ['https://example.com/docs'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/Invalid S3 URI/i);
  });

  it('rejects duplicate --source URIs within the same invocation', async () => {
    const { primitive } = makePrimitive(emptyProject());
    const result = await primitive.add({
      name: 'docs',
      source: ['s3://my-bucket/a/', 's3://my-bucket/a/'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/Duplicate data source in this invocation/i);
  });
});

describe('KnowledgeBasePrimitive — add (idempotent append)', () => {
  afterEach(() => vi.restoreAllMocks());

  function withExisting() {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
      },
    ];
    return makePrimitive(initial);
  }

  it('appends a new data source to an existing KB', async () => {
    const { primitive, getProject } = withExisting();
    const result = await primitive.add({
      name: 'docs',
      source: ['s3://my-bucket/c/'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.appended).toBe(true);
    expect(result.newDataSources).toEqual(['s3://my-bucket/c/']);

    const kb = getProject().knowledgeBases[0];
    expect(kb?.dataSources).toHaveLength(2);
    expect(kb?.dataSources.map(ds => (ds.type === 'S3' ? ds.uri : ds.connectorConfigFile))).toEqual([
      's3://my-bucket/a/',
      's3://my-bucket/c/',
    ]);
  });

  it('errors on duplicate URI', async () => {
    const { primitive } = withExisting();
    const result = await primitive.add({
      name: 'docs',
      source: ['s3://my-bucket/a/'],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/already exists on knowledge-base/i);
  });

  it('errors when neither --source nor --connector-config given on re-invocation', async () => {
    const { primitive } = withExisting();
    const result = await primitive.add({ name: 'docs' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/at least one --source/i);
  });

  it('errors when description differs', async () => {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        description: 'Original description',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
      },
    ];
    const { primitive } = makePrimitive(initial);
    const result = await primitive.add({
      name: 'docs',
      source: ['s3://my-bucket/c/'],
      description: 'Different description',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/update operations are not supported/i);
  });

  it('preserves existing description if not provided', async () => {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        description: 'Original',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
      },
    ];
    const { primitive, getProject } = makePrimitive(initial);
    const result = await primitive.add({ name: 'docs', source: ['s3://my-bucket/c/'] });
    expect(result.success).toBe(true);
    expect(getProject().knowledgeBases[0]?.description).toBe('Original');
  });

  it('treats empty-string description on append as a no-op', async () => {
    const { primitive, getProject } = withExisting();
    const result = await primitive.add({
      name: 'docs',
      source: ['s3://my-bucket/c/'],
      description: '',
    });
    expect(result.success).toBe(true);
    expect(getProject().knowledgeBases[0]?.description).toBeUndefined();
  });
});

describe('KnowledgeBasePrimitive — remove', () => {
  afterEach(() => vi.restoreAllMocks());

  function withTwoKbs() {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
      },
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'compliance',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/c/' }],
      },
    ];
    return makePrimitive(initial);
  }

  it('removes the named KB and leaves others intact', async () => {
    const { primitive, getProject } = withTwoKbs();
    const result = await primitive.remove('docs');
    expect(result.success).toBe(true);
    expect(getProject().knowledgeBases.map(kb => kb.name)).toEqual(['compliance']);
  });

  it('returns failure when KB not found', async () => {
    const { primitive } = withTwoKbs();
    const result = await primitive.remove('nonexistent');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/not found/i);
  });

  it('previewRemove returns a schema diff', async () => {
    const { primitive } = withTwoKbs();
    const preview = await primitive.previewRemove('docs');
    expect(preview.summary[0]).toMatch(/Removing knowledge base: docs/);
    expect(preview.schemaChanges).toHaveLength(1);
    expect(preview.schemaChanges[0]?.file).toBe('agentcore/agentcore.json');
  });

  it('previewRemove throws when KB not found', async () => {
    const { primitive } = withTwoKbs();
    await expect(primitive.previewRemove('nonexistent')).rejects.toThrow(/not found/i);
  });

  it('getRemovable lists all KBs', async () => {
    const { primitive } = withTwoKbs();
    const removables = await primitive.getRemovable();
    expect(removables.map(r => r.name)).toEqual(['docs', 'compliance']);
  });

  it('addScreen returns null (no TUI in Wave 1)', () => {
    const primitive = new KnowledgeBasePrimitive();
    expect(primitive.addScreen()).toBeNull();
  });

  it('cascade-prunes the removed KB out of the gateway agentic-retrieve target', async () => {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
        gateway: 'main-gw',
      },
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'hr',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/b/' }],
        gateway: 'main-gw',
      },
    ];
    initial.agentCoreGateways.push({
      name: 'main-gw',
      targets: [
        {
          name: 'docs',
          targetType: 'connector',
          connectorId: 'bedrock-knowledge-bases',
          configurations: [
            { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' }, parameterOverrides: [] },
            {
              name: 'AgenticRetrieveStream',
              parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'docs' } } }] },
              parameterOverrides: [],
            },
          ],
        },
        {
          name: 'hr',
          targetType: 'connector',
          connectorId: 'bedrock-knowledge-bases',
          configurations: [
            { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'hr' }, parameterOverrides: [] },
            {
              name: 'AgenticRetrieveStream',
              parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'hr' } } }] },
              parameterOverrides: [],
            },
          ],
        },
      ],
      authorizerType: 'NONE',
      enableSemanticSearch: true,
      exceptionLevel: 'NONE',
    } as unknown as AgentCoreProjectSpec['agentCoreGateways'][0]);
    const { primitive, getProject } = makePrimitive(initial);

    const result = await primitive.remove('docs');
    expect(result.success).toBe(true);

    const targets = getProject().agentCoreGateways[0]?.targets ?? [];
    // Per-KB target gone; hr target remains.
    expect(targets.find(t => t.name === 'docs')).toBeUndefined();
    const hr = targets.find(t => t.name === 'hr');
    expect(hr).toBeDefined();
    const agenticCfg = (hr?.configurations ?? []).find(c => c.name === 'AgenticRetrieveStream');
    const retrievers = (agenticCfg?.parameterValues as any)?.retrievers as any[];
    expect(retrievers?.map((r: any) => r.configuration.knowledgeBase.knowledgeBaseId)).toEqual(['hr']);
  });

  it('removes the connector target entirely when the removed KB was the only one', async () => {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
        gateway: 'main-gw',
      },
    ];
    initial.agentCoreGateways.push({
      name: 'main-gw',
      targets: [
        {
          name: 'docs',
          targetType: 'connector',
          connectorId: 'bedrock-knowledge-bases',
          configurations: [
            { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' }, parameterOverrides: [] },
            {
              name: 'AgenticRetrieveStream',
              parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'docs' } } }] },
              parameterOverrides: [],
            },
          ],
        },
      ],
      authorizerType: 'NONE',
      enableSemanticSearch: true,
      exceptionLevel: 'NONE',
    } as unknown as AgentCoreProjectSpec['agentCoreGateways'][0]);
    const { primitive, getProject } = makePrimitive(initial);

    const result = await primitive.remove('docs');
    expect(result.success).toBe(true);

    const targets = getProject().agentCoreGateways[0]?.targets ?? [];
    expect(targets).toHaveLength(0);
  });

  it('previewRemove summarizes removal of the KB target', async () => {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
        gateway: 'main-gw',
      },
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'hr',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/b/' }],
        gateway: 'main-gw',
      },
    ];
    initial.agentCoreGateways.push({
      name: 'main-gw',
      targets: [
        {
          name: 'docs',
          targetType: 'connector',
          connectorId: 'bedrock-knowledge-bases',
          configurations: [
            { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' }, parameterOverrides: [] },
            {
              name: 'AgenticRetrieveStream',
              parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'docs' } } }] },
              parameterOverrides: [],
            },
          ],
        },
        {
          name: 'hr',
          targetType: 'connector',
          connectorId: 'bedrock-knowledge-bases',
          configurations: [
            { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'hr' }, parameterOverrides: [] },
            {
              name: 'AgenticRetrieveStream',
              parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'hr' } } }] },
              parameterOverrides: [],
            },
          ],
        },
      ],
      authorizerType: 'NONE',
      enableSemanticSearch: true,
      exceptionLevel: 'NONE',
    } as unknown as AgentCoreProjectSpec['agentCoreGateways'][0]);
    const { primitive } = makePrimitive(initial);

    const preview = await primitive.previewRemove('docs');
    const lines = preview.summary.join('\n');
    expect(lines).toMatch(/Gateway target: 'docs' on 'main-gw' will be removed/);
  });

  it('previewRemove notes when the last KB target will be removed', async () => {
    const initial = emptyProject();
    initial.knowledgeBases = [
      {
        type: 'AgentCoreKnowledgeBase',
        name: 'docs',
        dataSources: [{ type: 'S3', uri: 's3://my-bucket/a/' }],
        gateway: 'main-gw',
      },
    ];
    initial.agentCoreGateways.push({
      name: 'main-gw',
      targets: [
        {
          name: 'docs',
          targetType: 'connector',
          connectorId: 'bedrock-knowledge-bases',
          configurations: [
            { name: 'Retrieve', parameterValues: { knowledgeBaseId: 'docs' }, parameterOverrides: [] },
            {
              name: 'AgenticRetrieveStream',
              parameterValues: { retrievers: [{ configuration: { knowledgeBase: { knowledgeBaseId: 'docs' } } }] },
              parameterOverrides: [],
            },
          ],
        },
      ],
      authorizerType: 'NONE',
      enableSemanticSearch: true,
      exceptionLevel: 'NONE',
    } as unknown as AgentCoreProjectSpec['agentCoreGateways'][0]);
    const { primitive } = makePrimitive(initial);

    const preview = await primitive.previewRemove('docs');
    const lines = preview.summary.join('\n');
    expect(lines).toMatch(/Gateway target: 'docs' on 'main-gw' will be removed/);
  });
});
