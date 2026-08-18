import {
  ConflictError,
  ResourceNotFoundError,
  createConfigIO,
  findConfigRoot,
  serializeResult,
  toError,
} from '../../lib';
import type { Result } from '../../lib/result';
import type { EvaluationLevel, Evaluator, EvaluatorConfig } from '../../schema';
import {
  BASE_EVALUATOR_ID_PATTERN,
  EvaluationLevelSchema,
  EvaluatorModelIdSchema,
  EvaluatorModelProviderSchema,
  EvaluatorSchema,
  isValidKmsKeyArn,
} from '../../schema';
import { getEvaluator } from '../aws/agentcore-control';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import {
  EvaluatorLevel,
  EvaluatorModelProvider,
  EvaluatorType,
  standardize,
} from '../telemetry/schemas/common-shapes.js';
import { renderCodeBasedEvaluatorTemplate, renderThirdPartyEvaluatorTemplate } from '../templates/EvaluatorRenderer';
import { requireTTY } from '../tui/guards/tty';
import {
  LEVEL_PLACEHOLDERS,
  RATING_SCALE_PRESETS,
  parseCustomRatingScale,
  validateInstructionPlaceholders,
} from '../tui/screens/evaluator/types';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ============================================================================
// Third-Party Library Registry
// ============================================================================

interface MetricWarning {
  metrics: Set<string>;
  message: string;
}

export interface ThirdPartyLibraryConfig {
  templateDir: string;
  defaultTimeoutSeconds: number;
  warnings: MetricWarning[];
}

export const THIRD_PARTY_EVALUATOR_LIBRARIES = {
  deepeval: {
    templateDir: 'deepeval-lambda',
    defaultTimeoutSeconds: 300,
    warnings: [
      {
        metrics: new Set([
          'FaithfulnessMetric',
          'HallucinationMetric',
          'ContextualRelevancyMetric',
          'ContextualPrecisionMetric',
          'ContextualRecallMetric',
        ]),
        message:
          'requires retrieval_context from tool-role messages. ' +
          'If your agent has no tool calls, the evaluator will return MISSING_REQUIRED_FIELD at runtime.',
      },
      {
        metrics: new Set(['ContextualPrecisionMetric', 'ContextualRecallMetric']),
        message:
          'requires expected_output via evaluationReferenceInputs. ' +
          'Caller must provide referenceInputs when invoking the Evaluate API.',
      },
    ],
  },
  autoevals: {
    templateDir: 'autoevals-lambda',
    defaultTimeoutSeconds: 60,
    warnings: [
      {
        metrics: new Set(['Factuality', 'ClosedQA']),
        message:
          'requires expected_output via evaluationReferenceInputs. ' +
          'Caller must provide referenceInputs when invoking the Evaluate API.',
      },
      {
        metrics: new Set(['SQL']),
        message:
          'requires expected_output (reference SQL) via evaluationReferenceInputs. ' +
          'Caller must provide referenceInputs when invoking the Evaluate API.',
      },
    ],
  },
} satisfies Record<string, ThirdPartyLibraryConfig>;

export type ThirdPartyLibrary = keyof typeof THIRD_PARTY_EVALUATOR_LIBRARIES;

const SUPPORTED_LIBRARIES: ThirdPartyLibrary[] = Object.keys(THIRD_PARTY_EVALUATOR_LIBRARIES) as ThirdPartyLibrary[];

function isSupportedLibrary(value: string): value is ThirdPartyLibrary {
  return Object.prototype.hasOwnProperty.call(THIRD_PARTY_EVALUATOR_LIBRARIES, value);
}

export const MODEL_PROVIDERS = ['openai', 'bedrock'] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

function normalizeModelProvider(value: string): ModelProvider | undefined {
  const normalized = value.toLowerCase();
  return (MODEL_PROVIDERS as readonly string[]).includes(normalized) ? (normalized as ModelProvider) : undefined;
}

// ============================================================================
// Types
// ============================================================================

export interface ThirdPartyLibraryOptions {
  library: ThirdPartyLibrary;
  metricClass: string;
  metricParams?: string;
  /** LLM judge provider; defaults to the library's built-in default (OpenAI). */
  modelProvider?: ModelProvider;
  /** Bedrock model ID (required when modelProvider is 'bedrock'). */
  model?: string;
}

export interface AddEvaluatorOptions {
  name: string;
  // Required. For a derived evaluator the CLI resolves it from the base metric
  // before calling add(); other types take it from --level.
  level?: EvaluationLevel;
  description?: string;
  config: EvaluatorConfig;
  kmsKeyArn?: string;
  thirdParty?: ThirdPartyLibraryOptions;
}

export type RemovableEvaluator = RemovableResource;

// ============================================================================
// Constants & Utilities
// ============================================================================

const DEFAULT_CODE_ENTRYPOINT = 'lambda_function.handler';
const DEFAULT_CODE_TIMEOUT = 60;

export function jsonToPythonValue(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonToPythonValue).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${jsonToPythonValue(v)}`).join(', ')}}`;
  }
  return String(value as string | number | boolean);
}

export function jsonToKwargs(json: string): string {
  const obj: unknown = JSON.parse(json);
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Expected a JSON object of keyword arguments');
  }
  return Object.entries(obj as Record<string, unknown>)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid Python kwarg name "${key}"`);
      }
      return `${key}=${jsonToPythonValue(value)}`;
    })
    .join(', ');
}

function getWarningsForMetric(libraryConfig: ThirdPartyLibraryConfig, metricClass: string): string[] {
  const messages: string[] = [];
  for (const warning of libraryConfig.warnings) {
    if (warning.metrics.has(metricClass)) {
      messages.push(`⚠️ ${metricClass} ${warning.message}`);
    }
  }
  return messages;
}

// ============================================================================
// EvaluatorPrimitive
// ============================================================================

/**
 * EvaluatorPrimitive handles all evaluator add/remove operations.
 */
export class EvaluatorPrimitive extends BasePrimitive<AddEvaluatorOptions, RemovableEvaluator> {
  readonly kind = 'evaluator' as const;
  readonly label = 'Evaluator';
  override readonly article = 'an';
  readonly primitiveSchema = EvaluatorSchema;

  async add(options: AddEvaluatorOptions): Promise<AddResult<{ evaluatorName: string; codePath?: string }>> {
    try {
      const evaluator = await this.createEvaluator(options);

      // Scaffold code for managed code-based evaluators
      if (options.config.codeBased?.managed) {
        const configRoot = findConfigRoot()!;
        const projectRoot = dirname(configRoot);
        const codeLocation = options.config.codeBased.managed.codeLocation;
        const targetDir = join(projectRoot, codeLocation);

        if (options.thirdParty) {
          const libraryConfig = THIRD_PARTY_EVALUATOR_LIBRARIES[options.thirdParty.library];
          await renderThirdPartyEvaluatorTemplate(
            libraryConfig.templateDir,
            {
              Name: options.name,
              EvaluatorClass: options.thirdParty.metricClass,
              EvaluatorParams: options.thirdParty.metricParams ?? '',
              // Omitted for the default (openai) so Handlebars treats it as falsy.
              ...(options.thirdParty.modelProvider === 'bedrock' && { ModelProviderBedrock: true }),
              ...(options.thirdParty.model && { Model: options.thirdParty.model }),
            },
            targetDir
          );
        } else {
          await renderCodeBasedEvaluatorTemplate(options.name, targetDir);
        }
        return { success: true, evaluatorName: evaluator.name, codePath: codeLocation };
      }

      return { success: true, evaluatorName: evaluator.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(evaluatorName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const index = project.evaluators.findIndex(e => e.name === evaluatorName);
      if (index === -1) {
        return { success: false, error: new ResourceNotFoundError(`Evaluator "${evaluatorName}" not found.`) };
      }

      // Warn if referenced by online eval configs
      const referencingConfigs = project.onlineEvalConfigs.filter(c => c.evaluators?.includes(evaluatorName));
      if (referencingConfigs.length > 0) {
        const configNames = referencingConfigs.map(c => c.name).join(', ');
        return {
          success: false,
          error: new ConflictError(
            `Evaluator "${evaluatorName}" is referenced by online eval config(s): ${configNames}. Remove those references first.`
          ),
        };
      }

      // Delete scaffolded code directory for managed code-based evaluators
      const evaluator = project.evaluators[index]!;
      if (evaluator.config.codeBased?.managed) {
        const configRoot = findConfigRoot()!;
        const projectRoot = dirname(configRoot);
        const codeDir = join(projectRoot, evaluator.config.codeBased.managed.codeLocation);
        if (existsSync(codeDir)) {
          await rm(codeDir, { recursive: true, force: true });
        }
      }

      project.evaluators.splice(index, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(evaluatorName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const evaluator = project.evaluators.find(e => e.name === evaluatorName);
    if (!evaluator) {
      throw new Error(`Evaluator "${evaluatorName}" not found.`);
    }

    const summary: string[] = [`Removing evaluator: ${evaluatorName}`];
    const directoriesToDelete: string[] = [];
    const schemaChanges: SchemaChange[] = [];

    const referencingConfigs = project.onlineEvalConfigs.filter(c => c.evaluators?.includes(evaluatorName));
    if (referencingConfigs.length > 0) {
      summary.push(
        `Blocked: Referenced by online eval config(s): ${referencingConfigs.map(c => c.name).join(', ')}. Remove those references first.`
      );
    }

    // Preview code directory deletion for managed code-based evaluators
    if (evaluator.config.codeBased?.managed) {
      const configRoot = findConfigRoot()!;
      const projectRoot = dirname(configRoot);
      const codeLocation = evaluator.config.codeBased.managed.codeLocation;
      const codeDir = join(projectRoot, codeLocation);
      if (existsSync(codeDir)) {
        directoriesToDelete.push(codeLocation);
        summary.push(`Will delete directory: ${codeLocation}`);
      }
    }

    const afterSpec = {
      ...project,
      evaluators: project.evaluators.filter(e => e.name !== evaluatorName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete, schemaChanges };
  }

  async getRemovable(): Promise<RemovableEvaluator[]> {
    try {
      const project = await this.readProjectSpec();
      return project.evaluators.map(e => ({ name: e.name }));
    } catch {
      return [];
    }
  }

  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return project.evaluators.map(e => e.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    const presetIds = RATING_SCALE_PRESETS.map(p => p.id);

    addCmd
      .command(this.kind)
      .description('Add a custom evaluator to the project')
      .option('--name <name>', 'Evaluator name')
      .option(
        '--level <level>',
        'Evaluation level: SESSION, TRACE, TOOL_CALL (auto-resolved from the base for --type derived)'
      )
      .option('--type <type>', 'Evaluator type: llm-as-a-judge (default), code-based, or derived')
      .option(
        '--model <model>',
        '[LLM] Bedrock inference profile ID or OpenResponses model ID; [derived] Bedrock inference profile ID for the judge model'
      )
      .option('--model-provider <provider>', '[LLM] Model provider: Bedrock (default) or OpenResponses')
      .option(
        '--base-evaluator-id <id>',
        '[derived] Managed base metric to derive from: "ThirdParty.<Provider>.<Metric>" or "Builtin.<Metric>"'
      )
      .option(
        '--instructions <text>',
        '[LLM] Evaluation prompt instructions (must include level-appropriate placeholders, e.g. {context})'
      )
      .option('--rating-scale <preset>', `[LLM] Rating scale preset: ${presetIds.join(', ')} (default: 1-5-quality)`)
      .option('--lambda-arn <arn>', '[Code-based] Existing Lambda function ARN (external)')
      .option('--timeout <seconds>', '[Code-based] Lambda timeout in seconds, 1-300 (default: 60)')
      .option(
        '--3p-template-json <json>',
        '[Code-based] Inline JSON with 3P library config: {"library", "metric", "modelProvider", "model", "params"}'
      )
      .option(
        '--3p-template-json-file <path>',
        '[Code-based] Path to JSON file with 3P library config (same format as --3p-template-json)'
      )
      .option(
        '--config <path>',
        'Path to evaluator config JSON file (overrides --model, --instructions, --rating-scale) [non-interactive]'
      )
      .option('--kms-key-arn <arn>', 'KMS key ARN for evaluator encryption (optional)')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          level?: string;
          type?: string;
          model?: string;
          modelProvider?: string;
          baseEvaluatorId?: string;
          instructions?: string;
          ratingScale?: string;
          lambdaArn?: string;
          timeout?: string;
          '3pTemplateJson'?: string;
          '3pTemplateJsonFile'?: string;
          config?: string;
          kmsKeyArn?: string;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.json) {
            await runCliCommand('add.evaluator', !!cliOptions.json, async () => {
              const fail = (error: string): never => {
                throw new Error(error);
              };

              // A derived evaluator resolves its level from the base metric, so
              // --level is optional (an offline override); required otherwise.
              const isDerived = cliOptions.type === 'derived' || cliOptions.baseEvaluatorId !== undefined;

              if (!cliOptions.name) {
                fail('--name is required in non-interactive mode');
              }
              if (!isDerived && !cliOptions.level) {
                fail('--level is required in non-interactive mode');
              }

              const levelResult = cliOptions.level ? EvaluationLevelSchema.safeParse(cliOptions.level) : undefined;
              if (levelResult && !levelResult.success) {
                fail(`Invalid --level "${cliOptions.level}". Must be one of: SESSION, TRACE, TOOL_CALL`);
              }

              // Parse --3p-template-json or --3p-template-json-file
              if (cliOptions['3pTemplateJson'] && cliOptions['3pTemplateJsonFile']) {
                fail('--3p-template-json and --3p-template-json-file cannot be used together');
              }
              let templateJsonStr: string | undefined;
              if (cliOptions['3pTemplateJson']) {
                templateJsonStr = cliOptions['3pTemplateJson'];
              } else if (cliOptions['3pTemplateJsonFile']) {
                if (!existsSync(cliOptions['3pTemplateJsonFile'])) {
                  fail(`--3p-template-json-file not found: ${cliOptions['3pTemplateJsonFile']}`);
                }
                templateJsonStr = readFileSync(cliOptions['3pTemplateJsonFile'], 'utf-8');
              }

              let threePLibrary: ThirdPartyLibrary | undefined;
              let threePMetric: string | undefined;
              let threePModelProvider: ModelProvider | undefined;
              let threePModel: string | undefined;
              let threePParams: string | undefined;

              if (templateJsonStr) {
                let templateObj: Record<string, unknown>;
                try {
                  templateObj = JSON.parse(templateJsonStr) as Record<string, unknown>;
                } catch {
                  throw new Error('--3p-template-json must be valid JSON');
                }
                if (!templateObj.library || typeof templateObj.library !== 'string') {
                  fail('--3p-template-json must include "library" (e.g. "deepeval" or "autoevals")');
                }
                if (!templateObj.metric || typeof templateObj.metric !== 'string') {
                  fail('--3p-template-json must include "metric" (e.g. "AnswerRelevancyMetric")');
                }
                const rawLibrary = String(templateObj.library);
                if (!isSupportedLibrary(rawLibrary)) {
                  fail(`Invalid library "${rawLibrary}". Supported: ${SUPPORTED_LIBRARIES.join(', ')}`);
                }
                threePLibrary = rawLibrary as ThirdPartyLibrary;
                threePMetric = templateObj.metric as string;
                if (templateObj.modelProvider) {
                  const rawProvider = templateObj.modelProvider as string;
                  const normalizedProvider = normalizeModelProvider(rawProvider);
                  if (!normalizedProvider) {
                    fail(`Invalid modelProvider "${rawProvider}". Supported: ${MODEL_PROVIDERS.join(', ')}`);
                  }
                  threePModelProvider = normalizedProvider;
                }
                if (templateObj.model) threePModel = templateObj.model as string;
                if (templateObj.params && typeof templateObj.params === 'object') {
                  try {
                    threePParams = Object.entries(templateObj.params as Record<string, unknown>)
                      .map(([k, v]) => {
                        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                          throw new Error(`Invalid Python kwarg name "${k}"`);
                        }
                        return `${k}=${jsonToPythonValue(v)}`;
                      })
                      .join(', ');
                  } catch (e) {
                    fail(`Invalid params in --3p-template-json: ${getErrorMessage(e)}`);
                  }
                }
                // Default modelProvider to 'bedrock' only when model is provided
                if (!threePModelProvider && threePModel) {
                  threePModelProvider = 'bedrock';
                }
                if (threePModelProvider === 'bedrock' && !threePModel) {
                  fail(
                    '--3p-template-json requires "model" when modelProvider is bedrock. ' +
                      'Pass a Bedrock inference profile ID (e.g. us.anthropic.claude-sonnet-4-20250514-v1:0)'
                  );
                }
                if (threePModelProvider === 'openai') {
                  console.warn(
                    '\n  ⚠️  OpenAI model provider selected. You must set OPENAI_API_KEY as a Lambda ' +
                      'environment variable after deployment.\n'
                  );
                }
              }

              if (cliOptions.timeout) {
                const timeoutVal = parseInt(cliOptions.timeout, 10);
                if (isNaN(timeoutVal) || timeoutVal < 1 || timeoutVal > 300) {
                  fail('--timeout must be an integer between 1 and 300');
                }
              }

              // Default --type: derived when a base id is given, else code-based when a
              // 3P (code) template is provided, else llm-as-a-judge.
              const evalType =
                cliOptions.type ?? (isDerived ? 'derived' : threePLibrary ? 'code-based' : 'llm-as-a-judge');
              if (evalType !== 'llm-as-a-judge' && evalType !== 'code-based' && evalType !== 'derived') {
                fail(`Invalid --type "${evalType}". Must be one of: llm-as-a-judge, code-based, derived`);
              }

              // Cross-validate flags against evaluator type
              if (evalType !== 'code-based') {
                if (cliOptions.lambdaArn) fail('--lambda-arn requires --type code-based');
                if (cliOptions.timeout) fail('--timeout requires --type code-based');
                if (threePLibrary) fail('--3p-template-json requires --type code-based');
              }
              if (evalType !== 'derived' && cliOptions.baseEvaluatorId) {
                fail('--base-evaluator-id requires --type derived');
              }
              if (evalType === 'code-based') {
                if (cliOptions.model) fail('--model cannot be used with --type code-based');
                if (cliOptions.modelProvider) fail('--model-provider cannot be used with --type code-based');
                if (cliOptions.instructions) fail('--instructions cannot be used with --type code-based');
                if (cliOptions.ratingScale) fail('--rating-scale cannot be used with --type code-based');
              }
              if (evalType === 'derived') {
                // The base metric owns the prompt and scale.
                if (cliOptions.instructions) fail('--instructions cannot be used with --type derived');
                if (cliOptions.ratingScale) fail('--rating-scale cannot be used with --type derived');
                if (cliOptions.modelProvider) fail('--model-provider cannot be used with --type derived');
              }
              if (cliOptions.config && cliOptions.modelProvider) {
                fail(
                  '--model-provider cannot be used with --config; set config.llmAsAJudge.modelProvider in the config file'
                );
              }

              let configJson: EvaluatorConfig;
              let thirdParty: ThirdPartyLibraryOptions | undefined;
              // For derived, the level is resolved from the base metric (or --level override).
              let resolvedLevel: EvaluationLevel | undefined = levelResult?.data;

              if (evalType === 'derived') {
                // --config carries a full evaluator config for other types; a derived
                // evaluator is built from --base-evaluator-id + --model, so reject
                // --config here rather than silently ignoring it.
                if (cliOptions.config) {
                  fail('--config is not supported with --type derived; use --base-evaluator-id and --model');
                }
                if (!cliOptions.baseEvaluatorId) {
                  fail('--base-evaluator-id is required for --type derived');
                }
                if (!cliOptions.model) {
                  fail('--model is required for --type derived (you bring the judge model)');
                }
                if (!BASE_EVALUATOR_ID_PATTERN.test(cliOptions.baseEvaluatorId!)) {
                  fail(
                    `Invalid --base-evaluator-id "${cliOptions.baseEvaluatorId}". ` +
                      'Must be "ThirdParty.<Provider>.<Metric>" or "Builtin.<Metric>"'
                  );
                }
                // The service requires the derived evaluator's level to match the base
                // metric's level. Resolve it via GetEvaluator so the customer never has
                // to know or type it; --level stays available as an offline override.
                resolvedLevel ??= await this.resolveBaseEvaluatorLevel(cliOptions.baseEvaluatorId!);
                configJson = {
                  derived: {
                    baseEvaluatorId: cliOptions.baseEvaluatorId!,
                    model: cliOptions.model!,
                  },
                };
              } else if (threePLibrary) {
                const libraryConfig = THIRD_PARTY_EVALUATOR_LIBRARIES[threePLibrary];
                configJson = this.buildThirdPartyConfig(cliOptions.name!, libraryConfig, cliOptions.timeout);
                thirdParty = {
                  library: threePLibrary,
                  metricClass: threePMetric!,
                  metricParams: threePParams,
                  modelProvider: threePModelProvider,
                  model: threePModel,
                };
              } else if (cliOptions.config) {
                configJson = JSON.parse(readFileSync(cliOptions.config, 'utf-8')) as EvaluatorConfig;
              } else if (evalType === 'code-based') {
                configJson = this.buildCodeBasedConfig(cliOptions.name!, cliOptions.lambdaArn, cliOptions.timeout);
              } else {
                // LLM-as-a-Judge flow
                if (!cliOptions.model) {
                  fail('Either --config or --model is required for LLM-as-a-Judge evaluators');
                }

                const modelResult = EvaluatorModelIdSchema.safeParse(cliOptions.model);
                if (!modelResult.success) {
                  fail(modelResult.error.issues[0]?.message ?? 'Invalid --model');
                }

                const modelProviderResult = EvaluatorModelProviderSchema.safeParse(
                  cliOptions.modelProvider ?? 'Bedrock'
                );
                if (!modelProviderResult.success) {
                  fail(
                    `Invalid --model-provider "${cliOptions.modelProvider}". Must be one of: Bedrock, OpenResponses`
                  );
                }
                const modelProvider = modelProviderResult.data!;

                if (!cliOptions.instructions) {
                  const level = levelResult!.data!;
                  const placeholders = LEVEL_PLACEHOLDERS[level].map(p => `{${p}}`).join(', ');
                  fail(
                    `--instructions is required in non-interactive mode (or use --config). ` +
                      `Must include at least one placeholder for ${level}: ${placeholders}`
                  );
                }

                const placeholderCheck = validateInstructionPlaceholders(cliOptions.instructions!, levelResult!.data!);
                if (placeholderCheck !== true) {
                  fail(placeholderCheck);
                }

                let ratingScale: NonNullable<EvaluatorConfig['llmAsAJudge']>['ratingScale'];
                const scaleInput = cliOptions.ratingScale ?? '1-5-quality';

                const preset = RATING_SCALE_PRESETS.find(p => p.id === scaleInput);
                if (preset) {
                  ratingScale = preset.ratingScale;
                } else {
                  const isNumerical = /^\d/.test(scaleInput.trim());
                  const parsed = parseCustomRatingScale(scaleInput, isNumerical ? 'numerical' : 'categorical');
                  if (!parsed.success) {
                    fail(
                      `Invalid --rating-scale "${scaleInput}". Use a preset (${presetIds.join(', ')}) ` +
                        `or custom format: "1:Label:Definition, 2:Label:Definition" (numerical) ` +
                        `or "Label:Definition, Label:Definition" (categorical)`
                    );
                  }
                  ratingScale = parsed.success ? parsed.ratingScale : undefined!;
                }

                configJson = {
                  llmAsAJudge: {
                    ...(modelProvider === 'OpenResponses' && { modelProvider }),
                    model: modelResult.data!,
                    instructions: cliOptions.instructions!,
                    ratingScale,
                  },
                };
              }

              if (cliOptions.kmsKeyArn && !isValidKmsKeyArn(cliOptions.kmsKeyArn)) {
                fail(
                  '--kms-key-arn must be a valid KMS key ARN (e.g. arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012)'
                );
              }

              const result = await this.add({
                name: cliOptions.name!,
                level: resolvedLevel,
                config: configJson,
                kmsKeyArn: cliOptions.kmsKeyArn,
                thirdParty,
              });

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else {
                if (result.codePath) {
                  console.log(`Created evaluator '${result.evaluatorName}'`);
                  console.log(`  Code: ${result.codePath}lambda_function.py`);
                  console.log(`  IAM:  ${result.codePath}execution-role-policy.json`);
                  console.log(
                    `\n  Next: Edit lambda_function.py with your evaluation logic, then run \`agentcore deploy\``
                  );
                } else if (evalType === 'derived') {
                  console.log(
                    `Added evaluator '${result.evaluatorName}' (derived from ${cliOptions.baseEvaluatorId} evaluator)`
                  );
                } else {
                  console.log(`Added evaluator '${result.evaluatorName}'`);
                }

                if (thirdParty) {
                  const libraryConfig = THIRD_PARTY_EVALUATOR_LIBRARIES[thirdParty.library];
                  const warnings = getWarningsForMetric(libraryConfig, thirdParty.metricClass);
                  for (const warning of warnings) {
                    console.warn(`\n  ${warning}`);
                  }
                  if (thirdParty.modelProvider === 'openai') {
                    console.warn(
                      '\n  ⚠️  OpenAI model provider selected. You must set OPENAI_API_KEY as a Lambda ' +
                        'environment variable for the evaluator to call the LLM judge.'
                    );
                  }
                }
              }

              return {
                evaluator_type: standardize(EvaluatorType, evalType),
                evaluator_level: standardize(EvaluatorLevel, resolvedLevel),
                ...(configJson.llmAsAJudge && {
                  evaluator_model_provider: standardize(
                    EvaluatorModelProvider,
                    configJson.llmAsAJudge.modelProvider ?? 'Bedrock'
                  ),
                }),
              };
            });
          } else {
            try {
              // TUI fallback
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'evaluator',
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
            } catch (error) {
              console.error(getErrorMessage(error));
              process.exit(1);
            }
          }
        }
      );

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  private buildCodeBasedConfig(name: string, lambdaArn?: string, timeoutStr?: string): EvaluatorConfig {
    if (lambdaArn) {
      return {
        codeBased: {
          external: { lambdaArn },
        },
      };
    }

    const timeoutSeconds = timeoutStr ? parseInt(timeoutStr, 10) : DEFAULT_CODE_TIMEOUT;
    return {
      codeBased: {
        managed: {
          codeLocation: `app/${name}/`,
          entrypoint: DEFAULT_CODE_ENTRYPOINT,
          timeoutSeconds,
          additionalPolicies: ['execution-role-policy.json'],
        },
      },
    };
  }

  private buildThirdPartyConfig(
    name: string,
    libraryConfig: ThirdPartyLibraryConfig,
    timeoutStr?: string
  ): EvaluatorConfig {
    const timeoutSeconds = timeoutStr ? parseInt(timeoutStr, 10) : libraryConfig.defaultTimeoutSeconds;
    return {
      codeBased: {
        managed: {
          codeLocation: `app/${name}/`,
          entrypoint: DEFAULT_CODE_ENTRYPOINT,
          timeoutSeconds,
          additionalPolicies: ['execution-role-policy.json'],
        },
      },
    };
  }

  /**
   * Resolve a derived evaluator's level from its base metric. The service requires
   * the derived evaluator's level to match the base's, so we read it via
   * GetEvaluator instead of asking the customer to know it.
   */
  private async resolveBaseEvaluatorLevel(baseEvaluatorId: string): Promise<EvaluationLevel> {
    // A fresh project has no saved deploy targets, so resolve the region directly
    // from the environment/profile fallback (env vars, then the AWS profile's region).
    let region: string | undefined;
    try {
      region = await createConfigIO().resolveRegionFallback();
    } catch {
      region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    }
    if (!region) {
      throw new Error(
        `Could not resolve an AWS region to look up "${baseEvaluatorId}". Set AWS_REGION or pass --level explicitly.`
      );
    }
    try {
      const base = await getEvaluator({ region, evaluatorId: baseEvaluatorId });
      return base.level;
    } catch (err) {
      throw new Error(
        `Could not resolve the level for base evaluator "${baseEvaluatorId}": ${getErrorMessage(err)}. ` +
          'Pass --level explicitly to override.'
      );
    }
  }

  private async createEvaluator(options: AddEvaluatorOptions): Promise<Evaluator> {
    if (!options.level) {
      throw new Error('Evaluation level is required (SESSION, TRACE, or TOOL_CALL)');
    }

    const evaluator: Evaluator = {
      name: options.name,
      level: options.level,
      ...(options.description && { description: options.description }),
      config: options.config,
      ...(options.kmsKeyArn && { kmsKeyArn: options.kmsKeyArn }),
    };

    await this.updateProjectSpec(project => {
      this.checkDuplicate(project.evaluators, options.name);
      project.evaluators.push(evaluator);
    });

    return evaluator;
  }
}
