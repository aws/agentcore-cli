import { RuntimeEndpointPrimitive } from '../RuntimeEndpointPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockConfigExists = vi.fn();
const mockReadDeployedState = vi.fn();

vi.mock('../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    configExists = mockConfigExists;
    readDeployedState = mockReadDeployedState;
  },
  findConfigRoot: () => '/fake/root',
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  serializeResult: (r: unknown) => r,
  ResourceNotFoundError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ResourceNotFoundError';
    }
  },
  ConflictError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ConflictError';
    }
  },
  ValidationError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ValidationError';
    }
  },
}));

function makeProject(
  runtimes: {
    name: string;
    endpoints?: Record<string, { version: number; description?: string }>;
  }[] = []
) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: runtimes.map(r => ({
      name: r.name,
      build: 'CodeZip' as const,
      entrypoint: 'main.py' as any,
      codeLocation: `app/${r.name}/` as any,
      runtimeVersion: 'PYTHON_3_14' as any,
      ...(r.endpoints && { endpoints: r.endpoints }),
    })),
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
  };
}

const primitive = new RuntimeEndpointPrimitive();

describe('RuntimeEndpointPrimitive', () => {
  afterEach(() => vi.clearAllMocks());

  it('has kind "runtime-endpoint"', () => {
    expect(primitive.kind).toBe('runtime-endpoint');
  });

  it('has label "Runtime Endpoint"', () => {
    expect(primitive.label).toBe('Runtime Endpoint');
  });

  describe('add', () => {
    it('successfully adds endpoint to a runtime', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);
      mockConfigExists.mockReturnValue(false);

      const result = await primitive.add({
        runtime: 'MyRuntime',
        endpoint: 'prod',
        version: 3,
        description: 'Production endpoint',
      });

      expect(result.success).toBe(true);

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      const runtime = writtenSpec.runtimes.find((r: any) => r.name === 'MyRuntime');
      expect(runtime.endpoints).toHaveProperty('prod');
      expect(runtime.endpoints.prod.version).toBe(3);
      expect(runtime.endpoints.prod.description).toBe('Production endpoint');
    });

    it('returns error when runtime not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'OtherRuntime' }]));
      mockConfigExists.mockReturnValue(false);

      const result = await primitive.add({
        runtime: 'NonExistent',
        endpoint: 'prod',
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: expect.stringContaining('not found') }),
        })
      );
    });

    it('returns error when endpoint already exists', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime', endpoints: { prod: { version: 1 } } }]));
      mockConfigExists.mockReturnValue(false);

      const result = await primitive.add({
        runtime: 'MyRuntime',
        endpoint: 'prod',
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: expect.stringContaining('already exists') }),
        })
      );
    });

    it('defaults version to 1 when not provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);
      mockConfigExists.mockReturnValue(false);

      const result = await primitive.add({
        runtime: 'MyRuntime',
        endpoint: 'staging',
      });

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.runtimes[0].endpoints.staging.version).toBe(1);
    });

    it.each([
      { version: 0, label: 'zero' },
      { version: -1, label: 'negative' },
      { version: 3.5, label: 'non-integer' },
    ])('returns error when version is $label ($version)', async ({ version }) => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));
      mockConfigExists.mockReturnValue(false);

      const result = await primitive.add({
        runtime: 'MyRuntime',
        endpoint: 'prod',
        version,
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: expect.stringContaining('positive integer') }),
        })
      );
    });

    it('returns richer JSON response with endpointName, agent, and version', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);
      mockConfigExists.mockReturnValue(false);

      const result = await primitive.add({
        runtime: 'MyRuntime',
        endpoint: 'prod',
        version: 2,
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          endpointName: 'prod',
          agent: 'MyRuntime',
          version: 2,
        })
      );
    });

    it('returns error when version exceeds latest deployed version', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));
      mockConfigExists.mockReturnValue(true);
      mockReadDeployedState.mockResolvedValue({
        targets: {
          'us-east-1': {
            resources: {
              runtimes: {
                MyRuntime: { runtimeVersion: 3 },
              },
            },
          },
        },
      });

      const result = await primitive.add({
        runtime: 'MyRuntime',
        endpoint: 'prod',
        version: 5,
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: expect.stringContaining('exceeds latest deployed version') }),
        })
      );
    });
  });

  describe('remove', () => {
    it('removes endpoint using composite key runtimeName/endpointName', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          {
            name: 'MyRuntime',
            endpoints: { prod: { version: 1 }, staging: { version: 2 } },
          },
        ])
      );
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('MyRuntime/prod');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      const runtime = writtenSpec.runtimes[0];
      expect(runtime.endpoints).not.toHaveProperty('prod');
      expect(runtime.endpoints).toHaveProperty('staging');
    });

    it('removes endpoint using legacy bare name (fallback)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime', endpoints: { prod: { version: 1 } } }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('prod');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.runtimes[0].endpoints).toBeUndefined();
    });

    it('returns error when endpoint not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));

      const result = await primitive.remove('MyRuntime/nonexistent');

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: expect.stringContaining('not found') }),
        })
      );
    });

    it('cleans up empty endpoints dict after removing last endpoint', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime', endpoints: { prod: { version: 1 } } }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('MyRuntime/prod');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.runtimes[0].endpoints).toBeUndefined();
    });

    it('correctly targets the right runtime when same endpoint name exists on multiple runtimes', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          { name: 'RuntimeA', endpoints: { prod: { version: 1 } } },
          { name: 'RuntimeB', endpoints: { prod: { version: 2 } } },
        ])
      );
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('RuntimeB/prod');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      // RuntimeA should still have its prod endpoint
      expect(writtenSpec.runtimes[0].endpoints).toHaveProperty('prod');
      // RuntimeB should have had its prod endpoint removed
      expect(writtenSpec.runtimes[1].endpoints).toBeUndefined();
    });
  });

  describe('previewRemove', () => {
    it('returns summary with correct runtime and endpoint info using composite key', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          {
            name: 'MyRuntime',
            endpoints: { prod: { version: 3, description: 'Production' } },
          },
        ])
      );

      const preview = await primitive.previewRemove('MyRuntime/prod');

      expect(preview.summary).toEqual(
        expect.arrayContaining([expect.stringContaining('prod'), expect.stringContaining('MyRuntime')])
      );
      expect(preview.summary).toEqual(expect.arrayContaining([expect.stringContaining('Version: 3')]));
      expect(preview.summary).toEqual(expect.arrayContaining([expect.stringContaining('Production')]));
    });

    it('returns schemaChanges showing before/after agentcore.json', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime', endpoints: { prod: { version: 1 } } }]));

      const preview = await primitive.previewRemove('MyRuntime/prod');

      expect(preview.schemaChanges).toHaveLength(1);
      expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');

      // Before should have the endpoint
      const before = preview.schemaChanges[0]!.before as any;
      expect(before.runtimes[0].endpoints).toHaveProperty('prod');

      // After should not have the endpoint (and endpoints dict cleaned up)
      const after = preview.schemaChanges[0]!.after as any;
      expect(after.runtimes[0].endpoints).toBeUndefined();
    });

    it('throws when endpoint not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));

      await expect(primitive.previewRemove('MyRuntime/missing')).rejects.toThrow('not found');
    });
  });

  describe('getRemovable', () => {
    it('returns all endpoints across all runtimes', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          { name: 'RuntimeA', endpoints: { prod: { version: 1 }, staging: { version: 2 } } },
          { name: 'RuntimeB', endpoints: { beta: { version: 3 } } },
        ])
      );

      const result = await primitive.getRemovable();

      expect(result).toHaveLength(3);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'RuntimeA/prod', runtimeName: 'RuntimeA', endpointName: 'prod', version: 1 }),
          expect.objectContaining({
            name: 'RuntimeA/staging',
            runtimeName: 'RuntimeA',
            endpointName: 'staging',
            version: 2,
          }),
          expect.objectContaining({ name: 'RuntimeB/beta', runtimeName: 'RuntimeB', endpointName: 'beta', version: 3 }),
        ])
      );
    });

    it('uses composite key format runtimeName/endpointName for name field', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime', endpoints: { prod: { version: 1 } } }]));

      const result = await primitive.getRemovable();

      expect(result[0]!.name).toBe('MyRuntime/prod');
    });

    it('returns empty array when no endpoints exist', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyRuntime' }]));

      const result = await primitive.getRemovable();

      expect(result).toEqual([]);
    });

    it('returns empty array when no runtimes exist', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.getRemovable();

      expect(result).toEqual([]);
    });
  });
});
