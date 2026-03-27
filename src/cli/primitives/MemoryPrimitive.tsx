import { findConfigRoot } from '../../lib';
import type { Memory, MemoryStrategy, MemoryStrategyType } from '../../schema';
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
  DEFAULT_STRATEGY_NAMESPACES,
  MemorySchema,
  MemoryStrategyTypeSchema,
} from '../../schema';
import { validateAddMemoryOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { DEFAULT_EVENT_EXPIRY } from '../tui/screens/memory/types';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Options for adding a memory resource.
 */
export interface AddMemoryOptions {
  name: string;
  strategies?: string;
  expiry?: number;
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
            .map(type => ({ type: type as MemoryStrategyType }))
        : [];

      const memory = await this.createMemory({
        name: options.name,
        eventExpiryDuration: options.expiry ?? DEFAULT_EVENT_EXPIRY,
        strategies,
      });

      return { success: true, memoryName: memory.name };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(memoryName: string): Promise<RemovalResult> {
    try {
      const project = await this.readProjectSpec();

      const memoryIndex = project.memories.findIndex(m => m.name === memoryName);
      if (memoryIndex === -1) {
        return { success: false, error: `Memory "${memoryName}" not found.` };
      }

      project.memories.splice(memoryIndex, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
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
        `Comma-separated strategies: ${MemoryStrategyTypeSchema.options.join(', ')} [non-interactive]`
      )
      .option('--expiry <days>', 'Event expiry duration in days (default: 30) [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; strategies?: string; expiry?: string; json?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.json) {
            // CLI mode
            const expiry = cliOptions.expiry ? parseInt(cliOptions.expiry, 10) : undefined;
            const validation = validateAddMemoryOptions({
              name: cliOptions.name,
              strategies: cliOptions.strategies,
              expiry,
            });

            if (!validation.valid) {
              if (cliOptions.json) {
                console.log(JSON.stringify({ success: false, error: validation.error }));
              } else {
                console.error(validation.error);
              }
              process.exit(1);
            }

            const result = await this.add({
              name: cliOptions.name!,
              strategies: cliOptions.strategies,
              expiry,
            });

            if (cliOptions.json) {
              console.log(JSON.stringify(result));
            } else if (result.success) {
              console.log(`Added memory '${result.memoryName}'`);
            } else {
              console.error(result.error);
            }
            process.exit(result.success ? 0 : 1);
          } else {
            // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
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
      });

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
    strategies: { type: string }[];
  }): Promise<Memory> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.memories, config.name);

    // Map strategies with their default namespaces
    const strategies: MemoryStrategy[] = config.strategies.map(s => {
      const strategyType = s.type as MemoryStrategyType;
      const defaultNamespaces = DEFAULT_STRATEGY_NAMESPACES[strategyType];
      return {
        type: strategyType,
        ...(defaultNamespaces && { namespaces: defaultNamespaces }),
        ...(strategyType === 'EPISODIC' && { reflectionNamespaces: DEFAULT_EPISODIC_REFLECTION_NAMESPACES }),
      };
    });

    const memory: Memory = {
      name: config.name,
      eventExpiryDuration: config.eventExpiryDuration,
      strategies,
    };

    project.memories.push(memory);
    await this.writeProjectSpec(project);

    return memory;
  }
}
