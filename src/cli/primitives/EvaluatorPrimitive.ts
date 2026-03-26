import { findConfigRoot } from '../../lib';
import type { EvaluationLevel, Evaluator, EvaluatorConfig } from '../../schema';
import { EvaluationLevelSchema, EvaluatorSchema } from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import {
  LEVEL_PLACEHOLDERS,
  RATING_SCALE_PRESETS,
  parseCustomRatingScale,
  validateInstructionPlaceholders,
} from '../tui/screens/evaluator/types';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

export interface AddEvaluatorOptions {
  name: string;
  level: EvaluationLevel;
  description?: string;
  config: EvaluatorConfig;
}

export type RemovableEvaluator = RemovableResource;

/**
 * EvaluatorPrimitive handles all evaluator add/remove operations.
 */
export class EvaluatorPrimitive extends BasePrimitive<AddEvaluatorOptions, RemovableEvaluator> {
  readonly kind = 'evaluator' as const;
  readonly label = 'Evaluator';
  override readonly article = 'an';
  readonly primitiveSchema = EvaluatorSchema;

  async add(options: AddEvaluatorOptions): Promise<AddResult<{ evaluatorName: string }>> {
    try {
      const evaluator = await this.createEvaluator(options);
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
    const schemaChanges: SchemaChange[] = [];

    const referencingConfigs = project.onlineEvalConfigs.filter(c => c.evaluators.includes(evaluatorName));
    if (referencingConfigs.length > 0) {
      summary.push(
        `Blocked: Referenced by online eval config(s): ${referencingConfigs.map(c => c.name).join(', ')}. Remove those references first.`
      );
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

    return { summary, directoriesToDelete: [], schemaChanges };
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
      .option('--model <model>', 'Bedrock model ID for LLM-as-a-Judge')
      .option(
        '--instructions <text>',
        'Evaluation prompt instructions (must include level-appropriate placeholders, e.g. {context})'
      )
      .option('--rating-scale <preset>', `Rating scale preset: ${presetIds.join(', ')} (default: 1-5-quality)`)
      .option(
        '--config <path>',
        'Path to evaluator config JSON file (overrides --model, --instructions, --rating-scale)'
      )
      .option('--json', 'Output as JSON')
      .action(
        async (cliOptions: {
          name?: string;
          level?: string;
          model?: string;
          instructions?: string;
          ratingScale?: string;
          config?: string;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            if (cliOptions.name || cliOptions.json) {
              const fail = (error: string) => {
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              };

              if (!cliOptions.name || !cliOptions.level) {
                fail('--name and --level are required in non-interactive mode');
              }

              if (!cliOptions.config && !cliOptions.model) {
                fail('Either --config or --model is required');
              }

              const levelResult = EvaluationLevelSchema.safeParse(cliOptions.level);
              if (!levelResult.success) {
                fail(`Invalid --level "${cliOptions.level}". Must be one of: SESSION, TRACE, TOOL_CALL`);
              }

              let configJson: EvaluatorConfig;
              if (cliOptions.config) {
                const { readFileSync } = await import('fs');
                configJson = JSON.parse(readFileSync(cliOptions.config, 'utf-8')) as EvaluatorConfig;
              } else {
                // --instructions is required when not using --config
                if (!cliOptions.instructions) {
                  const level = levelResult.data!;
                  const placeholders = LEVEL_PLACEHOLDERS[level].map(p => `{${p}}`).join(', ');
                  fail(
                    `--instructions is required in non-interactive mode (or use --config). ` +
                      `Must include at least one placeholder for ${level}: ${placeholders}`
                  );
                }

                // Validate placeholders
                const placeholderCheck = validateInstructionPlaceholders(cliOptions.instructions!, levelResult.data!);
                if (placeholderCheck !== true) {
                  fail(placeholderCheck);
                }

                // Resolve rating scale
                let ratingScale: EvaluatorConfig['llmAsAJudge']['ratingScale'];
                const scaleInput = cliOptions.ratingScale ?? '1-5-quality';

                const preset = RATING_SCALE_PRESETS.find(p => p.id === scaleInput);
                if (preset) {
                  ratingScale = preset.ratingScale;
                } else {
                  // Try parsing as custom format: "1:Poor:Fails, 2:Fair:Partially meets" or "Pass:Meets, Fail:Does not"
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

              const result = await this.add({
                name: cliOptions.name!,
                level: levelResult.data!,
                config: configJson,
              });

              if (cliOptions.json) {
                console.log(JSON.stringify(result));
              } else if (result.success) {
                console.log(`Added evaluator '${result.evaluatorName}'`);
              } else {
                console.error(result.error);
              }
              process.exit(result.success ? 0 : 1);
            } else {
              // TUI fallback
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
            }
          } catch (error) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
            } else {
              console.error(getErrorMessage(error));
            }
            process.exit(1);
          }
        }
      );

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  private async createEvaluator(options: AddEvaluatorOptions): Promise<Evaluator> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.evaluators, options.name);

    const evaluator: Evaluator = {
      type: 'CustomEvaluator',
      name: options.name,
      level: options.level,
      ...(options.description && { description: options.description }),
      config: options.config,
    };

    project.evaluators.push(evaluator);
    await this.writeProjectSpec(project);

    return evaluator;
  }
}
