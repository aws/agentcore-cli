import { createTempConfig } from '../../__tests__/helpers/temp-config';
import { resolveAuditFilePath } from '../config';
import { FileSystemSink } from '../sinks/filesystem-sink';
import { readFile } from 'fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const tmp = createTempConfig('fs-sink');
const outputDir = join(tmp.configDir, 'telemetry');

function createSink(opts: { dir?: string; log?: (msg: string) => void } = {}) {
  const filePath = join(opts.dir ?? outputDir, 'test-session.json');
  return new FileSystemSink({ filePath, log: opts.log });
}

function readJsonl(path: string): Promise<unknown[]> {
  return readFile(path, 'utf-8').then(data =>
    data
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  );
}

describe('FileSystemSink', () => {
  beforeEach(() => tmp.setup());
  afterAll(() => tmp.cleanup());

  it('writes each record as a JSONL line on disk', async () => {
    const sink = createSink();
    sink.record(42, { command_group: 'deploy', command: 'deploy', exit_reason: 'success' });
    await sink.flush();

    const entries = await readJsonl(join(outputDir, 'test-session.json'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      value: 42,
      attrs: { command_group: 'deploy', command: 'deploy', exit_reason: 'success' },
    });
  });

  it('appends multiple records as separate lines', async () => {
    const sink = createSink();
    sink.record(10, { command_group: 'add', command: 'add.agent' });
    sink.record(20, { command_group: 'add', command: 'add.memory' });
    await sink.flush();

    const entries = await readJsonl(join(outputDir, 'test-session.json'));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ value: 10 });
    expect(entries[1]).toMatchObject({ value: 20 });
  });

  it('creates output directory if it does not exist', async () => {
    const nested = join(tmp.testDir, 'deep', 'nested', 'telemetry');
    const filePath = join(nested, 'test.json');
    const sink = new FileSystemSink({ filePath });
    sink.record(1, { command_group: 'status', command: 'status' });
    await sink.flush();

    const entries = await readJsonl(filePath);
    expect(entries).toHaveLength(1);
  });

  it('flush is a no-op when no records exist', async () => {
    const sink = createSink();
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it('shutdown logs audit message when records were written', async () => {
    const logged: string[] = [];
    const sink = createSink({ log: msg => logged.push(msg) });
    sink.record(99, { command_group: 'invoke', command: 'invoke' });
    await sink.shutdown();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('[audit mode]');
    expect(logged[0]).toContain('test-session.json');
  });

  it('shutdown does not log when no records were written', async () => {
    const logged: string[] = [];
    const sink = createSink({ log: msg => logged.push(msg) });
    await sink.shutdown();

    expect(logged).toHaveLength(0);
  });
});

describe('resolveAuditFilePath', () => {
  it('joins outputDir, entrypoint, and sessionId into a JSON file path', () => {
    const path = resolveAuditFilePath('/home/user/.agentcore/telemetry', 'deploy', 'abc-123');
    expect(path).toBe('/home/user/.agentcore/telemetry/deploy-abc-123.json');
  });
});
