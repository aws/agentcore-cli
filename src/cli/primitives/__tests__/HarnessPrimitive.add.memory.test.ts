import { HarnessPrimitive } from '../HarnessPrimitive';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Memory-mode resolution is the load-bearing behavior of the managed-memory ungating: the harness
// owns its memory internally (no sibling `${name}Memory` is ever auto-created), and "no memory"
// must write `{ mode: 'disabled' }` — which the CDK maps to CFN `Memory: { Disabled: {} }`, a true
// opt-out — rather than omitting memory (which the service would silently auto-provision).

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockWriteHarnessSpec = vi.fn();

vi.mock('../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    writeHarnessSpec = mockWriteHarnessSpec;
    getPathResolver = () => ({ getHarnessDir: (name: string) => `/fake/root/app/${name}` });
  },
  findConfigRoot: () => '/fake/root',
}));

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

function baseProject() {
  return { name: 'proj', harnesses: [], memories: [], runtimes: [] };
}

/** Runs add() with the given options and returns the memory ref written to harness.json. */
async function memoryWrittenFor(options: Record<string, unknown>) {
  mockReadProjectSpec.mockResolvedValue(baseProject());
  const primitive = new HarnessPrimitive();
  const result = await primitive.add({
    name: 'support',
    modelProvider: 'bedrock',
    modelId: 'anthropic.claude-3',
    configBaseDir: '/fake/root',
    ...options,
  } as never);
  expect(result.success).toBe(true);
  const [, spec] = mockWriteHarnessSpec.mock.calls.at(-1)!;
  return (spec as { memory?: { mode: string } }).memory;
}

describe('HarnessPrimitive.add — memory mode resolution', () => {
  afterEach(() => vi.clearAllMocks());

  it('defaults to disabled when no memory flags are passed (memory is opt-in)', async () => {
    expect(await memoryWrittenFor({})).toEqual({ mode: 'disabled' });
  });

  it('writes { mode: "disabled" } for --no-memory (skipMemory)', async () => {
    expect(await memoryWrittenFor({ skipMemory: true })).toEqual({ mode: 'disabled' });
  });

  it('writes { mode: "disabled" } for --memory-mode disabled', async () => {
    expect(await memoryWrittenFor({ memoryMode: 'disabled' })).toEqual({ mode: 'disabled' });
  });

  it('writes managed only when explicitly requested via --memory-mode managed', async () => {
    expect(await memoryWrittenFor({ memoryMode: 'managed' })).toEqual({ mode: 'managed' });
  });

  it('writes managed when a managed-tuning flag is given (implies managed)', async () => {
    expect(await memoryWrittenFor({ memoryEventExpiryDays: 30 })).toEqual({ mode: 'managed', eventExpiryDuration: 30 });
  });

  it('writes managed with explicit strategies when tuned', async () => {
    expect(await memoryWrittenFor({ memoryMode: 'managed', memoryStrategies: ['SEMANTIC', 'SUMMARIZATION'] })).toEqual({
      mode: 'managed',
      strategies: ['SEMANTIC', 'SUMMARIZATION'],
    });
  });

  it('writes existing when a memory ARN is referenced', async () => {
    const arn = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-aBcD012345';
    expect(await memoryWrittenFor({ memoryArn: arn })).toEqual({ mode: 'existing', arn });
  });

  it('never auto-creates a sibling `${name}Memory` resource in the project', async () => {
    mockReadProjectSpec.mockResolvedValue(baseProject());
    const primitive = new HarnessPrimitive();
    await primitive.add({
      name: 'support',
      modelProvider: 'bedrock',
      modelId: 'anthropic.claude-3',
      configBaseDir: '/fake/root',
    } as never);
    const writtenProject = mockWriteProjectSpec.mock.calls.at(-1)![0] as { memories: unknown[] };
    expect(writtenProject.memories).toHaveLength(0);
  });
});
