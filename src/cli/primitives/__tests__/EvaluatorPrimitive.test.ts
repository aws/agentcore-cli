import type { EvaluatorConfig } from '../../../schema';
import {
  EvaluatorPrimitive,
  MODEL_PROVIDERS,
  THIRD_PARTY_EVALUATOR_LIBRARIES,
  jsonToKwargs,
  jsonToPythonValue,
} from '../EvaluatorPrimitive.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockUpdateProjectSpec = vi.fn(async (mutate: (project: ReturnType<typeof makeProject>) => unknown) => {
  const project = await mockReadProjectSpec();
  const result = await mutate(project);
  const updated = result ?? project;
  await mockWriteProjectSpec(updated);
  return updated;
});

vi.mock('../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    updateProjectSpec = mockUpdateProjectSpec;
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
const mockRenderThirdParty = vi.fn().mockResolvedValue(undefined);

vi.mock('../../templates/EvaluatorRenderer', () => ({
  renderCodeBasedEvaluatorTemplate: (...args: unknown[]) => mockRenderCodeBased(...args),
  renderThirdPartyEvaluatorTemplate: (...args: unknown[]) => mockRenderThirdParty(...args),
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

  describe('buildThirdPartyConfig', () => {
    describe('deepeval', () => {
      const deepevalConfig = THIRD_PARTY_EVALUATOR_LIBRARIES.deepeval;

      it('returns config with deepeval defaults (300s)', () => {
        // eslint-disable-next-line @typescript-eslint/dot-notation
        const config = primitive['buildThirdPartyConfig']('my_eval', deepevalConfig);

        expect(config).toEqual({
          codeBased: {
            managed: {
              codeLocation: 'app/my_eval/',
              entrypoint: 'lambda_function.handler',
              timeoutSeconds: 300,
              additionalPolicies: ['execution-role-policy.json'],
            },
          },
        });
      });

      it('respects custom timeout', () => {
        // eslint-disable-next-line @typescript-eslint/dot-notation
        const config = primitive['buildThirdPartyConfig']('my_eval', deepevalConfig, '120');

        expect(config.codeBased!.managed!.timeoutSeconds).toBe(120);
      });
    });

    describe('autoevals', () => {
      const autoevalsConfig = THIRD_PARTY_EVALUATOR_LIBRARIES.autoevals;

      it('returns config with autoevals defaults (60s)', () => {
        // eslint-disable-next-line @typescript-eslint/dot-notation
        const config = primitive['buildThirdPartyConfig']('fact_check', autoevalsConfig);

        expect(config).toEqual({
          codeBased: {
            managed: {
              codeLocation: 'app/fact_check/',
              entrypoint: 'lambda_function.handler',
              timeoutSeconds: 60,
              additionalPolicies: ['execution-role-policy.json'],
            },
          },
        });
      });

      it('respects custom timeout', () => {
        // eslint-disable-next-line @typescript-eslint/dot-notation
        const config = primitive['buildThirdPartyConfig']('fact_check', autoevalsConfig, '180');

        expect(config.codeBased!.managed!.timeoutSeconds).toBe(180);
      });
    });
  });

  describe('add with thirdParty', () => {
    const deepEvalConfig: EvaluatorConfig = {
      codeBased: {
        managed: {
          codeLocation: 'app/deep_eval/',
          entrypoint: 'lambda_function.handler',
          timeoutSeconds: 300,
          additionalPolicies: ['execution-role-policy.json'],
        },
      },
    };

    const autoevalsEvalConfig: EvaluatorConfig = {
      codeBased: {
        managed: {
          codeLocation: 'app/auto_eval/',
          entrypoint: 'lambda_function.handler',
          timeoutSeconds: 60,
          additionalPolicies: ['execution-role-policy.json'],
        },
      },
    };

    it('calls renderThirdPartyEvaluatorTemplate with deepeval templateDir', async () => {
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
      expect(mockRenderThirdParty).toHaveBeenCalledOnce();
      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'deepeval-lambda',
        { Name: 'deep_eval', EvaluatorClass: 'AnswerRelevancyMetric', EvaluatorParams: 'threshold=0.7' },
        expect.stringContaining('app/deep_eval')
      );
      expect(mockRenderCodeBased).not.toHaveBeenCalled();
    });

    it('calls renderThirdPartyEvaluatorTemplate with autoevals templateDir', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      const result = await primitive.add({
        name: 'auto_eval',
        level: 'SESSION',
        config: autoevalsEvalConfig,
        thirdParty: {
          library: 'autoevals',
          metricClass: 'Factuality',
          metricParams: '',
        },
      });

      expect(result.success).toBe(true);
      expect(result).toHaveProperty('codePath', 'app/auto_eval/');
      expect(mockRenderThirdParty).toHaveBeenCalledOnce();
      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'autoevals-lambda',
        { Name: 'auto_eval', EvaluatorClass: 'Factuality', EvaluatorParams: '' },
        expect.stringContaining('app/auto_eval')
      );
      expect(mockRenderCodeBased).not.toHaveBeenCalled();
    });

    it('passes empty string for EvaluatorParams when not provided', async () => {
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

      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'deepeval-lambda',
        { Name: 'deep_eval', EvaluatorClass: 'HallucinationMetric', EvaluatorParams: '' },
        expect.any(String)
      );
    });

    it('passes ModelProviderBedrock to the template when modelProvider is bedrock', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'auto_eval',
        level: 'SESSION',
        config: autoevalsEvalConfig,
        thirdParty: {
          library: 'autoevals',
          metricClass: 'Factuality',
          metricParams: '',
          modelProvider: 'bedrock',
        },
      });

      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'autoevals-lambda',
        { Name: 'auto_eval', EvaluatorClass: 'Factuality', EvaluatorParams: '', ModelProviderBedrock: true },
        expect.stringContaining('app/auto_eval')
      );
    });

    it('passes Model to the template when model is provided with bedrock provider', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'auto_eval',
        level: 'SESSION',
        config: autoevalsEvalConfig,
        thirdParty: {
          library: 'autoevals',
          metricClass: 'Factuality',
          metricParams: 'threshold=0.5',
          modelProvider: 'bedrock',
          model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        },
      });

      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'autoevals-lambda',
        {
          Name: 'auto_eval',
          EvaluatorClass: 'Factuality',
          EvaluatorParams: 'threshold=0.5',
          ModelProviderBedrock: true,
          Model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
        },
        expect.stringContaining('app/auto_eval')
      );
    });

    it('passes Model to the deepeval template when model is provided with bedrock provider', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'deep_eval',
        level: 'SESSION',
        config: deepEvalConfig,
        thirdParty: {
          library: 'deepeval',
          metricClass: 'AnswerRelevancyMetric',
          metricParams: 'threshold=0.7',
          modelProvider: 'bedrock',
          model: 'anthropic.claude-3-haiku-20240307-v1:0',
        },
      });

      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'deepeval-lambda',
        {
          Name: 'deep_eval',
          EvaluatorClass: 'AnswerRelevancyMetric',
          EvaluatorParams: 'threshold=0.7',
          ModelProviderBedrock: true,
          Model: 'anthropic.claude-3-haiku-20240307-v1:0',
        },
        expect.stringContaining('app/deep_eval')
      );
    });

    it('omits Model from the render context when not provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'auto_eval',
        level: 'SESSION',
        config: autoevalsEvalConfig,
        thirdParty: {
          library: 'autoevals',
          metricClass: 'Factuality',
          metricParams: '',
          modelProvider: 'openai',
        },
      });

      const renderData = mockRenderThirdParty.mock.calls[0]![1] as Record<string, unknown>;
      expect(renderData).not.toHaveProperty('Model');
      expect(renderData).not.toHaveProperty('ModelProviderBedrock');
    });

    it('omits ModelProviderBedrock when modelProvider is openai', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'deep_eval',
        level: 'SESSION',
        config: deepEvalConfig,
        thirdParty: {
          library: 'deepeval',
          metricClass: 'AnswerRelevancyMetric',
          metricParams: 'threshold=0.7',
          modelProvider: 'openai',
        },
      });

      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'deepeval-lambda',
        { Name: 'deep_eval', EvaluatorClass: 'AnswerRelevancyMetric', EvaluatorParams: 'threshold=0.7' },
        expect.stringContaining('app/deep_eval')
      );
    });

    it('omits ModelProviderBedrock when modelProvider is not set (backwards compatible)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      mockWriteProjectSpec.mockResolvedValue(undefined);

      await primitive.add({
        name: 'auto_eval',
        level: 'SESSION',
        config: autoevalsEvalConfig,
        thirdParty: {
          library: 'autoevals',
          metricClass: 'Factuality',
          metricParams: '',
        },
      });

      expect(mockRenderThirdParty).toHaveBeenCalledWith(
        'autoevals-lambda',
        { Name: 'auto_eval', EvaluatorClass: 'Factuality', EvaluatorParams: '' },
        expect.stringContaining('app/auto_eval')
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
      expect(mockRenderThirdParty).not.toHaveBeenCalled();
    });
  });
});

describe('THIRD_PARTY_EVALUATOR_LIBRARIES registry', () => {
  it('contains deepeval with expected defaults', () => {
    const config = THIRD_PARTY_EVALUATOR_LIBRARIES.deepeval;
    expect(config).toBeDefined();
    expect(config.templateDir).toBe('deepeval-lambda');
    expect(config.defaultTimeoutSeconds).toBe(300);
  });

  it('contains autoevals with expected defaults', () => {
    const config = THIRD_PARTY_EVALUATOR_LIBRARIES.autoevals;
    expect(config).toBeDefined();
    expect(config.templateDir).toBe('autoevals-lambda');
    expect(config.defaultTimeoutSeconds).toBe(60);
  });

  it('deepeval has warnings for retrieval_context metrics', () => {
    const config = THIRD_PARTY_EVALUATOR_LIBRARIES.deepeval;
    const retrievalWarning = config.warnings.find(w => w.metrics.has('FaithfulnessMetric'));
    expect(retrievalWarning).toBeDefined();
    expect(retrievalWarning!.message).toContain('retrieval_context');
    expect(retrievalWarning!.metrics.has('HallucinationMetric')).toBe(true);
    expect(retrievalWarning!.metrics.has('ContextualRelevancyMetric')).toBe(true);
  });

  it('deepeval has warnings for expected_output metrics', () => {
    const config = THIRD_PARTY_EVALUATOR_LIBRARIES.deepeval;
    const expectedWarning = config.warnings.find(
      w => w.metrics.has('ContextualPrecisionMetric') && w.message.includes('expected_output')
    );
    expect(expectedWarning).toBeDefined();
    expect(expectedWarning!.message).toContain('expected_output');
  });

  it('autoevals has warnings for reference-input metrics', () => {
    const config = THIRD_PARTY_EVALUATOR_LIBRARIES.autoevals;
    const factWarning = config.warnings.find(w => w.metrics.has('Factuality'));
    expect(factWarning).toBeDefined();
    expect(factWarning!.message).toContain('expected_output');
    expect(factWarning!.metrics.has('ClosedQA')).toBe(true);
  });

  it('autoevals has warnings for SQL metric', () => {
    const config = THIRD_PARTY_EVALUATOR_LIBRARIES.autoevals;
    const sqlWarning = config.warnings.find(w => w.metrics.has('SQL'));
    expect(sqlWarning).toBeDefined();
    expect(sqlWarning!.message).toContain('reference SQL');
  });

  it('does not contain unsupported libraries', () => {
    expect((THIRD_PARTY_EVALUATOR_LIBRARIES as Record<string, unknown>).ragas).toBeUndefined();
    expect((THIRD_PARTY_EVALUATOR_LIBRARIES as Record<string, unknown>).langsmith).toBeUndefined();
  });
});

describe('MODEL_PROVIDERS', () => {
  it('supports openai and bedrock only', () => {
    expect(MODEL_PROVIDERS).toEqual(['openai', 'bedrock']);
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
