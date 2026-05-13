import { findConfigRoot } from '../../lib';
import type { EvaluationLevel, Evaluator, EvaluatorConfig } from '../../schema';
import { EvaluationLevelSchema, EvaluatorSchema, isValidKmsKeyArn } from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { EvaluatorType, Level, standardize } from '../telemetry/schemas/common-shapes.js';
import { renderCodeBasedEvaluatorTemplate } from '../templates/EvaluatorRenderer';
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
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AddEvaluatorOptions {
  name: string;
  level: EvaluationLevel;
  description?: string;
  config: EvaluatorConfig;
  kmsKeyArn?: string;
}

export type RemovableEvaluator = RemovableResource;

const DEFAULT_CODE_ENTRYPOINT = 'lambda_function.handler';
const DEFAULT_CODE_TIMEOUT = 60;

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
        await renderCodeBasedEvaluatorTemplate(options.name, targetDir);
        return { success: true, evaluatorName: evaluator.name, codePath: codeLocation };
      }

      return { success: true, evaluatorName: evaluator.name };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(evaluatorName: string): Promise<RemovalResult> {
    try {
      const project = await this.readProjectSpec();

      const index = project.evaluators.findIndex(e => e.name === evaluatorName);
      if (index === -1) {
        return { success: false, error: `Evaluator "${evaluatorName}" not found.` };
      }

      // Warn if referenced by online eval configs
      const referencingConfigs = project.onlineEvalConfigs.filter(c => c.evaluators.includes(evaluatorName));
      if (referencingConfigs.length > 0) {
        const configNames = referencingConfigs.map(c => c.name).join(', ');
        return {
          success: false,
          error: `Evaluator "${evaluatorName}" is referenced by online eval config(s): ${configNames}. Remove those references first.`,
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
      return { success: false, error: getErrorMessage(err) };
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

    const referencingConfigs = project.onlineEvalConfigs.filter(c => c.evaluators.includes(evaluatorName));
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
      .option('--level <level>', 'Evaluation level: SESSION, TRACE, TOOL_CALL')
      .option('--type <type>', 'Evaluator type: llm-as-a-judge (default) or code-based')
      .option('--model <model>', '[LLM] Bedrock model ID for LLM-as-a-Judge')
      .option(
        '--instructions <text>',
        '[LLM] Evaluation prompt instructions (must include level-appropriate placeholders, e.g. {context})'
      )
      .option('--rating-scale <preset>', `[LLM] Rating scale preset: ${presetIds.join(', ')} (default: 1-5-quality)`)
      .option('--lambda-arn <arn>', '[Code-based] Existing Lambda function ARN (external)')
      .option('--timeout <seconds>', '[Code-based] Lambda timeout in seconds, 1-300 (default: 60)')
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
          instructions?: string;
          ratingScale?: string;
          lambdaArn?: string;
          timeout?: string;
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

              if (!cliOptions.name || !cliOptions.level) {
                fail('--name and --level are required in non-interactive mode');
              }

              const levelResult = EvaluationLevelSchema.safeParse(cliOptions.level);
              if (!levelResult.success) {
                fail(`Invalid --level "${cliOptions.level}". Must be one of: SESSION, TRACE, TOOL_CALL`);
              }

              const evalType = cliOptions.type ?? 'llm-as-a-judge';
              if (evalType !== 'llm-as-a-judge' && evalType !== 'code-based') {
                fail(`Invalid --type "${evalType}". Must be one of: llm-as-a-judge, code-based`);
              }

              // Cross-validate flags against evaluator type
              if (evalType !== 'code-based') {
                if (cliOptions.lambdaArn) fail('--lambda-arn requires --type code-based');
                if (cliOptions.timeout) fail('--timeout requires --type code-based');
              }
              if (evalType === 'code-based') {
                if (cliOptions.model) fail('--model cannot be used with --type code-based');
                if (cliOptions.instructions) fail('--instructions cannot be used with --type code-based');
                if (cliOptions.ratingScale) fail('--rating-scale cannot be used with --type code-based');
              }

              let configJson: EvaluatorConfig;

              if (cliOptions.config) {
                const { readFileSync } = await import('fs');
                configJson = JSON.parse(readFileSync(cliOptions.config, 'utf-8')) as EvaluatorConfig;
              } else if (evalType === 'code-based') {
                configJson = this.buildCodeBasedConfig(cliOptions.name!, cliOptions.lambdaArn, cliOptions.timeout);
              } else {
                // LLM-as-a-Judge flow
                if (!cliOptions.model) {
                  fail('Either --config or --model is required for LLM-as-a-Judge evaluators');
                }

                if (!cliOptions.instructions) {
                  const level = levelResult.data!;
                  const placeholders = LEVEL_PLACEHOLDERS[level].map(p => `{${p}}`).join(', ');
                  fail(
                    `--instructions is required in non-interactive mode (or use --config). ` +
                      `Must include at least one placeholder for ${level}: ${placeholders}`
                  );
                }

                const placeholderCheck = validateInstructionPlaceholders(cliOptions.instructions!, levelResult.data!);
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
                    model: cliOptions.model!,
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
                level: levelResult.data!,
                config: configJson,
                kmsKeyArn: cliOptions.kmsKeyArn,
              });

              if (!result.success) {
                throw new Error(result.error);
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(result));
              } else {
                if (result.codePath) {
                  console.log(`Created evaluator '${result.evaluatorName}'`);
                  console.log(`  Code: ${result.codePath}lambda_function.py`);
                  console.log(`  IAM:  ${result.codePath}execution-role-policy.json`);
                  console.log(
                    `\n  Next: Edit lambda_function.py with your evaluation logic, then run \`agentcore deploy\``
                  );
                } else {
                  console.log(`Added evaluator '${result.evaluatorName}'`);
                }
              }

              return {
                evaluator_type: standardize(EvaluatorType, evalType),
                level: standardize(Level, levelResult.data),
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

  private async createEvaluator(options: AddEvaluatorOptions): Promise<Evaluator> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.evaluators, options.name);

    const evaluator: Evaluator = {
      name: options.name,
      level: options.level,
      ...(options.description && { description: options.description }),
      config: options.config,
      ...(options.kmsKeyArn && { kmsKeyArn: options.kmsKeyArn }),
    };

    project.evaluators.push(evaluator);
    await this.writeProjectSpec(project);

    return evaluator;
  }
}
