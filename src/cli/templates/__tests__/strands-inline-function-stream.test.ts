import { copyAndRenderDir } from '../render.js';
import { TEMPLATE_ROOT } from '../templateRoot.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const TEMPLATE_DIR = join(TEMPLATE_ROOT, 'python', 'http', 'strands', 'base');
const outDirs: string[] = [];

const toolUseStart = { contentBlockStart: { start: { toolUse: { toolUseId: 't1', name: 'lookup' } } } };
const metadata = { metadata: { usage: { inputTokens: 10, outputTokens: 2 }, metrics: { latencyMs: 5 } } };
const handOffCall = [
  { messageStart: { role: 'assistant' } },
  toolUseStart,
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'tool_use' } },
];
const nextCall = [{ messageStart: { role: 'assistant' } }, { messageStop: { stopReason: 'end_turn' } }];

async function renderMain(hasExecutionLimits: boolean): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'strands-inline-'));
  outDirs.push(outDir);
  await copyAndRenderDir(TEMPLATE_DIR, outDir, {
    isExportHarness: true,
    inlineFunctionTools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' } }],
    hasExecutionLimits,
    timeoutSeconds: 60,
  });
  return readFileSync(join(outDir, 'main.py'), 'utf-8');
}

function extractBlock(source: string, from: string, to = from): string {
  const lines = source.split('\n');
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const head = lines.findIndex(line => line.trimStart().startsWith(to));
  const start = lines.findIndex(line => line.trimStart().startsWith(from));
  const colon = lines.findIndex((line, i) => i >= head && line.trimEnd().endsWith(':'));
  const end = lines.findIndex((line, i) => i > colon && line.trim() !== '' && indentOf(line) <= indentOf(lines[head]!));
  return lines
    .slice(start, end)
    .map(line => line.slice(indentOf(lines[start]!)))
    .join('\n');
}

function forwardedEvents(main: string, stream: object[]): string[] {
  const loop = extractBlock(main, 'hit_inline_function = False', 'async for event in agent.stream_async(');
  const script = [
    'import asyncio, json, sys',
    '_INLINE_FUNCTION_NAMES = {"lookup"}',
    extractBlock(main, 'def _is_inline_function_call'),
    'class FakeAgent:',
    '    async def stream_async(self, prompt):',
    '        for chunk in json.loads(sys.argv[1]):',
    '            yield {"event": chunk}',
    'async def run(agent, prompt):',
    loop.replace(/^/gm, '    '),
    'async def main():',
    '    print(json.dumps([next(iter(e["event"])) async for e in run(FakeAgent(), "hi")]))',
    'asyncio.run(main())',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script, JSON.stringify(stream)], { encoding: 'utf-8' });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as string[];
}

afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

describe.each([false, true])('strands inline function stream (hasExecutionLimits: %s)', hasExecutionLimits => {
  it('forwards the usage metadata of the call that hands off an inline function', async () => {
    const main = await renderMain(hasExecutionLimits);

    expect(forwardedEvents(main, [...handOffCall, metadata, ...nextCall])).toEqual([
      'messageStart',
      'contentBlockStart',
      'contentBlockStop',
      'messageStop',
      'metadata',
    ]);
  });

  it('stops at messageStop when the model sends no usage metadata', async () => {
    const main = await renderMain(hasExecutionLimits);

    expect(forwardedEvents(main, [...handOffCall, ...nextCall])).toEqual([
      'messageStart',
      'contentBlockStart',
      'contentBlockStop',
      'messageStop',
    ]);
  });

  it('forwards every event of a run that ends without an inline function', async () => {
    const main = await renderMain(hasExecutionLimits);

    expect(forwardedEvents(main, [...nextCall, metadata])).toEqual(['messageStart', 'messageStop', 'metadata']);
  });
});
