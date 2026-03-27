import type { EvaluatorConfig } from '../../../schema';
import { EvaluatorPrimitive } from '../EvaluatorPrimitive.js';
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

const validConfig: EvaluatorConfig = {
  llmAsAJudge: {
    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    instructions: 'Evaluate quality. Context: {context}',
    ratingScale: {
      numerical: [
        { value: 1, label: 'Poor', definition: 'Fails' },
        { value: 5, label: 'Excellent', definition: 'Perfect' },
      ],
    },
  },
};

function makeProject(
  evaluators: { name: string }[] = [],
  onlineEvalConfigs: { name: string; evaluators: string[] }[] = []
) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators,
    onlineEvalConfigs,
  };
}

const primitive = new EvaluatorPrimitive();

describe('EvaluatorPrimitive', () => {
  afterEach(() => vi.clearAllMocks());

  it('has correct kind, label, and article', () => {
    expect(primitive.kind).toBe('evaluator');
    expect(primitive.label).toBe('Evaluator');
    // eslint-disable-next-line @typescript-eslint/dot-notation
    expect(primitive['article']).toBe('an');
  });

  describe('add', () => {
    it('adds evaluator to project spec and returns success', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'MyEval',
        level: 'SESSION',
        config: validConfig,
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('evaluatorName', 'MyEval');

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.evaluators).toHaveLength(1);
      expect(writtenSpec.evaluators[0].name).toBe('MyEval');
      expect(writtenSpec.evaluators[0].level).toBe('SESSION');
    });

    it('includes description when provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'DescEval',
        level: 'TRACE',
        description: 'My description',
        config: validConfig,
      });

      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.evaluators[0].description).toBe('My description');
    });

    it('returns error when evaluator name already exists', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'Existing' }]));

      const result = await primitive.add({
        name: 'Existing',
        level: 'SESSION',
        config: validConfig,
      });

      expect(result).toEqual(
        expect.objectContaining({ success: false, error: expect.stringContaining('already exists') })
      );
    });

    it('returns error when readProjectSpec fails', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('disk read error'));

      const result = await primitive.add({
        name: 'NewEval',
        level: 'SESSION',
        config: validConfig,
      });

      expect(result).toEqual(expect.objectContaining({ success: false, error: 'disk read error' }));
    });
  });

  describe('remove', () => {
    it('removes evaluator from project spec', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'EvalA' }, { name: 'EvalB' }]));
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.remove('EvalA');

      expect(result.success).toBe(true);
      const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
      expect(writtenSpec.evaluators).toHaveLength(1);
      expect(writtenSpec.evaluators[0].name).toBe('EvalB');
    });

    it('returns error when evaluator not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      const result = await primitive.remove('NonExistent');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('NonExistent');
        expect(result.error).toContain('not found');
      }
    });

    it('blocks removal when referenced by online eval configs', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([{ name: 'UsedEval' }], [{ name: 'MyOnlineConfig', evaluators: ['UsedEval'] }])
      );

      const result = await primitive.remove('UsedEval');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('referenced by online eval config');
        expect(result.error).toContain('MyOnlineConfig');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
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
    it('returns preview with schema changes', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject([{ name: 'EvalA' }]));

      const preview = await primitive.previewRemove('EvalA');

      expect(preview.summary[0]).toContain('Removing evaluator: EvalA');
      expect(preview.schemaChanges).toHaveLength(1);
      expect(preview.schemaChanges[0]!.file).toBe('agentcore/agentcore.json');
      expect((preview.schemaChanges[0]!.after as { evaluators: unknown[] }).evaluators).toHaveLength(0);
    });

    it('throws when evaluator not found', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());

      await expect(primitive.previewRemove('Missing')).rejects.toThrow('not found');
    });

    it('warns when evaluator is referenced by online eval configs', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([{ name: 'UsedEval' }], [{ name: 'Config1', evaluators: ['UsedEval'] }])
      );

      const preview = await primitive.previewRemove('UsedEval');

      const blocked = preview.summary.find(s => s.includes('Blocked'));
      expect(blocked).toBeDefined();
      expect(blocked).toContain('Config1');
    });
  });

  describe('getRemovable', () => {
    it('returns evaluator names', async () => {
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
    it('returns evaluator names as strings', async () => {
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
