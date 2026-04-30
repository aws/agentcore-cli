import { ConfigIO, findConfigRoot } from '../../lib';
import type { AgentCoreProjectSpec } from '../../schema';
import type { ResourceType } from '../commands/remove/types';
import { getErrorMessage } from '../errors';
import { withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import type { SubCommand } from '../telemetry/schemas/command-run.js';
import { requireTTY } from '../tui/guards/tty';
import { SOURCE_CODE_NOTE } from './constants';
import type { AddResult, AddScreenComponent, RemovableResource, RemovalPreview, RemovalResult } from './types';
import type { Command } from '@commander-js/extra-typings';
import type { z } from 'zod';

/**
 * Abstract base class for AgentCore CLI primitives.
 *
 * Each primitive (Agent, Memory, Credential, Gateway, GatewayTarget)
 * extends this class and owns its add/remove logic entirely.
 *
 * The base provides shared helpers for reading/writing agentcore.json.
 * All resource types (including gateways) now use agentcore.json.
 */
export abstract class BasePrimitive<
  TAddOptions = Record<string, unknown>,
  TRemovable extends RemovableResource = RemovableResource,
> {
  /** Shared ConfigIO instance for agentcore.json operations. */
  protected readonly configIO = new ConfigIO();

  /** Resource kind identifier (e.g., 'agent', 'memory', 'credential', 'gateway', 'mcp-tool') */
  abstract readonly kind: ResourceType;

  /** Human-readable label (e.g., 'Agent', 'Memory', 'Credential') */
  abstract readonly label: string;

  /** Zod schema for validating the primitive's config */
  abstract readonly primitiveSchema: z.ZodTypeAny;

  /**
   * Add a new resource of this type.
   * Each primitive owns its implementation entirely.
   */
  abstract add(options: TAddOptions): Promise<AddResult>;

  /**
   * Remove a resource by name.
   */
  abstract remove(name: string): Promise<RemovalResult>;

  /**
   * Preview what will be removed.
   */
  abstract previewRemove(name: string): Promise<RemovalPreview>;

  /**
   * Get list of resources available for removal.
   */
  abstract getRemovable(): Promise<TRemovable[]>;

  /**
   * Register CLI commands for add/remove.
   */
  abstract registerCommands(addCmd: Command, removeCmd: Command): void;

  /**
   * Return the TUI screen component for the add flow, or null if no TUI.
   */
  abstract addScreen(): AddScreenComponent;

  // ═══════════════════════════════════════════════════════════════════
  // Shared helpers for primitives that work with agentcore.json
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Read the project spec from agentcore.json.
   */
  protected async readProjectSpec(configIO?: ConfigIO): Promise<AgentCoreProjectSpec> {
    return (configIO ?? this.configIO).readProjectSpec();
  }

  /**
   * Write the project spec to agentcore.json.
   */
  protected async writeProjectSpec(spec: AgentCoreProjectSpec, configIO?: ConfigIO): Promise<void> {
    await (configIO ?? this.configIO).writeProjectSpec(spec);
  }

  /**
   * Check for duplicate names in an array.
   * Throws if a resource with the given name already exists.
   */
  protected checkDuplicate(items: { name: string }[], name: string, label?: string): void {
    if (items.some(item => item.name === name)) {
      throw new Error(`${label ?? this.label} "${name}" already exists.`);
    }
  }

  /** Indefinite article for the resource kind ('a' or 'an'). Override for 'an'. */
  protected readonly article: string = 'a';

  /**
   * Register the standard remove subcommand for this primitive.
   * Handles CLI mode (--name/--yes/--json) and TUI fallback identically.
   */
  protected registerRemoveSubcommand(removeCmd: Command): void {
    removeCmd
      .command(this.kind)
      .description(`Remove ${this.article} ${this.label.toLowerCase()} from the project`)
      .option('--name <name>', 'Name of resource to remove [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; yes?: boolean; json?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          // Any flag triggers non-interactive CLI mode
          if (cliOptions.name || cliOptions.yes || cliOptions.json) {
            if (!cliOptions.name) {
              console.log(JSON.stringify({ success: false, error: '--name is required' }));
              process.exit(1);
            }

            const result = await withCommandRunTelemetry<SubCommand<'remove', typeof this.kind>, RemovalResult>(
              `remove.${this.kind}`,
              {},
              () => this.remove(cliOptions.name!)
            );
            console.log(
              JSON.stringify({
                success: result.success,
                resourceType: this.kind,
                resourceName: cliOptions.name,
                message: result.success ? `Removed ${this.label.toLowerCase()} '${cliOptions.name}'` : undefined,
                note: result.success ? SOURCE_CODE_NOTE : undefined,
                error: !result.success ? result.error : undefined,
              })
            );
            process.exit(result.success ? 0 : 1);
          } else {
            // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
            requireTTY();
            const [{ render }, { default: React }, { RemoveFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/remove'),
            ]);
            const { clear, unmount } = render(
              React.createElement(RemoveFlow, {
                isInteractive: false,
                force: cliOptions.yes,
                initialResourceType: this.kind,
                initialResourceName: cliOptions.name,
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
            console.error(`Error: ${getErrorMessage(error)}`);
          }
          process.exit(1);
        }
      });
  }
}
