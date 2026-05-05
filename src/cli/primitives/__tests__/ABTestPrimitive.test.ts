import { ABTestPrimitive } from '../ABTestPrimitive.js';
import type { AddABTestOptions } from '../ABTestPrimitive.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();

vi.mock('../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
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
}));

function makeProject(abTests: { name: string; gatewayRef?: string }[] = []) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    configBundles: [],
    abTests,
    httpGateways: [] as { name: string; runtimeRef: string }[],
  };
}

const validOptions: AddABTestOptions = {
  name: 'MyTest',
  agent: 'my-agent',
  controlBundle: 'arn:bundle:control',
  controlVersion: 'v1',
  treatmentBundle: 'arn:bundle:treatment',
  treatmentVersion: 'v1',
  controlWeight: 80,
  treatmentWeight: 20,
  onlineEval: 'arn:eval:config',
};

let primitive: ABTestPrimitive;

describe('ABTestPrimitive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primitive = new ABTestPrimitive();
  });

  it('has correct kind, label, and article', () => {
    expect(primitive.kind).toBe('ab-test');
    expect(primitive.label).toBe('AB Test');
    // eslint-disable-next-line @typescript-eslint/dot-notation
    expect(primitive['article']).toBe('an');
  });

  describe('add', () => {
    it('adds AB test to project spec and returns success', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add(validOptions);

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('abTestName', 'MyTest');

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.abTests).toHaveLength(1);
      expect(writtenSpec.abTests[0].name).toBe('MyTest');
      expect(writtenSpec.abTests[0].variants).toHaveLength(2);
      expect(writtenSpec.abTests[0].variants[0].name).toBe('C');
      expect(writtenSpec.abTests[0].variants[0].weight).toBe(80);
      expect(writtenSpec.abTests[0].variants[1].name).toBe('T1');
      expect(writtenSpec.abTests[0].variants[1].weight).toBe(20);
    });

    it('includes optional fields when provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        ...validOptions,
        description: 'Test description',
        roleArn: 'arn:aws:iam::123:role/MyRole',
        trafficHeaderName: 'X-AB-Route',
        maxDurationDays: 30,
        enableOnCreate: true,
      });

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      const test = writtenSpec.abTests[0];
      expect(test.description).toBe('Test description');
      expect(test.roleArn).toBe('arn:aws:iam::123:role/MyRole');
      expect(test.trafficAllocationConfig).toEqual({ routeOnHeader: { headerName: 'X-AB-Route' } });
      expect(test.maxDurationDays).toBe(30);
      expect(test.enableOnCreate).toBe(true);
    });

    it('omits optional fields when not provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add(validOptions);

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      const test = writtenSpec.abTests[0];
      expect(test.description).toBeUndefined();
      expect(test.roleArn).toBeUndefined();
      expect(test.trafficAllocationConfig).toBeUndefined();
      expect(test.maxDurationDays).toBeUndefined();
      expect(test.enableOnCreate).toBeUndefined();
    });

    it('returns error when AB test name already exists', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'MyTest' }]));

      const result = await primitive.add(validOptions);

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: expect.stringContaining('already exists') }),
        })
      );
    });

    it('returns error when readProjectSpec fails', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('disk read error'));

      const result = await primitive.add(validOptions);

      expect(result).toEqual(expect.objectContaining({ success: false, error: new Error('disk read error') }));
    });

    it('returns error when writeProjectSpec fails', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockRejectedValue(new Error('disk write error'));

      const result = await primitive.add(validOptions);

      expect(result).toEqual(expect.objectContaining({ success: false, error: new Error('disk write error') }));
    });

    it('returns error when variant weights do not sum to 100', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.add({
        ...validOptions,
        controlWeight: 80,
        treatmentWeight: 80,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('remove', () => {
    it('removes AB test from project spec', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'TestA' }, { name: 'TestB' }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('TestA');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.abTests).toHaveLength(1);
      expect(writtenSpec.abTests[0].name).toBe('TestB');
    });

    it('returns error when AB test not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.remove('NonExistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('NonExistent');
        expect(result.error.message).toContain('not found');
      }
    });

    it('returns error when readProjectSpec fails', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('io error'));

      const result = await primitive.remove('Whatever');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('io error');
      }
    });

    it('cascade-deletes orphaned HTTP gateway when last referencing AB test is removed', async () => {
      const project = makeProject([{ name: 'TestA', gatewayRef: '{{gateway:TestA-gw}}' }]);
      project.httpGateways = [{ name: 'TestA-gw', runtimeRef: 'my-agent' }];
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('TestA');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.abTests).toHaveLength(0);
      // Gateway is retained by default — cascade-delete only happens with deleteGateway: true
      expect(writtenSpec.httpGateways).toHaveLength(1);
    });

    it('retains HTTP gateway when another AB test still references it', async () => {
      const project = makeProject([
        { name: 'TestA', gatewayRef: '{{gateway:shared-gw}}' },
        { name: 'TestB', gatewayRef: '{{gateway:shared-gw}}' },
      ]);
      project.httpGateways = [{ name: 'shared-gw', runtimeRef: 'my-agent' }];
      mockReadProjectSpec.mockResolvedValue(project);
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('TestA');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.abTests).toHaveLength(1);
      expect(writtenSpec.httpGateways).toHaveLength(1);
      expect(writtenSpec.httpGateways[0].name).toBe('shared-gw');
    });
  });

  describe('previewRemove', () => {
    it('returns preview with schema changes', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'TestA' }]));

      const preview = await primitive.previewRemove('TestA');

      expect(preview.summary[0]).toContain('Removing AB test: TestA');
      expect(preview.schemaChanges).toHaveLength(1);
      expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
      expect((preview.schemaChanges[0]!.after as { abTests: unknown[] }).abTests).toHaveLength(0);
    });

    it('throws when AB test not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      await expect(primitive.previewRemove('Missing')).rejects.toThrow('not found');
    });
  });

  describe('getRemovable', () => {
    it('returns AB test names', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'A' }, { name: 'B' }]));

      const result = await primitive.getRemovable();

      expect(result).toEqual([{ name: 'A' }, { name: 'B' }]);
    });

    it('returns empty array on error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getRemovable()).toEqual([]);
    });
  });

  describe('getAllNames', () => {
    it('returns AB test names as strings', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'X' }, { name: 'Y' }]));

      const result = await primitive.getAllNames();

      expect(result).toEqual(['X', 'Y']);
    });

    it('returns empty array on error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getAllNames()).toEqual([]);
    });
  });
});
