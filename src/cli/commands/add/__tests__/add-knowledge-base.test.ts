import { readProjectConfig, runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end coverage for the `--data-source-type` flag registered on
 * `add knowledge-base`. Drives the built CLI so we exercise the actual
 * commander registration (flag default, --connector-config threading) rather
 * than calling add() directly — that path is unit-tested elsewhere.
 */

describe('add knowledge-base command — --data-source-type flag', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-kb-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    const projectName = 'TestProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('defaults to S3 when --data-source-type is omitted', async () => {
    const result = await runCLI(
      ['add', 'knowledge-base', '--name', 'kb-default', '--source', 's3://my-bucket/data', '--json'],
      projectDir
    );
    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const project = await readProjectConfig(projectDir);
    const kb = project.knowledgeBases.find(k => k.name === 'kb-default');
    expect(kb).toBeDefined();
    expect(kb!.dataSources).toEqual([{ type: 'S3', uri: 's3://my-bucket/data' }]);
  });

  it('writes a connector data source when --data-source-type web-crawler is given', async () => {
    const cfgPath = join(testDir, 'web-crawler.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        type: 'WEB',
        connectionConfiguration: { authType: 'NO_AUTH' },
        seedUrls: ['https://example.com'],
      }),
      'utf-8'
    );

    const result = await runCLI(
      [
        'add',
        'knowledge-base',
        '--name',
        'kb-web',
        '--data-source-type',
        'web-crawler',
        '--connector-config',
        cfgPath,
        '--json',
      ],
      projectDir
    );
    expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);

    const project = await readProjectConfig(projectDir);
    const kb = project.knowledgeBases.find(k => k.name === 'kb-web');
    expect(kb).toBeDefined();
    expect(kb!.dataSources).toHaveLength(1);
    const ds = kb!.dataSources[0]!;
    expect(ds.type).toBe('WEB');
    // Connector configs are copied into app/<kb>/<basename>.
    expect((ds as { connectorConfigFile?: string }).connectorConfigFile).toBe('app/kb-web/web-crawler.json');
  });

  it('rejects --connector-config for the default S3 type', async () => {
    const cfgPath = join(testDir, 'stray.json');
    await writeFile(cfgPath, JSON.stringify({ type: 'WEB' }), 'utf-8');

    const result = await runCLI(
      ['add', 'knowledge-base', '--name', 'kb-bad', '--connector-config', cfgPath, '--json'],
      projectDir
    );
    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
  });
});
