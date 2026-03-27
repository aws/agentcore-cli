import { OnlineEvalConfigPrimitive } from '../OnlineEvalConfigPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();

vi.mock('../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
  findConfigRoot: () => '/fake/root',
}));

function makeProject(
  onlineEvalConfigs: { name: string; evaluators: string[] }[] = [],
  evaluators: { name: string }[] = []
) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    agents: [],
    memories: [],
    credentials: [],
    evaluators,
    onlineEvalConfigs,
  };
}

const primitive = new OnlineEvalConfigPrimitive();

describe('OnlineEvalConfigPrimitive', () => {
  afterEach(() => vi.clearAllMocks());

  it('has correct kind, label, and article', () => {
    expect(primitive.kind).toBe('online-eval');
    expect(primitive.label).toBe('Online Eval Config');
    // eslint-disable-next-line @typescript-eslint/dot-notation
    expect(primitive['article']).toBe('an');
  });

  describe('add', () => {
    it('adds config to project spec and returns success', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'MyConfig',
        agent: 'MyAgent',
        evaluators: ['Builtin.GoalSuccessRate'],
        samplingRate: 10,
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('configName', 'MyConfig');

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.onlineEvalConfigs).toHaveLength(1);
      const config = writtenSpec.onlineEvalConfigs[0];
      expect(config.name).toBe('MyConfig');
      expect(config.evaluators).toEqual(['Builtin.GoalSuccessRate']);
      expect(config.samplingRate).toBe(10);
    });

    it('stores enableOnCreate when provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'EnabledConfig',
        agent: 'MyAgent',
        evaluators: ['Builtin.GoalSuccessRate'],
        samplingRate: 10,
        enableOnCreate: true,
      });

      expect(result.success).toBe(true);
      const config = mockWriteProjectSpec.mock.calls[0]![0].onlineEvalConfigs[0];
      expect(config.enableOnCreate).toBe(true);
    });

    it('omits enableOnCreate when not provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'NoEnableConfig',
        agent: 'MyAgent',
        evaluators: ['Builtin.GoalSuccessRate'],
        samplingRate: 10,
      });

      const config = mockWriteProjectSpec.mock.calls[0]![0].onlineEvalConfigs[0];
      expect(config.enableOnCreate).toBeUndefined();
    });

    it('supports multiple evaluators including ARNs', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'MultiConfig',
        agent: 'MyAgent',
        evaluators: ['Builtin.GoalSuccessRate', 'CustomEval', 'arn:aws:bedrock:us-east-1:123:evaluator/ext'],
        samplingRate: 50,
      });

      expect(result.success).toBe(true);
      const config = mockWriteProjectSpec.mock.calls[0]![0].onlineEvalConfigs[0];
      expect(config.evaluators).toEqual([
        'Builtin.GoalSuccessRate',
        'CustomEval',
        'arn:aws:bedrock:us-east-1:123:evaluator/ext',
      ]);
    });

    it('returns error when config name already exists', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'Existing', evaluators: ['e'] }]));

      const result = await primitive.add({
        name: 'Existing',
        agent: 'MyAgent',
        evaluators: ['e'],
        samplingRate: 10,
      });

      expect(result).toEqual(
        expect.objectContaining({ success: false, error: expect.stringContaining('already exists') })
      );
    });

    it('returns error when readProjectSpec fails', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('no project'));

      const result = await primitive.add({
        name: 'New',
        agent: 'MyAgent',
        evaluators: ['e'],
        samplingRate: 10,
      });

      expect(result).toEqual(expect.objectContaining({ success: false, error: 'no project' }));
    });
  });

  describe('remove', () => {
    it('removes config from project spec', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          { name: 'ConfigA', evaluators: ['e'] },
          { name: 'ConfigB', evaluators: ['f'] },
        ])
      );
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('ConfigA');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.onlineEvalConfigs).toHaveLength(1);
      expect(writtenSpec.onlineEvalConfigs[0].name).toBe('ConfigB');
    });

    it('returns error when config not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.remove('NonExistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('NonExistent');
        expect(result.error).toContain('not found');
      }
    });

    it('returns error when readProjectSpec fails', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('io error'));

      const result = await primitive.remove('Whatever');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('io error');
      }
    });
  });

  describe('previewRemove', () => {
    it('returns preview with summary including evaluators', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'Config1', evaluators: ['Builtin.X', 'CustomY'] }]));

      const preview = await primitive.previewRemove('Config1');

      expect(preview.summary).toContain('Removing online eval config: Config1');
      expect(preview.summary).toContain('Uses evaluators: Builtin.X, CustomY');
      expect(preview.schemaChanges).toHaveLength(1);
      expect((preview.schemaChanges[0]!.after as { onlineEvalConfigs: unknown[] }).onlineEvalConfigs).toHaveLength(0);
    });

    it('throws when config not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      await expect(primitive.previewRemove('Missing')).rejects.toThrow('not found');
    });
  });

  describe('getRemovable', () => {
    it('returns config names', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          { name: 'C1', evaluators: ['e'] },
          { name: 'C2', evaluators: ['f'] },
        ])
      );

      const result = await primitive.getRemovable();

      expect(result).toEqual([{ name: 'C1' }, { name: 'C2' }]);
    });

    it('returns empty array on error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getRemovable()).toEqual([]);
    });
  });

  describe('getAllNames', () => {
    it('returns config names as strings', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'X', evaluators: ['e'] }]));

      expect(await primitive.getAllNames()).toEqual(['X']);
    });

    it('returns empty array on error', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('fail'));

      expect(await primitive.getAllNames()).toEqual([]);
    });
  });
});
