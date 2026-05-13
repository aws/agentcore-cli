import { ResourceNotFoundError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type {
  Memory,
  MemoryStrategy,
  MemoryStrategyType,
  StreamContentLevel,
  StreamDeliveryResources,
} from '../../schema';
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
  DEFAULT_STRATEGY_NAMESPACES,
  MemorySchema,
  MemoryStrategyTypeSchema,
  StreamContentLevelSchema,
  StreamDeliveryResourcesSchema,
} from '../../schema';
import { DEFAULT_DELIVERY_TYPE, validateAddMemoryOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { requireTTY } from '../tui/guards/tty';
import { DEFAULT_EVENT_EXPIRY } from '../tui/screens/memory/types';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

/**
 * Options for adding a memory resource.
 */
export interface AddMemoryOptions {
  name: string;
  strategies?: string;
  expiry?: number;
  deliveryType?: string;
  // Flat flags for the simple single-stream case
  dataStreamArn?: string;
  contentLevel?: string;
  // Raw JSON for advanced/multi-target configurations. Takes precedence over flat flags.
  streamDeliveryResources?: string;
}

/**
 * Represents a memory that can be removed.
 */
export type RemovableMemory = RemovableResource;

/**
 * MemoryPrimitive handles all memory add/remove operations.
 * Absorbs logic from create-memory.ts and remove-memory.ts.
 */
export class MemoryPrimitive extends BasePrimitive<AddMemoryOptions, RemovableMemory> {
  readonly kind = 'memory';
  readonly label = 'Memory';
  readonly primitiveSchema = MemorySchema;

  async add(options: AddMemoryOptions): Promise<AddResult<{ memoryName: string }>> {
    try {
      const strategies = options.strategies
        ? options.strategies
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(type => ({ type: MemoryStrategyTypeSchema.parse(type) }))
        : [];

      const streamDeliveryResources = options.streamDeliveryResources
        ? this.parseStreamDeliveryResources(options.streamDeliveryResources)
        : options.dataStreamArn
          ? this.buildStreamDeliveryResources({
              deliveryType: options.deliveryType ?? DEFAULT_DELIVERY_TYPE,
              dataStreamArn: options.dataStreamArn,
              contentLevel: StreamContentLevelSchema.parse(options.contentLevel ?? 'FULL_CONTENT'),
            })
          : undefined;

      const memory = await this.createMemory({
        name: options.name,
        eventExpiryDuration: options.expiry ?? DEFAULT_EVENT_EXPIRY,
        strategies,
        streamDeliveryResources,
      });

      return { success: true, memoryName: memory.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(memoryName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const memoryIndex = project.memories.findIndex(m => m.name === memoryName);
      if (memoryIndex === -1) {
        return { success: false, error: new ResourceNotFoundError(`Memory "${memoryName}" not found.`) };
      }

      project.memories.splice(memoryIndex, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(memoryName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const memory = project.memories.find(m => m.name === memoryName);
    if (!memory) {
      throw new Error(`Memory "${memoryName}" not found.`);
    }

    const summary: string[] = [`Removing memory: ${memoryName}`];
    const schemaChanges: SchemaChange[] = [];

    const afterSpec = {
      ...project,
      memories: project.memories.filter(m => m.name !== memoryName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableMemory[]> {
    try {
      const project = await this.readProjectSpec();
      return project.memories.map(m => ({ name: m.name }));
    } catch {
      return [];
    }
  }

  /**
   * Get list of existing memory names.
   */
  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.configIO.readProjectSpec();
      return project.memories.map(m => m.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('memory')
      .description('Add a memory to the project')
      .option('--name <name>', 'Memory name [non-interactive]')
      .option(
        '--strategies <types>',
        'Comma-separated strategies: SEMANTIC, SUMMARIZATION, USER_PREFERENCE, EPISODIC [non-interactive]'
      )
      .option('--expiry <days>', 'Event expiry duration in days (default: 30) [non-interactive]')
      .option('--delivery-type <type>', 'Delivery target type (default: kinesis) [non-interactive]')
      .option('--data-stream-arn <arn>', 'Kinesis data stream ARN for memory record streaming [non-interactive]')
      .option(
        '--stream-content-level <level>',
        'Stream content level: FULL_CONTENT or METADATA_ONLY (default: FULL_CONTENT) [non-interactive]'
      )
      .option(
        '--stream-delivery-resources <json>',
        'Stream delivery config as JSON string (advanced, overrides flat flags) [non-interactive]'
      )
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          strategies?: string;
          expiry?: string;
          deliveryType?: string;
          dataStreamArn?: string;
          streamContentLevel?: string;
          streamDeliveryResources?: string;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.json) {
            // CLI mode
            await runCliCommand('add.memory', !!cliOptions.json, async () => {
              const expiry = cliOptions.expiry ? parseInt(cliOptions.expiry, 10) : undefined;
              const validation = validateAddMemoryOptions({
                name: cliOptions.name,
                strategies: cliOptions.strategies,
                expiry,
                deliveryType: cliOptions.deliveryType,
                dataStreamArn: cliOptions.dataStreamArn,
                contentLevel: cliOptions.streamContentLevel,
                streamDeliveryResources: cliOptions.streamDeliveryResources,
              });

              if (!validation.valid) {
                throw new Error(validation.error);
              }

              const result = await this.add({
                name: cliOptions.name!,
                strategies: cliOptions.strategies,
                expiry,
                deliveryType: cliOptions.deliveryType,
                dataStreamArn: cliOptions.dataStreamArn,
                contentLevel: cliOptions.streamContentLevel,
                streamDeliveryResources: cliOptions.streamDeliveryResources,
              });

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else {
                console.log(`Added memory '${result.memoryName}'`);
              }

              const strategyList = (cliOptions.strategies ?? '')
                .split(',')
                .map(s => s.trim().toUpperCase())
                .filter(Boolean);
              return {
                strategy_count: strategyList.length,
                strategy_semantic: strategyList.includes('SEMANTIC'),
                strategy_summarization: strategyList.includes('SUMMARIZATION'),
                strategy_user_preference: strategyList.includes('USER_PREFERENCE'),
                strategy_episodic: strategyList.includes('EPISODIC'),
              };
            });
          } else {
            try {
              // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'memory',
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

  /**
   * Core memory creation logic (absorbed from create-memory.ts).
   */
  private async createMemory(config: {
    name: string;
    eventExpiryDuration: number;
    strategies: { type: MemoryStrategyType }[];
    streamDeliveryResources?: StreamDeliveryResources;
  }): Promise<Memory> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.memories, config.name);

    // Map strategies with their default namespaces
    const strategies: MemoryStrategy[] = config.strategies.map(s => {
      const defaultNamespaces = DEFAULT_STRATEGY_NAMESPACES[s.type];
      return {
        type: s.type,
        ...(defaultNamespaces && { namespaces: defaultNamespaces }),
        ...(s.type === 'EPISODIC' && { reflectionNamespaces: DEFAULT_EPISODIC_REFLECTION_NAMESPACES }),
      };
    });

    const memory: Memory = {
      name: config.name,
      eventExpiryDuration: config.eventExpiryDuration,
      strategies,
      ...(config.streamDeliveryResources && { streamDeliveryResources: config.streamDeliveryResources }),
    };

    project.memories.push(memory);
    await this.writeProjectSpec(project);

    return memory;
  }

  private buildStreamDeliveryResources(config: {
    deliveryType: string;
    dataStreamArn: string;
    contentLevel: StreamContentLevel;
  }): StreamDeliveryResources {
    if (config.deliveryType === DEFAULT_DELIVERY_TYPE) {
      return {
        resources: [
          {
            kinesis: {
              dataStreamArn: config.dataStreamArn,
              contentConfigurations: [{ type: 'MEMORY_RECORDS', level: config.contentLevel }],
            },
          },
        ],
      };
    }
    throw new Error(`Unsupported delivery type: ${config.deliveryType}`);
  }

  private parseStreamDeliveryResources(input: string): StreamDeliveryResources {
    try {
      return StreamDeliveryResourcesSchema.parse(JSON.parse(input));
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error('Invalid JSON in stream delivery config');
      }
      const detail = e instanceof z.ZodError ? `: ${e.issues.map(i => i.message).join(', ')}` : '';
      throw new Error(`Stream delivery config does not match the expected schema${detail}`);
    }
  }
}
