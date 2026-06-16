import type { EvaluatorConfig } from '../../../schema';
import { EvaluatorPrimitive, jsonToKwargs, jsonToPythonValue } from '../EvaluatorPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  ConflictError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ConflictError';
    }
  },
}));

const mockRenderCodeBased = vi.fn().mockResolvedValue(undefined);
const mockRenderDeepEval = vi.fn().mockResolvedValue(undefined);

vi.mock('../../templates/EvaluatorRenderer', () => ({
  renderCodeBasedEvaluatorTemplate: (...args: unknown[]) => mockRenderCodeBased(...args),
  renderDeepEvalEvaluatorTemplate: (...args: unknown[]) => mockRenderDeepEval(...args),
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

function makeEvaluator(name: string, config?: EvaluatorConfig) {
  return {
    name,
    type: 'CustomEvaluator',
    level: 'SESSION',
    config: config ?? validConfig,
  };
}

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
    evaluators: evaluators.map(e => ('config' in e ? e : makeEvaluator(e.name))),
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
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ message: expect.stringContaining('already exists') }),
        })
      );
    });

    it('returns error when readProjectSpec fails', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('disk read error'));

      const result = await primitive.add({
        name: 'NewEval',
        level: 'SESSION',
        config: validConfig,
      });

      expect(result).toEqual(expect.objectContaining({ success: false, error: new Error('disk read error') }));
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
        expect(result.error.message).toContain('NonExistent');
        expect(result.error.message).toContain('not found');
      }
    });

    it('blocks removal when referenced by online eval configs', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([{ name: 'UsedEval' }], [{ name: 'MyOnlineConfig', evaluators: ['UsedEval'] }])
      );

      const result = await primitive.remove('UsedEval');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('referenced by online eval config');
        expect(result.error.message).toContain('MyOnlineConfig');
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('returns error when readProjectSpec fails', async () => {
      mockReadProjectSpec.mockRejectedValue(new Error('io error'));

      const result = await primitive.remove('Whatever');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('io error');
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

  describe('buildDeepEvalConfig', () => {
    it('returns managed code-based config with deepeval defaults', () => {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      const config = primitive['buildDeepEvalConfig']('my_eval');

      expect(config).toEqual({
        codeBased: {
          managed: {
            codeLocation: 'app/my_eval/',
            entrypoint: 'lambda_function.handler',
            timeoutSeconds: 300,
            memorySizeMb: 1024,
            additionalPolicies: ['execution-role-policy.json'],
          },
        },
      });
    });

    it('respects custom timeout', () => {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      const config = primitive['buildDeepEvalConfig']('my_eval', '120');

      expect(config.codeBased!.managed!.timeoutSeconds).toBe(120);
    });

    it('respects custom memory', () => {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      const config = primitive['buildDeepEvalConfig']('my_eval', undefined, '2048');

      expect(config.codeBased!.managed!.memorySizeMb).toBe(2048);
    });

    it('respects both custom timeout and memory', () => {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      const config = primitive['buildDeepEvalConfig']('my_eval', '60', '512');

      expect(config.codeBased!.managed!.timeoutSeconds).toBe(60);
      expect(config.codeBased!.managed!.memorySizeMb).toBe(512);
    });

    it('sets codeLocation based on evaluator name', () => {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      const config = primitive['buildDeepEvalConfig']('relevancy_check');

      expect(config.codeBased!.managed!.codeLocation).toBe('app/relevancy_check/');
    });
  });

  describe('add with thirdParty (deepeval)', () => {
    const deepEvalConfig: EvaluatorConfig = {
      codeBased: {
        managed: {
          codeLocation: 'app/deep_eval/',
          entrypoint: 'lambda_function.handler',
          timeoutSeconds: 300,
          memorySizeMb: 1024,
          additionalPolicies: ['execution-role-policy.json'],
        },
      },
    };

    it('calls renderDeepEvalEvaluatorTemplate when thirdParty.library is deepeval', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'deep_eval',
        level: 'SESSION',
        config: deepEvalConfig,
        thirdParty: {
          library: 'deepeval',
          metricClass: 'AnswerRelevancyMetric',
          metricParams: 'threshold=0.7',
        },
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('codePath', 'app/deep_eval/');
      expect(mockRenderDeepEval).toHaveBeenCalledOnce();
      expect(mockRenderDeepEval).toHaveBeenCalledWith(
        { Name: 'deep_eval', MetricClass: 'AnswerRelevancyMetric', MetricParams: 'threshold=0.7' },
        expect.stringContaining('app/deep_eval')
      );
      expect(mockRenderCodeBased).not.toHaveBeenCalled();
    });

    it('passes empty string for MetricParams when not provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'deep_eval',
        level: 'SESSION',
        config: deepEvalConfig,
        thirdParty: {
          library: 'deepeval',
          metricClass: 'HallucinationMetric',
        },
      });

      expect(mockRenderDeepEval).toHaveBeenCalledWith(
        { Name: 'deep_eval', MetricClass: 'HallucinationMetric', MetricParams: '' },
        expect.any(String)
      );
    });

    it('calls renderCodeBasedEvaluatorTemplate when thirdParty is not set', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const managedConfig: EvaluatorConfig = {
        codeBased: {
          managed: {
            codeLocation: 'app/plain_eval/',
            entrypoint: 'lambda_function.handler',
            timeoutSeconds: 60,
            additionalPolicies: ['execution-role-policy.json'],
          },
        },
      };

      await primitive.add({
        name: 'plain_eval',
        level: 'SESSION',
        config: managedConfig,
      });

      expect(mockRenderCodeBased).toHaveBeenCalledOnce();
      expect(mockRenderCodeBased).toHaveBeenCalledWith('plain_eval', expect.stringContaining('app/plain_eval'));
      expect(mockRenderDeepEval).not.toHaveBeenCalled();
    });
  });
});

describe('jsonToPythonValue', () => {
  it('converts null to None', () => {
    expect(jsonToPythonValue(null)).toBe('None');
  });

  it('converts true to True', () => {
    expect(jsonToPythonValue(true)).toBe('True');
  });

  it('converts false to False', () => {
    expect(jsonToPythonValue(false)).toBe('False');
  });

  it('converts integers', () => {
    expect(jsonToPythonValue(42)).toBe('42');
  });

  it('converts floats', () => {
    expect(jsonToPythonValue(0.7)).toBe('0.7');
  });

  it('converts strings with quotes', () => {
    expect(jsonToPythonValue('gpt-4')).toBe('"gpt-4"');
  });

  it('converts arrays', () => {
    expect(jsonToPythonValue([1, 'two', true])).toBe('[1, "two", True]');
  });

  it('converts nested objects to Python dicts', () => {
    expect(jsonToPythonValue({ key: 'value', n: 3 })).toBe('{"key": "value", "n": 3}');
  });

  it('handles empty arrays', () => {
    expect(jsonToPythonValue([])).toBe('[]');
  });

  it('handles empty objects', () => {
    expect(jsonToPythonValue({})).toBe('{}');
  });
});

describe('jsonToKwargs', () => {
  it('converts simple number parameter', () => {
    expect(jsonToKwargs('{"threshold": 0.7}')).toBe('threshold=0.7');
  });

  it('converts simple string parameter', () => {
    expect(jsonToKwargs('{"model": "gpt-4"}')).toBe('model="gpt-4"');
  });

  it('converts multiple parameters', () => {
    const result = jsonToKwargs('{"threshold": 0.7, "model": "gpt-4"}');
    expect(result).toBe('threshold=0.7, model="gpt-4"');
  });

  it('converts boolean parameters', () => {
    expect(jsonToKwargs('{"verbose": true, "strict": false}')).toBe('verbose=True, strict=False');
  });

  it('converts null parameters', () => {
    expect(jsonToKwargs('{"callback": null}')).toBe('callback=None');
  });

  it('converts array parameters', () => {
    expect(jsonToKwargs('{"tools": ["search", "calculate"]}')).toBe('tools=["search", "calculate"]');
  });

  it('converts nested object parameters', () => {
    const result = jsonToKwargs('{"config": {"temperature": 0.5}}');
    expect(result).toBe('config={"temperature": 0.5}');
  });

  it('handles mixed types', () => {
    const input = '{"threshold": 0.7, "model": "gpt-4", "verbose": true, "tags": ["eval"], "fallback": null}';
    const result = jsonToKwargs(input);
    expect(result).toBe('threshold=0.7, model="gpt-4", verbose=True, tags=["eval"], fallback=None');
  });

  it('throws on invalid JSON', () => {
    expect(() => jsonToKwargs('not json')).toThrow();
  });

  it('returns empty string for empty object', () => {
    expect(jsonToKwargs('{}')).toBe('');
  });
});
